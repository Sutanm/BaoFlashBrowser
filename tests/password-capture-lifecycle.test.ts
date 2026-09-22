import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

// getMainWindow 打桩成"可观测窗口"：sendToRenderer 的调用可以直接断言
// （此前固定返回 null，"捕获是否上报"这件事在单测里完全不可见）。
const windowMock = vi.hoisted(() => ({ send: vi.fn() }));

// 密码本打桩：saved 提供 host+username 查重结果，passwords 提供"能否解出明文"。
// 2026-09-22 的"变了才提示"语义依赖这两者，故必须在测试里可控。
const storeMock = vi.hoisted(() => ({
  saved: [] as { id: string; username: string }[],
  passwords: new Map<string, string | null>(),
}));

vi.mock('../src/main/modules/password-store', () => ({
  getMetaForHost: () => storeMock.saved,
  getDecryptedPassword: (id: string) => (storeMock.passwords.has(id) ? storeMock.passwords.get(id)! : null),
  isAutoCaptureEnabled: () => true,
  isCaptureExcluded: () => false,
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
  /** >0 时 attach 会抛错，用于复现"与 fill 争抢 debugger"的窗口。 */
  attachFailures = 0;

  attach(): void {
    if (this.attachFailures > 0) {
      this.attachFailures -= 1;
      throw new Error('CDP is already attached by an unmanaged client');
    }
    this.attached = true;
  }
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
    logMock.info.mockClear();
    logMock.warn.mockClear();
    windowMock.send.mockClear();
    storeMock.saved = [];
    storeMock.passwords.clear();
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

  // 2026-09-22：去重从"一律静默"改为 Chrome 的"变了才提示"。
  // 此前静默是用户误判"捕获坏了"的直接来源（日志里只有一行 skip already-saved）。
  it('同账号 + 同密码：静默跳过，不弹提示', () => {
    const wc = fakeWebContents(84);
    storeMock.saved = [{ id: 'e1', username: 'bao' }];
    storeMock.passwords.set('e1', 'pw12345');
    setupCapture(wc as never);
    emitCapture(wc, 'same-pass.example', { user: 'bao', pass: 'pw12345' });
    expect(windowMock.send).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledWith('[PasswordCapture] skip already-saved host=same-pass.example (same password)');
    teardownCapture(wc as never);
  });

  it('同账号但密码已变：照常弹提示（保存即覆盖旧条目＝更新密码）', () => {
    const wc = fakeWebContents(85);
    storeMock.saved = [{ id: 'e2', username: 'bao' }];
    storeMock.passwords.set('e2', 'OLD-password');
    setupCapture(wc as never);
    emitCapture(wc, 'changed-pass.example', { user: 'bao', pass: 'NEW-password' });
    expect(windowMock.send).toHaveBeenCalledTimes(1);
    expect(windowMock.send).toHaveBeenCalledWith('password:captured', expect.objectContaining({ host: 'changed-pass.example' }));
    expect(logMock.info).toHaveBeenCalledWith('[PasswordCapture] password changed host=changed-pass.example — prompting update');
    teardownCapture(wc as never);
  });

  it('解不出明文（密钥不可用）时沿用静默，不把旧密码误报成"已变"', () => {
    const wc = fakeWebContents(86);
    storeMock.saved = [{ id: 'e3', username: 'bao' }];
    storeMock.passwords.set('e3', null);
    setupCapture(wc as never);
    emitCapture(wc, 'locked-key.example', { user: 'bao', pass: 'whatever' });
    expect(windowMock.send).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalledWith('[PasswordCapture] skip already-saved host=locked-key.example (key unavailable)');
    teardownCapture(wc as never);
  });

  // 2026-09-22：password-fill 会短命 attach debugger（绕过 cdp-lease），捕获撞上时必须重试，
  // 否则该标签页永久无捕获（实测 wc=4 即如此）。
  it('attach 撞上 fill 的短命客户端时会重试，直到拿到租约', async () => {
    const wc = fakeWebContents(87);
    wc.debugger.attachFailures = 1;
    setupCapture(wc as never);
    expect(wc.debugger.listenerCount('message')).toBe(0);
    expect(logMock.warn).toHaveBeenCalledWith(
      '[PasswordCapture] attach failed:',
      'CDP is already attached by an unmanaged client',
    );

    await vi.advanceTimersByTimeAsync(250);
    expect(wc.debugger.attached).toBe(true);
    expect(wc.debugger.listenerCount('message')).toBe(1);
    teardownCapture(wc as never);
  });

  it('连续失败到上限后放弃，不无限自旋（并留有日志）', async () => {
    const wc = fakeWebContents(88);
    wc.debugger.attachFailures = 99;
    setupCapture(wc as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wc.debugger.attached).toBe(false);
    const retries = logMock.info.mock.calls.filter(([m]) => String(m).startsWith('[PasswordCapture] attach retry')).length;
    expect(retries).toBe(5);
    expect(logMock.warn).toHaveBeenCalledWith('[PasswordCapture] attach retries exhausted, wc.id=88');
    teardownCapture(wc as never);
  });

  it('teardown 会取消挂起中的附着重试（标签页关闭/自动化占位时不残留定时器）', async () => {
    const wc = fakeWebContents(89);
    wc.debugger.attachFailures = 1;
    const baseline = vi.getTimerCount();
    setupCapture(wc as never);
    expect(vi.getTimerCount()).toBeGreaterThan(baseline);
    teardownCapture(wc as never);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(wc.debugger.attached).toBe(false);
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
