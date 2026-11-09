import path from 'path';
import fs from 'fs';
import { randomBytes } from 'crypto';
import log from 'electron-log';
import { app, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { markCleanShutdown } from './session-recovery';

/**
 * 多窗口窗口注册表（SDD: docs/specs/multi-window-plan.md §6.1 / §7 P1）。
 *
 * 这里刻意不使用 `BrowserWindow.getAllWindows()`：userscripts `@background`
 * 的隐藏窗口与独立 DevTools 窗口都会混进来。只有经过 `createWindow()` 的
 * 浏览器窗口才算"注册窗口"。
 */
export interface CreateWindowOptions {
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  /** 跨重启稳定的 key（会话/几何持久化用）；不传则生成随机 key。 */
  windowKey?: string;
  /** 持久化顺序，用于启动时按序恢复。 */
  index?: number;
  /** 只有首个窗口应为 true，用于旧会话单归属迁移（P5）。 */
  isPrimary?: boolean;
}

export interface WindowContext {
  windowKey: string;
  index: number;
  isPrimary: boolean;
}

interface RegisteredWindow {
  win: BrowserWindow;
  key: string;
  index: number;
  isPrimary: boolean;
}

const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const READY_TO_SHOW_FALLBACK_MS = 8000;

const windows = new Map<number, RegisteredWindow>();
const shellWebContentsToWindow = new Map<number, BrowserWindow>();
const creationListeners = new Set<(win: BrowserWindow) => void>();
let focusedWindowId: number | null = null;
let nextIndex = 0;

// The renderer's CSP forbids inline scripts, so the global error handlers can no
// longer sit in index.html. They must still be installed BEFORE the entry module
// evaluates, or an error thrown while modules initialise would go unreported.
// Injecting on `did-start-loading` (which fires before the document's own scripts)
// preserves that early coverage without weakening `script-src`.
const EARLY_RENDERER_ERROR_HANDLERS = `(function () {
  window.onerror = function (m, s, l, c, e) { console.error('GLOBAL ERR:', m, s, l, c, e); };
  window.onunhandledrejection = function (e) { console.error('UNHANDLED:', e.reason); };
})();`;

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanitizeBounds(input: CreateWindowOptions['bounds']): {
  x?: number;
  y?: number;
  width: number;
  height: number;
} {
  const width = finite(input?.width);
  const height = finite(input?.height);
  const x = finite(input?.x);
  const y = finite(input?.y);
  return {
    ...(x === null ? {} : { x: Math.round(x) }),
    ...(y === null ? {} : { y: Math.round(y) }),
    width: width === null ? DEFAULT_WIDTH : Math.max(MIN_WIDTH, Math.round(width)),
    height: height === null ? DEFAULT_HEIGHT : Math.max(MIN_HEIGHT, Math.round(height)),
  };
}

export function createWindow(options: CreateWindowOptions = {}): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '..', 'build', 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.png');
  const bounds = sanitizeBounds(options.bounds);

  const opts: BrowserWindowConstructorOptions = {
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x === undefined ? {} : { x: bounds.x }),
    ...(bounds.y === undefined ? {} : { y: bounds.y }),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: process.platform === 'darwin'
      ? 'BaoFlashBrowser — Experimental macOS (Untested)'
      : 'BaoFlashBrowser',
    icon: iconPath,
    show: false,
    backgroundColor: '#f0f0f0',
    frame: false,
    webPreferences: {
      preload: preloadPath,
      plugins: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  };

  const win = new BrowserWindow(opts);
  const windowKey = options.windowKey || randomBytes(9).toString('hex');
  const index = options.index ?? nextIndex;
  if (index >= nextIndex) nextIndex = index + 1;
  const isPrimary = options.isPrimary ?? windows.size === 0;
  const shellWebContentsId = win.webContents.id;

  windows.set(win.id, { win, key: windowKey, index, isPrimary });
  shellWebContentsToWindow.set(shellWebContentsId, win);
  win.on('focus', () => { focusedWindowId = win.id; });

  // Explicit setIcon for Windows (some Electron versions need both)
  if (process.platform === 'win32') {
    try { win.setIcon(iconPath); } catch { /* ignore */ }
  }

  const distHtml = path.join(__dirname, 'renderer', 'index.html');
  const showAfterLoadFailure = (message: string): void => {
    log.error('[Window] renderer load failed:', message);
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };

  win.webContents.on('did-start-loading', () => {
    if (win.isDestroyed()) return;
    void win.webContents.executeJavaScript(EARLY_RENDERER_ERROR_HANDLERS).catch((error) => {
      log.warn('[Window] early error-handler injection failed:', error instanceof Error ? error.message : String(error));
    });
  });

  if (app.isPackaged) {
    void win.loadFile(distHtml).catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  } else if (fs.existsSync(distHtml)) {
    log.info('[Window] loading dist renderer (start mode):', distHtml);
    void win.loadFile(distHtml).catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  } else {
    log.info('[Window] loading vite dev server (dev mode): http://localhost:5173');
    void win.loadURL('http://localhost:5173').catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  }

  win.setMenu(null);

  win.webContents.on('will-navigate', (event, url) => {
    const allowedDevUrl = !app.isPackaged && url.startsWith('http://localhost:5173/');
    const allowedFileUrl = app.isPackaged && url.startsWith('file:');
    if (!allowedDevUrl && !allowedFileUrl) {
      event.preventDefault();
      log.warn('[Window] blocked main renderer navigation:', url);
    }
  });

  // ready-to-show 机制：等首帧渲染完毕再显示窗口，消除白屏/灰色背景
  const showFallbackTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      log.warn(`[Window] ready-to-show timed out after ${READY_TO_SHOW_FALLBACK_MS}ms; showing fallback window`);
      win.show();
    }
  }, READY_TO_SHOW_FALLBACK_MS);
  showFallbackTimer.unref?.();

  win.once('ready-to-show', () => {
    clearTimeout(showFallbackTimer);
    win.show();
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    clearTimeout(showFallbackTimer);
    showAfterLoadFailure(`${errorCode} ${errorDescription} ${validatedURL}`);
  });

  win.webContents.once('dom-ready', () => {
    log.info('[Window] renderer DOM ready:', win.webContents.getURL());
  });
  win.webContents.once('did-finish-load', () => {
    log.info('[Window] renderer finished loading:', win.webContents.getURL());
  });
  win.webContents.on('preload-error', (_event, preloadPathValue, error) => {
    log.error('[Window] preload failed:', preloadPathValue, error instanceof Error ? error.message : String(error));
  });
  // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error. Level 2 is a
  // warning and must not be recorded as an error, or genuine failures drown in
  // noise (Blockly emits its warnings at level 2).
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    // Name the severity instead of leaking Chromium's numeric level to the reader.
    const severity = level === 2 ? 'warn' : 'error';
    const entry = `[Window] renderer console level=${severity}: ${message} (${sourceId}:${line})`;
    if (level === 2) log.warn(entry);
    else log.error(entry);
  });

  win.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  // 关闭单个窗口不代表"正常退出"：teardown 与 markCleanShutdown 已上移到
  // before-quit（多窗口下关掉非最后窗口不能掩盖崩溃恢复）。
  win.on('session-end', () => {
    markCleanShutdown();
  });

  win.on('closed', () => {
    clearTimeout(showFallbackTimer);
    windows.delete(win.id);
    shellWebContentsToWindow.delete(shellWebContentsId);
    if (focusedWindowId === win.id) focusedWindowId = null;
  });

  log.info(`[Window] created id=${win.id} key=${windowKey} index=${index} primary=${isPrimary}`);
  for (const listener of creationListeners) {
    try { listener(win); } catch (error) {
      log.warn('[Window] creation listener failed:', error instanceof Error ? error.message : String(error));
    }
  }
  return win;
}

