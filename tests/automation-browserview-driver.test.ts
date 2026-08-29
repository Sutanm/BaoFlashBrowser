import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import {
  BrowserViewAutomationDriver,
  cssPointToRelativeCoordinate,
  deviceMatchToCssPoint,
  deviceMatchToLogicalRegionPoint,
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
  captureRects: Array<{ x: number; y: number; width: number; height: number } | undefined> = [];
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
  async capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<AutomationCapturedImage> {
    this.captureRects.push(rect);
    if (!rect) return this.image;
    const width = Math.round(rect.width * 1.5);
    const height = Math.round(rect.height * 1.5);
    return {
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toPNG: () => Buffer.from([1, 2, 3]),
      toBitmap: () => Buffer.alloc(width * height * 4),
    };
  }
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

  it('maps a game-surface region match back to a full logical point (DPR drift)', () => {
    // Reproduces a real 150%-DPR region capture: the page is captured at physical
    // pixels (1427×843) but the game surface is 712.36×435.57 logical. A region
    // match at bitmap (620,496) must land on the character's full-logical position
    // (≈662,272 + half-size), not drift below the surface.
    const regionMatch: ImageMatch = { x: 620, y: 496, width: 91, height: 117, score: 0.98 };
    const point = deviceMatchToLogicalRegionPoint(regionMatch, { width: 1427, height: 843 }, { width: 712.36, height: 435.57 }, { x: 352.68, y: 15.5 });
    expect(point.x).toBeCloseTo((620 + 91 / 2) * (712.36 / 1427) + 352.68, 2);
    expect(point.y).toBeCloseTo((496 + 117 / 2) * (435.57 / 843) + 15.5, 2);
    // Must stay inside the full logical canvas, not drift to the announcement area.
    expect(point.x).toBeGreaterThan(0);
    expect(point.y).toBeGreaterThan(0);
  });

  it('keeps full-page matches unchanged when no region offset is supplied', () => {
    const full: ImageMatch = { x: 400, y: 200, width: 80, height: 60, score: 0.97 };
    expect(deviceMatchToCssPoint(full, { width: 1280, height: 720 }, { width: 1280, height: 720 }))
      .toEqual({ x: 440, y: 230 });
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
    expect(wc.commands.map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 135, y: 215 },
      { type: 'mousePressed', x: 135, y: 215, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 135, y: 215, button: 'left', clickCount: 1 },
      { type: 'mousePressed', x: 135, y: 215, button: 'left', clickCount: 2 },
      { type: 'mouseReleased', x: 135, y: 215, button: 'left', clickCount: 2 },
    ]);
    expect(wc.commands.some((command) => command.method === 'Runtime.evaluateAssistantVisibility')).toBe(false);
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
    const driver = new BrowserViewAutomationDriver(wc, null, { getCssViewport: () => ({ width: 901, height: 561 }) });
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
    const driver = new BrowserViewAutomationDriver(wc, null, { getCssViewport: () => ({ width: 901, height: 561 }) });
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

  it('round-trips page and game coordinates through the same logical point', () => {
    const page = { x: 0, y: 0, width: 1280, height: 720 };
    const game = { x: 200, y: 100, width: 800, height: 400 };
    const gameCoordinate = { x: 4168, y: 7333 };
    const local = relativeCoordinateToCssPoint(gameCoordinate, { width: game.width, height: game.height });
    const logicalPoint = { x: game.x + local.x, y: game.y + local.y };
    const pageCoordinate = cssPointToRelativeCoordinate(logicalPoint, page);
    const pagePoint = relativeCoordinateToCssPoint(pageCoordinate, { width: page.width, height: page.height });
    const roundTrip = cssPointToRelativeCoordinate(pagePoint, game);
    expect(Math.abs(roundTrip.x - gameCoordinate.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(roundTrip.y - gameCoordinate.y)).toBeLessThanOrEqual(1);
  });

  it('maps logical input and a logical capture region through a fixed viewport scale', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const transform = {
      logicalSize: { width: 900, height: 560 },
      displaySize: { width: 720, height: 448 },
      scaleX: 0.8,
      scaleY: 0.8,
    };
    const driver = new BrowserViewAutomationDriver(wc, { find }, {
      getCssViewport: () => transform.logicalSize,
      getViewportTransform: () => transform,
    });
    const signal = new AbortController().signal;
    await driver.clickPoint({ x: 5000, y: 2500 }, { button: 'left', clickCount: 1 }, signal);
    await driver.findImage({
      asset: 'button.png', threshold: 0.9,
      relativeRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
    }, signal);

    expect(wc.commands.slice(0, 3).map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 359.6, y: 111.80000000000001 },
      { type: 'mousePressed', x: 359.6, y: 111.80000000000001, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 359.6, y: 111.80000000000001, button: 'left', clickCount: 1 },
    ]);
    expect(wc.captureRects).toEqual([{ x: 72, y: 89, width: 576, height: 270 }]);
    expect(find.mock.calls[0][1]).toMatchObject({
      bitmapSize: { width: 864, height: 405 },
      deviceOrigin: { x: 108, y: 134 },
      deviceSize: { width: 1080, height: 672 },
      cssSize: { width: 900, height: 560 },
    });
  });

  it('maps coordinates and relative vision regions inside a selected game surface', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const transform = {
      logicalSize: { width: 1280, height: 720 },
      displaySize: { width: 640, height: 360 },
      scaleX: 0.5,
      scaleY: 0.5,
    };
    const driver = new BrowserViewAutomationDriver(wc, { find }, {
      getCssViewport: () => transform.logicalSize,
      getViewportTransform: () => transform,
      getCoordinateSurface: () => ({ x: 100, y: 50, width: 400, height: 200 }),
    });
    driver.setCoordinateSpace('game');
    const signal = new AbortController().signal;
    await driver.clickPoint({ x: 5000, y: 5000 }, { button: 'left', clickCount: 1 }, signal);
    await driver.findImage({
      asset: 'button.png', threshold: 0.9,
      relativeRegion: { left: 2500, top: 2500, right: 7500, bottom: 7500 },
    }, signal);

    expect(wc.commands.slice(0, 3).map((command) => command.params)).toEqual([
      { type: 'mouseMoved', x: 299.75, y: 149.75 },
      { type: 'mousePressed', x: 299.75, y: 149.75, button: 'left', clickCount: 1 },
      { type: 'mouseReleased', x: 299.75, y: 149.75, button: 'left', clickCount: 1 },
    ]);
    expect(wc.captureRects).toEqual([{ x: 200, y: 100, width: 200, height: 100 }]);
  });

  it('crops ordinary OpenCV matching to the game surface only in game coordinates', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const driver = new BrowserViewAutomationDriver(wc, { find }, {
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({
        logicalSize: { width: 1280, height: 720 },
        displaySize: { width: 640, height: 360 },
        scaleX: 0.5,
        scaleY: 0.5,
      }),
      getCoordinateSurface: () => ({ x: 100, y: 50, width: 400, height: 200 }),
    });
    const signal = new AbortController().signal;

    driver.setCoordinateSpace('game');
    await driver.findImage({ asset: 'inside.png', threshold: 0.9 }, signal);
    driver.setCoordinateSpace('page');
    await driver.findImage({ asset: 'outside.png', threshold: 0.9 }, signal);

    expect(wc.captureRects).toEqual([
      { x: 100, y: 50, width: 400, height: 200 },
      undefined,
    ]);
  });

  it('intersects explicit image regions with the game surface', async () => {
    const wc = new FakeWebContents();
    const driver = new BrowserViewAutomationDriver(wc, { find: vi.fn(async () => MATCH) }, {
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({
        logicalSize: { width: 1280, height: 720 }, displaySize: { width: 640, height: 360 }, scaleX: 0.5, scaleY: 0.5,
      }),
      getCoordinateSurface: () => ({ x: 100, y: 50, width: 400, height: 200 }),
    });
    driver.setCoordinateSpace('game');
    const signal = new AbortController().signal;
    await driver.findImage({ asset: 'inside.png', threshold: 0.9, region: { x: 100, y: 50, width: 200, height: 200 } }, signal);
    expect(wc.captureRects).toEqual([{ x: 100, y: 50, width: 50, height: 75 }]);
    await expect(driver.findImage({ asset: 'outside.png', threshold: 0.9, region: { x: 0, y: 0, width: 100, height: 50 } }, signal))
      .rejects.toThrow(/does not overlap the game surface/);
  });

  it('reacquires the game surface after the live viewport changes', async () => {
    const wc = new FakeWebContents();
    let revision = 1;
    let surface = { x: 100, y: 50, width: 400, height: 200 };
    const refresh = vi.fn(async () => { surface = { x: 150, y: 75, width: 300, height: 150 }; });
    const waitForViewport = vi.fn(async () => undefined);
    const driver = new BrowserViewAutomationDriver(wc, null, {
      getCssViewport: () => ({ width: 1280, height: 720 }),
      getViewportTransform: () => ({
        logicalSize: { width: 1280, height: 720 }, displaySize: { width: 640, height: 360 }, scaleX: 0.5, scaleY: 0.5,
      }),
      getCoordinateSurface: () => surface,
      getViewportRevision: () => revision,
      waitForViewport,
      refreshCoordinateSurface: refresh,
    });
    driver.setCoordinateSpace('game');
    revision = 2;
    await driver.clickPoint({ x: 5000, y: 5000 }, { button: 'left', clickCount: 1 }, new AbortController().signal);
    expect(waitForViewport).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(wc.commands[0].params).toMatchObject({ type: 'mouseMoved', x: 299.75, y: 149.75 });
  });

  it('normalizes a windowed regional capture back to logical coordinates before matching', async () => {
    const wc = new FakeWebContents();
    const makeImage = (width: number, height: number): AutomationCapturedImage => ({
      isEmpty: () => false,
      getSize: () => ({ width, height }),
      toPNG: () => Buffer.from([1, 2, 3]),
      toBitmap: () => Buffer.alloc(width * height * 4),
      resize: ({ width: nextWidth, height: nextHeight }) => makeImage(nextWidth, nextHeight),
    });
    wc.capturePage = vi.fn(async (rect) => {
      wc.captureRects.push(rect);
      return makeImage(Math.round((rect?.width ?? 450) * 1.25), Math.round((rect?.height ?? 305) * 1.25));
    });
    const find = vi.fn(async () => MATCH);
    const transform = {
      logicalSize: { width: 900, height: 560 },
      displaySize: { width: 450, height: 305 },
      scaleX: 0.5,
      scaleY: 305 / 560,
    };
    const driver = new BrowserViewAutomationDriver(wc, { find }, {
      getCssViewport: () => transform.logicalSize,
      getViewportTransform: () => transform,
    });
    await driver.findImage({
      asset: 'button.png', threshold: 0.9,
      relativeRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
    }, new AbortController().signal);

    expect(wc.captureRects).toEqual([{ x: 45, y: 60, width: 360, height: 184 }]);
    expect(find.mock.calls[0][1]).toMatchObject({
      bitmapSize: { width: 720, height: 336 },
      deviceOrigin: { x: 90, y: 112 },
      deviceSize: { width: 900, height: 560 },
      cssSize: { width: 900, height: 560 },
    });
    expect(find.mock.calls[0][2].scales).toEqual([1]);
  });

  it('uses one batch matcher request for an image group when supported', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => null);
    const findMany = vi.fn(async () => ({ ...MATCH, asset: 'B.png' }));
    const driver = new BrowserViewAutomationDriver(wc, { find, findMany }, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const match = await driver.findImage({
      asset: 'A.png', alternatives: ['B.png', 'A.png'], threshold: 0.9,
    }, new AbortController().signal);

    expect(wc.captures).toBe(1);
    expect(find).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toEqual(['A.png', 'B.png']);
    expect(match).toMatchObject({ asset: 'B.png' });
  });

  it('shares one captured frame inside a condition evaluation scope', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const driver = new BrowserViewAutomationDriver(wc, { find }, { getCssViewport: () => ({ width: 900, height: 560 }) });
    const signal = new AbortController().signal;
    await driver.withFreshFrame(async () => {
      await driver.findImage({ asset: 'A.png', threshold: 0.9 }, signal);
      await driver.findImage({ asset: 'B.png', threshold: 0.9 }, signal);
    }, signal);
    expect(wc.captureRects).toEqual([undefined]);
    expect(wc.captures).toBe(1);
    expect(wc.decrements).toBe(1);
    expect(find).toHaveBeenCalledTimes(2);
    expect(find.mock.calls[0][1]).toBe(find.mock.calls[1][1]);

    await driver.findImage({ asset: 'C.png', threshold: 0.9 }, signal);
    expect(wc.captures).toBe(2);
  });

  it('captures a normalized entry region directly and preserves full-frame geometry', async () => {
    const wc = new FakeWebContents();
    const find = vi.fn(async () => MATCH);
    const driver = new BrowserViewAutomationDriver(wc, { find }, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await driver.findImage({
      asset: 'button.png', threshold: 0.9,
      relativeRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
    }, new AbortController().signal);
    expect(wc.captureRects).toEqual([{ x: 90, y: 112, width: 720, height: 336 }]);
    expect(find.mock.calls[0][1]).toMatchObject({
      bitmapSize: { width: 1080, height: 504 },
      deviceOrigin: { x: 135, y: 168 },
      deviceSize: { width: 1350, height: 840 },
      cssSize: { width: 900, height: 560 },
    });
    expect(find.mock.calls[0][2].region).toBeUndefined();
  });

  it('waits for reload completion without keeping CDP attached', async () => {
    const wc = new FakeWebContents();
    const matcher: AutomationVisionMatcher = { find: vi.fn(async () => null) };
    const driver = new BrowserViewAutomationDriver(wc, matcher, { getCssViewport: () => ({ width: 900, height: 560 }) });
    await expect(driver.reload(new AbortController().signal)).resolves.toBeUndefined();
    expect(wc.attached).toBe(false);
  });
});
