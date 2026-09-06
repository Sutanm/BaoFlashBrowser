import { performance } from 'perf_hooks';

export type RegionChangeReference = 'baseline' | 'previous';

export type RegionChangeSample = {
  readonly bitmap: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly captureMs?: number;
};

export type RegionChangeOptions = {
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly colorDelta: number;
  readonly minimumChangedPixels: number;
  readonly changedPixelRatio: number;
  readonly consecutiveFrames: number;
  readonly reference: RegionChangeReference;
};

export type RegionChangeResult = {
  readonly changed: boolean;
  readonly changedPixels: number;
  readonly totalPixels: number;
  readonly changedRatio: number;
  readonly maxChangedPixels: number;
  readonly maxChangedRatio: number;
  readonly samples: number;
  readonly elapsedMs: number;
  readonly captureMs: number;
};

export type RegionChangeDependencies = {
  readonly capture: () => Promise<RegionChangeSample>;
  readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
};

export type RegionColorOptions = {
  readonly colors: readonly { readonly red: number; readonly green: number; readonly blue: number }[];
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly tolerance: number;
  readonly minimumMatchingPixels: number;
  readonly consecutiveFrames: number;
};

export type RegionColorResult = {
  readonly found: boolean;
  readonly matchingPixels: number;
  readonly totalPixels: number;
  readonly matchingRatio: number;
  readonly maxMatchingPixels: number;
  readonly maxMatchingRatio: number;
  readonly samples: number;
  readonly elapsedMs: number;
  readonly captureMs: number;
  /** Bounds of all matching pixels, normalized to the observed region. */
  readonly matchBounds?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
};

export function compareRegionBitmaps(reference: RegionChangeSample, current: RegionChangeSample, colorDelta: number): { changedPixels: number; totalPixels: number; changedRatio: number } {
  if (reference.width !== current.width || reference.height !== current.height) throw new Error('captured region size changed while observing it');
  const totalPixels = reference.width * reference.height;
  const expectedBytes = totalPixels * 4;
  if (reference.bitmap.byteLength < expectedBytes || current.bitmap.byteLength < expectedBytes) throw new Error('captured region bitmap is incomplete');
  let changedPixels = 0;
  for (let offset = 0; offset < expectedBytes; offset += 4) {
    const blue = Math.abs(reference.bitmap[offset] - current.bitmap[offset]);
    const green = Math.abs(reference.bitmap[offset + 1] - current.bitmap[offset + 1]);
    const red = Math.abs(reference.bitmap[offset + 2] - current.bitmap[offset + 2]);
    if (Math.max(red, green, blue) >= colorDelta) changedPixels += 1;
  }
  return { changedPixels, totalPixels, changedRatio: totalPixels > 0 ? changedPixels / totalPixels : 0 };
}

export function countRegionColorPixels(sample: RegionChangeSample, colors: RegionColorOptions['colors'], tolerance: number): {
  matchingPixels: number;
  totalPixels: number;
  matchingRatio: number;
  matchBounds?: { x: number; y: number; width: number; height: number };
} {
  const totalPixels = sample.width * sample.height;
  const expectedBytes = totalPixels * 4;
  if (sample.bitmap.byteLength < expectedBytes) throw new Error('captured region bitmap is incomplete');
  let matchingPixels = 0;
  let minX = sample.width;
  let minY = sample.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < expectedBytes; offset += 4) {
    const blue = sample.bitmap[offset];
    const green = sample.bitmap[offset + 1];
    const red = sample.bitmap[offset + 2];
    if (colors.some((color) => Math.max(Math.abs(red - color.red), Math.abs(green - color.green), Math.abs(blue - color.blue)) <= tolerance)) {
      const pixel = offset / 4;
      const x = pixel % sample.width;
      const y = Math.floor(pixel / sample.width);
      matchingPixels += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    matchingPixels,
    totalPixels,
    matchingRatio: totalPixels > 0 ? matchingPixels / totalPixels : 0,
    ...(matchingPixels > 0 ? {
      matchBounds: {
        x: minX / sample.width,
        y: minY / sample.height,
        width: (maxX - minX + 1) / sample.width,
        height: (maxY - minY + 1) / sample.height,
      },
    } : {}),
  };
}

export async function waitForRegionChange(options: RegionChangeOptions, dependencies: RegionChangeDependencies, signal: AbortSignal): Promise<RegionChangeResult> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  let reference = await dependencies.capture();
  let captureMs = reference.captureMs ?? 0;
  let samples = 1;
  let consecutive = 0;
  let maxChangedPixels = 0;
  let maxChangedRatio = 0;
  let latest = { changedPixels: 0, totalPixels: reference.width * reference.height, changedRatio: 0 };

  while (now() - startedAt < options.timeoutMs) {
    if (signal.aborted) throw new Error('automation cancelled');
    const remainingMs = options.timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs), signal);
    const current = await dependencies.capture();
    captureMs += current.captureMs ?? 0;
    samples += 1;
    latest = compareRegionBitmaps(reference, current, options.colorDelta);
    maxChangedPixels = Math.max(maxChangedPixels, latest.changedPixels);
    maxChangedRatio = Math.max(maxChangedRatio, latest.changedRatio);
    const qualifies = latest.changedPixels >= options.minimumChangedPixels
      && latest.changedRatio >= options.changedPixelRatio;
    consecutive = qualifies ? consecutive + 1 : 0;
    if (consecutive >= options.consecutiveFrames) {
      return {
        changed: true, ...latest, maxChangedPixels, maxChangedRatio, samples,
        elapsedMs: now() - startedAt, captureMs,
      };
    }
    if (options.reference === 'previous') reference = current;
  }

  return {
    changed: false, ...latest, maxChangedPixels, maxChangedRatio, samples,
    elapsedMs: now() - startedAt, captureMs,
  };
}

export async function waitForRegionColor(options: RegionColorOptions, dependencies: RegionChangeDependencies, signal: AbortSignal): Promise<RegionColorResult> {
  const now = dependencies.now ?? (() => performance.now());
  const startedAt = now();
  let samples = 0;
  let consecutive = 0;
  let captureMs = 0;
  let maxMatchingPixels = 0;
  let maxMatchingRatio = 0;
  let latest = { matchingPixels: 0, totalPixels: 0, matchingRatio: 0 };
  while (now() - startedAt < options.timeoutMs) {
    if (signal.aborted) throw new Error('automation cancelled');
    const current = await dependencies.capture();
    captureMs += current.captureMs ?? 0;
    samples += 1;
    latest = countRegionColorPixels(current, options.colors, options.tolerance);
    maxMatchingPixels = Math.max(maxMatchingPixels, latest.matchingPixels);
    maxMatchingRatio = Math.max(maxMatchingRatio, latest.matchingRatio);
    consecutive = latest.matchingPixels >= options.minimumMatchingPixels ? consecutive + 1 : 0;
    if (consecutive >= options.consecutiveFrames) {
      return { found: true, ...latest, maxMatchingPixels, maxMatchingRatio, samples, elapsedMs: now() - startedAt, captureMs };
    }
    const remainingMs = options.timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await dependencies.sleep(Math.min(options.pollIntervalMs, remainingMs), signal);
  }
  return { found: false, ...latest, maxMatchingPixels, maxMatchingRatio, samples, elapsedMs: now() - startedAt, captureMs };
}
