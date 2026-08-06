import path from 'path';
import { app, protocol, session } from 'electron';
import log from 'electron-log';

import { setupFlash } from './modules/flash';
import { initSession } from './modules/session-manager';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { handleWebviewBeforeInputEvent, registerZoomShortcuts, startMouseHook } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';
import { registerConfigIPC } from './ipc/config.ipc';
import { registerTabsIPC } from './ipc/tabs.ipc';
import { registerDownloadIPC } from './ipc/download.ipc';
import { registerPasswordIPC } from './ipc/password.ipc';
import { registerDiagnosticsIPC } from './ipc/diagnostics.ipc';
import { init as initPasswordStore } from './modules/password-store';
import { tabManager } from './modules/tabs';
import { initDownloadManager, killAria2 } from './modules/download';
import { registerRuffleProtocol } from './modules/ruffle-session-protocol';
import { initializeSessionRecovery, preventCleanShutdownMark } from './modules/session-recovery';
import { startMemoryMonitor, stopMemoryMonitor } from './modules/memory-monitor';

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
  initializeSessionRecovery();

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
    // Custom protocols are session-scoped. BrowserView tabs use persist:, while
    // the main renderer uses defaultSession, so both must be registered before
    // any page can request Ruffle's JS/WASM components.
    try {
      registerRuffleProtocol(session.defaultSession, 'defaultSession');
      registerRuffleProtocol(session.fromPartition('persist:'), 'persist:');
    } catch (e: any) {
      log.error('[Ruffle] resource protocol registration failed:', e?.message || e);
    }

    // 窗口优先创建，首屏最快展示
    createWindow();
    tabManager.setPreload(path.join(__dirname, 'webview-preload.js'));
    initSession();
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerConfigIPC();
    registerTabsIPC();
    registerDownloadIPC();
    initPasswordStore().catch((e: any) => log.warn('[App] password store init failed:', e?.message));
    registerPasswordIPC();
    registerDiagnosticsIPC();
    startMemoryMonitor();

    // 重任务延迟到首渲染后执行，不阻塞首屏展示
     setImmediate(() => {
      initDownloadManager();
     });

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
        handleWebviewBeforeInputEvent(event, input);
      });

    });
  });

  app.on('window-all-closed', () => {
    stopMemoryMonitor();
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
      if (crashCount > 3) {
        preventCleanShutdownMark();
        app.quit();
        return;
      }
      setTimeout(() => win?.reload(), 500);
    }
  });

  app.on('child-process-gone', (_event, details) => {
    log.error('[App] CHILD PROCESS GONE — type: ' + details.type + ', reason: ' + details.reason + ', exitCode: ' + details.exitCode);
  });

  log.info('[App] started, version 1.0.1');
}

bootstrap();
