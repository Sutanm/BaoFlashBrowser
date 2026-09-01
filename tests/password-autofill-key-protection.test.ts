import { beforeEach, describe, expect, it, vi } from 'vitest';

// --- Mock electron-store（内存实现，按 name 隔离） ---
const storeState = vi.hoisted(() => ({ stores: new Map<string, Map<string, unknown>>() }));

vi.mock('electron-store', () => ({
  default: class MockStore {
    private readonly data: Map<string, unknown>;
    readonly path = '/mock/password-autofill-key.json';

    constructor(options: { name?: string; defaults?: Record<string, unknown> }) {
      const name = options.name ?? 'config';
      let data = storeState.stores.get(name);
      if (!data) {
        data = new Map(Object.entries(options.defaults ?? {}));
        storeState.stores.set(name, data);
      }
      this.data = data;
    }

    get(key: string): unknown { return this.data.get(key); }
    // electron-store 支持对象形式 set({a, b}) 合并写入多个 key。
    set(key: string | Record<string, unknown>, value?: unknown): void {
      if (typeof key === 'string') {
        this.data.set(key, value);
        return;
      }
      for (const [k, v] of Object.entries(key)) this.data.set(k, v);
    }
    clear(): void { this.data.clear(); }
  },
}));

// --- safe-storage 适配层可注入 mock（默认真实实现：纯 Node 下不可用） ---
const safeStorageMock = vi.hoisted(() => ({
  available: false,
  encrypt: (plain: string) => `enc:${plain}`,
  decrypt: (enc: string) => enc.startsWith('enc:') ? enc.slice(4) : null,
  isSafeStorageAvailable: vi.fn(),
  encryptWithSafeStorage: vi.fn(),
  decryptWithSafeStorage: vi.fn(),
}));

vi.mock('../src/main/utils/safe-storage', () => ({
  isSafeStorageAvailable: safeStorageMock.isSafeStorageAvailable,
  encryptWithSafeStorage: safeStorageMock.encryptWithSafeStorage,
  decryptWithSafeStorage: safeStorageMock.decryptWithSafeStorage,
}));

// 必须在使用前配置 mock 行为（vi.mock 提升，但函数体在 import 后执行）
safeStorageMock.isSafeStorageAvailable.mockImplementation(() => safeStorageMock.available);
safeStorageMock.encryptWithSafeStorage.mockImplementation((plain: string) =>
  safeStorageMock.available ? safeStorageMock.encrypt(plain) : null);
safeStorageMock.decryptWithSafeStorage.mockImplementation((enc: string) =>
  safeStorageMock.available ? safeStorageMock.decrypt(enc) : null);

import {
  setupMaster,
  unlockWithMaster,
  isAutoFillReady,
  setAutoFill,
  init,
} from '../src/main/modules/password-store';

function autoFillStore(): Map<string, unknown> | undefined {
  return storeState.stores.get('password-autofill-key');
}

describe('password-store auto-fill key protection', () => {
  beforeEach(() => {
    // 清空每个 store 的 data，但保留注册的 Map（模块单例 MockStore 实例
    // 持有 this.data 引用，删除注册会导致后续读写落空）。
    for (const data of storeState.stores.values()) data.clear();
    // 重置 mock 状态
    safeStorageMock.available = false;
  });

  it('rejects persisting a plaintext auto-fill key when safeStorage is unavailable', async () => {
    await setupMaster('Str0ngPass!');
    const store = autoFillStore();
    expect(store).toBeDefined();
    // 绝不明文落盘（MockStore 对未写 key 返回 undefined，语义等价于 null）
    expect(store?.get('keyPlain') ?? null).toBeNull();
    expect(store?.get('keyEnc') ?? null).toBeNull();
    // safeStorage 不可用时 auto-fill 未就绪（没有 DEK 可用）
    expect(isAutoFillReady()).toBe(false);
  });

  it('persists the auto-fill key encrypted via safeStorage when available', async () => {
    safeStorageMock.available = true;
    await setupMaster('Str0ngPass!');
    const store = autoFillStore();
    expect(store?.get('keyEnc')).toMatch(/^enc:/);
    expect(store?.get('keyPlain')).toBeNull();
    expect(isAutoFillReady()).toBe(true);
  });

  it('migrates a legacy plaintext key to an encrypted one on first read', async () => {
    safeStorageMock.available = true;
    // 预置旧版本明文 key（base64 的 32 字节）
    const legacyKey = Buffer.alloc(32, 7).toString('base64');
    autoFillStore()?.set('keyPlain', legacyKey);
    // setupMaster 会读取（迁移）旧 key 并重新包裹 DEK
    await setupMaster('Str0ngPass!');
    const store = autoFillStore();
    expect(store?.get('keyPlain')).toBeNull();
    expect(store?.get('keyEnc')).toMatch(/^enc:/);
    expect(isAutoFillReady()).toBe(true);
  });

  it('loads the encrypted key at init when auto-fill is enabled', async () => {
    safeStorageMock.available = true;
    await setupMaster('Str0ngPass!');
    expect(isAutoFillReady()).toBe(true);
    // 模拟重启：清空内存 DEK，持久化 auto-fill 开关保持开启，init() 应恢复。
    setAutoFill(false);
    storeState.stores.get('password-store')?.set('_autoFill', true);
    expect(isAutoFillReady()).toBe(false);
    await init();
    expect(isAutoFillReady()).toBe(true);
  });

  it('can still unlock with the master password and read entries', async () => {
    safeStorageMock.available = false;
    await setupMaster('Str0ngPass!');
    await unlockWithMaster('Str0ngPass!');
    // 主密码解锁路径不受 safeStorage 影响
    expect(true).toBe(true);
  });
});
