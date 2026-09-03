import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock electron-store（按 name 隔离；暴露 path 供搁置逻辑探测，默认不存在于磁盘） ---
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

// --- Mock keyring：可控档位（默认 C′：无 OS 后端）---
const keyringState = vi.hoisted(() => ({
  backend: null as string | null,
  unwrapOk: true,
}));

vi.mock('../src/main/modules/keyring', () => ({
  detectKeyring: vi.fn(async () => ({
    backend: keyringState.backend as never,
    reason: keyringState.backend ? undefined : 'no-tool',
  })),
  keyringWrap: vi.fn(async (secret: string) => (
    keyringState.backend ? { ok: true, blob: `enc:${secret}` } : { ok: false, reason: 'keyring-unavailable' }
  )),
  keyringUnwrap: vi.fn(async (blob: string) => {
    if (!keyringState.backend) return { ok: false, reason: 'keyring-unavailable' };
    if (!keyringState.unwrapOk) return { ok: false, reason: 'unwrap-failed' };
    return { ok: true, secret: blob.startsWith('enc:') ? blob.slice(4) : blob };
  }),
}));

import {
  init, initVault, isInitialized, isDekReady, isAutoFillReady,
  setAutoFill, dispose, addEntry, listEntries, getDecryptedPassword,
  getFillCredentialForUrl, deleteEntry, resetAll,
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

  it('initVault 走 keyEnc（OS 加密），重启后经 unwrap 恢复', async () => {
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

  it('OS unwrap 失败（后端失配/跨机器）→ 文件搁置、DEK 不可用、不崩溃', async () => {
    await initVault();
    keyringState.unwrapOk = false;
    dispose();
    await init();
    expect(isDekReady()).toBe(false);
    expect(storeFor('password-autofill-key')!.get('keyEnc')).toBeFalsy();
    expect(storeFor('password-autofill-key')!.get('keyLocal')).toBeFalsy();
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
