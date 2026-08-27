import { createActor, createMachine } from 'xstate';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';
import type {
  AutomationCoordinate,
  AutomationPointerTarget,
  AutomationRelativeRegion,
  AutomationImageMask,
  AutomationRegion,
  AutomationCondition,
  AutomationStep,
  AutomationWorkflow,
  ClickImageStep,
  KeyHoldUntilImageStep,
  MoveToImageStep,
  PositionCompareTarget,
  WaitImageStep,
  WaitImageStateStep,
} from '../../../shared/automation/types';
import { parseAutomationWorkflow } from '../../../shared/automation/schema';

export type ImageMatch = {
  asset?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
  scale?: number;
  matchMs?: number;
  captureMs?: number;
  bitmapMs?: number;
  totalMs?: number;
  sceneBytes?: number;
  wasmHeapBytes?: number;
  templateCacheBytes?: number;
  templateCacheEntries?: number;
  testedScales?: number[];
  masked?: boolean;
  lowVariance?: boolean;
  templateStdDev?: number;
};

export type FindImageRequest = {
  asset: string;
  alternatives?: string[];
  threshold: number;
  region?: AutomationRegion;
  relativeRegion?: AutomationRelativeRegion;
  scales?: number[];
  mask?: AutomationImageMask;
};

export type AutomationDriver = {
  findImage(request: FindImageRequest, signal: AbortSignal): Promise<ImageMatch | null>;
  resolveTargetPoint(target: PositionCompareTarget, signal: AbortSignal, relativeRegion?: AutomationRelativeRegion): Promise<{ x: number; y: number }>;
  getCssViewport(): { width: number; height: number };
  click(
    match: ImageMatch,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number; offset: { x: number; y: number } },
    signal: AbortSignal,
  ): Promise<void>;
  moveTo(match: ImageMatch, offset: { x: number; y: number }, signal: AbortSignal): Promise<void>;
  moveToPoint(coordinate: AutomationCoordinate, signal: AbortSignal): Promise<void>;
  drag(
    source: ImageMatch,
    target: ImageMatch,
    options: { button: 'left' | 'right' | 'middle'; durationMs: number },
    signal: AbortSignal,
  ): Promise<void>;
  dragTargets(
    source: AutomationDriverPointerTarget,
    target: AutomationDriverPointerTarget,
    options: { button: 'left' | 'right' | 'middle'; durationMs: number },
    signal: AbortSignal,
  ): Promise<void>;
  clickPoint(
    coordinate: AutomationCoordinate,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number },
    signal: AbortSignal,
  ): Promise<void>;
  pressKey(key: string, modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>, signal: AbortSignal): Promise<void>;
  keyDown(key: string, modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>, signal: AbortSignal): Promise<void>;
  keyUp(key: string, modifiers: Array<'alt' | 'control' | 'meta' | 'shift'>, signal: AbortSignal): Promise<void>;
  typeText(text: string, intervalMs: number, signal: AbortSignal): Promise<void>;
  scroll(deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>;
  navigate(url: string, signal: AbortSignal): Promise<void>;
  reload(signal: AbortSignal): Promise<void>;
  log(message: string): void;
  notify(title: string, body: string): void;
  sleep(durationMs: number, signal: AbortSignal): Promise<void>;
  now(): number;
};

export type AutomationRuntimeEvent =
  | { type: 'state'; state: AutomationRunnerState }
  | { type: 'step-start'; step: AutomationStep; executedSteps: number }
  | { type: 'step-paused'; step: AutomationStep; nextStep: number }
  | { type: 'image-match'; asset: string; match: ImageMatch }
  | { type: 'image-miss'; asset: string }
  | { type: 'random-click-coordinate'; coordinate: AutomationCoordinate }
  | { type: 'log'; message: string };

export type AutomationRunnerState =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'countdown'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

const lifecycleMachine = createMachine({
  initial: 'idle',
  states: {
    idle: { on: { CHECK: 'checking' } },
    checking: { on: { READY: 'ready', NOT_READY: 'idle', FAIL: 'failed', CANCEL: 'cancelled' } },
    ready: { on: { COUNTDOWN: 'countdown', START: 'running', CHECK: 'checking', CANCEL: 'cancelled' } },
    countdown: { on: { START: 'running', FAIL: 'failed', CANCEL: 'cancelled' } },
    running: { on: { COMPLETE: 'completed', FAIL: 'failed', CANCEL: 'cancelled' } },
    completed: { on: { RESET: 'idle' } },
    failed: { on: { RESET: 'idle' } },
    cancelled: { on: { RESET: 'idle' } },
  },
});

