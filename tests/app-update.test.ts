import { describe, expect, it, vi, afterEach } from 'vitest';
import https from 'https';
import { EventEmitter } from 'events';
import { checkAppUpdate, isNewerVersion } from '../src/main/modules/app-update';

afterEach(() => { vi.restoreAllMocks(); });

describe('app update', () => {
  it('compares stable versions numerically and ignores invalid tags', () => {
    expect(isNewerVersion('v1.10.0', '1.9.9')).toBe(true);
    expect(isNewerVersion('2.0.0', '1.99.99')).toBe(true);
    expect(isNewerVersion('1.1.2', '1.1.2')).toBe(false);
    expect(isNewerVersion('1.1.1', '1.1.2')).toBe(false);
    expect(isNewerVersion('1.2.0-beta', '1.1.2')).toBe(false);
    expect(isNewerVersion('bad', '1.1.2')).toBe(false);
  });

  it.each([
    [200, { tag_name: 'v1.2.0' }, 'available'],
    [200, { tag_name: 'v1.1.2' }, 'current'],
    [200, { tag_name: 'v1.0.0' }, 'current'],
    [200, { tag_name: 'v1.2.0', prerelease: true }, 'error'],
    [200, { tag_name: 'bad' }, 'error'],
    [403, {}, 'error'],
    [404, {}, 'error'],
  ])('handles HTTP %s release %j', async (statusCode, body, status) => {
    vi.spyOn(https, 'get').mockImplementation(((_url: unknown, _options: unknown, callback: (r: unknown) => void) => {
      const request = new EventEmitter();
      queueMicrotask(() => {
        const response = Object.assign(new EventEmitter(), { statusCode, setEncoding: vi.fn(), resume: vi.fn() });
        callback(response);
        response.emit('data', JSON.stringify(body));
        response.emit('end');
        request.emit('close');
      });
      return request;
    }) as typeof https.get);
    const result = await checkAppUpdate('1.1.2');
    expect(result.status).toBe(status);
    if (status === 'available') expect(result.releaseUrl).toBe('https://github.com/Sutanm/BaoFlashBrowser/releases/tag/v1.2.0');
  });
});
