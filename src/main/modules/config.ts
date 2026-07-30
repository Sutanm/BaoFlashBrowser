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
    if (cfg.flashVersion) {
      store.set('flashVersion', cfg.flashVersion);
    }
    if (cfg.lowEndMode !== undefined) {
      store.set('lowEndMode', cfg.lowEndMode);
    }
    if (cfg.downloadEngine) {
      store.set('downloadEngine', cfg.downloadEngine);
    }
    if (cfg.downloadDir !== undefined) {
      store.set('downloadDir', cfg.downloadDir);
    }
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
