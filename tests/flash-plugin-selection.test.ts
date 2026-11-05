import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { getFlashPluginPath, resolveFlashPlugin } from '../src/main/modules/flash';

const originalVariant = process.env.BAO_FLASH_PLUGIN_VARIANT;

afterEach(() => {
  if (originalVariant === undefined) delete process.env.BAO_FLASH_PLUGIN_VARIANT;
  else process.env.BAO_FLASH_PLUGIN_VARIANT = originalVariant;
});

describe.runIf(process.platform === 'win32' && process.arch === 'x64')('Flash plugin selection', () => {
  const app = { isPackaged: false } as Electron.App;

  it('keeps the bundled plugin as the default', () => {
    delete process.env.BAO_FLASH_PLUGIN_VARIANT;
    expect(path.basename(getFlashPluginPath(app)!)).toBe('pepflashplayer64.dll');
  });

  // Regression guard: the stable DLL name carries no version, so the physical
  // version must come from the embedded `WIN x,y,z,w` token. It used to be null.
  it('reports a physical version for the unversioned stable plugin', () => {
    delete process.env.BAO_FLASH_PLUGIN_VARIANT;
    const resolution = resolveFlashPlugin(app, 'stable');
    expect(resolution.physicalVersion).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // The advertised version stays pinned to config for legacy site gates.
    expect(resolution.version).toBe('34.0.0.330');
  });

  it('selects the China-modified plugin only in the experimental channel', () => {
    process.env.BAO_FLASH_PLUGIN_VARIANT = '34.0.0.380';
    const resolution = resolveFlashPlugin(app, 'experimental');
    expect(path.basename(resolution.pluginPath!)).toBe('pepflashplayer64_34_0_0_380.dll');
    expect(resolution).toMatchObject({
      effectiveChannel: 'experimental',
      source: 'bundled-experimental',
      experimental: true,
      version: '34.0.0.330',
      physicalVersion: '34.0.0.380',
    });
  });

  it('ignores experimental environment selection in the stable channel', () => {
    process.env.BAO_FLASH_PLUGIN_VARIANT = '34.0.0.380';
    expect(path.basename(getFlashPluginPath(app, 'stable')!)).toBe('pepflashplayer64.dll');
  });

  it('rejects path-like variant values and uses the declared experimental build', () => {
    process.env.BAO_FLASH_PLUGIN_VARIANT = '..\\untrusted';
    expect(path.basename(getFlashPluginPath(app, 'experimental')!)).toBe('pepflashplayer64_34_0_0_380.dll');
  });

  it('falls back to stable when a requested experimental build is absent', () => {
    process.env.BAO_FLASH_PLUGIN_VARIANT = '34.0.0.999';
    const resolution = resolveFlashPlugin(app, 'experimental');
    expect(path.basename(resolution.pluginPath!)).toBe('pepflashplayer64.dll');
    expect(resolution).toMatchObject({
      requestedChannel: 'experimental',
      effectiveChannel: 'stable',
      fallbackReason: 'experimental-plugin-not-found',
    });
  });
});
