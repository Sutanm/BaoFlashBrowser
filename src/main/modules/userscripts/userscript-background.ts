// @background persistent runtime: one hidden BrowserWindow per @background
// script. Crashes rebuild only their own window with exponential backoff
// (1s→2s→4s→8s→60s); 5 consecutive crashes stop that script until a restart.

import { BrowserWindow } from 'electron';
import { createCrashTracker } from './userscript-crash-tracker';
import type { UserscriptManager } from './userscript-manager';
import type { InstalledUserscript } from '../../../shared/userscript-types';

// backoffDelayMs 从纯模块 re-export(旧测试兼容)
export { backoffDelayMs } from './userscript-crash-tracker';

export interface BackgroundScriptStatus {
  scriptId: string;
  running: boolean;
  crashedCount: number;
  stopped: boolean;
}

export interface BackgroundRuntimeStatus {
  scripts: BackgroundScriptStatus[];
  stopped: boolean;
}

export interface BackgroundRuntime {
  start(): void;
  stop(): void;
  restart(): void;
  /** Diff the current script set against the window pool (create/destroy). */
  sync(): void;
  /** Rebuild only one script's window and reset its crash count. */
  restartScript(scriptId: string): void;
  getStatus(): BackgroundRuntimeStatus;
  getWcIds(): number[];
  getScriptIdForWc(wcId: number): string | null;
}

export interface BackgroundRuntimeOptions {
  preloadPath: string;
  manager: UserscriptManager;
  partition?: string;
  listBackgroundScripts: () => InstalledUserscript[];
}

interface ScriptWindowState {
  scriptId: string;
  window: BrowserWindow | null;
  generation: number;
  tracker: ReturnType<typeof createCrashTracker>;
  backoffTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

export function createBackgroundRuntime(options: BackgroundRuntimeOptions): BackgroundRuntime {
  const states = new Map<string, ScriptWindowState>();

  const ensureState = (scriptId: string): ScriptWindowState => {
    let state = states.get(scriptId);
    if (!state) {
      state = {
        scriptId,
        window: null,
        generation: 0,
        tracker: createCrashTracker(),
        backoffTimer: null,
        stopped: false,
      };
      states.set(scriptId, state);
    }
    return state;
  };

  const spawn = (state: ScriptWindowState): void => {
    if (state.window && !state.window.isDestroyed()) return; // idempotent
    state.stopped = false;
    state.generation += 1; // each rebuild gets a fresh generation (P1-7)
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: options.preloadPath,
        contextIsolation: true,
        plugins: false,
        nodeIntegration: false,
        spellcheck: false,
        // Hidden windows throttle timers by default; background scripts rely
        // on accurate setInterval timing, so disable throttling.
        backgroundThrottling: false,
        partition: options.partition ?? 'persist:',
      },
    });
    state.window = win;
    const wcId = win.webContents.id;
    options.manager.registerView(wcId, {
      mode: 'ppapi',
      generation: state.generation,
      token: 'background',
      kind: 'background',
      backgroundScriptId: state.scriptId,
    });
    win.webContents.on('render-process-gone', () => {
      // Ignore a late event from a window that was intentionally replaced.
      if (state.window !== win) return;
      // Clear/destroy the crashed instance before scheduling its replacement;
      // otherwise spawn() sees a non-destroyed window and returns early.
      destroy(state);
      const record = state.tracker.record(state.scriptId);
      if (record.shouldStop) {
        state.stopped = true;
        return;
      }
      state.backoffTimer = setTimeout(() => {
        state.backoffTimer = null;
        spawn(state);
      }, record.nextDelayMs);
    });
    void win.loadURL('data:text/html;charset=utf-8,');
  };

  const destroy = (state: ScriptWindowState): void => {
    if (state.backoffTimer) {
      clearTimeout(state.backoffTimer);
      state.backoffTimer = null;
    }
    const win = state.window;
    state.window = null;
    if (win && !win.isDestroyed()) {
      options.manager.unregisterView(win.webContents.id);
      win.destroy();
    }
  };

  const start = (): void => {
    for (const script of options.listBackgroundScripts()) spawn(ensureState(script.id));
  };

  return {
    start,
    stop(): void {
      for (const state of states.values()) destroy(state);
    },
    restart(): void {
      for (const state of states.values()) {
        state.tracker.reset(state.scriptId); // 手动重启清零崩溃计数
        destroy(state);
      }
      start();
    },
    restartScript(scriptId: string): void {
      const state = states.get(scriptId);
      if (!state) return;
      state.tracker.reset(scriptId);
      destroy(state);
      spawn(state);
    },
    sync(): void {
      const wanted = new Set(options.listBackgroundScripts().map((s) => s.id));
      for (const scriptId of Array.from(states.keys())) {
        if (!wanted.has(scriptId)) {
          destroy(ensureState(scriptId));
          states.delete(scriptId);
        }
      }
      for (const script of options.listBackgroundScripts()) {
        const state = ensureState(script.id);
        if (!state.stopped) spawn(state);
      }
    },
    getStatus(): BackgroundRuntimeStatus {
      const scripts = Array.from(states.values()).map((s) => ({
        scriptId: s.scriptId,
        running: Boolean(s.window && !s.window.isDestroyed()),
        crashedCount: s.tracker.crashedCount(s.scriptId),
        stopped: s.stopped,
      }));
      return { scripts, stopped: scripts.some((s) => s.stopped) };
    },
    getWcIds(): number[] {
      return Array.from(states.values())
        .filter((s) => s.window && !s.window.isDestroyed())
        .map((s) => s.window!.webContents.id);
    },
    getScriptIdForWc(wcId: number): string | null {
      for (const state of states.values()) {
        if (state.window && !state.window.isDestroyed() && state.window.webContents.id === wcId) return state.scriptId;
      }
      return null;
    },
  };
}
