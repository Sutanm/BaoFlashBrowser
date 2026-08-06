import { create } from 'zustand';
import { db, saveMeta } from '../services/db';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings, FlashEngineMode, FlashEngineRule, RuffleSource, ThemeMode } from '@shared/types/settings';
import type { PasswordEntry, PasswordStoreStatus, ActivePanel } from '@shared/types/passwords';
import { enqueueToast, type AddressToast, type ToastDismissReason, type ToastInput } from '../services/toast';
import { applyHistoryVisit } from '../services/history-state';

export type { AddressToast, ToastAction, ToastDismissReason, ToastInput } from '../services/toast';

export const defaultSettings: Settings = {
  homepage: 'about:newtab',
  restoreSession: true,
  suspendInactiveTabs: false,
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
  recordHistory: (entry: HistoryEntry) => void;
  updateHistoryByUrl: (url: string, patch: Partial<Pick<HistoryEntry, 'title' | 'favicon' | 'lastVisit'>>) => void;
  removeHistory: (id: string) => void;
  clearHistory: () => void;
  setDownloads: (d: DownloadItem[] | ((prev: DownloadItem[]) => DownloadItem[])) => void;
  setThemeMode: (t: ThemeMode) => void;
  setSettings: (s: Settings | ((prev: Settings) => Settings)) => void;
  setPasswords: (p: PasswordEntry[] | ((prev: PasswordEntry[]) => PasswordEntry[])) => void;
  setPasswordStoreStatus: (s: PasswordStoreStatus | ((prev: PasswordStoreStatus) => PasswordStoreStatus)) => void;
  setActivePanel: (p: ActivePanel | ((prev: ActivePanel) => ActivePanel)) => void;
  pushToast: (toast: ToastInput) => void;
  dismissToast: (id: number, reason: ToastDismissReason) => void;
}

const downloadPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
let persistenceQueue: Promise<void> = Promise.resolve();

function enqueuePersistence(label: string, operation: () => Promise<void>): void {
  persistenceQueue = persistenceQueue
    .then(operation, operation)
    .catch((error) => console.error(`[DB] ${label} persist failed:`, error));
}

// L36: 注入标志 — useLiveQuery 回灌 store 时跳过 db 写入，避免循环
let skipPersist = false;

async function replaceFavorites(next: BookmarkEntry[]): Promise<void> {
  await db.transaction('rw', db.favorites, async () => {
    await db.favorites.clear();
    if (next.length > 0) await db.favorites.bulkPut(next.map((item, index) => ({ ...item, _idx: index })));
  });
}

type PersistedDownload = DownloadItem & { _idx?: number };

function persistDownload(item: PersistedDownload, immediate: boolean): void {
  const existing = downloadPersistTimers.get(item.id);
  if (existing) clearTimeout(existing);
  const write = () => {
    downloadPersistTimers.delete(item.id);
    enqueuePersistence('download', () => db.downloads.put(item).then(() => undefined));
  };
  if (immediate) write();
  else downloadPersistTimers.set(item.id, setTimeout(write, 1000));
}

/** 内部使用：useLiveQuery 把 db 数据注入 store 时调用，不触发持久化 */
export function hydrateFromDb(patch: Partial<Pick<DataState, 'favorites' | 'history' | 'downloads' | 'settings' | 'themeMode'>>) {
  skipPersist = true;
  const normalized = patch.settings?.themeMode ? { ...patch, themeMode: patch.settings.themeMode } : patch;
  useDataStore.setState(normalized);
  skipPersist = false;
}

export const useDataStore = create<DataState>((set, get) => ({
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
        enqueuePersistence('favorites', () => replaceFavorites(next));
      }
      return { favorites: next };
    }),

  recordHistory: (entry) => {
    const previous = get().history;
    const { history, record, removedIds } = applyHistoryVisit(previous, entry);
    set({ history });
    if (!skipPersist) enqueuePersistence('history upsert', async () => {
      await db.transaction('rw', db.history, async () => {
        await db.history.put(record);
        if (removedIds.length) await db.history.bulkDelete(removedIds);
      });
    });
  },

  updateHistoryByUrl: (url, patch) => {
    const existing = get().history.find((item) => item.url === url);
    if (!existing) return;
    const updated = { ...existing, ...patch };
    set((state) => ({ history: state.history.map((item) => item.id === updated.id ? updated : item) }));
    if (!skipPersist) enqueuePersistence('history update', () => db.history.put(updated).then(() => undefined));
  },

  removeHistory: (id) => {
    set((state) => ({ history: state.history.filter((item) => item.id !== id) }));
    if (!skipPersist) enqueuePersistence('history delete', () => db.history.delete(id));
  },

  clearHistory: () => {
    set({ history: [] });
    if (!skipPersist) enqueuePersistence('history clear', () => db.history.clear());
  },

  setDownloads: (d) =>
    set((state) => {
      const rawNext = typeof d === 'function' ? d(state.downloads) : d;
      let nextIndex = Math.min(0, ...state.downloads.map((item) => (item as PersistedDownload)._idx ?? 0)) - 1;
      const next = rawNext.map((item) => {
        const previous = state.downloads.find((entry) => entry.id === item.id) as PersistedDownload | undefined;
        return { ...item, _idx: (item as PersistedDownload)._idx ?? previous?._idx ?? nextIndex-- } as PersistedDownload;
      });
      if (!skipPersist) {
        for (const previous of state.downloads) {
          if (!next.some((item) => item.id === previous.id)) {
            const timer = downloadPersistTimers.get(previous.id); if (timer) clearTimeout(timer);
            downloadPersistTimers.delete(previous.id);
            enqueuePersistence('download delete', () => db.downloads.delete(previous.id));
          }
        }
        for (const item of next) {
          const previous = state.downloads.find((entry) => entry.id === item.id);
          if (previous && JSON.stringify(previous) === JSON.stringify(item)) continue;
          const stateChanged = !previous || previous.state !== item.state;
          const terminal = ['completed', 'cancelled', 'interrupted'].includes(item.state);
          persistDownload(item, stateChanged || terminal);
        }
      }
      return { downloads: next };
    }),

  setThemeMode: (t) => {
    set((state) => {
      const nextSettings = { ...state.settings, themeMode: t };
      if (!skipPersist) {
        enqueuePersistence('themeMode', async () => {
          await db.transaction('rw', db.settings, db.meta, async () => {
            await db.settings.put(nextSettings, 'default');
            await saveMeta('themeMode', t);
          });
        });
      }
      return { themeMode: t, settings: nextSettings };
    });
  },

  setSettings: (s) =>
    set((state) => {
      const next = typeof s === 'function' ? s(state.settings) : s;
      if (!skipPersist) {
        enqueuePersistence('settings', () => db.settings.put(next, 'default').then(() => undefined));
      }
      return { settings: next, themeMode: next.themeMode };
    }),

  setPasswords: (p) =>
    set((state) => ({
      passwords: typeof p === 'function' ? p(state.passwords) : p,
    })),
  setPasswordStoreStatus: (s) =>
    set((state) => ({
      passwordStoreStatus:
        typeof s === 'function' ? s(state.passwordStoreStatus) : s,
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
