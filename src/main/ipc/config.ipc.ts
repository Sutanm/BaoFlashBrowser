import { createHandler } from '../utils/ipc-wrapper';
import { loadConfig, saveConfig } from '../modules/config';

export function registerConfigIPC(): void {
  createHandler('load-config', () => loadConfig());
  createHandler('save-config', (cfg) => saveConfig(cfg));
}
