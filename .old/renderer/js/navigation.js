// 导航与地址栏逻辑
var urlUtil = require('./utils/url');
var tabManager = require('./tab-manager');
var storage = require('./utils/storage');
var state = require('./state');

var addressBar;
var btnBack;
var btnForward;
var btnRefresh;
var btnMute;
var btnNewTab;

function init(opts) {
  addressBar = opts.addressBar;
  btnBack = opts.btnBack;
  btnForward = opts.btnForward;
  btnRefresh = opts.btnRefresh;
  btnMute = opts.btnMute;
  btnNewTab = opts.btnNewTab;

  btnBack.addEventListener('click', function () {
    var tab = tabManager.getActiveTab();
    if (tab) { try { tab.webview.goBack(); } catch (e) {} }
  });

  btnForward.addEventListener('click', function () {
    var tab = tabManager.getActiveTab();
    if (tab) { try { tab.webview.goForward(); } catch (e) {} }
  });

  btnRefresh.addEventListener('click', function () {
    var tab = tabManager.getActiveTab();
    if (!tab) return;
    if (tab.webview.isLoading()) {
      tab.webview.stop();
    } else {
      tab.webview.reload();
    }
  });

  addressBar.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var url = urlUtil.normalizeUrl(addressBar.value.trim());
      var tab = tabManager.getActiveTab();
      if (tab) {
        tab.webview.loadURL(url);
      }
    }
  });

  btnNewTab.addEventListener('click', function () {
    var newId = tabManager.createTab('newtab.html');
    tabManager.switchTab(newId);
    addressBar.focus();
    addressBar.select();
  });

  // Ctrl+T 新建标签
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      var newId = tabManager.createTab('newtab.html');
      tabManager.switchTab(newId);
      addressBar.focus();
      addressBar.select();
    }
  });

  // 静音
  btnMute.addEventListener('click', function () {
    tabManager.setMuted(!state.isMuted);
    btnMute.title = state.isMuted ? '取消静音' : '静音';
    btnMute.innerHTML = state.isMuted ? '&#128263;' : '&#128266;';
    if (state.isMuted) {
      btnMute.style.opacity = '0.5';
    } else {
      btnMute.style.opacity = '';
    }
  });
}

module.exports = { init: init };
