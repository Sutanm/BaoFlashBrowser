import path from 'path';
import fs from 'fs';
import localShortcut from 'electron-localshortcut';
import log from 'electron-log';
import { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

let mainWindow: BrowserWindow | null = null;

export function setupDevTools(win: BrowserWindow): void {
  localShortcut.register(win, 'F12', () => {
    const wc = win.webContents;
    try {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: 'right' });
      }
    } catch (err) {
      log.error('[DevTools] toggle failed', err);
    }
  });
}

export function createWindow(): BrowserWindow {
  const preloadPath = path.join(__dirname, 'preload.js');

  const opts: BrowserWindowConstructorOptions = {
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BaoFlashBrowser',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    backgroundColor: '#f0f0f0',
    frame: false,
    webPreferences: {
      preload: preloadPath,
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  };

  mainWindow = new BrowserWindow(opts);

  const htmlPath = path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  mainWindow.loadFile(htmlPath);

  setupDevTools(mainWindow);
  mainWindow.setMenu(null);

  if (process.platform === 'win32') {
    try {
      const iconPath = path.join(__dirname, '..', 'build', 'icon.ico');
      if (fs.existsSync(iconPath)) {
        mainWindow.setIcon(iconPath);
      }
    } catch (_e) {
      /* ignore */
    }
  }

  mainWindow.on('page-title-updated', (e) => {
    e.preventDefault();
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
