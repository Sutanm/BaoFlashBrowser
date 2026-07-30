import path from 'path';
import log from 'electron-log';
import { app, BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

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

  // Explicit setIcon for Windows (some Electron versions need both)
  if (process.platform === 'win32') {
    try { mainWindow.setIcon(iconPath); } catch {}
  }

  const htmlPath = app.isPackaged
    ? path.join(__dirname, '..', 'renderer', 'index.html')
    : path.join(__dirname, '..', 'src', 'renderer', 'index.html');
  mainWindow.loadFile(htmlPath);

  mainWindow.setMenu(null);

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
