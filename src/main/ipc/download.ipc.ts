import { BrowserWindow, ipcMain, shell, session, dialog } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { cancelDownload, pauseDownload, resumeDownload, getAria2Status, getDownloadDir } from '../modules/download';
import { saveConfig } from '../modules/config';
import { getMainWindow } from '../modules/window';

// --- L02: 路径穿越校验 ---
function isPathAllowed(savePath: string): boolean {
  const allowed = path.resolve(getDownloadDir());
  const target = path.resolve(savePath);
  return target === allowed || target.startsWith(allowed + path.sep);
}

// --- L03: 危险扩展名黑名单 ---
const DANGEROUS_EXTS = new Set(['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.wsf', '.scr', '.com']);

// --- L06: 允许的下载协议 ---
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

export function registerDownloadIPC(): void {
  ipcMain.handle('download:aria2-status', () => {
    return getAria2Status();
  });

  ipcMain.handle('download:get-dir', () => {
    return getDownloadDir();
  });

  ipcMain.handle('download:set-dir', async () => {
    const win = BrowserWindow.getFocusedWindow() || getMainWindow();
    if (!win) return null;
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
    if (!isPathAllowed(savePath)) {
      log.warn('[Download] path rejected (out of download dir):', savePath);
      return false;
    }
    try {
      fs.unlinkSync(savePath);
      log.info('[Download] file deleted:', savePath);
      return true;
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        log.info('[Download] file already removed:', savePath);
        return true;
      }
      log.error('[Download] delete file failed:', e.message);
      return false;
    }
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
    if (!savePath || !isPathAllowed(savePath)) {
      log.warn('[Download] open rejected (out of download dir):', savePath);
      return;
    }
    const ext = path.extname(savePath).toLowerCase();
    if (DANGEROUS_EXTS.has(ext)) {
      log.warn('[Download] open rejected (dangerous extension):', savePath);
      return;
    }
    if (fs.existsSync(savePath)) {
      shell.openPath(savePath);
    }
  });

  ipcMain.on('download:openDir', (_event, { savePath }: { savePath: string }) => {
    if (!savePath || !isPathAllowed(savePath)) {
      log.warn('[Download] openDir rejected (out of download dir):', savePath);
      return;
    }
    const dir = path.dirname(savePath);
    if (fs.existsSync(dir)) shell.openPath(dir);
  });

  ipcMain.on('download:start', (_event, { url, filename: _filename }: { url: string; filename?: string }) => {
    try {
      const proto = new URL(url).protocol;
      if (!ALLOWED_PROTOCOLS.has(proto)) {
        log.warn('[Download] start rejected (disallowed protocol):', proto, url);
        return;
      }
    } catch {
      log.warn('[Download] start rejected (invalid URL):', url);
      return;
    }
    log.info('[Download] manual start:', url);
    session.defaultSession.downloadURL(url);
  });

  log.info('[Download] IPC registered');
}
