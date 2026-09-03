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
  automationVisionWarmStart: boolean;
  automationOcrWarmStart: boolean;
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
  // 常驻会占用较多内存(OpenCV WASM 约 128MB、OCR 约 234MB),换取首次识别不再等待加载。
  automationVisionWarmStart: true,
  automationOcrWarmStart: true,
};

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as Array<keyof Config>;

export const CONFIG_SCHEMA: Store.Schema<Config> = {
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
  automationVisionWarmStart: { type: 'boolean' },
  automationOcrWarmStart: { type: 'boolean' },
};

// electron-store 惰性实例化:config.ts 可能被 userscripts/index.ts 引用,
// 顶层 new Store 会让 vitest(无 electron)导入链挂掉。
let store: Store<Config> | null = null;

function getStore(): Store<Config> {
  if (!store) {
    store = new Store<Config>({
      defaults: DEFAULT_CONFIG,
      schema: CONFIG_SCHEMA,
    });
  }
  return store;
}

export function loadConfig(): Config {
  const s = getStore();
  const loaded = { ...DEFAULT_CONFIG };
  for (const key of CONFIG_KEYS) setConfigField(loaded, key, s.get(key));
  return loaded;
}

function setConfigField<K extends keyof Config>(target: Config, key: K, value: Config[K]): void {
  target[key] = value;
}

function setPartialConfigField<K extends keyof Config>(target: Partial<Config>, key: K, value: Config[K]): void {
  target[key] = value;
}

export function saveConfig(cfg: Partial<Config>): boolean {
  try {
    // L26: 原子写入 — 合并后一次性 set，避免中途 crash 导致半更新
    const updates: Partial<Config> = {};
    for (const key of CONFIG_KEYS) {
      const value = cfg[key];
      if (value !== undefined) setPartialConfigField(updates, key, value);
    }
    if (Object.keys(updates).length > 0) {
      getStore().set(updates);
    }
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
