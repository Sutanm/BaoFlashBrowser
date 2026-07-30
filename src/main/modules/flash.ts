import path from 'path';
import fs from 'fs';
import os from 'os';
import log from 'electron-log';
import { App } from 'electron';

function getFlashPluginPath(app: App): string | null {
  const platform = process.platform;
  const arch = process.arch;
  const isPackaged = app.isPackaged;
  const basePath = isPackaged ? process.resourcesPath : path.join(__dirname, '..');

  if (platform === 'linux' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  if (platform === 'win32' && arch === 'x64') {
    return path.join(basePath, 'plugins', 'win64', 'pepflashplayer64.dll');
  }
  if (platform === 'win32' && arch === 'ia32') {
    return path.join(basePath, 'plugins', 'win32', 'pepflashplayer.dll');
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
  return '34.0.0.330';
}

export function setupFlash(app: App, flashVersion: string): void {
  const pluginPath = getFlashPluginPath(app);
  if (pluginPath && fs.existsSync(pluginPath)) {
    const ver = /^\d+\.\d+\.\d+\.\d+$/.test(flashVersion) ? flashVersion : extractVersion(pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
    app.commandLine.appendSwitch('ppapi-flash-version', ver);

    const mmsContent =
      'SuppressDebuggerExceptionDialogs=1\nErrorReportingEnable=0\nTraceOutputFileEnable=0\nDisableProductDownload=1\n';

    // Write to every path Flash might read from (both mms.cfg and mm.cfg)
    const mmsPaths = [
      process.cwd(),
      path.join(app.getPath('userData'), 'PepperFlash', 'System'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Macromedia', 'Flash Player'),
      path.join(os.homedir(), 'AppData', 'Local', 'PepperFlashPlayer'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'Flash Player'),
      path.dirname(pluginPath),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Macromed', 'Flash'),
      path.join(process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'Macromed', 'Flash'),
    ];

    for (const p of mmsPaths) {
      try {
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'mms.cfg'), mmsContent, 'utf-8');
        fs.writeFileSync(path.join(p, 'mm.cfg'), mmsContent, 'utf-8');
      } catch (_e) {}
    }
    log.info('[Flash] mms.cfg + mm.cfg written to all paths');

    log.info('[Flash] Plugin loaded: ' + pluginPath);
    log.info('[Flash] Version: ' + ver);
  } else {
    log.warn('[Flash] Plugin NOT found at: ' + pluginPath);
  }
}
