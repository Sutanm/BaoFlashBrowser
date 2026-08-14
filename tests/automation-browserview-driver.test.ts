import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserViewAutomationDriver,
  deviceMatchToCssPoint,
  type AutomationCapturedImage,
  type AutomationVisionMatcher,
  type AutomationWebContentsLike,
} from '../src/main/modules/automation/browserview-driver';
import type { ImageMatch } from '../src/main/modules/automation/runtime';

const MATCH: ImageMatch = { x: 150, y: 300, width: 90, height: 60, score: 0.98 };

class FakeWebContents extends EventEmitter implements AutomationWebContentsLike {
  private static nextId = 1000;
  id = FakeWebContents.nextId++;
  attached = false;
  captures = 0;
  decrements = 0;
  commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  loadedUrl = '';
  isDestroyed(): boolean { return false; }
  image: AutomationCapturedImage = {
    isEmpty: () => false,
    getSize: () => ({ width: 1350, height: 840 }),
    toPNG: () => Buffer.from([1, 2, 3]),
    toBitmap: () => Buffer.alloc(1350 * 840 * 4),
  };
  debugger = {
    isAttached: (): boolean => this.attached,
    attach: (): void => { this.attached = true; },
    detach: (): void => { this.attached = false; },
    sendCommand: async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      this.commands.push({ method, params }); return {};
    },
  };
  incrementCapturerCount(): void { this.captures += 1; }
  decrementCapturerCount(): void { this.decrements += 1; }
  async capturePage(): Promise<AutomationCapturedImage> { return this.image; }
  async executeJavaScript(code: string): Promise<unknown> {
    this.commands.push({ method: 'Runtime.evaluateAssistantVisibility', params: { code } });
    return code.includes("visibility = 'hidden'") ? '' : undefined;
  }
  async loadURL(url: string): Promise<void> { this.loadedUrl = url; }
  reload(): void { queueMicrotask(() => this.emit('did-finish-load')); }
}

describe('BrowserView automation driver', () => {
  it('converts device-pixel matches to logical BrowserView coordinates', () => {
    expect(deviceMatchToCssPoint(MATCH, { width: 1350, height: 840 }, { width: 900, height: 560 }, { x: 5, y: -5 }))
      .toEqual({ x: 135, y: 215 });
  });

  it('rejects an offset that moves input outside the BrowserView', () => {
    expect(() => deviceMatchToCssPoint(MATCH, { width: 1350, height: 840 }, { width: 900, height: 560 }, { x: -500, y: 0 }))
      .toThrow(/outside the BrowserView/);
  });

  it('captures with a capturer lease and sends transient CDP input', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => MATCH) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const signal = new AbortController().signal;
    const match = await driver.findImage({ asset: 'button.png', threshold: 0.92 }, signal);
    await driver.click(match!, { button: 'left', clickCount: 2, offset: { x: 5, y: -5 } }, signal);

    expect(wc.captures).toBe(1);
    expect(wc.decrements).toBe(1);
    expect(wc.attached).toBe(false);
    expect(wc.commands.filter((command) => command.method !== 'Runtime.evaluateAssistantVisibility').map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 135, y: 215 },
      { type: 'mousePressed', x: 135, y: 215, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 135, y: 215, button: 'left', clickCount: 1 },
      { type: 'mousePressed', x: 135, y: 215, button: 'left', clickCount: 2 },
      { type: 'mouseReleased', x: 135, y: 215, button: 'left', clickCount: 2 },
    ]);
    const visibilityCalls = wc.commands.filter((command) => command.method === 'Runtime.evaluateAssistantVisibility');
    expect(visibilityCalls).toHaveLength(2);
    expect(String(visibilityCalls[0].params?.code)).toContain("visibility = 'hidden'");
  });

  it('refuses navigation when another debugger client owns the tab', async () => {
    const wc = new FakeWebContents();
    wc.attached = true;
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await expect(driver.navigate('https://example.com', new AbortController().signal)).rejects.toThrow(/another debugger client/);
    expect(wc.loadedUrl).toBe('');
  });

  it('sends combination keys and separate held-key down/up events', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const signal = new AbortController().signal;
    await driver.pressKey('A', ['control', 'shift'], signal);
    await driver.pressKey('Space', [], signal);
    await driver.keyDown('ArrowRight', [], signal);
    await driver.keyUp('ArrowRight', [], signal);
    expect(wc.commands.map((command) => command.params)).toEqual([
      { type: 'rawKeyDown', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 10 },
      { type: 'keyUp', key: 'A', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: 10 },
      { type: 'rawKeyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0 },
      { type: 'char', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0, text: ' ', unmodifiedText: ' ' },
      { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32, modifiers: 0 },
      { type: 'rawKeyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 0 },
      { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39, modifiers: 0 },
    ]);
    expect(wc.attached).toBe(false);
  });

  it('waits for reload completion without keeping CDP attached', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await expect(driver.reload(new AbortController().signal)).resolves.toBeUndefined();
    expect(wc.attached).toBe(false);
  });
});
