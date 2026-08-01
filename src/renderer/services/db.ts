import Dexie from 'dexie';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

class BaoDB extends Dexie {
  favorites!: Dexie.Table<BookmarkEntry & { _idx?: number }, string>;
  history!: Dexie.Table<HistoryEntry, string>;
  downloads!: Dexie.Table<DownloadItem & { _idx?: number }, string>;
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

// Atomic upsert helpers
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

  // L23: 迁移改为 async + await bulkPut，确保数据完整性
  const migrate = async (key: string, store: Dexie.Table) => {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          await store.bulkPut(data);
        }
      }
    } catch (e) { console.warn('[DB] migrate failed for ' + key + ':', e); }
  };

  // L23: 4 个 migrate 相互独立，并行执行
  await Promise.all([
    migrate('baoflash_favorites', db.favorites),
    migrate('baoflash_history', db.history),
    migrate('baoflash_downloads', db.downloads),
    migrate('baoflash_settings', db.settings),
  ]);

  // Migrate theme to themeMode
  const oldTheme = localStorage.getItem('baoflash_theme');
  if (oldTheme) {
    const themeMode = oldTheme === 'dark' ? 'dark' : 'light';
    await saveMeta('themeMode', themeMode);
    localStorage.removeItem('baoflash_theme');
  }

  await saveMeta('migrated_v1', true);

  // Clear migrated localStorage keys
  for (const k of ['baoflash_favorites', 'baoflash_history', 'baoflash_downloads', 'baoflash_settings']) {
    localStorage.removeItem(k);
  }
}
