// 设置管理 - 重写暗黑模式为按钮
var storage = require('./utils/storage');
var theme = require('./theme');
var state = require('./state');

var settingsPanel;
var settingHomepage;
var settingFlashVer;
var settingDarkmode;
var settingLinkBehavior;
var btnSaveSettings;
var favPanel;

function updateDarkModeButton() {
  if (settingDarkmode) {
    settingDarkmode.textContent = theme.isDarkMode() ? '切换至浅色' : '切换至暗色';
  }
}

function init(opts) {
  settingsPanel = opts.settingsPanel;
  favPanel = opts.favPanel;
  settingHomepage = opts.settingHomepage;
  settingFlashVer = opts.settingFlashVer;
  settingDarkmode = opts.settingDarkmode;
  settingLinkBehavior = opts.settingLinkBehavior;
  btnSaveSettings = opts.btnSaveSettings;
  var btnSettings = opts.btnSettings;
  var btnSettingsClose = opts.btnSettingsClose;

  btnSettings.addEventListener('click', function () {
    if (settingsPanel.classList.contains('hidden')) {
      settingHomepage.value = storage.getHomepage();
      updateDarkModeButton();
      settingLinkBehavior.value = storage.getLinkBehavior();
      if (window.electronAPI) {
        window.electronAPI.getConfig().then(function (cfg) {
          var v = cfg.flashVersion || '34.0.0.330';
          settingFlashVer.value = v;
          state.savedFlashVersion = v;
        }).catch(function () {
          settingFlashVer.value = '34.0.0.330';
        });
      } else {
        settingFlashVer.value = '34.0.0.330';
      }
      settingsPanel.classList.remove('hidden');
      favPanel.classList.add('hidden');
    } else {
      settingsPanel.classList.add('hidden');
    }
  });

  btnSettingsClose.addEventListener('click', function () {
    settingsPanel.classList.add('hidden');
  });

  settingDarkmode.addEventListener('click', function () {
    theme.toggleDarkMode();
    updateDarkModeButton();
  });

  btnSaveSettings.addEventListener('click', function () {
    storage.saveHomepage(settingHomepage.value.trim());
    storage.saveLinkBehavior(settingLinkBehavior.value);
    var flashVer = settingFlashVer.value.trim();
    if (window.electronAPI && flashVer) {
      window.electronAPI.saveConfig({ flashVersion: flashVer }).then(function () {
        if (flashVer !== state.savedFlashVersion) {
          if (confirm('Flash 版本号已保存。需要重启浏览器才能生效，是否立即重启？')) {
            window.electronAPI.restartApp();
          }
        }
      });
    }
    settingsPanel.classList.add('hidden');
  });
}

module.exports = { init: init };
