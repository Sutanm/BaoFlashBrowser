import path from 'path';
import { performance } from 'perf_hooks';
import { Worker } from 'worker_threads';
import type {
  AutomationCapabilityRegion,
  AutomationCapturedFrame,
  AutomationImageMask,
  AutomationVisionMatcher,
  ImageMatch,
} from './capability-contracts';
import type { AutomationTemplateProvider } from './vision-worker-matcher';

type Pending = {
  resolve(value: ColorPointSupportResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal: AbortSignal;
  onAbort(): void;
};

export type ColorPointSupportResult = {
  readonly matches: readonly ImageMatch[];
  readonly unsupportedAssets: readonly string[];
};

function resolveWorkerPath(): string {
  return path.join(__dirname, 'color-vision-worker.cjs').replace(/([/\\])app\.asar\1/, '$1app.asar.unpacked$1');
}

function cssRegionToDevice(region: AutomationCapabilityRegion | undefined, frame: AutomationCapturedFrame) {
  if (!region) return undefined;
  const scaleX = frame.deviceSize.width / frame.cssSize.width;
  const scaleY = frame.deviceSize.height / frame.cssSize.height;
  const x = Math.max(0, Math.floor(region.x * scaleX)); const y = Math.max(0, Math.floor(region.y * scaleY));
  const right = Math.min(frame.deviceSize.width, Math.ceil((region.x + region.width) * scaleX));
  const bottom = Math.min(frame.deviceSize.height, Math.ceil((region.y + region.height) * scaleY));
  if (right <= x || bottom <= y) throw new Error('color search region is outside the captured frame');
  return { x, y, width: right - x, height: bottom - y };
}

function crop(bytes: Uint8Array, sourceWidth: number, region: NonNullable<ReturnType<typeof cssRegionToDevice>>): Uint8Array {
  const result = new Uint8Array(region.width * region.height * 4); const rowBytes = region.width * 4;
  for (let row = 0; row < region.height; row += 1) {
    const start = ((region.y + row) * sourceWidth + region.x) * 4;
    result.set(bytes.subarray(start, start + rowBytes), row * rowBytes);
  }
  return result;
}

export class ColorPointWorkerMatcher implements AutomationVisionMatcher {
  private worker?: Worker;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sentTemplates = new Set<string>();
  private lastStats: Partial<ImageMatch> = {};

  constructor(
    private readonly templates: AutomationTemplateProvider,
    private readonly options: { readonly workerPath?: string; readonly requestTimeoutMs?: number } = {},
  ) {}

  async find(asset: string, frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask }, signal: AbortSignal) {
    return (await this.findCandidates(asset, frame, options, signal))[0] ?? null;
  }

  async findCandidates(asset: string, frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask; maxCandidates?: number }, signal: AbortSignal) {
    return this.findManyCandidates([asset], frame, options, signal);
  }

  async findMany(assets: string[], frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask }, signal: AbortSignal) {
    return (await this.findManyCandidates(assets, frame, options, signal))[0] ?? null;
  }

  async findManyCandidates(assets: string[], frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask; maxCandidates?: number }, signal: AbortSignal): Promise<readonly ImageMatch[]> {
    const result = await this.findManyCandidatesWithSupport(assets, frame, options, signal);
    if (result.unsupportedAssets.length === new Set(assets).size) {
      throw new Error('color image recognition does not support these assets');
    }
    return result.matches;
  }

  async findManyCandidatesWithSupport(assets: string[], frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask; maxCandidates?: number }, signal: AbortSignal): Promise<ColorPointSupportResult> {
    if (signal.aborted) throw new Error('automation cancelled');
    const uniqueAssets = [...new Set(assets)];
    if (uniqueAssets.length === 0) throw new Error('at least one automation image asset is required');
    const loadStarted = performance.now();
    const loaded = await Promise.all(uniqueAssets.map(async (asset) => ({ asset, pixels: await this.templates.load(asset, signal) })));
    const templateLoadMs = performance.now() - loadStarted;
    const bitmapSize = frame.bitmapSize ?? frame.deviceSize;
    const bytes = frame.bitmap ?? frame.image.toBitmap();
    if (bytes.byteLength !== bitmapSize.width * bitmapSize.height * 4) throw new Error('captured BGRA byte length does not match frame dimensions');
    const region = cssRegionToDevice(options.region, frame);
    const sceneBytes = region ? crop(bytes, bitmapSize.width, region) : Uint8Array.from(bytes);
    const originX = region?.x ?? 0; const originY = region?.y ?? 0;
    const worker = this.ensureWorker(); await this.waitReady(signal);
    const id = this.nextId++;
    const started = performance.now();
    const result = await new Promise<ColorPointSupportResult>((resolve, reject) => {
      const onAbort = () => this.restart(new Error('automation cancelled'));
      const timer = setTimeout(() => this.restart(new Error('color matching timed out')), this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      const templates = loaded.map(({ asset, pixels }) => {
        const include = !this.sentTemplates.has(pixels.cacheKey);
        if (include) this.sentTemplates.add(pixels.cacheKey);
        return { asset, cacheKey: pixels.cacheKey, width: pixels.width, height: pixels.height, ...(include ? { bgra: pixels.bgra } : {}) };
      });
      worker.postMessage({
        id,
        scene: { pixels: sceneBytes, width: region?.width ?? bitmapSize.width, height: region?.height ?? bitmapSize.height },
        templates,
        options: { threshold: options.threshold, scales: options.scales, maxCandidates: options.maxCandidates ?? 1 },
      });
    });
    const matchMs = performance.now() - started;
    this.lastStats = { templateLoadMs, matchMs, sceneBytes: sceneBytes.byteLength };
    const addOriginAndStats = (match: ImageMatch): ImageMatch => ({
      ...match, x: match.x + originX, y: match.y + originY,
      templateLoadMs, matchMs, sceneBytes: sceneBytes.byteLength,
    });
    return {
      unsupportedAssets: result.unsupportedAssets,
      matches: result.matches.map(addOriginAndStats),
    };
  }

  getStats(): Partial<ImageMatch> { return { ...this.lastStats }; }

  async warmup(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    this.ensureWorker();
    await this.waitReady(signal);
  }

  async close(): Promise<void> {
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    this.readyReject?.(new Error('color matcher closed')); this.readyReject = undefined; this.readyResolve = undefined;
    this.rejectAll(new Error('color matcher closed')); this.sentTemplates.clear();
    if (worker) await worker.terminate();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath ?? resolveWorkerPath());
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    worker.on('message', (message: { type?: string; id?: number; matches?: ImageMatch[]; unsupportedAssets?: string[]; error?: string }) => {
      if (message.type === 'ready') { this.readyResolve?.(); this.readyResolve = undefined; this.readyReject = undefined; return; }
      if (typeof message.id !== 'number') return;
      const pending = this.pending.get(message.id); if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.onAbort);
      if (message.type === 'error') pending.reject(new Error(message.error ?? 'color matching failed'));
      else pending.resolve({ matches: message.matches ?? [], unsupportedAssets: message.unsupportedAssets ?? [] });
    });
    worker.on('error', (error) => this.restart(error instanceof Error ? error : new Error(String(error))));
    worker.on('exit', (code) => { if (this.worker === worker && code !== 0) this.restart(new Error(`color worker exited with code ${code}`)); });
    return worker;
  }

  private async waitReady(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    const ready = this.ready;
    if (!ready) throw new Error('color matcher worker is not available');
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('color matcher worker startup timed out')),
        this.options.requestTimeoutMs ?? 15_000,
      );
      onAbort = () => reject(new Error('automation cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([ready, guard]);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.restart(failure);
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private restart(error: Error): void {
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    this.readyReject?.(error); this.readyReject = undefined; this.readyResolve = undefined;
    this.rejectAll(error); this.sentTemplates.clear(); if (worker) void worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.onAbort); pending.reject(error);
    }
    this.pending.clear();
  }
}
