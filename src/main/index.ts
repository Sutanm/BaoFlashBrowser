import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { setupFlash } from './modules/flash';
import { initSession } from './modules/session';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { setMainWindowRef, registerShortcutHandler, registerZoomShortcuts, startMouseHook } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';
import { registerConfigIPC } from './ipc/config.ipc';

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

  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
  }

  app.commandLine.appendSwitch('--ignore-gpu-blacklist');
  app.commandLine.appendSwitch('--enable-gpu-rasterization');
  app.commandLine.appendSwitch('--enable-zero-copy');
  app.commandLine.appendSwitch('--process-per-site');

  if (config.lowEndMode) {
    app.commandLine.appendSwitch('enable-low-end-device-mode');
  }

  setupFlash(app, config.flashVersion);

  app.whenReady().then(() => {
    mainWindow = createWindow();
    initSession(() => getMainWindow());
    setMainWindowRef(mainWindow);
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerConfigIPC();

    app.on('web-contents-created', (_event, wc) => {
      wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
        const { handleWebviewBeforeInputEvent } = require('./ipc/shortcut.ipc');
        handleWebviewBeforeInputEvent(event, input);
      });

      wc.on('new-window', (event: Electron.Event, url: string) => {
        event.preventDefault();
        if (wc.hostWebContents) {
          wc.hostWebContents.send('navigate-url', url);
        }
      });
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  log.info('[App] started, version 1.0.1');
}

bootstrap();
