import { describe, expect, it } from 'vitest';
import { decodeGameSurfaceFeature, encodeGameSurfaceFeature, surfaceSpecFromGameSurfaceFeature } from '../src/shared/automation/core';
import { chooseLocatedGameSurface, gameSurfaceFeatureFromCandidate, type GameSurfaceCandidate } from '../src/main/modules/automation/game-surface-detector';

const candidate = (overrides: Partial<GameSurfaceCandidate> = {}): GameSurfaceCandidate => ({
  id: 'game', fingerprint: 'detector-fingerprint', kind: 'flash', label: 'Flash 游戏画面', frameDepth: 1,
  frameUrl: 'https://example.com/play', source: 'https://cdn.example.com/game.swf',
  rect: { x: 10, y: 20, width: 960, height: 540 }, score: 100, ...overrides,
});

describe('Automation 2.0 game-area feature code', () => {
  it('round-trips BFG1 text and maps it to a visual SurfaceSpec', () => {
    const encoded = encodeGameSurfaceFeature(gameSurfaceFeatureFromCandidate(candidate()));
    expect(encoded).toMatch(/^BFG1:/u);
    expect(decodeGameSurfaceFeature(encoded)).toMatchObject({ kind: 'flash', width: 960, height: 540 });
    expect(surfaceSpecFromGameSurfaceFeature(encoded)).toEqual({ kind: 'visual', visualHint: 'flash', fingerprint: encoded });
  });

  it('reacquires the authored area instead of choosing the detector top result', () => {
    const authored = gameSurfaceFeatureFromCandidate(candidate());
    const unrelatedTopResult = candidate({ id: 'advert', label: '广告', source: 'https://ads.example.com/ad.swf', frameUrl: 'https://example.com/ad', score: 999 });
    const movedGame = candidate({ id: 'game-moved', rect: { x: 200, y: 100, width: 1280, height: 720 }, score: 80 });
    expect(chooseLocatedGameSurface([unrelatedTopResult, movedGame], authored)?.id).toBe('game-moved');
  });

  it('rejects an ambiguous feature match', () => {
    const authored = gameSurfaceFeatureFromCandidate(candidate());
    expect(chooseLocatedGameSurface([candidate({ id: 'one' }), candidate({ id: 'two', rect: { x: 100, y: 100, width: 960, height: 540 } })], authored)).toBeNull();
  });
});
