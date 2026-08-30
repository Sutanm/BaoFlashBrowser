import {
  AutomationGeometryError,
  type AffineTransform2D,
  type Generation,
  type Region,
  type Size,
  type SpaceRef,
  type SurfaceId,
  type SurfaceSpaceRef,
  type TargetGenerationRef,
  IDENTITY_AFFINE,
  affine,
  assertCurrentSpace,
  composeAffine,
  intersectRegions,
  invertAffine,
  ratioRegionToLogical,
  region,
  size,
  surfaceSpace,
} from './geometry';

export type SurfaceElementHint = 'flash' | 'ruffle' | 'canvas' | 'iframe' | 'container';

export type PersistedRegion = {
  readonly unit: 'ratio' | 'logical';
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type SurfaceSpec =
  | { readonly kind: 'viewport' }
  | {
    readonly kind: 'element';
    readonly parent?: SurfaceSpec;
    readonly selector?: string;
    readonly framePath?: readonly string[];
    readonly elementHint?: SurfaceElementHint;
    readonly fingerprint?: string;
  }
  | {
    readonly kind: 'visual';
    readonly parent?: SurfaceSpec;
    readonly visualHint: SurfaceElementHint;
    readonly fingerprint?: string;
  }
  | {
    readonly kind: 'region';
    readonly parent: SurfaceSpec;
    readonly region: PersistedRegion;
    readonly overflow?: 'clip' | 'strict';
  }
  | { readonly kind: 'named'; readonly name: string };

export type SurfaceEvidence = {
  readonly resolver: string;
  readonly summary: string;
  readonly fingerprint?: string;
};

export type ResolvedSurface = {
  readonly id: SurfaceId;
  readonly spec: SurfaceSpec;
  readonly space: SurfaceSpaceRef;
  readonly parentSpace: SpaceRef;
  readonly boundsInParent: Region<'logical'>;
  readonly localSize: Size;
  readonly toViewport: AffineTransform2D;
  readonly resolvedAt: number;
  readonly evidence?: SurfaceEvidence;
};

export type SurfaceSpecRegistry = Readonly<Record<string, SurfaceSpec>>;

export type SurfaceErrorCode =
  | 'SURFACE_SPEC_INVALID'
  | 'SURFACE_SPEC_CYCLE'
  | 'SURFACE_SPEC_TOO_DEEP'
  | 'SURFACE_NAMED_NOT_FOUND'
  | 'SURFACE_REGION_OUTSIDE_PARENT';

export class AutomationSurfaceError extends Error {
  readonly code: SurfaceErrorCode;

  constructor(code: SurfaceErrorCode, message: string) {
    super(message);
    this.name = 'AutomationSurfaceError';
    this.code = code;
  }
}

function nonEmpty(value: string | undefined, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function validatePersistedRegion(value: PersistedRegion): void {
  const numbers = [value.x, value.y, value.width, value.height];
  if (!numbers.every(Number.isFinite) || value.width <= 0 || value.height <= 0) {
    throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'surface region must have positive finite dimensions');
  }
  if (value.unit === 'ratio' && (value.x < 0 || value.y < 0 || value.x + value.width > 1 || value.y + value.height > 1)) {
    throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'ratio surface region must be inside [0,1]');
  }
}

export function validateSurfaceSpec(
  spec: SurfaceSpec,
  options: { readonly named?: SurfaceSpecRegistry; readonly maxDepth?: number; readonly allowUnresolvedNamed?: boolean } = {},
): void {
  const maxDepth = options.maxDepth ?? 8;
  const objects = new Set<object>();
  const names = new Set<string>();

  const visit = (current: SurfaceSpec, depth: number): void => {
    if (depth > maxDepth) throw new AutomationSurfaceError('SURFACE_SPEC_TOO_DEEP', `surface nesting exceeds ${maxDepth}`);
    if (objects.has(current)) throw new AutomationSurfaceError('SURFACE_SPEC_CYCLE', 'surface spec contains an object cycle');
    objects.add(current);
    try {
      if (current.kind === 'viewport') return;
      if (current.kind === 'named') {
        if (!nonEmpty(current.name, 160)) throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'named surface requires a valid name');
        const referenced = options.named?.[current.name];
        if (!referenced && options.allowUnresolvedNamed) return;
        if (!referenced) throw new AutomationSurfaceError('SURFACE_NAMED_NOT_FOUND', `named surface is missing: ${current.name}`);
        if (names.has(current.name)) throw new AutomationSurfaceError('SURFACE_SPEC_CYCLE', `named surface cycle: ${current.name}`);
        names.add(current.name);
        try { visit(referenced, depth + 1); } finally { names.delete(current.name); }
        return;
      }
      if (current.kind === 'element') {
        if (!nonEmpty(current.selector, 1000) && !(current.framePath?.length) && !nonEmpty(current.fingerprint, 4096)) {
          throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'element surface requires selector, framePath or fingerprint');
        }
        if (current.framePath && (current.framePath.length > 8 || current.framePath.some((item) => !nonEmpty(item, 1000)))) {
          throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'surface framePath is invalid');
        }
        if (current.parent) visit(current.parent, depth + 1);
        return;
      }
      if (current.kind === 'visual') {
        if (current.fingerprint !== undefined && !nonEmpty(current.fingerprint, 4096)) {
          throw new AutomationSurfaceError('SURFACE_SPEC_INVALID', 'visual fingerprint is invalid');
        }
        if (current.parent) visit(current.parent, depth + 1);
        return;
      }
      validatePersistedRegion(current.region);
      visit(current.parent, depth + 1);
    } finally {
      objects.delete(current);
    }
  };

  visit(spec, 1);
}

