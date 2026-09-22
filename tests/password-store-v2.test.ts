import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock electron-store（按 name 隔离；暴露 path 供搁置逻辑探测，默认不存在于磁盘） ---
// writes 记录所有 set/clear 调用：失败路径必须零写入（规格 D1/D8 硬不变式）。
const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), writes: [] as string[] }));

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
      (this as unknown as { name: string }).name = name;
    }

    get(key: string): unknown { return this.data.get(key); }
    set(key: string, value: unknown): void {
      storeState.writes.push(`${(this as unknown as { name: string }).name}.set:${key}`);
      this.data.set(key, value);
    }
    clear(): void {
      storeState.writes.push(`${(this as unknown as { name: string }).name}.clear`);
      this.data.clear();
    }
  },
}));

// --- Mock keyring：可控档位（默认 C′：无 OS 后端）---
const keyringState = vi.hoisted(() => ({
  backend: null as string | null,
  unwrapOk: true,
  unwrapKind: 'decrypt-failed' as string,
  unwrapReason: 'unwrap-failed',
}));

vi.mock('../src/main/modules/keyring', () => ({
  detectKeyring: vi.fn(async () => ({
    backend: keyringState.backend as never,
    reason: keyringState.backend ? undefined : 'no-tool',
  })),
  getActiveBackendId: vi.fn(() => keyringState.backend as never),
  keyringWrap: vi.fn(async (secret: string) => (
    keyringState.backend
      ? { ok: true, blob: `enc:${secret}` }
      : { ok: false, kind: 'backend-unavailable', reason: 'keyring-unavailable' }
  )),
  keyringUnwrapAffine: vi.fn(async (blob: string, preferred: string | null) => {
    if (!keyringState.backend) return { ok: false, kind: 'backend-unavailable', reason: 'keyring-unavailable' };
    if (!keyringState.unwrapOk) return { ok: false, kind: keyringState.unwrapKind, reason: keyringState.unwrapReason };
    return { ok: true, secret: blob.startsWith('enc:') ? blob.slice(4) : blob, backend: (preferred ?? keyringState.backend) };
  }),
}));

import fs from 'fs';
import {
  init, initVault, isInitialized, isDekReady, isAutoFillReady,
  setAutoFill, dispose, addEntry, listEntries, getDecryptedPassword,
  getFillCredentialForUrl, deleteEntry, resetAll, getKeyLoadState, isDeterministicKeyFailure,
  getKeyStatus, ensureKeyLoaded, getMetaForHost,
  _looksLikeLegacyStoreText, _looksLikeLegacyPlainKey,
} from '../src/main/modules/password-store';

function storeFor(name: string): Map<string, unknown> | undefined {
  return storeState.stores.get(name);
}

