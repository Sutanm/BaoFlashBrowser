import { atom } from 'jotai';
import type { Tab } from '@shared/types/tab';

export interface TabState extends Tab {
  webviewId?: string;
}

export const tabsAtom = atom<TabState[]>([]);
export const activeTabIdAtom = atom<string | null>(null);
export const tabCountAtom = atom((get) => get(tabsAtom).length);
export const activeTabAtom = atom((get) => {
  const tabs = get(tabsAtom);
  const activeId = get(activeTabIdAtom);
  return tabs.find((t) => t.id === activeId) ?? null;
});
