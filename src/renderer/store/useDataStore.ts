import { create } from 'zustand';
import { db, saveMeta } from '../services/db';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings, FlashEngineMode, FlashEngineRule, RuffleSource, ThemeMode } from '@shared/types/settings';
import type { PasswordEntry, PasswordStoreStatus, ActivePanel } from '@shared/types/passwords';

export interface ToastAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface AddressToast {
  id?: number;
  message: string;
  type: 'success' | 'info' | 'warning' | 'error';
  color?: string;
  duration?: number | null;
  actions?: ToastAction[];
}

export const defaultSettings: Settings = {
  homepage: 'about:newtab',
  searchEngine: 'bing',
  linkBehavior: 'new-tab',
  flashEngineMode: 'auto' as FlashEngineMode,
  flashEngineRules: [] as FlashEngineRule[],
  ruffleSource: 'bundled' as RuffleSource,
  themeMode: 'system' as ThemeMode,
};

export interface DataState {
  favorites: BookmarkEntry[];
  history: HistoryEntry[];
  downloads: DownloadItem[];
  themeMode: ThemeMode;
  settings: Settings;
  passwords: PasswordEntry[];
  passwordStoreStatus: PasswordStoreStatus;
  activePanel: ActivePanel;
  toastQueue: AddressToast[];

  setFavorites: (f: BookmarkEntry[] | ((prev: BookmarkEntry[]) => BookmarkEntry[])) => void;
  setHistory: (h: HistoryEntry[] | ((prev: HistoryEntry[]) => HistoryEntry[])) => void;
  setDownloads: (d: DownloadItem[] | ((prev: DownloadItem[]) => DownloadItem[])) => void;
  setThemeMode: (t: ThemeMode) => void;
  setSettings: (s: Settings | ((prev: Settings) => Settings)) => void;
  setPasswords: (p: PasswordEntry[] | ((prev: PasswordEntry[]) => PasswordEntry[])) => void;
  setPasswordStoreStatus: (s: PasswordStoreStatus | ((prev: PasswordStoreStatus) => PasswordStoreStatus)) => void;
  setActivePanel: (p: ActivePanel | ((prev: ActivePanel) => ActivePanel)) => void;
  setToastQueue: (t: AddressToast[] | ((prev: AddressToast[]) => AddressToast[])) => void;
  pushToast: (toast: AddressToast) => void;
}

// L36: history 写入 debounce，合并频繁的 URL 变化触发
let histPersistTimer: ReturnType<typeof setTimeout> | undefined;

// L36: 注入标志 — useLiveQuery 回灌 store 时跳过 db 写入，避免循环
let skipPersist = false;

/** 内部使用：useLiveQuery 把 db 数据注入 store 时调用，不触发持久化 */
export function hydrateFromDb(patch: Partial<Pick<DataState, 'favorites' | 'history' | 'downloads' | 'settings' | 'themeMode'>>) {
  skipPersist = true;
  useDataStore.setState(patch);
  skipPersist = false;
}

export const useDataStore = create<DataState>((set) => ({
  favorites: [],
  history: [],
  downloads: [],
  themeMode: 'system',
  settings: defaultSettings,
  passwords: [],
  passwordStoreStatus: {
    initialized: false,
    unlocked: false,
    enabled: false,
  },
  activePanel: null,
  toastQueue: [],

  setFavorites: (f) =>
    set((state) => {
      const next = typeof f === 'function' ? f(state.favorites) : f;
      if (!skipPersist) {
        if (next.length === 0) {
          db.favorites.clear().catch((e) => console.error('[DB] favorites clear failed:', e));
        } else {
          db.favorites
            .clear()
            .then(() => db.favorites.bulkPut(next.map((x, i) => ({ ...x, _idx: i }))))
            .catch((e) => console.error('[DB] favorites persist failed:', e));
        }
      }
      return { favorites: next };
    }),

  setHistory: (h) =>
    set((state) => {
      const next = typeof h === 'function' ? (h as any)(state.history) : h;
      if (!skipPersist) {
        if (histPersistTimer) clearTimeout(histPersistTimer);
        histPersistTimer = setTimeout(() => {
          // history 使用 clear + bulkPut 全量替换，确保单项删除也能真正生效
          db.history
            .clear()
            .then(() => { if (next.length > 0) return db.history.bulkPut(next); })
            .catch((e) => console.error('[DB] history persist failed:', e));
        }, 500);
      }
      return { history: next };
    }),

  setDownloads: (d) =>
    set((state) => {
      const next = typeof d === 'function' ? d(state.downloads) : d;
      if (!skipPersist) {
        if (next.length === 0) {
          db.downloads.clear().catch((e) => console.error('[DB] downloads clear failed:', e));
        } else {
          db.downloads
            .clear()
            .then(() => db.downloads.bulkPut(next.map((x, i) => ({ ...x, _idx: i }))))
            .catch((e) => console.error('[DB] downloads persist failed:', e));
        }
      }
      return { downloads: next };
    }),

  setThemeMode: (t) => {
    set({ themeMode: t });
    if (!skipPersist) {
      saveMeta('themeMode', t).catch((e) => console.error('[DB] themeMode persist failed:', e));
    }
  },

  setSettings: (s) =>
    set((state) => {
      const next = typeof s === 'function' ? (s as any)(state.settings) : s;
      if (!skipPersist) {
        db.settings
          .put(next, 'default')
          .catch((e) => console.error('[DB] settings persist failed:', e));
      }
      return { settings: next };
    }),

  setPasswords: (p) =>
    set((state) => ({
      passwords: typeof p === 'function' ? (p as any)(state.passwords) : p,
    })),
  setPasswordStoreStatus: (s) =>
    set((state) => ({
      passwordStoreStatus:
        typeof s === 'function' ? (s as any)(state.passwordStoreStatus) : s,
    })),
  setActivePanel: (p) =>
    set((state) => ({
      activePanel:
        typeof p === 'function' ? p(state.activePanel) : p,
    })),

  setToastQueue: (t) =>
    set((state) => ({
      toastQueue: typeof t === 'function' ? (t as any)(state.toastQueue) : t,
    })),

  pushToast: (toast) =>
    set((state) => ({
      toastQueue: [...state.toastQueue, { ...toast, id: Date.now() + Math.random() }],
    })),
}));
