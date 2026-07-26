// 标签页管理
var state = require('./state');
var dom = require('./utils/dom');

var webviewContainer;
var tabList;
var addressBar;
var btnRefresh;
var onTabSwitchCallbacks = [];

function init(opts) {
  webviewContainer = opts.webviewContainer;
  tabList = opts.tabList;
  addressBar = opts.addressBar;
  btnRefresh = opts.btnRefresh;
}

function onTabSwitch(cb) {
  onTabSwitchCallbacks.push(cb);
}

function emitTabSwitch(tab) {
  for (var i = 0; i < onTabSwitchCallbacks.length; i++) {
    onTabSwitchCallbacks[i](tab);
  }
}

function createTab(url) {
  state.tabIdCounter++;
  var tabId = 'tab-' + state.tabIdCounter;
  var src = url || 'newtab.html';
  if (src === 'newtab.html') {
    var isDark = document.body.classList.contains('dark');
    src = 'newtab.html?dark=' + isDark;
  }

  var webview = document.createElement('webview');
  webview.setAttribute('id', tabId);
  webview.setAttribute('src', src);
  webview.setAttribute('plugins', '');
  webview.setAttribute('allowpopups', '');
  webview.classList.add('active');
  webviewContainer.appendChild(webview);

  var tab = {
    id: tabId,
    webview: webview,
    url: src,
    title: '新标签页',
    isLoading: false
  };

  for (var i = 0; i < state.tabs.length; i++) {
    state.tabs[i].webview.classList.remove('active');
  }

  state.tabs.push(tab);
  state.activeTabId = tabId;
  attachWebviewEvents(webview, tabId);
  updateTabBar();
  syncFromActiveTab();
  try { webview.setAudioMuted(state.isMuted); } catch (e) {}

  return tabId;
}

function closeTab(tabId) {
  var idx = -1;
  for (var i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i].id === tabId) { idx = i; break; }
  }
  if (idx === -1) return;

  var tab = state.tabs[idx];
  tab.webview.remove();
  state.tabs.splice(idx, 1);

  if (state.tabs.length === 0) {
    state.activeTabId = null;
    createTab('newtab.html');
    return;
  }

  if (state.activeTabId === tabId) {
    var newIdx = Math.min(idx, state.tabs.length - 1);
    switchTab(state.tabs[newIdx].id);
  }

  updateTabBar();
  syncFromActiveTab();
}

function switchTab(tabId) {
  var tab = getTabById(tabId);
  if (!tab || state.activeTabId === tabId) return;

  for (var i = 0; i < state.tabs.length; i++) {
    state.tabs[i].webview.classList.remove('active');
  }

  tab.webview.classList.add('active');
  state.activeTabId = tabId;
  updateTabBar();
  syncFromActiveTab();
  try { tab.webview.setAudioMuted(state.isMuted); } catch (e) {}
}

function getTabById(tabId) {
  for (var i = 0; i < state.tabs.length; i++) {
    if (state.tabs[i].id === tabId) return state.tabs[i];
  }
  return null;
}

function getActiveTab() {
  return getTabById(state.activeTabId);
}

function updateTabBar() {
  var btn = document.getElementById('btn-new-tab');
  tabList.innerHTML = '';
  for (var i = 0; i < state.tabs.length; i++) {
    var t = state.tabs[i];
    var el = document.createElement('div');
    el.className = 'tab-item' + (t.id === state.activeTabId ? ' active' : '');
    el.setAttribute('data-tabid', t.id);
    el.innerHTML =
      '<span class="tab-title">' + dom.escapeHtml(t.title) + '</span>' +
      '<button class="tab-close" data-tabid="' + t.id + '">&times;</button>';
    el.addEventListener('click', function (e) {
      if (e.target.className === 'tab-close') return;
      switchTab(this.getAttribute('data-tabid'));
    });
    tabList.appendChild(el);
  }
  tabList.appendChild(btn);

  var closeBtns = tabList.querySelectorAll('.tab-close');
  for (var j = 0; j < closeBtns.length; j++) {
    closeBtns[j].addEventListener('click', function (e) {
      e.stopPropagation();
      closeTab(this.getAttribute('data-tabid'));
    });
  }
}

