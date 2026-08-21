import path from 'path';
import fs from 'fs';
import os from 'os';
import log from 'electron-log';
import { App } from 'electron';
import { DEFAULT_FLASH_VERSION } from './config';
import type { FlashPluginChannel } from '@shared/types/flash';

const FLASH_VARIANT_ENV = 'BAO_FLASH_PLUGIN_VARIANT';
const WINDOWS_CN_VERSION = '34.0.0.380';
const VERSION_PATTERN = /^\d+\.\d+\.\d+\.\d+$/;

export interface FlashPluginResolution {
  requestedChannel: FlashPluginChannel;
  effectiveChannel: FlashPluginChannel | 'unavailable';
  pluginPath: string | null;
  version: string;
  physicalVersion: string | null;
  source: 'bundled-stable' | 'bundled-experimental' | 'system-experimental' | 'none';
  experimental: boolean;
  untested: boolean;
  fallbackReason?: string;
}

function resourceRoot(app: App): string {
  if (app.isPackaged) return process.resourcesPath;
  const bundledRoot = path.join(__dirname, '..');
  if (fs.existsSync(path.join(bundledRoot, 'plugins'))) return bundledRoot;
  return path.resolve(__dirname, '..', '..', '..');
}

function getRequestedVariant(channel: FlashPluginChannel): string | null {
  if (channel !== 'experimental') return null;
  const value = process.env[FLASH_VARIANT_ENV]?.trim();
  return value && VERSION_PATTERN.test(value) ? value : null;
}

function stablePluginPath(app: App): string | null {
  const root = resourceRoot(app);
  if (process.platform === 'linux' && process.arch === 'x64') {
    return path.join(root, 'plugins', 'linux64', 'libpepflashplayer64.so');
  }
  if (process.platform === 'win32' && process.arch === 'x64') {
    return path.join(root, 'plugins', 'win64', 'pepflashplayer64.dll');
  }
  if (process.platform === 'win32' && process.arch === 'ia32') {
    return path.join(root, 'plugins', 'win32', 'pepflashplayer.dll');
  }
  return null;
}

function extractVersion(pluginPath: string): string | null {
  const name = path.basename(pluginPath, path.extname(pluginPath));
  const parts = name.split('_');
  for (let i = parts.length - 4; i >= 0; i--) {
    const version = parts.slice(i, i + 4).join('.');
    if (VERSION_PATTERN.test(version)) return version;
  }
  return null;
}

function readMacManifestVersion(pluginPath: string): string | null {
  const candidates = [
    path.join(pluginPath, 'Contents', 'Resources', 'manifest.json'),
    path.join(path.dirname(pluginPath), 'manifest.json'),
  ];
  for (const candidate of candidates) {
    try {
      const version = JSON.parse(fs.readFileSync(candidate, 'utf8'))?.version;
      if (typeof version === 'string' && VERSION_PATTERN.test(version)) return version;
    } catch { /* optional companion manifest */ }
  }
  return null;
}

function resolveExperimental(app: App, configuredVersion: string): FlashPluginResolution | null {
  const root = resourceRoot(app);
  if (process.platform === 'win32' && process.arch === 'x64') {
    const variant = getRequestedVariant('experimental') || WINDOWS_CN_VERSION;
    const pluginPath = path.join(
      root,
      'plugins',
      'experimental',
      'win64',
      `pepflashplayer64_${variant.replace(/\./g, '_')}.dll`,
    );
    if (!fs.existsSync(pluginPath)) return null;
    return {
      requestedChannel: 'experimental',
      effectiveChannel: 'experimental',
      pluginPath,
      version: VERSION_PATTERN.test(configuredVersion) ? configuredVersion : variant,
      physicalVersion: variant,
      source: 'bundled-experimental',
      experimental: true,
      untested: false,
    };
  }

  if (process.platform === 'darwin' && process.arch === 'x64') {
    const candidates: Array<[string, FlashPluginResolution['source']]> = [
      [path.join(root, 'plugins', 'experimental', 'mac', 'PepperFlashPlayer.plugin'), 'bundled-experimental'],
      [path.join(os.homedir(), 'Library', 'Internet Plug-Ins', 'PepperFlashPlayer', 'PepperFlashPlayer.plugin'), 'system-experimental'],
      ['/Library/Internet Plug-Ins/PepperFlashPlayer/PepperFlashPlayer.plugin', 'system-experimental'],
    ];
    const found = candidates.find(([candidate]) => fs.existsSync(candidate));
    if (!found) return null;
    return {
      requestedChannel: 'experimental',
      effectiveChannel: 'experimental',
      pluginPath: found[0],
      version: VERSION_PATTERN.test(configuredVersion) ? configuredVersion : DEFAULT_FLASH_VERSION,
      physicalVersion: readMacManifestVersion(found[0]),
      source: found[1],
      experimental: true,
      untested: true,
    };
  }

  return null;
}

