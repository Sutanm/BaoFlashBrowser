import { describe, expect, it, beforeEach } from 'vitest';
import {
  resolveBackend,
  detectKeyring,
  clearKeyringCache,
  _setActiveBackendForTest,
  keyringWrap,
  keyringUnwrap,
  type KeyringBackend,
  type KeyringBackendId,
} from '../src/main/modules/keyring';

function makeBackend(
  id: KeyringBackendId,
  opts: {
    available?: boolean;
    probeOk?: boolean;
    probeReason?: string;
    wrapOk?: boolean;
    wrapReason?: string;
  } = {},
): KeyringBackend {
  return {
    id,
    async available() { return opts.available ?? true; },
    async probe() {
      return opts.probeOk === false
        ? { ok: false, reason: opts.probeReason ?? 'probe-failed' }
        : { ok: true };
    },
    async wrap(_secret) {
      return opts.wrapOk === false
        ? { ok: false, reason: opts.wrapReason ?? 'wrap-failed' }
        : { ok: true, blob: `blob:${_secret}` };
    },
    async unwrap(blob) {
      return { ok: true, secret: `secret:${blob}` };
    },
  };
}

describe('keyring 探测与后端选择', () => {
  beforeEach(() => clearKeyringCache());

  it('命中第一个可用候选（safeStorage 优先语义）', async () => {
    const ss = makeBackend('electron-safestorage');
    const plat = makeBackend('win-dpapi');
    const { status, backend } = await resolveBackend('win32', [ss, plat]);
    expect(status.backend).toBe('electron-safestorage');
    expect(backend).toBe(ss);
  });

  it('候选探测失败即停止并返回其 reason（不回落后续候选）', async () => {
    const ss = makeBackend('electron-safestorage', { probeOk: false, probeReason: 'safe-storage-unavailable' });
    const plat = makeBackend('win-dpapi');
    const { status } = await resolveBackend('win32', [ss, plat]);
    expect(status).toEqual({ backend: null, reason: 'safe-storage-unavailable' });
  });

  it('available=false 的候选被跳过，落到下一个', async () => {
    const ss = makeBackend('electron-safestorage', { available: false });
    const plat = makeBackend('win-dpapi');
    const { status } = await resolveBackend('win32', [ss, plat]);
    expect(status.backend).toBe('win-dpapi');
  });

  it('无任何候选时返回按平台的 reason', async () => {
    expect(await resolveBackend('linux', [])).toEqual({ backend: null, status: { backend: null, reason: 'no-tool' } });
    expect(await resolveBackend('freebsd', [])).toEqual({ backend: null, status: { backend: null, reason: 'unsupported-platform' } });
  });

  it('detectKeyring 命中注入缓存，clearKeyringCache 后可重新注入', async () => {
    _setActiveBackendForTest(makeBackend('win-dpapi'));
    expect(await detectKeyring()).toEqual({ backend: 'win-dpapi' });
    clearKeyringCache();
    _setActiveBackendForTest(null);
    expect(await detectKeyring()).toEqual({ backend: null, reason: 'test-none' });
  });
});

describe('keyring wrap/unwrap 便捷封装', () => {
  beforeEach(() => clearKeyringCache());

  it('有活跃后端时正常加解密', async () => {
    _setActiveBackendForTest(makeBackend('win-dpapi'));
    const w = await keyringWrap('c2VjcmV0');
    expect(w).toEqual({ ok: true, blob: 'blob:c2VjcmV0' });
    const u = await keyringUnwrap('blob:x');
    expect(u).toEqual({ ok: true, secret: 'secret:blob:x' });
  });

  it('无活跃后端时返回失败与 reason', async () => {
    _setActiveBackendForTest(null);
    expect(await keyringWrap('c2VjcmV0')).toEqual({ ok: false, reason: 'test-none' });
    expect(await keyringUnwrap('x')).toEqual({ ok: false, reason: 'test-none' });
  });

  it('后端 wrap 失败时透传其 reason', async () => {
    _setActiveBackendForTest(makeBackend('win-dpapi', { wrapOk: false, wrapReason: 'no-powershell' }));
    expect(await keyringWrap('c2VjcmV0')).toEqual({ ok: false, reason: 'no-powershell' });
  });
});
