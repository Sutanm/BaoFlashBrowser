// 窗口管理模块
var path = require('path');
var localShortcut = require('electron-localshortcut');
var log = require('electron-log');

var mainWindow = null;

function setupDevTools(win) {
  // 使用 electron-localshortcut 注册 F12，不依赖焦点位置
  localShortcut.register(win, 'F12', function () {
    var wc = win.webContents;
    try {
      if (wc.isDevToolsOpened()) {
        wc.closeDevTools();
      } else {
        wc.openDevTools({ mode: 'right' });
      }
    } catch (err) {
      log.error('[DevTools] toggle failed', err);
    }
  });
}

function createWindow(BrowserWindow) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'BaoFlashBrowser',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#f0f0f0',
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      plugins: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
  setupDevTools(mainWindow);
  mainWindow.setMenu(null);

  if (process.platform === 'win32') {
    try {
      var iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico');
      if (require('fs').existsSync(iconPath)) {
        mainWindow.setIcon(iconPath);
      }
    } catch (e) {}
  }

  mainWindow.on('page-title-updated', function (e) {
    e.preventDefault();
  });

  mainWindow.on('closed', function () {
    mainWindow = null;
  });

  log.info('[Window] created');
  return mainWindow;
}

function getMainWindow() {
  return mainWindow;
}

module.exports = {
  createWindow: createWindow,
  getMainWindow: getMainWindow,
  setupDevTools: setupDevTools
};
