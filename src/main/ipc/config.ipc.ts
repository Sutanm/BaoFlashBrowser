import { createHandler } from '../utils/ipc-wrapper';
import { z } from 'zod';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { loadConfig, saveConfig, type Config } from '../modules/config';

export function registerConfigIPC(): void {
  createHandler('load-config', () => loadConfig());
  createValidatedHandler('save-config', z.object({
    flashVersion: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/).optional(),
    lowEndMode: z.boolean().optional(),
    downloadEngine: z.enum(['chromium', 'aria2']).optional(),
    downloadDir: z.string().max(32767).optional(),
  }).strict(), (cfg: Partial<Config>) => saveConfig(cfg));
}
