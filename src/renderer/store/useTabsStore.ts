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
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,

  setTabs: (t) =>
    set((state) => ({ tabs: typeof t === 'function' ? t(state.tabs) : t })),
  setActiveTabId: (id) => set({ activeTabId: id }),
}));

export const useActiveTab = (): TabState | null => {
  const tabs = useTabsStore((s) => s.tabs);
  const activeTabId = useTabsStore((s) => s.activeTabId);
  return tabs.find((t) => t.id === activeTabId) ?? null;
};

export const useTabCount = (): number => {
  return useTabsStore((s) => s.tabs.length);
};
