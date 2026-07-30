import Dexie from 'dexie';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

class BaoDB extends Dexie {
  favorites!: Dexie.Table<BookmarkEntry, string>;
  history!: Dexie.Table<HistoryEntry, string>;
  downloads!: Dexie.Table<DownloadItem, string>;
  settings!: Dexie.Table<Settings, string>;
  meta!: Dexie.Table<{ key: string; value: any }, string>;

  constructor() {
    super('BaoFlashDB');
    this.version(1).stores({
      favorites: 'url',
      history: 'id,lastVisit',
      downloads: 'id',
      settings: 'searchEngine',
      meta: 'key',
    });
  }
}

export const db = new BaoDB();

export async function loadAll() {
  const [favorites, history, downloads, settings, meta] = await Promise.all([
    db.favorites.toArray(),
    db.history.orderBy('lastVisit').reverse().toArray(),
    db.downloads.toArray(),
    db.settings.toArray().then((r) => r[0] || null),
    db.meta.toArray().then((arr) => {
      const m: Record<string, any> = {};
      for (const { key, value } of arr) m[key] = value;
      return m;
    }),
  ]);
  return { favorites, history, downloads, settings, meta };
}

// Atomic upsert helpers
export async function saveSettings(s: Settings) {
  await db.settings.put(s, 'default');
}

export async function saveMeta(key: string, value: any) {
  await db.meta.put({ key, value }, key);
}

export async function loadMeta(key: string): Promise<any> {
  const entry = await db.meta.get(key);
  return entry?.value;
}

// Migrate localStorage to IndexedDB on first run
export async function migrateFromLocalStorage() {
  const migrated = await loadMeta('migrated_v1');
  if (migrated) return;

  const migrate = (key: string, store: Dexie.Table) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          store.bulkPut(data);
        }
      }
    } catch {}
  };

  migrate('baoflash_favorites', db.favorites);
  migrate('baoflash_history', db.history);
  migrate('baoflash_downloads', db.downloads);
  migrate('baoflash_settings', db.settings);

  // Migrate theme
  const theme = localStorage.getItem('baoflash_theme');
  if (theme) await saveMeta('theme', theme);

  await saveMeta('migrated_v1', true);

  // Clear migrated localStorage keys
  for (const k of ['baoflash_favorites', 'baoflash_history', 'baoflash_downloads', 'baoflash_settings']) {
    localStorage.removeItem(k);
  }
}
