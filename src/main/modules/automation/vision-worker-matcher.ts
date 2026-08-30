import path from 'path';
import { Worker } from 'worker_threads';
import type {
  AutomationCapabilityRegion,
  AutomationCapturedFrame,
  AutomationImageMask,
  AutomationVisionMatcher,
  ImageMatch,
} from './capability-contracts';

export type AutomationTemplatePixels = {
  cacheKey: string;
  width: number;
  height: number;
  bgra: Uint8Array;
};

export type AutomationTemplateProvider = {
  load(asset: string, signal: AbortSignal): Promise<AutomationTemplatePixels>;
};

export class CachingAutomationTemplateProvider implements AutomationTemplateProvider {
  private readonly source: AutomationTemplateProvider;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, AutomationTemplatePixels>();

  constructor(source: AutomationTemplateProvider, maxEntries = 64) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('template cache maxEntries must be a positive integer');
    this.source = source;
    this.maxEntries = maxEntries;
  }

  async load(asset: string, signal: AbortSignal): Promise<AutomationTemplatePixels> {
    const existing = this.cache.get(asset);
    if (existing) {
      this.cache.delete(asset);
      this.cache.set(asset, existing);
      return existing;
    }
    const loaded = await this.source.load(asset, signal);
    this.cache.set(asset, loaded);
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return loaded;
  }

  invalidate(asset?: string): void {
    if (asset === undefined) this.cache.clear();
    else this.cache.delete(asset);
  }
}

export type OpenCvWorkerMatcherOptions = {
  workerPath?: string;
  requestTimeoutMs?: number;
  maxCacheEntries?: number;
  maxCacheBytes?: number;
  maxSharedBytes?: number;
};

/**
 * worker_threads 的 `new Worker(path)` 无法直接读取 asar 归档内的脚本：
 * Electron 的 asar 集成只作用于主/渲染进程的 require 与 fs，Worker 入口文件
 * 必须指向真实文件系统。打包时通过 electron-builder 的 asarUnpack 把
 * vision-worker.cjs 释放到 `app.asar.unpacked/`，这里把 `__dirname` 拼出的
 * asar 路径改写到解包目录；开发模式下路径不含 `app.asar`，原样返回。
 */
function resolveVisionWorkerPath(): string {
  const candidate = path.join(__dirname, 'vision-worker.cjs');
  return candidate.replace(/([/\\])app\.asar\1/, '$1app.asar.unpacked$1');
}

type PendingRequest = {
  resolve(value: ImageMatch | null): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort(): void;
};

function cssRegionToDevice(
  region: AutomationCapabilityRegion | undefined,
  frame: AutomationCapturedFrame,
): AutomationCapabilityRegion | undefined {
  if (!region) return undefined;
  const scaleX = frame.deviceSize.width / frame.cssSize.width;
  const scaleY = frame.deviceSize.height / frame.cssSize.height;
  const x = Math.max(0, Math.floor(region.x * scaleX));
  const y = Math.max(0, Math.floor(region.y * scaleY));
  const right = Math.min(frame.deviceSize.width, Math.ceil((region.x + region.width) * scaleX));
  const bottom = Math.min(frame.deviceSize.height, Math.ceil((region.y + region.height) * scaleY));
  if (right <= x || bottom <= y) throw new Error('image search region is outside the captured frame');
  return { x, y, width: right - x, height: bottom - y };
}

