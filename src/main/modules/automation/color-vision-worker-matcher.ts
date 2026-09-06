import path from 'path';
import os from 'os';
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

function shareFrameBitmap(frame: AutomationCapturedFrame): AutomationCapturedFrame {
  if (typeof SharedArrayBuffer === 'undefined') return frame;
  const source = frame.bitmap ?? frame.image.toBitmap();
  if (source.buffer instanceof SharedArrayBuffer) return frame;
  const shared = Buffer.from(new SharedArrayBuffer(source.byteLength));
  shared.set(source);
  return { ...frame, bitmap: shared };
}

export class ColorPointWorkerMatcher implements AutomationVisionMatcher {
  private worker?: Worker;
  private ready?: Promise<void>;
  private readyResolve?: () => void;
  private readyReject?: (error: Error) => void;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly sentTemplates = new Set<string>();
  private sentSceneKey?: string;
  private lastStats: Partial<ImageMatch> = {};
  private readonly groupWorkers: ColorPointWorkerMatcher[] = [];

  constructor(
    private readonly templates: AutomationTemplateProvider,
    private readonly options: {
      readonly workerPath?: string;
      readonly requestTimeoutMs?: number;
      readonly parallelGroupSearch?: boolean;
      readonly parallelGroupWorkers?: number;
    } = {},
  ) {}

  /** Decode assets and build their reusable colour signatures before a scene needs them. */
  async preload(assets: readonly string[], signal: AbortSignal): Promise<ColorPointSupportResult> {
    if (this.options.parallelGroupSearch === false) return this.preloadSingle(assets, signal);
    const uniqueAssets = [...new Set(assets)];
    if (uniqueAssets.length === 0) return { matches: [], unsupportedAssets: [] };
    const workers = [this, ...this.ensureGroupWorkers(
      Math.min(this.configuredGroupWorkerCount(), uniqueAssets.length) - 1,
    )];
    // Keep one warm copy of each template instead of multiplying every decoded
    // image by the worker count. The normal request path sends it lazily if a
    // later dynamic schedule moves that asset to another worker.
    const shards = workers.map((_worker, workerIndex) => uniqueAssets
      .filter((_asset, assetIndex) => assetIndex % workers.length === workerIndex));
    const results = await Promise.all(workers.map((worker, index) => worker.preloadSingle(shards[index], signal)));
    return { matches: [], unsupportedAssets: results.flatMap((result) => result.unsupportedAssets) };
  }

  private async preloadSingle(assets: readonly string[], signal: AbortSignal): Promise<ColorPointSupportResult> {
    if (signal.aborted) throw new Error('automation cancelled');
    const uniqueAssets = [...new Set(assets)];
    if (uniqueAssets.length === 0) return { matches: [], unsupportedAssets: [] };
    const loaded = await Promise.all(uniqueAssets.map(async (asset) => ({ asset, pixels: await this.templates.load(asset, signal) })));
    const worker = this.ensureWorker();
    await this.waitReady(signal);
    const id = this.nextId++;
    return new Promise<ColorPointSupportResult>((resolve, reject) => {
      const onAbort = () => this.restart(new Error('automation cancelled'));
      const timer = setTimeout(() => this.restart(new Error('color template preload timed out')), this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal.addEventListener('abort', onAbort, { once: true });
      const templates = loaded.map(({ asset, pixels }) => {
        const include = !this.sentTemplates.has(pixels.cacheKey);
        if (include) this.sentTemplates.add(pixels.cacheKey);
        return { asset, cacheKey: pixels.cacheKey, width: pixels.width, height: pixels.height, ...(include ? { bgra: pixels.bgra } : {}) };
      });
      worker.postMessage({ type: 'preload', id, templates });
    });
  }

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
    const uniqueAssets = [...new Set(assets)];
    if (this.options.parallelGroupSearch === false || uniqueAssets.length < 2) {
      return this.findManyCandidatesWithSupportSingle(assets, frame, options, signal);
    }
    // Schedule whole assets dynamically, never split a template by scale. A
    // template's scale hypotheses compete during proposal selection, while
    // independent assets can safely be claimed by whichever worker becomes idle.
    const workers = [this, ...this.ensureGroupWorkers(
      Math.min(this.configuredGroupWorkerCount(), uniqueAssets.length) - 1,
    )];
    const started = performance.now();
    const workerFrame = shareFrameBitmap(frame);
    let nextAsset = 0;
    const partial: ColorPointSupportResult[] = [];
    const requestStats: Partial<ImageMatch>[] = [];
    await Promise.all(workers.map(async (worker) => {
      while (nextAsset < uniqueAssets.length) {
        const asset = uniqueAssets[nextAsset++];
        partial.push(await worker.findManyCandidatesWithSupportSingle(
          [asset], workerFrame, { ...options, maxCandidates: 1 }, signal,
        ));
        requestStats.push({ ...worker.lastStats });
      }
    }));
    const result: ColorPointSupportResult = {
      unsupportedAssets: partial.flatMap((entry) => entry.unsupportedAssets)
        .sort((first, second) => uniqueAssets.indexOf(first) - uniqueAssets.indexOf(second)),
      matches: partial.flatMap((entry) => entry.matches)
        .sort((first, second) => second.score - first.score
          || uniqueAssets.indexOf(first.asset ?? '') - uniqueAssets.indexOf(second.asset ?? ''))
        .slice(0, options.maxCandidates ?? 1),
    };
    const matchMs = performance.now() - started;
    this.lastStats = {
      matchMs,
      sceneBytes: Math.max(...requestStats.map((stats) => stats.sceneBytes ?? 0)),
      sceneTransferBytes: requestStats.reduce((total, stats) => total + (stats.sceneTransferBytes ?? 0), 0),
      templateLoadMs: Math.max(...requestStats.map((stats) => stats.templateLoadMs ?? 0)),
    };
    return { ...result, matches: result.matches.map((match) => ({ ...match, ...this.lastStats, matchMs })) };
  }

