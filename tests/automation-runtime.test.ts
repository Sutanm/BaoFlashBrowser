import { describe, expect, it, vi } from 'vitest';
import { AutomationRunner, type AutomationDriver, type AutomationDriverPointerTarget, type FindImageRequest, type ImageMatch } from '../src/main/modules/automation/runtime';
import type { AutomationWorkflow } from '../src/shared/automation/types';

const MATCH: ImageMatch = { x: 100, y: 80, width: 40, height: 20, score: 0.97 };

class FakeDriver implements AutomationDriver {
  time = 0;
  readonly calls: string[] = [];
  readonly requests: FindImageRequest[] = [];
  readonly findSpaces: Array<'page' | 'game'> = [];
  readonly targetPoints = new Map<string, { x: number; y: number }>();
  readonly answers = new Map<string, Array<ImageMatch | null>>();
  readonly findDurations: number[] = [];
  frameScopes = 0;
  coordinateSpace: 'page' | 'game' = 'page';
  readonly coordinateSpaces: Array<'page' | 'game'> = [];

  setCoordinateSpace(space: 'page' | 'game'): 'page' | 'game' {
    const previous = this.coordinateSpace;
    this.coordinateSpace = space;
    this.coordinateSpaces.push(space);
    return previous;
  }

  queue(asset: string, ...answers: Array<ImageMatch | null>): void {
    this.answers.set(asset, answers);
  }

  queueFindDurations(...durations: number[]): void {
    this.findDurations.push(...durations);
  }

  async findImage(request: FindImageRequest): Promise<ImageMatch | null> {
    this.calls.push(`find:${request.asset}`);
    this.requests.push(request);
    this.findSpaces.push(this.coordinateSpace);
    this.time += this.findDurations.shift() ?? 0;
    return this.answers.get(request.asset)?.shift() ?? null;
  }

  async withFreshFrame<T>(operation: () => Promise<T>): Promise<T> {
    this.frameScopes += 1;
    return operation();
  }

  async resolveTargetPoint(target: import('../src/shared/automation/types').PositionCompareTarget): Promise<{ x: number; y: number }> {
    if (target.kind === 'coordinate') return target.coordinate;
    return this.targetPoints.get(target.asset) ?? { x: 0, y: 0 };
  }

  getCssViewport(): { width: number; height: number } { return { width: 1280, height: 720 }; }

  async click(_match: ImageMatch, options: { button: string; clickCount: number; offset: { x: number; y: number } }): Promise<void> {
    this.calls.push(`click:${options.button}:${options.clickCount}:${options.offset.x},${options.offset.y}`);
  }

  async clickPoint(coordinate: { x: number; y: number }, options: { button: string; clickCount: number }): Promise<void> {
    this.calls.push(`click-point:${coordinate.x},${coordinate.y}:${options.button}:${options.clickCount}`);
  }

  async moveTo(_match: ImageMatch, offset: { x: number; y: number }): Promise<void> {
    this.calls.push(`move:${offset.x},${offset.y}`);
  }

  async moveToPoint(coordinate: { x: number; y: number }): Promise<void> {
    this.calls.push(`move-point:${coordinate.x},${coordinate.y}`);
  }

  async drag(source: ImageMatch, target: ImageMatch, options: { button: string; durationMs: number }): Promise<void> {
    this.calls.push(`drag:${options.button}:${options.durationMs}:${source.x},${source.y}->${target.x},${target.y}`);
  }

  async dragTargets(source: AutomationDriverPointerTarget, target: AutomationDriverPointerTarget, options: { button: string; durationMs: number }): Promise<void> {
    const label = (value: AutomationDriverPointerTarget): string => value.kind === 'coordinate'
      ? `coordinate:${value.coordinate.x},${value.coordinate.y}`
      : `match:${value.match.x},${value.match.y}`;
    this.calls.push(`drag-targets:${options.button}:${options.durationMs}:${label(source)}->${label(target)}`);
  }

  async pressKey(key: string, modifiers: string[]): Promise<void> {
    this.calls.push(`key:${modifiers.join('+')}:${key}`);
  }

