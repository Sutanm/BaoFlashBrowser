import type { HistoryEntry } from '@shared/types/history';

export const MAX_HISTORY_ENTRIES = 5000;

export function applyHistoryVisit(previous: HistoryEntry[], entry: HistoryEntry): {
  history: HistoryEntry[];
  record: HistoryEntry;
  removedIds: string[];
} {
  const existing = previous.find((item) => item.url === entry.url);
  const record = existing
    ? { ...existing, lastVisit: entry.lastVisit, visitCount: existing.visitCount + 1, title: entry.title || existing.title, favicon: entry.favicon || existing.favicon }
    : entry;
  const history = [record, ...previous.filter((item) => item.id !== record.id)]
    .sort((a, b) => b.lastVisit - a.lastVisit)
    .slice(0, MAX_HISTORY_ENTRIES);
  const keptIds = new Set(history.map((item) => item.id));
  return { history, record, removedIds: previous.filter((item) => !keptIds.has(item.id)).map((item) => item.id) };
}

