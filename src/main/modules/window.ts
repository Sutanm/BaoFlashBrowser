import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import { app, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { markCleanShutdown } from './session-recovery';

let mainWindow: BrowserWindow | null = null;
const READY_TO_SHOW_FALLBACK_MS = 8000;

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
