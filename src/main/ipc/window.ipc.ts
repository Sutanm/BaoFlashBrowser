import { ipcMain, BrowserWindow } from 'electron';

export function registerWindowIPC(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('win:minimize', () => {
    getWindow()?.minimize();
  });

  ipcMain.handle('win:maximize', () => {
    getWindow()?.maximize();
  });

  ipcMain.handle('win:unmaximize', () => {
    getWindow()?.unmaximize();
  });

  ipcMain.handle('win:close', () => {
    getWindow()?.close();
  });

  ipcMain.handle('win:setFullscreen', (_e, fullscreen: boolean) => {
    getWindow()?.setFullScreen(fullscreen);
  });

  ipcMain.handle('win:isMaximized', () => {
    return getWindow()?.isMaximized() ?? false;
  });
}
