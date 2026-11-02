import { describe, expect, it, vi } from 'vitest';
import { aria2ProxyOptions, resolveDownloadProxy } from '../src/main/modules/download-proxy';
import { DEFAULT_PROXY } from '../src/shared/types/proxy';
import type { Session } from 'electron';

describe('aria2 browser route mapping', () => {
  it('overrides every inherited proxy for direct connections', () => {
    expect(aria2ProxyOptions('DIRECT')).toMatchObject({ 'all-proxy': '', 'http-proxy': '', 'https-proxy': '', 'no-proxy': '' });
  });
  it('maps HTTP proxies and never skips an unsupported first route', () => {
    expect(aria2ProxyOptions('PROXY 127.0.0.1:7890; DIRECT')?.['https-proxy']).toBe('http://127.0.0.1:7890');
    expect(aria2ProxyOptions('PROXY [::1]:8080')?.['http-proxy']).toBe('http://[::1]:8080');
    for (const route of ['SOCKS5 localhost:1080; DIRECT', 'HTTPS proxy:443', '', 'PROXY bad:0', 'PROXY user:pass@host:80']) {
      expect(aria2ProxyOptions(route)).toBeNull();
    }
  });
  it('synchronizes system and PAC results, including bypass and unsupported routes', async () => {
    const resolveProxy = vi.fn().mockResolvedValue('PROXY localhost:7890');
    const sess = { resolveProxy } as unknown as Session;
    for (const mode of ['system', 'pac'] as const) {
      expect((await resolveDownloadProxy(sess, 'https://example.com', { ...DEFAULT_PROXY, mode }))?.['all-proxy']).toBe('http://localhost:7890');
    }
    resolveProxy.mockResolvedValue('DIRECT');
    expect((await resolveDownloadProxy(sess, 'https://example.com', { ...DEFAULT_PROXY, mode: 'manual', bypass: '*.example.com' }))?.['all-proxy']).toBe('');
    resolveProxy.mockResolvedValue('SOCKS5 localhost:1080; DIRECT');
    expect(await resolveDownloadProxy(sess, 'https://example.com')).toBeNull();
  });
  it('resolves against the requesting session and fails back to Chromium on errors', async () => {
    const resolveProxy = vi.fn().mockResolvedValue('PROXY localhost:8080');
    const sess = { resolveProxy } as unknown as Session;
    expect((await resolveDownloadProxy(sess, 'https://example.com/file', { ...DEFAULT_PROXY, mode: 'manual', host: 'localhost', port: 8080 }))?.['all-proxy']).toBe('http://localhost:8080');
    expect(resolveProxy).toHaveBeenCalledWith('https://example.com/file');
    resolveProxy.mockRejectedValue(new Error('unavailable'));
    expect(await resolveDownloadProxy(sess, 'https://example.com/file')).toBeNull();
  });
});
