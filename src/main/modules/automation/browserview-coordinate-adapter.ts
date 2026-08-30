import {
  AutomationGeometryError,
  type IntegerRect,
  type Point,
  type Region,
  type Size,
  type ViewportSpaceRef,
  assertCurrentSpace,
  coverRegionForIntegerBoundary,
  finite,
  intersectRegions,
  point,
  region,
  size,
} from '../../../shared/automation/core/geometry';

export type BrowserViewViewportTransform = {
  readonly space: ViewportSpaceRef;
  readonly logicalSize: Size;
  readonly displaySize: Size;
  readonly scaleX: number;
  readonly scaleY: number;
};

export function browserViewViewportTransform(input: {
  readonly space: ViewportSpaceRef;
  readonly logicalSize: { readonly width: number; readonly height: number };
  readonly displaySize: { readonly width: number; readonly height: number };
}): BrowserViewViewportTransform {
  const logicalSize = size(input.logicalSize.width, input.logicalSize.height);
  const displaySize = size(input.displaySize.width, input.displaySize.height);
  return Object.freeze({
    space: input.space,
    logicalSize,
    displaySize,
    scaleX: finite(displaySize.width / logicalSize.width, 'scaleX'),
    scaleY: finite(displaySize.height / logicalSize.height, 'scaleY'),
  });
}

export class BrowserViewCoordinateAdapter {
  private readonly transformSource: BrowserViewViewportTransform | (() => BrowserViewViewportTransform);

  constructor(transform: BrowserViewViewportTransform | (() => BrowserViewViewportTransform)) {
    this.transformSource = transform;
  }

  get transform(): BrowserViewViewportTransform {
    return typeof this.transformSource === 'function' ? this.transformSource() : this.transformSource;
  }

  logicalPointToDisplay(value: Point<'logical'>): { readonly x: number; readonly y: number } {
    this.assertViewportSpace(value.space);
    if (value.x < 0 || value.y < 0 || value.x >= this.transform.logicalSize.width || value.y >= this.transform.logicalSize.height) {
      throw new AutomationGeometryError('INVALID_POINT', `logical input point is outside the viewport: ${value.x},${value.y}`);
    }
    return Object.freeze({
      x: finite(value.x * this.transform.scaleX, 'display x'),
      y: finite(value.y * this.transform.scaleY, 'display y'),
    });
  }

  logicalRegionToDisplayCapture(value: Region<'logical'>): IntegerRect {
    this.assertViewportSpace(value.space);
    const viewportBounds = region('logical', this.transform.space, 0, 0,
      this.transform.logicalSize.width, this.transform.logicalSize.height);
    const clipped = intersectRegions(value, viewportBounds);
    if (!clipped) throw new AutomationGeometryError('INVALID_REGION', 'capture region does not overlap the viewport');
    const covered = coverRegionForIntegerBoundary({
      x: clipped.x * this.transform.scaleX,
      y: clipped.y * this.transform.scaleY,
      width: clipped.width * this.transform.scaleX,
      height: clipped.height * this.transform.scaleY,
    });
    const right = Math.min(Math.ceil(this.transform.displaySize.width), covered.x + covered.width);
    const bottom = Math.min(Math.ceil(this.transform.displaySize.height), covered.y + covered.height);
    const x = Math.max(0, covered.x);
    const y = Math.max(0, covered.y);
    if (right <= x || bottom <= y) throw new AutomationGeometryError('INVALID_REGION', 'rounded capture region is empty');
    return Object.freeze({ x, y, width: right - x, height: bottom - y });
  }

  displayPointToLogical(value: { readonly x: number; readonly y: number }): Point<'logical'> {
    return point('logical', this.transform.space,
      finite(value.x, 'display x') / this.transform.scaleX,
      finite(value.y, 'display y') / this.transform.scaleY);
  }

  displayRegionToLogical(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): Region<'logical'> {
    const display = region('logical', this.transform.space, value.x, value.y, value.width, value.height);
    const logical = region('logical', this.transform.space,
      display.x / this.transform.scaleX,
      display.y / this.transform.scaleY,
      display.width / this.transform.scaleX,
      display.height / this.transform.scaleY);
    const viewportBounds = region('logical', this.transform.space, 0, 0,
      this.transform.logicalSize.width, this.transform.logicalSize.height);
    const clipped = intersectRegions(logical, viewportBounds);
    if (!clipped) throw new AutomationGeometryError('INVALID_REGION', 'display region does not overlap the logical viewport');
    return clipped;
  }

  sourceViewportRegionToLogical(value: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }, sourceViewport: { readonly width: number; readonly height: number }): Region<'logical'> {
    const source = size(sourceViewport.width, sourceViewport.height);
    return this.displayRegionToLogical({
      x: value.x * this.transform.displaySize.width / source.width,
      y: value.y * this.transform.displaySize.height / source.height,
      width: value.width * this.transform.displaySize.width / source.width,
      height: value.height * this.transform.displaySize.height / source.height,
    });
  }

  private assertViewportSpace(space: ViewportSpaceRef | Region['space']): void {
    if (space.kind !== 'viewport') throw new AutomationGeometryError('SPACE_MISMATCH', 'BrowserView adapter requires ViewportSpace geometry');
    assertCurrentSpace(space, this.transform.space);
  }
}
