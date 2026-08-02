import Store from 'electron-store';
import type { DownloadItem, DownloadState } from '@shared/types/downloads';
import { mergeDownloadPatch, normalizeRestartedDownload, type StoredDownload } from '../utils/download-record';

interface DownloadStateSchema {
  records: StoredDownload[];
}

const store = new Store<DownloadStateSchema>({
  name: 'download-state',
  defaults: { records: [] },
  schema: { records: { type: 'array' } } as any,
});

const records = new Map<string, StoredDownload>();
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function isTerminal(state: DownloadState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'interrupted';
}

function persistNow(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const value = [...records.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 1000);
  store.set('records', value);
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  let changed = false;
  for (const item of store.get('records') || []) {
    if (!item || typeof item.id !== 'string' || !item.id || typeof item.url !== 'string') continue;
    const normalized = normalizeRestartedDownload(item);
    if (normalized !== item) changed = true;
    records.set(normalized.id, normalized);
  }
  if (changed) persistNow();
}

export function updateDownloadRecord(patch: Partial<DownloadItem> & Pick<DownloadItem, 'id' | 'state'>): StoredDownload | null {
  ensureLoaded();
  const previous = records.get(patch.id);
  if (!previous && (!patch.url || !patch.filename)) return null;
  const next = mergeDownloadPatch(previous, patch);
  if (!next) return null;
  records.set(next.id, next);
  if (isTerminal(next.state)) persistNow();
  else {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistNow, 1000);
  }
  return next;
}

export function getDownloadRecord(id: string): StoredDownload | null {
  ensureLoaded();
  return records.get(id) || null;
}

export function getDownloadRecords(): StoredDownload[] {
  ensureLoaded();
  return [...records.values()].sort((a, b) => a.updatedAt - b.updatedAt);
}

export function adoptDownloadRecords(items: DownloadItem[]): StoredDownload[] {
  ensureLoaded();
  let timestamp = Date.now();
  for (const item of items.slice(0, 1000)) {
    if (!item.id || records.has(item.id)) continue;
    const adopted = mergeDownloadPatch(undefined, {
      ...item,
      state: item.state === 'progressing' || item.state === 'paused' ? 'interrupted' : item.state,
      speed: 0,
    }, timestamp++);
    if (adopted) records.set(adopted.id, adopted);
  }
  persistNow();
  return getDownloadRecords();
}

export function removeDownloadRecord(id: string): void {
  ensureLoaded();
  records.delete(id);
  persistNow();
}

export function clearFinishedDownloadRecords(): void {
  ensureLoaded();
  for (const [id, item] of records) {
    if (item.state !== 'progressing' && item.state !== 'paused') records.delete(id);
  }
  persistNow();
}

export function flushDownloadState(): void {
  ensureLoaded();
  persistNow();
}