  async keyDown(key: string, modifiers: string[]): Promise<void> {
    this.calls.push(`key-down:${modifiers.join('+')}:${key}`);
  }

  async keyUp(key: string, modifiers: string[]): Promise<void> {
    this.calls.push(`key-up:${modifiers.join('+')}:${key}`);
  }

  async typeText(text: string, intervalMs: number): Promise<void> {
    this.calls.push(`text:${intervalMs}:${text}`);
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    this.calls.push(`scroll:${deltaX},${deltaY}`);
  }

  async navigate(url: string): Promise<void> {
    this.calls.push(`navigate:${url}`);
  }

  async reload(): Promise<void> { this.calls.push('reload'); }

  log(message: string): void { this.calls.push(`log:${message}`); }

  notify(title: string, body: string): void { this.calls.push(`notify:${title}:${body}`); }

  async sleep(durationMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    this.calls.push(`sleep:${durationMs}`);
    this.time += durationMs;
  }

  now(): number { return this.time; }
}

const workflow: AutomationWorkflow = {
  formatVersion: 2,
  id: 'runtime-demo',
  name: 'Runtime demo',
  readyWhen: { type: 'image-visible', asset: 'ready.png' },
  root: {
    type: 'sequence',
    steps: [
      { type: 'click-image', asset: 'start.png', timeoutMs: 500, minCycleMs: 100, offset: { x: 3, y: -2 } },
      {
        type: 'if-image',
        condition: { type: 'image-visible', asset: 'reward.png' },
        then: { type: 'sequence', steps: [{ type: 'key-press', key: 'Enter' }] },
        else: { type: 'sequence', steps: [{ type: 'key-press', key: 'Escape', modifiers: ['shift'] }] },
      },
      { type: 'repeat', times: 2, body: { type: 'sequence', steps: [{ type: 'delay', durationMs: 25 }] } },
    ],
  },
};