export function resolveFlashPlugin(
  app: App,
  channel: FlashPluginChannel = 'stable',
  configuredVersion = DEFAULT_FLASH_VERSION,
): FlashPluginResolution {
  if (channel === 'experimental') {
    const experimental = resolveExperimental(app, configuredVersion);
    if (experimental) return experimental;
  }

  const stablePath = stablePluginPath(app);
  if (stablePath && fs.existsSync(stablePath)) {
    return {
      requestedChannel: channel,
      effectiveChannel: 'stable',
      pluginPath: stablePath,
      version: VERSION_PATTERN.test(configuredVersion)
        ? configuredVersion
        : extractVersion(stablePath) || DEFAULT_FLASH_VERSION,
      physicalVersion: extractVersion(stablePath),
      source: 'bundled-stable',
      experimental: false,
      untested: false,
      ...(channel === 'experimental' ? { fallbackReason: 'experimental-plugin-not-found' } : {}),
    };
  }

  return {
    requestedChannel: channel,
    effectiveChannel: 'unavailable',
    pluginPath: null,
    version: VERSION_PATTERN.test(configuredVersion) ? configuredVersion : DEFAULT_FLASH_VERSION,
    physicalVersion: null,
    source: 'none',
    experimental: channel === 'experimental' || process.platform === 'darwin',
    untested: process.platform === 'darwin',
    fallbackReason: channel === 'experimental' ? 'experimental-plugin-not-found' : 'stable-plugin-not-found',
  };
}

export function getFlashPluginPath(app: App, channel: FlashPluginChannel = 'stable'): string | null {
  return resolveFlashPlugin(app, channel).pluginPath;
}

export function setupFlash(app: App, flashVersion: string, channel: FlashPluginChannel = 'stable'): void {
  const resolution = resolveFlashPlugin(app, channel, flashVersion);
  const pluginPath = resolution.pluginPath;
  if (!pluginPath) {
    log.warn(`[Flash] plugin unavailable: platform=${process.platform} arch=${process.arch} requested=${channel}`);
    return;
  }

  app.commandLine.appendSwitch('ppapi-flash-path', pluginPath);
  app.commandLine.appendSwitch('ppapi-flash-version', resolution.version);

  const mmsContent =
    'SuppressDebuggerExceptionDialogs=1\nErrorReportingEnable=0\nTraceOutputFileEnable=0\nDisableProductDownload=1\n';
  const isWindows = process.platform === 'win32';
  const isMac = process.platform === 'darwin';
  const mmsPaths = [
    process.cwd(),
    path.join(app.getPath('userData'), 'PepperFlash', 'System'),
    ...(isWindows ? [
      path.join(os.homedir(), 'AppData', 'Roaming', 'Macromedia', 'Flash Player'),
      path.join(os.homedir(), 'AppData', 'Local', 'PepperFlashPlayer'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Adobe', 'Flash Player'),
      path.dirname(pluginPath),
    ] : []),
    ...(isMac ? [path.join(os.homedir(), 'Library', 'Application Support', 'Macromedia')] : []),
  ];

  for (const target of mmsPaths) {
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'mms.cfg'), mmsContent, 'utf-8');
      fs.writeFileSync(path.join(target, 'mm.cfg'), mmsContent, 'utf-8');
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`[Flash] failed to write mms.cfg to ${target}: ${message}`);
    }
  }

  if (resolution.fallbackReason) {
    log.warn(`[Flash] experimental request fell back to stable: ${resolution.fallbackReason}`);
  }
  if (resolution.experimental) {
    log.warn(`[Flash] EXPERIMENTAL plugin enabled; untested=${resolution.untested}`);
  }
  log.info(`[Flash] Plugin loaded: ${pluginPath}`);
  log.info(`[Flash] Version: ${resolution.version}`);
  log.info(`[Flash] Channel: requested=${resolution.requestedChannel} effective=${resolution.effectiveChannel} source=${resolution.source}`);
}
