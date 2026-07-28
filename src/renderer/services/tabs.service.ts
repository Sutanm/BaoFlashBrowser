import { atom, useSetAtom, useAtom } from 'jotai';
import { useCallback } from 'react';
import type { TabState } from '@renderer/atoms/tabs.atom';
import { tabsAtom, activeTabIdAtom } from '@renderer/atoms/tabs.atom';
import { generateId } from './id.service';

export function createTabAtom(url: string) {
  const id = generateId();
  const tab: TabState = {
    id,
    url: url || 'about:newtab',
    title: 'New Tab',
    favicon: '',
    zoomLevel: 1.0,
    isLoading: true,
    isAudible: false,
    isMuted: false,
    canGoBack: false,
    canGoForward: false,
    createdAt: Date.now(),
  };
  return { id, tab };
}

export function useTabManager() {
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);

  const createTab = useCallback((url?: string) => {
    const { id, tab } = createTabAtom(url || 'about:newtab');
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    return id;
  }, [setTabs, setActiveTabId]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      return next;
    });
    if (activeTabId === tabId) {
      setTabs((prev) => {
        if (prev.length === 0) {
          setActiveTabId(null);
          return prev;
        }
        const idx = prev.findIndex((t) => t.id === tabId);
        const newIdx = Math.min(idx, prev.length - 1);
        setActiveTabId(prev[newIdx].id);
        return prev;
      });
    }
  }, [setTabs, setActiveTabId, activeTabId]);

  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  const updateTab = useCallback((tabId: string, changes: Partial<TabState>) => {
    setTabs((prev) =>
      prev.map((t) => (t.id === tabId ? { ...t, ...changes } : t)),
    );
  }, [setTabs]);

  return { tabs, activeTabId, createTab, closeTab, switchTab, updateTab };
}