export type AutomationRunnerOptions = {
  maxExecutedSteps?: number;
  maxDepth?: number;
  random?: () => number;
  onEvent?: (event: AutomationRuntimeEvent) => void;
};

export type AutomationDriverPointerTarget =
  | { kind: 'coordinate'; coordinate: AutomationCoordinate }
  | { kind: 'match'; match: ImageMatch };

export type AutomationRunOptions = {
  countdownMs?: number;
  signal?: AbortSignal;
  stepMode?: boolean;
};

// Keep runtime matching aligned with the test bench and the page assistant.
// A BrowserView capture can differ from a cropped source asset because of DPI,
// page zoom, or responsive layout, so exact 1:1 matching is too brittle.
export const DEFAULT_AUTOMATION_IMAGE_SCALES = [0.75, 1, 1.25] as const;

function imageScales(scales?: number[]): number[] {
  return scales ?? [...DEFAULT_AUTOMATION_IMAGE_SCALES];
}

export function intersectAutomationRelativeRegions(
  outer: AutomationRelativeRegion | undefined,
  inner: AutomationRelativeRegion,
): AutomationRelativeRegion {
  if (!outer) return { ...inner };
  const result = {
    left: Math.max(outer.left, inner.left),
    top: Math.max(outer.top, inner.top),
    right: Math.min(outer.right, inner.right),
    bottom: Math.min(outer.bottom, inner.bottom),
  };
  if (result.left >= result.right || result.top >= result.bottom) {
    throw new Error('vision region does not overlap its parent search region');
  }
  return result;
}

class AutomationEndSignal extends Error {
  constructor(readonly result: 'success' | 'failure', message?: string) {
    super(message || (result === 'success' ? 'script ended successfully' : 'script ended with failure'));
  }
}

export class AutomationRunner {
  private readonly workflow: AutomationWorkflow;
  private readonly driver: AutomationDriver;
  private readonly searchRegion: AutomationRelativeRegion | undefined;
  private activeSearchRegion: AutomationRelativeRegion | undefined;
  private readonly maxExecutedSteps: number;
  private readonly maxDepth: number;
  private readonly random: () => number;
  private readonly onEvent?: (event: AutomationRuntimeEvent) => void;
  private actor = createActor(lifecycleMachine);
  private controller: AbortController | null = null;
  private executedSteps = 0;
  private stepMode = false;
  private stepPermits = 0;
  private releaseStep: (() => void) | null = null;

  constructor(workflow: AutomationWorkflow, driver: AutomationDriver, options: AutomationRunnerOptions = {}) {
    this.workflow = parseAutomationWorkflow(workflow);
    this.driver = driver;
    this.searchRegion = this.workflow.searchRegion;
    this.activeSearchRegion = this.searchRegion;
    this.maxExecutedSteps = options.maxExecutedSteps ?? 10_000;
    this.maxDepth = options.maxDepth ?? 32;
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent;
    this.actor.start();
  }

  get state(): AutomationRunnerState {
    return String(this.actor.getSnapshot().value) as AutomationRunnerState;
  }

  async checkReady(signal?: AbortSignal): Promise<boolean> {
    if (this.state !== 'idle' && this.state !== 'ready') throw new Error(`cannot check readiness while ${this.state}`);
    const ownedController = signal ? null : createAutomationAbortController();
    const activeSignal = signal ?? ownedController!.signal;
    if (ownedController) this.controller = ownedController;
    this.send('CHECK');
    try {
      const ready = !this.workflow.readyWhen || await this.findCondition(this.workflow.readyWhen, activeSignal);
      this.send(ready ? 'READY' : 'NOT_READY');
      return ready;
    } catch (error) {
      if (activeSignal.aborted) {
        if (String(this.state) !== 'cancelled') this.send('CANCEL');
      } else this.send('FAIL');
      throw error;
    } finally {
      if (ownedController && this.controller === ownedController) this.controller = null;
    }
  }

