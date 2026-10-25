import { describe, expect, it, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { DEFAULT_PROXY, proxySettingsSchema, proxyTestSchema, toElectronProxy } from '../src/shared/types/proxy';
import { requiresMainConfigRestart } from '../src/renderer/services/settings-restart';

const mocks = vi.hoisted(() => ({
  defaultSession: { setProxy: vi.fn().mockResolvedValue(undefined) },
  tabSession: { setProxy: vi.fn().mockResolvedValue(undefined) },
  testSession: { setProxy: vi.fn().mockResolvedValue(undefined), resolveProxy: vi.fn().mockResolvedValue('PROXY 127.0.0.1:7890') },
  request: vi.fn(),
  fromPartition: vi.fn(),
}));
vi.mock('electron', () => ({
  session: { defaultSession: mocks.defaultSession, fromPartition: mocks.fromPartition },
  net: { request: mocks.request },
}));
import { initializeProxy, testProxy, usesBrowserDownloads } from '../src/main/modules/proxy';

const manual = { ...DEFAULT_PROXY, mode: 'manual' as const, host: '127.0.0.1' };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fromPartition.mockImplementation((partition: string) => partition === 'persist:' ? mocks.tabSession : mocks.testSession);
});

describe('proxy validation and Electron 11 configuration', () => {
  it('keeps system sessions untouched and explicitly clears proxy rules for direct', () => {
    expect(toElectronProxy(DEFAULT_PROXY)).toBeNull();
    expect(toElectronProxy({ ...DEFAULT_PROXY, mode: 'direct' })).toEqual({ proxyRules: '' });
  });

  it('supports HTTP, SOCKS5, IPv6 and bypass rules without a direct fallback', () => {
    expect(toElectronProxy(manual)).toEqual({ proxyRules: 'http://127.0.0.1:7890', proxyBypassRules: '' });
    const socks = { ...manual, protocol: 'socks5' as const, host: '[::1]', bypass: '*.example.com' };
    expect(proxySettingsSchema.parse(socks)).toEqual(socks);
    expect(toElectronProxy(socks)?.proxyRules).toBe('socks5://[::1]:7890');
  });

  it('rejects rule injection, embedded credentials and invalid ports', () => {
    for (const host of ['', 'http://localhost', 'user:password@localhost', 'host;direct://', 'host/path', 'host:8080']) {
      expect(proxySettingsSchema.safeParse({ ...manual, host }).success).toBe(false);
    }
    for (const port of [0, -1, 65536, 1.5]) {
      expect(proxySettingsSchema.safeParse({ ...manual, port }).success).toBe(false);
    }
    expect(proxySettingsSchema.safeParse({ ...manual, bypass: 'a\nb' }).success).toBe(false);
  });

  it('allows only HTTP(S) PAC and test URLs without credentials', () => {
    for (const pacUrl of ['file:///a.pac', 'data:text/plain,x', 'http://user:pass@host/a.pac', 'invalid']) {
      expect(proxySettingsSchema.safeParse({ ...DEFAULT_PROXY, mode: 'pac', pacUrl }).success).toBe(false);
    }
    expect(toElectronProxy({ ...DEFAULT_PROXY, mode: 'pac', pacUrl: 'https://example.com/a.pac' })).toEqual({ pacScript: 'https://example.com/a.pac' });
    expect(proxyTestSchema.safeParse({ proxy: DEFAULT_PROXY, url: 'file:///x' }).success).toBe(false);
  });

  it('requests a restart only when proxy settings change', () => {
    const config = { flashVersion: '34.0.0.330', flashPluginChannel: 'stable' as const, lowEndMode: false, proxy: DEFAULT_PROXY };
    expect(requiresMainConfigRestart(config, { ...config, proxy: { ...DEFAULT_PROXY } })).toBe(false);
    expect(requiresMainConfigRestart(config, { ...config, proxy: manual })).toBe(true);
  });
});

describe('proxy sessions', () => {
  it('applies to both browser sessions before use', async () => {
    await initializeProxy(manual);
    expect(mocks.defaultSession.setProxy).toHaveBeenCalledWith(toElectronProxy(manual));
    expect(mocks.tabSession.setProxy).toHaveBeenCalledWith(toElectronProxy(manual));
    expect(usesBrowserDownloads()).toBe(true);
  });

  it('does not override the system configuration', async () => {
    await initializeProxy(DEFAULT_PROXY);
    expect(mocks.defaultSession.setProxy).not.toHaveBeenCalled();
    expect(mocks.tabSession.setProxy).not.toHaveBeenCalled();
    expect(usesBrowserDownloads()).toBe(false);
  });

  it('tests unsaved settings in isolation and stops downloading at response headers', async () => {
    const request = Object.assign(new EventEmitter(), {
      abort: vi.fn(),
      end: () => queueMicrotask(() => request.emit('response', { statusCode: 204 })),
    });
    mocks.request.mockReturnValue(request);
    expect(await testProxy(manual, 'https://example.com/')).toEqual({ ok: true, route: 'PROXY 127.0.0.1:7890', statusCode: 204 });
    expect(mocks.request).toHaveBeenCalledWith({ url: 'https://example.com/', session: mocks.testSession, redirect: 'manual' });
    expect(mocks.defaultSession.setProxy).not.toHaveBeenCalled();
    expect(mocks.tabSession.setProxy).not.toHaveBeenCalled();
    expect(request.abort).toHaveBeenCalled();
  });

  it('times out and cancels requests which never respond', async () => {
    vi.useFakeTimers();
    try {
      const request = Object.assign(new EventEmitter(), { abort: vi.fn(), end: vi.fn() });
      mocks.request.mockReturnValue(request);
      const result = testProxy(manual, 'https://example.com/');
      await vi.advanceTimersByTimeAsync(15000);
      expect(await result).toMatchObject({ ok: false, error: 'TIMEOUT' });
      expect(request.abort).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('bounds retained Electron 11 sessions when testing repeatedly', async () => {
    mocks.request.mockImplementation(() => {
      const request = Object.assign(new EventEmitter(), {
        abort: vi.fn(), end: () => queueMicrotask(() => request.emit('response', { statusCode: 200 })),
      });
      return request;
    });
    let result;
    for (let i = 0; i < 33; i++) result = await testProxy(manual, 'http://example.com/');
    expect(result).toMatchObject({ ok: false, error: 'TEST_LIMIT' });
    expect(mocks.fromPartition.mock.calls.length).toBeLessThanOrEqual(32);
  });
});
