import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationCapturedFrame } from '../src/main/modules/automation/browserview-driver';
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
      scales: [1],
      mask: 'none' as const,
    };
    const first = await matcher.find('button.png', captured, options, signal);
    const second = await matcher.find('button.png', captured, options, signal);
    expect(first).toMatchObject({ x, y, width: templateWidth, height: templateHeight, scale: 1, masked: false });
    expect(first!.score).toBeGreaterThan(0.99);
    expect(second).toMatchObject({ x, y });
    expect(source.load).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('uses PNG alpha as a template mask', async () => {
    const sceneWidth = 70, sceneHeight = 55, targetX = 28, targetY = 19;
    const scene = patterned(sceneWidth, sceneHeight);
    const templateWidth = 12, templateHeight = 12;
    const template = patterned(templateWidth, templateHeight, 991);
    for (let y = 0; y < templateHeight; y += 1) {
      for (let x = 0; x < templateWidth; x += 1) {
        const alpha = x >= 3 && x < 9 && y >= 3 && y < 9 ? 255 : 0;
        template[(y * templateWidth + x) * 4 + 3] = alpha;
        if (alpha) {
          const source = (y * templateWidth + x) * 4;
          const destination = ((targetY + y) * sceneWidth + targetX + x) * 4;
          scene.set(template.subarray(source, source + 3), destination);
        }
      }
    }
    const { matcher } = matcherFor({ cacheKey: 'masked@1', width: templateWidth, height: templateHeight, bgra: template });
    const result = await matcher.find('masked.png', frame(scene, sceneWidth, sceneHeight), {
      threshold: 0.98, scales: [1], mask: 'alpha',
    }, new AbortController().signal);
    expect(result).toMatchObject({ x: targetX, y: targetY, width: templateWidth, height: templateHeight, masked: true });
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
      threshold: 0.6,
      region: { x: 25, y: 15, width: 35, height: 30 },
      scales: [0.75, 1, 1.5],
      mask: 'none',
    }, new AbortController().signal);
    expect(result).toMatchObject({ x: targetX, y: targetY, width: 15, height: 12, scale: 1.5 });
    expect(result!.score).toBeGreaterThan(0.6);
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
    expect(result).toMatchObject({ x: targetX, y: targetY, lowVariance: true });
    expect(result!.templateStdDev).toBeLessThan(4);
    expect(result!.score).toBeGreaterThan(0.99);
  }, 30_000);
});
