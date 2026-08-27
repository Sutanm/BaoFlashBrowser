import type { AutomationCoordinate, AutomationImageMask, AutomationRegion, AutomationRelativeRegion, PositionCompareTarget } from '../../../shared/automation/types';
import type {
  AutomationDriver,
  AutomationDriverPointerTarget,
  FindImageRequest,
  ImageMatch,
} from './runtime';
import { acquireCdpLease } from '../cdp-lease';
import { Notification } from 'electron';

export type AutomationCapturedImage = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toPNG(): Buffer;
  toBitmap(): Buffer;
};

export type AutomationCapturedFrame = {
  image: AutomationCapturedImage;
  bitmap?: Buffer;
  deviceSize: { width: number; height: number };
  cssSize: { width: number; height: number };
};

export type AutomationVisionMatcher = {
  find(
    asset: string,
    frame: AutomationCapturedFrame,
    options: { threshold: number; region?: AutomationRegion; scales?: number[]; mask?: AutomationImageMask },
    signal: AbortSignal,
  ): Promise<ImageMatch | null>;
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
  capturePage(): Promise<AutomationCapturedImage>;
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
  navigationTimeoutMs?: number;
  log?: (message: string) => void;
  assertCurrent?: () => void;
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

export async function hideAutomationAssistantForCapture(
  webContents: Pick<AutomationWebContentsLike, 'executeJavaScript'>,
): Promise<string | null> {
  try {
    const previous = await webContents.executeJavaScript(`(() => {
      const assistant = document.getElementById('bao-automation-frame-assistant');
      if (!assistant) return null;
      const previous = assistant.style.visibility;
      assistant.style.visibility = 'hidden';
      return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(previous))));
    })()`);
    return typeof previous === 'string' ? previous : null;
  } catch {
    return null;
  }
}

export async function restoreAutomationAssistantAfterCapture(
  webContents: Pick<AutomationWebContentsLike, 'executeJavaScript' | 'isDestroyed'>,
  previous: string | null,
): Promise<void> {
  if (previous === null || webContents.isDestroyed()) return;
  try {
    await webContents.executeJavaScript(`(() => {
      const assistant = document.getElementById('bao-automation-frame-assistant');
      if (assistant) assistant.style.visibility = ${JSON.stringify(previous)};
    })()`);
  } catch { /* Page navigation may destroy the document after capture. */ }
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

export class BrowserViewAutomationDriver implements AutomationDriver {
  private readonly webContents: AutomationWebContentsLike;
  private readonly matcher: AutomationVisionMatcher;
  private readonly options: BrowserViewAutomationDriverOptions;
  private lastFrame: AutomationCapturedFrame | null = null;
  private pointer = { x: 0, y: 0 };

  constructor(
    webContents: AutomationWebContentsLike,
    matcher: AutomationVisionMatcher,
    options: BrowserViewAutomationDriverOptions,
  ) {
    this.webContents = webContents;
    this.matcher = matcher;
    this.options = options;
  }

  async findImage(request: FindImageRequest, signal: AbortSignal): Promise<ImageMatch | null> {
    this.throwIfAborted(signal);
    this.assertCurrent();
    this.webContents.incrementCapturerCount();
    let assistantVisibility: string | null = null;
    let assistantRestored = false;
    try {
      assistantVisibility = await hideAutomationAssistantForCapture(this.webContents);
      const image = await this.webContents.capturePage();
      if (image.isEmpty()) throw new Error('BrowserView capture is empty');
      const frame: AutomationCapturedFrame = {
        image,
        bitmap: image.toBitmap(),
        deviceSize: image.getSize(),
        cssSize: this.options.getCssViewport(),
      };
      this.lastFrame = frame;
      await restoreAutomationAssistantAfterCapture(this.webContents, assistantVisibility);
      assistantRestored = true;
      let best: ImageMatch | null = null;
      const assets = [...new Set([request.asset, ...(request.alternatives ?? [])])];
      for (const asset of assets) {
        this.throwIfAborted(signal);
        const match = await this.matcher.find(asset, frame, {
          threshold: request.threshold,
          region: request.region ?? (request.relativeRegion ? relativeSearchRegionToCssRegion(request.relativeRegion, frame.cssSize) : undefined),
          scales: request.scales,
          mask: request.mask,
        }, signal);
        if (match && (!best || match.score > best.score)) best = { ...match, asset };
      }
      return best;
    } finally {
      if (!assistantRestored) await restoreAutomationAssistantAfterCapture(this.webContents, assistantVisibility);
      this.webContents.decrementCapturerCount();
    }
  }

  async resolveTargetPoint(target: PositionCompareTarget, signal: AbortSignal): Promise<{ x: number; y: number }> {
    if (target.kind === 'coordinate') {
      const cssSize = this.options.getCssViewport();
      return relativeCoordinateToCssPoint(target.coordinate, cssSize);
    }
    const match = await this.findImage({
      asset: target.asset,
      alternatives: target.alternatives,
      threshold: target.threshold ?? 0.9,
      region: target.region,
      scales: target.scales,
      mask: target.mask ?? 'auto',
    }, signal);
    if (!match) throw new Error(`image not found for position comparison: ${target.asset}`);
    return this.toCssPoint(match, target.offset ?? { x: 0, y: 0 });
  }

  getCssViewport(): { width: number; height: number } {
    return this.options.getCssViewport();
  }

  async click(
    match: ImageMatch,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number; offset: { x: number; y: number } },
    signal: AbortSignal,
  ): Promise<void> {
    const point = this.toCssPoint(match, options.offset);
    await this.withTransientCdp(signal, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (let count = 1; count <= options.clickCount; count += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: options.button, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: options.button, clickCount: count });
      }
    });
    this.pointer = point;
  }

  async moveTo(match: ImageMatch, offset: { x: number; y: number }, signal: AbortSignal): Promise<void> {
    const point = this.toCssPoint(match, offset);
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }));
    this.pointer = point;
  }

  async moveToPoint(coordinate: AutomationCoordinate, signal: AbortSignal): Promise<void> {
    const point = relativeCoordinateToCssPoint(coordinate, this.options.getCssViewport());
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }));
    this.pointer = point;
  }

  async clickPoint(
    coordinate: AutomationCoordinate,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number },
    signal: AbortSignal,
  ): Promise<void> {
    const point = relativeCoordinateToCssPoint(coordinate, this.options.getCssViewport());
    await this.withTransientCdp(signal, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      for (let count = 1; count <= options.clickCount; count += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: options.button, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: options.button, clickCount: count });
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
    const resolve = (value: AutomationDriverPointerTarget): { x: number; y: number } => value.kind === 'coordinate'
      ? relativeCoordinateToCssPoint(value.coordinate, this.options.getCssViewport())
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
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...start });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...start, button: options.button, buttons: buttonMask, clickCount: 1 });
      try {
        const steps = Math.max(1, Math.min(120, Math.ceil(options.durationMs / 16)));
        const intervalMs = options.durationMs / steps;
        for (let index = 1; index <= steps; index += 1) {
          if (intervalMs > 0) await this.sleep(intervalMs, signal);
          current = {
            x: start.x + (end.x - start.x) * index / steps,
            y: start.y + (end.y - start.y) * index / steps,
          };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...current, button: options.button, buttons: buttonMask });
        }
      } finally {
        // Release directly: the normal send wrapper intentionally rejects an aborted signal.
        await this.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', ...current, button: options.button, buttons: 0, clickCount: 1,
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
    await this.withTransientCdp(signal, (send) => send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.pointer.x, y: this.pointer.y, deltaX, deltaY,
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
