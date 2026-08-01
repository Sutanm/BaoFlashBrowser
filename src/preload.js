var contextBridge = require('electron').contextBridge;
var ipcRenderer = require('electron').ipcRenderer;

contextBridge.exposeInMainWorld('electronAPI', {
  openExternal: function (url) {
    ipcRenderer.invoke('open-external', url);
  },
  setTitle: function (title) {
    ipcRenderer.invoke('set-window-title', title);
  },
  getConfig: function () {
    return ipcRenderer.invoke('get-config');
  },
  saveConfig: function (cfg) {
    return ipcRenderer.invoke('save-config', cfg);
  },
  restartApp: function () {
    ipcRenderer.invoke('restart-app');
  },
  onNavigateUrl: function (callback) {
    ipcRenderer.on('navigate-url', function (event, url) {
      callback(url);
    });
  },
  minimizeWindow: function () {
    ipcRenderer.invoke('window-minimize');
  },
  toggleMaximizeWindow: function () {
    return ipcRenderer.invoke('window-toggle-maximize');
  },
  closeWindow: function () {
    ipcRenderer.invoke('window-close');
  },
  broadcastThemeChange: function (isDark) {
    ipcRenderer.invoke('broadcast-theme-change', isDark);
  },
  onThemeChange: function (callback) {
    ipcRenderer.on('theme-change', function (event, isDark) {
      callback(isDark);
    });
  },
  // 接收来自主进程的缩放快捷键指令（Ctrl++/Ctrl+-/Ctrl+0）
  onZoomShortcut: function (callback) {
    ipcRenderer.on('zoom-shortcut', function (event, action) {
      callback(action);
    });
  }
});
