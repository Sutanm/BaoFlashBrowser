import { describe, expect, it } from 'vitest';
import {
  generation,
  point,
  region,
  surfaceId,
  surfaceSpace,
  targetId,
  viewportSpace,
} from '../src/shared/automation/core/geometry';
import {
  AutomationFrameTransform,
  captureFrameGeometry,
  frameId,
} from '../src/shared/automation/core/frame-geometry';

const target = { targetId: targetId('tab-1'), targetGeneration: generation(1), viewportGeneration: generation(2) };
const viewport = viewportSpace(target);

describe('Automation 2.0 Frame geometry', () => {
  it('maps a full-frame bitmap match into ViewportSpace', () => {
    const frame = captureFrameGeometry({
      frameId: frameId('frame-1'), space: viewport,
      capturedRegion: region('logical', viewport, 0, 0, 900, 560), bitmapSize: { width: 1350, height: 840 },
    });
    const transform = new AutomationFrameTransform(frame);
    expect(transform.matchCenterToSpace({ x: 150, y: 300, width: 90, height: 60 }, { x: 5, y: -5 }))
      .toMatchObject({ x: 135, y: 215, space: viewport });
  });

  it('maps a DPR-scaled ROI match without relying on global lastFrame', () => {
    const game = surfaceSpace({ ...target, surfaceId: surfaceId('game'), surfaceGeneration: generation(3) });
    const frame = captureFrameGeometry({
      frameId: frameId('frame-roi'), space: game,
      capturedRegion: region('logical', game, 352.68, 15.5, 712.36, 435.57),
      bitmapSize: { width: 1427, height: 843 },
    });
    const result = new AutomationFrameTransform(frame)
      .matchCenterToSpace({ x: 620, y: 496, width: 91, height: 117 });
    expect(result.x).toBeCloseTo((620 + 91 / 2) * 712.36 / 1427 + 352.68, 12);
    expect(result.y).toBeCloseTo((496 + 117 / 2) * 435.57 / 843 + 15.5, 12);
  });

  it('round-trips Point and Region geometry through bitmap space', () => {
    const frame = captureFrameGeometry({
      frameId: frameId('frame-2'), space: viewport,
      capturedRegion: region('logical', viewport, 100, 50, 400, 300), bitmapSize: { width: 800, height: 600 },
    });
    const transform = new AutomationFrameTransform(frame);
    const sourcePoint = point('logical', viewport, 250, 125);
    const bitmapPoint = transform.spacePointToBitmap(sourcePoint);
    expect(bitmapPoint).toEqual({ x: 300, y: 150 });
    expect(transform.bitmapPointToSpace(bitmapPoint)).toMatchObject({ x: 250, y: 125 });
    const sourceRegion = region('logical', viewport, 200, 100, 100, 75);
    const bitmapRegion = transform.spaceRegionToBitmap(sourceRegion);
    expect(bitmapRegion).toEqual({ x: 200, y: 100, width: 200, height: 150 });
    expect(transform.bitmapRegionToSpace(bitmapRegion)).toMatchObject({ x: 200, y: 100, width: 100, height: 75 });
  });

  it('rejects stale target, viewport and Surface generations', () => {
    const game = surfaceSpace({ ...target, surfaceId: surfaceId('game'), surfaceGeneration: generation(3) });
    const transform = new AutomationFrameTransform(captureFrameGeometry({
      frameId: frameId('frame-3'), space: game,
      capturedRegion: region('logical', game, 0, 0, 100, 100), bitmapSize: { width: 100, height: 100 },
    }));
    expect(() => transform.assertCurrent({ ...game, targetGeneration: generation(2) }))
      .toThrowError(expect.objectContaining({ code: 'TARGET_STALE' }));
    expect(() => transform.assertCurrent({ ...game, viewportGeneration: generation(3) }))
      .toThrowError(expect.objectContaining({ code: 'VIEWPORT_STALE' }));
    expect(() => transform.assertCurrent({ ...game, surfaceGeneration: generation(4) }))
      .toThrowError(expect.objectContaining({ code: 'SURFACE_STALE' }));
  });

  it('rejects bitmap geometry outside the captured frame', () => {
    const transform = new AutomationFrameTransform(captureFrameGeometry({
      frameId: frameId('frame-4'), space: viewport,
      capturedRegion: region('logical', viewport, 0, 0, 100, 100), bitmapSize: { width: 200, height: 200 },
    }));
    expect(() => transform.bitmapPointToSpace({ x: 200, y: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_POINT' }));
    expect(() => transform.bitmapRegionToSpace({ x: 190, y: 0, width: 20, height: 10 })).toThrowError(expect.objectContaining({ code: 'INVALID_REGION' }));
  });
});
