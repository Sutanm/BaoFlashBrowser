import { contextBridge, ipcRenderer } from 'electron';
import path from 'path';
import type { FindInPageOptions } from 'electron';

// --- L04: IPC 通道白名单 ---
const ALLOWED_ON_CHANNELS = new Set([
  'tab:updated', 'tab:found', 'tab:load-error', 'tab:crashed', 'tab:newwindow',
  'download:progress', 'aria2:status', 'navigate-url',
  'shortcut',
  'password:captured', 'password:changed',
]);

const ALLOWED_INVOKE_CHANNELS = new Set([
  'tab:create', 'tab:close', 'tab:activate', 'tab:navigate', 'tab:goBack', 'tab:goForward',
  'tab:reload', 'tab:stop', 'tab:zoom', 'tab:mute', 'tab:devtools', 'tab:find', 'tab:stopFind',
  'tab:setBounds', 'tab:setRuffleMode',
  'load-config', 'save-config',
  'download:aria2-status', 'download:get-dir', 'download:set-dir', 'download:delete-file',
  'password:status', 'password:setup', 'password:unlock', 'password:lock',
  'password:toggle-enabled', 'password:list', 'password:save-confirm',
  'password:ignore', 'password:delete', 'password:get-password', 'password:set-default',
  'password:reset',
  'win:minimize', 'win:maximize', 'win:unmaximize', 'win:close', 'win:setFullscreen', 'win:toggleFullscreen', 'win:isMaximized',
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
    create: (tabId: string, url: string) => safeInvoke('tab:create', { tabId, url }),
    close: (tabId: string) => safeInvoke('tab:close', { tabId }),
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

  dl: {
    start: (url: string, filename?: string) => safeSend('download:start', { url, filename }),
    cancel: (id: string) => safeSend('download:cancel', { id }),
    pause: (id: string) => safeSend('download:pause', { id }),
    resume: (id: string) => safeSend('download:resume', { id }),
    open: (savePath: string) => safeSend('download:open', { savePath }),
    openDir: (savePath: string) => safeSend('download:openDir', { savePath }),
    getDir: () => safeInvoke('download:get-dir'),
    setDir: () => safeInvoke('download:set-dir'),
    deleteFile: (savePath: string) => safeInvoke('download:delete-file', { savePath }),
  },

  pwd: {
    status: () => safeInvoke('password:status'),
    setup: (password: string) => safeInvoke('password:setup', { password }),
    unlock: (password: string) => safeInvoke('password:unlock', { password }),
    lock: () => safeInvoke('password:lock'),
    toggleEnabled: () => safeInvoke('password:toggle-enabled'),
    list: () => safeInvoke('password:list'),
    saveConfirm: (captureId: string) => safeInvoke('password:save-confirm', { captureId }),
    ignore: (captureId: string) => safeInvoke('password:ignore', { captureId }),
    delete: (id: string) => safeInvoke('password:delete', { id }),
    getPassword: (id: string) => safeInvoke('password:get-password', { id }),
    setDefault: (id: string) => safeInvoke('password:set-default', { id }),
    resetAll: () => safeInvoke('password:reset'),
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
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