  async run(options: AutomationRunOptions = {}): Promise<boolean> {
    if (this.state === 'completed' || this.state === 'failed' || this.state === 'cancelled') this.send('RESET');
    this.controller = createAutomationAbortController();
    const signal = this.controller.signal;
    const forwardAbort = (): void => this.controller?.abort();
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
    this.executedSteps = 0;
    this.activeSearchRegion = this.searchRegion;
    this.stepMode = options.stepMode ?? false;
    this.stepPermits = this.stepMode ? 1 : 0;
    try {
      if (this.state === 'idle' && !await this.checkReady(signal)) return false;
      if (this.state !== 'ready') throw new Error(`cannot start while ${this.state}`);
      const countdownMs = options.countdownMs ?? 0;
      if (countdownMs > 0) {
        this.send('COUNTDOWN');
        await this.driver.sleep(countdownMs, signal);
      }
      this.throwIfAborted(signal);
      this.send('START');
      try {
        await this.execute(this.workflow.root, signal, 0);
      } catch (error) {
        if (error instanceof AutomationEndSignal && error.result === 'success') {
          this.send('COMPLETE');
          return true;
        }
        throw error;
      }
      this.send('COMPLETE');
      return true;
    } catch (error) {
      if (signal.aborted) {
        if (String(this.state) !== 'cancelled') this.send('CANCEL');
      } else this.send('FAIL');
      throw error;
    } finally {
      options.signal?.removeEventListener('abort', forwardAbort);
      this.controller = null;
      this.stepMode = false;
      this.stepPermits = 0;
      this.releaseStep = null;
    }
  }

  continueStep(): void {
    if (!this.stepMode || this.state !== 'running') throw new Error('automation is not paused in step mode');
    this.stepPermits += 1;
    this.releaseStep?.();
    this.releaseStep = null;
  }

  cancel(): void {
    this.controller?.abort();
    this.releaseStep?.();
    this.releaseStep = null;
    if (this.state === 'checking' || this.state === 'ready' || this.state === 'countdown' || this.state === 'running') {
      this.send('CANCEL');
    }
  }

  private send(type: 'CHECK' | 'READY' | 'NOT_READY' | 'COUNTDOWN' | 'START' | 'COMPLETE' | 'FAIL' | 'CANCEL' | 'RESET'): void {
    this.actor.send({ type });
    this.onEvent?.({ type: 'state', state: this.state });
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error('automation cancelled');
  }

  private async findCondition(condition: AutomationCondition, signal: AbortSignal, depth = 0): Promise<boolean> {
    this.throwIfAborted(signal);
    if (depth > this.maxDepth) throw new Error(`automation condition nesting exceeds ${this.maxDepth}`);
    if (condition.type === 'all') {
      for (const child of condition.conditions) if (!await this.findCondition(child, signal, depth + 1)) return false;
      return true;
    }
    if (condition.type === 'any') {
      for (const child of condition.conditions) if (await this.findCondition(child, signal, depth + 1)) return true;
      return false;
    }
    if (condition.type === 'not') return !await this.findCondition(condition.condition, signal, depth + 1);
    if (condition.type === 'position-relation') return this.evaluatePositionRelation(condition.targetA, condition.targetB, condition.relation, condition.tolerancePx, signal);
    const match = await this.driver.findImage({
      asset: condition.asset,
      alternatives: condition.alternatives,
      threshold: condition.threshold ?? 0.9,
      region: condition.region,
      relativeRegion: condition.region ? undefined : this.activeSearchRegion,
      scales: imageScales(condition.scales),
      mask: condition.mask ?? 'auto',
    }, signal);
    if (match) this.onEvent?.({ type: 'image-match', asset: match.asset ?? condition.asset, match });
    else this.onEvent?.({ type: 'image-miss', asset: condition.asset });
    return Boolean(match);
  }

