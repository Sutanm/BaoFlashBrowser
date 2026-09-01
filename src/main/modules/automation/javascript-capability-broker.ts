import {
  JAVASCRIPT_AUTOMATION_CAPABILITY,
  type JavaScriptAutomationCapability,
  type JavaScriptAutomationMethod,
  type JavaScriptAutomationParams,
  type JavaScriptAutomationRequest,
  type JavaScriptAutomationResponse,
  type JavaScriptAutomationResult,
} from '../../../shared/automation/javascript-api';
import { createAutomationAbortController } from '../../../shared/automation/abort-controller';

export type JavaScriptAutomationHostPorts = {
  [M in JavaScriptAutomationMethod]: (params: JavaScriptAutomationParams[M], signal: AbortSignal) => Promise<JavaScriptAutomationResult[M]>;
};

export type JavaScriptBrokerLimits = {
  readonly maxCalls: number;
  readonly maxConcurrentCalls: number;
  readonly maxRequestBytes: number;
  readonly maxResultBytes: number;
  readonly maxValueDepth: number;
  readonly maxStringLength: number;
  readonly deadlineMs: number;
};

export const DEFAULT_JAVASCRIPT_BROKER_LIMITS: JavaScriptBrokerLimits = Object.freeze({
  maxCalls: 10_000, maxConcurrentCalls: 8, maxRequestBytes: 64 * 1024, maxResultBytes: 256 * 1024,
  maxValueDepth: 32, maxStringLength: 10_000, deadlineMs: 30_000,
});

export class JavaScriptCapabilityBrokerError extends Error {
  constructor(readonly code: 'TOKEN_INVALID' | 'METHOD_INVALID' | 'PERMISSION_DENIED' | 'PAYLOAD_INVALID' | 'BUDGET_EXCEEDED' | 'BROKER_CLOSED' | 'CALL_FAILED', message: string) {
    super(message);
    this.name = 'JavaScriptCapabilityBrokerError';
  }
}

function assertSerializable(value: unknown, limits: JavaScriptBrokerLimits, depth = 0, seen = new Set<object>()): void {
  if (depth > limits.maxValueDepth) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'structured value depth exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'numbers must be finite');
    return;
  }
  if (typeof value === 'string') {
    if (value.length > limits.maxStringLength) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'string length exceeded');
    return;
  }
  if (typeof value !== 'object') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', `unsupported structured value: ${typeof value}`);
  if (seen.has(value)) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'structured value contains a cycle');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'structured value has a non-plain prototype');
  seen.add(value);
  for (const entry of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) assertSerializable(entry, limits, depth + 1, seen);
  seen.delete(value);
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertRequestShape(request: JavaScriptAutomationRequest): void {
  if (!request || typeof request !== 'object' || typeof request.requestId !== 'string' || !request.requestId
    || typeof request.runToken !== 'string' || typeof request.method !== 'string'
    || !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
    throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'invalid automation API request envelope');
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', `${label} must be an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, label: string, minimum?: number, maximum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (minimum !== undefined && value < minimum) || (maximum !== undefined && value > maximum)) {
    throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', `${label} is invalid`);
  }
  return value;
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', `${label} is invalid`);
  return value;
}

function assertLocator(value: unknown, depth = 0): void {
  const locator = record(value, 'locator');
  if (depth > 8) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'locator nesting is too deep');
  if (locator.kind === 'coordinate') {
    const point = record(locator.point, 'coordinate point');
    if (point.unit !== 'ratio' && point.unit !== 'logical') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'coordinate unit is invalid');
    finite(point.x, 'coordinate x'); finite(point.y, 'coordinate y');
    return;
  }
  if (locator.kind === 'image') {
    stringValue(locator.asset, 'image asset'); finite(locator.threshold, 'image threshold', 0, 1);
    if (locator.alternatives !== undefined) {
      if (!Array.isArray(locator.alternatives) || locator.alternatives.length > 100) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'image alternatives are invalid');
      locator.alternatives.forEach((asset) => stringValue(asset, 'image alternative'));
    }
    if (locator.region !== undefined) assertRegion(locator.region);
    return;
  }
  if (locator.kind === 'text') {
    stringValue(locator.text, 'text locator text'); finite(locator.minConfidence, 'text confidence', 0, 1);
    if (!['exact', 'contains', 'normalized'].includes(String(locator.match))) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'text match mode is invalid');
    if (locator.region !== undefined) assertRegion(locator.region);
    return;
  }
  if (locator.kind === 'firstOf') {
    if (!Array.isArray(locator.locators) || locator.locators.length < 1 || locator.locators.length > 20) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'firstOf locator count is invalid');
    locator.locators.forEach((candidate) => assertLocator(candidate, depth + 1));
    return;
  }
  throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', `unknown locator kind: ${String(locator.kind)}`);
}

