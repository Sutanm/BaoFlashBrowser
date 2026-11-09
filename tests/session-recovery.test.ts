// 多窗口 P5：崩溃恢复状态必须按窗口消费，不能被第一个窗口清零。
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ data: new Map<string, unknown>() }));
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(key: string): unknown { return storeState.data.get(key); }
    set(key: string, value: unknown): void { storeState.data.set(key, value); }
  },
}));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

async function loadModule() {
  vi.resetModules();
  return import('../src/main/modules/session-recovery');
}

describe('session recovery per window (P5)', () => {
  beforeEach(() => {
    storeState.data.clear();
    // 上次进程异常退出：running=true
    storeState.data.set('session', { running: true, startedAt: 1, cleanShutdownAt: null });
  });

  it('keeps abnormalExit visible until each window resolves it', async () => {
    const recovery = await loadModule();
    recovery.initializeSessionRecovery();

    expect(recovery.getSessionRecoveryStatus()).toEqual({ abnormalExit: true });
    expect(recovery.getSessionRecoveryStatus('key-a')).toEqual({ abnormalExit: true });
    expect(recovery.getSessionRecoveryStatus('key-b')).toEqual({ abnormalExit: true });

    recovery.resolveSessionRecovery('key-a');

    expect(recovery.getSessionRecoveryStatus('key-a')).toEqual({ abnormalExit: false });
    expect(recovery.getSessionRecoveryStatus('key-b')).toEqual({ abnormalExit: true });
    // 不带 key 的旧语义仍然是"整个进程已消费"。
    expect(recovery.getSessionRecoveryStatus()).toEqual({ abnormalExit: true });
  });

  it('clears globally only for the legacy no-arg call', async () => {
    const recovery = await loadModule();
    recovery.initializeSessionRecovery();

    recovery.resolveSessionRecovery();

    expect(recovery.getSessionRecoveryStatus()).toEqual({ abnormalExit: false });
    expect(recovery.getSessionRecoveryStatus('key-a')).toEqual({ abnormalExit: false });
  });

  it('reports a clean exit as no recovery needed for every window', async () => {
    storeState.data.set('session', { running: false, startedAt: 1, cleanShutdownAt: 2 });
    const recovery = await loadModule();
    recovery.initializeSessionRecovery();

    expect(recovery.getSessionRecoveryStatus('key-a')).toEqual({ abnormalExit: false });
    expect(recovery.getSessionRecoveryStatus('key-b')).toEqual({ abnormalExit: false });
  });
});
