export type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type TargetId = Brand<string, 'AutomationTargetId'>;
export type SurfaceId = Brand<string, 'AutomationSurfaceId'>;
export type Generation = Brand<number, 'AutomationGeneration'>;
export type FiniteNumber = Brand<number, 'AutomationFiniteNumber'>;
export type GeometryUnit = 'ratio' | 'logical';
export type PersistedPoint = { readonly unit: GeometryUnit; readonly x: number; readonly y: number };
export type PersistedVector = { readonly unit: GeometryUnit; readonly dx: number; readonly dy: number };

export type GeometryErrorCode =
  | 'INVALID_NUMBER'
  | 'INVALID_GENERATION'
  | 'INVALID_SIZE'
  | 'INVALID_POINT'
  | 'INVALID_REGION'
  | 'SPACE_MISMATCH'
  | 'TARGET_STALE'
  | 'VIEWPORT_STALE'
  | 'SURFACE_STALE'
  | 'TRANSFORM_NOT_INVERTIBLE';

export class AutomationGeometryError extends Error {
  readonly code: GeometryErrorCode;

  constructor(code: GeometryErrorCode, message: string) {
    super(message);
    this.name = 'AutomationGeometryError';
    this.code = code;
  }
}

export type TargetGenerationRef = {
  readonly targetId: TargetId;
  readonly targetGeneration: Generation;
  readonly viewportGeneration: Generation;
};

export type ViewportSpaceRef = TargetGenerationRef & {
  readonly kind: 'viewport';
};

export type SurfaceSpaceRef = TargetGenerationRef & {
  readonly kind: 'surface';
  readonly surfaceId: SurfaceId;
  readonly surfaceGeneration: Generation;
};

export type SpaceRef = ViewportSpaceRef | SurfaceSpaceRef;

export type Size = {
  readonly width: FiniteNumber;
  readonly height: FiniteNumber;
};

export type Point<Unit extends GeometryUnit = GeometryUnit> = {
  readonly kind: 'point';
  readonly unit: Unit;
  readonly space: SpaceRef;
  readonly x: FiniteNumber;
  readonly y: FiniteNumber;
};

export type Vector<Unit extends GeometryUnit = GeometryUnit> = {
  readonly kind: 'vector';
  readonly unit: Unit;
  readonly space: SpaceRef;
  readonly dx: FiniteNumber;
  readonly dy: FiniteNumber;
};

export type Region<Unit extends GeometryUnit = GeometryUnit> = {
  readonly kind: 'region';
  readonly unit: Unit;
  readonly space: SpaceRef;
  readonly x: FiniteNumber;
  readonly y: FiniteNumber;
  readonly width: FiniteNumber;
  readonly height: FiniteNumber;
};

export type AffineTransform2D = {
  readonly a: FiniteNumber;
  readonly b: FiniteNumber;
  readonly c: FiniteNumber;
  readonly d: FiniteNumber;
  readonly e: FiniteNumber;
  readonly f: FiniteNumber;
};

export type IntegerRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

function assertNonEmptyId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AutomationGeometryError('INVALID_NUMBER', `${label} must not be empty`);
  return normalized;
}

export function targetId(value: string): TargetId {
  return assertNonEmptyId(value, 'target id') as TargetId;
}

export function surfaceId(value: string): SurfaceId {
  return assertNonEmptyId(value, 'surface id') as SurfaceId;
}

export function generation(value: number): Generation {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AutomationGeometryError('INVALID_GENERATION', `generation must be a non-negative safe integer: ${String(value)}`);
  }
  return value as Generation;
}

export function finite(value: number, label = 'value'): FiniteNumber {
  if (!Number.isFinite(value)) throw new AutomationGeometryError('INVALID_NUMBER', `${label} must be finite: ${String(value)}`);
  return (Object.is(value, -0) ? 0 : value) as FiniteNumber;
}

export function size(width: number, height: number): Size {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AutomationGeometryError('INVALID_SIZE', `size must be positive and finite: ${String(width)}x${String(height)}`);
  }
  return Object.freeze({ width: finite(width, 'width'), height: finite(height, 'height') });
}

export function viewportSpace(ref: TargetGenerationRef): ViewportSpaceRef {
  return Object.freeze({ ...ref, kind: 'viewport' });
}

export function surfaceSpace(ref: TargetGenerationRef & { surfaceId: SurfaceId; surfaceGeneration: Generation }): SurfaceSpaceRef {
  return Object.freeze({ ...ref, kind: 'surface' });
}

