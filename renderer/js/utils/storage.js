// localStorage 封装
var KEYS = {
  FAVORITES: 'baoflash_favorites',
  HOMEPAGE: 'baoflash_homepage',
  DARKMODE: 'baoflash_darkmode',
  LINK_BEHAVIOR: 'baoflash_link_behavior'
};

function getJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || '') || fallback;
  } catch (e) {
    return fallback;
  }
}

function setJson(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

// 收藏夹
function getFavorites() {
  return getJson(KEYS.FAVORITES, []);
}

function saveFavorites(favs) {
  setJson(KEYS.FAVORITES, favs);
}

// 主页
function getHomepage() {
  return localStorage.getItem(KEYS.HOMEPAGE) || 'newtab.html';
}

function saveHomepage(url) {
  localStorage.setItem(KEYS.HOMEPAGE, url);
}

// 暗色模式
function getDarkMode() {
  return localStorage.getItem(KEYS.DARKMODE) === 'true';
}

function saveDarkMode(on) {
  localStorage.setItem(KEYS.DARKMODE, on ? 'true' : 'false');
}

// 链接打开方式
function getLinkBehavior() {
  return localStorage.getItem(KEYS.LINK_BEHAVIOR) || 'newtab';
}

function saveLinkBehavior(val) {
  localStorage.setItem(KEYS.LINK_BEHAVIOR, val);
}

module.exports = {
  getFavorites: getFavorites,
  saveFavorites: saveFavorites,
  getHomepage: getHomepage,
  saveHomepage: saveHomepage,
  getDarkMode: getDarkMode,
  saveDarkMode: saveDarkMode,
  getLinkBehavior: getLinkBehavior,
  saveLinkBehavior: saveLinkBehavior
};