function assertRegion(value: unknown): void {
  const region = record(value, 'region');
  if (region.unit !== 'ratio' && region.unit !== 'logical') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'region unit is invalid');
  const x = finite(region.x, 'region x'); const y = finite(region.y, 'region y');
  const width = finite(region.width, 'region width', Number.EPSILON); const height = finite(region.height, 'region height', Number.EPSILON);
  if (region.unit === 'ratio' && (x < 0 || y < 0 || x + width > 1 || y + height > 1)) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'ratio region is outside [0,1]');
}

function assertTarget(value: unknown): void {
  const target = record(value, 'target');
  assertLocator(target.locator);
}

function validateMethodParams(method: JavaScriptAutomationMethod, untrusted: unknown): void {
  const params = record(untrusted, `${method} params`);
  if (method === 'input.click') {
    assertTarget(params.target);
    if (params.count !== undefined && !Number.isSafeInteger(finite(params.count, 'click count', 1, 10))) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'click count must be an integer');
    if (params.button !== undefined && !['primary', 'middle', 'secondary'].includes(String(params.button))) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'mouse button is invalid');
    if (params.timeoutMs !== undefined) finite(params.timeoutMs, 'click timeout', 0, 3_600_000);
    if (params.pollIntervalMs !== undefined) finite(params.pollIntervalMs, 'click poll interval', 0, 3_600_000);
  } else if (method === 'input.move') {
    assertTarget(params.target); if (params.durationMs !== undefined) finite(params.durationMs, 'move duration', 0, 60_000);
    if (params.timeoutMs !== undefined) finite(params.timeoutMs, 'move timeout', 0, 3_600_000);
    if (params.pollIntervalMs !== undefined) finite(params.pollIntervalMs, 'move poll interval', 0, 3_600_000);
  } else if (method === 'input.drag') {
    assertTarget(params.from); assertTarget(params.to); if (params.durationMs !== undefined) finite(params.durationMs, 'drag duration', 0, 60_000);
    if (params.timeoutMs !== undefined) finite(params.timeoutMs, 'drag timeout', 0, 3_600_000);
    if (params.pollIntervalMs !== undefined) finite(params.pollIntervalMs, 'drag poll interval', 0, 3_600_000);
  }
  else if (method === 'input.keyPress') {
    stringValue(params.key, 'key');
    if (params.modifiers !== undefined && (!Array.isArray(params.modifiers) || params.modifiers.some((value) => !['alt', 'control', 'meta', 'shift'].includes(String(value))))) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'key modifiers are invalid');
  }
  else if (method === 'input.typeText') { stringValue(params.text, 'text', true); if (params.intervalMs !== undefined) finite(params.intervalMs, 'text interval', 0, 60_000); }
  else if (method === 'input.scroll') { finite(params.deltaX, 'scroll deltaX'); finite(params.deltaY, 'scroll deltaY'); }
  else if (method === 'vision.find') { assertLocator(params.locator); if ((params.locator as { kind?: unknown }).kind !== 'image') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'vision.find requires ImageLocator'); }
  else if (method === 'vision.exists') assertLocator(params.locator);
  else if (method === 'ocr.findText') { assertLocator(params.locator); if ((params.locator as { kind?: unknown }).kind !== 'text') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'ocr.findText requires TextLocator'); }
  else if (method === 'ocr.readText' || method === 'ocr.readNumber') {
    if (params.region !== undefined) assertRegion(params.region);
    if (params.minConfidence !== undefined) finite(params.minConfidence, 'OCR confidence', 0, 1);
    if (params.locale !== undefined) stringValue(params.locale, 'OCR locale');
  }
  else if (method === 'page.navigate') {
    const value = stringValue(params.url, 'navigation URL');
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'navigation URL is invalid'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'navigation URL protocol is not allowed');
  } else if (method === 'time.sleep') finite(params.durationMs, 'sleep duration', 0, 3_600_000);
  else if (method === 'log.write') {
    if (!['debug', 'info', 'warn', 'error'].includes(String(params.level))) throw new JavaScriptCapabilityBrokerError('PAYLOAD_INVALID', 'log level is invalid');
    stringValue(params.message, 'log message', true);
  } else if (method === 'notify.show') { stringValue(params.title, 'notification title'); if (params.body !== undefined) stringValue(params.body, 'notification body', true); }
}

