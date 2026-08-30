import {
  AutomationGeometryError,
  type Point,
  type Region,
  type Size,
  type SpaceRef,
  type SurfaceSpaceRef,
  type ViewportSpaceRef,
  assertCurrentSpace,
  invertAffine,
  logicalPointToRatio,
  logicalRegionToRatio,
  ratioPointToLogical,
  ratioRegionToLogical,
  transformPoint,
  transformRegion,
  viewportSpace,
} from './geometry';
import type { ResolvedSurface } from './surface';

export type CoordinateSnapshot = {
  readonly viewport: ViewportSpaceRef;
  readonly viewportSize: Size;
  readonly surfaces?: readonly ResolvedSurface[];
};

export class AutomationCoordinateResolver {
  private readonly snapshot: CoordinateSnapshot;
  private readonly surfaces: Map<string, ResolvedSurface>;

  constructor(snapshot: CoordinateSnapshot) {
    this.snapshot = snapshot;
    this.surfaces = new Map((snapshot.surfaces ?? []).map((surface) => [surface.id, surface]));
    for (const surface of this.surfaces.values()) this.assertSpaceCurrent(surface.space);
  }

  sizeOf(space: SpaceRef): Size {
    this.assertSpaceCurrent(space);
    return space.kind === 'viewport' ? this.snapshot.viewportSize : this.requireSurface(space).localSize;
  }

  toLogical(value: Point): Point<'logical'>;
  toLogical(value: Region): Region<'logical'>;
  toLogical(value: Point | Region): Point<'logical'> | Region<'logical'> {
    this.assertSpaceCurrent(value.space);
    if (value.unit === 'logical') return value as Point<'logical'> | Region<'logical'>;
    const logicalSize = this.sizeOf(value.space);
    return value.kind === 'point'
      ? ratioPointToLogical(value as Point<'ratio'>, logicalSize)
      : ratioRegionToLogical(value as Region<'ratio'>, logicalSize);
  }

  toViewport(value: Point): Point<'logical'>;
  toViewport(value: Region): Region<'logical'>;
  toViewport(value: Point | Region): Point<'logical'> | Region<'logical'> {
    const logical = value.kind === 'point' ? this.toLogical(value) : this.toLogical(value);
    if (logical.space.kind === 'viewport') return logical;
    const surface = this.requireSurface(logical.space);
    return logical.kind === 'point'
      ? transformPoint(logical, this.snapshot.viewport, surface.toViewport)
      : transformRegion(logical, this.snapshot.viewport, surface.toViewport);
  }

  convert(value: Point, targetSpace: SpaceRef, targetUnit?: 'logical'): Point<'logical'>;
  convert(value: Point, targetSpace: SpaceRef, targetUnit: 'ratio'): Point<'ratio'>;
  convert(value: Region, targetSpace: SpaceRef, targetUnit?: 'logical'): Region<'logical'>;
  convert(value: Region, targetSpace: SpaceRef, targetUnit: 'ratio'): Region<'ratio'>;
  convert(
    value: Point | Region,
    targetSpace: SpaceRef,
    targetUnit: 'logical' | 'ratio' = 'logical',
  ): Point | Region {
    this.assertSpaceCurrent(targetSpace);
    const viewportValue = value.kind === 'point' ? this.toViewport(value) : this.toViewport(value);
    let logical: Point<'logical'> | Region<'logical'>;
    if (targetSpace.kind === 'viewport') {
      logical = viewportValue;
    } else {
      const targetSurface = this.requireSurface(targetSpace);
      const inverse = invertAffine(targetSurface.toViewport);
      logical = viewportValue.kind === 'point'
        ? transformPoint(viewportValue, targetSpace, inverse)
        : transformRegion(viewportValue, targetSpace, inverse);
    }
    if (targetUnit === 'logical') return logical;
    const targetSize = this.sizeOf(targetSpace);
    return logical.kind === 'point'
      ? logicalPointToRatio(logical, targetSize)
      : logicalRegionToRatio(logical, targetSize);
  }

  assertSpaceCurrent(space: SpaceRef): void {
    const asViewport = viewportSpace({
      targetId: space.targetId,
      targetGeneration: space.targetGeneration,
      viewportGeneration: space.viewportGeneration,
    });
    assertCurrentSpace(asViewport, this.snapshot.viewport);
    if (space.kind === 'surface') {
      const surface = this.surfaces.get(space.surfaceId);
      if (!surface) throw new AutomationGeometryError('SURFACE_STALE', `surface is not resolved: ${space.surfaceId}`);
      assertCurrentSpace(space, surface.space);
    }
  }

  private requireSurface(space: SurfaceSpaceRef): ResolvedSurface {
    const surface = this.surfaces.get(space.surfaceId);
    if (!surface) throw new AutomationGeometryError('SURFACE_STALE', `surface is not resolved: ${space.surfaceId}`);
    assertCurrentSpace(space, surface.space);
    return surface;
  }
}
