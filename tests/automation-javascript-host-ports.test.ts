import { describe, expect, it } from 'vitest';
import { AutomationCoordinateResolver } from '../src/shared/automation/core/coordinate-resolver';
import { affine, frameId, generation, point, region, size, surfaceId, targetId, viewportSpace } from '../src/shared/automation/core';
import { resolvedSurface } from '../src/shared/automation/core/surface';
import { scriptTarget } from '../src/main/modules/automation/javascript-host-ports';

describe('JavaScript automation target coordinates', () => {
  it('returns recognition geometry in the active surface space', () => {
    const target = { targetId: targetId('tab-1'), targetGeneration: generation(1), viewportGeneration: generation(1) };
    const viewport = viewportSpace(target);
    const surface = resolvedSurface({
      id: surfaceId('game'), generation: generation(1), target: viewport,
      spec: { kind: 'visual', visualHint: 'container' }, parentSpace: viewport,
      boundsInParent: region('logical', viewport, 352, 15, 950, 562),
      localSize: size(950, 562), toViewport: affine(1, 0, 0, 1, 352, 15),
    });
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1600, 900), surfaces: [surface] });
    const context = { currentSpace: surface.space, coordinateResolver: resolver, signal: new AbortController().signal, now: Date.now };
    const result = scriptTarget({
      id: 'fish', space: viewport,
      activationPoint: point('logical', viewport, 752, 315),
      bounds: region('logical', viewport, 732, 305, 40, 20),
      confidence: .95, frameId: frameId('frame-1'), locatorFingerprint: 'image:fish', resolvedAt: 1,
    }, context);

    expect(result.point).toEqual({ x: 400, y: 300 });
    expect(result.bounds).toEqual({ x: 380, y: 290, width: 40, height: 20 });
    expect(result.ratioPoint).toEqual({ x: 400 / 949, y: 300 / 561 });
    expect(result.ratioBounds).toEqual({ x: 380 / 950, y: 290 / 562, width: 40 / 950, height: 20 / 562 });
  });
});
