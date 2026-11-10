import { create } from 'zustand';
import type { Tab } from '@shared/types/tab';

export interface TabState extends Tab {
  webviewId?: string;
}

export interface TabsState {
  tabs: TabState[];
  activeTabId: string | null;

  setTabs: (t: TabState[] | ((prev: TabState[]) => TabState[])) => void;
  setActiveTabId: (id: string | null) => void;
  /**
   * 一次性替换标签列表与活动标签。
   *
   * 拆成两次 `set` 会留下"列表已换、活动 id 还是旧的"的中间态：`App` 里
   * `!activeTab` 会成立 → 外壳盖上新标签页并把 BrowserView 挪到 (-9999,1×1)，
   * 视觉上就是一次闪白。跨窗迁移这种整表替换必须原子完成。
   */
  replaceTabs: (tabs: TabState[], activeTabId: string | null) => void;
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,

  setTabs: (t) =>
    set((state) => ({ tabs: typeof t === 'function' ? t(state.tabs) : t })),
  setActiveTabId: (id) => set({ activeTabId: id }),
  replaceTabs: (tabs, activeTabId) => set({ tabs, activeTabId }),
}));
