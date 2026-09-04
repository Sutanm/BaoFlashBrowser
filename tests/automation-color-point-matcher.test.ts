import { describe, expect, it } from 'vitest';
import {
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
  it('finds an opaque sprite while excluding its dominant border background', () => {
    const template = image(12, 10, [220, 160, 20, 255]);
    paint(template, 2, 2, 8, 6, [40, 70, 210, 255]);
    paint(template, 4, 3, 3, 3, [180, 30, 240, 255]);
    const scene = image(80, 50, [10, 15, 20, 255]);
    paint(scene, 31, 18, 8, 6, [40, 70, 210, 255]);
    paint(scene, 33, 19, 3, 3, [180, 30, 240, 255]);

    expect(matchColorPoints(scene, template, { threshold: .9, mirror: false, maxCandidates: 1 })[0]).toMatchObject({
      x: 31, y: 18, width: 8, height: 6, score: 1,
    });
  });

  it('matches a horizontally mirrored transparent sprite', () => {
    const template = image(9, 7, [0, 0, 0, 0]);
    paint(template, 1, 1, 3, 5, [30, 80, 220, 255]);
    paint(template, 4, 2, 4, 2, [190, 40, 70, 255]);
    const scene = image(50, 30, [12, 18, 25, 255]);
    paint(scene, 22, 11, 3, 5, [30, 80, 220, 255]);
    paint(scene, 18, 12, 4, 2, [190, 40, 70, 255]);

    expect(matchColorPoints(scene, template, { threshold: .85, maxCandidates: 1 })[0]).toMatchObject({
      x: 18, y: 11, width: 7, height: 5, mirrored: true,
    });
  });

  it('rejects flat templates that do not contain enough discriminating colors', () => {
    expect(() => extractColorPointSignature(image(12, 10, [50, 50, 50, 255]))).toThrow(/foreground/);
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
    })[0]).toMatchObject({ x: 31, y: 18, score: 1 });
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
});
