import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { Settings } from '@shared/types/settings';

/**
 * 多窗口并发写的合并策略（SDD: docs/specs/multi-window-plan.md §6.5）。
 *
 * 渲染层每个窗口各有一份 store 副本；写库时不能把"本地全量对象"直接覆盖
 * 数据库，否则另一个窗口刚改的其它字段会被覆盖。这里只计算**本窗口真正改动的
 * 部分**，再与库内最新值合并。
 */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function changedSettings(previous: Settings, next: Settings): Partial<Settings> {
  const changed: Partial<Settings> = {};
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]) as Set<keyof Settings>;
  for (const key of keys) {
    if (!sameValue(previous[key], next[key])) {
      (changed as Record<string, unknown>)[key as string] = next[key];
    }
  }
  return changed;
}

export function mergeSettings(current: Settings, changed: Partial<Settings>): Settings {
  return { ...current, ...changed };
}

/**
 * 收藏是"全量列表"API：只删除本窗口确实删掉的条目，别的窗口新增的条目保留。
 *
 * **删除必须按主键 `url` 算**：`db.favorites` 的 schema 是 `'url'`（见
 * `services/db.ts`），而 `Table.bulkDelete(keys)` 只认主键。早先这里返回的是
 * 收藏的 `id`，`bulkDelete(['<id>'])` 删不到任何行、随后的 `bulkPut` 又把列表原样
 * 写回，liveQuery 一回灌就"取消收藏没反应"（2026-11-10 真机复现）。
 *
 * 同时给缺少 `id` 的历史行（localStorage 迁移来的、P5b 之前新增的）补一个：
 * 类型上 `BookmarkEntry.id` 必填，缺 id 的行走过 store 后再写回时应当被规范化。
 */
export function planFavoriteWrites(previous: BookmarkEntry[], next: BookmarkEntry[]): {
  removedKeys: string[];
  put: Array<BookmarkEntry & { _idx: number }>;
} {
  const previousKeys = new Set(previous.map((item) => item.url));
  const nextKeys = new Set(next.map((item) => item.url));
  return {
    removedKeys: [...previousKeys].filter((key) => !nextKeys.has(key)),
    put: next.map((item, index) => ({ ...item, id: item.id || item.url, _idx: index })),
  };
}
