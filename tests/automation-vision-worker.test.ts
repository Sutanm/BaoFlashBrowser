import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationCapturedFrame } from '../src/main/modules/automation/capability-contracts';
import { AutomationVisionService } from '../src/main/modules/automation/vision-service';
import {
  OpenCvWorkerMatcher,
  CachingAutomationTemplateProvider,
  type AutomationTemplatePixels,
  type AutomationTemplateProvider,
} from '../src/main/modules/automation/vision-worker-matcher';

const workers: OpenCvWorkerMatcher[] = [];

function patterned(width: number, height: number, seed = 1): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const hash = (Math.imul(x + seed, 1103515245) ^ Math.imul(y + seed * 3, 12345)) >>> 0;
      pixels[index] = hash & 255;
      pixels[index + 1] = (hash >>> 8) & 255;
      pixels[index + 2] = (hash >>> 16) & 255;
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

function crop(source: Uint8Array, sourceWidth: number, x: number, y: number, width: number, height: number): Uint8Array {
  const result = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((y + row) * sourceWidth + x) * 4;
    result.set(source.subarray(from, from + width * 4), row * width * 4);
  }
  return result;
}

function pasteNearest(
  destination: Uint8Array,
  destinationWidth: number,
  source: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  x: number,
  y: number,
  scale: number,
): void {
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);
  for (let row = 0; row < height; row += 1) {
    for (let column = 0; column < width; column += 1) {
      const sourceX = Math.min(sourceWidth - 1, Math.floor(column / scale));
      const sourceY = Math.min(sourceHeight - 1, Math.floor(row / scale));
      const from = (sourceY * sourceWidth + sourceX) * 4;
      const to = ((y + row) * destinationWidth + x + column) * 4;
      destination.set(source.subarray(from, from + 4), to);
    }
  }
}

function frame(pixels: Uint8Array, width: number, height: number, cssWidth = width, cssHeight = height): AutomationCapturedFrame {
  return {
    deviceSize: { width, height }, cssSize: { width: cssWidth, height: cssHeight },
    image: {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toBitmap: () => Buffer.from(pixels),
      toPNG: () => Buffer.alloc(0),
    },
  };
}

function matcherFor(template: AutomationTemplatePixels): { matcher: OpenCvWorkerMatcher; provider: AutomationTemplateProvider; source: AutomationTemplateProvider } {
  const source: AutomationTemplateProvider = { load: vi.fn(async () => template) };
  const provider = new CachingAutomationTemplateProvider(source, 4);
  const matcher = new OpenCvWorkerMatcher(provider, {
    workerPath: path.resolve('src/main/modules/automation/vision-worker.cjs'),
    requestTimeoutMs: 20_000,
    maxCacheEntries: 4,
    maxCacheBytes: 4 * 1024 * 1024,
  });
  workers.push(matcher);
  return { matcher, provider, source };
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
});

