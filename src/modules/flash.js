// Flash 插件管理模块
var path = require('path');
var fs = require('fs');
var log = require('electron-log');

function getFlashPluginPath(app) {
  var platform = process.platform;
  var arch = process.arch;
  var isPackaged = app.isPackaged;
  var basePath = isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');

  if (platform === 'linux' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'win64', 'pepflashplayer.dll');
  }
  if (platform === 'win32' && arch === 'ia32') {
    return path.join(basePath, 'plugins', 'win32', 'pepflashplayer32_32_0_0_156.dll');
  }
  return null;
}

function setupFlash(app, flashVersion) {
  var pluginPath = getFlashPluginPath(app);
  if (pluginPath && fs.existsSync(pluginPath)) {
    app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-version', flashVersion);
    log.info('[Flash] Plugin loaded: ' + pluginPath);
    log.info('[Flash] Version reported: ' + flashVersion);
  } else {
    log.warn('[Flash] Plugin NOT found at: ' + pluginPath);
  }
}

module.exports = { setupFlash: setupFlash };
