import React, { useEffect, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../services/db';
import { hydrateFromDb, useDataStore } from '../../store/useDataStore';

const DatabaseHydrator: React.FC = () => {
  const setDownloads = useDataStore((state) => state.setDownloads);
  const downloadSyncDoneRef = useRef(false);
  const favorites = useLiveQuery(async () => (await db.favorites.toArray()).sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0)), []);
  const history = useLiveQuery(() => db.history.orderBy('lastVisit').reverse().limit(5000).toArray(), []);
  const downloads = useLiveQuery(async () => {
    const items = (await db.downloads.toArray()).filter((item) => item.filename).map((item) =>
      item.state === 'progressing' || item.state === 'paused'
        ? { ...item, state: 'interrupted' as const, speed: 0 }
        : item
    );
    return items.sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
  }, []);
  const settings = useLiveQuery(async () => (await db.settings.toArray())[0] || null, []);
  const themeMode = useLiveQuery(async () => (await db.meta.get('themeMode'))?.value as 'light' | 'dark' | 'system' | undefined, []);

  useEffect(() => { if (favorites) hydrateFromDb({ favorites }); }, [favorites]);
  useEffect(() => { if (history) hydrateFromDb({ history }); }, [history]);
  useEffect(() => { if (settings) hydrateFromDb({ settings: { ...useDataStore.getState().settings, ...settings } }); }, [settings]);
  useEffect(() => { if (themeMode) hydrateFromDb({ themeMode }); }, [themeMode]);
  useEffect(() => {
    if (!downloads) return;
    hydrateFromDb({ downloads });
    if (downloadSyncDoneRef.current) return;
    downloadSyncDoneRef.current = true;
    window.electronAPI.dl.syncRecords(downloads).then(setDownloads)
      .catch((error) => console.warn('[Download] main-process state sync failed:', error));
  }, [downloads, setDownloads]);

  return null;
};

export default DatabaseHydrator;