  private async findManyCandidatesWithSupportSingle(assets: string[], frame: AutomationCapturedFrame, options: { threshold: number; region?: AutomationCapabilityRegion; scales?: number[]; mask?: AutomationImageMask; maxCandidates?: number }, signal: AbortSignal): Promise<ColorPointSupportResult> {
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
    const sceneKey = frame.frameId === undefined ? undefined : region
      ? `${frame.frameId}:${region.x},${region.y},${region.width},${region.height}`
      : `${frame.frameId}:full`;
    const reuseScene = sceneKey !== undefined && sceneKey === this.sentSceneKey;
    const sharedWholeFrame = !region && bytes.buffer instanceof SharedArrayBuffer;
    const sceneBytes = reuseScene
      ? new Uint8Array(0)
      : region ? crop(bytes, bitmapSize.width, region) : sharedWholeFrame ? bytes : Uint8Array.from(bytes);
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
        scene: {
          pixels: sceneBytes,
          width: region?.width ?? bitmapSize.width,
          height: region?.height ?? bitmapSize.height,
          frameKey: sceneKey,
          reuse: reuseScene,
        },
        templates,
        options: { threshold: options.threshold, scales: options.scales, maxCandidates: options.maxCandidates ?? 1 },
      });
      this.sentSceneKey = sceneKey;
    });
    const matchMs = performance.now() - started;
    const sceneByteLength = (region?.width ?? bitmapSize.width) * (region?.height ?? bitmapSize.height) * 4;
    const sceneTransferBytes = sharedWholeFrame ? 0 : sceneBytes.byteLength;
    this.lastStats = { templateLoadMs, matchMs, sceneBytes: sceneByteLength, sceneTransferBytes };
    const addOriginAndStats = (match: ImageMatch): ImageMatch => ({
      ...match, x: match.x + originX, y: match.y + originY,
      templateLoadMs, matchMs, sceneBytes: sceneByteLength, sceneTransferBytes,
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
    if (this.options.parallelGroupSearch === false) {
      await this.waitReady(signal);
      return;
    }
    const workers = this.ensureGroupWorkers(this.configuredGroupWorkerCount() - 1);
    await Promise.all([this.waitReady(signal), ...workers.map((worker) => worker.warmup(signal))]);
  }

  async close(): Promise<void> {
    const groupWorkers = this.groupWorkers.splice(0);
    const worker = this.worker; this.worker = undefined; this.ready = undefined;
    this.readyReject?.(new Error('color matcher closed')); this.readyReject = undefined; this.readyResolve = undefined;
    this.rejectAll(new Error('color matcher closed')); this.sentTemplates.clear(); this.sentSceneKey = undefined;
    await Promise.all([worker ? worker.terminate() : Promise.resolve(), ...groupWorkers.map((entry) => entry.close())]);
  }

  private configuredGroupWorkerCount(): number {
    const defaultWorkers = Math.min(7, Math.max(2, os.cpus().length - 1));
    return Math.max(2, Math.min(8, Math.floor(this.options.parallelGroupWorkers ?? defaultWorkers)));
  }

  private ensureGroupWorkers(count: number): ColorPointWorkerMatcher[] {
    while (this.groupWorkers.length < count) {
      this.groupWorkers.push(new ColorPointWorkerMatcher(this.templates, {
        ...this.options,
        parallelGroupSearch: false,
      }));
    }
    return this.groupWorkers.slice(0, count);
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
    this.rejectAll(error); this.sentTemplates.clear(); this.sentSceneKey = undefined; if (worker) void worker.terminate();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.signal.removeEventListener('abort', pending.onAbort); pending.reject(error);
    }
    this.pending.clear();
  }
}
