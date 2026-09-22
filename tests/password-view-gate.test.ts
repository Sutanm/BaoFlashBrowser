// @vitest-environment node
/**
 * view-gate 门禁内核（规格 2026-09-22-view-gate-design.md，G1–G12）。
 *
 * 用**真实 password-store + 真实 view-gate**（只 mock electron-store / keyring / log），
 * 这样 viewFallback 的真实读写、tier 判定与门禁策略一起被验证，而不是各测各的。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }));

vi.mock('electron-store', () => ({
  default: class MockStore {
    readonly path: string;
    private readonly data: Map<string, unknown>;

    constructor(options: { name?: string; defaults?: Record<string, unknown> }) {
      const name = options.name ?? 'config';
      this.path = `/mock/${name}.json`;
      let data = storeState.stores.get(name);
      if (!data) {
        data = new Map(Object.entries(options.defaults ?? {}));
        storeState.stores.set(name, data);
      }
      this.data = data;
    }

    get(key: string): unknown { return this.data.get(key); }
    set(key: string, value: unknown): void { this.data.set(key, value); }
    clear(): void { this.data.clear(); }
  },
}));

const logMock = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('electron-log', () => ({ default: logMock }));

const keyringState = vi.hoisted(() => ({ backend: null as string | null }));
vi.mock('../src/main/modules/keyring', () => ({
  detectKeyring: vi.fn(async () => ({
    backend: keyringState.backend as never,
    reason: keyringState.backend ? undefined : 'no-tool',
  })),
  getActiveBackendId: vi.fn(() => keyringState.backend as never),
  invalidateKeyring: vi.fn(),
  keyringWrap: vi.fn(async (secret: string) => (
    keyringState.backend ? { ok: true, blob: `enc:${secret}` } : { ok: false, kind: 'backend-unavailable', reason: 'keyring-unavailable' }
  )),
  keyringUnwrapAffine: vi.fn(async (blob: string) => (
    keyringState.backend ? { ok: true, secret: blob.startsWith('enc:') ? blob.slice(4) : blob } : { ok: false, kind: 'backend-unavailable', reason: 'keyring-unavailable' }
  )),
}));

import { initVault, dispose, getViewFallback } from '../src/main/modules/password-store';
import {
  authorizeView, resolveViewGuard, setViewPassword, isViewLocked, computeFailOutcome,
  resetOsAuthUnavailable,
  MAX_VIEW_FAILURES, VIEW_LOCK_MS, VIEW_PASSWORD_MIN,
  _setOsBackendForTest, _setPlatformForTest, _resetViewGateForTest,
  type OsVerifyBackend, type OsVerifyResult,
} from '../src/main/modules/view-gate';

function guardStore(): Map<string, unknown> {
  return storeState.stores.get('password-view-guard')!;
}

function fakeBackend(result: OsVerifyResult | (() => OsVerifyResult), available = true): OsVerifyBackend {
  return {
    id: 'win-credui',
    async available() { return available; },
    async verify() { return typeof result === 'function' ? result() : result; },
  };
}

const GRANTED: OsVerifyResult = { ok: true };

/** 建一个 tier A 的库（keyring 后端存在）。 */
async function initTierA(): Promise<void> {
  keyringState.backend = 'win-dpapi';
  await initVault();
}

/** 建一个 tier C 的库（无 OS 后端）。 */
async function initTierC(): Promise<void> {
  keyringState.backend = null;
  await initVault();
}

describe('view-gate 策略解析（规格 §2）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    _resetViewGateForTest();
    logMock.warn.mockClear();
  });

  it('未建库 → none / not-initialized', async () => {
    const guard = await resolveViewGuard();
    expect(guard).toMatchObject({ mode: 'none', reason: 'not-initialized' });
  });

  it('tier C → password（强制），未设置时 passwordSet=false', async () => {
    await initTierC();
    expect(await resolveViewGuard()).toMatchObject({ mode: 'password', passwordSet: false, reason: 'tier-c' });
  });

  it('tier C 设置后 → passwordSet=true', async () => {
    await initTierC();
    await setViewPassword('hunter2-view');
    expect(await resolveViewGuard()).toMatchObject({ mode: 'password', passwordSet: true });
  });

  it('tier A 且有可用 OS 后端 → os-win', async () => {
    await initTierA();
    _setOsBackendForTest(fakeBackend(GRANTED));
    expect(await resolveViewGuard()).toMatchObject({ mode: 'os-win' });
  });

  it('tier A 但平台无 OS 后端（darwin/linux 未实现）→ 退到 password，绝不放行', async () => {
    await initTierA();
    _setOsBackendForTest(null);
    _setPlatformForTest('linux');
    expect(await resolveViewGuard()).toMatchObject({ mode: 'password', reason: 'no-os-auth-backend' });
  });

  it('后端 available()=false → 退到 password', async () => {
    await initTierA();
    _setOsBackendForTest(fakeBackend(GRANTED, false));
    expect(await resolveViewGuard()).toMatchObject({ mode: 'password', reason: 'no-os-auth-backend' });
  });

  it('已降级（osAuthUnavailable）→ password + reason=os-auth-unavailable', async () => {
    await initTierA();
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'unusable-account' }));
    await authorizeView();
    expect(await resolveViewGuard()).toMatchObject({ mode: 'password', reason: 'os-auth-unavailable' });
    await resetOsAuthUnavailable();
    _setOsBackendForTest(fakeBackend(GRANTED));
    expect(await resolveViewGuard()).toMatchObject({ mode: 'os-win' });
  });
});