function attachWebviewEvents(webview, tabId) {
  webview.addEventListener('did-navigate', function (e) {
    var tab = getTabById(tabId);
    if (tab) {
      tab.url = e.url;
      if (tabId === state.activeTabId) {
        addressBar.value = e.url;
        updateNavButtonsForTab(tab);
        if (window.electronAPI) {
          window.electronAPI.setTitle(document.title);
        }
      }
      updateTabBar();
      emitTabSwitch(tab);
    }
  });

  webview.addEventListener('did-navigate-in-page', function (e) {
    if (!e.isMainFrame) return;
    var tab = getTabById(tabId);
    if (tab) {
      tab.url = e.url;
      if (tabId === state.activeTabId) {
        addressBar.value = e.url;
        updateNavButtonsForTab(tab);
      }
    }
  });

  webview.addEventListener('page-title-updated', function (e) {
    var tab = getTabById(tabId);
    if (tab) {
      tab.title = e.title;
      updateTabBar();
      if (tabId === state.activeTabId) {
        document.title = e.title;
        if (window.electronAPI) {
          window.electronAPI.setTitle(e.title);
        }
      }
    }
  });

  webview.addEventListener('did-start-loading', function () {
    var tab = getTabById(tabId);
    if (tab) tab.isLoading = true;
    if (tabId === state.activeTabId) {
      btnRefresh.textContent = '\u00D7';
      showProgressBar();
    }
  });

  webview.addEventListener('did-stop-loading', function () {
    var tab = getTabById(tabId);
    if (tab) tab.isLoading = false;
    if (tabId === state.activeTabId) {
      btnRefresh.textContent = '\u21BB';
      updateNavButtonsForTab(getActiveTab());
      hideProgressBar();
    }
  });

  webview.addEventListener('dom-ready', function () {
    try { webview.setAudioMuted(state.isMuted); } catch (e) {}
  });

  webview.addEventListener('did-fail-load', function (e) {
    if (e.errorCode === -3) return;
    var tab = getTabById(tabId);
    if (tab) tab.isLoading = false;
    if (tabId === state.activeTabId) {
      btnRefresh.textContent = '\u21BB';
      hideProgressBar();
      if (e.isMainFrame && e.errorCode !== -3) {
        showErrorPage(webview, e);
      }
    }
  });
}

function syncFromActiveTab() {
  var tab = getActiveTab();
  if (!tab) return;
  addressBar.value = tab.url === 'about:blank' || tab.url.slice(-11) === 'newtab.html' ? '' : tab.url;
  updateNavButtonsForTab(tab);
  emitTabSwitch(tab);
  if (tab.title) {
    document.title = tab.title;
    if (window.electronAPI) {
      window.electronAPI.setTitle(tab.title);
    }
  }
}

function updateNavButtonsForTab(tab) {
  var btnBack = document.getElementById('btn-back');
  var btnForward = document.getElementById('btn-forward');
  if (!tab) return;
  try {
    if (btnBack) btnBack.disabled = !tab.webview.canGoBack();
    if (btnForward) btnForward.disabled = !tab.webview.canGoForward();
  } catch (e) {}
}

function setMuted(muted) {
  state.isMuted = muted;
  for (var i = 0; i < state.tabs.length; i++) {
    try { state.tabs[i].webview.setAudioMuted(state.isMuted); } catch (e) {}
  }
}

// --- 加载进度条 ---
function showProgressBar() {
  var bar = document.getElementById('loading-progress');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'loading-progress';
    document.body.appendChild(bar);
  }
  bar.style.width = '0%';
  bar.style.opacity = '1';
  bar.style.display = 'block';
  // 模拟进度增长
  var progress = 0;
  bar._timer = setInterval(function () {
    progress += Math.random() * 30;
    if (progress > 90) progress = 90;
    bar.style.width = progress + '%';
  }, 200);
}

function hideProgressBar() {
  var bar = document.getElementById('loading-progress');
  if (!bar) return;
  if (bar._timer) {
    clearInterval(bar._timer);
    bar._timer = null;
  }
  bar.style.width = '100%';
  setTimeout(function () {
    bar.style.opacity = '0';
    setTimeout(function () {
      bar.style.display = 'none';
      bar.style.width = '0%';
    }, 200);
  }, 100);
}

// --- 错误页面 ---
function showErrorPage(webview, error) {
  var errorHtml = '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' +
    'body{font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;color:#333}' +
    'h1{font-size:48px;color:#999;margin-bottom:10px}' +
    'p{color:#666;margin-bottom:20px}' +
    'a{color:#533483;text-decoration:none;padding:8px 20px;border:1px solid #533483;border-radius:4px}' +
    'a:hover{background:#533483;color:#fff}' +
    '</style></head><body>' +
    '<h1>' + (error.errorCode || '错误') + '</h1>' +
    '<p>无法加载页面：' + (error.validatedURL || error.url || '') + '</p>' +
    '<p>' + (error.errorDescription || '连接失败，请检查网络或网址是否正确。') + '</p>' +
    '<a href="#" onclick="history.back();return false;">返回上一页</a>' +
    '</body></html>';
  try {
    webview.executeJavaScript('document.documentElement.outerHTML = ' + JSON.stringify(errorHtml) + ';');
  } catch (e) {}
}

module.exports = {
  init: init,
  onTabSwitch: onTabSwitch,
  createTab: createTab,
  closeTab: closeTab,
  switchTab: switchTab,
  getTabById: getTabById,
  getActiveTab: getActiveTab,
  updateTabBar: updateTabBar,
  syncFromActiveTab: syncFromActiveTab,
  updateNavButtonsForTab: updateNavButtonsForTab,
  setMuted: setMuted
};
