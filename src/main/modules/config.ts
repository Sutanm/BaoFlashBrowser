import Store from 'electron-store';
import log from 'electron-log';
import type { DownloadEngine } from '@shared/types/settings';

export const DEFAULT_FLASH_VERSION = '34.0.0.330';

interface Config {
  flashVersion: string;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  downloadDir: string;
}

const store = new Store<Config>({
  defaults: { flashVersion: DEFAULT_FLASH_VERSION, lowEndMode: false, downloadEngine: 'aria2', downloadDir: '' },
  schema: {
    flashVersion: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
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
  },
});

export function loadConfig(): Config {
  return {
    flashVersion: store.get('flashVersion'),
    lowEndMode: store.get('lowEndMode'),
    downloadEngine: store.get('downloadEngine'),
    downloadDir: store.get('downloadDir'),
  };
}

export function saveConfig(cfg: Partial<Config>): boolean {
  try {
    // L26: 原子写入 — 合并后一次性 set，避免中途 crash 导致半更新
    const updates: Partial<Config> = {};
    if (cfg.flashVersion !== undefined) updates.flashVersion = cfg.flashVersion;
    if (cfg.lowEndMode !== undefined) updates.lowEndMode = cfg.lowEndMode;
    if (cfg.downloadEngine !== undefined) updates.downloadEngine = cfg.downloadEngine;
    if (cfg.downloadDir !== undefined) updates.downloadDir = cfg.downloadDir;
    if (Object.keys(updates).length > 0) {
      store.set(updates as any);
    }
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