describe('password-store v2 生命周期（C′ 档：无 OS 密钥库）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    keyringState.backend = null;
    keyringState.unwrapOk = true;
    for (const data of storeState.stores.values()) {
      data.set('version', 2);
      data.set('dekAutoFillEnc', null);
      data.set('entries', []);
      data.set('viewFallback', null);
      data.set('_enabled', true);
      data.set('_autoCapture', true);
      data.set('_autoFill', true);
      data.set('_excludedSites', []);
    }
    setAutoFill(true);
  });

  it('initVault：无密码建库，C′ 本地 keyLocal 落盘，DEK 就绪', async () => {
    const result = await initVault();
    expect(result).toEqual({ success: true, tier: 'C' });
    expect(isInitialized()).toBe(true);
    expect(isDekReady()).toBe(true);
    expect(isAutoFillReady()).toBe(true);
    const keyStore = storeFor('password-autofill-key')!;
    expect(keyStore.get('keyLocal')).toMatch(/^v1:/);
    expect(keyStore.get('keyEnc')).toBeNull();
  });

  it('条目加解密与读取：list/add/getDecrypted/fill 语义保持', async () => {
    await initVault();
    const id = addEntry({ host: 'example.com', username: 'alice', password: 'S3cret!' });
    expect(id).toBeTruthy();
    expect(listEntries().map((e) => e.username)).toEqual(['alice']);
    expect(getDecryptedPassword(id)).toBe('S3cret!');
    const auto = getFillCredentialForUrl('https://example.com/login', undefined, true);
    expect(auto).toMatchObject({ host: 'example.com', username: 'alice', password: 'S3cret!' });
    // 关闭 auto-fill 后自动填充不再返回，但显式指定 id（automatic=false）仍可填
    setAutoFill(false);
    expect(getFillCredentialForUrl('https://example.com/login', undefined, true)).toBeNull();
    expect(getFillCredentialForUrl('https://example.com/login', id, false)?.password).toBe('S3cret!');
  });

  // 2026-09-22：对齐 Chrome —— 用户名允许为空（没有用户名框、或捕获时用户名还没进 DOM）。
  it('空用户名条目可以保存与读取，且查重键为 host + 空串', async () => {
    await initVault();
    const id = addEntry({ host: 'nouser.example', username: '', password: 'S3cret!' });
    expect(id).toBeTruthy();
    expect(listEntries().map((e) => e.username)).toEqual(['']);
    expect(getDecryptedPassword(id)).toBe('S3cret!');
    expect(getMetaForHost('nouser.example').map((e) => e.username)).toEqual(['']);
    // host / password 仍然必填
    expect(() => addEntry({ host: '', username: '', password: 'x' })).toThrow('Incomplete params');
    expect(() => addEntry({ host: 'nouser.example', username: '', password: '' })).toThrow('Incomplete params');
  });

  it('重启（dispose→init）：C′ keyLocal 解混淆恢复 DEK，免任何输入', async () => {
    await initVault();
    const id = addEntry({ host: 'a.com', username: 'u', password: 'pw-1' });
    dispose();
    expect(isAutoFillReady()).toBe(false);
    await init();
    expect(isDekReady()).toBe(true);
    expect(isAutoFillReady()).toBe(true);
    expect(getDecryptedPassword(id)).toBe('pw-1');
  });

  it('deleteEntry 生效', async () => {
    await initVault();
    const id = addEntry({ host: 'a.com', username: 'u', password: 'pw-1' });
    expect(deleteEntry(id)).toBe(true);
    expect(listEntries()).toHaveLength(0);
  });

  it('resetAll 清空 vault 与 key 文件，恢复未建库状态', async () => {
    await initVault();
    resetAll();
    expect(isInitialized()).toBe(false);
    expect(isDekReady()).toBe(false);
    expect(storeFor('password-autofill-key')!.get('keyLocal')).toBeFalsy();
  });

  it('C′ keyLocal 损坏 → deterministic/corrupt-local，保留文件不静默装作正常', async () => {
    await initVault();
    const keyStore = storeFor('password-autofill-key')!;
    keyStore.set('keyLocal', 'garbage-not-v1');
    dispose();
    storeState.writes.length = 0;
    await init();
    expect(isDekReady()).toBe(false);
    expect(storeState.writes).toEqual([]);
    expect(keyStore.get('keyLocal')).toBe('garbage-not-v1');
    expect(getKeyLoadState()).toMatchObject({ outcome: 'deterministic', kind: 'corrupt-local' });
  });
});

describe('密钥状态暴露与自愈（规格 D6/D7）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    keyringState.unwrapOk = true;
    keyringState.unwrapKind = 'decrypt-failed';
    keyringState.unwrapReason = 'unwrap-failed';
    for (const data of storeState.stores.values()) {
      data.set('version', 2);
      data.set('dekAutoFillEnc', null);
      data.set('entries', []);
      data.set('_enabled', true);
      data.set('_autoCapture', true);
      data.set('_autoFill', true);
      data.set('_excludedSites', []);
    }
    dispose();
  });

  it('成功：keyStatus=ok、无 issue', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    dispose();
    await ensureKeyLoaded();
    expect(getKeyStatus()).toEqual({ status: 'ok' });
  });

  it('瞬时失败：keyStatus=retrying，issue 带原因/尝试次数/下次重试；自愈后可恢复', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    keyringState.unwrapOk = false;
    keyringState.unwrapKind = 'timeout';
    keyringState.unwrapReason = 'timeout';
    dispose();
    await ensureKeyLoaded();
    const status = getKeyStatus();
    expect(status.status).toBe('retrying');
    expect(status.issue).toMatchObject({ kind: 'transient', reason: 'timeout', hint: 'wait' });
    expect(status.issue?.attempts).toBeGreaterThanOrEqual(1);
    // 会话内自愈：故障消失后再次加载即恢复（无需重启、无需轮换密钥）
    keyringState.unwrapOk = true;
    await ensureKeyLoaded();
    expect(getKeyStatus()).toEqual({ status: 'ok' });
    expect(isAutoFillReady()).toBe(true);
  });

  it('确定性失败：keyStatus=blocked，hint=rebuild（等用户决策，不自动动作）', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    keyringState.unwrapOk = false;
    keyringState.unwrapKind = 'decrypt-failed';
    dispose();
    await ensureKeyLoaded();
    const status = getKeyStatus();
    expect(status.status).toBe('blocked');
    expect(status.issue).toMatchObject({ kind: 'deterministic', reason: 'unwrap-failed', hint: 'rebuild' });
  });

  it('ensureKeyLoaded 幂等：并发调用共享同一次尝试', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    dispose();
    const [a, b] = await Promise.all([ensureKeyLoaded(), ensureKeyLoaded()]);
    expect(a).toEqual(b);
    expect(isDekReady()).toBe(true);
  });

  // 2026-09-21 实测回归：ensureKeyLoaded 位于每次自动填充尝试的路径上，
  // 不带短路时每次都会重新解包（DPAPI 起 PowerShell，~170ms/次），
  // 实测 13 秒会话解包 22 次。
  it('DEK 已就绪时短路：不再重新解包', async () => {
    keyringState.backend = 'win-dpapi';
    await initVault();
    dispose();
    const unwrap = (await import('../src/main/modules/keyring')).keyringUnwrapAffine as unknown as { mock: { calls: unknown[] } };
    await ensureKeyLoaded();
    const afterFirst = unwrap.mock.calls.length;
    await ensureKeyLoaded();
    await ensureKeyLoaded();
    expect(unwrap.mock.calls.length).toBe(afterFirst);
    expect(isDekReady()).toBe(true);
    expect(getKeyStatus()).toEqual({ status: 'ok' });
  });
});

