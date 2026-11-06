import { contextBridge, ipcRenderer } from 'electron';
import path from 'path';
import type { FindInPageOptions } from 'electron';

// --- L04: IPC 通道白名单 ---
const ALLOWED_ON_CHANNELS = new Set([
  'tab:updated', 'tab:found', 'tab:load-error', 'tab:crashed', 'tab:newwindow',
  'ruffle:diagnostic',
  'download:progress', 'aria2:status', 'navigate-url',
  'shortcut',
  'password:captured', 'password:changed', 'password:filled',
  'userscripts:changed',
  'userscript:open-tab',
  'devtoolbox:entries', 'devtoolbox:cleared', 'devtoolbox:bridge-event', 'devtoolbox:devtools-window-closed',
]);

const ALLOWED_INVOKE_CHANNELS = new Set([
  'ui:set-language',
    'tab:create', 'tab:close', 'tab:suspend', 'tab:activate', 'tab:focusActive', 'tab:navigate', 'tab:goBack', 'tab:goForward',
  'tab:reload', 'tab:stop', 'tab:zoom', 'tab:mute', 'tab:devtools', 'tab:find', 'tab:stopFind',
  'tab:setBounds', 'tab:setRuffleMode',
  'load-config', 'save-config',
  'theme:set-source',
  'app:version', 'app:check-update', 'app:open-release',
  'cache:clear',
  'proxy:test',
  'download:open-folder', 'download:aria2-status', 'download:get-dir', 'download:set-dir', 'download:delete-file',
  'download:list', 'download:remove-record', 'download:clear-finished', 'download:pause', 'download:resume',
  'password:status', 'password:init',
  'password:toggle-enabled', 'password:set-auto-capture', 'password:set-auto-fill', 'password:set-excluded-sites', 'password:list', 'password:save-confirm',
  'password:ignore', 'password:delete', 'password:reveal', 'password:set-default',
  'password:reset', 'password:fill', 'password:retry-key', 'password:rebuild-vault',
  'password:set-view-password', 'password:reset-os-auth',
  'diagnostics:export',
  'devtoolbox:snapshot', 'devtoolbox:clear', 'devtoolbox:devtools-url', 'devtoolbox:open-native', 'devtoolbox:probe-page',
  'devtoolbox:open-devtools-window', 'devtoolbox:close-devtools-window',
  'devtoolbox:attach-devtools-view', 'devtoolbox:set-devtools-bounds', 'devtoolbox:detach-devtools-view',
  'devtoolbox:bridge-attach', 'devtoolbox:bridge-detach', 'devtoolbox:bridge-send', 'devtoolbox:bridge-stats',
  'file:open-swf',
  'session:recovery-status', 'session:resolve-recovery',
  'win:minimize', 'win:maximize', 'win:unmaximize', 'win:close', 'win:setFullscreen', 'win:toggleFullscreen', 'win:isMaximized',
  'userscripts:list', 'userscripts:get-source', 'userscripts:parse-source',
  'userscripts:install-source', 'userscripts:install-file', 'userscripts:install-url',
  'userscripts:uninstall', 'userscripts:set-enabled', 'userscripts:update-source',
  'userscripts:for-tab', 'userscripts:invoke-command',
  'userscripts:check-updates', 'userscripts:apply-update',
  'userscripts:background-status', 'userscripts:background-restart',
  'userscripts:export-source',
  'userscripts:list-values', 'userscripts:set-value-admin', 'userscripts:delete-value-admin',
  'screenshot:get-dir', 'screenshot:capture', 'screenshot:capture-active', 'screenshot:reveal', 'screenshot:set-dir',
    'automation-v3:list', 'automation-v3:get', 'automation-v3:create', 'automation-v3:validate-workflow',
    'automation-v3:update-workflow', 'automation-v3:upsert-script', 'automation-v3:delete-script', 'automation-v3:set-main-entry', 'automation-v3:delete',
    'automation-v3:open', 'automation-v3:install', 'automation-v3:export',
    'automation-v3:show-assistant', 'automation-v3:status', 'automation-v3:start', 'automation-v3:cancel',
    'automation-v3:read-clipboard', 'automation-v3:asset-preview',
    'automation-v3:open-test-scene', 'automation-v3:test-asset-on-scene', 'automation-v3:test-text-on-scene',
    'automation-v3:import-assets', 'automation-v3:import-asset-folder', 'automation-v3:delete-asset',
    'automation-v3:capture-asset-frame', 'automation-v3:save-captured-asset',
    'automation-v3:test-asset', 'automation-v3:test-text', 'automation-v3:test-asset-preview', 'automation-v3:test-text-preview',
]);

