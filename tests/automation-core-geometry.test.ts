import { describe, expect, it } from 'vitest';
import {
  AutomationGeometryError,
  IDENTITY_AFFINE,
  affine,
  applyAffine,
  assertCurrentSpace,
  composeAffine,
  coverRegionForIntegerBoundary,
  generation,
  intersectRegions,
  invertAffine,
  logicalPointToRatio,
  logicalRegionToRatio,
  point,
  ratioPointToLogical,
  ratioRegionToLogical,
  region,
  regionContainsPoint,
  roundPointForInput,
  size,
  surfaceId,
  surfaceSpace,
  targetId,
  transformRegion,
  viewportSpace,
} from '../src/shared/automation/core/geometry';

const target = targetId('tab-1');
const viewport = viewportSpace({ targetId: target, targetGeneration: generation(1), viewportGeneration: generation(2) });

describe('Automation 2.0 core geometry', () => {
  it('rejects non-finite values, invalid sizes and invalid ratio geometry', () => {
    expect(() => size(0, 10)).toThrow(AutomationGeometryError);
    expect(() => point('logical', viewport, Number.NaN, 0)).toThrow(/finite/);
    expect(() => point('ratio', viewport, 1.01, 0)).toThrow(/inside/);
    expect(() => region('ratio', viewport, .8, 0, .3, 1)).toThrow(/inside/);
    expect(() => region('logical', viewport, 0, 0, 0, 1)).toThrow(/positive/);
  });

  it('maps ratio points to the last in-bounds logical coordinate', () => {
    const logicalSize = size(901, 561);
    expect(ratioPointToLogical(point('ratio', viewport, 0, 0), logicalSize)).toMatchObject({ x: 0, y: 0 });
    expect(ratioPointToLogical(point('ratio', viewport, .5, .25), logicalSize)).toMatchObject({ x: 450, y: 140 });
    expect(ratioPointToLogical(point('ratio', viewport, 1, 1), logicalSize)).toMatchObject({ x: 900, y: 560 });
    const roundTrip = logicalPointToRatio(point('logical', viewport, 450, 140), logicalSize);
    expect(roundTrip.x).toBeCloseTo(.5, 12);
    expect(roundTrip.y).toBeCloseTo(.25, 12);
  });

  it('maps ratio regions over the full half-open logical extent', () => {
    const logicalSize = size(900, 560);
    const full = ratioRegionToLogical(region('ratio', viewport, 0, 0, 1, 1), logicalSize);
    expect(full).toMatchObject({ x: 0, y: 0, width: 900, height: 560 });
    const partial = ratioRegionToLogical(region('ratio', viewport, .1, .2, .8, .6), logicalSize);
    expect(partial).toMatchObject({ x: 90, y: 112, width: 720, height: 336 });
    expect(logicalRegionToRatio(partial, logicalSize)).toMatchObject({ x: .1, y: .2, width: .8, height: .6 });
  });

  it('uses half-open Region intersection and containment', () => {
    const first = region('logical', viewport, 0, 0, 100, 100);
    const second = region('logical', viewport, 50, 40, 100, 20);
    expect(intersectRegions(first, second)).toMatchObject({ x: 50, y: 40, width: 50, height: 20 });
    expect(intersectRegions(first, region('logical', viewport, 100, 0, 10, 10))).toBeNull();
    expect(regionContainsPoint(first, point('logical', viewport, 99.999, 50))).toBe(true);
    expect(regionContainsPoint(first, point('logical', viewport, 100, 50))).toBe(false);
  });

  it('distinguishes target, viewport and surface generation failures', () => {
    const surface = surfaceSpace({ ...viewport, surfaceId: surfaceId('game'), surfaceGeneration: generation(3) });
    expect(() => assertCurrentSpace(surface, { ...surface, targetGeneration: generation(2) })).toThrowError(expect.objectContaining({ code: 'TARGET_STALE' }));
    expect(() => assertCurrentSpace(surface, { ...surface, viewportGeneration: generation(3) })).toThrowError(expect.objectContaining({ code: 'VIEWPORT_STALE' }));
    expect(() => assertCurrentSpace(surface, { ...surface, surfaceGeneration: generation(4) })).toThrowError(expect.objectContaining({ code: 'SURFACE_STALE' }));
  });

  it('composes and inverts affine transforms', () => {
    const scale = affine(2, 0, 0, 3, 0, 0);
    const translate = affine(1, 0, 0, 1, 10, 20);
    const combined = composeAffine(translate, scale);
    expect(applyAffine(combined, { x: 4, y: 5 })).toEqual({ x: 18, y: 35 });
    const inverse = invertAffine(combined);
    const original = applyAffine(inverse, applyAffine(combined, { x: 4.25, y: 5.5 }));
    expect(original.x).toBeCloseTo(4.25, 12);
    expect(original.y).toBeCloseTo(5.5, 12);
    expect(applyAffine(IDENTITY_AFFINE, original)).toEqual(original);
    expect(() => invertAffine(affine(1, 2, 2, 4, 0, 0))).toThrowError(expect.objectContaining({ code: 'TRANSFORM_NOT_INVERTIBLE' }));
  });

  it('returns an axis-aligned cover for transformed Regions', () => {
    const targetSpace = viewportSpace({ targetId: target, targetGeneration: generation(1), viewportGeneration: generation(2) });
    const transformed = transformRegion(region('logical', viewport, 0, 0, 10, 20), targetSpace, affine(2, 0, 0, .5, 4, 6));
    expect(transformed).toMatchObject({ x: 4, y: 6, width: 20, height: 10 });
  });

  it('centralizes input and capture rounding rules', () => {
    expect(roundPointForInput({ x: 1.5, y: -1.5 })).toEqual({ x: 2, y: -2 });
    expect(coverRegionForIntegerBoundary({ x: 10.2, y: 20.8, width: 4.1, height: 5.3 }))
      .toEqual({ x: 10, y: 20, width: 5, height: 7 });
  });

  it('round-trips deterministic property samples across viewport sizes', () => {
    let state = 0x5eed1234;
    const random = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 0x1_0000_0000;
    };
    for (let index = 0; index < 200; index += 1) {
      const logicalSize = size(2 + Math.floor(random() * 2000), 2 + Math.floor(random() * 1200));
      const sourcePoint = point('ratio', viewport, random(), random());
      const pointRoundTrip = logicalPointToRatio(ratioPointToLogical(sourcePoint, logicalSize), logicalSize);
      expect(pointRoundTrip.x).toBeCloseTo(sourcePoint.x, 12);
      expect(pointRoundTrip.y).toBeCloseTo(sourcePoint.y, 12);

      const x = random() * .8;
      const y = random() * .8;
      const width = .001 + random() * (1 - x - .001);
      const height = .001 + random() * (1 - y - .001);
      const sourceRegion = region('ratio', viewport, x, y, width, height);
      const regionRoundTrip = logicalRegionToRatio(ratioRegionToLogical(sourceRegion, logicalSize), logicalSize);
      expect(regionRoundTrip.x).toBeCloseTo(sourceRegion.x, 12);
      expect(regionRoundTrip.y).toBeCloseTo(sourceRegion.y, 12);
      expect(regionRoundTrip.width).toBeCloseTo(sourceRegion.width, 12);
      expect(regionRoundTrip.height).toBeCloseTo(sourceRegion.height, 12);
    }
  });
});