/** 注册窗口创建回调；返回取消函数。index.ts 用它给每个窗口绑定宿主事件。 */
export function onWindowCreated(listener: (win: BrowserWindow) => void): () => void {
  creationListeners.add(listener);
  return () => creationListeners.delete(listener);
}

export function getRegisteredWindows(): BrowserWindow[] {
  return [...windows.values()]
    .filter((entry) => !entry.win.isDestroyed())
    .sort((a, b) => (a.index === b.index ? a.win.id - b.win.id : a.index - b.index))
    .map((entry) => entry.win);
}

export function getWindowById(id: number): BrowserWindow | null {
  const entry = windows.get(id);
  return entry && !entry.win.isDestroyed() ? entry.win : null;
}

/**
 * 主路径用 `BrowserWindow.fromWebContents`，兜底显式 `webContents → window`
 * 注册表（Electron 11 的 BrowserView `hostWebContents` 为 null，且外壳
 * WebContents 在窗口销毁边缘可能反查不到）。未注册窗口（userscripts 隐藏窗口、
 * DevTools 窗口）返回 null。
 */
export function getWindowForWebContents(wc: Electron.WebContents | null | undefined): BrowserWindow | null {
  if (!wc) return null;
  try {
    const direct = BrowserWindow.fromWebContents(wc);
    if (direct && windows.has(direct.id) && !direct.isDestroyed()) return direct;
  } catch { /* webContents already destroyed */ }
  const fallback = shellWebContentsToWindow.get(wc.id);
  if (fallback && windows.has(fallback.id) && !fallback.isDestroyed()) return fallback;
  return null;
}

/** 最近聚焦的已注册窗口；没有聚焦记录时退化为首个注册窗口。 */
export function getFocusedRegisteredWindow(): BrowserWindow | null {
  if (focusedWindowId !== null) {
    const focused = windows.get(focusedWindowId);
    if (focused && !focused.win.isDestroyed()) return focused.win;
  }
  return getRegisteredWindows()[0] ?? null;
}

/**
 * @deprecated 迁移期兼容 shim，等价于 `getFocusedRegisteredWindow()`。
 * 新代码禁止使用：它会把"最近聚焦"误当成"发起请求的窗口"。
 */
export function getMainWindow(): BrowserWindow | null {
  return getFocusedRegisteredWindow();
}

export function getWindowKey(win: BrowserWindow): string {
  return windows.get(win.id)?.key ?? '';
}

export function getWindowContext(win: BrowserWindow): WindowContext | null {
  const entry = windows.get(win.id);
  if (!entry) return null;
  return { windowKey: entry.key, index: entry.index, isPrimary: entry.isPrimary };
}
