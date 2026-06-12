(function () {
  console.log('[APP] app.js loaded');
  document.title = 'BaoFlashBrowser - loaded';

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

  var tabs = [];
  var activeTabId = null;
  var tabIdCounter = 0;
  var isMuted = false;
  var savedFlashVersion = '34.0.0.330';

  // --- Tab Management ---

  function createTab(url) {
    tabIdCounter++;
    var tabId = 'tab-' + tabIdCounter;
    var src = url || 'newtab.html';
    console.log('[TAB] createTab id=' + tabId + ' src=' + src + ' totalTabs=' + (tabs.length + 1));

    var webview = document.createElement('webview');
    webview.setAttribute('id', tabId);
    webview.setAttribute('src', src);
    webview.setAttribute('plugins', '');
    webview.setAttribute('allowpopups', '');
    webview.classList.add('active');
    webviewContainer.appendChild(webview);
    console.log('[TAB] webview appended to container, active class set');

    var tab = {
      id: tabId,
      webview: webview,
      url: src,
      title: '新标签页',
      isLoading: false
    };

    // Deactivate all other webviews
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].webview.classList.remove('active');
    }

    tabs.push(tab);
    activeTabId = tabId;
    attachWebviewEvents(webview, tabId);
    updateTabBar();
    syncFromActiveTab();
    try { webview.setAudioMuted(isMuted); } catch (e) {}
    console.log('[TAB] createTab done activeTabId=' + activeTabId);

    return tabId;
  }

  function closeTab(tabId) {
    var idx = -1;
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === tabId) { idx = i; break; }
    }
    if (idx === -1) return;

    var tab = tabs[idx];
    tab.webview.remove();
    tabs.splice(idx, 1);

    if (tabs.length === 0) {
      activeTabId = null;
      createTab('newtab.html');
      return;
    }

    if (activeTabId === tabId) {
      // Switch to adjacent tab
      var newIdx = Math.min(idx, tabs.length - 1);
      switchTab(tabs[newIdx].id);
    }

    updateTabBar();
    syncFromActiveTab();
  }

  function switchTab(tabId) {
    var tab = getTabById(tabId);
    console.log('[TAB] switchTab to=' + tabId + ' from=' + activeTabId + ' tabFound=' + !!tab);
    if (!tab || activeTabId === tabId) return;

    for (var i = 0; i < tabs.length; i++) {
      tabs[i].webview.classList.remove('active');
    }

    tab.webview.classList.add('active');
    console.log('[TAB] tab ' + tabId + ' now has classes: ' + tab.webview.className);
    activeTabId = tabId;
    updateTabBar();
    syncFromActiveTab();
    try { tab.webview.setAudioMuted(isMuted); } catch (e) {}
  }

  function getTabById(tabId) {
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === tabId) return tabs[i];
    }
    return null;
  }

  function getActiveTab() {
    return getTabById(activeTabId);
  }

  function updateTabBar() {
    tabList.innerHTML = '';
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var el = document.createElement('div');
      el.className = 'tab-item' + (t.id === activeTabId ? ' active' : '');
      el.setAttribute('data-tabid', t.id);
      el.innerHTML =
        '<span class="tab-title">' + escapeHtml(t.title) + '</span>' +
        '<button class="tab-close" data-tabid="' + t.id + '">&times;</button>';
      el.addEventListener('click', function (e) {
        if (e.target.className === 'tab-close') return;
        switchTab(this.getAttribute('data-tabid'));
      });
      tabList.appendChild(el);
    }

    // Attach close handlers
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
        if (tabId === activeTabId) {
          addressBar.value = e.url;
          updateNavButtonsForTab(tab);
          updateFavStar();
          if (window.electronAPI) {
            window.electronAPI.setTitle(document.title);
          }
        }
        updateTabBar();
      }
    });

    webview.addEventListener('did-navigate-in-page', function (e) {
      if (!e.isMainFrame) return;
      var tab = getTabById(tabId);
      if (tab) {
        tab.url = e.url;
        if (tabId === activeTabId) {
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
        if (tabId === activeTabId) {
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
      if (tabId === activeTabId) {
        btnRefresh.textContent = '\u00D7';
      }
    });

    webview.addEventListener('did-stop-loading', function () {
      var tab = getTabById(tabId);
      if (tab) tab.isLoading = false;
      if (tabId === activeTabId) {
        btnRefresh.textContent = '\u21BB';
        updateNavButtonsForTab(getActiveTab());
      }
    });

    webview.addEventListener('dom-ready', function () {
      try { webview.setAudioMuted(isMuted); } catch (e) {}
    });

    webview.addEventListener('did-fail-load', function (e) {
      if (e.errorCode === -3) return;
      var tab = getTabById(tabId);
      if (tab) tab.isLoading = false;
      if (tabId === activeTabId) {
        btnRefresh.textContent = '\u21BB';
      }
    });
  }

  function syncFromActiveTab() {
    var tab = getActiveTab();
    if (!tab) return;
      addressBar.value = tab.url === 'about:blank' || tab.url.slice(-11) === 'newtab.html' ? '' : tab.url;
    updateNavButtonsForTab(tab);
    updateFavStar();
    if (tab.title) {
      document.title = tab.title;
      if (window.electronAPI) {
        window.electronAPI.setTitle(tab.title);
      }
    }
  }

  function updateNavButtonsForTab(tab) {
    if (!tab) return;
    try {
      btnBack.disabled = !tab.webview.canGoBack();
      btnForward.disabled = !tab.webview.canGoForward();
    } catch (e) {}
  }

  // --- Helpers ---

  function getFavorites() {
    try {
      return JSON.parse(localStorage.getItem('baoflash_favorites') || '[]');
    } catch (e) {
      return [];
    }
  }

  function saveFavorites(favs) {
    localStorage.setItem('baoflash_favorites', JSON.stringify(favs));
  }

  function getHomepage() {
    return localStorage.getItem('baoflash_homepage') || 'newtab.html';
  }

  function saveHomepage(url) {
    localStorage.setItem('baoflash_homepage', url);
  }

  function getDarkMode() {
    return localStorage.getItem('baoflash_darkmode') === 'true';
  }

  function setDarkMode(on) {
    if (on) {
      document.body.classList.add('dark-mode');
    } else {
      document.body.classList.remove('dark-mode');
    }
    localStorage.setItem('baoflash_darkmode', on ? 'true' : 'false');
  }

  function getLinkBehavior() {
    return localStorage.getItem('baoflash_link_behavior') || 'newtab';
  }

  function setLinkBehavior(val) {
    localStorage.setItem('baoflash_link_behavior', val);
  }

  function isUrl(input) {
    if (input.indexOf('://') !== -1) return true;
    if (input.indexOf('.') !== -1 && input.indexOf(' ') === -1) return true;
    if (input === 'about:blank' || input === 'localhost') return true;
    return false;
  }

  function normalizeUrl(input) {
    if (!input) return 'about:blank';
    if (input.indexOf('://') !== -1) return input;
    if (input.indexOf('.') !== -1 && input.indexOf(' ') === -1) return 'https://' + input;
    return 'https://www.bing.com/search?q=' + encodeURIComponent(input);
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function addCurrentToFavorites() {
    var tab = getActiveTab();
    if (!tab) return false;
    var url = tab.url;
    if (!url || url === 'about:blank') return false;
    var title = tab.title || url;
    var favs = getFavorites();
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].url === url) return false;
    }
    favs.unshift({ url: url, title: title });
    saveFavorites(favs);
    return true;
  }

  function updateFavStar() {
    var tab = getActiveTab();
    var url = tab ? tab.url : '';
    var favs = getFavorites();
    var exists = favs.some(function (f) { return f.url === url; });
    if (exists) {
      btnFav.innerHTML = '&#9733;';
      btnFav.style.color = '#ffd700';
    } else {
      btnFav.innerHTML = '&#9734;';
      btnFav.style.color = '';
    }
  }

  // --- Navigation ---

  btnBack.addEventListener('click', function () {
    var tab = getActiveTab();
    if (tab) { try { tab.webview.goBack(); } catch (e) {} }
  });

  btnForward.addEventListener('click', function () {
    var tab = getActiveTab();
    if (tab) { try { tab.webview.goForward(); } catch (e) {} }
  });

  btnRefresh.addEventListener('click', function () {
    var tab = getActiveTab();
    if (!tab) return;
    if (tab.webview.isLoading()) {
      tab.webview.stop();
    } else {
      tab.webview.reload();
    }
  });

  addressBar.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      var url = normalizeUrl(addressBar.value.trim());
      var tab = getActiveTab();
      if (tab) {
        tab.webview.loadURL(url);
      }
    }
  });

  btnNewTab.addEventListener('click', function () {
    console.log('[TAB] btnNewTab clicked');
    var newId = createTab('newtab.html');
    switchTab(newId);
    addressBar.focus();
    addressBar.select();
  });

  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.key === 't') {
      e.preventDefault();
      console.log('[TAB] Ctrl+T pressed');
      var newId = createTab('newtab.html');
      switchTab(newId);
      addressBar.focus();
      addressBar.select();
    }
  });

  // --- Mute ---

  btnMute.addEventListener('click', function () {
    isMuted = !isMuted;
    for (var i = 0; i < tabs.length; i++) {
      try { tabs[i].webview.setAudioMuted(isMuted); } catch (e) {}
    }
    btnMute.innerHTML = isMuted ? '&#x266A;' : '&#x266A;';
    btnMute.title = isMuted ? '取消静音' : '静音';
    if (isMuted) {
      btnMute.style.opacity = '0.3';
    } else {
      btnMute.style.opacity = '';
    }
  });

  // --- Favorites ---

  function renderFavorites() {
    var favs = getFavorites();
    favList.innerHTML = '';
    if (favs.length === 0) {
      favList.innerHTML = '<div class="fav-empty">暂无收藏</div>';
      return;
    }
    for (var i = 0; i < favs.length; i++) {
      var item = document.createElement('div');
      item.className = 'fav-item';
      item.innerHTML =
        '<span class="fav-item-title">' + escapeHtml(favs[i].title || favs[i].url) + '</span>' +
        '<span class="fav-item-url">' + escapeHtml(favs[i].url) + '</span>' +
        '<button class="fav-item-remove" data-url="' + escapeHtml(favs[i].url) + '">&times;</button>';
      item.addEventListener('click', function (e) {
        if (e.target.className === 'fav-item-remove') return;
        var url = this.querySelector('.fav-item-remove').getAttribute('data-url');
        var tab = getActiveTab();
        if (tab) {
          tab.webview.loadURL(url);
        }
        favPanel.classList.add('hidden');
      });
      favList.appendChild(item);
    }

    var removeBtns = favList.querySelectorAll('.fav-item-remove');
    for (var j = 0; j < removeBtns.length; j++) {
      removeBtns[j].addEventListener('click', function (e) {
        e.stopPropagation();
        var url = this.getAttribute('data-url');
        var favs = getFavorites();
        favs = favs.filter(function (f) { return f.url !== url; });
        saveFavorites(favs);
        renderFavorites();
        updateFavStar();
      });
    }
  }

  btnFavAdd.addEventListener('click', function () {
    if (addCurrentToFavorites()) {
      renderFavorites();
      updateFavStar();
    }
  });

  btnFav.addEventListener('click', function () {
    if (favPanel.classList.contains('hidden')) {
      renderFavorites();
      favPanel.classList.remove('hidden');
      settingsPanel.classList.add('hidden');
    } else {
      favPanel.classList.add('hidden');
    }
  });

  btnFavClose.addEventListener('click', function () {
    favPanel.classList.add('hidden');
  });

  btnFav.addEventListener('dblclick', function () {
    var tab = getActiveTab();
    if (!tab) return;
    var url = tab.url;
    if (!url || url === 'about:blank') return;
    var favs = getFavorites();
    var idx = -1;
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].url === url) { idx = i; break; }
    }
    if (idx >= 0) {
      favs.splice(idx, 1);
      saveFavorites(favs);
    } else {
      addCurrentToFavorites();
    }
    updateFavStar();
  });

  // --- Settings ---

  btnSettings.addEventListener('click', function () {
    if (settingsPanel.classList.contains('hidden')) {
      settingHomepage.value = getHomepage();
      settingDarkmode.checked = getDarkMode();
      settingLinkBehavior.value = getLinkBehavior();
      if (window.electronAPI) {
        window.electronAPI.getConfig().then(function (cfg) {
          var v = cfg.flashVersion || '34.0.0.330';
          settingFlashVer.value = v;
          savedFlashVersion = v;
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

  btnSaveSettings.addEventListener('click', function () {
    saveHomepage(settingHomepage.value.trim());
    setDarkMode(settingDarkmode.checked);
    setLinkBehavior(settingLinkBehavior.value);
    var flashVer = settingFlashVer.value.trim();
    if (window.electronAPI && flashVer) {
      window.electronAPI.saveConfig({ flashVersion: flashVer }).then(function () {
        if (flashVer !== savedFlashVersion) {
          if (confirm('Flash 版本号已保存。需要重启浏览器才能生效，是否立即重启？')) {
            window.electronAPI.restartApp();
          }
        }
      });
    }
    settingsPanel.classList.add('hidden');
  });

  // --- Click-outside to close panels ---

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

  // --- Init ---

  if (getDarkMode()) {
    document.body.classList.add('dark-mode');
  }

  var homepage = getHomepage();
  var initUrl = homepage !== 'about:blank' && homepage !== 'newtab.html' ? normalizeUrl(homepage) : 'newtab.html';
  console.log('[APP] init homepage=' + homepage + ' initUrl=' + initUrl);
  createTab(initUrl);

  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'navigate-url') {
      var url = e.data.url;
      if (getLinkBehavior() === 'newtab') {
        var newTabId = createTab(url);
        switchTab(newTabId);
      } else {
        var tab = getActiveTab();
        if (tab) tab.webview.loadURL(url);
      }
    }
  });
})();
