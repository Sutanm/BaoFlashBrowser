import type { BgraImage } from './color-point-matcher';

export type BgrColor = readonly [number, number, number];

export type ColorColumnTrackerOptions = {
  readonly colors: readonly BgrColor[];
  readonly expectedX: number;
  readonly xRadius?: number;
  readonly region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly tolerance?: number;
  readonly minimumPixels?: number;
  readonly maximumRowGap?: number;
  readonly maximumFrameJump?: number;
  readonly reacquireAfterMisses?: number;
};

export type ColorColumnSignal = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly bottomY: number;
  readonly pixels: number;
};

function distance(pixels: Uint8Array, offset: number, color: BgrColor): number {
  return Math.abs(pixels[offset] - color[0])
    + Math.abs(pixels[offset + 1] - color[1])
    + Math.abs(pixels[offset + 2] - color[2]);
}

function boundedRegion(frame: BgraImage, region: ColorColumnTrackerOptions['region']) {
  const x = Math.max(0, Math.floor(region.x));
  const y = Math.max(0, Math.floor(region.y));
  const right = Math.min(frame.width, Math.ceil(region.x + region.width));
  const bottom = Math.min(frame.height, Math.ceil(region.y + region.height));
  if (right <= x || bottom <= y) throw new Error('color column region is outside the frame');
  return { x, y, right, bottom };
}

export function findColorColumnSignals(
  frame: BgraImage,
  options: ColorColumnTrackerOptions,
): ColorColumnSignal[] {
  if (frame.pixels.byteLength !== frame.width * frame.height * 4) throw new Error('frame BGRA byte length does not match dimensions');
  if (options.colors.length === 0) throw new Error('color column tracker requires at least one color');
  const bounds = boundedRegion(frame, options.region);
  const radius = Math.max(0, Math.floor(options.xRadius ?? 6));
  const left = Math.max(bounds.x, Math.round(options.expectedX) - radius);
  const right = Math.min(bounds.right, Math.round(options.expectedX) + radius + 1);
  const tolerance = Math.max(0, options.tolerance ?? 52);
  const minimumPixels = Math.max(1, Math.floor(options.minimumPixels ?? 4));
  const maximumRowGap = Math.max(0, Math.floor(options.maximumRowGap ?? 2));
  const rows: Array<{ y: number; points: number[] }> = [];
  for (let y = bounds.y; y < bounds.bottom; y += 1) {
    const points: number[] = [];
    for (let x = left; x < right; x += 1) {
      const offset = (y * frame.width + x) * 4;
      if (options.colors.some((color) => distance(frame.pixels, offset, color) <= tolerance)) points.push(x);
    }
    if (points.length > 0) rows.push({ y, points });
  }

  const groups: typeof rows[] = [];
  for (const row of rows) {
    const previous = groups[groups.length - 1]?.at(-1);
    if (!previous || row.y - previous.y > maximumRowGap + 1) groups.push([row]);
    else groups[groups.length - 1].push(row);
  }
  return groups.map((group): ColorColumnSignal => {
    const xs = group.flatMap((row) => row.points);
    const pixels = xs.length;
    const minimumX = Math.min(...xs); const maximumX = Math.max(...xs);
    const minimumY = group[0].y; const maximumY = group[group.length - 1].y;
    const weightedY = group.reduce((sum, row) => sum + row.y * row.points.length, 0);
    return {
      x: minimumX,
      y: minimumY,
      width: maximumX - minimumX + 1,
      height: maximumY - minimumY + 1,
      centerX: xs.reduce((sum, x) => sum + x, 0) / pixels,
      centerY: weightedY / pixels,
      bottomY: maximumY,
      pixels,
    };
  }).filter((signal) => signal.pixels >= minimumPixels)
    .sort((leftSignal, rightSignal) => rightSignal.pixels - leftSignal.pixels);
}

/** Tracks the vertical movement of a color signal whose horizontal column is stable. */
export class ColorColumnTracker {
  private previous?: ColorColumnSignal;
  private misses = 0;

  constructor(private readonly options: ColorColumnTrackerOptions) {}

  reset(): void { this.previous = undefined; this.misses = 0; }

  match(frame: BgraImage): ColorColumnSignal | undefined {
    const candidates = findColorColumnSignals(frame, this.options);
    if (candidates.length === 0) {
      this.misses += 1;
      if (this.misses >= Math.max(1, this.options.reacquireAfterMisses ?? 2)) this.previous = undefined;
      return undefined;
    }
    if (!this.previous) { this.misses = 0; return (this.previous = candidates[0]); }
    const maximumJump = Math.max(1, this.options.maximumFrameJump ?? 18);
    const nearby = candidates
      .filter((candidate) => Math.abs(candidate.centerY - this.previous!.centerY) <= maximumJump)
      .sort((left, right) => Math.abs(left.centerY - this.previous!.centerY) - Math.abs(right.centerY - this.previous!.centerY));
    if (nearby[0]) { this.misses = 0; return (this.previous = nearby[0]); }
    this.misses += 1;
    if (this.misses < Math.max(1, this.options.reacquireAfterMisses ?? 2)) return undefined;
    this.misses = 0;
    return (this.previous = candidates[0]);
  }
}
