import { useEffect } from 'react';
import { useDataStore } from '../store/useDataStore';
import { useI18nContext } from '../i18n/i18n-react';
import type { DownloadItem } from '@shared/types/downloads';

export function useDownloadListener(): void {
  const { LL } = useI18nContext();
  const setDownloads = useDataStore((s) => s.setDownloads);
  const pushToast = useDataStore((s) => s.pushToast);

  useEffect(() => {
    const cleanup = window.electronAPI?.on('download:progress', (payload) => {
      const name = payload.filename || LL.download.file();
      const isNewDownload = !useDataStore.getState().downloads.some((download) => download.id === payload.id);
      if (isNewDownload) {
        pushToast({ key: `download-start:${payload.id}`, message: LL.download.started({ name }), type: 'info' });
      }

      setDownloads((prev: DownloadItem[]) => {
        const exists = prev.find((d) => d.id === payload.id);
        if (exists) {
          return prev.map((d) => {
            if (d.id !== payload.id) return d;
            return {
              ...d,
              ...Object.fromEntries(Object.entries(payload).filter(([, value]) => value !== undefined)),
            } as DownloadItem;
          });
        }
        return [{
          id: payload.id,
          url: payload.url || '',
          filename: payload.filename || name,
          state: payload.state,
          progress: payload.progress,
          speed: payload.speed,
          receivedBytes: payload.receivedBytes || 0,
          totalBytes: payload.totalBytes || 0,
          savePath: payload.savePath || '',
          engine: payload.engine,
        }, ...prev];
      });

      if (payload.state === 'completed') {
        pushToast({ key: `download-result:${payload.id}`, message: LL.download.completed({ name }), type: 'success' });
      } else if (payload.state === 'cancelled') {
        pushToast({ key: `download-result:${payload.id}`, message: LL.download.cancelledNotify({ name }), type: 'warning' });
      } else if (payload.state === 'interrupted') {
        pushToast({ key: `download-result:${payload.id}`, message: LL.download.failed({ name }), type: 'error' });
      }
    });
    return () => { cleanup?.(); };
  }, [setDownloads, pushToast, LL]);
}
