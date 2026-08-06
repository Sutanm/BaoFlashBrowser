import { describe, expect, it } from 'vitest';
import { applyHistoryVisit, MAX_HISTORY_ENTRIES } from '../src/renderer/services/history-state';
import type { HistoryEntry } from '../src/shared/types/history';

function entry(index: number, url = `https://example.com/${index}`): HistoryEntry {
  return { id: `h_${index}`, url, title: `Page ${index}`, favicon: '', visitCount: 1, lastVisit: index };
}

describe('bounded history state', () => {
  it('keeps the latest 5000 entries and reports only the evicted record', () => {
    const previous = Array.from({ length: MAX_HISTORY_ENTRIES }, (_, index) => entry(index));
    const result = applyHistoryVisit(previous, entry(MAX_HISTORY_ENTRIES));
    expect(result.history).toHaveLength(MAX_HISTORY_ENTRIES);
    expect(result.history[0].id).toBe(`h_${MAX_HISTORY_ENTRIES}`);
    expect(result.removedIds).toEqual(['h_0']);
  });

  it('updates one existing URL without creating another record', () => {
    const previous = [entry(1, 'https://example.com/login')];
    const result = applyHistoryVisit(previous, { ...entry(2), url: previous[0].url, title: 'Updated' });
    expect(result.history).toHaveLength(1);
    expect(result.record).toMatchObject({ id: 'h_1', visitCount: 2, title: 'Updated', lastVisit: 2 });
  });
});