describe('查看密码（G6）', () => {
  beforeEach(async () => {
    for (const data of storeState.stores.values()) data.clear();
    _resetViewGateForTest();
    await initTierC();
  });

  it('过短口令被拒，且不写入任何记录', async () => {
    const short = 'a'.repeat(VIEW_PASSWORD_MIN - 1);
    expect(await setViewPassword(short)).toMatchObject({ success: false, error: 'weak-password' });
    expect(getViewFallback()).toBeNull();
  });

  it('设置后记录为 PBKDF2 形态（salt/hash/iter），不含明文', async () => {
    await setViewPassword('correct horse');
    const record = getViewFallback()!;
    expect(record.iter).toBe(250000);
    expect(record.salt.length).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain('correct horse');
  });

  it('正确口令放行；错误口令拒绝并计入失败', async () => {
    await setViewPassword('correct horse');
    expect(await authorizeView('correct horse')).toMatchObject({ ok: true, code: 'ok' });
    const bad = await authorizeView('wrong');
    expect(bad).toMatchObject({ ok: false, code: 'wrong-credential', remainingAttempts: MAX_VIEW_FAILURES - 1 });
  });

  it('未带口令 → needs-input（不计入失败）', async () => {
    await setViewPassword('correct horse');
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'needs-input' });
    expect(guardStore().get('failCount')).toBe(0);
  });

  it('C 档未设置就查看 → needs-setup（不计入失败）', async () => {
    expect(await authorizeView('anything')).toMatchObject({ ok: false, code: 'needs-setup' });
    expect(guardStore().get('failCount')).toBe(0);
  });

  it('修改口令：缺 current 被拒；current 错误计入失败；成功则旧口令失效', async () => {
    await setViewPassword('first-pass');
    expect(await setViewPassword('second-pass')).toMatchObject({ success: false, error: 'current-required' });

    const wrongCurrent = await setViewPassword('second-pass', 'not-the-current');
    expect(wrongCurrent).toMatchObject({ success: false, error: 'wrong-credential' });
    expect(guardStore().get('failCount')).toBe(1);

    expect(await setViewPassword('second-pass', 'first-pass')).toMatchObject({ success: true });
    expect(guardStore().get('failCount')).toBe(0);
    expect(await authorizeView('first-pass')).toMatchObject({ ok: false, code: 'wrong-credential' });
    expect(await authorizeView('second-pass')).toMatchObject({ ok: true, code: 'ok' });
  });

  it('成功验证会把之前的失败计数清零', async () => {
    await setViewPassword('correct horse');
    await authorizeView('bad-1');
    await authorizeView('bad-2');
    expect(guardStore().get('failCount')).toBe(2);
    await authorizeView('correct horse');
    expect(guardStore().get('failCount')).toBe(0);
  });
});

