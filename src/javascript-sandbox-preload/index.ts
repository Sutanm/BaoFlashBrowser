import { contextBridge, ipcRenderer } from 'electron';
import type {
  JavaScriptAutomationMethod,
  JavaScriptAutomationParams,
  JavaScriptAutomationResponse,
  JavaScriptAutomationResult,
  BaoAutomationApi,
} from '../shared/automation/javascript-api';
import type { LocatorSpec, TargetRef } from '../shared/automation/core/locator';
import type { PersistedRegion } from '../shared/automation/core/surface';

const REQUEST_CHANNEL = 'automation-js:request';
const CONFIG_CHANNEL = 'automation-js:config';
const config = ipcRenderer.sendSync(CONFIG_CHANNEL) as { runToken?: unknown };
if (!config || typeof config.runToken !== 'string' || !config.runToken) throw new Error('Automation JavaScript sandbox has no run token');

let nextRequestId = 1;

async function call<M extends JavaScriptAutomationMethod>(method: M, params: JavaScriptAutomationParams[M]): Promise<JavaScriptAutomationResult[M]> {
  const response = await ipcRenderer.invoke(REQUEST_CHANNEL, {
    requestId: `sandbox-${nextRequestId++}`,
    runToken: config.runToken,
    method,
    params,
  }) as JavaScriptAutomationResponse;
  if (!response || response.requestId === undefined || typeof response.ok !== 'boolean') throw new Error('Automation host returned an invalid response');
  if (!response.ok) {
    // Electron 11 contextBridge drops custom properties from rejected Error
    // objects. A frozen data error preserves the stable code across worlds.
    throw Object.freeze({ name: 'BaoAutomationError', code: response.error.code, message: response.error.message });
  }
  return response.value as JavaScriptAutomationResult[M];
}

function freeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) if (child && typeof child === 'object') Object.freeze(child);
  return Object.freeze(value);
}

const bao: BaoAutomationApi = freeze({
  input: freeze({
    click: (target: TargetRef, options: { button?: 'primary' | 'middle' | 'secondary'; count?: number; timeoutMs?: number; pollIntervalMs?: number } = {}) => call('input.click', { target, ...options }),
    move: (target: TargetRef, options: { durationMs?: number; timeoutMs?: number; pollIntervalMs?: number } = {}) => call('input.move', { target, ...options }),
    drag: (options: { from: TargetRef; to: TargetRef; button?: 'primary' | 'middle' | 'secondary'; durationMs?: number; timeoutMs?: number; pollIntervalMs?: number }) => call('input.drag', options),
    keyPress: (key: string, modifiers: readonly ('alt' | 'control' | 'meta' | 'shift')[] = []) => call('input.keyPress', { key, modifiers }),
    typeText: (text: string, intervalMs = 0) => call('input.typeText', { text, intervalMs }),
    scroll: (deltaX: number, deltaY: number) => call('input.scroll', { deltaX, deltaY }),
  }),
  vision: freeze({
    find: (locator: Extract<LocatorSpec, { kind: 'image' }>) => call('vision.find', { locator }),
    exists: (locator: LocatorSpec) => call('vision.exists', { locator }),
  }),
  ocr: freeze({
    findText: (locator: Extract<LocatorSpec, { kind: 'text' }>) => call('ocr.findText', { locator }),
    readText: (region?: PersistedRegion, minConfidence?: number) => call('ocr.readText', { region, minConfidence }),
    readNumber: (region?: PersistedRegion, locale?: string) => call('ocr.readNumber', { region, locale }),
  }),
  page: freeze({
    url: () => call('page.url', {}),
    navigate: (url: string) => call('page.navigate', { url }),
    reload: () => call('page.reload', {}),
  }),
  time: freeze({
    sleep: (durationMs: number) => call('time.sleep', { durationMs }),
    now: () => call('time.now', {}),
  }),
  log: freeze({
    debug: (message: string) => call('log.write', { level: 'debug', message }),
    info: (message: string) => call('log.write', { level: 'info', message }),
    warn: (message: string) => call('log.write', { level: 'warn', message }),
    error: (message: string) => call('log.write', { level: 'error', message }),
  }),
  notify: freeze({ show: (title: string, body?: string) => call('notify.show', { title, body }) }),
});

contextBridge.exposeInMainWorld('bao', bao);
