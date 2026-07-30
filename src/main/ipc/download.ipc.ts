import { BrowserWindow, ipcMain, shell, session, dialog } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { cancelDownload, pauseDownload, resumeDownload, getAria2Status, getDownloadDir } from '../modules/download';
import { saveConfig } from '../modules/config';

export function registerDownloadIPC(): void {
  ipcMain.handle('download:aria2-status', () => {
    return getAria2Status();
  });

  ipcMain.handle('download:get-dir', () => {
    return getDownloadDir();
  });

  ipcMain.handle('download:set-dir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: getDownloadDir(),
      title: '选择下载目录',
    });
    if (!result.canceled && result.filePaths[0]) {
      const dir = result.filePaths[0];
      saveConfig({ downloadDir: dir });
      log.info('[Download] directory changed to:', dir);
      return dir;
    }
    return null;
  });

  ipcMain.handle('download:delete-file', (_event, { savePath }: { savePath: string }) => {
    try {
      if (savePath && fs.existsSync(savePath)) {
        fs.unlinkSync(savePath);
        log.info('[Download] file deleted:', savePath);
        return true;
      }
    } catch (e: any) {
      log.error('[Download] delete file failed:', e.message);
    }
    return false;
  });

  ipcMain.on('download:cancel', (_event, { id }: { id: string }) => {
    log.info('[Download] cancel requested:', id);
    cancelDownload(id);
  });

  ipcMain.on('download:pause', (_event, { id }: { id: string }) => {
    log.info('[Download] pause requested:', id);
    pauseDownload(id);
  });

  ipcMain.on('download:resume', (_event, { id }: { id: string }) => {
    log.info('[Download] resume requested:', id);
    resumeDownload(id);
  });

  ipcMain.on('download:open', (_event, { savePath }: { savePath: string }) => {
    if (savePath && fs.existsSync(savePath)) {
      shell.openPath(savePath);
    }
  });

  ipcMain.on('download:openDir', (_event, { savePath }: { savePath: string }) => {
    if (savePath) {
      const dir = path.dirname(savePath);
      if (fs.existsSync(dir)) shell.openPath(dir);
    }
  });

  ipcMain.on('download:start', (_event, { url, filename: _filename }: { url: string; filename?: string }) => {
    log.info('[Download] manual start:', url);
    session.defaultSession.downloadURL(url);
  });

  log.info('[Download] IPC registered');
}