export class JavaScriptAutomationCapabilityBroker {
  private readonly limits: JavaScriptBrokerLimits;
  private readonly controller = createAutomationAbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private calls = 0;
  private closed = false;

  constructor(
    readonly runToken: string,
    private readonly grants: ReadonlySet<JavaScriptAutomationCapability>,
    private readonly ports: JavaScriptAutomationHostPorts,
    limits: Partial<JavaScriptBrokerLimits> = {},
  ) {
    this.limits = { ...DEFAULT_JAVASCRIPT_BROKER_LIMITS, ...limits };
  }

  async handle(untrusted: unknown): Promise<JavaScriptAutomationResponse> {
    let requestId = 'invalid';
    try {
      const request = untrusted as JavaScriptAutomationRequest;
      assertRequestShape(request);
      requestId = request.requestId;
      if (this.closed) throw new JavaScriptCapabilityBrokerError('BROKER_CLOSED', 'automation API broker is closed');
      if (request.runToken !== this.runToken) throw new JavaScriptCapabilityBrokerError('TOKEN_INVALID', 'automation run token does not match');
      if (!(request.method in JAVASCRIPT_AUTOMATION_CAPABILITY)) throw new JavaScriptCapabilityBrokerError('METHOD_INVALID', `unknown automation API method: ${request.method}`);
      const capability = JAVASCRIPT_AUTOMATION_CAPABILITY[request.method];
      if (capability && !this.grants.has(capability)) throw new JavaScriptCapabilityBrokerError('PERMISSION_DENIED', `automation capability is not granted: ${capability}`);
      assertSerializable(request.params, this.limits);
      validateMethodParams(request.method, request.params);
      if (encodedBytes(request) > this.limits.maxRequestBytes) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'automation API request byte budget exceeded');
      this.calls += 1;
      if (this.calls > this.limits.maxCalls) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'automation API call budget exceeded');
      if (this.pending.size >= this.limits.maxConcurrentCalls) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'automation API concurrency budget exceeded');

      const port = this.ports[request.method] as (params: unknown, signal: AbortSignal) => Promise<unknown>;
      if (typeof port !== 'function') throw new JavaScriptCapabilityBrokerError('METHOD_INVALID', `automation API port is unavailable: ${request.method}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const operation = Promise.race([
        port(request.params, this.controller.signal),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new JavaScriptCapabilityBrokerError('CALL_FAILED', `automation API call timed out: ${request.method}`)), this.limits.deadlineMs); }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
      this.pending.add(operation);
      let value: unknown;
      try { value = await operation; } finally { this.pending.delete(operation); }
      assertSerializable(value, this.limits);
      if (encodedBytes(value) > this.limits.maxResultBytes) throw new JavaScriptCapabilityBrokerError('BUDGET_EXCEEDED', 'automation API result byte budget exceeded');
      return { requestId, ok: true, value };
    } catch (error) {
      const safe = error instanceof JavaScriptCapabilityBrokerError ? error : new JavaScriptCapabilityBrokerError('CALL_FAILED', error instanceof Error ? error.message : String(error));
      return { requestId, ok: false, error: { code: safe.code, message: safe.message } };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    await Promise.allSettled([...this.pending]);
  }
}
