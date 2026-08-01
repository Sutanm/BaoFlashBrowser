var electron = require('electron');
var app = electron.app;
var BrowserWindow = electron.BrowserWindow;
var ipcMain = electron.ipcMain;
var shell = electron.shell;
var validator = require('validator');
var log = require('electron-log');

var config = require('./modules/config');
var flash = require('./modules/flash');
var windowMgr = require('./modules/window');
var sessionMgr = require('./modules/session');

log.transports.file.level = 'info';
log.transports.console.level = 'info';

app.setName('BaoFlashBrowser');

if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

app.commandLine.appendSwitch('ignore-gpu-blacklist');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

app.commandLine.appendSwitch('process-per-site');
app.commandLine.appendSwitch('disk-cache-size', '524288000');

// --- 单实例锁（解决二次启动卡顿问题） ---
// 第二个实例立即退出，不创建任何窗口，避免闪现
var gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.exit(0);
} else {
  app.on('second-instance', function (event, commandLine, workingDirectory) {
    var win = windowMgr.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // --- Flash 插件初始化 ---
  var appConfig = config.loadConfig();
  flash.setupFlash(app, appConfig.flashVersion);

  app.whenReady().then(function () {
    sessionMgr.initSession(app);
    windowMgr.createWindow(BrowserWindow);
  });

  app.on('web-contents-created', function (event, wc) {
    wc.on('new-window', function (e, url) {
      e.preventDefault();
      if (wc.hostWebContents) {
        wc.hostWebContents.send('navigate-url', url);
      }
    });
  });

  app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowMgr.createWindow(BrowserWindow);
    }
  });
}

// --- IPC 处理 ---

// open-external：仅允许 http/https 协议
ipcMain.handle('open-external', function (event, url) {
  if (!url || typeof url !== 'string') return;
  if (validator.isURL(url, { protocols: ['http', 'https'], require_protocol: true })) {
    shell.openExternal(url);
  } else {
    log.warn('[Security] blocked open-external for invalid url: ' + url);
  }
});

ipcMain.handle('set-window-title', function (event, title) {
  var win = windowMgr.getMainWindow();
  if (win) {
    win.setTitle(title || 'BaoFlashBrowser');
  }
});

ipcMain.handle('get-config', function () {
  return config.loadConfig();
});

ipcMain.handle('save-config', function (event, cfg) {
  return config.saveConfig(cfg);
});

ipcMain.handle('restart-app', function () {
  app.relaunch();
  app.quit();
});

// 窗口控制（无边框窗口用）
ipcMain.handle('window-minimize', function () {
  var win = windowMgr.getMainWindow();
  if (win) win.minimize();
});

ipcMain.handle('window-toggle-maximize', function () {
  var win = windowMgr.getMainWindow();
  if (!win) return false;
  if (win.isMaximized()) {
    win.unmaximize();
    return false;
  } else {
    win.maximize();
    return true;
  }
});

ipcMain.handle('window-close', function () {
  var win = windowMgr.getMainWindow();
  if (win) win.close();
});

ipcMain.handle('broadcast-theme-change', function (event, isDark) {
  var win = windowMgr.getMainWindow();
  if (win) {
    var wc = win.webContents;
    wc.send('theme-change', isDark);
  }
});
