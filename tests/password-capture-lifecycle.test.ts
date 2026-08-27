import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('../src/main/modules/password-store', () => ({
  getMetaForHost: () => [], isAutoCaptureEnabled: () => true, isCaptureExcluded: () => false,
}));
vi.mock('../src/main/modules/window', () => ({ getMainWindow: () => null }));
vi.mock('electron-log', () => ({ default: logMock }));

import { addBoundedCaptureKey, getCaptureContextIds, setupCapture, teardownCapture } from '../src/main/modules/password-capture';

class FakeDebugger extends EventEmitter {
  attached = false;
  evaluateContexts: number[] = [];
  failures = new Set<number>();

  attach(): void { this.attached = true; }
  detach(): void { this.attached = false; }
  isAttached(): boolean { return this.attached; }
  sendCommand(method: string, params?: { contextId?: number }): Promise<void> {
    if (method === 'Runtime.evaluate' && typeof params?.contextId === 'number') {
      this.evaluateContexts.push(params.contextId);
      if (this.failures.delete(params.contextId)) return Promise.reject(new Error('temporary failure'));
    }
    return Promise.resolve();
  }
}

function fakeWebContents(id = 77) {
  const debug = new FakeDebugger();
  return {
    id,
    debugger: debug,
    isDestroyed: () => false,
    getURL: () => 'https://example.com/login?account=private',
  };
}

describe('password capture lifecycle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    logMock.debug.mockClear();
  });

  it('removes its exact listener, state and retry timer across repeated setup/teardown', async () => {
    const wc = fakeWebContents();
    const baselineTimers = vi.getTimerCount();
    for (let index = 0; index < 50; index++) {
      setupCapture(wc as never);
      expect(wc.debugger.listenerCount('message')).toBe(1);
      teardownCapture(wc as never);
      expect(wc.debugger.listenerCount('message')).toBe(0);
      expect(getCaptureContextIds(wc as never)).toEqual([]);
    }
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it('clears execution contexts and retries only a failed context', async () => {
    const wc = fakeWebContents(78);
    wc.debugger.failures.add(2);
    setupCapture(wc as never);
    wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 1 } });
    wc.debugger.emit('message', {}, 'Runtime.executionContextCreated', { context: { id: 2 } });
    await Promise.resolve(); await Promise.resolve();
    expect(wc.debugger.evaluateContexts).toEqual([1, 2]);
    expect(logMock.debug).toHaveBeenCalledWith(
      '[PasswordCapture] context injection failed; retry scheduled',
      { contextId: 2, error: 'temporary failure' },
    );
    await vi.advanceTimersByTimeAsync(4000);
    expect(wc.debugger.evaluateContexts).toEqual([1, 2, 2]);
    wc.debugger.emit('message', {}, 'Runtime.executionContextsCleared', {});
    expect(getCaptureContextIds(wc as never)).toEqual([]);
    teardownCapture(wc as never);
  });

  it('keeps captured-key deduplication at the strict configured bound', () => {
    const keys = new Set(['one', 'two']);
    addBoundedCaptureKey(keys, 'three', 2);
    expect([...keys]).toEqual(['two', 'three']);
    addBoundedCaptureKey(keys, 'three', 2);
    expect([...keys]).toEqual(['two', 'three']);
  });
});
