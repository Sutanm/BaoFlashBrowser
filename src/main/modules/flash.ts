import path from 'path';
import fs from 'fs';
import log from 'electron-log';
import { App } from 'electron';

function getFlashPluginPath(app: App): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const isPackaged = app.isPackaged;
  const basePath = isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');

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

function extractVersion(dllPath: string): string {
  const name = path.basename(dllPath, path.extname(dllPath));
  const parts = name.split('_');
  for (let i = parts.length - 4; i >= 0; i--) {
    const ver = parts.slice(i, i + 4).join('.');
    if (/^\d+\.\d+\.\d+\.\d+$/.test(ver)) {
      return ver;
    }
  }
  return '0.0.0.0';
}

export function setupFlash(app: App, _flashVersion: string): void {
  const pluginPath = getFlashPluginPath(app);
  if (pluginPath && fs.existsSync(pluginPath)) {
    const ver = extractVersion(pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-version', ver);
    log.info('[Flash] Plugin loaded: ' + pluginPath);
    log.info('[Flash] Version: ' + ver);
  } else {
    log.warn('[Flash] Plugin NOT found at: ' + pluginPath);
  }
}
