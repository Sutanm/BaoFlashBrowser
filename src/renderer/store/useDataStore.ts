import { create } from 'zustand';
import { db, saveMeta } from '../services/db';
import { changedSettings, mergeSettings, planFavoriteWrites } from '../services/persistence-merge';
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
  /** P8：IndexedDB 首次水合完成（此前不得下发主题/语言，否则会用默认值覆盖）。 */
  hydrated: boolean;

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
  markHydrated: () => void;
}

let persistenceQueue: Promise<void> = Promise.resolve();

function enqueuePersistence(label: string, operation: () => Promise<void>): void {
  persistenceQueue = persistenceQueue
    .then(operation, operation)
    .catch((error) => console.error(`[DB] ${label} persist failed:`, error));
}

// L36: 注入标志 — useLiveQuery 回灌 store 时跳过 db 写入，避免循环
let skipPersist = false;

async function replaceFavorites(previous: BookmarkEntry[], next: BookmarkEntry[]): Promise<void> {
  const { removedKeys, put } = planFavoriteWrites(previous, next);
  await db.transaction('rw', db.favorites, async () => {
    // removedKeys 是主键（url），不是收藏 id：表 schema 见 services/db.ts 的 `favorites: 'url'`。
    if (removedKeys.length > 0) await db.favorites.bulkDelete(removedKeys);
    if (put.length > 0) await db.favorites.bulkPut(put);
  });
}

/** 只把本窗口真正改过的设置键合并进库，避免覆盖另一个窗口的并发修改。 */
async function persistSettingsMerge(previous: Settings, next: Settings): Promise<void> {
  const changed = changedSettings(previous, next);
  if (Object.keys(changed).length === 0) return;
  await db.transaction('rw', db.settingsSingleton, async () => {
    const current = (await db.settingsSingleton.get('default')) ?? next;
    await db.settingsSingleton.put(mergeSettings(current, changed), 'default');
  });
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
    enabled: false,
    initialized: false,
    tier: 'none',
    autoCapture: true,
    autoFill: true,
    autoFillReady: false,
    keyStatus: 'ok',
    viewGuard: { mode: 'none', passwordSet: false },
    excludedSites: [],
  },
  activePanel: null,
  toastQueue: [],
  hydrated: false,

  markHydrated: () => set({ hydrated: true }),

  setFavorites: (f) =>
    set((state) => {
      const next = typeof f === 'function' ? f(state.favorites) : f;
      const previous = state.favorites;
      if (!skipPersist) {
        enqueuePersistence('favorites', () => replaceFavorites(previous, next));
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
    set((state) => ({
      downloads: typeof d === 'function' ? d(state.downloads) : d,
    })),

  setThemeMode: (t) => {
    set((state) => {
      const previous = state.settings;
      const nextSettings = { ...state.settings, themeMode: t };
      if (!skipPersist) {
        enqueuePersistence('themeMode', async () => {
          await persistSettingsMerge(previous, nextSettings);
          await saveMeta('themeMode', t);
        });
      }
      return { themeMode: t, settings: nextSettings };
    });
  },

  setSettings: (s) =>
    set((state) => {
      const previous = state.settings;
      const next = typeof s === 'function' ? s(state.settings) : s;
      if (!skipPersist) {
        enqueuePersistence('settings', () => persistSettingsMerge(previous, next));
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
