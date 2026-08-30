import { describe, expect, it } from 'vitest';
import {
  affine,
  generation,
  point,
  region,
  size,
  surfaceId,
  targetId,
  viewportSpace,
} from '../src/shared/automation/core/geometry';
import { AutomationCoordinateResolver } from '../src/shared/automation/core/coordinate-resolver';
import { resolveRegionSurface } from '../src/shared/automation/core/surface';

const target = { targetId: targetId('tab-1'), targetGeneration: generation(1), viewportGeneration: generation(1) };
const viewport = viewportSpace(target);
const outerSpec = { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'logical', x: 100, y: 50, width: 800, height: 600 } } as const;
const outer = resolveRegionSurface({ id: surfaceId('outer'), generation: generation(2), target, spec: outerSpec, parentSpace: viewport, parentSize: size(1280, 720) });
const innerSpec = { kind: 'region', parent: outerSpec, region: { unit: 'ratio', x: .25, y: .25, width: .5, height: .5 } } as const;
const inner = resolveRegionSurface({ id: surfaceId('inner'), generation: generation(3), target, spec: innerSpec, parentSpace: outer.space, parentSize: outer.localSize, parentToViewport: outer.toViewport });

describe('Automation 2.0 CoordinateResolver', () => {
  it('resolves ratio and logical geometry within ViewportSpace', () => {
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720) });
    expect(resolver.toLogical(point('ratio', viewport, .5, .5))).toMatchObject({ x: 639.5, y: 359.5, unit: 'logical' });
    expect(resolver.toLogical(region('ratio', viewport, .25, .25, .5, .5))).toMatchObject({ x: 320, y: 180, width: 640, height: 360 });
  });

  it('maps nested SurfaceSpace geometry to ViewportSpace', () => {
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720), surfaces: [outer, inner] });
    expect(resolver.toViewport(point('logical', inner.space, 0, 0))).toMatchObject({ x: 300, y: 200, space: viewport });
    expect(resolver.toViewport(point('ratio', inner.space, 1, 1))).toMatchObject({ x: 699, y: 499 });
    expect(resolver.toViewport(region('ratio', inner.space, 0, 0, 1, 1))).toMatchObject({ x: 300, y: 200, width: 400, height: 300 });
  });

  it('converts between sibling and parent Spaces through ViewportSpace', () => {
    const siblingSpec = { kind: 'region', parent: outerSpec, region: { unit: 'logical', x: 500, y: 100, width: 200, height: 200 } } as const;
    const sibling = resolveRegionSurface({ id: surfaceId('sibling'), generation: generation(1), target, spec: siblingSpec, parentSpace: outer.space, parentSize: outer.localSize, parentToViewport: outer.toViewport });
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720), surfaces: [outer, inner, sibling] });
    const siblingPoint = resolver.convert(point('logical', inner.space, 300, 50), sibling.space);
    // inner origin=(300,200), sibling origin=(600,150); viewport point=(600,250)
    expect(siblingPoint).toMatchObject({ x: 0, y: 100, space: sibling.space });
    expect(resolver.convert(siblingPoint, inner.space)).toMatchObject({ x: 300, y: 50 });
  });

  it('supports nonuniform affine Surface transforms', () => {
    const scaled = { ...outer, id: surfaceId('scaled'), space: { ...outer.space, surfaceId: surfaceId('scaled') }, toViewport: affine(2, 0, 0, .5, 10, 20) };
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720), surfaces: [scaled] });
    expect(resolver.toViewport(point('logical', scaled.space, 4, 8))).toMatchObject({ x: 18, y: 24 });
    expect(resolver.convert(point('logical', viewport, 18, 24), scaled.space)).toMatchObject({ x: 4, y: 8 });
  });

  it('rejects stale target, viewport and Surface generations', () => {
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720), surfaces: [outer] });
    expect(() => resolver.toLogical(point('logical', { ...viewport, targetGeneration: generation(2) }, 1, 1)))
      .toThrowError(expect.objectContaining({ code: 'TARGET_STALE' }));
    expect(() => resolver.toLogical(point('logical', { ...viewport, viewportGeneration: generation(2) }, 1, 1)))
      .toThrowError(expect.objectContaining({ code: 'VIEWPORT_STALE' }));
    expect(() => resolver.toLogical(point('logical', { ...outer.space, surfaceGeneration: generation(9) }, 1, 1)))
      .toThrowError(expect.objectContaining({ code: 'SURFACE_STALE' }));
  });

  it('rejects an unresolved Surface instead of guessing a transform', () => {
    const resolver = new AutomationCoordinateResolver({ viewport, viewportSize: size(1280, 720) });
    expect(() => resolver.toViewport(point('logical', outer.space, 0, 0)))
      .toThrowError(expect.objectContaining({ code: 'SURFACE_STALE' }));
  });
});
