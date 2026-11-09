// 多窗口 P5：并发写库只应用本窗口改动的那部分。
import { describe, expect, it } from 'vitest';
import { changedSettings, mergeSettings, planFavoriteWrites } from '../src/renderer/services/persistence-merge';
import { defaultSettings } from '../src/renderer/store/useDataStore';

describe('persistence merge (P5)', () => {
  it('reports only changed settings keys', () => {
    const previous = { ...defaultSettings, homepage: 'https://a.example', searchEngine: 'bing' as const };
    const next = { ...previous, homepage: 'https://b.example' };

    expect(changedSettings(previous, next)).toEqual({ homepage: 'https://b.example' });
    expect(changedSettings(previous, { ...previous })).toEqual({});
  });

  it('merges changed keys over the latest database value', () => {
    const current = { ...defaultSettings, homepage: 'https://db.example', searchEngine: 'google' as const };
    const merged = mergeSettings(current, { homepage: 'https://local.example' });

    expect(merged.homepage).toBe('https://local.example');
    // 另一个窗口改过的 searchEngine 不能被本窗口的旧副本覆盖。
    expect(merged.searchEngine).toBe('google');
  });

  it('deletes only favorite ids removed locally and reindexes the rest', () => {
    const previous = [
      { id: 'a', title: 'A', url: 'https://a.example' },
      { id: 'b', title: 'B', url: 'https://b.example' },
    ];
    const next = [
      { id: 'b', title: 'B', url: 'https://b.example' },
      { id: 'c', title: 'C', url: 'https://c.example' },
    ];

    expect(planFavoriteWrites(previous, next)).toEqual({
      removedIds: ['a'],
      put: [
        { id: 'b', title: 'B', url: 'https://b.example', _idx: 0 },
        { id: 'c', title: 'C', url: 'https://c.example', _idx: 1 },
      ],
    });
  });

  it('never deletes ids that another window added', () => {
    const previous = [{ id: 'a', title: 'A', url: 'https://a.example' }];
    const next = [{ id: 'a', title: 'A', url: 'https://a.example' }];

    expect(planFavoriteWrites(previous, next).removedIds).toEqual([]);
  });
});
