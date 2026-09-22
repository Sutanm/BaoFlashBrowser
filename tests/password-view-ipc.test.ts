// @vitest-environment node
/**
 * reveal 授权制（规格 G1/G11/G12）：门禁必须在解密之前，且未授权时**绝不触碰明文**。
 *
 * 这是 IPC 层的集成测试：真实走 zod 校验 → view-gate → password-store，
 * 只在最外圈 mock 掉 electron / electron-store / keyring / tabs。
 * 关键断言用 spy 钉死"未授权时 getDecryptedPassword 调用次数为 0"——
 * 比读代码可靠，也比 grep 可靠。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

// --- ipcMain 假注册表：把 createHandler 注册的处理器暴露成可直接调用的函数 ---
const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, (args: unknown) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, args: unknown) => unknown) => {
      ipcState.handlers.set(channel, (args: unknown) => fn({}, args));
    },
    on: () => { /* not used by password IPC */ },
  },
}));

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

vi.mock('../src/main/modules/tabs', () => ({
  tabManager: { refreshPasswordFill: vi.fn(), refreshPasswordCapture: vi.fn(), fillPassword: vi.fn() },
}));
vi.mock('../src/main/modules/password-capture', () => ({
  getPendingCredential: vi.fn(() => null),
  removePendingCredential: vi.fn(),
  notifyPasswordChanged: vi.fn(),
}));

// password-store 保留真实实现，只把解密函数换成可计数的 spy。
vi.mock('../src/main/modules/password-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/modules/password-store')>();
  return { ...actual, getDecryptedPassword: vi.fn(actual.getDecryptedPassword) };
});

import { addEntry, dispose, initVault, getDecryptedPassword, listEntries } from '../src/main/modules/password-store';
import { setViewPassword, _setOsBackendForTest, _resetViewGateForTest } from '../src/main/modules/view-gate';
import { registerPasswordIPC } from '../src/main/ipc/password.ipc';

const decryptSpy = vi.mocked(getDecryptedPassword);
const reveal = (payload: unknown): Promise<Record<string, unknown>> =>
  ipcState.handlers.get('password:reveal')!(payload) as Promise<Record<string, unknown>>;
const setViewPwd = (payload: unknown): Promise<Record<string, unknown>> =>
  ipcState.handlers.get('password:set-view-password')!(payload) as Promise<Record<string, unknown>>;
const resetOsAuth = (): Promise<Record<string, unknown>> =>
  ipcState.handlers.get('password:reset-os-auth')!(undefined) as Promise<Record<string, unknown>>;
const status = (): Promise<Record<string, unknown>> =>
  ipcState.handlers.get('password:status')!(undefined) as Promise<Record<string, unknown>>;

function seedStores(): void {
  for (const data of storeState.stores.values()) data.clear();
  _resetViewGateForTest();
  keyringState.backend = null;
}

async function initTierCWithEntry(): Promise<string> {
  seedStores();
  await initVault();
  return addEntry({ host: 'a.com', username: 'u', password: 'pw-A' });
}

