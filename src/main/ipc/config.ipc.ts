import { ipcMain } from 'electron';
import { saveConfig } from '../modules/config';

export function registerConfigIPC(): void {
  ipcMain.handle('save-config', (_event, cfg: Record<string, unknown>) => {
    return saveConfig(cfg as any);
  });
}
