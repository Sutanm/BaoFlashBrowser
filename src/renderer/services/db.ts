import Dexie from 'dexie';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

class BaoDB extends Dexie {
  favorites!: Dexie.Table<BookmarkEntry & { _idx?: number }, string>;
  history!: Dexie.Table<HistoryEntry, string>;
  downloads!: Dexie.Table<DownloadItem & { _idx?: number }, string>;
  settingsSingleton!: Dexie.Table<Settings, string>;
  meta!: Dexie.Table<{ key: string; value: unknown }, string>;

  constructor() {
    super('BaoFlashDB');
    this.version(1).stores({
      favorites: 'url',
      history: 'id,lastVisit',
      downloads: 'id',
      settings: 'searchEngine',
      meta: 'key',
    });
    this.version(2).stores({
      favorites: 'url',
      history: 'id,lastVisit,url',
      downloads: 'id',
      settings: 'searchEngine',
      meta: 'key',
    }).upgrade(async (transaction) => {
      const history = transaction.table<HistoryEntry, string>('history');
      const entries = await history.orderBy('lastVisit').reverse().toArray();
      if (entries.length > 5000) await history.bulkDelete(entries.slice(5000).map((entry) => entry.id));
    });
    // Keep the legacy table as a recovery copy. Its rows have no timestamps,
    // so preserve the same first row that older releases actually displayed.
    this.version(3).stores({ settingsSingleton: '' }).upgrade(async (transaction) => {
      const previous = await transaction.table<Settings, string>('settings').toArray();
      if (previous[0]) await transaction.table('settingsSingleton').put(previous[0], 'default');
    });
  }
}

export const db = new BaoDB();

// Atomic upsert helpers
export async function saveMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

export async function loadMeta<T = unknown>(key: string): Promise<T | undefined> {
  const entry = await db.meta.get(key);
  return entry?.value as T | undefined;
}

// Migrate localStorage to IndexedDB on first run
export async function migrateFromLocalStorage() {
  const migrated = await loadMeta('migrated_v1');
  if (migrated) return;

  const keys = ['baoflash_favorites', 'baoflash_history', 'baoflash_downloads', 'baoflash_settings'];
  // Parse before starting the transaction. Malformed input stays available for recovery.
  const values = keys.map((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? undefined : JSON.parse(raw);
  });
  const oldTheme = localStorage.getItem('baoflash_theme');
  await db.transaction('rw', [db.favorites, db.history, db.downloads, db.settingsSingleton, db.meta], async () => {
    const tables: Dexie.Table[] = [db.favorites, db.history, db.downloads];
    for (let i = 0; i < tables.length; i++) {
      if (values[i] === undefined) continue;
      if (!Array.isArray(values[i])) throw new Error(`Invalid legacy data: ${keys[i]}`);
      if (values[i].length) await tables[i].bulkPut(values[i]);
    }
    const settings = Array.isArray(values[3]) ? values[3][0] : values[3];
    if (settings !== undefined) {
      if (!settings || typeof settings !== 'object' || !['bing', 'google', 'baidu'].includes(settings.searchEngine)) {
        throw new Error('Invalid legacy settings');
      }
      if (!(await db.settingsSingleton.get('default'))) await db.settingsSingleton.put(settings, 'default');
    }
    if (oldTheme) await saveMeta('themeMode', oldTheme === 'dark' ? 'dark' : 'light');
    await saveMeta('migrated_v1', true);
  });
  // Only remove source data after the entire transaction commits.
  for (const key of [...keys, 'baoflash_theme']) localStorage.removeItem(key);
}
