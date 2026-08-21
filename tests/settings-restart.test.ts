import { describe, expect, it } from 'vitest';
import { requiresMainConfigRestart } from '../src/renderer/services/settings-restart';

const loaded = { flashVersion: '35.0.0.1', flashPluginChannel: 'stable' as const, lowEndMode: true, userscriptMaxValueKB: 64 };

describe('settings restart detection', () => {
  it('does not request a restart when non-default loaded values are unchanged', () => {
    expect(requiresMainConfigRestart(loaded, { ...loaded })).toBe(false);
  });

  it('requests a restart when a loaded value is changed back to a default', () => {
    expect(requiresMainConfigRestart(loaded, { ...loaded, flashVersion: '34.0.0.330' })).toBe(true);
    expect(requiresMainConfigRestart(loaded, { ...loaded, flashPluginChannel: 'experimental' })).toBe(true);
    expect(requiresMainConfigRestart(loaded, { ...loaded, lowEndMode: false })).toBe(true);
    expect(requiresMainConfigRestart(loaded, { ...loaded, userscriptMaxValueKB: 16 })).toBe(true);
  });
});
