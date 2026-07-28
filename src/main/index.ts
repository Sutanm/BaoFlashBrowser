import { app, BrowserWindow } from 'electron';
import log from 'electron-log';
import { setupFlash } from './modules/flash';
import { initSession } from './modules/session';
import { loadConfig } from './modules/config';
import { createWindow } from './modules/window';

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

    app.on('web-contents-created', (_event, wc) => {
      wc.on('before-input-event', handleBeforeInputEvent);
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  log.info('[App] started, version 2.0.0');
}

function handleBeforeInputEvent(
  event: Electron.Event,
  input: Electron.Input,
): void {
  // Placeholder — full shortcut table implemented in Phase 1.1
  log.debug('[Shortcut] key=', input.key, 'ctrl=', input.control, 'type=', input.type);
}

bootstrap();
