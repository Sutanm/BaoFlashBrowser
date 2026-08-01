// 收藏夹管理
var storage = require('./utils/storage');
var dom = require('./utils/dom');
var tabManager = require('./tab-manager');

var favList;
var favPanel;
var btnFav;
var onFavoritesChangedCallbacks = [];

function init(opts) {
  favList = opts.favList;
  favPanel = opts.favPanel;
  btnFav = opts.btnFav;

  opts.btnFavAdd.addEventListener('click', function () {
    if (addCurrentToFavorites()) {
      renderFavorites();
      updateFavStar();
    }
  });

  btnFav.addEventListener('click', function () {
    if (favPanel.classList.contains('hidden')) {
      renderFavorites();
      favPanel.classList.remove('hidden');
      opts.settingsPanel.classList.add('hidden');
    } else {
      favPanel.classList.add('hidden');
    }
  });

  opts.btnFavClose.addEventListener('click', function () {
    favPanel.classList.add('hidden');
  });

  btnFav.addEventListener('dblclick', function () {
    var tab = tabManager.getActiveTab();
    if (!tab) return;
    var url = tab.url;
    if (!url || url === 'about:blank') return;
    var favs = storage.getFavorites();
    var idx = -1;
    for (var i = 0; i < favs.length; i++) {
      if (favs[i].url === url) { idx = i; break; }
    }
    if (idx >= 0) {
      favs.splice(idx, 1);
      storage.saveFavorites(favs);
    } else {
      addCurrentToFavorites();
    }
    updateFavStar();
  });
}

function addCurrentToFavorites() {
  var tab = tabManager.getActiveTab();
  if (!tab) return false;
  var url = tab.url;
  if (!url || url === 'about:blank') return false;
  var title = tab.title || url;
  var favs = storage.getFavorites();
  for (var i = 0; i < favs.length; i++) {
    if (favs[i].url === url) return false;
  }
  favs.unshift({ url: url, title: title });
  storage.saveFavorites(favs);
  return true;
}

function updateFavStar() {
  var tab = tabManager.getActiveTab();
  var url = tab ? tab.url : '';
  var favs = storage.getFavorites();
  var exists = favs.some(function (f) { return f.url === url; });
  if (exists) {
    btnFav.innerHTML = '&#9733;';
    btnFav.style.color = '#ffd700';
  } else {
    btnFav.innerHTML = '&#9734;';
    btnFav.style.color = '';
  }
}

function renderFavorites() {
  var favs = storage.getFavorites();
  favList.innerHTML = '';
  if (favs.length === 0) {
    favList.innerHTML = '<div class="fav-empty">暂无收藏</div>';
    return;
  }
  for (var i = 0; i < favs.length; i++) {
    var item = document.createElement('div');
    item.className = 'fav-item';
    item.innerHTML =
      '<span class="fav-item-title">' + dom.escapeHtml(favs[i].title || favs[i].url) + '</span>' +
      '<span class="fav-item-url">' + dom.escapeHtml(favs[i].url) + '</span>' +
      '<button class="fav-item-remove" data-url="' + dom.escapeHtml(favs[i].url) + '">&times;</button>';
    item.addEventListener('click', function (e) {
      if (e.target.className === 'fav-item-remove') return;
      var url = this.querySelector('.fav-item-remove').getAttribute('data-url');
      var tab = tabManager.getActiveTab();
      var isNewTab = !tab || tab.url === 'newtab.html' || tab.url === 'about:blank' || tab.url.endsWith('/newtab.html');
      if (isNewTab) {
        if (tab) tab.webview.loadURL(url);
        else tabManager.createTab(url);
      } else {
        var newTabId = tabManager.createTab(url);
        tabManager.switchTab(newTabId);
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
      var favs = storage.getFavorites();
      favs = favs.filter(function (f) { return f.url !== url; });
      storage.saveFavorites(favs);
      renderFavorites();
      updateFavStar();
    });
  }
}

module.exports = {
  init: init,
  addCurrentToFavorites: addCurrentToFavorites,
  updateFavStar: updateFavStar,
  renderFavorites: renderFavorites
};
