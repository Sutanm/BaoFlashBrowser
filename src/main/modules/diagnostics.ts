import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import os from 'os';
import log from 'electron-log';
import { loadConfig } from './config';
import { resolveFlashPlugin } from './flash';
import { ruffleBundleInfo } from './ruffle-bundle';
import { redactDiagnosticText } from '../utils/diagnostic-redaction';
import { getMemoryDiagnostics } from './memory-monitor';
import { PROJECT_PROVENANCE, PROVENANCE_SHORT_ID } from '../../shared/provenance';

interface ResourceDiagnostic {
  name: string;
  present: boolean;
  bytes?: number;
  sha256?: string;
}

async function fileDiagnostic(name: string, file: string): Promise<ResourceDiagnostic> {
  try {
    const stat = await fs.promises.stat(file);
    if (stat.isDirectory()) return { name, present: true };
    const hash = crypto.createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(file);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return { name, present: true, bytes: stat.size, sha256: hash.digest('hex') };
  } catch {
    return { name, present: false };
  }
}

function expectedNativeResources(): Array<[string, string]> {
  const root = app.isPackaged ? process.resourcesPath : path.join(__dirname, '..');
  if (process.platform === 'win32') {
    const aria2Path = !app.isPackaged && process.arch === 'ia32'
      ? path.join(root, 'native', 'aria2', 'win32', 'aria2c.exe')
      : path.join(root, 'native', 'aria2', 'aria2c.exe');
    return [
      ['aria2', aria2Path],
      ['mouse-hook', path.join(root, 'native', 'mouse-hook.exe')],
    ];
  }
  if (process.platform === 'linux') {
    return [
      ['aria2', path.join(root, 'native', 'aria2', 'aria2c')],
      ['mouse-hook', path.join(root, 'native', 'mouse-hook-linux')],
    ];
  }
  return [];
}

async function recentSanitizedLogs(): Promise<string[]> {
  try {
    const file = log.transports.file.getFile().path;
    const stat = await fs.promises.stat(file);
    const start = Math.max(0, stat.size - 256 * 1024);
    const handle = await fs.promises.open(file, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const privatePaths = [app.getPath('home'), app.getPath('userData'), os.homedir()];
      return redactDiagnosticText(buffer.toString('utf8'), privatePaths).split(/\r?\n/).slice(-500);
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

export async function createDiagnosticReport(): Promise<Record<string, unknown>> {
  const config = loadConfig();
  const flash = resolveFlashPlugin(app, config.flashPluginChannel, config.flashVersion);
  const ruffleRoot = path.join(__dirname, 'lib', 'ruffle');
  const resources = await Promise.all([
    fileDiagnostic('PPAPI Flash', flash.pluginPath || ''),
    fileDiagnostic('Ruffle bootstrap', path.join(ruffleRoot, 'ruffle.js')),
    fileDiagnostic('Ruffle CJK font', path.join(ruffleRoot, 'SourceHanSansCN-Regular.otf')),
    ...expectedNativeResources().map(([name, file]) => fileDiagnostic(name, file)),
  ]);

  return {
    format: 'BaoFlashBrowser diagnostics',
    formatVersion: 3,
    provenance: {
      ...PROJECT_PROVENANCE,
      shortId: PROVENANCE_SHORT_ID,
    },
    generatedAt: new Date().toISOString(),
    app: {
      version: app.getVersion(),
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
    },
    runtime: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      osRelease: os.release(),
      totalMemoryMiB: Math.round(os.totalmem() / 1024 / 1024),
    },
    settings: {
      flashVersion: config.flashVersion,
      flashPluginChannel: config.flashPluginChannel,
      lowEndMode: config.lowEndMode,
      downloadEngine: config.downloadEngine,
      customDownloadDirectory: Boolean(config.downloadDir),
    },
    flash: {
      requestedChannel: flash.requestedChannel,
      effectiveChannel: flash.effectiveChannel,
      source: flash.source,
      version: flash.version,
      physicalVersion: flash.physicalVersion,
      available: Boolean(flash.pluginPath),
      experimental: flash.experimental,
      untested: flash.untested,
      fallbackReason: flash.fallbackReason,
    },
    ruffle: ruffleBundleInfo(),
    resources,
    memory: getMemoryDiagnostics(),
    logs: await recentSanitizedLogs(),
  };
}