  private async evaluatePositionRelation(
    targetA: PositionCompareTarget,
    targetB: PositionCompareTarget,
    relation: string,
    tolerancePx: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const pointA = await this.driver.resolveTargetPoint(targetA, signal, this.activeSearchRegion);
    const pointB = await this.driver.resolveTargetPoint(targetB, signal, this.activeSearchRegion);
    const cssViewport = this.driver.getCssViewport();
    const toleranceRelativeX = (tolerancePx / cssViewport.width) * 10_000;
    const toleranceRelativeY = (tolerancePx / cssViewport.height) * 10_000;
    switch (relation) {
      case 'vertical': return Math.abs(pointA.x - pointB.x) <= toleranceRelativeX;
      case 'horizontal': return Math.abs(pointA.y - pointB.y) <= toleranceRelativeY;
      case 'overlap': return Math.hypot(pointA.x - pointB.x, pointA.y - pointB.y) <= Math.hypot(toleranceRelativeX, toleranceRelativeY);
      default: throw new Error(`unknown position relation: ${relation}`);
    }
  }

  private async waitForImage(step: WaitImageStep | WaitImageStateStep | ClickImageStep | MoveToImageStep | KeyHoldUntilImageStep, signal: AbortSignal): Promise<ImageMatch> {
    const timeoutMs = step.timeoutMs ?? 10_000;
    const pollMs = step.pollMs ?? 200;
    const deadline = this.driver.now() + timeoutMs;
    while (true) {
      this.throwIfAborted(signal);
      const match = await this.driver.findImage({
        asset: step.asset,
        alternatives: step.alternatives,
        threshold: step.threshold ?? 0.9,
        region: step.region,
        relativeRegion: step.region ? undefined : this.activeSearchRegion,
        scales: imageScales(step.scales),
        mask: step.mask ?? 'auto',
      }, signal);
      if (match) {
        this.onEvent?.({ type: 'image-match', asset: match.asset ?? step.asset, match });
        return match;
      }
      this.onEvent?.({ type: 'image-miss', asset: step.asset });
      const remaining = deadline - this.driver.now();
      if (remaining <= 0) throw new Error(`timed out waiting for image: ${step.asset}`);
      await this.driver.sleep(Math.min(pollMs, remaining), signal);
    }
  }

  private async waitForImageState(step: WaitImageStateStep | KeyHoldUntilImageStep, signal: AbortSignal): Promise<void> {
    if (step.state === 'visible') {
      await this.waitForImage(step, signal);
      return;
    }
    const timeoutMs = step.timeoutMs ?? 10_000;
    const pollMs = step.pollMs ?? 200;
    const deadline = this.driver.now() + timeoutMs;
    while (true) {
      this.throwIfAborted(signal);
      const visible = await this.findCondition({
        type: 'image-visible', asset: step.asset, threshold: step.threshold, region: step.region,
        alternatives: step.alternatives, scales: step.scales, mask: step.mask ?? 'auto',
      }, signal);
      if (!visible) return;
      const remaining = deadline - this.driver.now();
      if (remaining <= 0) throw new Error(`timed out waiting for image to disappear: ${step.asset}`);
      await this.driver.sleep(Math.min(pollMs, remaining), signal);
    }
  }

  private async waitForConditionResult(condition: AutomationCondition, timeoutMs: number, pollMs: number, signal: AbortSignal): Promise<boolean> {
    const deadline = this.driver.now() + timeoutMs;
    while (true) {
      this.throwIfAborted(signal);
      if (await this.findCondition(condition, signal)) return true;
      const remaining = deadline - this.driver.now();
      if (remaining <= 0) return false;
      await this.driver.sleep(Math.min(pollMs, remaining), signal);
    }
  }

  private async waitForCondition(condition: AutomationCondition, timeoutMs: number, pollMs: number, signal: AbortSignal): Promise<void> {
    if (!await this.waitForConditionResult(condition, timeoutMs, pollMs, signal)) throw new Error('timed out waiting for combined condition');
  }

  private async resolvePointerTarget(target: AutomationPointerTarget, timeoutMs: number | undefined, pollMs: number | undefined, signal: AbortSignal): Promise<AutomationDriverPointerTarget> {
    if (target.kind === 'coordinate') return target;
    const match = await this.waitForImage({ ...target.condition, type: 'wait-image', timeoutMs, pollMs }, signal);
    return { kind: 'match', match };
  }

