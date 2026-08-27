import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserViewAutomationDriver,
  deviceMatchToCssPoint,
  relativeCoordinateToCssPoint,
  relativeSearchRegionToCssRegion,
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

  it('converts normalized coordinates independently of capture dimensions', () => {
    expect(relativeCoordinateToCssPoint({ x: 5000, y: 2500 }, { width: 901, height: 561 })).toEqual({ x: 450, y: 140 });
    expect(relativeCoordinateToCssPoint({ x: 10_000, y: 10_000 }, { width: 900, height: 560 })).toEqual({ x: 899, y: 559 });
    expect(() => relativeCoordinateToCssPoint({ x: 10_001, y: 0 }, { width: 900, height: 560 })).toThrow(/0 to 10000/);
  });

  it('converts normalized search-region corners to CSS pixels', () => {
    expect(relativeSearchRegionToCssRegion(
      { left: 1000, top: 2000, right: 9000, bottom: 8000 },
      { width: 900, height: 560 },
    )).toEqual({ x: 90, y: 112, width: 720, height: 336 });
    expect(() => relativeSearchRegionToCssRegion(
      { left: 5000, top: 1000, right: 5000, bottom: 9000 },
      { width: 900, height: 560 },
    )).toThrow(/valid/);
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

  it('clicks a relative coordinate without requiring a preceding capture', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 901, height: 561 }) });
    await driver.clickPoint({ x: 5000, y: 2500 }, { button: 'left', clickCount: 1 }, new AbortController().signal);
    expect(wc.captures).toBe(0);
    expect(wc.commands.map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 450, y: 140 },
      { type: 'mousePressed', x: 450, y: 140, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 450, y: 140, button: 'left', clickCount: 1 },
    ]);
  });

  it('moves and drags using normalized coordinates without capturing', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 901, height: 561 }) });
    const signal = new AbortController().signal;
    await driver.moveToPoint({ x: 5000, y: 2500 }, signal);
    await driver.dragTargets(
      { kind: 'coordinate', coordinate: { x: 1000, y: 2000 } },
      { kind: 'coordinate', coordinate: { x: 9000, y: 8000 } },
      { button: 'left', durationMs: 0 }, signal,
    );
    expect(wc.captures).toBe(0);
    expect(wc.commands.map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 450, y: 140 },
      { type: 'mouseMoved', x: 90, y: 112 },
      { type: 'mousePressed', x: 90, y: 112, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseMoved', x: 810, y: 448, button: 'left', buttons: 1 },
      { type: 'mouseReleased', x: 810, y: 448, button: 'left', buttons: 0, clickCount: 1 },
    ]);
  });

  it('drags between matched image centers with a pressed-button move', async () => {
    const wc = new FakeWebContents();
    const target = { ...MATCH, x: 600, y: 450 };
    const matcher: AutomationVisionMatcher = { find: vi.fn(async (asset: string) => asset === 'B.png' ? target : MATCH) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const signal = new AbortController().signal;
    const sourceMatch = await driver.findImage({ asset: 'A.png', threshold: 0.9 }, signal);
    const targetMatch = await driver.findImage({ asset: 'B.png', threshold: 0.9 }, signal);
    await driver.drag(sourceMatch!, targetMatch!, { button: 'left', durationMs: 0 }, signal);
    expect(wc.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 130, y: 220 },
      { type: 'mousePressed', x: 130, y: 220, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseMoved', x: 430, y: 320, button: 'left', buttons: 1 },
      { type: 'mouseReleased', x: 430, y: 320, button: 'left', buttons: 0, clickCount: 1 },
    ]);
    expect(wc.attached).toBe(false);
  });

  it('releases the mouse button when a drag fails after pressing', async () => {
    const wc = new FakeWebContents();
    const originalSend = wc.debugger.sendCommand;
    let mouseCommands = 0;
    wc.debugger.sendCommand = async (method, params) => {
      if (method === 'Input.dispatchMouseEvent') {
        mouseCommands += 1;
        if (mouseCommands === 3) throw new Error('movement failed');
      }
      return originalSend(method, params);
    };
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => MATCH) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const signal = new AbortController().signal;
    const match = await driver.findImage({ asset: 'A.png', threshold: 0.9 }, signal);
    await expect(driver.drag(match!, match!, { button: 'left', durationMs: 0 }, signal)).rejects.toThrow(/movement failed/);
    expect(wc.commands.at(-1)?.params).toMatchObject({ type: 'mouseReleased', button: 'left', buttons: 0 });
    expect(wc.attached).toBe(false);
  });

  it('matches an image group against one captured frame and returns the best member', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async (asset: string) => asset.endsWith('right.png') ? { ...MATCH, score: 0.96 } : asset.endsWith('left.png') ? { ...MATCH, score: 0.81 } : null);
    const matcher: AutomationVisionMatcher = { find };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const match = await driver.findImage({
      asset: '角色/行走/left.png',
      alternatives: ['角色/行走/right.png', '角色/行走/up.png'],
      threshold: 0.7,
    }, new AbortController().signal);

    expect(wc.captures).toBe(1);
    expect(wc.decrements).toBe(1);
    expect(find.mock.calls.map((call) => call[0])).toEqual(['角色/行走/left.png', '角色/行走/right.png', '角色/行走/up.png']);
    expect(new Set(find.mock.calls.map((call) => call[1].bitmap))).toHaveProperty('size', 1);
    expect(match).toMatchObject({ asset: '角色/行走/right.png', score: 0.96 });
  });

  it('passes a normalized entry region to OpenCV as a CSS search region', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const driver = new BrowserViewAutomationDriver(wc, { find }, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await driver.findImage({
      asset: 'button.png', threshold: 0.9,
      relativeRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
    }, new AbortController().signal);
    expect(find.mock.calls[0][2].region).toEqual({ x: 90, y: 112, width: 720, height: 336 });
  });

  it('waits for reload completion without keeping CDP attached', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await expect(driver.reload(new AbortController().signal)).resolves.toBeUndefined();
    expect(wc.attached).toBe(false);
  });
});
