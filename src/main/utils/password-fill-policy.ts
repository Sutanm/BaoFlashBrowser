export interface FillEntryMeta {
  id: string;
  host: string;
  origin: string;
  username: string;
  updatedAt: number;
}

function normalizedHost(host: string): string {
  return host.trim().replace(/^www\./i, '').toLowerCase();
}

export function selectFillEntry<T extends FillEntryMeta>(
  entries: T[],
  pageUrl: string,
  requestedId?: string,
): T | null {
  let page: URL;
  try { page = new URL(pageUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(page.protocol)) return null;

  const pageHost = normalizedHost(page.hostname);
  const matches = entries.filter((entry) => {
    if (requestedId && entry.id !== requestedId) return false;
    if (normalizedHost(entry.host) !== pageHost) return false;
    try {
      const saved = new URL(entry.origin);
      if (normalizedHost(saved.hostname) !== pageHost) return false;
      if (saved.protocol === 'https:' && page.protocol !== 'https:') return false;
    } catch {
      // Older entries may only have a host. Exact host matching still applies.
    }
    return true;
  });

  matches.sort((a, b) => b.updatedAt - a.updatedAt);
  return matches[0] || null;
}
