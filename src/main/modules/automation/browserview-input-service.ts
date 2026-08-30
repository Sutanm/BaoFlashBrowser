import { acquireAutomationCdpLease } from '../cdp-lease';

export type AutomationInputPoint = { readonly x: number; readonly y: number };
export type AutomationMouseButton = 'left' | 'right' | 'middle';
export type AutomationKeyModifier = 'alt' | 'control' | 'meta' | 'shift';

type DebuggerLike = {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  detach(): void;
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

export type BrowserViewInputTarget = {
  readonly id: number;
  isDestroyed(): boolean;
  readonly debugger: DebuggerLike;
};

type KeyboardDescriptor = {
  key: string;
  code?: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  text?: string;
};

const NAMED_KEYS: Record<string, Omit<KeyboardDescriptor, 'key'>> = {
  Backspace: { code: 'Backspace', windowsVirtualKeyCode: 8 }, Tab: { code: 'Tab', windowsVirtualKeyCode: 9, text: '\t' },
  Enter: { code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }, Shift: { code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  Control: { code: 'ControlLeft', windowsVirtualKeyCode: 17 }, Alt: { code: 'AltLeft', windowsVirtualKeyCode: 18 },
  Escape: { code: 'Escape', windowsVirtualKeyCode: 27 }, Space: { code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  PageUp: { code: 'PageUp', windowsVirtualKeyCode: 33 }, PageDown: { code: 'PageDown', windowsVirtualKeyCode: 34 },
  End: { code: 'End', windowsVirtualKeyCode: 35 }, Home: { code: 'Home', windowsVirtualKeyCode: 36 },
  ArrowLeft: { code: 'ArrowLeft', windowsVirtualKeyCode: 37 }, ArrowUp: { code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowRight: { code: 'ArrowRight', windowsVirtualKeyCode: 39 }, ArrowDown: { code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Insert: { code: 'Insert', windowsVirtualKeyCode: 45 }, Delete: { code: 'Delete', windowsVirtualKeyCode: 46 },
};

function describeKeyboardKey(input: string): KeyboardDescriptor {
  const alias = input === ' ' || input === 'Spacebar' ? 'Space' : input === 'Esc' ? 'Escape' : input;
  const named = NAMED_KEYS[alias];
  if (named) {
    const virtualKeyCode = named.windowsVirtualKeyCode;
    return { key: alias === 'Space' ? ' ' : alias, ...named, nativeVirtualKeyCode: virtualKeyCode };
  }
  if (/^[a-z]$/i.test(alias)) {
    const upper = alias.toUpperCase();
    const code = upper.charCodeAt(0);
    return { key: alias, code: `Key${upper}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: alias };
  }
  if (/^[0-9]$/.test(alias)) {
    const code = alias.charCodeAt(0);
    return { key: alias, code: `Digit${alias}`, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, text: alias };
  }
  const functionKey = /^F([1-9]|1[0-2])$/.exec(alias);
  if (functionKey) {
    const code = 111 + Number(functionKey[1]);
    return { key: alias, code: alias, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  }
  return { key: alias, text: alias.length === 1 ? alias : undefined };
}

export type BrowserViewInputServiceOptions = {
  readonly assertCurrent: () => void;
  readonly toDisplayPoint: (point: AutomationInputPoint) => AutomationInputPoint;
  readonly displayScale: () => { readonly x: number; readonly y: number };
  readonly sleep: (durationMs: number, signal: AbortSignal) => Promise<void>;
};

/** CDP-backed input port. It owns debugger leases and guarantees drag release. */
export class BrowserViewInputService {
  private pointer: AutomationInputPoint = { x: 0, y: 0 };

  constructor(private readonly target: BrowserViewInputTarget, private readonly options: BrowserViewInputServiceOptions) {}

  async move(point: AutomationInputPoint, signal: AbortSignal): Promise<void> {
    await this.withCdp(signal, (send) => send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...this.options.toDisplayPoint(point) }));
    this.pointer = point;
  }

  async click(point: AutomationInputPoint, button: AutomationMouseButton, clickCount: number, signal: AbortSignal): Promise<void> {
    const display = this.options.toDisplayPoint(point);
    await this.withCdp(signal, async (send) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...display });
      for (let count = 1; count <= clickCount; count += 1) {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...display, button, clickCount: count });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...display, button, clickCount: count });
      }
    });
    this.pointer = point;
  }

  async drag(start: AutomationInputPoint, end: AutomationInputPoint, button: AutomationMouseButton, durationMs: number, signal: AbortSignal): Promise<void> {
    const buttonMask = { left: 1, right: 2, middle: 4 }[button];
    let current = start;
    await this.withCdp(signal, async (send) => {
      const displayStart = this.options.toDisplayPoint(start);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...displayStart });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...displayStart, button, buttons: buttonMask, clickCount: 1 });
      try {
        const steps = Math.max(1, Math.min(120, Math.ceil(durationMs / 16)));
        const intervalMs = durationMs / steps;
        for (let index = 1; index <= steps; index += 1) {
          if (intervalMs > 0) await this.options.sleep(intervalMs, signal);
          current = { x: start.x + (end.x - start.x) * index / steps, y: start.y + (end.y - start.y) * index / steps };
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...this.options.toDisplayPoint(current), button, buttons: buttonMask });
        }
      } finally {
        await this.target.debugger.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseReleased', ...this.options.toDisplayPoint(current), button, buttons: 0, clickCount: 1,
        }).catch(() => undefined);
      }
    });
    this.pointer = current;
  }

  async keyDown(key: string, modifiers: AutomationKeyModifier[], signal: AbortSignal): Promise<void> {
    const descriptor = describeKeyboardKey(key);
    const mask = this.modifierMask(modifiers);
    await this.withCdp(signal, async (send) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: descriptor.key, code: descriptor.code,
        windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode, nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode, modifiers: mask });
      if (modifiers.length === 0 && descriptor.text !== undefined) {
        await send('Input.dispatchKeyEvent', { type: 'char', ...descriptor, modifiers: mask,
          text: descriptor.text, unmodifiedText: descriptor.text });
      }
    });
  }

  async keyUp(key: string, modifiers: AutomationKeyModifier[], signal: AbortSignal): Promise<void> {
    const descriptor = describeKeyboardKey(key);
    await this.withCdp(signal, (send) => send('Input.dispatchKeyEvent', { type: 'keyUp', key: descriptor.key,
      code: descriptor.code, windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode,
      nativeVirtualKeyCode: descriptor.nativeVirtualKeyCode, modifiers: this.modifierMask(modifiers) }));
  }

  async typeText(text: string, intervalMs: number, signal: AbortSignal): Promise<void> {
    if (intervalMs === 0) {
      await this.withCdp(signal, (send) => send('Input.insertText', { text }));
      return;
    }
    for (const character of text) {
      await this.withCdp(signal, (send) => send('Input.insertText', { text: character }));
      await this.options.sleep(intervalMs, signal);
    }
  }

  async scroll(deltaX: number, deltaY: number, signal: AbortSignal): Promise<void> {
    const display = this.options.toDisplayPoint(this.pointer);
    const scale = this.options.displayScale();
    await this.withCdp(signal, (send) => send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: display.x, y: display.y, deltaX: deltaX * scale.x, deltaY: deltaY * scale.y,
    }));
  }

  private modifierMask(modifiers: AutomationKeyModifier[]): number {
    return modifiers.reduce((mask, modifier) => mask | ({ alt: 1, control: 2, meta: 4, shift: 8 })[modifier], 0);
  }

  private async withCdp(
    signal: AbortSignal,
    action: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<unknown>,
  ): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    this.options.assertCurrent();
    const lease = await acquireAutomationCdpLease(this.target, signal);
    try {
      await action((method, params) => {
        if (signal.aborted) throw new Error('automation cancelled');
        return this.target.debugger.sendCommand(method, params);
      });
    } finally {
      lease.release();
    }
  }
}
