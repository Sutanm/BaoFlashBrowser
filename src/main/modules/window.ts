import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import { app, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { markCleanShutdown } from './session-recovery';

let mainWindow: BrowserWindow | null = null;
const READY_TO_SHOW_FALLBACK_MS = 8000;

// The renderer's CSP forbids inline scripts, so the global error handlers can no
// longer sit in index.html. They must still be installed BEFORE the entry module
// evaluates, or an error thrown while modules initialise would go unreported.
// Injecting on `did-start-loading` (which fires before the document's own scripts)
// preserves that early coverage without weakening `script-src`.
const EARLY_RENDERER_ERROR_HANDLERS = `(function () {
  window.onerror = function (m, s, l, c, e) { console.error('GLOBAL ERR:', m, s, l, c, e); };
  window.onunhandledrejection = function (e) { console.error('UNHANDLED:', e.reason); };
})();`;

export function createWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '..', 'build', 'icon.ico')
    : path.join(__dirname, '..', 'build', 'icon.png');

  const opts: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
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

  mainWindow = new BrowserWindow(opts);

  // Explicit setIcon for Windows (some Electron versions need both)
  if (process.platform === 'win32') {
    try { mainWindow.setIcon(iconPath); } catch { /* ignore */ }
  }

  const distHtml = path.join(__dirname, 'renderer', 'index.html');
  const showAfterLoadFailure = (message: string): void => {
    log.error('[Window] renderer load failed:', message);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
  };

  mainWindow.webContents.on('did-start-loading', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void mainWindow.webContents.executeJavaScript(EARLY_RENDERER_ERROR_HANDLERS).catch((error) => {
      log.warn('[Window] early error-handler injection failed:', error instanceof Error ? error.message : String(error));
    });
  });

  if (app.isPackaged) {
    void mainWindow.loadFile(distHtml).catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  } else if (fs.existsSync(distHtml)) {
    log.info('[Window] loading dist renderer (start mode):', distHtml);
    void mainWindow.loadFile(distHtml).catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  } else {
    log.info('[Window] loading vite dev server (dev mode): http://localhost:5173');
    void mainWindow.loadURL('http://localhost:5173').catch((error) => showAfterLoadFailure(error instanceof Error ? error.message : String(error)));
  }

  mainWindow.setMenu(null);

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDevUrl = !app.isPackaged && url.startsWith('http://localhost:5173/');
    const allowedFileUrl = app.isPackaged && url.startsWith('file:');
    if (!allowedDevUrl && !allowedFileUrl) {
      event.preventDefault();
      log.warn('[Window] blocked main renderer navigation:', url);
    }
  });

  // ready-to-show 机制：等首帧渲染完毕再显示窗口，消除白屏/灰色背景
  const showFallbackTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      log.warn(`[Window] ready-to-show timed out after ${READY_TO_SHOW_FALLBACK_MS}ms; showing fallback window`);
      mainWindow.show();
    }
  }, READY_TO_SHOW_FALLBACK_MS);
  showFallbackTimer.unref?.();

  mainWindow.once('ready-to-show', () => {
    clearTimeout(showFallbackTimer);
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    clearTimeout(showFallbackTimer);
    showAfterLoadFailure(`${errorCode} ${errorDescription} ${validatedURL}`);
  });

  mainWindow.webContents.once('dom-ready', () => {
    log.info('[Window] renderer DOM ready:', mainWindow?.webContents.getURL());
  });
  mainWindow.webContents.once('did-finish-load', () => {
    log.info('[Window] renderer finished loading:', mainWindow?.webContents.getURL());
  });
  mainWindow.webContents.on('preload-error', (_event, preloadPathValue, error) => {
    log.error('[Window] preload failed:', preloadPathValue, error instanceof Error ? error.message : String(error));
  });
  // Chromium console levels: 0=verbose, 1=info, 2=warning, 3=error. Level 2 is a
  // warning and must not be recorded as an error, or genuine failures drown in
  // noise (Blockly emits its warnings at level 2).
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (level < 2) return;
    // Name the severity instead of leaking Chromium's numeric level to the reader.
    const severity = level === 2 ? 'warn' : 'error';
    const entry = `[Window] renderer console level=${severity}: ${message} (${sourceId}:${line})`;
    if (level === 2) log.warn(entry);
    else log.error(entry);
  });

  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
  });

  mainWindow.on('close', () => {
    markCleanShutdown();
  });

  mainWindow.on('session-end', () => {
    markCleanShutdown();
  });

  mainWindow.on('closed', () => {
    clearTimeout(showFallbackTimer);
    mainWindow = null;
  });

  log.info('[Window] created');
  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