export function point<Unit extends GeometryUnit>(unit: Unit, space: SpaceRef, x: number, y: number): Point<Unit> {
  if (unit === 'ratio' && (x < 0 || x > 1 || y < 0 || y > 1)) {
    throw new AutomationGeometryError('INVALID_POINT', `ratio point must be inside [0,1]: ${String(x)},${String(y)}`);
  }
  return Object.freeze({ kind: 'point', unit, space, x: finite(x, 'x'), y: finite(y, 'y') });
}

export function vector<Unit extends GeometryUnit>(unit: Unit, space: SpaceRef, dx: number, dy: number): Vector<Unit> {
  return Object.freeze({ kind: 'vector', unit, space, dx: finite(dx, 'dx'), dy: finite(dy, 'dy') });
}

export function region<Unit extends GeometryUnit>(
  unit: Unit,
  space: SpaceRef,
  x: number,
  y: number,
  width: number,
  height: number,
): Region<Unit> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new AutomationGeometryError('INVALID_REGION', `region size must be positive and finite: ${String(width)}x${String(height)}`);
  }
  if (unit === 'ratio' && (x < 0 || y < 0 || x + width > 1 || y + height > 1)) {
    throw new AutomationGeometryError('INVALID_REGION', 'ratio region must be fully inside [0,1]');
  }
  return Object.freeze({
    kind: 'region', unit, space,
    x: finite(x, 'x'), y: finite(y, 'y'),
    width: finite(width, 'width'), height: finite(height, 'height'),
  });
}

export function sameTargetGeneration(first: TargetGenerationRef, second: TargetGenerationRef): boolean {
  return first.targetId === second.targetId && first.targetGeneration === second.targetGeneration;
}

export function sameSpace(first: SpaceRef, second: SpaceRef): boolean {
  if (first.kind !== second.kind || !sameTargetGeneration(first, second)
    || first.viewportGeneration !== second.viewportGeneration) return false;
  return first.kind === 'viewport' || (second.kind === 'surface'
    && first.surfaceId === second.surfaceId && first.surfaceGeneration === second.surfaceGeneration);
}

export function assertCurrentSpace(actual: SpaceRef, expected: SpaceRef): void {
  if (actual.targetId !== expected.targetId || actual.targetGeneration !== expected.targetGeneration) {
    throw new AutomationGeometryError('TARGET_STALE', 'automation target generation changed');
  }
  if (actual.viewportGeneration !== expected.viewportGeneration) {
    throw new AutomationGeometryError('VIEWPORT_STALE', 'automation viewport generation changed');
  }
  if (actual.kind !== expected.kind) throw new AutomationGeometryError('SPACE_MISMATCH', 'geometry spaces have different kinds');
  if (actual.kind === 'surface' && expected.kind === 'surface'
    && (actual.surfaceId !== expected.surfaceId || actual.surfaceGeneration !== expected.surfaceGeneration)) {
    throw new AutomationGeometryError('SURFACE_STALE', 'automation surface generation changed');
  }
}

export function ratioPointToLogical(value: Point<'ratio'>, logicalSize: Size): Point<'logical'> {
  // Points represent input positions. Ratio 1 maps to the last in-bounds logical
  // coordinate, while Regions below use the full half-open extent.
  return point('logical', value.space,
    value.x * Math.max(0, logicalSize.width - 1),
    value.y * Math.max(0, logicalSize.height - 1));
}

export function logicalPointToRatio(value: Point<'logical'>, logicalSize: Size): Point<'ratio'> {
  const xDenominator = Math.max(1, logicalSize.width - 1);
  const yDenominator = Math.max(1, logicalSize.height - 1);
  return point('ratio', value.space, value.x / xDenominator, value.y / yDenominator);
}

export function ratioRegionToLogical(value: Region<'ratio'>, logicalSize: Size): Region<'logical'> {
  return region('logical', value.space,
    value.x * logicalSize.width, value.y * logicalSize.height,
    value.width * logicalSize.width, value.height * logicalSize.height);
}

export function logicalRegionToRatio(value: Region<'logical'>, logicalSize: Size): Region<'ratio'> {
  return region('ratio', value.space,
    value.x / logicalSize.width, value.y / logicalSize.height,
    value.width / logicalSize.width, value.height / logicalSize.height);
}

