import { atom } from 'jotai';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings, FlashEngineMode, FlashEngineRule } from '@shared/types/settings';

export const favoritesAtom = atom<BookmarkEntry[]>([]);
export const historyAtom = atom<HistoryEntry[]>([]);
export const downloadsAtom = atom<DownloadItem[]>([]);

export const defaultSettings: Settings = {
  homepage: 'about:newtab',
  searchEngine: 'bing',
  linkBehavior: 'new-tab',
  flashVersion: '34.0.0.330',
  flashEngineMode: 'auto' as FlashEngineMode,
  flashEngineRules: [] as FlashEngineRule[],
  lowEndMode: false,
};

export const settingsAtom = atom<Settings>(defaultSettings);