describe('失败计数与锁定（G7 / G8 作用域）', () => {
  beforeEach(async () => {
    for (const data of storeState.stores.values()) data.clear();
    _resetViewGateForTest();
    await initTierC();
    await setViewPassword('correct horse');
  });

  it(`连续 ${MAX_VIEW_FAILURES} 次失败 → 锁定 30 分钟`, async () => {
    for (let i = 1; i < MAX_VIEW_FAILURES; i += 1) {
      const result = await authorizeView('wrong');
      expect(result.code).toBe('wrong-credential');
      expect(result.remainingAttempts).toBe(MAX_VIEW_FAILURES - i);
      expect(result.lockedForMs).toBeUndefined();
    }
    // 触发锁定的那一次仍以 wrong-credential 返回，并附带 lockedForMs：
    // UI 需要同时说清"口令错了"和"已锁 30 分钟"。
    const tripping = await authorizeView('wrong');
    expect(tripping).toMatchObject({ ok: false, code: 'wrong-credential', remainingAttempts: 0, lockedForMs: VIEW_LOCK_MS });
    expect(guardStore().get('lockedUntil')).toBeTypeOf('number');
    // 此后才进入 locked。
    expect(await authorizeView('wrong')).toMatchObject({ ok: false, code: 'locked', remainingAttempts: 0 });
  });

  it('锁定期间即使口令正确也拒绝，且不累加计数、不延长锁定', async () => {
    for (let i = 0; i < MAX_VIEW_FAILURES; i += 1) await authorizeView('wrong');
    const lockedUntil = guardStore().get('lockedUntil') as number;
    const failCount = guardStore().get('failCount') as number;

    expect(await authorizeView('correct horse')).toMatchObject({ ok: false, code: 'locked' });
    expect(await authorizeView('wrong')).toMatchObject({ ok: false, code: 'locked' });
    expect(guardStore().get('failCount')).toBe(failCount);
    expect(guardStore().get('lockedUntil')).toBe(lockedUntil);
  });

  it('锁定期满自动清零，给回完整次数', async () => {
    for (let i = 0; i < MAX_VIEW_FAILURES; i += 1) await authorizeView('wrong');
    const now = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(now + VIEW_LOCK_MS + 1000);
    try {
      expect(isViewLocked()).toMatchObject({ locked: false, lockedForMs: 0 });
      expect(guardStore().get('failCount')).toBe(0);
      expect(await authorizeView('correct horse')).toMatchObject({ ok: true, code: 'ok' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('computeFailOutcome 是纯函数：第 5 次才触发锁定', () => {
    expect(computeFailOutcome(1, 1000)).toEqual({ failCount: 1, lockedUntil: null, remainingAttempts: 4 });
    expect(computeFailOutcome(4, 1000).lockedUntil).toBeNull();
    expect(computeFailOutcome(5, 1000)).toEqual({ failCount: 5, lockedUntil: 1000 + VIEW_LOCK_MS, remainingAttempts: 0 });
  });
});

describe('OS 验证路径：哪些失败不计入（G5）', () => {
  beforeEach(async () => {
    for (const data of storeState.stores.values()) data.clear();
    _resetViewGateForTest();
    await initTierA();
  });

  it('成功 → ok 并清零计数', async () => {
    _setOsBackendForTest(fakeBackend(GRANTED));
    expect(await authorizeView()).toMatchObject({ ok: true, code: 'ok' });
    expect(guardStore().get('failCount')).toBe(0);
  });

  it('取消 → cancelled，不计数', async () => {
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'cancelled' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'cancelled' });
    expect(guardStore().get('failCount')).toBe(0);
  });

  it('通道不可用 → unavailable（fail closed），不计数', async () => {
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'unavailable', reason: 'timeout' }));
    const result = await authorizeView();
    expect(result).toMatchObject({ ok: false, code: 'unavailable' });
    expect(result.ok).toBe(false);
    expect(guardStore().get('failCount')).toBe(0);
  });

  it('Windows 账户已被系统锁定 → account-locked，不计数、不降级', async () => {
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'account-locked' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'account-locked' });
    expect(guardStore().get('failCount')).toBe(0);
    expect(guardStore().get('osAuthUnavailable')).toBe(false);
  });

  it('凭据错误 / 非当前用户 → wrong-credential，计入失败', async () => {
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'bad-credential' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'wrong-credential', remainingAttempts: MAX_VIEW_FAILURES - 1 });
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'not-current-user' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'wrong-credential', reason: 'not-current-user' });
    expect(guardStore().get('failCount')).toBe(2);
  });

  it('账户不可用 / 策略拒绝 → degraded + 持久化降级（PIN-only 与空密码账户的出路）', async () => {
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'unusable-account', reason: 'unusable-account:1327' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'degraded' });
    expect(guardStore().get('osAuthUnavailable')).toBe(true);
    expect(guardStore().get('failCount')).toBe(0);

    // 降级后 OS 路径不再被调用；设置页的"重新检测"清掉标记后，denied 同样触发降级。
    await resetOsAuthUnavailable();
    expect(await resolveViewGuard()).toMatchObject({ mode: 'os-win' });
    _setOsBackendForTest(fakeBackend({ ok: false, kind: 'denied', reason: 'denied:1385' }));
    expect(await authorizeView()).toMatchObject({ ok: false, code: 'degraded' });
    expect(guardStore().get('osAuthUnavailable')).toBe(true);
  });
});

describe('无门禁可用时不得泄露明文（G1）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    _resetViewGateForTest();
  });

  it('未建库 → none', async () => {
    expect(await authorizeView('anything')).toMatchObject({ ok: false, code: 'none', reason: 'not-initialized' });
  });

  it('dispose 后 DEK 不可用 → none / key-unavailable（不引导用户白输口令）', async () => {
    await initTierC();
    dispose();
    expect(await resolveViewGuard()).toMatchObject({ mode: 'none', reason: 'key-unavailable' });
    expect(await authorizeView('anything')).toMatchObject({ ok: false, code: 'none' });
  });
});
