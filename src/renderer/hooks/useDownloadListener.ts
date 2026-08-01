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

      setDownloads((prev: DownloadItem[]) => {
        const exists = prev.find((d) => d.id === payload.id);
        if (exists) {
          return prev.map((d) => {
            if (d.id !== payload.id) return d;
            const merged = { ...d } as any;
            for (const key of Object.keys(payload)) {
              if (payload[key] !== undefined) merged[key] = payload[key];
            }
            return merged as DownloadItem;
          });
        }
        pushToast({ message: LL.download.started({ name }), type: 'info' });
        return [{ ...payload, id: payload.id }, ...prev];
      });

      if (payload.state === 'completed') {
        pushToast({ message: LL.download.completed({ name }), type: 'success' });
      } else if (payload.state === 'cancelled') {
        pushToast({ message: LL.download.cancelledNotify({ name }), type: 'warning' });
      } else if (payload.state === 'interrupted') {
        pushToast({ message: LL.download.failed({ name }), type: 'error' });
      }
    });
    return () => { cleanup?.(); };
  }, [setDownloads, pushToast, LL]);
}