export function expandNamedSurface(spec: SurfaceSpec, named: SurfaceSpecRegistry, maxDepth = 8): SurfaceSpec {
  validateSurfaceSpec(spec, { named, maxDepth });
  const expand = (current: SurfaceSpec): SurfaceSpec => {
    if (current.kind === 'named') return expand(named[current.name]);
    if (current.kind === 'element' && current.parent) return Object.freeze({ ...current, parent: expand(current.parent) });
    if (current.kind === 'visual' && current.parent) return Object.freeze({ ...current, parent: expand(current.parent) });
    if (current.kind === 'region') return Object.freeze({ ...current, parent: expand(current.parent) });
    return current;
  };
  return expand(spec);
}

export function resolvedSurface(input: {
  readonly id: SurfaceId;
  readonly generation: Generation;
  readonly target: TargetGenerationRef;
  readonly spec: SurfaceSpec;
  readonly parentSpace: SpaceRef;
  readonly boundsInParent: Region<'logical'>;
  readonly localSize: Size;
  readonly toViewport: AffineTransform2D;
  readonly resolvedAt?: number;
  readonly evidence?: SurfaceEvidence;
}): ResolvedSurface {
  assertCurrentSpace(input.parentSpace, input.boundsInParent.space);
  if (input.parentSpace.targetId !== input.target.targetId
    || input.parentSpace.targetGeneration !== input.target.targetGeneration
    || input.parentSpace.viewportGeneration !== input.target.viewportGeneration) {
    throw new AutomationGeometryError('TARGET_STALE', 'resolved surface parent belongs to another target generation');
  }
  // Validate now so invalid transforms cannot enter a ResolvedSurface graph.
  invertAffine(input.toViewport);
  const space = surfaceSpace({ ...input.target, surfaceId: input.id, surfaceGeneration: input.generation });
  return Object.freeze({
    id: input.id,
    spec: input.spec,
    space,
    parentSpace: input.parentSpace,
    boundsInParent: input.boundsInParent,
    localSize: input.localSize,
    toViewport: input.toViewport,
    resolvedAt: input.resolvedAt ?? Date.now(),
    evidence: input.evidence,
  });
}

export function assertResolvedSurfaceCurrent(value: ResolvedSurface, currentSpace: SurfaceSpaceRef): void {
  assertCurrentSpace(value.space, currentSpace);
}

export function resolveRegionSurface(input: {
  readonly id: SurfaceId;
  readonly generation: Generation;
  readonly target: TargetGenerationRef;
  readonly spec: Extract<SurfaceSpec, { readonly kind: 'region' }>;
  readonly parentSpace: SpaceRef;
  readonly parentSize: Size;
  readonly parentToViewport?: AffineTransform2D;
  readonly resolvedAt?: number;
}): ResolvedSurface {
  validatePersistedRegion(input.spec.region);
  const requested = input.spec.region.unit === 'ratio'
    ? ratioRegionToLogical(region('ratio', input.parentSpace,
      input.spec.region.x, input.spec.region.y, input.spec.region.width, input.spec.region.height), input.parentSize)
    : region('logical', input.parentSpace,
      input.spec.region.x, input.spec.region.y, input.spec.region.width, input.spec.region.height);
  const parentBounds = region('logical', input.parentSpace, 0, 0, input.parentSize.width, input.parentSize.height);
  const clipped = intersectRegions(requested, parentBounds);
  if (!clipped) throw new AutomationSurfaceError('SURFACE_REGION_OUTSIDE_PARENT', 'surface region does not overlap its parent');
  if (input.spec.overflow === 'strict'
    && (clipped.x !== requested.x || clipped.y !== requested.y || clipped.width !== requested.width || clipped.height !== requested.height)) {
    throw new AutomationSurfaceError('SURFACE_REGION_OUTSIDE_PARENT', 'strict surface region extends outside its parent');
  }
  const translation = affine(1, 0, 0, 1, clipped.x, clipped.y);
  const toViewport = composeAffine(input.parentToViewport ?? IDENTITY_AFFINE, translation);
  return resolvedSurface({
    id: input.id,
    generation: input.generation,
    target: input.target,
    spec: input.spec,
    parentSpace: input.parentSpace,
    boundsInParent: clipped,
    localSize: size(clipped.width, clipped.height),
    toViewport,
    resolvedAt: input.resolvedAt,
    evidence: { resolver: 'region', summary: 'region surface resolved from parent geometry' },
  });
}
