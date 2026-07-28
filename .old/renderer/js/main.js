// 渲染进程入口
var tabManager = require('./tab-manager');
var favorites = require('./favorites');
var settings = require('./settings');
var navigation = require('./navigation');
var theme = require('./theme');
var windowControls = require('./window-controls');
var zoom = require('./zoom');
var storage = require('./utils/storage');
var urlUtil = require('./utils/url');

function init() {
  // 获取 DOM 元素
  var addressBar = document.getElementById('address-bar');
  var btnBack = document.getElementById('btn-back');
  var btnForward = document.getElementById('btn-forward');
  var btnRefresh = document.getElementById('btn-refresh');
  var btnMute = document.getElementById('btn-mute');
  var btnFav = document.getElementById('btn-fav');
  var btnSettings = document.getElementById('btn-settings');
  var favPanel = document.getElementById('favorites-panel');
  var favList = document.getElementById('favorites-list');
  var btnFavClose = document.getElementById('btn-fav-close');
  var btnFavAdd = document.getElementById('btn-fav-add');
  var settingsPanel = document.getElementById('settings-panel');
  var btnSettingsClose = document.getElementById('btn-settings-close');
  var settingHomepage = document.getElementById('setting-homepage');
  var settingFlashVer = document.getElementById('setting-flash-ver');
  var settingDarkmode = document.getElementById('setting-darkmode');
  var settingLinkBehavior = document.getElementById('setting-link-behavior');
  var btnSaveSettings = document.getElementById('btn-save-settings');
  var tabList = document.getElementById('tab-list');
  var btnNewTab = document.getElementById('btn-new-tab');
  var webviewContainer = document.getElementById('webview-container');

  // 初始化各模块
  tabManager.init({
    webviewContainer: webviewContainer,
    tabList: tabList,
    addressBar: addressBar,
    btnRefresh: btnRefresh
  });

  favorites.init({
    favList: favList,
    favPanel: favPanel,
    btnFav: btnFav,
    btnFavAdd: btnFavAdd,
    btnFavClose: btnFavClose,
    settingsPanel: settingsPanel
  });

  settings.init({
    settingsPanel: settingsPanel,
    favPanel: favPanel,
    settingHomepage: settingHomepage,
    settingFlashVer: settingFlashVer,
    settingDarkmode: settingDarkmode,
    settingLinkBehavior: settingLinkBehavior,
    btnSaveSettings: btnSaveSettings,
    btnSettings: btnSettings,
    btnSettingsClose: btnSettingsClose
  });

  navigation.init({
    addressBar: addressBar,
    btnBack: btnBack,
    btnForward: btnForward,
    btnRefresh: btnRefresh,
    btnMute: btnMute,
    btnNewTab: btnNewTab
  });

  // 初始化缩放模块
  var btnZoomIn = document.getElementById('btn-zoom-in');
  var btnZoomOut = document.getElementById('btn-zoom-out');
  var btnZoomReset = document.getElementById('btn-zoom-reset');
  var zoomDisplay = document.getElementById('zoom-display');

  zoom.init({
    btnZoomIn: btnZoomIn,
    btnZoomOut: btnZoomOut,
    btnZoomReset: btnZoomReset,
    zoomDisplay: zoomDisplay
  });

  // 标签切换时更新收藏星标
  tabManager.onTabSwitch(function () {
    favorites.updateFavStar();
  });

  // 点击外部关闭面板
  document.addEventListener('click', function (e) {
    if (!favPanel.classList.contains('hidden') &&
        !favPanel.contains(e.target) &&
        e.target !== btnFav &&
        !btnFav.contains(e.target)) {
      favPanel.classList.add('hidden');
    }
    if (!settingsPanel.classList.contains('hidden') &&
        !settingsPanel.contains(e.target) &&
        e.target !== btnSettings &&
        !btnSettings.contains(e.target)) {
      settingsPanel.classList.add('hidden');
    }
  });

  // 初始化主题
  theme.initTheme();

  // 初始化窗口控制按钮
  windowControls.init();

  // 初始化静音按钮图标
  btnMute.innerHTML = '&#128266;';

  // 创建初始标签
  var homepage = storage.getHomepage();
  var initUrl = homepage !== 'about:blank' && homepage !== 'newtab.html' ? urlUtil.normalizeUrl(homepage) : 'newtab.html';
  tabManager.createTab(initUrl);

  // 窗口大小变化时更新标签栏
  window.addEventListener('resize', function () {
    tabManager.updateTabBar();
  });

  // 监听来自主进程的导航请求（替代不安全的 postMessage）
  if (window.electronAPI && window.electronAPI.onNavigateUrl) {
    window.electronAPI.onNavigateUrl(function (url) {
      if (storage.getLinkBehavior() === 'newtab') {
        var newTabId = tabManager.createTab(url);
        tabManager.switchTab(newTabId);
      } else {
        var tab = tabManager.getActiveTab();
        if (tab) tab.webview.loadURL(url);
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
