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

/** 收藏是"全量列表"API：只删除本窗口确实删掉的 id，别的窗口新增的条目保留。 */
export function planFavoriteWrites(previous: BookmarkEntry[], next: BookmarkEntry[]): {
  removedIds: string[];
  put: Array<BookmarkEntry & { _idx: number }>;
} {
  const previousIds = new Set(previous.map((item) => item.id));
  const nextIds = new Set(next.map((item) => item.id));
  return {
    removedIds: [...previousIds].filter((id) => !nextIds.has(id)),
    put: next.map((item, index) => ({ ...item, _idx: index })),
  };
}
