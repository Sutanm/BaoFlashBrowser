import type { Settings } from '@shared/types/settings';
import type { TabSnapshotEntry } from '@shared/types/ipc';
import type { TabState } from '../store/useTabsStore';
import { createInitialTabState, type InternalTabTitles } from './tab-initial-state';

/**
 * 用主进程的权威快照重建标签列表（P7 跨窗迁移 / tear-off）。
 *
 * 两条不能破的规矩：
 * 1. **认得的标签只覆盖主进程说了算的字段**（url / title / favicon）。整条重建会
 *    冲掉渲染层自己维护的运行态——favicon 只在页面加载时随 `tab:updated` 发一次，
 *    重建一次就永久丢失，表现为"拖一次标签，两个窗口的图标全没了"；zoomFactor、
 *    createdAt 同理。
 * 2. **url 为空时不许猜成 about:newtab**。猜出来的 about:newtab 会被会话持久化
 *    写盘，于是刷新也回不到真实页面，等于把一次事件丢失固化成永久错误。
 */
export function mergeTabSnapshot(
  prev: TabState[],
  snapshot: TabSnapshotEntry[],
  settings: Pick<Settings, 'flashEngineMode' | 'flashEngineRules'>,
  titles: InternalTabTitles,
): TabState[] {
  const known = new Map(prev.map((item) => [item.id, item]));
  return snapshot.map((item) => {
    const existing = known.get(item.tabId);
    if (existing) {
      return {
        ...existing,
        url: item.url || existing.url,
        title: item.title || existing.title,
        ...(item.favicon ? { favicon: item.favicon } : {}),
      };
    }
    const created = createInitialTabState(item.tabId, item.url || 'about:newtab', settings, titles);
    if (item.title) created.title = item.title;
    if (item.favicon) created.favicon = item.favicon;
    return created;
  });
}

/** 快照里的活动标签；没有显式标记时退回第一个。 */
export function pickActiveTabId(snapshot: TabSnapshotEntry[]): string | null {
  if (!snapshot.length) return null;
  return snapshot.find((item) => item.active)?.tabId ?? snapshot[0].tabId;
}
