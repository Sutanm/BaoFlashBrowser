import path from 'path';
import { Worker } from 'worker_threads';
import type { AutomationRegion } from '../../../shared/automation/types';
import type { ImageMatch } from './runtime';
import type {
  AutomationCapturedFrame,
  AutomationVisionMatcher,
} from './browserview-driver';

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

type PendingRequest = {
  resolve(value: ImageMatch | null): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort(): void;
};

function copyForTransfer(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(bytes);
}

function cssRegionToDevice(
  region: AutomationRegion | undefined,
  frame: AutomationCapturedFrame,
): AutomationRegion | undefined {
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

  constructor(templates: AutomationTemplateProvider, options: OpenCvWorkerMatcherOptions = {}) {
    this.templates = templates;
    this.options = {
      workerPath: options.workerPath ?? path.join(__dirname, 'vision-worker.cjs'),
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      maxCacheEntries: options.maxCacheEntries ?? 64,
      maxCacheBytes: options.maxCacheBytes ?? 128 * 1024 * 1024,
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
    options: { threshold: number; region?: AutomationRegion; scales?: number[]; mask?: 'none' | 'alpha' },
    signal: AbortSignal,
  ): Promise<ImageMatch | null> {
    if (signal.aborted) throw new Error('automation cancelled');
    const template = await this.templates.load(asset, signal);
    if (template.width <= 0 || template.height <= 0 || template.bgra.byteLength !== template.width * template.height * 4) {
      throw new Error(`invalid template pixels for ${asset}`);
    }
    const sceneBytes = copyForTransfer(frame.image.toBitmap());
    if (sceneBytes.byteLength !== frame.deviceSize.width * frame.deviceSize.height * 4) {
      throw new Error('captured BGRA byte length does not match frame dimensions');
    }
    const includeTemplate = !this.sentTemplates.has(template.cacheKey);
    const templateBytes = includeTemplate ? copyForTransfer(template.bgra) : undefined;
    const id = this.nextId++;
    this.ensureWorker();
    await this.waitUntilWorkerReady(signal);

    return new Promise<ImageMatch | null>((resolve, reject) => {
      const onAbort = (): void => this.restartWorker(new Error('automation cancelled'));
      const timer = setTimeout(() => {
        this.restartWorker(new Error(`OpenCV match timed out after ${this.options.requestTimeoutMs}ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      if (includeTemplate) this.sentTemplates.add(template.cacheKey);
      if (this.pending.size > 1) {
        this.pending.delete(id);
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('OpenCV matcher accepts one request at a time'));
        return;
      }
      const metadata = Buffer.from(JSON.stringify({
        id,
        scene: { width: frame.deviceSize.width, height: frame.deviceSize.height },
        template: {
          cacheKey: template.cacheKey, width: template.width, height: template.height,
        },
        options: {
          threshold: options.threshold,
          region: cssRegionToDevice(options.region, frame),
          scales: options.scales ?? [1],
          mask: options.mask ?? 'none',
        },
      }), 'utf8');
      const control = this.sharedControl;
      const data = this.sharedData;
      if (!control || !data || Atomics.load(control, 0) !== 0) {
        this.restartWorker(new Error('OpenCV worker shared channel is busy'));
        return;
      }
      const totalBytes = metadata.byteLength + sceneBytes.byteLength + (templateBytes?.byteLength ?? 0);
      if (totalBytes > data.byteLength) {
        this.restartWorker(new Error(`OpenCV request exceeds shared buffer budget: ${totalBytes} > ${data.byteLength}`));
        return;
      }
      data.set(metadata, 0);
      data.set(sceneBytes, metadata.byteLength);
      if (templateBytes) data.set(templateBytes, metadata.byteLength + sceneBytes.byteLength);
      Atomics.store(control, 1, id);
      Atomics.store(control, 2, metadata.byteLength);
      Atomics.store(control, 3, sceneBytes.byteLength);
      Atomics.store(control, 4, templateBytes?.byteLength ?? 0);
      Atomics.store(control, 0, 1);
      Atomics.notify(control, 0);
    });
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
    const message = value as { type?: string; id?: unknown; error?: unknown; match?: unknown };
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
    else pending.resolve((message.match as ImageMatch | null | undefined) ?? null);
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
