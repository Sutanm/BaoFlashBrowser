import {
  AutomationActionRegistry,
  AutomationLocatorQueries,
  type ActionContext,
  type LocatedTarget,
} from '../../../shared/automation/core';
import type { PersistedRegion } from '../../../shared/automation/core/surface';
import type { ScriptLocatedTarget } from '../../../shared/automation/javascript-api';
import type { JavaScriptAutomationHostPorts } from './javascript-capability-broker';

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
  readonly page: {
    url(): string;
    navigate(url: string, signal: AbortSignal): Promise<void>;
    reload(signal: AbortSignal): Promise<void>;
  };
  readonly time: { sleep(durationMs: number, signal: AbortSignal): Promise<void>; now(): number };
  readonly log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) => void;
  readonly notify: (title: string, body?: string) => void;
};

function scriptTarget(target: LocatedTarget): ScriptLocatedTarget {
  return {
    point: { x: target.activationPoint.x, y: target.activationPoint.y },
    bounds: target.bounds ? { x: target.bounds.x, y: target.bounds.y, width: target.bounds.width, height: target.bounds.height } : undefined,
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
      try { return scriptTarget(await services.locators.find({ locator: params.locator }, services.context(signal))); }
      catch (error) { if (isTargetNotFound(error)) return null; throw error; }
    },
    'vision.exists': (params, signal) => services.locators.exists(params.locator, services.context(signal)),
    'ocr.findText': async (params, signal) => {
      try { return scriptTarget(await services.locators.find({ locator: params.locator }, services.context(signal))); }
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
