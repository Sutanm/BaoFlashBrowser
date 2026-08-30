import { describe, expect, it } from 'vitest';
import {
  IDENTITY_AFFINE,
  applyAffine,
  generation,
  region,
  size,
  surfaceId,
  targetId,
  viewportSpace,
} from '../src/shared/automation/core/geometry';
import {
  AutomationSurfaceError,
  assertResolvedSurfaceCurrent,
  expandNamedSurface,
  resolvedSurface,
  resolveRegionSurface,
  validateSurfaceSpec,
  type SurfaceSpec,
} from '../src/shared/automation/core/surface';

const target = { targetId: targetId('tab-1'), targetGeneration: generation(2), viewportGeneration: generation(4) };
const viewport = viewportSpace(target);

describe('Automation 2.0 surface model', () => {
  it('validates viewport, element, visual, region and named specs', () => {
    const named = {
      game: { kind: 'element', selector: 'canvas#game', elementHint: 'canvas' } as const,
    };
    expect(() => validateSurfaceSpec({ kind: 'viewport' })).not.toThrow();
    expect(() => validateSurfaceSpec({ kind: 'visual', visualHint: 'flash' })).not.toThrow();
    expect(() => validateSurfaceSpec({ kind: 'named', name: 'game' }, { named })).not.toThrow();
    expect(expandNamedSurface({ kind: 'named', name: 'game' }, named)).toEqual(named.game);
    expect(() => validateSurfaceSpec({ kind: 'element' })).toThrowError(expect.objectContaining({ code: 'SURFACE_SPEC_INVALID' }));
  });

  it('rejects object, named and depth cycles', () => {
    const cyclic = { kind: 'element', selector: '#game' } as { kind: 'element'; selector: string; parent?: SurfaceSpec };
    cyclic.parent = cyclic;
    expect(() => validateSurfaceSpec(cyclic)).toThrowError(expect.objectContaining({ code: 'SURFACE_SPEC_CYCLE' }));
    const named: Record<string, SurfaceSpec> = { a: { kind: 'named', name: 'b' }, b: { kind: 'named', name: 'a' } };
    expect(() => validateSurfaceSpec({ kind: 'named', name: 'a' }, { named })).toThrowError(expect.objectContaining({ code: 'SURFACE_SPEC_CYCLE' }));
    const nested: SurfaceSpec = { kind: 'region', parent: { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'ratio', x: 0, y: 0, width: 1, height: 1 } }, region: { unit: 'ratio', x: 0, y: 0, width: 1, height: 1 } };
    expect(() => validateSurfaceSpec(nested, { maxDepth: 2 })).toThrowError(expect.objectContaining({ code: 'SURFACE_SPEC_TOO_DEEP' }));
  });

  it('resolves a ratio Region Surface into parent and viewport geometry', () => {
    const spec = { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'ratio', x: .25, y: .2, width: .5, height: .6 } } as const;
    const resolved = resolveRegionSurface({
      id: surfaceId('game'), generation: generation(1), target, spec,
      parentSpace: viewport, parentSize: size(1280, 720), parentToViewport: IDENTITY_AFFINE, resolvedAt: 123,
    });
    expect(resolved.boundsInParent).toMatchObject({ x: 320, y: 144, width: 640, height: 432 });
    expect(resolved.localSize).toEqual(size(640, 432));
    expect(applyAffine(resolved.toViewport, { x: 10, y: 20 })).toEqual({ x: 330, y: 164 });
    expect(resolved.resolvedAt).toBe(123);
    expect(() => assertResolvedSurfaceCurrent(resolved, resolved.space)).not.toThrow();
    expect(() => assertResolvedSurfaceCurrent(resolved, { ...resolved.space, surfaceGeneration: generation(2) }))
      .toThrowError(expect.objectContaining({ code: 'SURFACE_STALE' }));
  });

  it('composes a nested Region Surface through the parent transform', () => {
    const outerSpec = { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'logical', x: 100, y: 50, width: 800, height: 600 } } as const;
    const outer = resolveRegionSurface({ id: surfaceId('outer'), generation: generation(1), target, spec: outerSpec, parentSpace: viewport, parentSize: size(1280, 720) });
    const innerSpec = { kind: 'region', parent: outerSpec, region: { unit: 'ratio', x: .25, y: .25, width: .5, height: .5 } } as const;
    const inner = resolveRegionSurface({ id: surfaceId('inner'), generation: generation(1), target, spec: innerSpec, parentSpace: outer.space, parentSize: outer.localSize, parentToViewport: outer.toViewport });
    expect(inner.boundsInParent).toMatchObject({ x: 200, y: 150, width: 400, height: 300 });
    expect(applyAffine(inner.toViewport, { x: 0, y: 0 })).toEqual({ x: 300, y: 200 });
  });

  it('clips or rejects logical Region Surfaces outside the parent', () => {
    const base = { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'logical', x: -10, y: 20, width: 40, height: 30 } } as const;
    const clipped = resolveRegionSurface({ id: surfaceId('clip'), generation: generation(1), target, spec: base, parentSpace: viewport, parentSize: size(100, 100) });
    expect(clipped.boundsInParent).toMatchObject({ x: 0, y: 20, width: 30, height: 30 });
    expect(() => resolveRegionSurface({ id: surfaceId('strict'), generation: generation(1), target, spec: { ...base, overflow: 'strict' }, parentSpace: viewport, parentSize: size(100, 100) }))
      .toThrowError(expect.objectContaining({ code: 'SURFACE_REGION_OUTSIDE_PARENT' }));
    expect(() => resolveRegionSurface({ id: surfaceId('miss'), generation: generation(1), target, spec: { ...base, region: { ...base.region, x: 110 } }, parentSpace: viewport, parentSize: size(100, 100) }))
      .toThrow(AutomationSurfaceError);
  });

  it('requires ResolvedSurface bounds to use its parent Space', () => {
    const otherViewport = viewportSpace({ ...target, viewportGeneration: generation(5) });
    const spec = { kind: 'region', parent: { kind: 'viewport' }, region: { unit: 'ratio', x: 0, y: 0, width: 1, height: 1 } } as const;
    expect(() => resolvedSurface({
      id: surfaceId('bad'), generation: generation(1), target, spec,
      parentSpace: viewport, boundsInParent: region('logical', otherViewport, 0, 0, 10, 10),
      localSize: size(10, 10), toViewport: IDENTITY_AFFINE,
    })).toThrowError(expect.objectContaining({ code: 'VIEWPORT_STALE' }));
  });
});
