import path from 'path';
import fs from 'fs';
import { app, BrowserWindow, protocol } from 'electron';
import log from 'electron-log';
import { setupFlash } from './modules/flash';
import { initSession } from './modules/session';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { registerZoomShortcuts, startMouseHook } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';
import { registerConfigIPC } from './ipc/config.ipc';
import { registerTabsIPC } from './ipc/tabs.ipc';
import { registerDownloadIPC } from './ipc/download.ipc';
import { registerPasswordIPC } from './ipc/password.ipc';
import { init as initPasswordStore } from './modules/password-store';
import { tabManager } from './modules/tabs';
import { loadRuffleJs } from './modules/ruffle-bundle';
import { selfTest as dpapiSelfTest } from './modules/dpapi';
import { initDownloadManager, killAria2 } from './modules/download';

function bootstrap(): void {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.on('second-instance', () => {
    const win = getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  const config = loadConfig();

  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('--enable-gpu-rasterization');
    app.commandLine.appendSwitch('--enable-zero-copy');
  }

  app.commandLine.appendSwitch('--ignore-gpu-blacklist');
  app.commandLine.appendSwitch('--disable-gpu-process-crash-limit');
  app.commandLine.appendSwitch('--disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-flash-sandbox');

  if (config.lowEndMode) {
    app.commandLine.appendSwitch('enable-low-end-device-mode');
  }

  setupFlash(app, config.flashVersion);

  // Register ruffle-resource scheme privileges BEFORE app.whenReady()
  // so Chromium treats it as a trusted scheme (CORS, fetch, service worker OK).
  try {
    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'ruffle-resource',
        privileges: {
          standard: false,
          secure: true,
          supportFetchAPI: true,
          allowServiceWorkers: false,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
  } catch (e: any) {
    log.warn('[Ruffle] scheme privileges registration failed:', e?.message);
  }

  app.whenReady().then(() => {
    loadRuffleJs();
    // Register custom protocol for Ruffle self-hosted resources
    try {
      protocol.registerBufferProtocol('ruffle-resource', (req, cb) => {
        // req.url;
        const stripped = req.url.replace(/^ruffle-resource:\/\//, '');
        // Strip query string / fragment
        const cleanName = stripped.split('?')[0].split('#')[0];
        const fileName = decodeURIComponent(cleanName);
        const fullPath = path.join(__dirname, 'lib', 'ruffle', fileName);
        fs.readFile(fullPath, (err, data) => {
          if (err) {
            log.warn('[Ruffle] resource not found: ' + fullPath + ' (' + err.message + ')');
            cb({ error: -6 /* net::ERR_FILE_NOT_FOUND */ });
            return;
          }
          let mimeType = 'application/octet-stream';
          const ext = path.extname(fullPath).toLowerCase();
          if (ext === '.js') mimeType = 'application/javascript';
          else if (ext === '.wasm') mimeType = 'application/wasm';
          else if (ext === '.map') mimeType = 'application/json';
          cb({
            mimeType,
            data,
            headers: {
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Access-Control-Allow-Origin': '*',
            },
          });
        });
      });
      log.info('[Ruffle] protocol ruffle-resource registered (buffer mode');
    } catch (e: any) { log.warn('[Ruffle] protocol registration failed:', e?.message); }

    createWindow();
    tabManager.setPreload(path.join(__dirname, 'webview-preload.js'));
    initSession();
    initDownloadManager();
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerConfigIPC();
    registerTabsIPC();
    registerDownloadIPC();
    initPasswordStore().catch((e: any) => log.warn('[App] password store init failed:', e?.message));
    registerPasswordIPC();
    dpapiSelfTest();

    const win = getMainWindow();
    win?.on('resize', () => {
      // Renderer recalculates and sends tab:setBounds
    });

    if (process.platform === 'win32') {
      win?.on('move', () => {
        // Renderer recalculates and sends tab:setBounds
      });
    }

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
    killAria2();
    app.quit();
  });

  let crashCount = 0;
  let crashResetTimer: ReturnType<typeof setTimeout> | null = null;

  app.on('render-process-gone', (_event, wc, details) => {
    const win = getMainWindow();
    if (wc === win?.webContents) {
      log.error('[App] MAIN RENDER PROCESS GONE — reason: ' + details.reason);
      crashCount++;
      if (crashResetTimer) clearTimeout(crashResetTimer);
      crashResetTimer = setTimeout(() => { crashCount = 0; }, 30000);
      if (crashCount > 3) { app.quit(); return; }
      setTimeout(() => win?.reload(), 500);
    }
  });

  app.on('child-process-gone', (_event, details) => {
    log.error('[App] CHILD PROCESS GONE — type: ' + details.type + ', reason: ' + details.reason + ', exitCode: ' + details.exitCode);
  });

  log.info('[App] started, version 1.0.1');
}

bootstrap();
