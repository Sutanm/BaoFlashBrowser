import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { setupFlash } from './modules/flash';
import { initSession } from './modules/session';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { setMainWindowRef, registerShortcutHandler } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';

let mainWindow: BrowserWindow | null = null;

function bootstrap(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  const config = loadConfig();

  app.commandLine.appendSwitch('--ignore-gpu-blacklist');
  app.commandLine.appendSwitch('--enable-gpu-rasterization');
  app.commandLine.appendSwitch('--enable-zero-copy');
  app.commandLine.appendSwitch('--process-per-site');

  setupFlash(app, config.flashVersion);

  app.whenReady().then(() => {
    initSession();
    mainWindow = createWindow();
    setMainWindowRef(mainWindow);
    registerWindowIPC(() => getMainWindow());

    app.on('web-contents-created', (_event, wc) => {
      wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
        const { handleWebviewBeforeInputEvent } = require('./ipc/shortcut.ipc');
        handleWebviewBeforeInputEvent(event, input);
      });
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  log.info('[App] started, version 1.0.1');
}

bootstrap();
