import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

// getMainWindow 打桩成"可观测窗口"：sendToRenderer 的调用可以直接断言
// （此前固定返回 null，"捕获是否上报"这件事在单测里完全不可见）。
const windowMock = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('../src/main/modules/password-store', () => ({
  getMetaForHost: () => [], isAutoCaptureEnabled: () => true, isCaptureExcluded: () => false,
}));
vi.mock('../src/main/modules/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => windowMock.send(...args) },
  }),
}));
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
    windowMock.send.mockClear();
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

  // 2026-09-22：对齐 Chrome —— 用户名允许为空。此前 `!data.user` 会让"用户名还没进 DOM 的登录"
  // （先填密码、或压根没有用户名框）静默不弹保存提示。
  // 注意：shownToastKeys 是模块级去重表，跨用例必须换 host，否则会被判成"已提示过"。
  const emitCapture = (wc: ReturnType<typeof fakeWebContents>, host: string, payload: Record<string, unknown>): void => {
    wc.debugger.emit('message', {}, 'Runtime.bindingCalled', {
      name: '__baopReport',
      payload: JSON.stringify({ _type: 'baop_capture', host, origin: `https://${host}/login`, title: 't', source: 'submit', ...payload }),
    });
  };

  it('用户名可为空：空账号的捕获照样上报，且 username 是空串而不是 undefined', () => {
    const wc = fakeWebContents(79);
    setupCapture(wc as never);
    emitCapture(wc, 'empty-user.example', { user: '', pass: 'pw12345' });
    expect(windowMock.send).toHaveBeenCalledTimes(1);
    expect(windowMock.send).toHaveBeenCalledWith('password:captured', expect.objectContaining({
      host: 'empty-user.example', username: '',
    }));
    teardownCapture(wc as never);
  });

  it('user 字段缺失时按空串处理（不写 undefined 进查重键/待保存凭据）', () => {
    const wc = fakeWebContents(80);
    setupCapture(wc as never);
    emitCapture(wc, 'missing-user.example', { pass: 'pw12345' });
    expect(windowMock.send).toHaveBeenCalledTimes(1);
    expect(windowMock.send).toHaveBeenCalledWith('password:captured', expect.objectContaining({ username: '' }));
    teardownCapture(wc as never);
  });

  it('密码过短仍被丢弃（放开空用户名不等于放开一切）', () => {
    const wc = fakeWebContents(81);
    setupCapture(wc as never);
    emitCapture(wc, 'short-pass.example', { user: '', pass: 'x' });
    emitCapture(wc, 'short-pass.example', { user: 'bao', pass: '' });
    expect(windowMock.send).not.toHaveBeenCalled();
    teardownCapture(wc as never);
  });
});
