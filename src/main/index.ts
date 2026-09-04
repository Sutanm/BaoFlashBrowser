/*! BaoFlashBrowser · crafted by Sutanm */
/* eslint-disable @typescript-eslint/no-require-imports -- compile-time guarded CommonJS loads let esbuild physically omit disabled modules */
import path from 'path';
import { app, protocol, session } from 'electron';
import log from 'electron-log';

import { setupFlash } from './modules/flash';
import { configureOptionalSessionServices, initSession } from './modules/session-manager';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { handleWebviewBeforeInputEvent, registerZoomShortcuts, startMouseHook } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';
import { registerConfigIPC } from './ipc/config.ipc';
import { registerTabsIPC } from './ipc/tabs.ipc';
import { registerScreenshotIPC } from './ipc/screenshot.ipc';
import { configureOptionalTabServices, tabManager } from './modules/tabs';
import { registerRuffleProtocol } from './modules/ruffle-session-protocol';
import { initializeSessionRecovery, preventCleanShutdownMark } from './modules/session-recovery';

let automationService: { shutdown(): Promise<void> } | null = null;

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

  // Chromium 87's Windows spellchecker can derive corrupt dictionary paths
  // on newer Windows builds, leaving random Unicode folders beside the app.
  // The browser does not offer spellchecking, so disable the feature globally.
  if (process.platform === 'win32') {
    app.commandLine.appendSwitch('disable-features', 'WinUseBrowserSpellChecker');
  }

  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
  }

  app.commandLine.appendSwitch('ignore-gpu-blacklist');
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-flash-sandbox');

  if (config.lowEndMode) {
    app.commandLine.appendSwitch('enable-low-end-device-mode');
  }

  setupFlash(app, config.flashVersion, config.flashPluginChannel);

  // Register ruffle-resource scheme privileges BEFORE app.whenReady()
  // so Chromium treats it as a trusted scheme (CORS, fetch, service worker OK).
    try {
      const privilegedSchemes: Electron.CustomScheme[] = [
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
      ];
      if (MODULE_JS_PATCH) privilegedSchemes.push({
        // ES2022 chunk patch target: must load from http (non-secure-context)
        // pages too — old game sites may be plain http.
        scheme: 'bf-js-patch',
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      });
      protocol.registerSchemesAsPrivileged(privilegedSchemes);
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

    // 创建主窗口优先于可选模块初始化，保留快速首屏；BrowserView 要等 IPC
    // 注册后才会创建，因此下面仍能在首个标签页出现前完成依赖装配。
    const mainWindow = createWindow();
    mainWindow.on('restore', () => tabManager.refreshActiveViewAfterHostRestore());
    tabManager.setPreload(path.join(__dirname, 'webview-preload.js'));

    // Optional integrations are wired before the first BrowserView/session is
    // configured. Disabled modules therefore have no reverse import from core.
    const userscripts = MODULE_USERSCRIPTS
      ? require('./modules/userscripts') as typeof import('./modules/userscripts')
      : undefined;
    const downloads = MODULE_DOWNLOAD
      ? require('./modules/download') as typeof import('./modules/download')
      : undefined;
    const jsPatch = MODULE_JS_PATCH
      ? require('./modules/js-patch-service') as typeof import('./modules/js-patch-service')
      : undefined;
    const passwordStore = MODULE_PASSWORDS
      ? require('./modules/password-store') as typeof import('./modules/password-store')
      : undefined;
    const passwordCapture = MODULE_PASSWORDS
      ? require('./modules/password-capture') as typeof import('./modules/password-capture')
      : undefined;
    const passwordFill = MODULE_PASSWORDS
      ? require('./modules/password-fill') as typeof import('./modules/password-fill')
      : undefined;

    userscripts?.initUserscriptManager();
    configureOptionalSessionServices({
      downloadSetup: downloads?.setupDownloadHandlers,
      jsPatchRedirect: jsPatch?.chunkRedirectUrl,
      webRequestObserver: userscripts?.getWebRequestObserver(),
    });
    configureOptionalTabServices({
      getUserscriptManager: userscripts?.getUserscriptManager,
      passwords: passwordStore && passwordCapture && passwordFill ? {
        setupCapture: passwordCapture.setupCapture,
        teardownCapture: passwordCapture.teardownCapture,
        fillPasswords: passwordFill.fillPasswordsInWebContents,
        getFillCredentialForUrl: passwordStore.getFillCredentialForUrl,
        isAutoFillEnabled: passwordStore.isAutoFillEnabled,
      } : undefined,
    });

    initSession();
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerConfigIPC({ applyUserscriptCapacityConfig: userscripts?.applyCapacityConfig });
    registerTabsIPC();
    if (MODULE_DOWNLOAD) {
      const { registerDownloadIPC } = require('./ipc/download.ipc') as typeof import('./ipc/download.ipc');
      registerDownloadIPC();
    }
    registerScreenshotIPC(() => getMainWindow());
    if (MODULE_PASSWORDS) {
      const { registerPasswordIPC } = require('./ipc/password.ipc') as typeof import('./ipc/password.ipc');
      passwordStore?.init().catch((e: any) => log.warn('[App] password store init failed:', e?.message));
      registerPasswordIPC();
    }
    if (MODULE_DIAGNOSTICS) {
      const { registerDiagnosticsIPC } = require('./ipc/diagnostics.ipc') as typeof import('./ipc/diagnostics.ipc');
      registerDiagnosticsIPC();
    }
    if (MODULE_USERSCRIPTS) {
      const { registerUserscriptsIPC } = require('./ipc/userscripts.ipc') as typeof import('./ipc/userscripts.ipc');
      const { registerUserscriptsAdminIPC } = require('./ipc/userscripts-admin.ipc') as typeof import('./ipc/userscripts-admin.ipc');
      registerUserscriptsIPC();
      registerUserscriptsAdminIPC(() => getMainWindow());
    }
    jsPatch?.setupJsPatchInterceptor();
    if (MODULE_AUTOMATION) {
      const { registerAutomationV3IPC } = require('./ipc/automation-v3.ipc') as typeof import('./ipc/automation-v3.ipc');
      automationService = registerAutomationV3IPC(() => getMainWindow());
    }
    if (MODULE_AUTOMATION && MODULE_USERSCRIPTS) {
      const { registerAutomationUserscriptBridge } = require('./ipc/automation-userscript-bridge.ipc') as typeof import('./ipc/automation-userscript-bridge.ipc');
      registerAutomationUserscriptBridge();
    }
    if (MODULE_MEMORY_MONITOR) {
      const { startMemoryMonitor } = require('./modules/memory-monitor') as typeof import('./modules/memory-monitor');
      startMemoryMonitor();
    }

    // 调试截图 HTTP 口子：仅开发模式 + BAO_SCREENSHOT_HTTP=1（发布版零监听端口）
    if (MODULE_SCREENSHOT && !app.isPackaged && process.env.BAO_SCREENSHOT_HTTP === '1') {
      const { startScreenshotHttpServer } = require('./modules/screenshot-http') as typeof import('./modules/screenshot-http');
      startScreenshotHttpServer();
    }

    // 重任务延迟到首渲染后执行，不阻塞首屏展示
     setImmediate(() => {
      if (MODULE_DOWNLOAD) downloads?.initDownloadManager();
      if (MODULE_AUTOMATION) startAutomationWarmStart();
     });

    app.on('web-contents-created', (_event, wc) => {
      wc.on('before-input-event', (event: Electron.Event, input: Electron.Input) => {
        handleWebviewBeforeInputEvent(event, input);
      });

    });
  });

  app.on('window-all-closed', () => {
    if (MODULE_MEMORY_MONITOR) {
      const { stopMemoryMonitor } = require('./modules/memory-monitor') as typeof import('./modules/memory-monitor');
      stopMemoryMonitor();
    }
    if (MODULE_AUTOMATION) {
      const { shutdownAutomationOcr, shutdownAutomationVision } = require('./modules/automation/automation-warm-start') as typeof import('./modules/automation/automation-warm-start');
      void automationService?.shutdown();
      void shutdownAutomationVision();
      void shutdownAutomationOcr();
    }
    if (MODULE_DOWNLOAD) {
      const { killAria2 } = require('./modules/download') as typeof import('./modules/download');
      killAria2();
    }
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

  log.info(`[App] started, version ${app.getVersion()}`);
}

/** 按设置开关在后台预热自动化常驻资源,不阻塞首屏。 */
function startAutomationWarmStart(): void {
  const { warmStartAutomationOcr, warmStartAutomationVision } = require('./modules/automation/automation-warm-start') as typeof import('./modules/automation/automation-warm-start');
  const cfg = loadConfig();
  if (cfg.automationVisionWarmStart ?? true) {
    void warmStartAutomationVision().then((result) => {
      if (!result.ok) log.warn(`[Automation] OpenCV 预热失败: ${result.error ?? 'unknown'}`);
      else log.info(`[Automation] OpenCV Worker 预热完成 ${result.ms}ms`);
    });
  }
  if (cfg.automationOcrWarmStart ?? true) {
    void warmStartAutomationOcr().then((result) => {
      if (!result.ok && result.error) log.warn(`[Automation] OCR 预热失败: ${result.error}`);
      else if (result.ok) log.info(`[Automation] OCR Sidecar 预热完成 ${result.ms}ms`);
    });
  }
}

bootstrap();