const ALLOWED_SEND_CHANNELS = new Set([
  'download:start', 'download:cancel',
  'download:open', 'download:openDir',
]);

/**
 * 同步通道白名单。
 *
 * 目前只有一条：拖拽抽屉时更新 DevTools 视图矩形。异步 IPC 会把原生视图的
 * 更新推到下一帧，快速拖拽时「布局已经到位、画面还停在上一帧」非常明显。
 * 主进程侧只是 `view.setBounds()`，微秒级，阻塞渲染线程的代价可以接受。
 */
const ALLOWED_SYNC_CHANNELS = new Set([
  'devtoolbox:set-devtools-bounds-sync',
]);

function safeInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
    console.warn('[Preload] invoke() rejected: unauthorized channel', channel);
    return Promise.reject(new Error('Unauthorized IPC channel: ' + channel));
  }
  return ipcRenderer.invoke(channel, ...args);
}

function safeSend(channel: string, ...args: unknown[]): void {
  if (!ALLOWED_SEND_CHANNELS.has(channel)) {
    console.warn('[Preload] send() rejected: unauthorized channel', channel);
    return;
  }
  ipcRenderer.send(channel, ...args);
}

function safeSendSync(channel: string, ...args: unknown[]): void {
  if (!ALLOWED_SYNC_CHANNELS.has(channel)) {
    console.warn('[Preload] sendSync() rejected: unauthorized channel', channel);
    return;
  }
  // 不把返回值交给渲染层：这条通道只做"通知"，没有语义上的回包。
  ipcRenderer.sendSync(channel, ...args);
}

