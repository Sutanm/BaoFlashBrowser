import { describe, expect, it } from 'vitest';
import { extractColorPointSignature, type BgraImage } from '../src/main/modules/automation/color-point-matcher';
import { calibrateColorPointConfidence, ColorPointTracker, evaluateColorPointMatches } from '../src/main/modules/automation/color-point-tracker';

function image(width: number, height: number, color: [number, number, number, number]): BgraImage {
  const pixels = new Uint8Array(width * height * 4);
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset);
  return { pixels, width, height };
}

function paint(target: BgraImage, x: number, y: number, width: number, height: number, color: [number, number, number, number]) {
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    target.pixels.set(color, ((y + row) * target.width + x + column) * 4);
  }
}

function sprite(): BgraImage {
  const result = image(12, 10, [0, 0, 0, 0]);
  paint(result, 2, 2, 8, 6, [40, 70, 210, 255]);
  paint(result, 6, 3, 4, 3, [180, 30, 240, 255]);
  return result;
}

function frameAt(x?: number, y?: number): BgraImage {
  const result = image(100, 70, [10, 15, 20, 255]);
  if (x !== undefined && y !== undefined) {
    paint(result, x + 2, y + 2, 8, 6, [40, 70, 210, 255]);
    paint(result, x + 6, y + 3, 4, 3, [180, 30, 240, 255]);
  }
  return result;
}

const match = (score: number, x = 0) => ({
  x, y: 0, width: 10, height: 10, scale: 1, mirrored: false,
  score, featureCount: 10, matchedFeatures: 10, matchMs: 1,
});

describe('ColorPointTracker', () => {
  it('tracks movement in a small ROI after the initial match', () => {
    const tracker = new ColorPointTracker(extractColorPointSignature(sprite()), {
      threshold: .8,
      minimumScore: .9,
      minimumMargin: .05,
      mirror: false,
      initialRegion: { x: 10, y: 10, width: 80, height: 50 },
      trackingPadding: 8,
    });

    const first = tracker.match(frameAt(30, 24));
    const second = tracker.match(frameAt(35, 27));

    expect(first).toMatchObject({ accepted: true, tracking: false, consecutiveMisses: 0 });
    expect(first.best).toMatchObject({ x: 30, y: 24 });
    expect(second).toMatchObject({ accepted: true, tracking: true, consecutiveMisses: 0 });
    expect(second.best).toMatchObject({ x: 35, y: 27 });
    expect(second.searchedRegion!.width).toBeLessThan(40);
  });

  it('reacquires in the initial ROI after bounded local misses', () => {
    const tracker = new ColorPointTracker(extractColorPointSignature(sprite()), {
      threshold: .8,
      minimumScore: .9,
      minimumMargin: .05,
      mirror: false,
      initialRegion: { x: 5, y: 5, width: 90, height: 60 },
      trackingPadding: 5,
      reacquireAfterMisses: 2,
    });

    expect(tracker.match(frameAt(20, 20)).accepted).toBe(true);
    expect(tracker.match(frameAt(70, 45))).toMatchObject({ accepted: false, tracking: true, consecutiveMisses: 1 });
    expect(tracker.match(frameAt(70, 45))).toMatchObject({ accepted: false, tracking: true, consecutiveMisses: 2 });
    const reacquired = tracker.match(frameAt(70, 45));
    expect(reacquired).toMatchObject({ accepted: true, tracking: false, reacquired: true, consecutiveMisses: 0 });
    expect(reacquired.best).toMatchObject({ x: 70, y: 45 });
  });

  it('reset discards the previous tracking window', () => {
    const tracker = new ColorPointTracker(extractColorPointSignature(sprite()), {
      threshold: .8, minimumScore: .9, minimumMargin: .05, mirror: false,
      initialRegion: { x: 5, y: 5, width: 90, height: 60 },
    });
    tracker.match(frameAt(20, 20));
    tracker.reset();
    expect(tracker.lastMatch).toBeUndefined();
    expect(tracker.match(frameAt(70, 45))).toMatchObject({ accepted: true, tracking: false });
  });
});

describe('evaluateColorPointMatches', () => {
  it('requires both score and independent-candidate margin', () => {
    expect(evaluateColorPointMatches([match(.8), match(.78, 30)], { minimumScore: .7, minimumMargin: .05 }).accepted).toBe(false);
    expect(evaluateColorPointMatches([match(.8), match(.6, 30)], { minimumScore: .7, minimumMargin: .05 }).accepted).toBe(true);
  });
});

describe('calibrateColorPointConfidence', () => {
  it('boosts a unique interpolated candidate but not a near-tied color patch', () => {
    expect(calibrateColorPointConfidence([match(.48), match(.21, 30)]).confidence).toBe(1);
    expect(calibrateColorPointConfidence([match(.50), match(.494, 30)]).confidence).toBeCloseTo(.5375);
    expect(calibrateColorPointConfidence([match(.30)]).confidence).toBe(1);
  });

  it('does not turn a near-tied tiny-sprite candidate into a unique match', () => {
    const calibrated = calibrateColorPointConfidence([match(.525), match(.512, 30)]);
    expect(calibrated.margin).toBeCloseTo(.013);
    expect(calibrated.confidence).toBeLessThan(.61);
  });
});
