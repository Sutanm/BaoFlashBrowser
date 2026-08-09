// @require/@resource fetch cache. Pure TS with injected network and disk
// adapters so it is unit-testable and portable to the real main process.
// Mirrors the planned src/main/modules/userscripts/userscript-require-cache.ts
// (upstream naming: userscript-require-cache).

export interface RequireCacheOptions {
  fetcher: (url: string) => Promise<string>;
  loadFromDisk?: (url: string) => string | undefined;
  saveToDisk?: (url: string, source: string) => void;
  maxTotalBytes?: number;
}

export type RequireEnsureResult =
  | { ok: true; source: string; cached: boolean }
  | { ok: false; error: string };

const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024;

interface CacheEntry {
  source: string;
  cached: boolean;
}

export class RequireCache {
  private readonly options: Required<Pick<RequireCacheOptions, 'fetcher' | 'maxTotalBytes'>> &
    Pick<RequireCacheOptions, 'loadFromDisk' | 'saveToDisk'>;
  private readonly entries = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<RequireEnsureResult>>();

  constructor(options: RequireCacheOptions) {
    this.options = {
      fetcher: options.fetcher,
      loadFromDisk: options.loadFromDisk,
      saveToDisk: options.saveToDisk,
      maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    };
  }

  has(url: string): boolean {
    return this.entries.has(url);
  }

  get(url: string): string | undefined {
    return this.entries.get(url)?.source;
  }

  entriesList(): Array<{ url: string; source: string }> {
    return Array.from(this.entries, ([url, entry]) => ({ url, source: entry.source }));
  }

  private totalBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += Buffer.byteLength(entry.source, 'utf8');
    return total;
  }

  ensure(url: string): Promise<RequireEnsureResult> {
    const existing = this.pending.get(url);
    if (existing) return existing;
    const promise = this.doEnsure(url);
    this.pending.set(url, promise);
    void promise.finally(() => this.pending.delete(url));
    return promise;
  }

  private async doEnsure(url: string): Promise<RequireEnsureResult> {
    const hit = this.entries.get(url);
    if (hit) return { ok: true, source: hit.source, cached: hit.cached };

    const diskSource = this.options.loadFromDisk?.(url);
    if (diskSource !== undefined) {
      if (!this.store(url, diskSource, true)) return { ok: false, error: 'size-limit' };
      return { ok: true, source: diskSource, cached: true };
    }

    let source: string;
    try {
      source = await this.options.fetcher(url);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (Buffer.byteLength(source, 'utf8') > this.options.maxTotalBytes) {
      return { ok: false, error: 'size-limit' };
    }
    if (!this.store(url, source, false)) return { ok: false, error: 'size-limit' };
    this.options.saveToDisk?.(url, source);
    return { ok: true, source, cached: false };
  }

  private store(url: string, source: string, cached: boolean): boolean {
    const incoming = Buffer.byteLength(source, 'utf8');
    if (incoming > this.options.maxTotalBytes) return false;
    this.entries.delete(url);
    let current = this.totalBytes();
    while (current + incoming > this.options.maxTotalBytes) {
      // Drop the largest existing entry until the aggregate fits.
      let largest: string | null = null;
      let largestBytes = -1;
      for (const [entryUrl, entry] of this.entries) {
        const bytes = Buffer.byteLength(entry.source, 'utf8');
        if (bytes > largestBytes) {
          largestBytes = bytes;
          largest = entryUrl;
        }
      }
      if (!largest) return false;
      this.entries.delete(largest);
      current -= largestBytes;
    }
    this.entries.set(url, { source, cached });
    return true;
  }
}
