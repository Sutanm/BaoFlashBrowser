// src/main/ipc/screenshot.ipc.ts
import fs from 'fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import log from 'electron-log';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { captureTab, getScreenshotDir } from '../modules/screenshot';
import { tabManager } from '../modules/tabs';
import { saveConfig } from '../modules/config';
import { isPathWithinDirectory } from '../utils/download-path';

const rectSchema = z.object({
  x: z.number().finite(), y: z.number().finite(),
  width: z.number().finite().min(1), height: z.number().finite().min(1),
});
const commonSchema = {
  save: z.boolean().optional(),
  savePath: z.string().max(32767).optional(),
  returnData: z.boolean().optional(),
  rect: rectSchema.optional(),
};

export function registerScreenshotIPC(getWin: () => BrowserWindow | null): void {
  createValidatedHandler('screenshot:capture',
    z.object({ tabId: z.string().min(1).max(128), ...commonSchema }).strict(),
    (args) => captureTab(args.tabId, args));
  createValidatedHandler('screenshot:capture-active',
    z.object(commonSchema).strict(),
    (args) => {
      const activeId = tabManager.getActiveId();
      if (!activeId) return { success: false, code: 'NO_ACTIVE_TAB', error: 'No active tab' };
      return captureTab(activeId, args);
    });

  // Electron 11: showItemInFolder 返回 void 不抛异常 → existsSync 前置
  createValidatedHandler('screenshot:reveal',
    z.object({ filePath: z.string().min(1).max(32767) }).strict(),
    ({ filePath }) => {
      const dir = getScreenshotDir();
      if (!isPathWithinDirectory(dir, filePath)) {
        return { success: false, code: 'PATH_DENIED', error: 'Path outside screenshot directory' };
      }
      if (!fs.existsSync(filePath)) {
        return { success: false, code: 'REVEAL_FAILED', error: 'File does not exist' };
      }
      shell.showItemInFolder(filePath);
      return { success: true };
    });

  // set-dir 用裸 ipcMain.handle：需要 getWin 闭包（dialog 父窗口）+ 无参通道不需 zod 校验
  ipcMain.handle('screenshot:set-dir', async (_event, payload?: { title?: string }) => {
    try {
      const win = getWin() ?? BrowserWindow.getFocusedWindow();
      if (!win) {
        log.warn('[Screenshot] set-dir aborted (no window)');
        return { success: false, code: 'NO_WINDOW', error: 'No window available' };
      }
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: getScreenshotDir(),
        title: (payload?.title as string | undefined) ?? 'Select Screenshot Folder',
      });
      if (result.canceled || !result.filePaths[0]) return { success: true, canceled: true };
      const dir = result.filePaths[0];
      try {
        await fs.promises.access(dir, fs.constants.W_OK);
      } catch {
        log.warn('[Screenshot] set-dir rejected (not writable):', dir);
        return { success: false, code: 'DIR_NOT_WRITABLE', error: 'Selected directory is not writable', dir };
      }
      if (isPathWithinDirectory(app.getPath('userData'), dir)) {
        log.warn('[Screenshot] set-dir rejected (within userData):', dir);
        return { success: false, code: 'DIR_DENIED', error: 'Screenshots directory cannot be within userData', dir };
      }
      saveConfig({ screenshotDir: dir });
      log.info('[Screenshot] directory changed to:', dir);
      return { success: true, dir };
    } catch (e) {
      log.error('[Screenshot] set-dir failed:', e instanceof Error ? e.message : e);
      return { success: false, code: 'SET_DIR_FAILED', error: e instanceof Error ? e.message : String(e) };
    }
  });
}
