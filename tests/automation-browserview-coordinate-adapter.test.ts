import { describe, expect, it } from 'vitest';
import {
  generation,
  point,
  region,
  targetId,
  viewportSpace,
} from '../src/shared/automation/core/geometry';
import {
  BrowserViewCoordinateAdapter,
  browserViewViewportTransform,
} from '../src/main/modules/automation/browserview-coordinate-adapter';

const viewport = viewportSpace({ targetId: targetId('tab-1'), targetGeneration: generation(2), viewportGeneration: generation(3) });

function adapter(logical = { width: 1280, height: 720 }, display = { width: 900, height: 560 }): BrowserViewCoordinateAdapter {
  return new BrowserViewCoordinateAdapter(browserViewViewportTransform({ space: viewport, logicalSize: logical, displaySize: display }));
}

describe('BrowserView Coordinate Adapter', () => {
  it('maps logical points with nonuniform live viewport scale', () => {
    expect(adapter().logicalPointToDisplay(point('logical', viewport, 640, 360))).toEqual({ x: 450, y: 280 });
  });

  it('preserves fractional input coordinates and rejects out-of-bounds points', () => {
    expect(adapter({ width: 100, height: 100 }, { width: 150, height: 125 })
      .logicalPointToDisplay(point('logical', viewport, 10.25, 20.5))).toEqual({ x: 15.375, y: 25.625 });
    expect(() => adapter().logicalPointToDisplay(point('logical', viewport, 1280, 0)))
      .toThrowError(expect.objectContaining({ code: 'INVALID_POINT' }));
  });

  it('rounds capture Regions outward and clamps to display bounds', () => {
    const value = adapter({ width: 100, height: 100 }, { width: 151, height: 125 });
    expect(value.logicalRegionToDisplayCapture(region('logical', viewport, 10.2, 20.2, 10.1, 10.1)))
      .toEqual({ x: 15, y: 25, width: 16, height: 13 });
    expect(value.logicalRegionToDisplayCapture(region('logical', viewport, -5, -5, 110, 110)))
      .toEqual({ x: 0, y: 0, width: 151, height: 125 });
  });

  it('maps display game-surface bounds back to logical viewport geometry', () => {
    const value = adapter();
    expect(value.displayRegionToLogical({ x: 225, y: 140, width: 450, height: 280 }))
      .toMatchObject({ x: 320, y: 180, width: 640, height: 360, space: viewport });
  });

  it('maps a game surface selected in the live page into the fixed authoring viewport', () => {
    const mapped = adapter({ width: 1280, height: 720 }, { width: 1600, height: 900 })
      .sourceViewportRegionToLogical(
        { x: 512, y: 83, width: 1040, height: 310 },
        { width: 2048, height: 1114 },
      );
    expect(mapped.x).toBeCloseTo(320);
    expect(mapped.y).toBeCloseTo(83 / 1114 * 720);
    expect(mapped.width).toBeCloseTo(650);
    expect(mapped.height).toBeCloseTo(310 / 1114 * 720);
  });

  it('rejects stale viewport generations', () => {
    expect(() => adapter().logicalPointToDisplay(point('logical', { ...viewport, viewportGeneration: generation(4) }, 10, 10)))
      .toThrowError(expect.objectContaining({ code: 'VIEWPORT_STALE' }));
  });

  it('round-trips display and logical points within floating precision', () => {
    const value = adapter();
    const logical = point('logical', viewport, 333.3, 222.2);
    const roundTrip = value.displayPointToLogical(value.logicalPointToDisplay(logical));
    expect(roundTrip.x).toBeCloseTo(logical.x, 12);
    expect(roundTrip.y).toBeCloseTo(logical.y, 12);
  });

  it('uses the latest BrowserView size after maximize or windowed transitions', () => {
    let display = { width: 1280, height: 720 };
    const value = new BrowserViewCoordinateAdapter(() => browserViewViewportTransform({
      space: viewport,
      logicalSize: { width: 1280, height: 720 },
      displaySize: display,
    }));
    const logical = point('logical', viewport, 320, 180);
    expect(value.logicalPointToDisplay(logical)).toEqual({ x: 320, y: 180 });

    display = { width: 800, height: 500 };
    expect(value.logicalPointToDisplay(logical)).toEqual({ x: 200, y: 125 });
    expect(value.displayRegionToLogical({ x: 100, y: 50, width: 400, height: 250 }))
      .toMatchObject({ x: 160, y: 72, width: 640, height: 360 });
  });
});