function cropBgra(
  bytes: Uint8Array,
  sourceWidth: number,
  region: AutomationCapabilityRegion,
): Uint8Array {
  const result = new Uint8Array(region.width * region.height * 4);
  const rowBytes = region.width * 4;
  for (let row = 0; row < region.height; row += 1) {
    const sourceStart = ((region.y + row) * sourceWidth + region.x) * 4;
    result.set(bytes.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
  }
  return result;
}

export class OpenCvWorkerMatcher implements AutomationVisionMatcher {
  private readonly templates: AutomationTemplateProvider;
  private readonly options: Required<OpenCvWorkerMatcherOptions>;
  private worker: Worker | null = null;
  private sharedControl: Int32Array | null = null;
  private sharedData: Uint8Array | null = null;
  private workerReady: Promise<void> | null = null;
  private resolveWorkerReady: (() => void) | null = null;
  private rejectWorkerReady: ((error: Error) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly sentTemplates = new Set<string>();
  private sentFrameId: number | undefined;
  private lastStats: Partial<ImageMatch> = {};

  constructor(templates: AutomationTemplateProvider, options: OpenCvWorkerMatcherOptions = {}) {
    this.templates = templates;
    this.options = {
      workerPath: options.workerPath ?? resolveVisionWorkerPath(),
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      maxCacheEntries: options.maxCacheEntries ?? 32,
      maxCacheBytes: options.maxCacheBytes ?? 64 * 1024 * 1024,
      maxSharedBytes: options.maxSharedBytes ?? 64 * 1024 * 1024,
    };
  }

  async warmup(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    this.ensureWorker();
    await this.waitUntilWorkerReady(signal);
  }

  async find(
    asset: string,
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null> {
    return this.findMany([asset], frame, options, signal);
  }

  getStats(): Partial<ImageMatch> {
    return { ...this.lastStats };
  }

  async findMany(
    assets: string[],
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null> {
    if (signal.aborted) throw new Error('automation cancelled');
    const uniqueAssets = [...new Set(assets)];
    if (uniqueAssets.length === 0) throw new Error('at least one automation image asset is required');
    const templateLoadStartedAt = Date.now();
    const templates = await Promise.all(uniqueAssets.map(async (asset) => ({ asset, pixels: await this.templates.load(asset, signal) })));
    const templateLoadMs = Date.now() - templateLoadStartedAt;
    for (const template of templates) {
      if (template.pixels.width <= 0 || template.pixels.height <= 0
        || template.pixels.bgra.byteLength !== template.pixels.width * template.pixels.height * 4) {
        throw new Error(`invalid template pixels for ${template.asset}`);
      }
    }
    const bitmapSize = frame.bitmapSize ?? frame.deviceSize;
    const deviceOrigin = frame.deviceOrigin ?? { x: 0, y: 0 };
    const fullSceneBytes = frame.bitmap ?? frame.image.toBitmap();
    if (fullSceneBytes.byteLength !== bitmapSize.width * bitmapSize.height * 4) {
      throw new Error('captured BGRA byte length does not match frame dimensions');
    }
    const deviceRegion = cssRegionToDevice(options.region, frame);
    const sceneBytes = deviceRegion
      ? cropBgra(fullSceneBytes, bitmapSize.width, deviceRegion)
      : fullSceneBytes;
    // When the caller already narrowed the capture to a source region via
    // capturePage (findImage passes region: undefined), deviceOrigin holds the
    // region's LOGICAL offset but the matched location lives in the region's
    // bitmap pixel space. Do NOT fold a raw logical origin into the match here:
    // mixing the two coordinate spaces makes the clickable point drift outside
    // the surface. Report the match as region-local; the driver converts via the
    // region bitmap→logical scale and adds the logical offset itself. Full-page
    // matches (origin 0,0) are unaffected.
    const regionLocal = Boolean(deviceOrigin.x || deviceOrigin.y);
    const scene = deviceRegion
      ? {
        width: deviceRegion.width, height: deviceRegion.height,
        originX: deviceOrigin.x + deviceRegion.x, originY: deviceOrigin.y + deviceRegion.y,
      }
      : {
        width: bitmapSize.width, height: bitmapSize.height,
        originX: regionLocal ? 0 : deviceOrigin.x, originY: regionLocal ? 0 : deviceOrigin.y,
      };
    const reusableFrameId = deviceRegion ? undefined : frame.frameId;
    const reuseScene = reusableFrameId !== undefined && this.sentFrameId === reusableFrameId;
    const sceneTransferBytes = reuseScene ? new Uint8Array(0) : sceneBytes;
    const availableTemplateKeys = new Set(this.sentTemplates);
    const templatePayloads = templates.map(({ asset, pixels }) => {
      const include = !availableTemplateKeys.has(pixels.cacheKey);
      availableTemplateKeys.add(pixels.cacheKey);
      return { asset, pixels, include };
    });
    const id = this.nextId++;
    const workerReadyStartedAt = Date.now();
    this.ensureWorker();
    await this.waitUntilWorkerReady(signal);
    const workerReadyMs = Date.now() - workerReadyStartedAt;
    let sharedCopyMs = 0;

    const result = await new Promise<ImageMatch | null>((resolve, reject) => {
      const onAbort = (): void => this.restartWorker(new Error('automation cancelled'));
      const timer = setTimeout(() => {
        this.restartWorker(new Error(`OpenCV match timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      if (this.pending.size > 1) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('OpenCV matcher accepts one request at a time'));
        return;
      }
      let templateOffset = 0;
      const templateMetadata = templatePayloads.map(({ asset, pixels, include }) => {
        const byteLength = include ? pixels.bgra.byteLength : 0;
        const descriptor = {
          asset, cacheKey: pixels.cacheKey, width: pixels.width, height: pixels.height,
          byteOffset: templateOffset, byteLength,
        };
        templateOffset += byteLength;
        return descriptor;
      });
      const metadata = Buffer.from(JSON.stringify({
        id,
        scene: { ...scene, frameId: reusableFrameId ?? id, reuse: reuseScene },
        templates: templateMetadata,
        options: {
          threshold: options.threshold,
          scales: options.scales ?? [1],
          mask: options.mask ?? 'auto',
        },
      }), 'utf8');
      const control = this.sharedControl;
      const data = this.sharedData;
      if (!control || !data || Atomics.load(control, 0) !== 0) {
        this.restartWorker(new Error('OpenCV worker shared channel is busy'));
        return;
      }
      const totalBytes = metadata.byteLength + sceneTransferBytes.byteLength + templateOffset;
      if (totalBytes > data.byteLength) {
        this.restartWorker(new Error(`OpenCV request exceeds shared buffer budget: ${totalBytes} > ${data.byteLength}`));
        return;
      }
      const sharedCopyStartedAt = Date.now();
      data.set(metadata, 0);
      data.set(sceneTransferBytes, metadata.byteLength);
      const templateStart = metadata.byteLength + sceneTransferBytes.byteLength;
      for (let index = 0; index < templatePayloads.length; index += 1) {
        const payload = templatePayloads[index];
        if (!payload.include) continue;
        const descriptor = templateMetadata[index];
        data.set(payload.pixels.bgra, templateStart + descriptor.byteOffset);
        this.sentTemplates.add(payload.pixels.cacheKey);
      }
      sharedCopyMs = Date.now() - sharedCopyStartedAt;
      this.sentFrameId = reusableFrameId;
      Atomics.store(control, 1, id);
      Atomics.store(control, 2, metadata.byteLength);
      Atomics.store(control, 3, sceneTransferBytes.byteLength);
      Atomics.store(control, 4, templateOffset);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    });
    const requestStats = {
      templateLoadMs, workerReadyMs, sharedCopyMs,
      sceneBytes: sceneBytes.byteLength, sceneTransferBytes: sceneTransferBytes.byteLength,
    };
    this.lastStats = { ...this.lastStats, ...requestStats };
    return result ? { ...result, ...requestStats } : null;
  }

  async close(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    this.rejectWorkerReady?.(new Error('OpenCV matcher closed'));
    this.resolveWorkerReady = null;
    this.rejectWorkerReady = null;
    this.workerReady = null;
    this.rejectAll(new Error('OpenCV matcher closed'));
    this.sentTemplates.clear();
    this.sentFrameId = undefined;
    this.sharedControl = null;
    this.sharedData = null;
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    const dataBuffer = new SharedArrayBuffer(this.options.maxSharedBytes);
    this.sharedControl = new Int32Array(controlBuffer);
    this.sharedData = new Uint8Array(dataBuffer);
    const worker = new Worker(this.options.workerPath, {
      workerData: {
        maxCacheEntries: this.options.maxCacheEntries,
        maxCacheBytes: this.options.maxCacheBytes,
        controlBuffer,
        dataBuffer,
      },
    });
    worker.on('message', (value: unknown) => this.handleMessage(value));
    worker.on('error', (error) => this.restartWorker(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', (code) => {
      if (this.worker === worker && code !== 0) this.restartWorker(new Error(`OpenCV worker exited with code ${code}`));
    });
    this.worker = worker;
    this.workerReady = new Promise<void>((resolve, reject) => {
      this.resolveWorkerReady = resolve;
      this.rejectWorkerReady = reject;
    });
    return worker;
  }

  private async waitUntilWorkerReady(signal: AbortSignal): Promise<void> {
    const ready = this.workerReady;
    if (!ready) throw new Error('OpenCV worker was not created');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const guard = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`OpenCV worker startup timed out after ${this.options.requestTimeoutMs}ms`)), this.options.requestTimeoutMs);
      onAbort = () => reject(new Error('automation cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([ready, guard]);
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      this.restartWorker(reason);
      throw reason;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private handleMessage(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const message = value as { type?: string; id?: unknown; error?: unknown; match?: unknown; stats?: unknown };
    if (message.type === 'ready') {
      this.resolveWorkerReady?.();
      this.resolveWorkerReady = null;
      this.rejectWorkerReady = null;
      return;
    }
    if (message.type === 'startup-error') {
      this.restartWorker(new Error(typeof message.error === 'string' ? message.error : 'OpenCV worker startup failed'));
      return;
    }
    if ((message.type !== 'result' && message.type !== 'error') || typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.signal.removeEventListener('abort', pending.onAbort);
    if (message.type === 'error') pending.reject(new Error(typeof message.error === 'string' ? message.error : 'OpenCV worker error'));
    else {
      const match = (message.match as ImageMatch | null | undefined) ?? null;
      const stats = (message.stats as Partial<ImageMatch> | undefined) ?? {};
      this.lastStats = { ...this.lastStats, ...stats };
      pending.resolve(match ? { ...match, ...stats } : null);
    }
  }

  private restartWorker(reason: Error): void {
    const worker = this.worker;
    this.worker = null;
    this.sharedControl = null;
    this.sharedData = null;
    this.workerReady = null;
    this.rejectWorkerReady?.(reason);
    this.resolveWorkerReady = null;
    this.rejectWorkerReady = null;
    this.sentTemplates.clear();
    this.sentFrameId = undefined;
    this.rejectAll(reason);
    if (worker) void worker.terminate();
  }

  private rejectAll(reason: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal.removeEventListener('abort', pending.onAbort);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}
