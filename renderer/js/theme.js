// 主题（暗色模式）管理 - 重写版
var storage = require('./utils/storage');

function initTheme() {
  if (storage.getDarkMode()) {
    document.body.classList.add('dark');
  }
}

function toggleDarkMode() {
  var isDark = document.body.classList.contains('dark');
  var newDark = !isDark;
  if (isDark) {
    document.body.classList.remove('dark');
    storage.saveDarkMode(false);
  } else {
    document.body.classList.add('dark');
    storage.saveDarkMode(true);
  }

  var webviews = document.querySelectorAll('webview');
  for (var i = 0; i < webviews.length; i++) {
    try {
      webviews[i].executeJavaScript(
        'document.body.classList.' + (newDark ? 'add' : 'remove') + '("dark");'
      );
    } catch (e) {}
  }

  return newDark;
}

function isDarkMode() {
  return document.body.classList.contains('dark');
}

module.exports = {
  initTheme: initTheme,
  toggleDarkMode: toggleDarkMode,
  isDarkMode: isDarkMode
};
