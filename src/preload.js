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
  }
});

ipcRenderer.on('navigate-url', function (event, url) {
  window.postMessage({ type: 'navigate-url', url: url }, '*');
});
