import { performance } from 'perf_hooks';
import type { CaptureFrameGeometry } from '../../../shared/automation/core/frame-geometry';
import type { AutomationCapabilityRegion, AutomationCapturedFrame, AutomationCapturedImage } from './capability-contracts';
import { withTimeout } from '../../utils/with-timeout';

export interface BrowserViewCaptureSource {
  incrementCapturerCount(size?: { width: number; height: number }, stayHidden?: boolean): void;
  decrementCapturerCount(stayHidden?: boolean): void;
  capturePage(rect?: AutomationCapabilityRegion): Promise<AutomationCapturedImage>;
}

export type BrowserViewCaptureRequest = {
  readonly logicalViewportSize: { readonly width: number; readonly height: number };
  readonly displayViewportSize?: { readonly width: number; readonly height: number };
  readonly logicalRegion?: AutomationCapabilityRegion;
  readonly displayRegion?: AutomationCapabilityRegion;
  readonly emptyMessage?: string;
  readonly scope?: object;
};

export type BrowserViewCaptureServiceOptions = {
  readonly frameGeometry: (
    frameId: string,
    bitmapSize: { readonly width: number; readonly height: number },
    logicalRegion?: AutomationCapabilityRegion,
  ) => CaptureFrameGeometry;
  readonly now?: () => number;
  readonly captureTimeoutMs?: number;
};

let nextCaptureFrameId = 1;
const DEFAULT_CAPTURE_TIMEOUT_MS = 10_000;

function captureKey(region?: AutomationCapabilityRegion): string {
  return region ? `${region.x},${region.y},${region.width},${region.height}` : 'full';
}

/** Owns capture normalization and operation-scoped frame reuse. */
export class BrowserViewCaptureService {
  private scopedFrames: Map<string, AutomationCapturedFrame> | null = null;
  private readonly operationFrames = new WeakMap<object, Map<string, Promise<AutomationCapturedFrame>>>();
  private readonly now: () => number;
  private readonly captureTimeoutMs: number;

  constructor(
    private readonly source: BrowserViewCaptureSource,
    private readonly options: BrowserViewCaptureServiceOptions,
  ) {
    this.now = options.now ?? (() => performance.now());
    this.captureTimeoutMs = options.captureTimeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  }

  private capturePage(region?: AutomationCapabilityRegion): Promise<AutomationCapturedImage> {
    return withTimeout(this.source.capturePage(region), this.captureTimeoutMs, '捕获页面超时，请重试');
  }

  async capture(request: BrowserViewCaptureRequest): Promise<AutomationCapturedFrame> {
    const key = captureKey(request.logicalRegion);
    const cached = this.scopedFrames?.get(key);
    if (cached) return cached;

    let operationFrames: Map<string, Promise<AutomationCapturedFrame>> | undefined;
    if (request.scope) {
      operationFrames = this.operationFrames.get(request.scope);
      if (!operationFrames) {
        operationFrames = new Map();
        this.operationFrames.set(request.scope, operationFrames);
      }
      const operationCached = operationFrames.get(key);
      if (operationCached) return operationCached;
    }

    const pending = this.captureUncached(request);
    operationFrames?.set(key, pending);
    try {
      const frame = await pending;
      this.scopedFrames?.set(key, frame);
      return frame;
    } catch (error) {
      operationFrames?.delete(key);
      throw error;
    }
  }

  private async captureUncached(request: BrowserViewCaptureRequest): Promise<AutomationCapturedFrame> {

    const logicalCaptureSize = request.logicalRegion
      ? { width: request.logicalRegion.width, height: request.logicalRegion.height }
      : request.logicalViewportSize;
    // Ask Chromium's compositor for the stable logical pixel size up front.
    // NativeImage.resize remains a fallback for Electron/PPAPI paths that do
    // not honour the preferred capturer size.
    this.source.incrementCapturerCount(logicalCaptureSize);
    try {
      const captureStartedAt = this.now();
      const sourceImage = await this.capturePage(request.displayRegion);
      const captureMs = this.now() - captureStartedAt;
      if (sourceImage.isEmpty()) throw new Error(request.emptyMessage ?? 'BrowserView capture is empty');

      const sourceSize = sourceImage.getSize();
      const normalized = Boolean(sourceImage.resize)
        && (sourceSize.width !== logicalCaptureSize.width || sourceSize.height !== logicalCaptureSize.height);
      const image = normalized
        ? sourceImage.resize!({ ...logicalCaptureSize, quality: 'best' })
        : sourceImage;
      const bitmapSize = image.getSize();
      const bitmapStartedAt = this.now();
      const bitmap = image.toBitmap();
      const bitmapMs = this.now() - bitmapStartedAt;
      const numericFrameId = nextCaptureFrameId++;
      const deviceSize = normalized
        ? { ...request.logicalViewportSize }
        : request.logicalRegion && request.displayRegion && request.displayViewportSize
          ? {
            width: Math.round(request.displayViewportSize.width * bitmapSize.width / request.displayRegion.width),
            height: Math.round(request.displayViewportSize.height * bitmapSize.height / request.displayRegion.height),
          }
          : request.logicalRegion
            ? {
              width: Math.round(bitmapSize.width / request.logicalRegion.width * request.logicalViewportSize.width),
              height: Math.round(bitmapSize.height / request.logicalRegion.height * request.logicalViewportSize.height),
            }
          : bitmapSize;
      const frame: AutomationCapturedFrame = {
        frameId: numericFrameId,
        geometry: this.options.frameGeometry(`runtime-${numericFrameId}`, bitmapSize, request.logicalRegion),
        image,
        bitmap,
        bitmapSize,
        deviceOrigin: request.logicalRegion
          ? { x: request.logicalRegion.x, y: request.logicalRegion.y }
          : { x: 0, y: 0 },
        deviceSize,
        cssSize: { ...request.logicalViewportSize },
        regionCssSize: request.logicalRegion ? { ...logicalCaptureSize } : undefined,
        captureMs,
        bitmapMs,
      };
      return frame;
    } finally {
      this.source.decrementCapturerCount();
    }
  }

  async withFreshFrame<T>(operation: () => Promise<T>): Promise<T> {
    if (this.scopedFrames) return operation();
    const frames = new Map<string, AutomationCapturedFrame>();
    this.scopedFrames = frames;
    try {
      return await operation();
    } finally {
      if (this.scopedFrames === frames) this.scopedFrames = null;
    }
  }
}