  private async execute(step: AutomationStep, signal: AbortSignal, depth: number): Promise<void> {
    this.throwIfAborted(signal);
    if (depth > this.maxDepth) throw new Error(`automation nesting exceeds ${this.maxDepth}`);
    if (this.stepMode && step.type !== 'sequence') await this.waitForStepPermit(step, signal);
    this.executedSteps += 1;
    if (this.executedSteps > this.maxExecutedSteps) throw new Error(`automation step budget exceeds ${this.maxExecutedSteps}`);
    this.onEvent?.({ type: 'step-start', step, executedSteps: this.executedSteps });

    switch (step.type) {
      case 'sequence':
        for (const child of step.steps) await this.execute(child, signal, depth + 1);
        return;
      case 'delay':
        await this.driver.sleep(step.durationMs, signal);
        return;
      case 'wait-image':
        await this.waitForImage(step, signal);
        return;
      case 'wait-image-state':
        await this.waitForImageState(step, signal);
        return;
      case 'click-image': {
        const match = await this.waitForImage(step, signal);
        let clickMatch = match;
        if (step.verifyBeforeClick) {
          const verified = await this.driver.findImage({
            asset: step.asset, threshold: step.threshold ?? 0.9, region: step.region,
            relativeRegion: step.region ? undefined : this.activeSearchRegion,
            alternatives: step.alternatives, scales: imageScales(step.scales), mask: step.mask ?? 'auto',
          }, signal);
          if (!verified) throw new Error(`image disappeared before click: ${step.asset}`);
          const firstX = match.x + match.width / 2; const firstY = match.y + match.height / 2;
          const nextX = verified.x + verified.width / 2; const nextY = verified.y + verified.height / 2;
          const movement = Math.hypot(nextX - firstX, nextY - firstY);
          if (movement > (step.maxMovementPx ?? 12)) throw new Error(`image moved ${movement.toFixed(1)}px before click: ${step.asset}`);
          clickMatch = verified;
        }
        await this.driver.click(clickMatch, {
          button: step.button ?? 'left',
          clickCount: step.clickCount ?? 1,
          offset: step.offset ?? { x: 0, y: 0 },
        }, signal);
        return;
      }
      case 'key-press':
        await this.driver.pressKey(step.key, step.modifiers ?? [], signal);
        return;
      case 'key-hold-until-image': {
        const modifiers = step.modifiers ?? [];
        await this.driver.keyDown(step.key, modifiers, signal);
        try {
          await this.waitForImageState(step, signal);
        } finally {
          await this.driver.keyUp(step.key, modifiers, createAutomationAbortController().signal);
        }
        return;
      }
      case 'move-to-image': {
        const match = await this.waitForImage(step, signal);
        await this.driver.moveTo(match, step.offset ?? { x: 0, y: 0 }, signal);
        return;
      }
      case 'move-to-coordinate':
        await this.driver.moveToPoint(step.coordinate, signal);
        return;
      case 'click-coordinate':
        await this.driver.clickPoint(step.coordinate, {
          button: step.button ?? 'left', clickCount: step.clickCount ?? 1,
        }, signal);
        return;
      case 'random-click-region': {
        const padding = step.padding ?? 0;
        const sample = (minimum: number, maximumExclusive: number): number => {
          const value = this.random();
          if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('random source must return a number from 0 (inclusive) to 1 (exclusive)');
          return minimum + Math.floor(value * (maximumExclusive - minimum));
        };
        const coordinate = {
          x: sample(step.region.left + padding, step.region.right - padding),
          y: sample(step.region.top + padding, step.region.bottom - padding),
        };
        const message = `random click coordinate ${coordinate.x},${coordinate.y}`;
        this.driver.log(message);
        this.onEvent?.({ type: 'random-click-coordinate', coordinate });
        await this.driver.clickPoint(coordinate, {
          button: step.button ?? 'left', clickCount: step.clickCount ?? 2,
        }, signal);
        return;
      }
      case 'vision-region': {
        const previousRegion = this.activeSearchRegion;
        this.activeSearchRegion = intersectAutomationRelativeRegions(previousRegion, step.region);
        try {
          await this.execute(step.body, signal, depth + 1);
        } finally {
          this.activeSearchRegion = previousRegion;
        }
        return;
      }
      case 'drag-image': {
        const waitOptions = { timeoutMs: step.timeoutMs, pollMs: step.pollMs };
        const source = await this.waitForImage({ ...step.source, ...waitOptions, type: 'wait-image' }, signal);
        const target = await this.waitForImage({ ...step.target, ...waitOptions, type: 'wait-image' }, signal);
        await this.driver.drag(source, target, {
          button: step.button ?? 'left',
          durationMs: step.durationMs ?? 800,
        }, signal);
        return;
      }
      case 'drag': {
        const source = await this.resolvePointerTarget(step.source, step.timeoutMs, step.pollMs, signal);
        const target = await this.resolvePointerTarget(step.target, step.timeoutMs, step.pollMs, signal);
        await this.driver.dragTargets(source, target, {
          button: step.button ?? 'left', durationMs: step.durationMs ?? 800,
        }, signal);
        return;
      }
      case 'text-input':
        await this.driver.typeText(step.text, step.intervalMs ?? 0, signal);
        return;
      case 'scroll':
        await this.driver.scroll(step.deltaX, step.deltaY, signal);
        return;
      case 'navigate':
        await this.driver.navigate(step.url, signal);
        return;
      case 'reload':
        await this.driver.reload(signal);
        return;
      case 'log':
        this.driver.log(step.message);
        this.onEvent?.({ type: 'log', message: step.message });
        return;
      case 'notification':
        this.driver.notify(step.title, step.body);
        return;
      case 'if-image': {
        const found = await this.findCondition(step.condition, signal);
        const branch = (step.negate ? !found : found) ? step.then : step.else;
        if (branch) await this.execute(branch, signal, depth + 1);
        return;
      }
      case 'if-condition': {
        const branch = await this.findCondition(step.condition, signal) ? step.then : step.else;
        if (branch) await this.execute(branch, signal, depth + 1);
        return;
      }
      case 'wait-condition':
        await this.waitForCondition(step.condition, step.timeoutMs ?? 10_000, step.pollMs ?? 200, signal);
        return;
      case 'wait-condition-branch': {
        const matched = await this.waitForConditionResult(step.condition, step.timeoutMs ?? 10_000, step.pollMs ?? 200, signal);
        await this.execute(matched ? step.success : step.timeout, signal, depth + 1);
        return;
      }
      case 'end':
        throw new AutomationEndSignal(step.result, step.message);
      case 'repeat':
        for (let index = 0; index < step.times; index += 1) await this.execute(step.body, signal, depth + 1);
        return;
      case 'repeat-until-image':
        for (let index = 0; index <= step.maxIterations; index += 1) {
          const visible = await this.findCondition(step.condition, signal);
          if ((step.until === 'visible' && visible) || (step.until === 'hidden' && !visible)) return;
          if (index === step.maxIterations) break;
          await this.execute(step.body, signal, depth + 1);
          if (step.delayMs) await this.driver.sleep(step.delayMs, signal);
        }
        throw new Error(`repeat-until condition not met after ${step.maxIterations} iterations: ${step.condition.asset}`);
      case 'repeat-until-condition':
        for (let index = 0; index <= step.maxIterations; index += 1) {
          if (await this.findCondition(step.condition, signal)) return;
          if (index === step.maxIterations) break;
          await this.execute(step.body, signal, depth + 1);
          if (step.delayMs) await this.driver.sleep(step.delayMs, signal);
        }
        throw new Error(`combined repeat-until condition not met after ${step.maxIterations} iterations`);
      case 'position-compare': {
        const matched = await this.evaluatePositionRelation(step.targetA, step.targetB, step.relation, step.tolerancePx, signal);
        const branch = matched ? step.then : step.else;
        if (branch) await this.execute(branch, signal, depth + 1);
        return;
      }
    }
  }

  private async waitForStepPermit(step: AutomationStep, signal: AbortSignal): Promise<void> {
    if (this.stepPermits > 0) { this.stepPermits -= 1; return; }
    this.onEvent?.({ type: 'step-paused', step, nextStep: this.executedSteps + 1 });
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => { cleanup(); reject(new Error('automation cancelled')); };
      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort);
        if (this.releaseStep === release) this.releaseStep = null;
      };
      const release = (): void => { cleanup(); resolve(); };
      this.releaseStep = release;
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    this.throwIfAborted(signal);
    if (this.stepPermits > 0) this.stepPermits -= 1;
  }
}
