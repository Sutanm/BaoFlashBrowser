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
      { id: 'a', title: 'A', url: 'https://a.example' },
      { id: 'b', title: 'B', url: 'https://b.example' },
    ];
    const next = [
      { id: 'b', title: 'B', url: 'https://b.example' },
      { id: 'c', title: 'C', url: 'https://c.example' },
    ];

    // db.favorites 的主键是 url（services/db.ts: `favorites: 'url'`），
    // bulkDelete 只认主键 —— 这里回归的是"按 id 删 = 静默空操作、取消收藏无效"。
    expect(planFavoriteWrites(previous, next)).toEqual({
      removedKeys: ['https://a.example'],
      put: [
        { id: 'b', title: 'B', url: 'https://b.example', _idx: 0 },
        { id: 'c', title: 'C', url: 'https://c.example', _idx: 1 },
      ],
    });
  });

  it('never deletes entries that another window added', () => {
    const previous = [{ id: 'a', title: 'A', url: 'https://a.example' }];
    const next = [{ id: 'a', title: 'A', url: 'https://a.example' }];

    expect(planFavoriteWrites(previous, next).removedKeys).toEqual([]);
  });

  it('backfills the id of legacy rows that were migrated without one', () => {
    const legacy = { title: 'Legacy', url: 'https://legacy.example' } as unknown as { id: string; title: string; url: string };
    const { put } = planFavoriteWrites([legacy], [legacy]);

    expect(put[0].id).toBe('https://legacy.example');
    expect(put[0]._idx).toBe(0);
  });
});
