import {
  AutomationActionRegistry,
  AutomationLocatorQueries,
  type ActionContext,
  type LocatedTarget,
} from '../../../shared/automation/core';
import type { PersistedRegion } from '../../../shared/automation/core/surface';
import type { ScriptLocatedTarget } from '../../../shared/automation/javascript-api';
import type { JavaScriptAutomationHostPorts } from './javascript-capability-broker';
import type { RegionChangeOptions, RegionChangeResult, RegionColorOptions, RegionColorResult } from './region-change-detector';

export type JavaScriptAutomationServicePorts = {
  readonly actions: AutomationActionRegistry;
  readonly locators: AutomationLocatorQueries;
  readonly context: (signal: AbortSignal) => ActionContext;
  readonly input: {
    keyPress(key: string, modifiers: readonly ('alt' | 'control' | 'meta' | 'shift')[], signal: AbortSignal): Promise<void>;
    typeText(text: string, intervalMs: number, signal: AbortSignal): Promise<void>;
    scroll(deltaX: number, deltaY: number, signal: AbortSignal): Promise<void>;
  };
  readonly ocr: {
    readText(region: PersistedRegion | undefined, minConfidence: number | undefined, context: ActionContext): Promise<string>;
    readNumber(region: PersistedRegion | undefined, locale: string | undefined, context: ActionContext): Promise<number>;
  };
  readonly vision: {
    waitForRegionChange(region: PersistedRegion, options: RegionChangeOptions, context: ActionContext): Promise<RegionChangeResult>;
    waitForColor(region: PersistedRegion, options: RegionColorOptions, context: ActionContext): Promise<RegionColorResult>;
  };
  readonly page: {
    url(): string;
    navigate(url: string, signal: AbortSignal): Promise<void>;
    reload(signal: AbortSignal): Promise<void>;
  };
  readonly time: { sleep(durationMs: number, signal: AbortSignal): Promise<void>; now(): number };
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly notify: (title: string, body?: string) => void;
};

export function scriptTarget(target: LocatedTarget, context: ActionContext): ScriptLocatedTarget {
  // Recognition backends report viewport geometry. The public JavaScript API,
  // however, accepts persisted points/regions in the active Context space.
  // Return values in that same space so a script can safely feed a found point
  // back into another locator without applying the surface offset twice.
  const activationPoint = context.coordinateResolver.convert(target.activationPoint, context.currentSpace);
  const bounds = target.bounds
    ? context.coordinateResolver.convert(target.bounds, context.currentSpace)
    : undefined;
  const ratioPoint = context.coordinateResolver.convert(target.activationPoint, context.currentSpace, 'ratio');
  const ratioBounds = target.bounds
    ? context.coordinateResolver.convert(target.bounds, context.currentSpace, 'ratio')
    : undefined;
  return {
    point: { x: activationPoint.x, y: activationPoint.y },
    bounds: bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : undefined,
    ratioPoint: { x: ratioPoint.x, y: ratioPoint.y },
    ratioBounds: ratioBounds ? { x: ratioBounds.x, y: ratioBounds.y, width: ratioBounds.width, height: ratioBounds.height } : undefined,
    confidence: target.confidence,
  };
}

function isTargetNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'TARGET_NOT_FOUND');
}

/** Maps the public JavaScript API to the same Core registries/services used by other frontends. */
export function createJavaScriptAutomationHostPorts(services: JavaScriptAutomationServicePorts): JavaScriptAutomationHostPorts {
  return {
    'input.click': async (params, signal) => { await services.actions.execute({ kind: 'click', target: params.target, button: params.button, count: params.count, timeoutMs: params.timeoutMs, pollIntervalMs: params.pollIntervalMs }, services.context(signal)); return null; },
    'input.move': async (params, signal) => { await services.actions.execute({ kind: 'move', target: params.target, durationMs: params.durationMs, timeoutMs: params.timeoutMs, pollIntervalMs: params.pollIntervalMs }, services.context(signal)); return null; },
    'input.drag': async (params, signal) => { await services.actions.execute({ kind: 'drag', from: params.from, to: params.to, button: params.button, durationMs: params.durationMs, timeoutMs: params.timeoutMs, pollIntervalMs: params.pollIntervalMs }, services.context(signal)); return null; },
    'input.keyPress': async (params, signal) => { await services.input.keyPress(params.key, params.modifiers ?? [], signal); return null; },
    'input.typeText': async (params, signal) => { await services.input.typeText(params.text, params.intervalMs ?? 0, signal); return null; },
    'input.scroll': async (params, signal) => { await services.input.scroll(params.deltaX, params.deltaY, signal); return null; },
    'vision.find': async (params, signal) => {
      const context = services.context(signal);
      try { return scriptTarget(await services.locators.find({ locator: params.locator }, context), context); }
      catch (error) { if (isTargetNotFound(error)) return null; throw error; }
    },
    'vision.exists': (params, signal) => services.locators.exists(params.locator, services.context(signal)),
    'vision.waitForRegionChange': (params, signal) => services.vision.waitForRegionChange(params.region, {
      timeoutMs: params.timeoutMs ?? 10_000,
      pollIntervalMs: params.pollIntervalMs ?? 10,
      colorDelta: params.colorDelta ?? 32,
      minimumChangedPixels: params.minimumChangedPixels ?? 2,
      changedPixelRatio: params.changedPixelRatio ?? .02,
      consecutiveFrames: params.consecutiveFrames ?? 1,
      reference: params.reference ?? 'baseline',
    }, services.context(signal)),
    'vision.waitForColor': (params, signal) => services.vision.waitForColor(params.region, {
      colors: params.colors.map((value) => {
        const hex = value.startsWith('#') ? value.slice(1) : value;
        return { red: Number.parseInt(hex.slice(0, 2), 16), green: Number.parseInt(hex.slice(2, 4), 16), blue: Number.parseInt(hex.slice(4, 6), 16) };
      }),
      timeoutMs: params.timeoutMs ?? 10_000,
      pollIntervalMs: params.pollIntervalMs ?? 10,
      tolerance: params.tolerance ?? 16,
      minimumMatchingPixels: params.minimumMatchingPixels ?? 1,
      consecutiveFrames: params.consecutiveFrames ?? 1,
    }, services.context(signal)),
    'ocr.findText': async (params, signal) => {
      const context = services.context(signal);
      try { return scriptTarget(await services.locators.find({ locator: params.locator }, context), context); }
      catch (error) { if (isTargetNotFound(error)) return null; throw error; }
    },
    'ocr.readText': (params, signal) => services.ocr.readText(params.region, params.minConfidence, services.context(signal)),
    'ocr.readNumber': (params, signal) => services.ocr.readNumber(params.region, params.locale, services.context(signal)),
    'page.url': async () => services.page.url(),
    'page.navigate': async (params, signal) => { await services.page.navigate(params.url, signal); return null; },
    'page.reload': async (_params, signal) => { await services.page.reload(signal); return null; },
    'time.sleep': async (params, signal) => { await services.time.sleep(params.durationMs, signal); return null; },
    'time.now': async () => services.time.now(),
    'log.write': async (params) => { services.log(params.level, params.message); return null; },
    'notify.show': async (params) => { services.notify(params.title, params.body); return null; },
  };
}
