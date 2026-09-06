import { describe, expect, it, vi } from 'vitest';
import { JavaScriptAutomationCapabilityBroker, type JavaScriptAutomationHostPorts } from '../src/main/modules/automation/javascript-capability-broker';
import { JAVASCRIPT_AUTOMATION_CAPABILITY, type JavaScriptAutomationMethod } from '../src/shared/automation/javascript-api';

function ports(overrides: Partial<Record<JavaScriptAutomationMethod, (params: unknown, signal: AbortSignal) => Promise<unknown>>> = {}): JavaScriptAutomationHostPorts {
  return Object.fromEntries(Object.keys(JAVASCRIPT_AUTOMATION_CAPABILITY).map((method) => [method, overrides[method as JavaScriptAutomationMethod] ?? (async () => null)])) as unknown as JavaScriptAutomationHostPorts;
}

function request(method: JavaScriptAutomationMethod, params: Record<string, unknown> = {}, token = 'run-token') {
  return { requestId: `request-${method}`, runToken: token, method, params };
}

describe('JavaScriptAutomationCapabilityBroker', () => {
  it('is default-deny for capability-bearing methods', async () => {
    const call = vi.fn(async () => null);
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(), ports({ 'input.click': call }));
    const response = await broker.handle(request('input.click', { target: { locator: { kind: 'coordinate', point: { unit: 'ratio', x: .5, y: .5 } } } }));
    expect(response).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(call).not.toHaveBeenCalled();
  });

  it('binds every request to the current run token', async () => {
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(), ports());
    await expect(broker.handle(request('time.now', {}, 'another-run'))).resolves.toMatchObject({ ok: false, error: { code: 'TOKEN_INVALID' } });
  });

  it('allows permission-free time calls and returns structured values', async () => {
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(), ports({ 'time.now': async () => 123 }));
    await expect(broker.handle(request('time.now'))).resolves.toEqual({ requestId: 'request-time.now', ok: true, value: 123 });
  });

  it('validates method payloads before invoking host ports', async () => {
    const call = vi.fn(async () => null);
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['input']), ports({ 'input.click': call }));
    const response = await broker.handle(request('input.click', { target: { locator: { kind: 'coordinate', point: { unit: 'ratio', x: Number.NaN, y: .5 } } } }));
    expect(response).toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
    expect(call).not.toHaveBeenCalled();
  });

  it('accepts bounded click target-acquisition options for script authors', async () => {
    const call = vi.fn(async () => null);
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['input']), ports({ 'input.click': call }));
    const params = {
      target: { locator: { kind: 'image', asset: 'dynamic.png', threshold: .9 } },
      timeoutMs: 2_500,
      pollIntervalMs: 80,
    };
    await expect(broker.handle(request('input.click', params))).resolves.toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith(params, expect.any(AbortSignal));

    await expect(broker.handle(request('input.click', { ...params, timeoutMs: -1 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
  });

  it('allows bounded color and auto image strategies but rejects unknown recognition methods', async () => {
    const call = vi.fn(async () => null);
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['vision']), ports({ 'vision.find': call }));
    const locator = { kind: 'image', asset: 'small-target.png', threshold: .5, method: 'color' };
    await expect(broker.handle(request('vision.find', { locator }))).resolves.toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith({ locator }, expect.any(AbortSignal));
    await expect(broker.handle(request('vision.find', { locator: { ...locator, method: 'auto' } })))
      .resolves.toMatchObject({ ok: true });
    await expect(broker.handle(request('vision.find', { locator: { ...locator, method: 'unknown' } })))
      .resolves.toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
  });

  it('validates and grants host-side region change observation as vision', async () => {
    const value = { changed: true, changedPixels: 4, totalPixels: 16, changedRatio: .25, maxChangedPixels: 4, maxChangedRatio: .25, samples: 3, elapsedMs: 42, captureMs: 30 };
    const call = vi.fn(async () => value);
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['vision']), ports({ 'vision.waitForRegionChange': call }));
    const params = {
      region: { unit: 'logical', x: 100, y: 200, width: 4, height: 4 },
      timeoutMs: 60_000,
      pollIntervalMs: 10,
      colorDelta: 32,
      minimumChangedPixels: 2,
      changedPixelRatio: .05,
      consecutiveFrames: 2,
      reference: 'baseline',
    };
    await expect(broker.handle(request('vision.waitForRegionChange', params))).resolves.toMatchObject({ ok: true, value });
    expect(call).toHaveBeenCalledWith(params, expect.any(AbortSignal));
    await expect(broker.handle(request('vision.waitForRegionChange', { ...params, changedPixelRatio: 2 })))
      .resolves.toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
  });

  it('validates RGB color observation parameters', async () => {
    const call = vi.fn(async () => ({ found: true }));
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['vision']), ports({ 'vision.waitForColor': call }));
    const params = { region: { unit: 'ratio', x: .4, y: .4, width: .01, height: .01 }, colors: ['#FBEC00', 'fba400'], tolerance: 12 };
    await expect(broker.handle(request('vision.waitForColor', params))).resolves.toMatchObject({ ok: true });
    expect(call).toHaveBeenCalledWith(params, expect.any(AbortSignal));
    await expect(broker.handle(request('vision.waitForColor', { ...params, colors: ['yellow'] })))
      .resolves.toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
  });

  it('rejects navigation protocols outside HTTP(S)', async () => {
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(['page.navigate']), ports());
    await expect(broker.handle(request('page.navigate', { url: 'file:///C:/secret.txt' }))).resolves.toMatchObject({ ok: false, error: { code: 'PAYLOAD_INVALID' } });
  });

  it('enforces concurrent-call budgets', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(), ports({ 'time.sleep': async () => pending.then(() => null) }), { maxConcurrentCalls: 1 });
    const first = broker.handle(request('time.sleep', { durationMs: 1 }));
    await Promise.resolve();
    const second = await broker.handle({ ...request('time.sleep', { durationMs: 1 }), requestId: 'second' });
    expect(second).toMatchObject({ ok: false, error: { code: 'BUDGET_EXCEEDED' } });
    release();
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it('close aborts and drains pending host calls', async () => {
    const broker = new JavaScriptAutomationCapabilityBroker('run-token', new Set(), ports({
      'time.sleep': async (_params, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
    }));
    const pending = broker.handle(request('time.sleep', { durationMs: 1000 }));
    await Promise.resolve();
    await broker.close();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'CALL_FAILED' } });
    await expect(broker.handle(request('time.now'))).resolves.toMatchObject({ ok: false, error: { code: 'BROKER_CLOSED' } });
  });
});
