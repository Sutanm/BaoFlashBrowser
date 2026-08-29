import type { AutomationCoordinate, AutomationImageMask, AutomationRegion, AutomationRelativeRegion, PositionCompareTarget } from '../../../shared/automation/types';
import type {
  AutomationDriver,
  AutomationDriverPointerTarget,
  FindImageRequest,
  FindTextRequest,
  ImageMatch,
  TextMatch,
} from './runtime';
import type { OcrTextItem } from './paddle-ocr-engine';
import { acquireCdpLease } from '../cdp-lease';
import { Notification } from 'electron';

export type AutomationCapturedImage = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toBitmap(): Buffer;
  resize?(options: { width: number; height: number; quality?: 'good' | 'better' | 'best' }): AutomationCapturedImage;
};

export type AutomationCapturedFrame = {
  frameId?: number;
  image: AutomationCapturedImage;
  bitmap?: Buffer;
  bitmapSize?: { width: number; height: number };
  deviceOrigin?: { x: number; y: number };
  deviceSize: { width: number; height: number };
  cssSize: { width: number; height: number };
  captureMs?: number;
  bitmapMs?: number;
};

let nextAutomationFrameId = 1;

export type AutomationVisionMatcher = {
  find(
    asset: string,
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null>;
  findMany?(
    assets: string[],
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null>;
  getStats?(): Partial<ImageMatch>;
};

export type AutomationOcrEngine = {
  recognize(frame: AutomationCapturedFrame, signal: AbortSignal): Promise<OcrTextItem[]>;
};

type DebuggerLike = {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type AutomationWebContentsLike = {
  id: number;
  isDestroyed(): boolean;
  debugger: DebuggerLike;
  incrementCapturerCount(size?: { width: number; height: number }, stayHidden?: boolean): void;
  decrementCapturerCount(stayHidden?: boolean): void;
  capturePage(rect?: AutomationRegion): Promise<AutomationCapturedImage>;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  reload(): void;
  once(event: 'did-finish-load', listener: () => void): unknown;
  once(event: 'did-fail-load', listener: (...args: unknown[]) => void): unknown;
  removeListener(event: 'did-finish-load', listener: () => void): unknown;
  removeListener(event: 'did-fail-load', listener: (...args: unknown[]) => void): unknown;
};

export type BrowserViewAutomationDriverOptions = {
  getCssViewport(): { width: number; height: number };
  /** Selected game/player rectangle in the live BrowserView CSS coordinate space. */
  getCoordinateSurface?: () => AutomationRegion | null;
  getViewportTransform?: () => {
    logicalSize: { width: number; height: number };
    displaySize: { width: number; height: number };
    scaleX: number;
    scaleY: number;
  };
  getViewportRevision?: () => number;
  waitForViewport?: () => Promise<void>;
  refreshCoordinateSurface?: () => Promise<void>;
  navigationTimeoutMs?: number;
  log?: (message: string) => void;
  assertCurrent?: () => void;
  ocr?: AutomationOcrEngine;
};

type KeyboardDescriptor = {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  text?: string;
};

const NAMED_KEYS: Record<string, Omit<KeyboardDescriptor, 'key'>> = {
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 },
  Tab: { code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Shift: { code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  Control: { code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  Alt: { code: 'AltLeft', windowsVirtualKeyCode: 18 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 },
  Space: { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  End: { code: 'End', windowsVirtualKeyCode: 35 },
  Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Insert: { code: 'Insert', windowsVirtualKeyCode: 45 },
  Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
};

function describeKeyboardKey(input: string): KeyboardDescriptor {
  const alias = input === ' ' || input === 'Spacebar' ? 'Space' : input === 'Esc' ? 'Escape' : input;
  const named = NAMED_KEYS[alias];
  if (named) {
    const virtualKeyCode = named.windowsVirtualKeyCode;
    return {
      key: alias === 'Space' ? ' ' : alias,
      ...named,
      nativeVirtualKeyCode: virtualKeyCode,
    };
  }

  if (/^[a-z]$/i.test(alias)) {
    const upper = alias.toUpperCase();
    const virtualKeyCode = upper.charCodeAt(0);
    return { key: alias, code: `Key${upper}`, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, text: alias };
  }
  if (/^[0-9]$/.test(alias)) {
    const virtualKeyCode = alias.charCodeAt(0);
    return { key: alias, code: `Digit${alias}`, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode, text: alias };
  }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(alias);
  if (functionKey) {
    const virtualKeyCode = 111 + Number(functionKey[1]);
    return { key: alias, code: alias, windowsVirtualKeyCode: virtualKeyCode, nativeVirtualKeyCode: virtualKeyCode };
  }
  return { key: alias, text: alias.length === 1 ? alias : undefined };
}

export function deviceMatchToCssPoint(
  match: ImageMatch,
  deviceSize: { width: number; height: number },
  cssSize: { width: number; height: number },
  offset: { x: number; y: number } = { x: 0, y: 0 },
): { x: number; y: number } {
  if (deviceSize.width <= 0 || deviceSize.height <= 0 || cssSize.width <= 0 || cssSize.height <= 0) {
    throw new Error('capture and viewport dimensions must be positive');
  }
  const point = {
    x: (match.x + match.width / 2) * cssSize.width / deviceSize.width + offset.x,
    y: (match.y + match.height / 2) * cssSize.height / deviceSize.height + offset.y,
  };
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
    || point.x < 0 || point.y < 0 || point.x >= cssSize.width || point.y >= cssSize.height) {
    throw new Error(`automation input point is outside the BrowserView: ${point.x},${point.y}`);
  }
  return point;
}

export function relativeCoordinateToCssPoint(
  coordinate: AutomationCoordinate,
  cssSize: { width: number; height: number },
): { x: number; y: number } {
  if (cssSize.width <= 0 || cssSize.height <= 0) throw new Error('BrowserView dimensions must be positive');
  if (!Number.isInteger(coordinate.x) || !Number.isInteger(coordinate.y)
    || coordinate.x < 0 || coordinate.x > 10_000 || coordinate.y < 0 || coordinate.y > 10_000) {
    throw new Error(`relative coordinate must be an integer from 0 to 10000: ${coordinate.x},${coordinate.y}`);
  }
  return {
    x: coordinate.x / 10_000 * Math.max(0, cssSize.width - 1),
    y: coordinate.y / 10_000 * Math.max(0, cssSize.height - 1),
  };
}

export function relativeSearchRegionToCssRegion(
  region: AutomationRelativeRegion,
  cssSize: { width: number; height: number },
): AutomationRegion {
  if (cssSize.width <= 0 || cssSize.height <= 0) throw new Error('BrowserView dimensions must be positive');
  if (![region.left, region.top, region.right, region.bottom].every(Number.isInteger)
    || region.left < 0 || region.top < 0 || region.right > 10_000 || region.bottom > 10_000
    || region.left >= region.right || region.top >= region.bottom) {
    throw new Error('relative search region must use valid 0 to 10000 corners');
  }
  const x = Math.floor(region.left / 10_000 * cssSize.width);
  const y = Math.floor(region.top / 10_000 * cssSize.height);
  const right = Math.ceil(region.right / 10_000 * cssSize.width);
  const bottom = Math.ceil(region.bottom / 10_000 * cssSize.height);
  return { x, y, width: right - x, height: bottom - y };
}

export function cssPointToRelativeCoordinate(
  point: { x: number; y: number },
  surface: AutomationRegion,
): AutomationCoordinate {
  if (surface.width <= 0 || surface.height <= 0) throw new Error('coordinate surface dimensions must be positive');
  return {
    x: Math.max(0, Math.min(10_000, Math.round((point.x - surface.x) / Math.max(1, surface.width - 1) * 10_000))),
    y: Math.max(0, Math.min(10_000, Math.round((point.y - surface.y) / Math.max(1, surface.height - 1) * 10_000))),
  };
}

function intersectAutomationRegions(first: AutomationRegion, second: AutomationRegion): AutomationRegion {
  const x = Math.max(first.x, second.x);
  const y = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  if (right <= x || bottom <= y) throw new Error('image search region does not overlap the game surface');
  return { x, y, width: right - x, height: bottom - y };
}

export class BrowserViewAutomationDriver implements AutomationDriver {
  private readonly webContents: AutomationWebContentsLike;
  private readonly matcher: AutomationVisionMatcher | null;
  private readonly options: BrowserViewAutomationDriverOptions;
  private lastFrame: AutomationCapturedFrame | null = null;
  private scopedFrames: Map<string, AutomationCapturedFrame> | null = null;
  private lastVisionStatsLogAt = 0;
  private pointer = { x: 0, y: 0 };
  private coordinateSpace: 'page' | 'game' = 'page';
  private viewportRevision: number | undefined;

  constructor(
    webContents: AutomationWebContentsLike,
    matcher: AutomationVisionMatcher | null,
    options: BrowserViewAutomationDriverOptions,
  ) {
    this.webContents = webContents;
    this.matcher = matcher;
    this.options = options;
    this.viewportRevision = options.getViewportRevision?.();
  }

  async findImage(request: FindImageRequest, signal: AbortSignal): Promise<ImageMatch | null> {
    const totalStartedAt = Date.now();
    this.throwIfAborted(signal);
    this.assertCurrent();
    if (!this.matcher) throw new Error('automation workflow does not have a vision matcher');
    await this.ensureCoordinateSurfaceCurrent(signal);
    const cssSize = this.options.getCssViewport();
    const gameSurface = this.coordinateSpace === 'game' ? this.coordinateSurfaceLogical() : undefined;
    const requestedRegion = request.region
      ?? (request.relativeRegion ? this.relativeRegionToLogical(request.relativeRegion) : undefined);
    const captureRegion = gameSurface
      ? (requestedRegion ? intersectAutomationRegions(requestedRegion, gameSurface) : gameSurface)
      : requestedRegion;
    const displayCaptureRegion = captureRegion ? this.logicalRegionToDisplay(captureRegion) : undefined;
    const frameKey = captureRegion
      ? `${captureRegion.x},${captureRegion.y},${captureRegion.width},${captureRegion.height}`
      : 'full';
    let frame = this.scopedFrames?.get(frameKey);
    if (!frame) {
      this.webContents.incrementCapturerCount();
      try {
        const captureStartedAt = Date.now();
        const sourceImage = await this.webContents.capturePage(displayCaptureRegion);
        const captureMs = Date.now() - captureStartedAt;
        if (sourceImage.isEmpty()) throw new Error('BrowserView capture is empty');
        const logicalCaptureSize = captureRegion
          ? { width: captureRegion.width, height: captureRegion.height }
          : cssSize;
        const sourceSize = sourceImage.getSize();
        const normalized = Boolean(sourceImage.resize)
          && (sourceSize.width !== logicalCaptureSize.width || sourceSize.height !== logicalCaptureSize.height);
        const image = normalized
          ? sourceImage.resize!({ ...logicalCaptureSize, quality: 'best' })
          : sourceImage;
        const bitmapSize = image.getSize();
        const transform = this.viewportTransform();
        const deviceScaleX = displayCaptureRegion ? bitmapSize.width / displayCaptureRegion.width
          : bitmapSize.width / transform.displaySize.width;
        const deviceScaleY = displayCaptureRegion ? bitmapSize.height / displayCaptureRegion.height
          : bitmapSize.height / transform.displaySize.height;
        const bitmapStartedAt = Date.now();
        const bitmap = image.toBitmap();
        const bitmapMs = Date.now() - bitmapStartedAt;
        frame = {
          frameId: nextAutomationFrameId++,
          image,
          bitmap,
          bitmapSize,
          deviceOrigin: normalized && captureRegion
            ? { x: captureRegion.x, y: captureRegion.y }
            : captureRegion
              ? { x: Math.round((displayCaptureRegion?.x ?? 0) * deviceScaleX), y: Math.round((displayCaptureRegion?.y ?? 0) * deviceScaleY) }
              : { x: 0, y: 0 },
          deviceSize: normalized
            ? { ...cssSize }
            : captureRegion
              ? { width: Math.round(transform.displaySize.width * deviceScaleX), height: Math.round(transform.displaySize.height * deviceScaleY) }
              : bitmapSize,
          cssSize,
          captureMs,
          bitmapMs,
        };
        this.scopedFrames?.set(frameKey, frame);
      } finally {
        this.webContents.decrementCapturerCount();
      }
    }
    this.lastFrame = frame;
    const assets = [...new Set([request.asset, ...(request.alternatives ?? [])])];
      const options = {
        threshold: request.threshold,
        // capturePage already restricted the frame to the requested region.
        region: undefined,
        // Assets captured by the v2 workbench are normalized to one bitmap
        // pixel per logical CSS pixel. Match them at the live capture density.
        scales: (request.scales ?? [1]).map((scale) => scale * Math.sqrt(
          frame!.deviceSize.width / frame!.cssSize.width
          * frame!.deviceSize.height / frame!.cssSize.height,
        )),
        mask: request.mask,
      };
      let best: ImageMatch | null = null;
      if (this.matcher.findMany) best = await this.matcher.findMany(assets, frame, options, signal);
      else {
        for (const asset of assets) {
          this.throwIfAborted(signal);
          const match = await this.matcher.find(asset, frame, options, signal);
          if (match && (!best || match.score > best.score)) best = { ...match, asset };
        }
      }
      const totalMs = Date.now() - totalStartedAt;
      const now = Date.now();
      if (this.options.log && now - this.lastVisionStatsLogAt >= 5_000) {
        this.lastVisionStatsLogAt = now;
        const stats = this.matcher.getStats?.() ?? {};
        this.options.log(`vision capture=${frame.captureMs ?? '?'}ms bitmap=${frame.bitmapMs ?? '?'}ms templates=${stats.templateLoadMs ?? best?.templateLoadMs ?? '?'}ms worker=${stats.workerReadyMs ?? best?.workerReadyMs ?? '?'}ms shared-copy=${stats.sharedCopyMs ?? best?.sharedCopyMs ?? '?'}ms scene-mat=${stats.sceneMatMs ?? best?.sceneMatMs ?? '?'}ms gray=${stats.grayMs ?? best?.grayMs ?? '?'}ms resize=${stats.resizeMs ?? best?.resizeMs ?? '?'}ms match-template=${stats.matchTemplateMs ?? best?.matchTemplateMs ?? '?'}ms scaled-cache=${stats.scaledTemplateCacheHits ?? best?.scaledTemplateCacheHits ?? '?'}/${stats.scaledTemplateCacheMisses ?? best?.scaledTemplateCacheMisses ?? '?'} hit/miss match=${stats.matchMs ?? best?.matchMs ?? '?'}ms total=${totalMs}ms scene=${stats.sceneBytes ?? best?.sceneBytes ?? frame.bitmap?.byteLength ?? '?'}B transfer=${stats.sceneTransferBytes ?? best?.sceneTransferBytes ?? '?'}B wasm=${stats.wasmHeapBytes ?? best?.wasmHeapBytes ?? '?'}B cache=${stats.templateCacheBytes ?? best?.templateCacheBytes ?? '?'}B/${stats.templateCacheEntries ?? best?.templateCacheEntries ?? '?'} entries`);
      }
      return best ? { ...best, captureMs: frame.captureMs, bitmapMs: frame.bitmapMs, totalMs } : null;
  }

  async findText(request: FindTextRequest, signal: AbortSignal): Promise<TextMatch | null> {
    const totalStartedAt = Date.now();
    this.throwIfAborted(signal);
    this.assertCurrent();
    if (!this.options.ocr) throw new Error('当前安装的是标准版，不包含 OCR；请安装 BaoFlashBrowser OCR 版');
    await this.ensureCoordinateSurfaceCurrent(signal);
    const cssSize = this.options.getCssViewport();
    const gameSurface = this.coordinateSpace === 'game' ? this.coordinateSurfaceLogical() : undefined;
    const requestedRegion = request.region
      ?? (request.relativeRegion ? this.relativeRegionToLogical(request.relativeRegion) : undefined);
    const captureRegion = gameSurface
      ? (requestedRegion ? intersectAutomationRegions(requestedRegion, gameSurface) : gameSurface)
      : requestedRegion;
    const displayCaptureRegion = captureRegion ? this.logicalRegionToDisplay(captureRegion) : undefined;
    // Share the exact same captured frame with OpenCV when a combined
    // condition evaluates image and text inside one withFreshFrame scope.
    const frameKey = captureRegion
      ? `${captureRegion.x},${captureRegion.y},${captureRegion.width},${captureRegion.height}`
      : 'full';
    let frame = this.scopedFrames?.get(frameKey);
    if (!frame) {
      this.webContents.incrementCapturerCount();
      try {
        const captureStartedAt = Date.now();
        const sourceImage = await this.webContents.capturePage(displayCaptureRegion);
        const captureMs = Date.now() - captureStartedAt;
        if (sourceImage.isEmpty()) throw new Error('BrowserView OCR capture is empty');
        const logicalCaptureSize = captureRegion
          ? { width: captureRegion.width, height: captureRegion.height }
          : cssSize;
        const sourceSize = sourceImage.getSize();
        const normalized = Boolean(sourceImage.resize)
          && (sourceSize.width !== logicalCaptureSize.width || sourceSize.height !== logicalCaptureSize.height);
        const image = normalized ? sourceImage.resize!({ ...logicalCaptureSize, quality: 'best' }) : sourceImage;
        const bitmapSize = image.getSize();
        const bitmapStartedAt = Date.now();
        const bitmap = image.toBitmap();
        frame = {
          frameId: nextAutomationFrameId++, image, bitmap, bitmapSize,
          deviceOrigin: captureRegion ? { x: captureRegion.x, y: captureRegion.y } : { x: 0, y: 0 },
          deviceSize: normalized ? { ...cssSize } : (captureRegion ? { ...logicalCaptureSize } : bitmapSize),
          cssSize,
          captureMs,
          bitmapMs: Date.now() - bitmapStartedAt,
        };
        this.scopedFrames?.set(frameKey, frame);
      } finally {
        this.webContents.decrementCapturerCount();
      }
    }
    this.lastFrame = frame;
    const items = await this.options.ocr.recognize(frame, signal);
    const query = request.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    const candidates = items.filter((item) => {
      if (item.score < request.minScore) return false;
      const text = item.text.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
      return request.match === 'exact' ? text === query : text.includes(query);
    });
    const best = candidates.sort((a, b) => b.score - a.score)[0];
    if (!best) return null;
    const xs = best.box.map((point) => point[0]);
    const ys = best.box.map((point) => point[1]);
    const left = Math.min(...xs) + (frame.deviceOrigin?.x ?? 0);
    const top = Math.min(...ys) + (frame.deviceOrigin?.y ?? 0);
    const right = Math.max(...xs) + (frame.deviceOrigin?.x ?? 0);
    const bottom = Math.max(...ys) + (frame.deviceOrigin?.y ?? 0);
    return {
      text: best.text,
      x: left,
      y: top,
      width: Math.max(1, right - left),
      height: Math.max(1, bottom - top),
      score: best.score,
      captureMs: frame.captureMs,
      bitmapMs: frame.bitmapMs,
      totalMs: Date.now() - totalStartedAt,
    };
  }

  async withFreshFrame<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    this.throwIfAborted(signal);
    if (this.scopedFrames) return operation();
    const frames = new Map<string, AutomationCapturedFrame>();
    this.scopedFrames = frames;
    try {
      return await operation();
    } finally {
      if (this.scopedFrames === frames) this.scopedFrames = null;
    }
  }

  async resolveTargetPoint(target: PositionCompareTarget, signal: AbortSignal, relativeRegion?: AutomationRelativeRegion): Promise<{ x: number; y: number }> {
    await this.ensureCoordinateSurfaceCurrent(signal);
    if (target.kind === 'coordinate') {
      return this.relativePointToLogical(target.coordinate);
    }
    const match = await this.findImage({
      asset: target.asset,
      alternatives: target.alternatives,
      threshold: target.threshold ?? 0.9,
      region: target.region,
      relativeRegion: target.region ? undefined : relativeRegion,
      scales: target.scales,
      mask: target.mask ?? 'auto',
    }, signal);
    if (!match) throw new Error(`image not found for position comparison: ${target.asset}`);
    return this.toCssPoint(match, target.offset ?? { x: 0, y: 0 });
  }

  getCssViewport(): { width: number; height: number } {
    return this.options.getCssViewport();
  }

  setCoordinateSpace(space: 'page' | 'game'): 'page' | 'game' {
    const previous = this.coordinateSpace;
    this.coordinateSpace = space;
    return previous;
  }

  async click(
    match: ImageMatch,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number; offset: { x: number; y: number } },
    signal: AbortSignal,
  ): Promise<void> {
    const point = this.toCssPoint(match, options.offset);
    const displayPoint = this.logicalPointToDisplay(point);
    await this.withTransientCdp(signal, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...displayPoint });
      for (let count = 1; count <= options.clickCount; count += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...displayPoint, button: options.button, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...displayPoint, button: options.button, clickCount: count });
      }
    });
    this.pointer = point;
  }

  async moveTo(match: ImageMatch, offset: { x: number; y: number }, signal: AbortSignal): Promise<void> {
    const point = this.toCssPoint(match, offset);
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...this.logicalPointToDisplay(point) }));
    this.pointer = point;
  }

  async moveToPoint(coordinate: AutomationCoordinate, signal: AbortSignal): Promise<void> {
    await this.ensureCoordinateSurfaceCurrent(signal);
    const point = this.relativePointToLogical(coordinate);
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...this.logicalPointToDisplay(point) }));
    this.pointer = point;
  }

  async clickPoint(
    coordinate: AutomationCoordinate,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number },
    signal: AbortSignal,
  ): Promise<void> {
    await this.ensureCoordinateSurfaceCurrent(signal);
    const point = this.relativePointToLogical(coordinate);
    const displayPoint = this.logicalPointToDisplay(point);
    await this.withTransientCdp(signal, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...displayPoint });
      for (let count = 1; count <= options.clickCount; count += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...displayPoint, button: options.button, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...displayPoint, button: options.button, clickCount: count });
      }
    });
    this.pointer = point;
  }

  async drag(
    source: ImageMatch,
    target: ImageMatch,
    options: { button: 'left' | 'right' | 'middle'; durationMs: number },
    signal: AbortSignal,
  ): Promise<void> {
    const start = this.toCssPoint(source, { x: 0, y: 0 });
    const end = this.toCssPoint(target, { x: 0, y: 0 });
    await this.dispatchDrag(start, end, options, signal);
  }

  async dragTargets(
    source: AutomationDriverPointerTarget,
    target: AutomationDriverPointerTarget,
    options: { button: 'left' | 'right' | 'middle'; durationMs: number },
    signal: AbortSignal,
  ): Promise<void> {
    await this.ensureCoordinateSurfaceCurrent(signal);
    const resolve = (value: AutomationDriverPointerTarget): { x: number; y: number } => value.kind === 'coordinate'
      ? this.relativePointToLogical(value.coordinate)
      : this.toCssPoint(value.match, { x: 0, y: 0 });
    await this.dispatchDrag(resolve(source), resolve(target), options, signal);
  }

  private async dispatchDrag(
    start: { x: number; y: number },
    end: { x: number; y: number },
    options: { button: 'left' | 'right' | 'middle'; durationMs: number },
    signal: AbortSignal,
  ): Promise<void> {
    const buttonMask = { left: 1, right: 2, middle: 4 }[options.button];
    let current = start;
    await this.withTransientCdp(signal, async (send) => {
      const displayStart = this.logicalPointToDisplay(start);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...displayStart });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...displayStart, button: options.button, buttons: buttonMask, clickCount: 1 });
      try {
        const steps = Math.max(1, Math.min(120, Math.ceil(options.durationMs / 16)));
        const intervalMs = options.durationMs / steps;
        for (let index = 1; index <= steps; index += 1) {
          if (intervalMs > 0) await this.sleep(intervalMs, signal);
          current = {
            x: start.x + (end.x - start.x) * index / steps,
            y: start.y + (end.y - start.y) * index / steps,
          };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...this.logicalPointToDisplay(current), button: options.button, buttons: buttonMask });
        }
      } finally {
        // Release directly: the normal send wrapper intentionally rejects an aborted signal.
        await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', ...this.logicalPointToDisplay(current), button: options.button, buttons: 0, clickCount: 1,
        }).catch(() => undefined);
      }
    });
    this.pointer = current;
  }

  async pressKey(
    key: string,
    modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.keyDown(key, modifiers, signal);
    await this.keyUp(key, modifiers, signal);
  }

  async keyDown(key: string, modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    this.assertCurrent();
    const modifierMask = this.modifierMask(modifiers);
    const descriptor = describeKeyboardKey(key);
    await this.withTransientCdp(signal, async (send) => {
      await send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: descriptor.key,
        code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
        nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode,
        modifiers: modifierMask,
      });
      if (modifiers.length === 0 && descriptor.text !== undefined) {
        await send('Input.dispatchKeyEvent', {
          type: 'char',
          ...descriptor,
          modifiers: modifierMask,
          text: descriptor.text,
          unmodifiedText: descriptor.text,
        });
      }
    });
  }

  async keyUp(key: string, modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    this.assertCurrent();
    const descriptor = describeKeyboardKey(key);
    await this.withTransientCdp(signal, (send) => send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: descriptor.key,
      code: descriptor.code,
      windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode,
      modifiers: this.modifierMask(modifiers),
    }));
  }

  async typeText(text: string, intervalMs: number, signal: AbortSignal): Promise<void> {
    if (intervalMs === 0) {
      await this.withTransientCdp(signal, (send) => send('Input.insertText', { text }));
      return;
    }
    for (const character of text) {
      await this.withTransientCdp(signal, (send) => send('Input.insertText', { text: character }));
      await this.sleep(intervalMs, signal);
    }
  }

  async scroll(deltaX: number, deltaY: number, signal: AbortSignal): Promise<void> {
    const displayPoint = this.logicalPointToDisplay(this.pointer);
    const transform = this.viewportTransform();
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: displayPoint.x, y: displayPoint.y,
      deltaX: deltaX * transform.scaleX, deltaY: deltaY * transform.scaleY,
    }));
  }

  async navigate(url: string, signal: AbortSignal): Promise<void> {
    this.assertDebuggerDetached('navigate');
    this.throwIfAborted(signal);
    this.assertCurrent();
    await this.webContents.loadURL(url);
    this.throwIfAborted(signal);
    this.lastFrame = null;
  }

  async reload(signal: AbortSignal): Promise<void> {
    this.assertDebuggerDetached('reload');
    this.throwIfAborted(signal);
    this.assertCurrent();
    const timeoutMs = this.options.navigationTimeoutMs ?? 30_000;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.webContents.removeListener('did-finish-load', onLoad);
        this.webContents.removeListener('did-fail-load', onFail);
        signal.removeEventListener('abort', onAbort);
      };
      const onLoad = (): void => { cleanup(); resolve(); };
      const onFail = (...args: unknown[]): void => { cleanup(); reject(new Error(`reload failed: ${String(args[2] ?? args[1] ?? 'unknown')}`)); };
      const onAbort = (): void => { cleanup(); reject(new Error('automation cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`reload timed out after ${timeoutMs}ms`)); }, timeoutMs);
      this.webContents.once('did-finish-load', onLoad);
      this.webContents.once('did-fail-load', onFail);
      signal.addEventListener('abort', onAbort, { once: true });
      this.webContents.reload();
    });
    this.lastFrame = null;
  }

  log(message: string): void { this.options.log?.(message); }

  notify(title: string, body: string): void {
    try {
      const notification = new Notification({ title, body, silent: true });
      notification.show();
    } catch { /* notifications unavailable */ }
  }

  sleep(durationMs: number, signal: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const onAbort = (): void => { clearTimeout(timer); reject(new Error('automation cancelled')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, durationMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  now(): number { return Date.now(); }

  private toCssPoint(match: ImageMatch, offset: { x: number; y: number }): { x: number; y: number } {
    if (!this.lastFrame) throw new Error('input action requires a preceding image match');
    return deviceMatchToCssPoint(match, this.lastFrame.deviceSize, this.lastFrame.cssSize, offset);
  }

  private viewportTransform(): {
    logicalSize: { width: number; height: number };
    displaySize: { width: number; height: number };
    scaleX: number;
    scaleY: number;
  } {
    const supplied = this.options.getViewportTransform?.();
    if (supplied) return supplied;
    const logicalSize = this.options.getCssViewport();
    return { logicalSize, displaySize: { ...logicalSize }, scaleX: 1, scaleY: 1 };
  }

  private logicalPointToDisplay(point: { x: number; y: number }): { x: number; y: number } {
    const transform = this.viewportTransform();
    return { x: point.x * transform.scaleX, y: point.y * transform.scaleY };
  }

  private logicalRegionToDisplay(region: AutomationRegion): AutomationRegion {
    const transform = this.viewportTransform();
    const x = Math.floor(region.x * transform.scaleX);
    const y = Math.floor(region.y * transform.scaleY);
    const right = Math.ceil((region.x + region.width) * transform.scaleX);
    const bottom = Math.ceil((region.y + region.height) * transform.scaleY);
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
  }

  private coordinateSurfaceLogical(): AutomationRegion {
    const logical = this.options.getCssViewport();
    if (this.coordinateSpace === 'page') return { x: 0, y: 0, width: logical.width, height: logical.height };
    const displaySurface = this.options.getCoordinateSurface?.();
    if (!displaySurface) throw new Error('游戏画面坐标不可用：没有找到脚本指定的游戏画面');
    const transform = this.viewportTransform();
    const x = Math.max(0, Math.min(logical.width - 1, displaySurface.x / transform.scaleX));
    const y = Math.max(0, Math.min(logical.height - 1, displaySurface.y / transform.scaleY));
    const right = Math.max(x + 1, Math.min(logical.width, (displaySurface.x + displaySurface.width) / transform.scaleX));
    const bottom = Math.max(y + 1, Math.min(logical.height, (displaySurface.y + displaySurface.height) / transform.scaleY));
    return { x, y, width: right - x, height: bottom - y };
  }

  private async ensureCoordinateSurfaceCurrent(signal: AbortSignal): Promise<void> {
    if (this.coordinateSpace !== 'game' || !this.options.refreshCoordinateSurface) return;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const revision = this.options.getViewportRevision?.();
      if (revision === undefined || revision === this.viewportRevision) return;
      this.throwIfAborted(signal);
      await this.options.waitForViewport?.();
      this.throwIfAborted(signal);
      await this.options.refreshCoordinateSurface();
      if ((this.options.getViewportRevision?.() ?? revision) === revision) {
        this.viewportRevision = revision;
        return;
      }
    }
    throw new Error('窗口仍在变化，暂时无法稳定定位游戏画面');
  }

  private relativePointToLogical(coordinate: AutomationCoordinate): { x: number; y: number } {
    const surface = this.coordinateSurfaceLogical();
    const local = relativeCoordinateToCssPoint(coordinate, { width: surface.width, height: surface.height });
    return { x: surface.x + local.x, y: surface.y + local.y };
  }

  private relativeRegionToLogical(region: AutomationRelativeRegion): AutomationRegion {
    const surface = this.coordinateSurfaceLogical();
    const local = relativeSearchRegionToCssRegion(region, { width: surface.width, height: surface.height });
    return { x: surface.x + local.x, y: surface.y + local.y, width: local.width, height: local.height };
  }

  private assertDebuggerDetached(action: string): void {
    if (this.webContents.debugger.isAttached()) throw new Error(`cannot ${action} while another debugger client is attached`);
  }

  private modifierMask(modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>): number {
    return modifiers.reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 })[modifier], 0);
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('automation cancelled');
  }

  private assertCurrent(): void {
    if (this.webContents.isDestroyed()) throw new Error('automation target was destroyed');
    this.options.assertCurrent?.();
  }

  private async withTransientCdp(
    signal: AbortSignal,
    action: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>,
  ): Promise<void> {
    this.throwIfAborted(signal);
    this.assertCurrent();
    this.assertDebuggerDetached('send input');
    const lease = acquireCdpLease(this.webContents, 'automation');
    try {
      const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
        this.throwIfAborted(signal);
        return this.webContents.debugger.sendCommand(method, params);
      };
      await action(send);
    } finally {
      lease.release();
    }
  }
}
