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

  it('deletes only favorites removed locally, keyed by the table primary key (url)', () => {
    const previous = [
      { id: 'a', title: 'A', url: 'https://a.example', addedAt: 1 },
      { id: 'b', title: 'B', url: 'https://b.example', addedAt: 2 },
    ];
    const next = [
      previous[1],
      { id: 'c', title: 'C', url: 'https://c.example', addedAt: 3 },
    ];

    // db.favorites 的主键是 url（services/db.ts: `favorites: 'url'`），
    // bulkDelete 只认主键 —— 这里回归的是"按 id 删 = 静默空操作、取消收藏无效"。
    expect(planFavoriteWrites(previous, next)).toEqual({
      removedKeys: ['https://a.example'],
      put: [{ id: 'c', title: 'C', url: 'https://c.example', addedAt: 3, _idx: 1 }],
      update: [{ url: 'https://b.example', changes: { _idx: 0 } }],
    });
  });

  it('never deletes entries that another window added', () => {
    const previous = [{ id: 'a', title: 'A', url: 'https://a.example', addedAt: 1 }];
    const next = [...previous, { id: 'b', title: 'B', url: 'https://b.example', addedAt: 2 }];

    expect(planFavoriteWrites(previous, next).removedKeys).toEqual([]);
    expect(planFavoriteWrites(previous, next).put.map(({ url }) => url)).toEqual(['https://b.example']);
  });

  it('backfills the id of legacy rows that were migrated without one', () => {
    const legacy = { id: '', title: 'Legacy', url: 'https://legacy.example', addedAt: 0 };
    const { put, update } = planFavoriteWrites([legacy], [legacy]);

    expect(put).toEqual([]);
    expect(update).toEqual([{ url: 'https://legacy.example', changes: { id: 'https://legacy.example' } }]);
  });
});