describe('OpenCV automation vision worker', () => {
  it('warms up the worker without loading a template or running a match', async () => {
    const { matcher, source } = matcherFor({ cacheKey: 'warmup@1', width: 1, height: 1, bgra: new Uint8Array([0, 0, 0, 255]) });
    await expect(matcher.warmup(new AbortController().signal)).resolves.toBeUndefined();
    expect(source.load).not.toHaveBeenCalled();
  }, 30_000);

  it('wakes promptly after being idle', async () => {
    const width = 64, height = 48, x = 22, y = 17, templateWidth = 10, templateHeight = 8;
    const scene = patterned(width, height, 72);
    const template = crop(scene, width, x, y, templateWidth, templateHeight);
    const { matcher } = matcherFor({ cacheKey: 'idle@1', width: templateWidth, height: templateHeight, bgra: template });
    await matcher.warmup(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const startedAt = Date.now();
    const result = await matcher.find('idle.png', frame(scene, width, height), {
      threshold: 0.99, scales: [1], mask: 'none',
    }, new AbortController().signal);
    expect(result).toMatchObject({ x, y });
    expect(Date.now() - startedAt).toBeLessThan(1000);
  }, 30_000);

  it('queues concurrent requests before they reach the single-channel worker', async () => {
    const width = 70, height = 52, x = 27, y = 19, templateWidth = 10, templateHeight = 8;
    const scene = patterned(width, height, 811);
    const template = crop(scene, width, x, y, templateWidth, templateHeight);
    const { matcher } = matcherFor({ cacheKey: 'queued@1', width: templateWidth, height: templateHeight, bgra: template });
    const service = new AutomationVisionService(matcher);
    const captured = frame(scene, width, height);
    const [first, second] = await Promise.all([
      service.locate(captured, { assets: ['queued.png'], threshold: .99, scales: [1], mask: 'none' }, new AbortController().signal),
      service.locate(captured, { assets: ['queued.png'], threshold: .99, scales: [1], mask: 'none' }, new AbortController().signal),
    ]);

    expect(first).toMatchObject({ x, y, queueDepthAtSubmit: 0 });
    expect(second).toMatchObject({ x, y, queueDepthAtSubmit: 1 });
    expect(second!.queueWaitMs).toBeGreaterThan(0);
  }, 30_000);

  it('returns no match when a search region cannot contain the template', async () => {
    const scene = patterned(40, 30, 14);
    const template = patterned(16, 12, 99);
    const { matcher } = matcherFor({ cacheKey: 'too-large@1', width: 16, height: 12, bgra: template });
    await expect(matcher.find('too-large.png', frame(scene, 40, 30), {
      threshold: 0.9,
      region: { x: 5, y: 5, width: 8, height: 6 },
      scales: [0.75, 1, 1.25],
      mask: 'none',
    }, new AbortController().signal)).resolves.toBeNull();
  }, 30_000);

  it('finds an exact template inside a CSS-defined ROI and reuses the worker cache', async () => {
    const width = 96, height = 72, x = 41, y = 29, templateWidth = 14, templateHeight = 11;
    const scene = patterned(width, height);
    const template = crop(scene, width, x, y, templateWidth, templateHeight);
    const { matcher, source } = matcherFor({ cacheKey: 'button@1', width: templateWidth, height: templateHeight, bgra: template });
    const captured = frame(scene, width, height, width / 1.5, height / 1.5);
    const signal = new AbortController().signal;
    const options = {
      threshold: 0.99,
      region: { x: 20, y: 12, width: 35, height: 30 },
      scales: [0.75, 1, 1.25],
      mask: 'auto' as const,
    };
    const first = await matcher.find('button.png', captured, options, signal);
    const second = await matcher.find('button.png', captured, options, signal);
    expect(first).toMatchObject({ x, y, width: templateWidth, height: templateHeight, scale: 1, masked: false, algorithm: 'ccoeff' });
    expect(first!.score).toBeGreaterThan(0.99);
    expect(first!.testedScales).toEqual([1]);
    expect(first!.sceneBytes).toBeLessThan(scene.byteLength);
    expect(first!.wasmHeapBytes).toBeGreaterThan(0);
    expect(first!.templateCacheEntries).toBe(1);
    expect(second).toMatchObject({ x, y });
    expect(source.load).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('reuses scaled grayscale templates and masks across frames', async () => {
    const width = 160, height = 120, x = 52, y = 38, templateWidth = 32, templateHeight = 24;
    const scene = patterned(width, height, 817);
    const template = crop(scene, width, x, y, templateWidth, templateHeight);
    const { matcher, source } = matcherFor({ cacheKey: 'scaled-cache@1', width: templateWidth, height: templateHeight, bgra: template });
    const signal = new AbortController().signal;
    const options = { threshold: -1, scales: [0.75, 1.25], mask: 'auto' as const };
    const captured = frame(scene, width, height);
    captured.frameId = 101;
    const first = await matcher.find('scaled.png', captured, options, signal);
    const second = await matcher.find('scaled.png', captured, options, signal);
    expect(first).toMatchObject({ scaledTemplateCacheHits: 0, scaledTemplateCacheMisses: 2 });
    expect(second).toMatchObject({ scaledTemplateCacheHits: 2, scaledTemplateCacheMisses: 0 });
    expect(second!.templateCacheBytes).toBe(first!.templateCacheBytes);
    expect(first!.sceneTransferBytes).toBe(scene.byteLength);
    expect(second!.sceneTransferBytes).toBe(0);
    expect(second!.sceneMatMs).toBe(0);
    expect(second!.grayMs).toBe(0);
    expect(second!.scaleMatchTimings).toEqual([
      expect.objectContaining({ scale: 0.75, operations: 1 }),
      expect.objectContaining({ scale: 1.25, operations: 1 }),
    ]);
    expect(second!.scaleMatchTimings!.every((timing) => timing.matchTemplateMs > 0)).toBe(true);
    expect(second!.assetMatchTimings).toEqual([
      expect.objectContaining({ asset: 'scaled.png', operations: 2 }),
    ]);
    expect(source.load).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('returns a region-local match when the capture carries a source-region origin', async () => {
    const width = 48, height = 36, localX = 17, localY = 13, templateWidth = 9, templateHeight = 7;
    const scene = patterned(width, height, 33);
    const template = crop(scene, width, localX, localY, templateWidth, templateHeight);
    const { matcher } = matcherFor({ cacheKey: 'region-origin@1', width: templateWidth, height: templateHeight, bgra: template });
    const captured = frame(scene, width, height, 96, 72);
    captured.bitmapSize = { width, height };
    // A directly-captured source region: the match location lives in the region's
    // bitmap pixel space, so the matcher must NOT fold a raw logical origin into
    // it (that would make the clickable point drift). The driver adds the origin.
    captured.deviceOrigin = { x: 120, y: 80 };
    captured.deviceSize = { width: 320, height: 240 };
    const result = await matcher.find('button.png', captured, {
      threshold: 0.99, scales: [1], mask: 'none',
    }, new AbortController().signal);

    expect(result).toMatchObject({ x: localX, y: localY });
  }, 30_000);

  it('matches multiple templates against one scene request and returns the best asset', async () => {
    const width = 96, height = 72, x = 41, y = 29, templateWidth = 14, templateHeight = 11;
    const scene = patterned(width, height);
    const matching = crop(scene, width, x, y, templateWidth, templateHeight);
    const missing = patterned(templateWidth, templateHeight, 991);
    const source: AutomationTemplateProvider = {
      load: vi.fn(async (asset: string) => ({
        cacheKey: `${asset}@1`, width: templateWidth, height: templateHeight,
        bgra: asset === 'matching.png' ? matching : missing,
      })),
    };
    const matcher = new OpenCvWorkerMatcher(new CachingAutomationTemplateProvider(source, 4), {
      workerPath: path.resolve('src/main/modules/automation/vision-worker.cjs'),
      requestTimeoutMs: 20_000,
      maxCacheEntries: 4,
      maxCacheBytes: 4 * 1024 * 1024,
    });
    workers.push(matcher);
    const result = await matcher.findMany(['missing.png', 'matching.png'], frame(scene, width, height), {
      threshold: 0.9, scales: [1], mask: 'none',
    }, new AbortController().signal);

    expect(result).toMatchObject({ asset: 'matching.png', x, y, width: templateWidth, height: templateHeight });
    expect(source.load).toHaveBeenCalledTimes(2);
  }, 30_000);

  it('returns repeated template instances in stable visual order', async () => {
    const width = 120, height = 90, templateWidth = 13, templateHeight = 10;
    const scene = patterned(width, height, 51);
    const template = patterned(templateWidth, templateHeight, 1201);
    const positions = [{ x: 71, y: 52 }, { x: 9, y: 14 }, { x: 68, y: 14 }];
    for (const position of positions) {
      pasteNearest(scene, width, template, templateWidth, templateHeight, position.x, position.y, 1);
    }
    const { matcher } = matcherFor({ cacheKey: 'repeated@1', width: templateWidth, height: templateHeight, bgra: template });
    const results = await matcher.findCandidates!('repeated.png', frame(scene, width, height), {
      threshold: 0.99, scales: [1], mask: 'none', maxCandidates: 10,
    }, new AbortController().signal);

    expect(results).toHaveLength(3);
    expect(results.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 9, y: 14 }, { x: 68, y: 14 }, { x: 71, y: 52 },
    ]);
    expect(results.every((result) => result.score > 0.99)).toBe(true);
    expect(results[0].rawCandidateCount).toBeGreaterThanOrEqual(3);
    expect(results[0].nmsCandidateCount).toBe(3);
  }, 30_000);

  it('suppresses duplicate boxes produced by equivalent template scales', async () => {
    const width = 90, height = 65, x = 31, y = 22, templateWidth = 12, templateHeight = 9;
    const scene = patterned(width, height, 72);
    const template = patterned(templateWidth, templateHeight, 914);
    pasteNearest(scene, width, template, templateWidth, templateHeight, x, y, 1);
    const { matcher } = matcherFor({ cacheKey: 'nms@1', width: templateWidth, height: templateHeight, bgra: template });
    const results = await matcher.findCandidates!('nms.png', frame(scene, width, height), {
      threshold: 0.99, scales: [1, 1.01], mask: 'none', maxCandidates: 10,
    }, new AbortController().signal);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ x, y });
    expect(results[0].rawCandidateCount).toBeGreaterThanOrEqual(2);
    expect(results[0].nmsCandidateCount).toBe(1);
  }, 30_000);

  it('returns candidates from every matching asset in an image group', async () => {
    const width = 110, height = 75, templateWidth = 11, templateHeight = 8;
    const scene = patterned(width, height, 85);
    const first = patterned(templateWidth, templateHeight, 1501);
    const second = patterned(templateWidth, templateHeight, 1703);
    pasteNearest(scene, width, first, templateWidth, templateHeight, 12, 16, 1);
    pasteNearest(scene, width, second, templateWidth, templateHeight, 73, 43, 1);
    const source: AutomationTemplateProvider = {
      load: vi.fn(async (asset: string) => ({
        cacheKey: `${asset}@1`, width: templateWidth, height: templateHeight,
        bgra: asset === 'first.png' ? first : second,
      })),
    };
    const matcher = new OpenCvWorkerMatcher(new CachingAutomationTemplateProvider(source, 4), {
      workerPath: path.resolve('src/main/modules/automation/vision-worker.cjs'),
      requestTimeoutMs: 20_000,
      maxCacheEntries: 4,
      maxCacheBytes: 4 * 1024 * 1024,
    });
    workers.push(matcher);
    const results = await matcher.findManyCandidates!(['second.png', 'first.png'], frame(scene, width, height), {
      threshold: 0.99, scales: [1], mask: 'none', maxCandidates: 10,
    }, new AbortController().signal);

    expect(results.map(({ asset, x, y }) => ({ asset, x, y }))).toEqual([
      { asset: 'first.png', x: 12, y: 16 },
      { asset: 'second.png', x: 73, y: 43 },
    ]);
  }, 30_000);

  it('automatically uses PNG alpha as a template mask', async () => {
    const sceneWidth = 70, sceneHeight = 55, targetX = 28, targetY = 19;
    const scene = patterned(sceneWidth, sceneHeight);
    const templateWidth = 12, templateHeight = 12;
    const template = patterned(templateWidth, templateHeight, 991);
    for (let y = 0; y < templateHeight; y += 1) {
      for (let x = 0; x < templateWidth; x += 1) {
        const inCore = x >= 3 && x < 9 && y >= 3 && y < 9;
        const inSoftEdge = x >= 2 && x < 10 && y >= 2 && y < 10;
        const alpha = inCore ? 255 : inSoftEdge ? 96 : 0;
        template[(y * templateWidth + x) * 4 + 3] = alpha;
        if (inCore) {
          const source = (y * templateWidth + x) * 4;
          const destination = ((targetY + y) * sceneWidth + targetX + x) * 4;
          scene.set(template.subarray(source, source + 3), destination);
        }
      }
    }
    const { matcher } = matcherFor({ cacheKey: 'masked@1', width: templateWidth, height: templateHeight, bgra: template });
    const result = await matcher.find('masked.png', frame(scene, sceneWidth, sceneHeight), {
      threshold: 0.98, scales: [1], mask: 'auto',
    }, new AbortController().signal);
    expect(result).toMatchObject({ x: targetX, y: targetY, width: templateWidth, height: templateHeight, masked: true, algorithm: 'ccorr-mask' });
    expect(result!.score).toBeGreaterThan(0.98);
  }, 30_000);

  it('selects the best scale from a bounded multi-scale search', async () => {
    const sceneWidth = 90, sceneHeight = 65, targetX = 34, targetY = 23;
    const templateWidth = 10, templateHeight = 8;
    const scene = patterned(sceneWidth, sceneHeight, 17);
    const template = patterned(templateWidth, templateHeight, 773);
    pasteNearest(scene, sceneWidth, template, templateWidth, templateHeight, targetX, targetY, 1.5);
    const { matcher } = matcherFor({ cacheKey: 'scaled@1', width: templateWidth, height: templateHeight, bgra: template });
    const result = await matcher.find('scaled.png', frame(scene, sceneWidth, sceneHeight), {
      threshold: 0.99,
      region: { x: 25, y: 15, width: 35, height: 30 },
      scales: [0.75, 1, 1.5, 2],
      mask: 'none',
    }, new AbortController().signal);
    expect(result).toMatchObject({
      x: targetX, y: targetY, width: 15, height: 12, scale: 1.5, upscaleInterpolation: 'nearest',
    });
    expect(result!.score).toBeGreaterThan(0.99);
    expect(result!.scaleMatchTimings?.map((timing) => timing.scale)).toEqual([1, 0.75, 1.5]);
  }, 30_000);

  it('uses normalized difference matching for a low-variance template', async () => {
    const width = 64, height = 48, targetX = 31, targetY = 17, templateWidth = 9, templateHeight = 7;
    const scene = patterned(width, height, 91);
    const template = new Uint8Array(templateWidth * templateHeight * 4);
    for (let index = 0; index < template.length; index += 4) {
      template[index] = 80; template[index + 1] = 80; template[index + 2] = 80; template[index + 3] = 255;
    }
    pasteNearest(scene, width, template, templateWidth, templateHeight, targetX, targetY, 1);
    const { matcher } = matcherFor({ cacheKey: 'solid@1', width: templateWidth, height: templateHeight, bgra: template });
    const result = await matcher.find('solid.png', frame(scene, width, height), {
      threshold: 0.99, scales: [1], mask: 'none',
    }, new AbortController().signal);
    expect(result).toMatchObject({ x: targetX, y: targetY, lowVariance: true, algorithm: 'sqdiff' });
    expect(result!.templateStdDev).toBeLessThan(4);
    expect(result!.score).toBeGreaterThan(0.99);
  }, 30_000);
});
