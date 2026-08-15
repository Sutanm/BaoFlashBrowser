import { describe, expect, it, vi } from 'vitest';
import { AutomationRunner, type AutomationDriver, type FindImageRequest, type ImageMatch } from '../src/main/modules/automation/runtime';
import type { AutomationWorkflow } from '../src/shared/automation/types';

const MATCH: ImageMatch = { x: 100, y: 80, width: 40, height: 20, score: 0.97 };

class FakeDriver implements AutomationDriver {
  time = 0;
  readonly calls: string[] = [];
  readonly requests: FindImageRequest[] = [];
  readonly answers = new Map<string, Array<ImageMatch | null>>();

  queue(asset: string, ...answers: Array<ImageMatch | null>): void {
    this.answers.set(asset, answers);
  }

  async findImage(request: FindImageRequest): Promise<ImageMatch | null> {
    this.calls.push(`find:${request.asset}`);
    this.requests.push(request);
    return this.answers.get(request.asset)?.shift() ?? null;
  }

  async click(_match: ImageMatch, options: { button: string; clickCount: number; offset: { x: number; y: number } }): Promise<void> {
    this.calls.push(`click:${options.button}:${options.clickCount}:${options.offset.x},${options.offset.y}`);
  }

  async moveTo(_match: ImageMatch, offset: { x: number; y: number }): Promise<void> {
    this.calls.push(`move:${offset.x},${offset.y}`);
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

  async sleep(durationMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('automation cancelled');
    this.calls.push(`sleep:${durationMs}`);
    this.time += durationMs;
  }

  now(): number { return this.time; }
}

const workflow: AutomationWorkflow = {
  formatVersion: 1,
  id: 'runtime-demo',
  name: 'Runtime demo',
  readyWhen: { type: 'image-visible', asset: 'ready.png' },
  root: {
    type: 'sequence',
    steps: [
      { type: 'click-image', asset: 'start.png', timeoutMs: 500, pollMs: 100, offset: { x: 3, y: -2 } },
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
      formatVersion: 1, id: 'unconditional', name: 'Unconditional',
      root: { type: 'sequence', steps: [{ type: 'key-press', key: 'A', modifiers: ['control', 'shift'] }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['key:control+shift:A']);
  });

  it('holds a key until the image state matches and always releases it', async () => {
    const driver = new FakeDriver();
    driver.queue('done.png', null, MATCH);
    const runner = new AutomationRunner({
      formatVersion: 1, id: 'hold-key', name: 'Hold key',
      root: { type: 'sequence', steps: [{
        type: 'key-hold-until-image', key: 'Space', modifiers: ['shift'], asset: 'done.png',
        state: 'visible', timeoutMs: 100, pollMs: 50,
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
      formatVersion: 1, id: 'default-scales', name: 'Default scales',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'button.png' }] },
    }, driver);
    await expect(runner.run()).resolves.toBe(true);
    expect(driver.requests[0].scales).toEqual([0.75, 1, 1.25]);
    expect(driver.requests[0].mask).toBe('auto');
  });

  it('passes every member of an image group to the driver', async () => {
    const driver = new FakeDriver();
    driver.queue('角色/行走/left.png', { ...MATCH, asset: '角色/行走/right.png' });
    const runner = new AutomationRunner({
      formatVersion: 1, id: 'image-group', name: 'Image group',
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
      formatVersion: 1, id: 'verified-click', name: 'Verified click',
      root: { type: 'sequence', steps: [{ type: 'click-image', asset: 'stable.png', verifyBeforeClick: true, maxMovementPx: 8 }] },
    }, driver);
    await expect(stable.run()).resolves.toBe(true);
    expect(driver.calls).toEqual(['find:stable.png', 'find:stable.png', 'click:left:1:0,0']);

    const movingDriver = new FakeDriver();
    movingDriver.queue('moving.png', MATCH, { ...MATCH, x: MATCH.x + 30 });
    const moving = new AutomationRunner({
      formatVersion: 1, id: 'moving-click', name: 'Moving click',
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
      formatVersion: 1, id: 'boolean-conditions', name: 'Boolean conditions',
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
      formatVersion: 1, id: 'condition-controls', name: 'Condition controls',
      root: { type: 'sequence', steps: [
        {
          type: 'wait-condition', timeoutMs: 100, pollMs: 25,
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
  });

  it('releases a held key when the image wait times out', async () => {
    const driver = new FakeDriver();
    driver.queue('never.png', null, null);
    const runner = new AutomationRunner({
      formatVersion: 1, id: 'hold-timeout', name: 'Hold timeout',
      root: { type: 'sequence', steps: [{
        type: 'key-hold-until-image', key: 'ArrowRight', asset: 'never.png', state: 'visible', timeoutMs: 50, pollMs: 50,
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
      formatVersion: 1, id: 'expanded', name: 'Expanded',
      root: { type: 'sequence', steps: [
        { type: 'wait-image-state', asset: 'visible.png', state: 'hidden', timeoutMs: 200, pollMs: 50 },
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
      formatVersion: 1, id: 'stepped', name: 'Stepped',
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
