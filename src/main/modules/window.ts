import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import { app, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';
import { markCleanShutdown } from './session-recovery';

let mainWindow: BrowserWindow | null = null;

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
    title: 'BaoFlashBrowser',
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
  if (app.isPackaged) {
    mainWindow.loadFile(distHtml);
  } else if (fs.existsSync(distHtml)) {
    log.info('[Window] loading dist renderer (start mode):', distHtml);
    mainWindow.loadFile(distHtml);
  } else {
    log.info('[Window] loading vite dev server (dev mode): http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
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
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
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
    mainWindow = null;
  });

  log.info('[Window] created');
  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
