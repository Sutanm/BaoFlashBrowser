import {
  AutomationGeometryError,
  type Brand,
  type Point,
  type Region,
  type Size,
  type SpaceRef,
  assertCurrentSpace,
  finite,
  point,
  region,
  size,
} from './geometry';

export type FrameId = Brand<string, 'AutomationFrameId'>;

export type BitmapPoint = {
  readonly x: number;
  readonly y: number;
};

export type BitmapRegion = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type CaptureFrameGeometry = {
  readonly frameId: FrameId;
  readonly space: SpaceRef;
  readonly capturedRegion: Region<'logical'>;
  readonly bitmapSize: Size;
  readonly capturedAt: number;
  readonly sequence: number;
};

export function frameId(value: string): FrameId {
  const normalized = value.trim();
  if (!normalized) throw new AutomationGeometryError('INVALID_NUMBER', 'frame id must not be empty');
  return normalized as FrameId;
}

export function captureFrameGeometry(input: {
  readonly frameId: FrameId;
  readonly space: SpaceRef;
  readonly capturedRegion: Region<'logical'>;
  readonly bitmapSize: { readonly width: number; readonly height: number };
  readonly capturedAt?: number;
  readonly sequence?: number;
}): CaptureFrameGeometry {
  assertCurrentSpace(input.capturedRegion.space, input.space);
  const capturedAt = input.capturedAt ?? Date.now();
  const sequence = input.sequence ?? 0;
  if (!Number.isFinite(capturedAt) || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new AutomationGeometryError('INVALID_NUMBER', 'frame timestamp and sequence must be valid');
  }
  return Object.freeze({
    frameId: input.frameId,
    space: input.space,
    capturedRegion: input.capturedRegion,
    bitmapSize: size(input.bitmapSize.width, input.bitmapSize.height),
    capturedAt,
    sequence,
  });
}

function validateBitmapPoint(value: BitmapPoint, bitmapSize: Size, allowFarEdge = false): void {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)
    || value.x < 0 || value.y < 0
    || (allowFarEdge ? value.x > bitmapSize.width || value.y > bitmapSize.height
      : value.x >= bitmapSize.width || value.y >= bitmapSize.height)) {
    throw new AutomationGeometryError('INVALID_POINT', `bitmap point is outside the frame: ${String(value.x)},${String(value.y)}`);
  }
}

function validateBitmapRegion(value: BitmapRegion, bitmapSize: Size): void {
  if (![value.x, value.y, value.width, value.height].every(Number.isFinite)
    || value.x < 0 || value.y < 0 || value.width <= 0 || value.height <= 0
    || value.x + value.width > bitmapSize.width || value.y + value.height > bitmapSize.height) {
    throw new AutomationGeometryError('INVALID_REGION', 'bitmap region must be positive and inside the frame');
  }
}

export class AutomationFrameTransform {
  readonly frame: CaptureFrameGeometry;

  constructor(frame: CaptureFrameGeometry) {
    this.frame = frame;
  }

  assertCurrent(currentSpace: SpaceRef): void {
    assertCurrentSpace(this.frame.space, currentSpace);
  }

  bitmapPointToSpace(value: BitmapPoint): Point<'logical'> {
    validateBitmapPoint(value, this.frame.bitmapSize);
    return point('logical', this.frame.space,
      this.frame.capturedRegion.x + value.x * this.frame.capturedRegion.width / this.frame.bitmapSize.width,
      this.frame.capturedRegion.y + value.y * this.frame.capturedRegion.height / this.frame.bitmapSize.height);
  }

  bitmapRegionToSpace(value: BitmapRegion): Region<'logical'> {
    validateBitmapRegion(value, this.frame.bitmapSize);
    return region('logical', this.frame.space,
      this.frame.capturedRegion.x + value.x * this.frame.capturedRegion.width / this.frame.bitmapSize.width,
      this.frame.capturedRegion.y + value.y * this.frame.capturedRegion.height / this.frame.bitmapSize.height,
      value.width * this.frame.capturedRegion.width / this.frame.bitmapSize.width,
      value.height * this.frame.capturedRegion.height / this.frame.bitmapSize.height);
  }

  spacePointToBitmap(value: Point<'logical'>): BitmapPoint {
    assertCurrentSpace(value.space, this.frame.space);
    const x = (value.x - this.frame.capturedRegion.x) * this.frame.bitmapSize.width / this.frame.capturedRegion.width;
    const y = (value.y - this.frame.capturedRegion.y) * this.frame.bitmapSize.height / this.frame.capturedRegion.height;
    validateBitmapPoint({ x, y }, this.frame.bitmapSize);
    return Object.freeze({ x: finite(x, 'bitmap x'), y: finite(y, 'bitmap y') });
  }

  spaceRegionToBitmap(value: Region<'logical'>): BitmapRegion {
    assertCurrentSpace(value.space, this.frame.space);
    const converted = {
      x: (value.x - this.frame.capturedRegion.x) * this.frame.bitmapSize.width / this.frame.capturedRegion.width,
      y: (value.y - this.frame.capturedRegion.y) * this.frame.bitmapSize.height / this.frame.capturedRegion.height,
      width: value.width * this.frame.bitmapSize.width / this.frame.capturedRegion.width,
      height: value.height * this.frame.bitmapSize.height / this.frame.capturedRegion.height,
    };
    validateBitmapRegion(converted, this.frame.bitmapSize);
    return Object.freeze(converted);
  }

  matchCenterToSpace(match: BitmapRegion, offset: { readonly x?: number; readonly y?: number } = {}): Point<'logical'> {
    validateBitmapRegion(match, this.frame.bitmapSize);
    const center = {
      x: match.x + match.width / 2,
      y: match.y + match.height / 2,
    };
    // A match may end exactly at the bitmap far edge, but its positive-size
    // center always remains strictly inside the frame.
    validateBitmapPoint(center, this.frame.bitmapSize, true);
    const value = this.bitmapPointToSpace(center);
    return point('logical', value.space,
      value.x + finite(offset.x ?? 0, 'offset x'),
      value.y + finite(offset.y ?? 0, 'offset y'));
  }
}
