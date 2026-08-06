import type { DownloadItem } from '@shared/types/downloads';

export interface StoredDownload extends DownloadItem {
  updatedAt: number;
}

export function normalizeRestartedDownload(item: StoredDownload, now = Date.now()): StoredDownload {
  if (item.state !== 'progressing' && item.state !== 'paused') return item;
  return { ...item, state: 'interrupted', speed: 0, updatedAt: now };
}

export function mergeDownloadPatch(
  previous: StoredDownload | undefined,
  patch: Partial<DownloadItem> & Pick<DownloadItem, 'id' | 'state'>,
  now = Date.now(),
): StoredDownload | null {
  if (!previous && (!patch.url || !patch.filename)) return null;
  return {
    id: patch.id,
    url: patch.url ?? previous?.url ?? '',
    filename: patch.filename ?? previous?.filename ?? 'download',
    state: patch.state,
    progress: patch.progress ?? previous?.progress ?? 0,
    speed: patch.speed ?? previous?.speed ?? 0,
    receivedBytes: patch.receivedBytes ?? previous?.receivedBytes ?? 0,
    totalBytes: patch.totalBytes ?? previous?.totalBytes ?? 0,
    savePath: patch.savePath ?? previous?.savePath ?? '',
    engine: patch.engine ?? previous?.engine,
    updatedAt: now,
  };
}

export function selectRetainedDownloadRecords(items: StoredDownload[], maxTerminal = 1000): StoredDownload[] {
  const active = items.filter((item) => item.state === 'progressing' || item.state === 'paused');
  const terminal = items
    .filter((item) => item.state !== 'progressing' && item.state !== 'paused')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxTerminal);
  return [...active, ...terminal];
}
