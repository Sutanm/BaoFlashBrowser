import { describe, expect, it } from 'vitest';
import { verifyColorPointStructure } from '../src/main/modules/automation/color-structure-verifier';
import type { BgraImage } from '../src/main/modules/automation/color-point-matcher';

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

describe('colour proposal structure verifier', () => {
  it('ranks an exact shape above a same-palette patch', () => {
    const template = image(12, 12, [0, 0, 0, 0]);
    paint(template, 4, 1, 3, 9, [20, 190, 245, 255]);
    paint(template, 6, 8, 4, 3, [35, 45, 75, 255]);
    const scene = image(55, 28, [8, 20, 35, 255]);
    paint(scene, 9, 5, 3, 9, [20, 190, 245, 255]);
    paint(scene, 11, 12, 4, 3, [35, 45, 75, 255]);
    paint(scene, 31, 4, 10, 12, [20, 190, 245, 255]);
    paint(scene, 33, 12, 4, 3, [35, 45, 75, 255]);

    const exact = verifyColorPointStructure(scene, template, { x: 5, y: 4, width: 12, height: 12, mirrored: false });
    const patch = verifyColorPointStructure(scene, template, { x: 27, y: 4, width: 12, height: 12, mirrored: false });
    expect(exact.structureScore).toBeGreaterThan(.95);
    expect(patch.structureScore).toBeLessThan(exact.structureScore - .2);
    expect(patch.silhouettePrecision).toBeLessThan(exact.silhouettePrecision);
  });

  it('supports a scaled proposal and rejects invalid bounds', () => {
    const template = image(6, 6, [0, 0, 0, 0]);
    paint(template, 1, 1, 2, 4, [30, 180, 240, 255]);
    paint(template, 3, 3, 2, 2, [190, 45, 70, 255]);
    const scene = image(30, 24, [10, 20, 30, 255]);
    paint(scene, 12, 8, 4, 8, [30, 180, 240, 255]);
    paint(scene, 16, 12, 4, 4, [190, 45, 70, 255]);
    const result = verifyColorPointStructure(scene, template, { x: 10, y: 6, width: 12, height: 12, mirrored: false });
    expect(result.structureScore).toBeGreaterThan(.9);
    expect(() => verifyColorPointStructure(scene, template, { x: 25, y: 20, width: 12, height: 12, mirrored: false })).toThrow(/outside/);
  });
});
