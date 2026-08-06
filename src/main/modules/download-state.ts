import Store from 'electron-store';
import type { DownloadItem, DownloadState } from '@shared/types/downloads';
import { mergeDownloadPatch, normalizeRestartedDownload, selectRetainedDownloadRecords, type StoredDownload } from '../utils/download-record';

interface DownloadStateSchema {
  records: StoredDownload[];
}

const store = new Store<DownloadStateSchema>({
  name: 'download-state',
  defaults: { records: [] },
  schema: { records: { type: 'array' } } as any,
});

const records = new Map<string, StoredDownload>();
const MAX_TERMINAL_RECORDS = 1000;
let loaded = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function isTerminal(state: DownloadState): boolean {
  return state === 'completed' || state === 'cancelled' || state === 'interrupted';
}

function trimTerminalRecords(): void {
  const retained = new Set(selectRetainedDownloadRecords([...records.values()], MAX_TERMINAL_RECORDS).map((item) => item.id));
  for (const id of records.keys()) if (!retained.has(id)) records.delete(id);
}

function persistNow(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  trimTerminalRecords();
  const active = [...records.values()].filter((item) => !isTerminal(item.state));
  const terminal = [...records.values()].filter((item) => isTerminal(item.state)).sort((a, b) => b.updatedAt - a.updatedAt);
  const value = [...active, ...terminal];
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
  trimTerminalRecords();
  if (changed) persistNow();
}

export function updateDownloadRecord(patch: Partial<DownloadItem> & Pick<DownloadItem, 'id' | 'state'>): StoredDownload | null {
  ensureLoaded();
  const previous = records.get(patch.id);
  if (!previous && (!patch.url || !patch.filename)) return null;
  const next = mergeDownloadPatch(previous, patch);
  if (!next) return null;
  records.set(next.id, next);
  trimTerminalRecords();
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
  for (const item of items) {
    if (!item.id || records.has(item.id)) continue;
    const adopted = mergeDownloadPatch(undefined, {
      ...item,
      state: item.state === 'progressing' || item.state === 'paused' ? 'interrupted' : item.state,
      speed: 0,
    }, timestamp++);
    if (adopted) records.set(adopted.id, adopted);
  }
  trimTerminalRecords();
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
