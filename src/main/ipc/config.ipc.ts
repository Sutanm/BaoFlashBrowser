import { ipcMain } from 'electron';
import log from 'electron-log';
import { loadConfig, saveConfig } from '../modules/config';

export function registerConfigIPC(): void {
  ipcMain.handle('load-config', () => {
    return loadConfig();
  });

  ipcMain.handle('save-config', (_event, cfg) => {
    try {
      return saveConfig(cfg);
    } catch (err: any) {
      log.error('[IPC] save-config failed:', err?.message || err);
      throw err;
    }
  });
}
