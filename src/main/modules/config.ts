import Store from 'electron-store';
import log from 'electron-log';
import type { DownloadEngine } from '@shared/types/downloads';
import type { FlashPluginChannel } from '@shared/types/flash';

export const DEFAULT_FLASH_VERSION = '34.0.0.330';

export interface Config {
  flashVersion: string;
  flashPluginChannel: FlashPluginChannel;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  downloadDir: string;
  screenshotDir: string;
  userscriptMaxResponseMB: number;
  userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number;
  userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number;
  userscriptDownloadConcurrent: number;
  userscriptMaxValueKB: number;
}

export const DEFAULT_CONFIG: Config = {
  flashVersion: DEFAULT_FLASH_VERSION,
  flashPluginChannel: 'stable',
  lowEndMode: false,
  downloadEngine: 'aria2',
  downloadDir: '',
  screenshotDir: '',
  userscriptMaxResponseMB: 2,
  userscriptTimeoutSeconds: 15,
  userscriptMaxConcurrentPerScript: 4,
  userscriptMaxConcurrentGlobal: 16,
  userscriptDownloadMaxMB: 8,
  userscriptDownloadConcurrent: 4,
  userscriptMaxValueKB: 16,
};

// electron-store 惰性实例化:config.ts 可能被 userscripts/index.ts 引用,
// 顶层 new Store 会让 vitest(无 electron)导入链挂掉。
let store: Store<Config> | null = null;

function getStore(): Store<Config> {
  if (!store) {
    store = new Store<Config>({
      defaults: DEFAULT_CONFIG,
      schema: {
        flashVersion: {
          type: 'string',
          pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
        },
        flashPluginChannel: {
          type: 'string',
          enum: ['stable', 'experimental'],
        },
        lowEndMode: {
          type: 'boolean',
        },
        downloadEngine: {
          type: 'string',
          enum: ['chromium', 'aria2'],
        },
        downloadDir: {
          type: 'string',
        },
        screenshotDir: {
          type: 'string',
        },
        userscriptMaxResponseMB: { type: 'number', minimum: 1, maximum: 64 },
        userscriptTimeoutSeconds: { type: 'number', minimum: 1, maximum: 120 },
        userscriptMaxConcurrentPerScript: { type: 'number', minimum: 1, maximum: 16 },
        userscriptMaxConcurrentGlobal: { type: 'number', minimum: 1, maximum: 64 },
        userscriptDownloadMaxMB: { type: 'number', minimum: 1, maximum: 64 },
        userscriptDownloadConcurrent: { type: 'number', minimum: 1, maximum: 16 },
        userscriptMaxValueKB: { type: 'number', minimum: 1, maximum: 1024 },
      },
    });
  }
  return store;
}

export function loadConfig(): Config {
  const s = getStore();
  return {
    flashVersion: s.get('flashVersion'),
    flashPluginChannel: s.get('flashPluginChannel'),
    lowEndMode: s.get('lowEndMode'),
    downloadEngine: s.get('downloadEngine'),
    downloadDir: s.get('downloadDir'),
    screenshotDir: s.get('screenshotDir'),
    userscriptMaxResponseMB: s.get('userscriptMaxResponseMB'),
    userscriptTimeoutSeconds: s.get('userscriptTimeoutSeconds'),
    userscriptMaxConcurrentPerScript: s.get('userscriptMaxConcurrentPerScript'),
    userscriptMaxConcurrentGlobal: s.get('userscriptMaxConcurrentGlobal'),
    userscriptDownloadMaxMB: s.get('userscriptDownloadMaxMB'),
    userscriptDownloadConcurrent: s.get('userscriptDownloadConcurrent'),
    userscriptMaxValueKB: s.get('userscriptMaxValueKB'),
  };
}

export function saveConfig(cfg: Partial<Config>): boolean {
  try {
    // L26: 原子写入 — 合并后一次性 set，避免中途 crash 导致半更新
    const updates: Partial<Config> = {};
    if (cfg.flashVersion !== undefined) updates.flashVersion = cfg.flashVersion;
    if (cfg.flashPluginChannel !== undefined) updates.flashPluginChannel = cfg.flashPluginChannel;
    if (cfg.lowEndMode !== undefined) updates.lowEndMode = cfg.lowEndMode;
    if (cfg.downloadEngine !== undefined) updates.downloadEngine = cfg.downloadEngine;
    if (cfg.downloadDir !== undefined) updates.downloadDir = cfg.downloadDir;
    if (cfg.screenshotDir !== undefined) updates.screenshotDir = cfg.screenshotDir;
    if (cfg.userscriptMaxResponseMB !== undefined) updates.userscriptMaxResponseMB = cfg.userscriptMaxResponseMB;
    if (cfg.userscriptTimeoutSeconds !== undefined) updates.userscriptTimeoutSeconds = cfg.userscriptTimeoutSeconds;
    if (cfg.userscriptMaxConcurrentPerScript !== undefined) updates.userscriptMaxConcurrentPerScript = cfg.userscriptMaxConcurrentPerScript;
    if (cfg.userscriptMaxConcurrentGlobal !== undefined) updates.userscriptMaxConcurrentGlobal = cfg.userscriptMaxConcurrentGlobal;
    if (cfg.userscriptDownloadMaxMB !== undefined) updates.userscriptDownloadMaxMB = cfg.userscriptDownloadMaxMB;
    if (cfg.userscriptDownloadConcurrent !== undefined) updates.userscriptDownloadConcurrent = cfg.userscriptDownloadConcurrent;
    if (cfg.userscriptMaxValueKB !== undefined) updates.userscriptMaxValueKB = cfg.userscriptMaxValueKB;
    if (Object.keys(updates).length > 0) {
      getStore().set(updates);
    }
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
