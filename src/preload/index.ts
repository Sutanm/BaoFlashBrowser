import { contextBridge, ipcRenderer } from 'electron';
import path from 'path';

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

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      console.warn('[Preload] invoke() rejected: unauthorized channel', channel);
      return Promise.reject(new Error('Unauthorized IPC channel: ' + channel));
    }
    return ipcRenderer.invoke(channel, ...args);
  },

  webviewPreloadPath: path.join(__dirname, 'webview-preload.js'),

  tab: {
    create: (tabId: string, url: string) => ipcRenderer.invoke('tab:create', { tabId, url }),
    close: (tabId: string) => ipcRenderer.invoke('tab:close', { tabId }),
    activate: (tabId: string) => ipcRenderer.invoke('tab:activate', { tabId }),
    navigate: (tabId: string, url: string) => ipcRenderer.invoke('tab:navigate', { tabId, url }),
    goBack: (tabId: string) => ipcRenderer.invoke('tab:goBack', { tabId }),
    goForward: (tabId: string) => ipcRenderer.invoke('tab:goForward', { tabId }),
    reload: (tabId: string) => ipcRenderer.invoke('tab:reload', { tabId }),
    stop: (tabId: string) => ipcRenderer.invoke('tab:stop', { tabId }),
    zoom: (tabId: string, factor: number) => ipcRenderer.invoke('tab:zoom', { tabId, factor }),
    mute: (tabId: string, muted: boolean) => ipcRenderer.invoke('tab:mute', { tabId, muted }),
    devtools: (tabId: string) => ipcRenderer.invoke('tab:devtools', { tabId }),
    find: (tabId: string, text: string, options?: any) => ipcRenderer.invoke('tab:find', { tabId, text, options }),
    stopFind: (tabId: string, action: string) => ipcRenderer.invoke('tab:stopFind', { tabId, action }),
    setBounds: (x: number, y: number, w: number, h: number) => ipcRenderer.invoke('tab:setBounds', { x, y, w, h }),
    setRuffleMode: (tabId: string, enabled: boolean, source: 'bundled' | 'cdn') =>
      ipcRenderer.invoke('tab:setRuffleMode', { tabId, enabled, source }),
  },

  config: {
    get: () => ipcRenderer.invoke('load-config'),
  },

  dl: {
    start: (url: string, filename?: string) => ipcRenderer.send('download:start', { url, filename }),
    cancel: (id: string) => ipcRenderer.send('download:cancel', { id }),
    pause: (id: string) => ipcRenderer.send('download:pause', { id }),
    resume: (id: string) => ipcRenderer.send('download:resume', { id }),
    open: (savePath: string) => ipcRenderer.send('download:open', { savePath }),
    openDir: (savePath: string) => ipcRenderer.send('download:openDir', { savePath }),
    getDir: () => ipcRenderer.invoke('download:get-dir'),
    setDir: () => ipcRenderer.invoke('download:set-dir'),
    deleteFile: (savePath: string) => ipcRenderer.invoke('download:delete-file', { savePath }),
  },

  pwd: {
    status: () => ipcRenderer.invoke('password:status'),
    setup: (password: string) => ipcRenderer.invoke('password:setup', { password }),
    unlock: (password: string) => ipcRenderer.invoke('password:unlock', { password }),
    lock: () => ipcRenderer.invoke('password:lock'),
    toggleEnabled: () => ipcRenderer.invoke('password:toggle-enabled'),
    list: () => ipcRenderer.invoke('password:list'),
    saveConfirm: (captureId: string) => ipcRenderer.invoke('password:save-confirm', { captureId }),
    ignore: (captureId: string) => ipcRenderer.invoke('password:ignore', { captureId }),
    delete: (id: string) => ipcRenderer.invoke('password:delete', { id }),
    getPassword: (id: string) => ipcRenderer.invoke('password:get-password', { id }),
  setDefault: (id: string) => ipcRenderer.invoke('password:set-default', { id }),
  resetAll: () => ipcRenderer.invoke('password:reset'),
},

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    unmaximize: () => ipcRenderer.invoke('win:unmaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    setFullscreen: (fullscreen: boolean) =>
      ipcRenderer.invoke('win:setFullscreen', fullscreen),
    toggleFullscreen: () => ipcRenderer.invoke('win:toggleFullscreen'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized') as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
