import type { Settings } from '@shared/types/settings';
import type { TabSnapshotEntry } from '@shared/types/ipc';
import type { TabState } from '../store/useTabsStore';
import { createInitialTabState, type InternalTabTitles } from './tab-initial-state';

/**
 * 用主进程的权威快照重建标签列表（P7 跨窗迁移 / tear-off）。
 *
 * 两条不能破的规矩：
 * 1. 已知标签保留渲染层维护的字段。缩放、静音、引擎和挂起状态由主进程提供，
 *    这样迁入新窗口时也能恢复原有设置。
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
    const runtime = {
      ...(item.zoomFactor !== undefined ? { zoomFactor: item.zoomFactor } : {}),
      ...(item.isMuted !== undefined ? { isMuted: item.isMuted } : {}),
      ...(item.ruffleMode !== undefined ? { ruffleMode: item.ruffleMode, ruffleSource: item.ruffleSource } : {}),
      ...(item.suspended !== undefined ? { suspended: item.suspended } : {}),
      ...(item.crashed !== undefined ? { crashed: item.crashed } : {}),
    };
    if (existing) {
      return {
        ...existing,
        ...runtime,
        url: item.url || existing.url,
        title: item.title || existing.title,
        ...(item.favicon ? { favicon: item.favicon } : {}),
      };
    }
    const created = createInitialTabState(item.tabId, item.url || 'about:newtab', settings, titles);
    if (item.title) created.title = item.title;
    if (item.favicon) created.favicon = item.favicon;
    return { ...created, ...runtime };
  });
}

/** 快照里的活动标签；没有显式标记时退回第一个。 */
export function pickActiveTabId(snapshot: TabSnapshotEntry[]): string | null {
  if (!snapshot.length) return null;
  return snapshot.find((item) => item.active)?.tabId ?? snapshot[0].tabId;
}
