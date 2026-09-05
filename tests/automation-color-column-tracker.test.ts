import { describe, expect, it } from 'vitest';
import { ColorColumnTracker, findColorColumnSignals } from '../src/main/modules/automation/color-column-tracker';
import type { BgraImage } from '../src/main/modules/automation/color-point-matcher';

function frame(): BgraImage {
  const width = 80; const height = 60;
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set([15, 20, 25, 255], offset);
  return { width, height, pixels };
}

function point(target: BgraImage, x: number, y: number, color: [number, number, number, number]) {
  target.pixels.set(color, (y * target.width + x) * 4);
}

describe('color column signal detection', () => {
  it('groups matching rows and ignores the same color outside the expected column', () => {
    const input = frame();
    for (let y = 18; y <= 25; y += 1) { point(input, 39, y, [0, 160, 240, 255]); point(input, 40, y, [0, 160, 240, 255]); }
    for (let y = 5; y <= 20; y += 1) point(input, 65, y, [0, 160, 240, 255]);
    const matches = findColorColumnSignals(input, {
      colors: [[0, 160, 240]], expectedX: 40, xRadius: 3,
      region: { x: 0, y: 0, width: 80, height: 60 }, tolerance: 0,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ x: 39, y: 18, width: 2, height: 8, bottomY: 25, pixels: 16 });
  });

  it('bridges a small vertical gap but keeps distant signals separate', () => {
    const input = frame();
    for (const y of [10, 11, 13, 14, 30, 31]) point(input, 40, y, [0, 160, 240, 255]);
    const matches = findColorColumnSignals(input, {
      colors: [[0, 160, 240]], expectedX: 40, xRadius: 2,
      region: { x: 30, y: 0, width: 20, height: 50 }, tolerance: 0, maximumRowGap: 1, minimumPixels: 2,
    });
    expect(matches.map(({ y, height, pixels }) => ({ y, height, pixels }))).toEqual([
      { y: 10, height: 5, pixels: 4 }, { y: 30, height: 2, pixels: 2 },
    ]);
  });

  it('prefers temporal continuity over a larger distant distractor', () => {
    const tracker = new ColorColumnTracker({
      colors: [[0, 160, 240]], expectedX: 40, xRadius: 3,
      region: { x: 30, y: 0, width: 20, height: 60 }, tolerance: 0, maximumFrameJump: 8,
    });
    const first = frame();
    for (let y = 10; y < 16; y += 1) point(first, 40, y, [0, 160, 240, 255]);
    expect(tracker.match(first)?.y).toBe(10);

    const second = frame();
    for (let y = 14; y < 20; y += 1) point(second, 40, y, [0, 160, 240, 255]);
    for (let y = 40; y < 55; y += 1) point(second, 40, y, [0, 160, 240, 255]);
    expect(tracker.match(second)?.y).toBe(14);
  });

  it('does not jump to a distant signal until the reacquisition budget is exhausted', () => {
    const tracker = new ColorColumnTracker({
      colors: [[0, 160, 240]], expectedX: 40, xRadius: 3,
      region: { x: 30, y: 0, width: 20, height: 60 }, tolerance: 0,
      maximumFrameJump: 5, reacquireAfterMisses: 2,
    });
    const first = frame();
    for (let y = 8; y < 14; y += 1) point(first, 40, y, [0, 160, 240, 255]);
    expect(tracker.match(first)?.y).toBe(8);
    const moved = frame();
    for (let y = 40; y < 48; y += 1) point(moved, 40, y, [0, 160, 240, 255]);
    expect(tracker.match(moved)).toBeUndefined();
    expect(tracker.match(moved)?.y).toBe(40);
  });
});
