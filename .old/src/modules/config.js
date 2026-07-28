// 配置管理模块（electron-store + schema 校验）
var Store = require('electron-store');
var log = require('electron-log');

var store = new Store({
  defaults: { flashVersion: '34.0.0.330' },
  schema: {
    flashVersion: {
      type: 'string',
      pattern: '^\\d+\\.\\d+\\.\\d+\\.\\d+$'
    }
  }
});

function loadConfig() {
  return { flashVersion: store.get('flashVersion') };
}

function saveConfig(cfg) {
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

module.exports = { loadConfig: loadConfig, saveConfig: saveConfig };
