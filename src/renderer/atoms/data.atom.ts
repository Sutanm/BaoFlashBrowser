import { atom } from 'jotai';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings, FlashEngineMode, FlashEngineRule, RuffleSource, DownloadEngine } from '@shared/types/settings';
import type { PasswordEntry, PasswordStoreStatus, ActivePanel } from '@shared/types/passwords';

export const favoritesAtom = atom<BookmarkEntry[]>([]);
export const historyAtom = atom<HistoryEntry[]>([]);
export const downloadsAtom = atom<DownloadItem[]>([]);
export const themeAtom = atom<'light' | 'dark'>('light');

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface AddressToast {
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
  color?: string;
  duration?: number | null;
  actions?: ToastAction[];
}

export const toastQueueAtom = atom<AddressToast[]>([]);

export const pushToastAtom = atom(
  null,
  (_get, set, toast: AddressToast) => {
    set(toastQueueAtom, (prev) => [...prev, toast]);
  }
);

export const defaultSettings: Settings = {
  homepage: 'about:newtab',
  searchEngine: 'bing',
  linkBehavior: 'new-tab',
  flashVersion: '34.0.0.330',
  flashEngineMode: 'auto' as FlashEngineMode,
  flashEngineRules: [] as FlashEngineRule[],
  lowEndMode: false,
  ruffleSource: 'bundled' as RuffleSource,
  downloadEngine: 'aria2' as DownloadEngine,
};

export const settingsAtom = atom<Settings>(defaultSettings);

export const passwordsAtom = atom<PasswordEntry[]>([]);
export const passwordStoreStatusAtom = atom<PasswordStoreStatus>({
  initialized: false,
  unlocked: false,
  enabled: false,
  dpapiAvailable: false,
});
export const activePanelAtom = atom<ActivePanel>(null);