describe('密钥失败种类 → transient/deterministic 归属（规格 D2）', () => {
  it('确定性：只有"文件/密文本身有问题"这类', () => {
    for (const kind of ['decrypt-failed', 'key-length-mismatch', 'corrupt-local', 'legacy-plaintext', 'key-material-missing'] as const) {
      expect(isDeterministicKeyFailure(kind)).toBe(true);
    }
  });

  it('瞬时性：环境/时序/传输类，必须可重试', () => {
    for (const kind of ['backend-unavailable', 'timeout', 'spawn-failed', 'protocol-error'] as const) {
      expect(isDeterministicKeyFailure(kind)).toBe(false);
    }
  });
});

describe('password-store v2（A 档：OS 密钥库可用）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    keyringState.backend = 'win-dpapi';
    keyringState.unwrapOk = true;
    for (const data of storeState.stores.values()) {
      data.set('version', 2);
      data.set('dekAutoFillEnc', null);
      data.set('entries', []);
      data.set('viewFallback', null);
      data.set('_enabled', true);
      data.set('_autoCapture', true);
      data.set('_autoFill', true);
      data.set('_excludedSites', []);
    }
    setAutoFill(true);
  });

  it('验证用 initVault 走 keyEnc（OS 加密），重启后经 unwrap 恢复', async () => {
    const result = await initVault();
    expect(result).toEqual({ success: true, tier: 'A' });
    const keyStore = storeFor('password-autofill-key')!;
    expect(keyStore.get('keyEnc')).toMatch(/^enc:/);
    expect(keyStore.get('keyLocal')).toBeNull();
    const id = addEntry({ host: 'a.com', username: 'u', password: 'pw-A' });
    dispose();
    await init();
    expect(getDecryptedPassword(id)).toBe('pw-A');
  });

  // 2026-09-21 事故回归防线：过去这条用例断言的是"失败即搁置文件"，
  // 把破坏性行为锁成了预期。现在断言的是相反的不变式（规格 D1）。
  it('OS unwrap 确定性失败 → 保留密钥文件、DEK 不可用、状态 deterministic、零写盘', async () => {
    await initVault();
    const keyStore = storeFor('password-autofill-key')!;
    const storedBlob = keyStore.get('keyEnc');
    expect(storedBlob).toBeTruthy();
    keyringState.unwrapOk = false;
    keyringState.unwrapKind = 'decrypt-failed';
    dispose();
    const rename = vi.spyOn(fs, 'renameSync');
    const unlink = vi.spyOn(fs, 'unlinkSync');
    storeState.writes.length = 0;
    try {
      await init();
    } finally {
      rename.mockRestore();
      unlink.mockRestore();
    }
    expect(isDekReady()).toBe(false);
    expect(isAutoFillReady()).toBe(false);
    // 密钥材料原样保留：不轮换、不清空、不改名
    expect(keyStore.get('keyEnc')).toBe(storedBlob);
    expect(keyStore.get('keyLocal')).toBeNull();
    expect(rename).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
    expect(storeState.writes).toEqual([]);
    expect(getKeyLoadState()).toMatchObject({ outcome: 'deterministic', kind: 'decrypt-failed' });
    expect(isDeterministicKeyFailure('decrypt-failed')).toBe(true);
  });

  it('OS unwrap 瞬时失败（timeout）→ 保留文件、状态 transient（可重试）', async () => {
    await initVault();
    const keyStore = storeFor('password-autofill-key')!;
    const storedBlob = keyStore.get('keyEnc');
    keyringState.unwrapOk = false;
    keyringState.unwrapKind = 'timeout';
    keyringState.unwrapReason = 'timeout';
    dispose();
    storeState.writes.length = 0;
    await init();
    expect(isDekReady()).toBe(false);
    expect(keyStore.get('keyEnc')).toBe(storedBlob);
    expect(storeState.writes).toEqual([]);
    expect(getKeyLoadState()).toMatchObject({ outcome: 'transient', kind: 'timeout' });
    expect(isDeterministicKeyFailure('timeout')).toBe(false);
    // 后恢复：同一把 key 仍可用（没有被轮换掉）
    keyringState.unwrapOk = true;
    await init();
    expect(isDekReady()).toBe(true);
    expect(getKeyLoadState()).toMatchObject({ outcome: 'ok' });
    expect(keyStore.get('keyEnc')).toBe(storedBlob);
  });

  it('库已建但 key 材料缺失（历史破坏性版本留下的状态）→ deterministic，不静默装作正常', async () => {
    await initVault();
    const keyStore = storeFor('password-autofill-key')!;
    keyStore.set('keyEnc', null);
    keyStore.set('keyLocal', null);
    dispose();
    storeState.writes.length = 0;
    await init();
    expect(isDekReady()).toBe(false);
    expect(storeState.writes).toEqual([]);
    expect(getKeyLoadState()).toMatchObject({ outcome: 'deterministic', kind: 'key-material-missing' });
  });
});

