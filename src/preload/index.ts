import { contextBridge, ipcRenderer } from 'electron';
import path from 'path';

const electronAPI = {
  on(channel: string, callback: (...args: unknown[]) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
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
