import { registerAppUpdateIPC, runStartupUpdateCheck } from './ipc/app-update.ipc';
/*! BaoFlashBrowser · crafted by Sutanm */
/* eslint-disable @typescript-eslint/no-require-imports -- compile-time guarded CommonJS loads let esbuild physically omit disabled modules */
import path from 'path';
import { app, protocol, session } from 'electron';
import log from 'electron-log';
import { registerUiLanguageIPC } from './modules/ui-language';

import { setupFlash } from './modules/flash';
import { configureOptionalSessionServices, initSession } from './modules/session-manager';
import { initializeProxy } from './modules/proxy';
import { loadConfig } from './modules/config';
import { createWindow, getMainWindow } from './modules/window';
import { registerShortcutHandler, registerZoomShortcuts, startMouseHook } from './ipc/shortcut.ipc';
import { registerWindowIPC } from './ipc/window.ipc';
import { registerThemeIPC } from './ipc/theme.ipc';
import { registerConfigIPC } from './ipc/config.ipc';
import { registerTabsIPC } from './ipc/tabs.ipc';
import { registerScreenshotIPC } from './ipc/screenshot.ipc';
import { registerDevToolboxIPC } from './ipc/devtoolbox.ipc';
import { initDevToolbox, shutdownDevToolsFrontendServer, shutdownWorkspaceWatchers } from './modules/devtoolbox';
import { devToolsBridge } from './modules/devtoolbox-bridge';
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
    // 通知图标靠 AUMID 关联应用身份；不设就是默认的 electron.app.Electron（空图标）。
    // 值必须与 electron-builder 的 appId 一致。
    app.setAppUserModelId('com.bao.flashbrowser');
  }

  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
  }

  app.commandLine.appendSwitch('ignore-gpu-blacklist');
  app.commandLine.appendSwitch('disable-gpu-process-crash-limit');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');

  // 抽屉 DevTools 的传输层（全版本常开）。端口必须 0（系统临时分配）：
  // Chromium 会把实际端口写进 userData/DevToolsActivePort，devtoolbox 的
  // resolveDebugPort() 从那里发现它。固定端口既占着不放（还要躲 Windows
  // 保留端口段），也没有必要——消费者全在应用内部。安全面：只绑 127.0.0.1，
  // 等于本机进程可调试本应用，与 DevTools 前端 iframe 的既有暴露一致。
  app.commandLine.appendSwitch('remote-debugging-port', '0');
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
      if (MODULE_JS_PATCH) privilegedSchemes.push({
        scheme: 'bfb-github-module',
        privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
      });
      protocol.registerSchemesAsPrivileged(privilegedSchemes);
  } catch (e) {
    log.warn('[Ruffle] scheme privileges registration failed:', (e instanceof Error ? e.message : 'Unknown error'));
  }

  app.whenReady().then(async () => {
    registerUiLanguageIPC(() => getMainWindow());
    // Apply before creating windows, background scripts or navigations.
    try {
      await initializeProxy(config.proxy);
    } catch {
      log.error('[Proxy] configuration failed; startup stopped');
      app.quit();
      return;
    }
    // Custom protocols are session-scoped. BrowserView tabs use persist:, while
    // the main renderer uses defaultSession, so both must be registered before
    // any page can request Ruffle's JS/WASM components.
    try {
      registerRuffleProtocol(session.defaultSession, 'defaultSession');
      registerRuffleProtocol(session.fromPartition('persist:'), 'persist:');
    } catch (e) {
      log.error('[Ruffle] resource protocol registration failed:', (e instanceof Error ? e.message : 'Unknown error'));
    }

    // 创建主窗口优先于可选模块初始化，保留快速首屏；BrowserView 要等 IPC
    // 注册后才会创建，因此下面仍能在首个标签页出现前完成依赖装配。
    const mainWindow = createWindow();
    // Chromium 87 合成器表面丢失的修复：还原和最大化都要触发（最大化不产生
    // restore 事件，只挂 restore 时"最小化→弹通知→最大化"会白屏）
    mainWindow.on('restore', () => tabManager.refreshActiveViewAfterHostRestore());
    mainWindow.on('maximize', () => tabManager.refreshActiveViewAfterHostRestore());
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
    const githubModules = MODULE_JS_PATCH
      ? require('./modules/github-module-service') as typeof import('./modules/github-module-service')
      : undefined;
    githubModules?.setupGitHubModules();
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
      githubModules: githubModules ? {
        register: githubModules.registerGitHubModuleSession,
        redirect: githubModules.githubModuleRedirect,
        patchCsp: githubModules.patchGitHubModuleCsp,
      } : undefined,
    });
    configureOptionalTabServices({
      getUserscriptManager: userscripts?.getUserscriptManager,
      passwords: passwordStore && passwordCapture && passwordFill ? {
        setupCapture: passwordCapture.setupCapture,
        teardownCapture: passwordCapture.teardownCapture,
        fillPasswords: passwordFill.fillPasswordsInWebContents,
        getFillCredentialForUrl: passwordStore.getFillCredentialForUrl,
        isAutoFillEnabled: passwordStore.isAutoFillEnabled,
        ensureKeyLoaded: passwordStore.ensureKeyLoaded,
      } : undefined,
    });

    initSession();
    registerZoomShortcuts();
    startMouseHook();
    registerWindowIPC(() => getMainWindow());
    registerThemeIPC();
    registerConfigIPC({ applyUserscriptCapacityConfig: userscripts?.applyCapacityConfig });
    registerTabsIPC();
    // 内置开发者工具箱：只读观察（console-message + electron-log），不占用 CDP 租约。
    initDevToolbox();
    registerDevToolboxIPC();
    registerAppUpdateIPC();
    if (MODULE_DOWNLOAD) {
      const { registerDownloadIPC } = require('./ipc/download.ipc') as typeof import('./ipc/download.ipc');
      registerDownloadIPC();
    }
    registerScreenshotIPC(() => getMainWindow());
    if (MODULE_PASSWORDS) {
      const { registerPasswordIPC } = require('./ipc/password.ipc') as typeof import('./ipc/password.ipc');
      const { setViewGateOwnerWindow } = require('./modules/view-gate-win') as typeof import('./modules/view-gate-win');
      // CredUI 验证对话框是 powershell.exe 子进程创建的顶层窗口，必须给它一个属主窗口，
      // 否则它没有 Z 序关系、可能被压在浏览器窗口后面（2026-11-08 反馈）。
      setViewGateOwnerWindow(() => {
        const win = getMainWindow();
        if (!win || win.isDestroyed()) return null;
        const handle = win.getNativeWindowHandle();
        // HWND 是 32 位句柄（64 位进程里以符号扩展的 8 字节存放），低 4 字节就是它的值。
        // 不用 BigInt：主进程 tsconfig 目标低于 ES2020，BigInt 字面量过不了类型检查。
        const value = handle.length >= 4 ? handle.readUInt32LE(0) : 0;
        return value > 0 ? String(value) : null;
      });
      passwordStore?.init().catch((e: unknown) => log.warn('[App] password store init failed:', (e instanceof Error ? e.message : 'Unknown error')));
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
      // 启动自动检查更新（auto 模式下有新版本弹桌面通知）；网络请求不阻塞首屏。
      void runStartupUpdateCheck();
    });

    app.on('web-contents-created', (_event, wc) => {
      registerShortcutHandler(wc);
    });
    // 主窗口早于上面的事件监听创建，必须显式补绑，否则焦点在外壳界面
    // （地址栏、开发者工具箱输入框）时 F12 等快捷键全部失效。
    registerShortcutHandler(mainWindow.webContents);
  });

  app.on('window-all-closed', () => {
    shutdownDevToolsFrontendServer();
    // 工作区的 fs.watch 句柄必须显式关闭，否则退出时事件循环还挂着。
    shutdownWorkspaceWatchers();
    // 桥的 browser ws 是长连接，退出前必须显式关闭（否则进程退出要多等一个超时）。
    devToolsBridge.shutdown();
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
