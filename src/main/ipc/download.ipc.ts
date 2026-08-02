import { BrowserWindow, ipcMain, shell, session, dialog } from 'electron';
import log from 'electron-log';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { cancelDownload, pauseDownload, resumeDownload, getAria2Status, getDownloadDir } from '../modules/download';
import { saveConfig } from '../modules/config';
import { getMainWindow } from '../modules/window';
import { createValidatedHandler, registerValidatedListener } from '../utils/ipc-wrapper';
import { isPathWithinDirectory } from '../utils/download-path';
import {
  adoptDownloadRecords, clearFinishedDownloadRecords, getDownloadRecords, removeDownloadRecord,
} from '../modules/download-state';

// --- L02: 路径穿越校验 ---
function isPathAllowed(savePath: string): boolean {
  return isPathWithinDirectory(getDownloadDir(), savePath);
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

  createValidatedHandler('download:list', z.undefined(), () => getDownloadRecords());

  const downloadRecord = z.object({
    id: z.string().min(1).max(128),
    url: z.string().max(8192),
    filename: z.string().min(1).max(255),
    state: z.enum(['progressing', 'completed', 'cancelled', 'interrupted', 'paused']),
    progress: z.number().finite().min(0).max(100),
    speed: z.number().finite().min(0),
    receivedBytes: z.number().finite().min(0),
    totalBytes: z.number().finite().min(0),
    savePath: z.string().max(32767),
    engine: z.enum(['chromium', 'aria2']).optional(),
  });
  createValidatedHandler('download:sync-records', z.object({
    records: z.array(downloadRecord).max(1000),
  }).strict(), ({ records }) => adoptDownloadRecords(records));

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

  const pathArg = z.object({ savePath: z.string().min(1).max(32767) }).strict();
  const idArg = z.object({ id: z.string().min(1).max(128) }).strict();

  createValidatedHandler('download:remove-record', idArg, ({ id }) => {
    removeDownloadRecord(id);
    return { success: true };
  });
  createValidatedHandler('download:clear-finished', z.undefined(), () => {
    clearFinishedDownloadRecords();
    return { success: true };
  });

  createValidatedHandler('download:delete-file', pathArg, async ({ savePath }) => {
    if (!isPathAllowed(savePath)) {
      log.warn('[Download] path rejected (out of download dir):', savePath);
      return false;
    }
    try {
      const stat = await fs.promises.lstat(savePath);
      if (!stat.isFile()) {
        log.warn('[Download] delete rejected (not a regular file):', savePath);
        return false;
      }
      await fs.promises.unlink(savePath);
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

  registerValidatedListener('download:cancel', idArg, (_event, { id }) => {
    log.info('[Download] cancel requested:', id);
    cancelDownload(id);
  });

  registerValidatedListener('download:pause', idArg, (_event, { id }) => {
    log.info('[Download] pause requested:', id);
    pauseDownload(id);
  });

  registerValidatedListener('download:resume', idArg, (_event, { id }) => {
    log.info('[Download] resume requested:', id);
    resumeDownload(id);
  });

  registerValidatedListener('download:open', pathArg, (_event, { savePath }) => {
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

  registerValidatedListener('download:openDir', pathArg, (_event, { savePath }) => {
    if (!savePath || !isPathAllowed(savePath)) {
      log.warn('[Download] openDir rejected (out of download dir):', savePath);
      return;
    }
    const dir = path.dirname(savePath);
    if (fs.existsSync(dir)) shell.openPath(dir);
  });

  registerValidatedListener('download:start', z.object({
    url: z.string().url().max(8192), filename: z.string().max(255).optional(),
  }).strict(), (_event, { url, filename: _filename }) => {
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
