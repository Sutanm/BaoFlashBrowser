import { create } from 'zustand';
import { db, saveMeta } from '../services/db';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings, FlashEngineMode, FlashEngineRule, RuffleSource, ThemeMode } from '@shared/types/settings';
import type { PasswordEntry, PasswordStoreStatus, ActivePanel } from '@shared/types/passwords';
import { enqueueToast, type AddressToast, type ToastDismissReason, type ToastInput } from '../services/toast';

export type { AddressToast, ToastAction, ToastDismissReason, ToastInput } from '../services/toast';

export const defaultSettings: Settings = {
  homepage: 'about:newtab',
  restoreSession: true,
  searchEngine: 'bing',
  linkBehavior: 'new-tab',
  flashEngineMode: 'auto' as FlashEngineMode,
  flashEngineRules: [] as FlashEngineRule[],
  ruffleSource: 'bundled' as RuffleSource,
  themeMode: 'system' as ThemeMode,
  language: 'zh-CN',
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
  pushToast: (toast: ToastInput) => void;
  dismissToast: (id: number, reason: ToastDismissReason) => void;
}

// L36: history 写入 debounce，合并频繁的 URL 变化触发
let histPersistTimer: ReturnType<typeof setTimeout> | undefined;
let downloadsPersistTimer: ReturnType<typeof setTimeout> | undefined;

// L36: 注入标志 — useLiveQuery 回灌 store 时跳过 db 写入，避免循环
let skipPersist = false;

async function replaceFavorites(next: BookmarkEntry[]): Promise<void> {
  await db.transaction('rw', db.favorites, async () => {
    await db.favorites.clear();
    if (next.length > 0) await db.favorites.bulkPut(next.map((item, index) => ({ ...item, _idx: index })));
  });
}

async function replaceHistory(next: HistoryEntry[]): Promise<void> {
  await db.transaction('rw', db.history, async () => {
    await db.history.clear();
    if (next.length > 0) await db.history.bulkPut(next);
  });
}

async function replaceDownloads(next: DownloadItem[]): Promise<void> {
  await db.transaction('rw', db.downloads, async () => {
    await db.downloads.clear();
    if (next.length > 0) await db.downloads.bulkPut(next.map((item, index) => ({ ...item, _idx: index })));
  });
}

/** 内部使用：useLiveQuery 把 db 数据注入 store 时调用，不触发持久化 */
export function hydrateFromDb(patch: Partial<Pick<DataState, 'favorites' | 'history' | 'downloads' | 'settings' | 'themeMode'>>) {
  skipPersist = true;
  const normalized = patch.settings?.themeMode ? { ...patch, themeMode: patch.settings.themeMode } : patch;
  useDataStore.setState(normalized);
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
    autoCapture: true,
    autoFill: true,
    autoFillReady: false,
    excludedSites: [],
  },
  activePanel: null,
  toastQueue: [],

  setFavorites: (f) =>
    set((state) => {
      const next = typeof f === 'function' ? f(state.favorites) : f;
      if (!skipPersist) {
        replaceFavorites(next).catch((e) => console.error('[DB] favorites persist failed:', e));
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
          replaceHistory(next).catch((e) => console.error('[DB] history persist failed:', e));
        }, 500);
      }
      return { history: next };
    }),

  setDownloads: (d) =>
    set((state) => {
      const next = typeof d === 'function' ? d(state.downloads) : d;
      if (!skipPersist) {
        const terminalChanged = next.length !== state.downloads.length || next.some((item) => {
          const previous = state.downloads.find((entry) => entry.id === item.id);
          return previous && previous.state !== item.state && ['completed', 'cancelled', 'interrupted'].includes(item.state);
        });
        if (downloadsPersistTimer) clearTimeout(downloadsPersistTimer);
        if (terminalChanged) {
          downloadsPersistTimer = undefined;
          replaceDownloads(next).catch((e) => console.error('[DB] downloads persist failed:', e));
        } else {
          downloadsPersistTimer = setTimeout(() => {
            downloadsPersistTimer = undefined;
            replaceDownloads(next).catch((e) => console.error('[DB] downloads persist failed:', e));
          }, 1000);
        }
      }
      return { downloads: next };
    }),

  setThemeMode: (t) => {
    set((state) => {
      const nextSettings = { ...state.settings, themeMode: t };
      if (!skipPersist) {
        db.settings.put(nextSettings, 'default').catch((e) => console.error('[DB] themeMode persist failed:', e));
        saveMeta('themeMode', t).catch((e) => console.error('[DB] legacy themeMode persist failed:', e));
      }
      return { themeMode: t, settings: nextSettings };
    });
  },

  setSettings: (s) =>
    set((state) => {
      const next = typeof s === 'function' ? (s as any)(state.settings) : s;
      if (!skipPersist) {
        db.settings
          .put(next, 'default')
          .catch((e) => console.error('[DB] settings persist failed:', e));
      }
      return { settings: next, themeMode: next.themeMode };
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

  pushToast: (toast) => {
    const id = nextToastId++;
    let dismissed: ReturnType<typeof enqueueToast>['dismissed'] = [];
    set((state) => {
      const result = enqueueToast(state.toastQueue, { ...toast, id });
      dismissed = result.dismissed;
      return { toastQueue: result.queue };
    });
    for (const item of dismissed) item.toast.onDismiss?.(item.reason);
  },

  dismissToast: (id, reason) => {
    let removed: AddressToast | undefined;
    set((state) => ({
      toastQueue: state.toastQueue.filter((toast) => {
        if (toast.id !== id) return true;
        removed = toast;
        return false;
      }),
    }));
    removed?.onDismiss?.(reason);
  },
}));

let nextToastId = 1;