describe('automation runtime', () => {
  it('checks readiness, polls, branches, loops and completes deterministically', async () => {
    const driver = new FakeDriver();
    driver.queue('ready.png', MATCH);
    driver.queue('start.png', null, MATCH);
    driver.queue('reward.png', null);
    const states: string[] = [];
    const runner = new AutomationRunner(workflow, driver, {
      onEvent: (event) => { if (event.type === 'state') states.push(event.state); },
    });

    await expect(runner.run({ countdownMs: 50 })).resolves.toBe(true);
    expect(runner.state).toBe('completed');
    expect(states).toEqual(['checking', 'ready', 'countdown', 'running', 'completed']);
    expect(driver.calls).toEqual([
      'find:ready.png',
      'sleep:50',
      'find:start.png',
      'sleep:100',
      'find:start.png',
      'click:left:1:3,-2',
      'find:reward.png',
      'key:shift:Escape',
      'sleep:25',
      'sleep:25',
    ]);
  });

  it('stays idle when the prerequisite image is absent', async () => {
    const driver = new FakeDriver();
    driver.queue('ready.png', null);
    const runner = new AutomationRunner(workflow, driver);
    await expect(runner.run()).resolves.toBe(false);
    expect(runner.state).toBe('idle');
    expect(driver.calls).toEqual(['find:ready.png']);
  });

  it('treats a workflow without readyWhen as an unconditional entry', async () => {
    const driver = new FakeDriver();
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'unconditional', name: 'Unconditional',
      root: { type: 'sequence', steps: [{ type: 'key-press', key: 'A', modifiers: ['control', 'shift'] }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['key:control+shift:A']);
  });

  it('holds a key until the image state matches and always releases it', async () => {
    const driver = new FakeDriver();
    driver.queue('done.png', null, MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'hold-key', name: 'Hold key',
      root: { type: 'sequence', steps: [{
        type: 'key-hold-until-image', key: 'Space', modifiers: ['shift'], asset: 'done.png',
        state: 'visible', timeoutMs: 100, minCycleMs: 50,
      }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual([
      'key-down:shift:Space', 'find:done.png', 'sleep:50', 'find:done.png', 'key-up:shift:Space',
    ]);
  });

  it('uses the same multi-scale defaults as the visual test tools', async () => {
    const driver = new FakeDriver();
    driver.queue('button.png', MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'default-scales', name: 'Default scales',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png' }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.requests[0].scales).toEqual([0.75, 1, 1.25]);
    expect(driver.requests[0].mask).toBe('auto');
  });

  it('finds both endpoints before dragging an image', async () => {
    const driver = new FakeDriver();
    driver.queue('A.png', MATCH);
    driver.queue('B.png', { ...MATCH, x: 320, y: 240 });
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'drag-image', name: 'Drag image',
      root: { type: 'sequence', steps: [{
        type: 'drag-image',
        source: { type: 'image-visible', asset: 'A.png', threshold: 0.88 },
        target: { type: 'image-visible', asset: 'B.png', threshold: 0.92 },
        button: 'left', durationMs: 600,
      }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['find:A.png', 'find:B.png', 'drag:left:600:100,80->320,240']);
    expect(driver.requests.map((request) => request.threshold)).toEqual([0.88, 0.92]);
  });

  it('moves to coordinates and supports mixed coordinate/image drag targets', async () => {
    const driver = new FakeDriver();
    driver.queue('A.png', MATCH);
    driver.queue('B.png', { ...MATCH, x: 300, y: 200 });
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'pointer-targets', name: 'Pointer targets',
      root: { type: 'sequence', steps: [
        { type: 'move-to-coordinate', coordinate: { x: 6000, y: 3500 } },
        { type: 'drag', source: { kind: 'image', condition: { type: 'image-visible', asset: 'A.png' } }, target: { kind: 'coordinate', coordinate: { x: 8000, y: 7000 } }, durationMs: 400 },
        { type: 'drag', source: { kind: 'coordinate', coordinate: { x: 1000, y: 2000 } }, target: { kind: 'image', condition: { type: 'image-visible', asset: 'B.png' } }, button: 'right', durationMs: 0 },
        { type: 'drag', source: { kind: 'coordinate', coordinate: { x: 2500, y: 2500 } }, target: { kind: 'coordinate', coordinate: { x: 7500, y: 7500 } } },
      ] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual([
      'move-point:6000,3500',
      'find:A.png',
      'drag-targets:left:400:match:100,80->coordinate:8000,7000',
      'find:B.png',
      'drag-targets:right:0:coordinate:1000,2000->match:300,200',
      'drag-targets:left:800:coordinate:2500,2500->coordinate:7500,7500',
    ]);
  });

  it('runs the matching branch when a waited condition succeeds and the timeout branch otherwise', async () => {
    const successDriver = new FakeDriver();
    successDriver.queue('ready.png', null, MATCH);
    const source = (id: string): AutomationWorkflow => ({
      formatVersion: 2, id, name: id,
      root: { type: 'sequence', steps: [{
        type: 'wait-condition-branch', condition: { type: 'image-visible', asset: 'ready.png' }, timeoutMs: 100, minCycleMs: 50,
        success: { type: 'sequence', steps: [{ type: 'key-press', key: 'Enter' }] },
        timeout: { type: 'sequence', steps: [{ type: 'key-press', key: 'Escape' }] },
      }] },
    });
    await expect(new AutomationRunner(source('wait-success'), successDriver).run()).resolves.toBe(true);
    expect(successDriver.calls).toEqual(['find:ready.png', 'sleep:50', 'find:ready.png', 'key::Enter']);

    const timeoutDriver = new FakeDriver();
    await expect(new AutomationRunner(source('wait-timeout'), timeoutDriver).run()).resolves.toBe(true);
    expect(timeoutDriver.calls).toEqual(['find:ready.png', 'sleep:50', 'find:ready.png', 'sleep:50', 'find:ready.png', 'key::Escape']);
  });

  it('ends successfully without running later steps and can deliberately fail with a reason', async () => {
    const successDriver = new FakeDriver();
    const successRunner = new AutomationRunner({
      formatVersion: 2, id: 'end-success', name: 'End success',
      root: { type: 'sequence', steps: [{ type: 'end', result: 'success', message: 'done' }, { type: 'key-press', key: 'A' }] },
    }, successDriver);
    await expect(successRunner.run()).resolves.toBe(true);
    expect(successRunner.state).toBe('completed');
    expect(successDriver.calls).toEqual([]);

    const failureRunner = new AutomationRunner({
      formatVersion: 2, id: 'end-failure', name: 'End failure',
      root: { type: 'sequence', steps: [{ type: 'end', result: 'failure', message: '体力不足' }] },
    }, new FakeDriver());
    await expect(failureRunner.run()).rejects.toThrow('体力不足');
    expect(failureRunner.state).toBe('failed');
  });

  it('clicks a relative coordinate without capturing or matching an image', async () => {
    const driver = new FakeDriver();
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'coordinate-click', name: 'Coordinate click',
      root: { type: 'sequence', steps: [{ type: 'click-coordinate', coordinate: { x: 6250, y: 3750 }, button: 'right', clickCount: 2 }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['click-point:6250,3750:right:2']);
    expect(driver.requests).toHaveLength(0);
  });

  it('randomly clicks one point inside the padded region and reuses it for a double click', async () => {
    const driver = new FakeDriver();
    const events: Array<{ x: number; y: number }> = [];
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'random-region-click', name: 'Random region click',
      root: { type: 'sequence', steps: [{
        type: 'random-click-region', region: { left: 2000, top: 1000, right: 8000, bottom: 7000 }, padding: 100,
      }] },
    }, driver, {
      random: () => 0.5,
      onEvent: (event) => { if (event.type === 'random-click-coordinate') events.push(event.coordinate); },
    });
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['log:random click coordinate 5000,4000', 'click-point:5000,4000:left:2']);
    expect(events).toEqual([{ x: 5000, y: 4000 }]);
    expect(driver.requests).toHaveLength(0);
  });

  it('applies the entry search region to image operations unless a step overrides it', async () => {
    const driver = new FakeDriver();
    driver.queue('inside.png', MATCH);
    driver.queue('override.png', MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'game-region', name: 'Game region',
      searchRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 },
      root: { type: 'sequence', steps: [
        { type: 'wait-image', asset: 'inside.png' },
        { type: 'wait-image', asset: 'override.png', region: { x: 10, y: 20, width: 300, height: 200 } },
      ] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.requests[0]).toMatchObject({ relativeRegion: { left: 1000, top: 2000, right: 9000, bottom: 8000 } });
    expect(driver.requests[1]).toMatchObject({ region: { x: 10, y: 20, width: 300, height: 200 } });
    expect(driver.requests[1].relativeRegion).toBeUndefined();
  });

  it('switches page and game coordinate scopes and restores the entry space', async () => {
    const driver = new FakeDriver();
    driver.queue('page.png', MATCH);
    driver.queue('game.png', MATCH);
    driver.queue('entry.png', MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2,
      id: 'coordinate-spaces',
      name: 'Coordinate spaces',
      coordinateSpace: 'game',
      gameSurface: {
        version: 1, kind: 'flash', label: 'Flash · game', source: 'game.swf',
        frameUrl: 'https://example.test/frame.html', width: 950, height: 562,
      },
      root: { type: 'sequence', steps: [
        {
          type: 'coordinate-space', space: 'page',
          body: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'page.png', timeoutMs: 1 }] },
        },
        {
          type: 'coordinate-space', space: 'game',
          body: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'game.png', timeoutMs: 1 }] },
        },
        { type: 'wait-image', asset: 'entry.png', timeoutMs: 1 },
      ] },
    }, driver);

    await expect(runner.run()).resolves.toBe(true);
    expect(driver.findSpaces).toEqual(['page', 'game', 'game']);
    expect(driver.coordinateSpace).toBe('game');
  });

  it('compares position tolerance in logical pixels', async () => {
    const driver = new FakeDriver();
    driver.targetPoints.set('A.png', { x: 100, y: 100 });
    driver.targetPoints.set('B.png', { x: 111, y: 500 });
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'pixel-tolerance', name: 'Pixel tolerance',
      root: { type: 'sequence', steps: [{
        type: 'if-condition',
        condition: {
          type: 'position-relation', relation: 'vertical', tolerancePx: 10,
          targetA: { kind: 'image', asset: 'A.png' }, targetB: { kind: 'image', asset: 'B.png' },
        },
        then: { type: 'sequence', steps: [{ type: 'key-press', key: 'T' }] },
        else: { type: 'sequence', steps: [{ type: 'key-press', key: 'F' }] },
      }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['key::F']);
  });

  it('uses a minimum cycle duration and retries immediately by default', async () => {
    const limitedDriver = new FakeDriver();
    limitedDriver.queue('limited.png', null, MATCH);
    limitedDriver.queueFindDurations(70, 70);
    const limitedRunner = new AutomationRunner({
      formatVersion: 2, id: 'minimum-cycle', name: 'Minimum cycle',
      root: { type: 'sequence', steps: [{
        type: 'wait-image', asset: 'limited.png', timeoutMs: 500, minCycleMs: 100,
      }] },
    }, limitedDriver);
    await expect(limitedRunner.run()).resolves.toBe(true);
    expect(limitedDriver.calls).toEqual(['find:limited.png', 'sleep:30', 'find:limited.png']);

    const immediateDriver = new FakeDriver();
    immediateDriver.queue('immediate.png', null, MATCH);
    const immediateRunner = new AutomationRunner({
      formatVersion: 2, id: 'immediate-cycle', name: 'Immediate cycle',
      root: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'immediate.png', timeoutMs: 500 }] },
    }, immediateDriver);
    await expect(immediateRunner.run()).resolves.toBe(true);
    expect(immediateDriver.calls).toEqual(['find:immediate.png', 'find:immediate.png']);
  });

  it('intersects nested fast recognition regions and restores the outer region afterwards', async () => {
    const driver = new FakeDriver();
    for (const asset of ['outer.png', 'nested.png', 'restored.png', 'global.png']) driver.queue(asset, MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'scoped-vision', name: 'Scoped vision',
      searchRegion: { left: 1000, top: 1000, right: 9000, bottom: 9000 },
      root: { type: 'sequence', steps: [
        {
          type: 'vision-region', region: { left: 2000, top: 500, right: 8000, bottom: 8000 },
          body: { type: 'sequence', steps: [
            { type: 'wait-image', asset: 'outer.png' },
            {
              type: 'vision-region', region: { left: 3000, top: 3000, right: 9500, bottom: 7000 },
              body: { type: 'sequence', steps: [{ type: 'wait-image', asset: 'nested.png' }] },
            },
            { type: 'wait-image', asset: 'restored.png' },
            { type: 'click-coordinate', coordinate: { x: 5000, y: 5000 } },
          ] },
        },
        { type: 'wait-image', asset: 'global.png' },
      ] },
    }, driver);

    await expect(runner.run()).resolves.toBe(true);
    expect(driver.requests.map((request) => request.relativeRegion)).toEqual([
      { left: 2000, top: 1000, right: 8000, bottom: 8000 },
      { left: 3000, top: 3000, right: 8000, bottom: 7000 },
      { left: 2000, top: 1000, right: 8000, bottom: 8000 },
      { left: 1000, top: 1000, right: 9000, bottom: 9000 },
    ]);
    expect(driver.calls).toContain('click-point:5000,5000:left:1');
  });

  it('passes every member of an image group to the driver', async () => {
    const driver = new FakeDriver();
    driver.queue('角色/行走/left.png', { ...MATCH, asset: '角色/行走/right.png' });
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'image-group', name: 'Image group',
      root: { type: 'sequence', steps: [{
        type: 'click-image', asset: '角色/行走/left.png',
        alternatives: ['角色/行走/right.png', '角色/行走/up.png', '角色/行走/down.png'],
      }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.requests[0].alternatives).toEqual(['角色/行走/right.png', '角色/行走/up.png', '角色/行走/down.png']);
  });

  it('rechecks a target before clicking and rejects excessive movement', async () => {
    const driver = new FakeDriver();
    driver.queue('stable.png', MATCH, { ...MATCH, x: MATCH.x + 5 });
    const stable = new AutomationRunner({
      formatVersion: 2, id: 'verified-click', name: 'Verified click',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'stable.png', verifyBeforeClick: true, maxMovementPx: 8 }] },
    }, driver);
    await expect(stable.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['find:stable.png', 'find:stable.png', 'click:left:1:0,0']);

    const movingDriver = new FakeDriver();
    movingDriver.queue('moving.png', MATCH, { ...MATCH, x: MATCH.x + 30 });
    const moving = new AutomationRunner({
      formatVersion: 2, id: 'moving-click', name: 'Moving click',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'moving.png', verifyBeforeClick: true, maxMovementPx: 8 }] },
    }, movingDriver);
    await expect(moving.run()).rejects.toThrow(/moved/);
    expect(movingDriver.calls).toEqual(['find:moving.png', 'find:moving.png']);
  });

  it('cancels an in-progress standalone readiness check', async () => {
    const driver = new FakeDriver();
    driver.findImage = vi.fn(async (_request, signal) => new Promise<ImageMatch | null>((_resolve, reject) => {
      const fail = (): void => reject(new Error('automation cancelled'));
      signal.addEventListener('abort', fail, { once: true });
      if (signal.aborted) fail();
    }));
    const runner = new AutomationRunner(workflow, driver);
    const checking = runner.checkReady();
    await vi.waitFor(() => expect(runner.state).toBe('checking'));
    runner.cancel();
    await expect(checking).rejects.toThrow(/cancelled/);
    expect(runner.state).toBe('cancelled');
  });

  it('evaluates nested and/or/not conditions with short-circuiting', async () => {
    const driver = new FakeDriver();
    driver.queue('one.png', MATCH);
    driver.queue('two.png', null);
    driver.queue('three.png', MATCH);
    driver.queue('never-read.png', MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'boolean-conditions', name: 'Boolean conditions',
      root: { type: 'sequence', steps: [{
        type: 'if-condition',
        condition: {
          type: 'all', conditions: [
            { type: 'image-visible', asset: 'one.png' },
            { type: 'any', conditions: [
              { type: 'image-visible', asset: 'two.png' },
              { type: 'not', condition: { type: 'image-visible', asset: 'three.png' } },
            ] },
            { type: 'image-visible', asset: 'never-read.png' },
          ],
        },
        then: { type: 'sequence', steps: [{ type: 'key-press', key: 'T' }] },
        else: { type: 'sequence', steps: [{ type: 'key-press', key: 'F' }] },
      }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['find:one.png', 'find:two.png', 'find:three.png', 'key::F']);
  });

  it('waits and repeats with reusable combined conditions', async () => {
    const driver = new FakeDriver();
    driver.queue('wait-a.png', null, MATCH);
    driver.queue('wait-b.png', MATCH);
    driver.queue('loop-a.png', null, null, MATCH);
    driver.queue('loop-b.png', MATCH);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'condition-controls', name: 'Condition controls',
      root: { type: 'sequence', steps: [
        {
          type: 'wait-condition', timeoutMs: 100, minCycleMs: 25,
          condition: { type: 'all', conditions: [
            { type: 'image-visible', asset: 'wait-a.png' },
            { type: 'image-visible', asset: 'wait-b.png' },
          ] },
        },
        {
          type: 'repeat-until-condition', maxIterations: 3,
          condition: { type: 'any', conditions: [
            { type: 'image-visible', asset: 'loop-a.png' },
            { type: 'image-visible', asset: 'loop-b.png' },
          ] },
          body: { type: 'sequence', steps: [{ type: 'key-press', key: 'R' }] },
        },
      ] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual([
      'find:wait-a.png', 'sleep:25', 'find:wait-a.png', 'find:wait-b.png',
      'find:loop-a.png', 'find:loop-b.png',
    ]);
    expect(driver.frameScopes).toBe(3);
  });

  it('releases a held key when the image wait times out', async () => {
    const driver = new FakeDriver();
    driver.queue('never.png', null, null);
    const runner = new AutomationRunner({
      formatVersion: 2, id: 'hold-timeout', name: 'Hold timeout',
      root: { type: 'sequence', steps: [{
        type: 'key-hold-until-image', key: 'ArrowRight', asset: 'never.png', state: 'visible', timeoutMs: 50, minCycleMs: 50,
      }] },
    }, driver);
    await expect(runner.run()).rejects.toThrow(/timed out/);
    expect(driver.calls.at(-1)).toBe('key-up::ArrowRight');
  });

  it('enforces the execution budget', async () => {
    const driver = new FakeDriver();
    driver.queue('ready.png', MATCH);
    driver.queue('start.png', MATCH);
    driver.queue('reward.png', null);
    const runner = new AutomationRunner(workflow, driver, { maxExecutedSteps: 3 });
    await expect(runner.run()).rejects.toThrow(/step budget/);
    expect(runner.state).toBe('failed');
  });

  it('supports hidden waits, pointer/text/scroll/navigation and bounded repeat-until', async () => {
    const driver = new FakeDriver();
    driver.queue('visible.png', MATCH, null);
    driver.queue('pointer.png', MATCH);
    driver.queue('done.png', null, null, MATCH);
    const expanded: AutomationWorkflow = {
      formatVersion: 2, id: 'expanded', name: 'Expanded',
      root: { type: 'sequence', steps: [
        { type: 'wait-image-state', asset: 'visible.png', state: 'hidden', timeoutMs: 200, minCycleMs: 50 },
        { type: 'move-to-image', asset: 'pointer.png', offset: { x: 4, y: 5 } },
        { type: 'text-input', text: '你好', intervalMs: 10 },
        { type: 'scroll', deltaX: 0, deltaY: 480 },
        { type: 'navigate', url: 'https://example.com/game' },
        { type: 'reload' },
        { type: 'log', message: 'looping' },
        {
          type: 'repeat-until-image', until: 'visible', maxIterations: 3, delayMs: 20,
          condition: { type: 'image-visible', asset: 'done.png' },
          body: { type: 'sequence', steps: [{ type: 'key-press', key: 'Space' }] },
        },
      ] },
    };
    const runner = new AutomationRunner(expanded, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toContain('move:4,5');
    expect(driver.calls).toContain('text:10:你好');
    expect(driver.calls).toContain('scroll:0,480');
    expect(driver.calls).toContain('navigate:https://example.com/game');
    expect(driver.calls).toContain('reload');
    expect(driver.calls).toContain('log:looping');
    expect(driver.calls.filter((call) => call === 'key::Space')).toHaveLength(2);
  });

  it('pauses before each action in step mode and resumes one action at a time', async () => {
    const driver = new FakeDriver();
    const paused: string[] = [];
    const stepped: AutomationWorkflow = {
      formatVersion: 2, id: 'stepped', name: 'Stepped',
      root: { type: 'sequence', steps: [
        { type: 'key-press', key: 'A' },
        { type: 'delay', durationMs: 10 },
        { type: 'key-press', key: 'B' },
      ] },
    };
    const runner = new AutomationRunner(stepped, driver, {
      onEvent: (event) => { if (event.type === 'step-paused') paused.push(event.step.type); },
    });
    const run = runner.run({ stepMode: true });
    await vi.waitFor(() => expect(paused).toEqual(['delay']));
    expect(driver.calls).toEqual(['key::A']);
    runner.continueStep();
    await vi.waitFor(() => expect(paused).toEqual(['delay', 'key-press']));
    expect(driver.calls).toEqual(['key::A', 'sleep:10']);
    runner.continueStep();
    await expect(run).resolves.toBe(true);
    expect(driver.calls).toEqual(['key::A', 'sleep:10', 'key::B']);
  });
});
