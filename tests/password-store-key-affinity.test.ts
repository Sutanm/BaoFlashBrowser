import { beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';

/**
 * 后端亲和标签（规格 D4）：
 * - keyEnc 落盘时记录产出它的后端（keyEncBackend）；
 * - 读取时优先标签后端，标签缺失/失配则**只读试解**（≤2 个候选），成功才回写标签；
 * - 全失败保留文件、零写盘。
 *
 * 历史裸 base64 密文（09-03~09-21 之间落盘的形态）等价于"标签为空"，
 * 因此本组用例也是那次事故遗留文件的恢复路径回归保护。
 */

const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>(), writes: [] as string[] }));

vi.mock('electron-store', () => ({
  default: class MockStore {
    readonly path: string;
    private readonly data: Map<string, unknown>;
    private readonly name: string;

    constructor(options: { name?: string; defaults?: Record<string, unknown> }) {
      this.name = options.name ?? 'config';
      this.path = `/mock/${this.name}.json`;
      let data = storeState.stores.get(this.name);
      if (!data) {
        data = new Map(Object.entries(options.defaults ?? {}));
        storeState.stores.set(this.name, data);
      }
      this.data = data;
    }

    get(key: string): unknown { return this.data.get(key); }
    set(key: string, value: unknown): void {
      storeState.writes.push(`${this.name}.set:${key}`);
      this.data.set(key, value);
    }
    clear(): void {
      storeState.writes.push(`${this.name}.clear`);
      this.data.clear();
    }
  },
}));

const keyringState = vi.hoisted(() => ({
  active: 'win-dpapi' as string | null,
  available: ['win-dpapi', 'electron-safestorage'] as string[],
  canUnwrap: new Set<string>(),
  attemptOrder: [] as string[],
}));

vi.mock('../src/main/modules/keyring', () => ({
  detectKeyring: vi.fn(async () => ({
    backend: keyringState.active as never,
    reason: keyringState.active ? undefined : 'no-tool',
  })),
  getActiveBackendId: vi.fn(() => keyringState.active as never),
  keyringWrap: vi.fn(async (secret: string) => ({ ok: true, blob: `blob:${secret}` })),
  keyringUnwrapAffine: vi.fn(async (blob: string, preferred: string | null) => {
    const order: string[] = [];
    if (preferred && keyringState.available.includes(preferred)) order.push(preferred);
    if (keyringState.active && keyringState.available.includes(keyringState.active) && !order.includes(keyringState.active)) {
      order.push(keyringState.active);
    }
    for (const id of keyringState.available) {
      if (order.length >= 2) break;
      if (!order.includes(id)) order.push(id);
    }
    for (const id of order.slice(0, 2)) {
      keyringState.attemptOrder.push(id);
      if (keyringState.canUnwrap.has(id)) {
        return { ok: true, secret: blob.startsWith('blob:') ? blob.slice(5) : blob, backend: id };
      }
    }
    return { ok: false, kind: 'decrypt-failed', reason: 'unwrap-failed' };
  }),
}));

import { init, isDekReady, dispose, getKeyLoadState } from '../src/main/modules/password-store';

const KEY_LEN = 32;

function storeFor(name: string): Map<string, unknown> {
  let data = storeState.stores.get(name);
  if (!data) {
    data = new Map();
    storeState.stores.set(name, data);
  }
  return data;
}

/** 造一个"库已建 + 有 wrap key"的真实可解状态（密文用真 AES-256-GCM 生成）。 */
function seedVault(opts: { tag: string | null; wrapKeyBackendReadable: boolean }): { keyStore: Map<string, unknown>; store: Map<string, unknown> } {
  const wrapKey = crypto.randomBytes(KEY_LEN);
  const dek = crypto.randomBytes(KEY_LEN);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
  const ct = Buffer.concat([cipher.update(dek), cipher.final()]);

  const store = storeFor('password-store');
  store.set('version', 2);
  store.set('dekAutoFillEnc', { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  store.set('entries', []);
  store.set('viewFallback', null);
  store.set('_enabled', true);
  store.set('_autoCapture', true);
  store.set('_autoFill', true);
  store.set('_excludedSites', []);

  const keyStore = storeFor('password-autofill-key');
  keyStore.set('keyEnc', `blob:${wrapKey.toString('base64')}`);
  keyStore.set('keyEncBackend', opts.tag);
  keyStore.set('keyLocal', null);
  if (opts.wrapKeyBackendReadable) keyringState.canUnwrap.add(keyringState.active ?? 'win-dpapi');
  return { keyStore, store };
}

describe('keyEnc 后端亲和标签（规格 D4）', () => {
  beforeEach(() => {
    for (const data of storeState.stores.values()) data.clear();
    storeState.writes.length = 0;
    keyringState.active = 'win-dpapi';
    keyringState.available = ['win-dpapi', 'electron-safestorage'];
    keyringState.canUnwrap = new Set();
    keyringState.attemptOrder = [];
    dispose();
  });

  it('无标签（历史裸密文）→ 只读试解成功并回写标签', async () => {
    const { keyStore } = seedVault({ tag: null, wrapKeyBackendReadable: true });
    await init();
    expect(isDekReady()).toBe(true);
    expect(keyStore.get('keyEncBackend')).toBe('win-dpapi');
    expect(getKeyLoadState().outcome).toBe('ok');
  });

  it('标签指向非活跃后端但可解 → 先试标签后端，成功即纠正标签', async () => {
    const { keyStore } = seedVault({ tag: 'electron-safestorage', wrapKeyBackendReadable: false });
    keyringState.canUnwrap.add('electron-safestorage');
    await init();
    expect(isDekReady()).toBe(true);
    expect(keyringState.attemptOrder[0]).toBe('electron-safestorage');
    expect(keyStore.get('keyEncBackend')).toBe('electron-safestorage');
  });

  it('标签后端解不开、活跃后端可解 → 试解顺序 标签→活跃，成功后标签被纠正', async () => {
    const { keyStore } = seedVault({ tag: 'electron-safestorage', wrapKeyBackendReadable: true });
    await init();
    expect(isDekReady()).toBe(true);
    expect(keyringState.attemptOrder).toEqual(['electron-safestorage', 'win-dpapi']);
    expect(keyStore.get('keyEncBackend')).toBe('win-dpapi');
  });

  it('标签后端缺失（本机不可用）→ 回落当前活跃后端，成功不改密文只改标签', async () => {
    const { keyStore } = seedVault({ tag: 'linux-secret-service', wrapKeyBackendReadable: true });
    const blobBefore = keyStore.get('keyEnc');
    await init();
    expect(isDekReady()).toBe(true);
    expect(keyStore.get('keyEnc')).toBe(blobBefore);
    expect(keyStore.get('keyEncBackend')).toBe('win-dpapi');
  });

  it('全部候选解不开 → deterministic，密文与标签原样保留、零写盘', async () => {
    const { keyStore } = seedVault({ tag: 'win-dpapi', wrapKeyBackendReadable: false });
    const blobBefore = keyStore.get('keyEnc');
    storeState.writes.length = 0;
    await init();
    expect(isDekReady()).toBe(false);
    expect(keyStore.get('keyEnc')).toBe(blobBefore);
    expect(keyStore.get('keyEncBackend')).toBe('win-dpapi');
    expect(storeState.writes).toEqual([]);
    expect(getKeyLoadState()).toMatchObject({ outcome: 'deterministic', kind: 'decrypt-failed' });
  });
});