describe('旧明文 key 搁置（决策 8 白名单：唯一允许的读路径搁置）', () => {
  it('检出非空 key/keyPlain → 搁置并清空（其它失败路径不得如此）', async () => {
    for (const data of storeState.stores.values()) data.clear();
    for (const data of storeState.stores.values()) {
      data.set('version', 2);
      data.set('dekAutoFillEnc', { iv: 'a', ct: 'b', tag: 'c' });
      data.set('entries', []);
      data.set('_enabled', true);
      data.set('_autoCapture', true);
      data.set('_autoFill', true);
      data.set('_excludedSites', []);
    }
    const keyStore = storeFor('password-autofill-key');
    keyStore?.set('key', 'plain-legacy-key');
    const exists = vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => undefined);
    const unlink = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);
    const read = vi.spyOn(fs, 'readFileSync');
    read.mockImplementation((() => JSON.stringify({ key: 'plain-legacy-key' })) as never);
    try {
      await init();
      expect(rename).toHaveBeenCalledTimes(1);
      expect(keyStore?.get('key')).toBeUndefined();
      expect(getKeyLoadState()).toMatchObject({ outcome: 'deterministic', kind: 'legacy-plaintext' });
    } finally {
      exists.mockRestore();
      rename.mockRestore();
      unlink.mockRestore();
      read.mockRestore();
    }
  });
});

describe('旧数据检测（审计 #10 收紧条件）', () => {
  it('v1 密码本：salt/dekMasterEnc 非 null 或 version<2 → legacy', () => {
    expect(_looksLikeLegacyStoreText(JSON.stringify({ version: 1, salt: 'x', dekMasterEnc: { iv: 'a', ct: 'b', tag: 'c' } }))).toBe(true);
    expect(_looksLikeLegacyStoreText(JSON.stringify({ version: 1, salt: null, dekMasterEnc: null }))).toBe(true);
    // 新机默认（无文件时仅内存 defaults；若落盘也是 v2 形态）→ 非 legacy
    expect(_looksLikeLegacyStoreText(JSON.stringify({ version: 2, salt: null, dekMasterEnc: null }))).toBe(false);
    expect(_looksLikeLegacyStoreText(JSON.stringify({ version: 2, dekAutoFillEnc: null }))).toBe(false);
    expect(_looksLikeLegacyStoreText('not json')).toBe(true);
  });

  it('旧明文 key：key / keyPlain 非空 → legacy；null 不算', () => {
    expect(_looksLikeLegacyPlainKey({ key: 'abc' })).toBe(true);
    expect(_looksLikeLegacyPlainKey({ keyPlain: 'abc' })).toBe(true);
    expect(_looksLikeLegacyPlainKey({ key: null, keyPlain: null })).toBe(false);
    expect(_looksLikeLegacyPlainKey({ keyEnc: 'x' })).toBe(false);
    expect(_looksLikeLegacyPlainKey(null)).toBe(false);
  });
});
