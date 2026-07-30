import type { BrowserWindow, WebContents } from 'electron';
import { globalShortcut, app } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import log from 'electron-log';
import type { ShortcutAction } from '@shared/types/ipc';

type ShortcutEntry = {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  action: ShortcutAction | 'zoom-in' | 'zoom-out' | 'zoom-reset';
};

const SHORTCUTS: ShortcutEntry[] = [
  // Tab management
  { key: 't', ctrl: true, action: 'new-tab' },
  { key: 'w', ctrl: true, action: 'close-tab' },
  { key: 'Tab', ctrl: true, action: 'next-tab' },
  { key: 'Tab', ctrl: true, shift: true, action: 'prev-tab' },
  { key: '1', ctrl: true, action: 'switch-tab-1' },
  { key: '2', ctrl: true, action: 'switch-tab-2' },
  { key: '3', ctrl: true, action: 'switch-tab-3' },
  { key: '4', ctrl: true, action: 'switch-tab-4' },
  { key: '5', ctrl: true, action: 'switch-tab-5' },
  { key: '6', ctrl: true, action: 'switch-tab-6' },
  { key: '7', ctrl: true, action: 'switch-tab-7' },
  { key: '8', ctrl: true, action: 'switch-tab-8' },
  // Navigation
  { key: 'F5', action: 'reload' },
  { key: 'r', ctrl: true, action: 'reload' },
  { key: 'Escape', action: 'stop-or-dismiss' },
  { key: 'l', ctrl: true, action: 'focus-address' },
  { key: 'd', alt: true, action: 'focus-address' },
  // Features
  { key: 'F11', action: 'fullscreen' },
  { key: 'F12', action: 'devtools' },
  { key: 'i', ctrl: true, shift: true, action: 'devtools' },
  { key: 'd', ctrl: true, action: 'bookmark' },
  { key: 'h', ctrl: true, action: 'history-panel' },
  { key: 'f', ctrl: true, action: 'find-in-page' },
  { key: 's', ctrl: true, action: 'save-page' },
  { key: 'p', ctrl: true, action: 'print-page' },
  { key: 'u', ctrl: true, action: 'view-source' },
  { key: 'n', ctrl: true, action: 'new-window' },
  { key: 'Delete', ctrl: true, shift: true, action: 'clear-data' },
  // Zoom
  { key: '=', ctrl: true, action: 'zoom-in' },
  { key: '+', ctrl: true, action: 'zoom-in' },
  { key: '-', ctrl: true, action: 'zoom-out' },
  { key: '0', ctrl: true, action: 'zoom-reset' },
  // Navigation
  { key: 'Left', alt: true, action: 'go-back' },
  { key: 'Right', alt: true, action: 'go-forward' },
];

let mainWindow: BrowserWindow | null = null;

export function setMainWindowRef(win: BrowserWindow): void {
  mainWindow = win;
}

function matchShortcut(input: Electron.Input): ShortcutEntry | null {
  for (const sc of SHORTCUTS) {
    if (input.key !== sc.key) continue;
    if (!!sc.ctrl !== input.control) continue;
    if (!!sc.shift !== input.shift) continue;
    if (!!sc.alt !== input.alt) continue;
    return sc;
  }
  return null;
}

export function handleWebviewBeforeInputEvent(
  event: Electron.Event,
  input: Electron.Input,
): void {
  // Handle keyboard shortcuts
  if (input.type === 'keyDown') {
    const matched = matchShortcut(input);
    if (matched) {
      event.preventDefault();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('shortcut', matched.action);
      }
      return;
    }
  }

  // Handle Ctrl+MouseWheel for zoom (fallback for Flash/iframe areas)
  if (input.type === 'mouseWheel' && (input.control || input.meta)) {
    event.preventDefault();
    const action = input.deltaY < 0 ? 'zoom-in' : 'zoom-out';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('shortcut', action);
    }
  }
}

export function registerShortcutHandler(wc: WebContents): void {
  wc.on('before-input-event', handleWebviewBeforeInputEvent);
}

const ZOOM_SHORTCUTS = [
  { accel: 'CommandOrControl+=', action: 'zoom-in' },
  { accel: 'CommandOrControl+numadd', action: 'zoom-in' },
  { accel: 'CommandOrControl+-', action: 'zoom-out' },
  { accel: 'CommandOrControl+numsub', action: 'zoom-out' },
  { accel: 'CommandOrControl+0', action: 'zoom-reset' },
  { accel: 'CommandOrControl+num0', action: 'zoom-reset' },
];

function registerGlobalZoom(): void {
  for (const { accel, action } of ZOOM_SHORTCUTS) {
    try {
      if (!globalShortcut.isRegistered(accel)) {
        globalShortcut.register(accel, () => {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('shortcut', action);
          }
        });
      }
    } catch { /* already registered or failed */ }
  }
}

function unregisterGlobalZoom(): void {
  for (const { accel } of ZOOM_SHORTCUTS) {
    try {
      globalShortcut.unregister(accel);
    } catch { /* not registered */ }
  }
}

export function registerZoomShortcuts(): void {
  if (!mainWindow) return;

  mainWindow.on('focus', registerGlobalZoom);
  mainWindow.on('blur', unregisterGlobalZoom);

  if (mainWindow.isFocused()) {
    registerGlobalZoom();
  }

  app.on('will-quit', unregisterGlobalZoom);
}

let mouseHookProcess: ChildProcess | null = null;
let _willQuitRegistered = false;

export function startMouseHook(): void {
  if (mouseHookProcess) return;

  const platform = process.platform;
  let exeName: string;

  if (platform === 'win32') {
    exeName = 'mouse-hook.exe';
  } else if (platform === 'linux') {
    exeName = 'mouse-hook-linux';
  } else {
    return;
  }

  const exePath = path.join(app.getAppPath(), 'native', exeName);
  try {
    const child = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'] });
    mouseHookProcess = child;

    let buf = '';
    child.stdout.on('data', (data: Buffer) => {
      buf += data.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        const action = trimmed === 'ZOOM_IN' ? 'zoom-in' : trimmed === 'ZOOM_OUT' ? 'zoom-out' : null;
        if (action && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('shortcut', action);
        }
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      log.warn('[mouse-hook] ' + data.toString().trim());
    });

    child.on('error', (err) => {
      log.error('[mouse-hook] spawn error: ' + err.message);
      mouseHookProcess = null;
    });

    child.on('exit', (code, signal) => {
      const reason = signal ? 'signal ' + signal : 'code ' + code;
      log.warn('[mouse-hook] exited with ' + reason);
      mouseHookProcess = null;
    });

    if (!_willQuitRegistered) {
      _willQuitRegistered = true;
      app.on('will-quit', () => {
        if (mouseHookProcess) {
          mouseHookProcess.kill();
          mouseHookProcess = null;
        }
      });
    }
  } catch (err) {
    log.warn('[mouse-hook] failed to start: ' + err);
  }
}
