import React, { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../services/db';
import { hydrateFromDb, useDataStore } from '../../store/useDataStore';

const DatabaseHydrator: React.FC = () => {
  const setDownloads = useDataStore((state) => state.setDownloads);
  const favorites = useLiveQuery(async () => (await db.favorites.toArray()).sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0)), []);
  const history = useLiveQuery(() => db.history.orderBy('lastVisit').reverse().limit(5000).toArray(), []);
  const settings = useLiveQuery(async () => (await db.settings.toArray())[0] || null, []);
  const themeMode = useLiveQuery(async () => (await db.meta.get('themeMode'))?.value as 'light' | 'dark' | 'system' | undefined, []);

  useEffect(() => { if (favorites) hydrateFromDb({ favorites }); }, [favorites]);
  useEffect(() => { if (history) hydrateFromDb({ history }); }, [history]);
  useEffect(() => { if (settings) hydrateFromDb({ settings: { ...useDataStore.getState().settings, ...settings } }); }, [settings]);
  useEffect(() => { if (themeMode) hydrateFromDb({ themeMode }); }, [themeMode]);

  // 下载记录以主进程为唯一权威源（download-state 已在主进程持久化）：
  // 挂载时一次性拉取，后续只靠 download:progress 事件驱动。
  // 之前这里用 useLiveQuery 监听 IndexedDB 镜像并在每次写库时把
  // progressing/paused 强制改写为 interrupted 回灌 store，导致面板
  // 长期停留在「已中断」、暂停按钮失效。
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.dl.list()
      .then((records) => { if (!cancelled && Array.isArray(records)) setDownloads(records); })
      .catch((error) => console.warn('[Download] main-process list failed:', error));
    return () => { cancelled = true; };
  }, [setDownloads]);

  return null;
};

export default DatabaseHydrator;
