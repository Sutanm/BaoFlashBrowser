import { describe, expect, it } from 'vitest';
import { compareRegionBitmaps, countRegionColorPixels, waitForRegionChange, waitForRegionColor, type RegionChangeSample } from '../src/main/modules/automation/region-change-detector';

function sample(values: readonly number[]): RegionChangeSample {
  const bitmap = new Uint8Array(values.length * 4);
  values.forEach((value, index) => {
    bitmap[index * 4] = value;
    bitmap[index * 4 + 1] = value;
    bitmap[index * 4 + 2] = value;
    bitmap[index * 4 + 3] = 255;
  });
  return { bitmap, width: values.length, height: 1, captureMs: 2 };
}

describe('region change detector', () => {
  it('counts changed pixels from BGRA color channels', () => {
    expect(compareRegionBitmaps(sample([10, 10, 10]), sample([10, 45, 41]), 32)).toEqual({
      changedPixels: 1,
      totalPixels: 3,
      changedRatio: 1 / 3,
    });
  });

  it('matches one of several RGB colors with a bounded tolerance', () => {
    expect(countRegionColorPixels(sample([10, 40, 80]), [
      { red: 42, green: 42, blue: 42 },
      { red: 200, green: 200, blue: 200 },
    ], 3)).toEqual({
      matchingPixels: 1,
      totalPixels: 3,
      matchingRatio: 1 / 3,
      matchBounds: { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
    });
  });

  it('waits inside the host until a baseline-relative change is stable', async () => {
    let clock = 0;
    const frames = [sample([0, 0, 0, 0]), sample([0, 40, 0, 0]), sample([0, 45, 0, 0])];
    let frameIndex = 0;
    const result = await waitForRegionChange({
      timeoutMs: 100,
      pollIntervalMs: 10,
      colorDelta: 32,
      minimumChangedPixels: 1,
      changedPixelRatio: .2,
      consecutiveFrames: 2,
      reference: 'baseline',
    }, {
      capture: async () => frames[Math.min(frameIndex++, frames.length - 1)],
      sleep: async (durationMs) => { clock += durationMs; },
      now: () => clock,
    }, new AbortController().signal);

    expect(result).toMatchObject({ changed: true, changedPixels: 1, totalPixels: 4, samples: 3, elapsedMs: 20, captureMs: 6 });
  });

  it('returns peak diagnostics when no change reaches the threshold', async () => {
    let clock = 0;
    const result = await waitForRegionChange({
      timeoutMs: 20,
      pollIntervalMs: 10,
      colorDelta: 32,
      minimumChangedPixels: 2,
      changedPixelRatio: 0,
      consecutiveFrames: 1,
      reference: 'previous',
    }, {
      capture: async () => sample([0, 40]),
      sleep: async (durationMs) => { clock += durationMs; },
      now: () => clock,
    }, new AbortController().signal);

    expect(result).toMatchObject({ changed: false, maxChangedPixels: 0, samples: 3, elapsedMs: 20 });
  });

  it('waits for a target color without a baseline frame', async () => {
    let clock = 0;
    const frames = [sample([0, 0]), sample([0, 40])];
    let frameIndex = 0;
    const result = await waitForRegionColor({
      colors: [{ red: 40, green: 40, blue: 40 }], timeoutMs: 50, pollIntervalMs: 10,
      tolerance: 0, minimumMatchingPixels: 1, consecutiveFrames: 1,
    }, {
      capture: async () => frames[Math.min(frameIndex++, frames.length - 1)],
      sleep: async (durationMs) => { clock += durationMs; }, now: () => clock,
    }, new AbortController().signal);
    expect(result).toMatchObject({ found: true, matchingPixels: 1, samples: 2, elapsedMs: 10 });
  });
});
