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
]);

const ALLOWED_INVOKE_CHANNELS = new Set([
    'tab:create', 'tab:close', 'tab:suspend', 'tab:activate', 'tab:navigate', 'tab:goBack', 'tab:goForward',
  'tab:reload', 'tab:stop', 'tab:zoom', 'tab:mute', 'tab:devtools', 'tab:find', 'tab:stopFind',
  'tab:setBounds', 'tab:setRuffleMode',
  'load-config', 'save-config',
  'cache:clear',
  'download:aria2-status', 'download:get-dir', 'download:set-dir', 'download:delete-file',
  'download:list', 'download:sync-records', 'download:remove-record', 'download:clear-finished',
  'password:status', 'password:setup', 'password:unlock', 'password:lock',
  'password:toggle-enabled', 'password:set-auto-capture', 'password:set-auto-fill', 'password:set-excluded-sites', 'password:list', 'password:save-confirm',
  'password:ignore', 'password:delete', 'password:get-password', 'password:set-default',
  'password:reset', 'password:fill',
  'diagnostics:export',
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
  'screenshot:capture', 'screenshot:capture-active', 'screenshot:reveal', 'screenshot:set-dir',
    'automation-v3:list', 'automation-v3:get', 'automation-v3:create', 'automation-v3:validate-workflow',
    'automation-v3:update-workflow', 'automation-v3:upsert-script', 'automation-v3:set-main-entry', 'automation-v3:delete',
    'automation-v3:open', 'automation-v3:install', 'automation-v3:export',
    'automation-v3:status', 'automation-v3:start', 'automation-v3:cancel',
    'automation-v3:read-clipboard', 'automation-v3:asset-preview',
    'automation-v3:open-test-scene', 'automation-v3:test-asset-on-scene', 'automation-v3:test-text-on-scene',
    'automation-v3:import-assets', 'automation-v3:import-asset-folder', 'automation-v3:delete-asset',
    'automation-v3:capture-asset-frame', 'automation-v3:save-captured-asset',
    'automation-v3:test-asset', 'automation-v3:test-text', 'automation-v3:test-asset-preview', 'automation-v3:test-text-preview',
]);

const ALLOWED_SEND_CHANNELS = new Set([
  'download:start', 'download:cancel', 'download:pause', 'download:resume',
  'download:open', 'download:openDir',
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
  },

  cache: {
    clear: () => safeInvoke('cache:clear', {}),
  },

  dl: {
    start: (url: string, filename?: string) => safeSend('download:start', { url, filename }),
    cancel: (id: string) => safeSend('download:cancel', { id }),
    pause: (id: string) => safeSend('download:pause', { id }),
    resume: (id: string) => safeSend('download:resume', { id }),
    open: (savePath: string) => safeSend('download:open', { savePath }),
    openDir: (savePath: string) => safeSend('download:openDir', { savePath }),
    getDir: () => safeInvoke('download:get-dir'),
    setDir: (title?: string) => safeInvoke('download:set-dir', { title }),
    deleteFile: (savePath: string) => safeInvoke('download:delete-file', { savePath }),
    list: () => safeInvoke('download:list'),
    syncRecords: (records: import('@shared/types/downloads').DownloadItem[]) => safeInvoke('download:sync-records', { records }),
    removeRecord: (id: string) => safeInvoke('download:remove-record', { id }),
    clearFinished: () => safeInvoke('download:clear-finished'),
  },

  pwd: {
    status: () => safeInvoke('password:status'),
    setup: (password: string) => safeInvoke('password:setup', { password }),
    unlock: (password: string) => safeInvoke('password:unlock', { password }),
    lock: () => safeInvoke('password:lock'),
    toggleEnabled: () => safeInvoke('password:toggle-enabled'),
    setAutoCapture: (enabled: boolean) => safeInvoke('password:set-auto-capture', { enabled }),
    setAutoFill: (enabled: boolean) => safeInvoke('password:set-auto-fill', { enabled }),
    setExcludedSites: (sites: string[]) => safeInvoke('password:set-excluded-sites', { sites }),
    list: () => safeInvoke('password:list'),
    saveConfirm: (captureId: string) => safeInvoke('password:save-confirm', { captureId }),
    ignore: (captureId: string) => safeInvoke('password:ignore', { captureId }),
    delete: (id: string) => safeInvoke('password:delete', { id }),
    getPassword: (id: string) => safeInvoke('password:get-password', { id }),
    setDefault: (id: string) => safeInvoke('password:set-default', { id }),
    fill: (tabId: string, id: string) => safeInvoke('password:fill', { tabId, id }),
    resetAll: () => safeInvoke('password:reset'),
  },

  diagnostics: {
    export: () => safeInvoke('diagnostics:export'),
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
    capture: (tabId: string, opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture', { tabId, ...opts }),
    captureActive: (opts?: { save?: boolean; savePath?: string; returnData?: boolean; rect?: { x: number; y: number; width: number; height: number } }) =>
      safeInvoke('screenshot:capture-active', { ...opts }),
    reveal: (filePath: string) => safeInvoke('screenshot:reveal', { filePath }),
    setDir: (title?: string) => safeInvoke('screenshot:set-dir', { title }),
  },

    automationV3: {
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
