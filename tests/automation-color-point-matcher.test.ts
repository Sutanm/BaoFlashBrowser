import { describe, expect, it } from 'vitest';
import {
  areColorPointMatchesSameObject,
  extractColorPointSignature,
  matchColorPoints,
  matchColorPointSignature,
  type BgraImage,
} from '../src/main/modules/automation/color-point-matcher';

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

describe('multi-point color matcher POC', () => {
  it('clusters adjacent multi-scale hypotheses without merging separate targets', () => {
    const match = (x: number, y: number, width: number, height: number) => ({
      x, y, width, height, scale: 1, mirrored: false, score: .5,
      featureCount: 20, matchedFeatures: 15, matchMs: 1,
    });
    expect(areColorPointMatchesSameObject(match(134, 58, 9, 10), match(131, 45, 11, 12))).toBe(true);
    expect(areColorPointMatchesSameObject(match(127, 85, 11, 12), match(131, 69, 11, 12))).toBe(true);
    expect(areColorPointMatchesSameObject(match(130, 98, 9, 10), match(125, 112, 9, 10))).toBe(true);
    expect(areColorPointMatchesSameObject(match(122, 155, 11, 12), match(143, 150, 11, 12))).toBe(false);
    expect(areColorPointMatchesSameObject(match(195, 45, 9, 10), match(210, 42, 9, 10))).toBe(false);
  });

  it('can preserve overlapping scale hypotheses for downstream structure verification', () => {
    const template = image(12, 10, [220, 160, 20, 255]);
    paint(template, 2, 2, 8, 6, [40, 70, 210, 255]);
    paint(template, 4, 3, 3, 3, [180, 30, 240, 255]);
    const scene = image(80, 50, [10, 15, 20, 255]);
    paint(scene, 31, 18, 8, 6, [40, 70, 210, 255]);
    paint(scene, 33, 19, 3, 3, [180, 30, 240, 255]);
    const signature = extractColorPointSignature(template);
    const deduped = matchColorPointSignature(scene, signature, { threshold: 0, scales: [.9, 1, 1.1], maxCandidates: 20 });
    const preserved = matchColorPointSignature(scene, signature, {
      threshold: 0, scales: [.9, 1, 1.1], maxCandidates: 20, preserveScaleHypotheses: true,
    });
    expect(preserved.length).toBeGreaterThan(deduped.length);
    expect(new Set(preserved.map((match) => match.scale)).size).toBeGreaterThan(1);
  });

  it('finds an opaque sprite while excluding its dominant border background', () => {
    const template = image(12, 10, [220, 160, 20, 255]);
    paint(template, 2, 2, 8, 6, [40, 70, 210, 255]);
    paint(template, 4, 3, 3, 3, [180, 30, 240, 255]);
    const scene = image(80, 50, [10, 15, 20, 255]);
    paint(scene, 31, 18, 8, 6, [40, 70, 210, 255]);
    paint(scene, 33, 19, 3, 3, [180, 30, 240, 255]);

    expect(matchColorPoints(scene, template, { threshold: .9, mirror: false, maxCandidates: 1 })[0]).toMatchObject({
      x: 29, y: 16, width: 12, height: 10, score: 1,
    });
  });

  it('matches a horizontally mirrored transparent sprite', () => {
    const template = image(9, 7, [0, 0, 0, 0]);
    paint(template, 1, 1, 3, 5, [30, 80, 220, 255]);
    paint(template, 4, 2, 4, 2, [190, 40, 70, 255]);
    const scene = image(50, 30, [12, 18, 25, 255]);
    paint(scene, 22, 11, 3, 5, [30, 80, 220, 255]);
    paint(scene, 18, 12, 4, 2, [190, 40, 70, 255]);

    expect(matchColorPoints(scene, template, { threshold: .85, mirror: true, maxCandidates: 1 })[0]).toMatchObject({
      x: 17, y: 10, width: 9, height: 7, mirrored: true,
    });
  });

  it('restores an asymmetric transparent border to the returned asset bounds', () => {
    const template = image(11, 9, [0, 0, 0, 0]);
    paint(template, 3, 1, 7, 5, [30, 80, 220, 255]);
    paint(template, 6, 2, 4, 2, [190, 40, 70, 255]);
    const scene = image(60, 40, [12, 18, 25, 255]);
    // The authored asset begins at 20,12; its visible body begins at 23,13.
    paint(scene, 23, 13, 7, 5, [30, 80, 220, 255]);
    paint(scene, 26, 14, 4, 2, [190, 40, 70, 255]);

    expect(matchColorPoints(scene, template, { threshold: .85, mirror: false, maxCandidates: 1 })[0]).toMatchObject({
      x: 20, y: 12, width: 11, height: 9,
    });
  });

  it('rejects flat templates that do not contain enough discriminating colors', () => {
    expect(() => extractColorPointSignature(image(12, 10, [50, 50, 50, 255]))).toThrow(/foreground/);
  });

  it('routes multi-tone grayscale templates away from the color backend', () => {
    const template = image(12, 10, [240, 240, 240, 255]);
    paint(template, 2, 2, 8, 6, [70, 70, 70, 255]);
    paint(template, 5, 3, 3, 3, [130, 130, 130, 255]);
    expect(() => extractColorPointSignature(template)).toThrow(/chromatic/);
  });

  it('keeps ROI match coordinates in the full scene coordinate space', () => {
    const template = image(12, 10, [220, 160, 20, 255]);
    paint(template, 2, 2, 8, 6, [40, 70, 210, 255]);
    paint(template, 4, 3, 3, 3, [180, 30, 240, 255]);
    const scene = image(80, 50, [10, 15, 20, 255]);
    paint(scene, 31, 18, 8, 6, [40, 70, 210, 255]);
    paint(scene, 33, 19, 3, 3, [180, 30, 240, 255]);

    expect(matchColorPoints(scene, template, {
      threshold: .9, mirror: false, maxCandidates: 1,
      region: { x: 20, y: 10, width: 30, height: 25 },
    })[0]).toMatchObject({ x: 29, y: 16, score: 1 });
  });

  it('reuses a material signature without changing the result', () => {
    const template = image(9, 7, [0, 0, 0, 0]);
    paint(template, 1, 1, 3, 5, [30, 80, 220, 255]);
    paint(template, 4, 2, 4, 2, [190, 40, 70, 255]);
    const scene = image(50, 30, [12, 18, 25, 255]);
    paint(scene, 15, 9, 3, 5, [30, 80, 220, 255]);
    paint(scene, 18, 10, 4, 2, [190, 40, 70, 255]);
    const signature = extractColorPointSignature(template);

    const first = matchColorPointSignature(scene, signature, { threshold: .85, mirror: false, maxCandidates: 1 });
    const second = matchColorPointSignature(scene, signature, { threshold: .85, mirror: false, maxCandidates: 1 });
    expect(second.map(({ matchMs: _matchMs, ...match }) => match))
      .toEqual(first.map(({ matchMs: _matchMs, ...match }) => match));
  });

  it('scores a complete color geometry above a partial same-color patch', () => {
    const template = image(14, 10, [230, 220, 210, 255]);
    paint(template, 2, 2, 9, 6, [35, 80, 210, 255]);
    paint(template, 7, 3, 5, 3, [180, 35, 235, 255]);
    const complete = image(60, 40, [10, 15, 20, 255]);
    paint(complete, 22, 14, 9, 6, [35, 80, 210, 255]);
    paint(complete, 27, 15, 5, 3, [180, 35, 235, 255]);
    const partial = image(60, 40, [10, 15, 20, 255]);
    paint(partial, 22, 14, 4, 3, [35, 80, 210, 255]);
    paint(partial, 27, 15, 2, 2, [180, 35, 235, 255]);
    const signature = extractColorPointSignature(template);
    const options = { threshold: 0, mirror: false, maxCandidates: 1 } as const;

    const completeScore = matchColorPointSignature(complete, signature, options)[0]?.score ?? 0;
    const partialScore = matchColorPointSignature(partial, signature, options)[0]?.score ?? 0;
    expect(completeScore).toBeGreaterThan(.95);
    expect(partialScore).toBeLessThan(completeScore - .25);
  });

  it('penalizes matching colors that spill outside a transparent silhouette', () => {
    const template = image(12, 12, [0, 0, 0, 0]);
    paint(template, 4, 2, 3, 8, [20, 180, 245, 255]);
    paint(template, 6, 7, 3, 3, [35, 45, 70, 255]);
    const scene = image(70, 35, [8, 20, 35, 255]);
    // Clean authored silhouette.
    paint(scene, 14, 7, 3, 8, [20, 180, 245, 255]);
    paint(scene, 16, 12, 3, 3, [35, 45, 70, 255]);
    // Same positive points embedded in a larger same-colour patch.
    paint(scene, 40, 5, 9, 12, [20, 180, 245, 255]);
    paint(scene, 42, 12, 3, 3, [35, 45, 70, 255]);

    const matches = matchColorPoints(scene, template, { threshold: 0, mirror: false, maxCandidates: 3 });
    expect(matches[0]).toMatchObject({ x: 10, y: 5 });
    expect(matches[0].score).toBeGreaterThan((matches.find((match) => match.x >= 35)?.score ?? 0) + .1);
  });
});
