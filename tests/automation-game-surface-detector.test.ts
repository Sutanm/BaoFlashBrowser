import { describe, expect, it } from 'vitest';
import { chooseLocatedGameSurface, chooseMatchingGameSurface, chooseReplacementGameSurface, gameSurfaceLocatorFromCandidate, type GameSurfaceCandidate } from '../src/main/modules/automation/game-surface-detector';

const candidate = (id: string, fingerprint: string, x: number): GameSurfaceCandidate => ({
  id,
  fingerprint,
  kind: 'flash',
  label: 'Flash 播放器',
  frameDepth: 2,
  frameUrl: 'https://example.test/game/frame.html',
  source: 'https://example.test/game.swf',
  rect: { x, y: 20, width: 640, height: 480 },
  score: 160,
});

describe('game surface detector matching', () => {
  it('reacquires the same surface after its rectangle changes', () => {
    const resized = candidate('surface-new', 'stable-fingerprint', 240);
    expect(chooseMatchingGameSurface([
      candidate('other', 'other-fingerprint', 10),
      resized,
    ], 'stable-fingerprint')).toBe(resized);
  });

  it('does not silently bind an unrelated player', () => {
    expect(chooseMatchingGameSurface([candidate('other', 'other-fingerprint', 10)], 'missing')).toBeNull();
  });

  it('reacquires a canvas whose DOM identity changed after a window resize', () => {
    const previous = { ...candidate('old', 'old', 100), kind: 'canvas' as const, label: 'canvas', source: '' };
    const replacement = { ...previous, id: 'new', fingerprint: 'new', rect: { x: 40, y: 30, width: 420, height: 315 } };
    expect(chooseReplacementGameSurface([replacement], previous)).toBe(replacement);
  });

  it('falls back to the containing iframe when a Flash plugin node disappears', () => {
    const previous = candidate('plugin', 'plugin', 100);
    const frame = { ...previous, id: 'frame', fingerprint: 'frame', kind: 'frame' as const, label: 'iframe 游戏区域候选', source: previous.frameUrl };
    expect(chooseReplacementGameSurface([frame], previous)).toBe(frame);
  });

  it('locates the author-selected game after its position and size change', () => {
    const selected = candidate('selected', 'selected-fingerprint', 100);
    const locator = gameSurfaceLocatorFromCandidate(selected);
    const moved = { ...selected, id: 'moved', fingerprint: 'moved', rect: { x: 420, y: 80, width: 950, height: 712.5 } };
    const other = { ...candidate('other', 'other', 20), source: 'https://example.test/other.swf', label: 'Flash other game' };
    expect(chooseLocatedGameSurface([other, moved], locator)).toBe(moved);
  });

  it('refuses to guess when two candidates match the copied feature equally', () => {
    const selected = candidate('selected', 'selected-fingerprint', 100);
    const locator = gameSurfaceLocatorFromCandidate(selected);
    expect(chooseLocatedGameSurface([
      { ...selected, id: 'first', fingerprint: 'first' },
      { ...selected, id: 'second', fingerprint: 'second', rect: { ...selected.rect, x: 800 } },
    ], locator)).toBeNull();
  });

  it('falls back from a disappeared Flash node to its strongly matching iframe', () => {
    const selected = candidate('selected', 'selected-fingerprint', 100);
    const locator = gameSurfaceLocatorFromCandidate(selected);
    const frame = {
      ...selected,
      id: 'frame', fingerprint: 'frame', kind: 'frame' as const,
      label: 'iframe 游戏区域候选', source: selected.frameUrl,
    };
    expect(chooseLocatedGameSurface([frame], locator)).toBe(frame);
  });
});
