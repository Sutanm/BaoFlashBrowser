import { describe, expect, it } from 'vitest';
import { RequireCache } from '@main/modules/userscripts/userscript-require-cache';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('userscript RequireCache', () => {
  it('fetches and caches a URL exactly once', async () => {
    let fetches = 0;
    const cache = new RequireCache({ fetcher: async () => { fetches += 1; return 'source-1'; } });
    expect(await cache.ensure('http://x/lib.js')).toEqual({ ok: true, source: 'source-1', cached: false });
    expect(await cache.ensure('http://x/lib.js')).toEqual({ ok: true, source: 'source-1', cached: false });
    expect(fetches).toBe(1);
  });

  it('dedupes concurrent fetches of the same URL', async () => {
    let fetches = 0;
    const cache = new RequireCache({
      fetcher: async () => { fetches += 1; await delay(10); return 's'; },
    });
    const [a, b] = await Promise.all([cache.ensure('http://x/lib.js'), cache.ensure('http://x/lib.js')]);
    expect(a.ok && b.ok).toBe(true);
    expect(fetches).toBe(1);
  });

  it('falls back to the disk cache when the network fails', async () => {
    const disk = new Map([['http://x/lib.js', 'disk-source']]);
    const cache = new RequireCache({
      fetcher: async () => { throw new Error('offline'); },
      loadFromDisk: (url) => disk.get(url),
    });
    expect(await cache.ensure('http://x/lib.js')).toEqual({ ok: true, source: 'disk-source', cached: true });
  });

  it('reports failure when neither network nor disk has the source', async () => {
    const cache = new RequireCache({ fetcher: async () => { throw new Error('offline'); } });
    const result = await cache.ensure('http://x/lib.js');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeDefined();
  });

  it('persists fetched sources to disk', async () => {
    const saved: Array<[string, string]> = [];
    const cache = new RequireCache({
      fetcher: async () => 'fresh',
      saveToDisk: (url, source) => { saved.push([url, source]); },
    });
    await cache.ensure('http://x/lib.js');
    expect(saved).toEqual([['http://x/lib.js', 'fresh']]);
  });

  it('rejects sources above the total byte budget', async () => {
    const cache = new RequireCache({
      fetcher: async () => 'x'.repeat(1024),
      maxTotalBytes: 512,
    });
    expect(await cache.ensure('http://x/lib.js')).toEqual({ ok: false, error: 'size-limit' });
  });

  it('evicts enough entries to keep the aggregate within budget', async () => {
    const sources: Record<string, string> = { a: 'a'.repeat(40), b: 'b'.repeat(40), c: 'c'.repeat(70) };
    const cache = new RequireCache({ fetcher: async (url) => sources[url], maxTotalBytes: 100 });
    await cache.ensure('a');
    await cache.ensure('b');
    await cache.ensure('c');

    const total = cache.entriesList().reduce((sum, entry) => sum + Buffer.byteLength(entry.source), 0);
    expect(total).toBeLessThanOrEqual(100);
    expect(cache.get('c')).toBe(sources.c);
  });

  it('rejects an oversized source loaded from disk', async () => {
    const cache = new RequireCache({
      fetcher: async () => 'unused',
      loadFromDisk: () => '中'.repeat(40),
      maxTotalBytes: 100,
    });
    expect(await cache.ensure('disk')).toEqual({ ok: false, error: 'size-limit' });
  });

  it('exposes cached entries for snapshot expansion', async () => {
    const cache = new RequireCache({ fetcher: async () => 'lib-source' });
    await cache.ensure('http://x/lib.js');
    expect(cache.get('http://x/lib.js')).toBe('lib-source');
    expect(cache.has('http://x/lib.js')).toBe(true);
    expect(cache.get('http://x/other.js')).toBeUndefined();
  });
});

