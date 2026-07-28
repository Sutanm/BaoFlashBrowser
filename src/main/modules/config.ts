import Store from 'electron-store';
import log from 'electron-log';

interface Config {
  flashVersion: string;
}

const store = new Store<Config>({
  defaults: { flashVersion: '34.0.0.330' },
  schema: {
    flashVersion: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$',
    },
  },
});

export function loadConfig(): Config {
  return { flashVersion: store.get('flashVersion') };
}

export function saveConfig(cfg: Partial<Config>): boolean {
  try {
    if (cfg && cfg.flashVersion) {
      store.set('flashVersion', cfg.flashVersion);
    }
    return true;
  } catch (e) {
    log.error('[Config] save failed', e);
    return false;
  }
}