const electronAPI = {
  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    if (!ALLOWED_ON_CHANNELS.has(channel)) {
      console.warn('[Preload] on() rejected: unauthorized channel', channel);
      return () => {};
    }
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  invoke: safeInvoke,

  webviewPreloadPath: path.join(__dirname, 'webview-preload.js'),

  tab: {
    create: (tabId: string, url: string, ruffleConfig?: { enabled: boolean; source: 'bundled' | 'cdn' }) =>
      safeInvoke('tab:create', { tabId, url, ruffleConfig }),
    close: (tabId: string) => safeInvoke('tab:close', { tabId }),
    suspend: (tabId: string) => safeInvoke('tab:suspend', { tabId }),
    activate: (tabId: string) => safeInvoke('tab:activate', { tabId }),
    focusActive: () => safeInvoke('tab:focusActive', undefined),
    navigate: (tabId: string, url: string) => safeInvoke('tab:navigate', { tabId, url }),
    goBack: (tabId: string) => safeInvoke('tab:goBack', { tabId }),
    goForward: (tabId: string) => safeInvoke('tab:goForward', { tabId }),
    reload: (tabId: string) => safeInvoke('tab:reload', { tabId }),
    stop: (tabId: string) => safeInvoke('tab:stop', { tabId }),
    zoom: (tabId: string, factor: number) => safeInvoke('tab:zoom', { tabId, factor }),
    mute: (tabId: string, muted: boolean) => safeInvoke('tab:mute', { tabId, muted }),
    devtools: (tabId: string) => safeInvoke('tab:devtools', { tabId }),
    find: (tabId: string, text: string, options?: FindInPageOptions) => safeInvoke('tab:find', { tabId, text, options }),
    stopFind: (tabId: string, action: string) => safeInvoke('tab:stopFind', { tabId, action }),
    setBounds: (x: number, y: number, w: number, h: number) => safeInvoke('tab:setBounds', { x, y, w, h }),
    setRuffleMode: (tabId: string, enabled: boolean, source: 'bundled' | 'cdn') =>
      safeInvoke('tab:setRuffleMode', { tabId, enabled, source }),
  },

  config: {
    get: () => safeInvoke('load-config'),
    testProxy: (proxy: import('../shared/types/proxy').ProxySettings, url: string) => safeInvoke('proxy:test', { proxy, url }),
  },

  cache: {
    clear: () => safeInvoke('cache:clear', {}),
  },

  dl: {
    start: (url: string, filename?: string) => safeSend('download:start', { url, filename }),
    cancel: (id: string) => safeSend('download:cancel', { id }),
    pause: (id: string) => safeInvoke('download:pause', { id }),
    resume: (id: string) => safeInvoke('download:resume', { id }),
    open: (savePath: string) => safeSend('download:open', { savePath }),
    openDir: (savePath: string) => safeSend('download:openDir', { savePath }),
    openFolder: () => safeInvoke('download:open-folder', {}),
    getDir: () => safeInvoke('download:get-dir'),
    setDir: (title?: string) => safeInvoke('download:set-dir', { title }),
    deleteFile: (savePath: string) => safeInvoke('download:delete-file', { savePath }),
    list: () => safeInvoke('download:list'),
    removeRecord: (id: string) => safeInvoke('download:remove-record', { id }),
    clearFinished: () => safeInvoke('download:clear-finished'),
  },

  pwd: {
    status: () => safeInvoke('password:status'),
    init: () => safeInvoke('password:init'),
    toggleEnabled: () => safeInvoke('password:toggle-enabled'),
    setAutoCapture: (enabled: boolean) => safeInvoke('password:set-auto-capture', { enabled }),
    setAutoFill: (enabled: boolean) => safeInvoke('password:set-auto-fill', { enabled }),
    setExcludedSites: (sites: string[]) => safeInvoke('password:set-excluded-sites', { sites }),
    list: () => safeInvoke('password:list'),
    saveConfirm: (captureId: string) => safeInvoke('password:save-confirm', { captureId }),
    ignore: (captureId: string) => safeInvoke('password:ignore', { captureId }),
    delete: (id: string) => safeInvoke('password:delete', { id }),
    // secret 只在查看密码模式下携带（A 档由主进程弹系统对话框）。
    reveal: (id: string, secret?: string) => safeInvoke('password:reveal', { id, secret }),
    setViewPassword: (password: string, current?: string) => safeInvoke('password:set-view-password', { password, current }),
    resetOsAuth: () => safeInvoke('password:reset-os-auth'),
    setDefault: (id: string) => safeInvoke('password:set-default', { id }),
    fill: (tabId: string, id: string) => safeInvoke('password:fill', { tabId, id }),
    resetAll: () => safeInvoke('password:reset'),
    retryKey: () => safeInvoke('password:retry-key'),
    rebuildVault: (confirm: string) => safeInvoke('password:rebuild-vault', { confirm }),
  },

  diagnostics: {
    export: () => safeInvoke('diagnostics:export'),
  },

  devtoolbox: {
    snapshot: () => safeInvoke('devtoolbox:snapshot'),
    clear: () => safeInvoke('devtoolbox:clear'),
    devtoolsUrl: (target: 'page' | 'shell') => safeInvoke('devtoolbox:devtools-url', { target }),
    openNative: (target: 'page' | 'shell') => safeInvoke('devtoolbox:open-native', { target }),
    probePage: () => safeInvoke('devtoolbox:probe-page'),
    /** 独立窗口模式：把前端整页放进一个独立 BrowserWindow。 */
    openDevToolsWindow: (target?: 'page' | 'shell') => safeInvoke('devtoolbox:open-devtools-window', target ? { target } : {}),
    closeDevToolsWindow: () => safeInvoke('devtoolbox:close-devtools-window'),
    onDevToolsWindowClosed: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('devtoolbox:devtools-window-closed', listener);
      return () => { ipcRenderer.removeListener('devtoolbox:devtools-window-closed', listener); };
    },
    /** 内嵌前端视图：用独立 WebContents（BrowserView）承载前端，而不是 iframe。 */
    attachDevToolsView: (target: 'page' | 'shell') => safeInvoke('devtoolbox:attach-devtools-view', { target }),
    setDevToolsBounds: (rect: { x: number; y: number; width: number; height: number }) =>
      safeInvoke('devtoolbox:set-devtools-bounds', rect),
    /** 拖拽专用：同步更新，避免原生视图落后布局一帧（见 ALLOWED_SYNC_CHANNELS）。 */
    setDevToolsBoundsSync: (rect: { x: number; y: number; width: number; height: number }) =>
      safeSendSync('devtoolbox:set-devtools-bounds-sync', rect),
    detachDevToolsView: () => safeInvoke('devtoolbox:detach-devtools-view'),
    onEntries: (callback: (entries: unknown[]) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, entries: unknown[]) => callback(entries);
      ipcRenderer.on('devtoolbox:entries', listener);
      return () => { ipcRenderer.removeListener('devtoolbox:entries', listener); };
    },
    onCleared: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('devtoolbox:cleared', listener);
      return () => { ipcRenderer.removeListener('devtoolbox:cleared', listener); };
    },
    /**
     * CDP 桥（桥 v2）：把当前活动标签的 target 挂到桥、然后经桥收发 CDP 消息。
     * 规格 docs/archive/superpowers/specs/2026-11-06-devtools-cdp-bridge-design.md。
     * 事件按 16ms 合批下发（主进程侧完成），这里只做解包。
     *
     * B3 之后这条 IPC 只剩两个用途：外壳 renderer 调 `attach`（切标签热切换，
     * 前端容器不重建）、探针调 `stats`。真正的 CDP 收发已迁到前端自己的
     * preload（`src/preload/devtools.ts` 的 `bfbBridge`），不再经过这里。
     */
    bridge: {
      attach: (target?: 'page' | 'shell') => safeInvoke('devtoolbox:bridge-attach', target ? { target } : {}),
      detach: () => safeInvoke('devtoolbox:bridge-detach'),
      send: (method: string, params?: Record<string, unknown>, sessionId?: string, id?: number) => safeInvoke('devtoolbox:bridge-send', { method, params, sessionId, id }),
      stats: () => safeInvoke('devtoolbox:bridge-stats'),
      onEvents: (callback: (events: unknown[]) => void) => {
        const listener = (_event: Electron.IpcRendererEvent, payload: { events?: unknown[] }) => callback(payload?.events ?? []);
        ipcRenderer.on('devtoolbox:bridge-event', listener);
        return () => { ipcRenderer.removeListener('devtoolbox:bridge-event', listener); };
      },
    },
  },

  file: {
    openSwf: () => safeInvoke('file:open-swf'),
  },

  session: {
    recoveryStatus: () => safeInvoke('session:recovery-status'),
    resolveRecovery: () => safeInvoke('session:resolve-recovery'),
  },

  win: {
    minimize: () => safeInvoke('win:minimize'),
    maximize: () => safeInvoke('win:maximize'),
    unmaximize: () => safeInvoke('win:unmaximize'),
    close: () => safeInvoke('win:close'),
    setFullscreen: (fullscreen: boolean) => safeInvoke('win:setFullscreen', fullscreen),
    toggleFullscreen: () => safeInvoke('win:toggleFullscreen'),
    isMaximized: () => safeInvoke('win:isMaximized') as Promise<boolean>,
  },

  userscripts: {
    list: () => safeInvoke('userscripts:list', {}),
    getSource: (id: string) => safeInvoke('userscripts:get-source', { id }),
    parseSource: (source: string) => safeInvoke('userscripts:parse-source', { source }),
    installSource: (source: string, enabled?: boolean) => safeInvoke('userscripts:install-source', { source, enabled }),
    installFile: (title?: string) => safeInvoke('userscripts:install-file', { title }),
    installUrl: (url: string) => safeInvoke('userscripts:install-url', { url }),
    uninstall: (id: string) => safeInvoke('userscripts:uninstall', { id }),
    setEnabled: (id: string, enabled: boolean) => safeInvoke('userscripts:set-enabled', { id, enabled }),
    updateSource: (id: string, source: string) => safeInvoke('userscripts:update-source', { id, source }),
    forTab: (tabId: string, url: string) => safeInvoke('userscripts:for-tab', { tabId, url }),
    invokeCommand: (tabId: string, commandId: string) => safeInvoke('userscripts:invoke-command', { tabId, commandId }),
    checkUpdates: () => safeInvoke('userscripts:check-updates', {}),
    applyUpdate: (id: string) => safeInvoke('userscripts:apply-update', { id }),
    backgroundStatus: () => safeInvoke('userscripts:background-status', {}),
    backgroundRestart: (id?: string) => safeInvoke('userscripts:background-restart', id ? { id } : {}),
    exportSource: (id: string, title?: string) => safeInvoke('userscripts:export-source', { id, title }),
    listValues: (id: string) => safeInvoke('userscripts:list-values', { id }),
    setValueAdmin: (id: string, key: string, value: unknown) => safeInvoke('userscripts:set-value-admin', { id, key, value }),
    deleteValueAdmin: (id: string, key: string) => safeInvoke('userscripts:delete-value-admin', { id, key }),
    onChanged: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('userscripts:changed', listener);
      return () => { ipcRenderer.removeListener('userscripts:changed', listener); };
    },
  },

  screenshot: {
    getDir: () => safeInvoke('screenshot:get-dir', {}),
    capture: (tabId: string, opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture', { tabId, ...opts }),
    captureActive: (opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture-active', { ...opts }),
    reveal: (filePath: string) => safeInvoke('screenshot:reveal', { filePath }),
    setDir: (title?: string) => safeInvoke('screenshot:set-dir', { title }),
  },

    automationV3: {
      showAssistant: (tabId: string) => safeInvoke('automation-v3:show-assistant', { tabId }),
    listPackages: () => safeInvoke('automation-v3:list', {}),
    getPackage: (packageId: string) => safeInvoke('automation-v3:get', { packageId }),
    createPackage: (id: string, name: string) => safeInvoke('automation-v3:create', { id, name }),
    validateWorkflow: (workflow: unknown) => safeInvoke('automation-v3:validate-workflow', { workflow }),
    updateWorkflow: (packageId: string, workflow: unknown) => safeInvoke('automation-v3:update-workflow', { packageId, workflow }),
    upsertScript: (packageId: string, id: string, name: string, source: string, permissions: string[], language?: 'javascript' | 'typescript') =>
      safeInvoke('automation-v3:upsert-script', { packageId, id, name, source, permissions, language }),
    deleteScript: (packageId: string, scriptId: string) => safeInvoke('automation-v3:delete-script', { packageId, scriptId }),
    setMainEntry: (packageId: string, entryId: string) => safeInvoke('automation-v3:set-main-entry', { packageId, entryId }),
    deletePackage: (packageId: string) => safeInvoke('automation-v3:delete', { packageId }),
    openPackage: (i18n?: { title?: string; filterName?: string }) => safeInvoke('automation-v3:open', i18n ?? {}),
    installPackage: (token: string, replace?: boolean, approvals?: Record<string, string[]>) => safeInvoke('automation-v3:install', { token, replace, approvals }),
    exportPackage: (packageId: string, i18n?: { title?: string; filterName?: string }) => safeInvoke('automation-v3:export', { packageId, ...i18n }),
    status: () => safeInvoke('automation-v3:status', {}),
    start: (packageId: string, frontendId: string, tabId: string, profilePath?: string) => safeInvoke('automation-v3:start', { packageId, frontendId, tabId, profilePath }),
      cancel: () => safeInvoke('automation-v3:cancel', {}),
      readClipboard: () => safeInvoke('automation-v3:read-clipboard', {}),
      assetPreview: (packageId: string, asset: string) => safeInvoke('automation-v3:asset-preview', { packageId, asset }),
      openTestScene: () => safeInvoke('automation-v3:open-test-scene', {}),
      testAssetOnScene: (packageId: string, token: string, asset: string, threshold: number, scales: number[], mask: 'auto' | 'none' | 'alpha') => safeInvoke('automation-v3:test-asset-on-scene', { packageId, token, asset, threshold, scales, mask }),
      testTextOnScene: (token: string, text: string, match: 'contains' | 'exact', minConfidence: number) => safeInvoke('automation-v3:test-text-on-scene', { token, text, match, minConfidence }),
      importAssets: (packageId: string) => safeInvoke('automation-v3:import-assets', { packageId }),
      importAssetFolder: (packageId: string) => safeInvoke('automation-v3:import-asset-folder', { packageId }),
      deleteAsset: (packageId: string, asset: string) => safeInvoke('automation-v3:delete-asset', { packageId, asset }),
      captureAssetFrame: (packageId: string, tabId: string) => safeInvoke('automation-v3:capture-asset-frame', { packageId, tabId }),
      saveCapturedAsset: (packageId: string, token: string, assetName: string, rect: { x: number; y: number; width: number; height: number }, overwrite?: boolean) => safeInvoke('automation-v3:save-captured-asset', { packageId, token, assetName, rect, overwrite }),
      testAsset: (packageId: string, tabId: string, asset: string, threshold: number, scales: number[], mask: 'auto' | 'none' | 'alpha') => safeInvoke('automation-v3:test-asset', { packageId, tabId, asset, threshold, scales, mask }),
      testText: (packageId: string, tabId: string, text: string, match: 'contains' | 'exact', minConfidence: number) => safeInvoke('automation-v3:test-text', { packageId, tabId, text, match, minConfidence }),
      testAssetPreview: (packageId: string, tabId: string, asset: string, threshold: number, scales: number[], mask: 'auto' | 'none' | 'alpha') => safeInvoke('automation-v3:test-asset-preview', { packageId, tabId, asset, threshold, scales, mask }),
      testTextPreview: (packageId: string, tabId: string, text: string, match: 'contains' | 'exact', minConfidence: number) => safeInvoke('automation-v3:test-text-preview', { packageId, tabId, text, match, minConfidence }),
    },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
