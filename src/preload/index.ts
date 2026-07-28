import { contextBridge, ipcRenderer } from 'electron';

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

  win: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    unmaximize: () => ipcRenderer.invoke('win:unmaximize'),
    close: () => ipcRenderer.invoke('win:close'),
    setFullscreen: (fullscreen: boolean) =>
      ipcRenderer.invoke('win:setFullscreen', fullscreen),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized') as Promise<boolean>,
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);