describe('password:reveal 授权制', () => {
  beforeEach(() => {
    seedStores();
    decryptSpy.mockClear();
    logMock.info.mockClear();
    logMock.warn.mockClear();
    if (!ipcState.handlers.size) registerPasswordIPC();
  });

  it('未建库 → not-authorized，且不触碰解密', async () => {
    const result = await reveal({ id: 'no-such-entry' });
    expect(result).toMatchObject({ error: 'not-authorized' });
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('条目不存在 → missing，且不消耗验证次数（不白输一次口令）', async () => {
    await initVault();
    await setViewPassword('correct horse');
    const result = await reveal({ id: 'missing-entry', secret: 'correct horse' });
    expect(result).toMatchObject({ error: 'missing' });
    expect(decryptSpy).not.toHaveBeenCalled();

    const state = storeState.stores.get('password-view-guard')!;
    expect(state.get('failCount')).toBe(0);
  });

  it('C 档尚未设置查看密码 → needs-setup，不解密', async () => {
    const id = await initTierCWithEntry();
    const result = await reveal({ id });
    expect(result).toMatchObject({ error: 'needs-setup', mode: 'password' });
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('未带口令 → needs-input，不解密', async () => {
    const id = await initTierCWithEntry();
    await setViewPassword('correct horse');
    expect(await reveal({ id })).toMatchObject({ error: 'needs-input' });
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('口令错误 → wrong-credential + 剩余次数，不解密', async () => {
    const id = await initTierCWithEntry();
    await setViewPassword('correct horse');
    const result = await reveal({ id, secret: 'nope' });
    expect(result).toMatchObject({ error: 'wrong-credential', remainingAttempts: 4 });
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('口令正确 → 返回明文，且恰好解密一次', async () => {
    const id = await initTierCWithEntry();
    await setViewPassword('correct horse');
    const result = await reveal({ id, secret: 'correct horse' });
    expect(result).toMatchObject({ password: 'pw-A', mode: 'password' });
    expect(decryptSpy).toHaveBeenCalledTimes(1);
  });

  it('锁定后连正确口令也拒绝，且不解密', async () => {
    const id = await initTierCWithEntry();
    await setViewPassword('correct horse');
    for (let i = 0; i < 5; i += 1) await reveal({ id, secret: 'nope' });
    const result = await reveal({ id, secret: 'correct horse' });
    expect(result.error).toBe('locked');
    expect(result.lockedForMs).toBeTypeOf('number');
    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('A 档：取消 / 通道不可用 → 不解密（fail closed）', async () => {
    seedStores();
    keyringState.backend = 'win-dpapi';
    await initVault();
    const id = addEntry({ host: 'b.com', username: 'u', password: 'pw-B' });

    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: false, kind: 'cancelled' }; } });
    expect(await reveal({ id })).toMatchObject({ error: 'cancelled' });

    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: false, kind: 'unavailable', reason: 'timeout' }; } });
    expect(await reveal({ id })).toMatchObject({ error: 'unavailable', reason: 'timeout' });

    expect(decryptSpy).not.toHaveBeenCalled();
  });

  it('A 档验证通过 → 返回明文', async () => {
    seedStores();
    keyringState.backend = 'win-dpapi';
    await initVault();
    const id = addEntry({ host: 'c.com', username: 'u', password: 'pw-C' });
    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: true }; } });
    expect(await reveal({ id })).toMatchObject({ password: 'pw-C', mode: 'os-win' });
  });

  it('入参严格校验：多余字段被拒', async () => {
    await initTierCWithEntry();
    await expect(reveal({ id: 'x', secret: 'y', extra: 1 })).rejects.toThrow(/Invalid arguments/);
    expect(decryptSpy).not.toHaveBeenCalled();
  });
});

describe('password:set-view-password', () => {
  beforeEach(() => {
    seedStores();
    if (!ipcState.handlers.size) registerPasswordIPC();
  });

  it('C 档可设置；过短被拒', async () => {
    await initVault();
    expect(await setViewPwd({ password: 'abc' })).toMatchObject({ success: false, error: 'weak-password' });
    expect(await setViewPwd({ password: 'long enough' })).toMatchObject({ success: true });
  });

  it('A 档（走系统验证）拒绝写入查看密码：避免留下永不生效的材料', async () => {
    seedStores();
    keyringState.backend = 'win-dpapi';
    await initVault();
    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: true }; } });
    expect(await setViewPwd({ password: 'long enough' })).toMatchObject({ success: false, error: 'not-available' });
  });
});

describe('password:reset-os-auth 与 status', () => {
  beforeEach(() => {
    seedStores();
    if (!ipcState.handlers.size) registerPasswordIPC();
  });

  it('降级后可重新检测，status 反映真实门禁（不再用占位）', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: false, kind: 'unusable-account', reason: 'unusable-account:1327' }; } });
    await ipcState.handlers.get('password:status')!(undefined);
    expect(((await status()).viewGuard as Record<string, unknown>)).toMatchObject({ mode: 'os-win' });

    // 触发降级
    const id = addEntry({ host: 'd.com', username: 'u', password: 'pw-D' });
    await reveal({ id });
    expect(((await status()).viewGuard as Record<string, unknown>)).toMatchObject({
      mode: 'password', reason: 'os-auth-unavailable', passwordSet: false,
    });

    // 重新检测（模拟用户在系统侧修好账户）
    _setOsBackendForTest({ id: 'win-credui', async available() { return true; }, async verify() { return { ok: true }; } });
    const reset = await resetOsAuth();
    expect((reset.viewGuard as Record<string, unknown>)).toMatchObject({ mode: 'os-win' });
  });

  it('dispose 后 status 的门禁退到 none（不引导用户白输口令）', async () => {
    await initVault();
    dispose();
    expect(((await status()).viewGuard as Record<string, unknown>)).toMatchObject({
      mode: 'none', reason: 'key-unavailable',
    });
  });

  it('列表仍可用（门禁不挡列条目）', async () => {
    await initTierCWithEntry();
    expect(listEntries()).toHaveLength(1);
  });
});
