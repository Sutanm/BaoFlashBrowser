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
    return path.join(basePath, 'plugins', 'win32', 'pepflashplayer32_32_0_0_465.dll');
  }
  return null;
}

// 从 DLL 文件名中提取版本号（如 pepflashplayer32_32_0_0_465.dll → 32.0.0.465）
function extractVersion(dllPath) {
  var name = path.basename(dllPath, path.extname(dllPath));
  var parts = name.split('_');
  // 取最后4个数字段
  for (var i = parts.length - 4; i >= 0; i--) {
    var ver = parts.slice(i, i + 4).join('.');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ver)) {
      return ver;
    }
  }
  return '0.0.0.0';
}

function setupFlash(app, flashVersion) {
  var pluginPath = getFlashPluginPath(app);
  if (pluginPath && fs.existsSync(pluginPath)) {
    var ver = extractVersion(pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-version', ver);
    log.info('[Flash] Plugin loaded: ' + pluginPath);
    log.info('[Flash] Version: ' + ver);
  } else {
    log.warn('[Flash] Plugin NOT found at: ' + pluginPath);
  }
}

module.exports = { setupFlash: setupFlash };
