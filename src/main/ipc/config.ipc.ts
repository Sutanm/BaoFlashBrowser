import { createHandler } from '../utils/ipc-wrapper';
import { z } from 'zod';
import { app } from 'electron';
import { createValidatedHandler } from '../utils/ipc-wrapper';
import { loadConfig, saveConfig, type Config } from '../modules/config';
import { applyCapacityConfig } from '../modules/userscripts';
import { isPathWithinDirectory } from '../utils/download-path';
import { clearBrowserCache } from '../modules/session-manager';

const capacityField = (min: number, max: number) => z.number().int().min(min).max(max);

// 路径字段：空串/undefined 放行（未设置目录）；非空时拒绝位于 userData 内的目录
const pathField = (field: string) => z.string().max(32767).optional().refine(
  (dir) => !dir || !isPathWithinDirectory(app.getPath('userData'), dir),
  { message: `${field} must not be within userData` },
);

export function registerConfigIPC(): void {
  createHandler('load-config', () => loadConfig());
  createValidatedHandler('cache:clear', z.object({}).optional(), () => clearBrowserCache());
  createValidatedHandler('save-config', z.object({
    flashVersion: z.string().regex(/^\d+\.\d+\.\d+\.\d+$/).optional(),
    flashPluginChannel: z.enum(['stable', 'experimental']).optional(),
    lowEndMode: z.boolean().optional(),
    downloadEngine: z.enum(['chromium', 'aria2']).optional(),
    downloadDir: pathField('downloadDir'),
    screenshotDir: pathField('screenshotDir'),
    userscriptMaxResponseMB: capacityField(1, 64).optional(),
    userscriptTimeoutSeconds: capacityField(1, 120).optional(),
    userscriptMaxConcurrentPerScript: capacityField(1, 16).optional(),
    userscriptMaxConcurrentGlobal: capacityField(1, 64).optional(),
    userscriptDownloadMaxMB: capacityField(1, 64).optional(),
    userscriptDownloadConcurrent: capacityField(1, 16).optional(),
    userscriptMaxValueKB: capacityField(1, 1024).optional(),
    automationVisionWarmStart: z.boolean().optional(),
    automationOcrWarmStart: z.boolean().optional(),
  }).strict(), (cfg: Partial<Config>) => {
    const ok = saveConfig(cfg);
    // 容量配置保存后热应用(无需重启)
    applyCapacityConfig(cfg);
    return ok;
  });
}
