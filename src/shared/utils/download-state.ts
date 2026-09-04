import type { DownloadItem } from '../types/downloads';

/**
 * Reconcile the initial main-process snapshot with progress events that may have
 * arrived while the async list request was in flight. Records absent from the
 * snapshot are retained because they can represent downloads started after the
 * snapshot was captured.
 */
export function reconcileDownloadSnapshot(
  current: DownloadItem[],
  snapshot: DownloadItem[],
): DownloadItem[] {
  const byId = new Map(snapshot.map((item) => [item.id, item]));

  for (const item of current) {
    const incoming = byId.get(item.id);
    if (!incoming || (item.updatedAt ?? 0) > (incoming.updatedAt ?? 0)) {
      byId.set(item.id, item);
    }
  }

  return [...byId.values()].sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
}
