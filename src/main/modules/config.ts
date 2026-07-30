import Store from 'electron-store';
import log from 'electron-log';

interface Config {
  flashVersion: string;
  lowEndMode: boolean;
}

const store = new Store<Config>({
  defaults: { flashVersion: '34.0.0.330', lowEndMode: false },
  schema: {
    flashVersion: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
    },
    lowEndMode: {
      type: 'boolean',
    },
  },
});

export function loadConfig(): Config {
  return {
    flashVersion: store.get('flashVersion'),
    lowEndMode: store.get('lowEndMode'),
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
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