function assertComparable(first: Region, second: Region): void {
  if (first.unit !== second.unit || !sameSpace(first.space, second.space)) {
    throw new AutomationGeometryError('SPACE_MISMATCH', 'regions must use the same unit and Space');
  }
}

export function intersectRegions<Unit extends GeometryUnit>(first: Region<Unit>, second: Region<Unit>): Region<Unit> | null {
  assertComparable(first, second);
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  return right <= x || bottom <= y ? null : region(first.unit, first.space, x, y, right - x, bottom - y);
}

export function regionContainsPoint<Unit extends GeometryUnit>(container: Region<Unit>, value: Point<Unit>): boolean {
  if (container.unit !== value.unit || !sameSpace(container.space, value.space)) {
    throw new AutomationGeometryError('SPACE_MISMATCH', 'point and region must use the same unit and Space');
  }
  return value.x >= container.x && value.y >= container.y
    && value.x < container.x + container.width && value.y < container.y + container.height;
}

export function affine(a: number, b: number, c: number, d: number, e: number, f: number): AffineTransform2D {
  return Object.freeze({ a: finite(a), b: finite(b), c: finite(c), d: finite(d), e: finite(e), f: finite(f) });
}

export const IDENTITY_AFFINE: AffineTransform2D = affine(1, 0, 0, 1, 0, 0);

export function applyAffine(transform: AffineTransform2D, value: { readonly x: number; readonly y: number }): { x: number; y: number } {
  return {
    x: transform.a * value.x + transform.c * value.y + transform.e,
    y: transform.b * value.x + transform.d * value.y + transform.f,
  };
}

/** Returns outer(inner(point)). */
export function composeAffine(outer: AffineTransform2D, inner: AffineTransform2D): AffineTransform2D {
  return affine(
    outer.a * inner.a + outer.c * inner.b,
    outer.b * inner.a + outer.d * inner.b,
    outer.a * inner.c + outer.c * inner.d,
    outer.b * inner.c + outer.d * inner.d,
    outer.a * inner.e + outer.c * inner.f + outer.e,
    outer.b * inner.e + outer.d * inner.f + outer.f,
  );
}

export function invertAffine(transform: AffineTransform2D): AffineTransform2D {
  const determinant = transform.a * transform.d - transform.b * transform.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON) {
    throw new AutomationGeometryError('TRANSFORM_NOT_INVERTIBLE', 'affine transform is not invertible');
  }
  return affine(
    transform.d / determinant,
    -transform.b / determinant,
    -transform.c / determinant,
    transform.a / determinant,
    (transform.c * transform.f - transform.d * transform.e) / determinant,
    (transform.b * transform.e - transform.a * transform.f) / determinant,
  );
}

export function transformPoint(value: Point<'logical'>, targetSpace: SpaceRef, transform: AffineTransform2D): Point<'logical'> {
  const result = applyAffine(transform, value);
  return point('logical', targetSpace, result.x, result.y);
}

export function transformRegion(value: Region<'logical'>, targetSpace: SpaceRef, transform: AffineTransform2D): Region<'logical'> {
  const corners = [
    applyAffine(transform, { x: value.x, y: value.y }),
    applyAffine(transform, { x: value.x + value.width, y: value.y }),
    applyAffine(transform, { x: value.x, y: value.y + value.height }),
    applyAffine(transform, { x: value.x + value.width, y: value.y + value.height }),
  ];
  const xs = corners.map((item) => item.x);
  const ys = corners.map((item) => item.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return region('logical', targetSpace, x, y, Math.max(...xs) - x, Math.max(...ys) - y);
}

export function roundPointForInput(value: { readonly x: number; readonly y: number }): { x: number; y: number } {
  const nearest = (number: number): number => number < 0 ? -Math.floor(-number + 0.5) : Math.floor(number + 0.5);
  return { x: nearest(finite(value.x, 'x')), y: nearest(finite(value.y, 'y')) };
}

export function coverRegionForIntegerBoundary(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): IntegerRect {
  const source = region('logical', viewportSpace({ targetId: targetId('rounding'), targetGeneration: generation(0), viewportGeneration: generation(0) }),
    value.x, value.y, value.width, value.height);
  const x = Math.floor(source.x);
  const y = Math.floor(source.y);
  const right = Math.ceil(source.x + source.width);
  const bottom = Math.ceil(source.y + source.height);
  return { x, y, width: right - x, height: bottom - y };
}
