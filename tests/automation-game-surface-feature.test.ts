import { describe, expect, it } from 'vitest';
import { decodeGameSurfaceFeature, encodeGameSurfaceFeature, GAME_SURFACE_FEATURE_PREFIX } from '../src/shared/automation/game-surface-feature';

describe('automation game-surface feature strings', () => {
  it('round-trips a copied feature without exposing it as block text', () => {
    const locator = {
      version: 1 as const,
      kind: 'flash' as const,
      label: 'Flash · picaTown',
      source: 'Swfloader.swf',
      frameUrl: 'https://web.example.test/games/pkt/index.html',
      width: 950,
      height: 562,
    };
    const feature = encodeGameSurfaceFeature(locator);
    expect(feature.startsWith(GAME_SURFACE_FEATURE_PREFIX)).toBe(true);
    expect(decodeGameSurfaceFeature(feature)).toEqual(locator);
  });

  it('rejects unrelated clipboard content', () => {
    expect(() => decodeGameSurfaceFeature('950x562')).toThrow(/游戏画面特征串/);
  });
});
