import { useEffect } from 'react';
import { useSetAtom } from 'jotai';
import { downloadsAtom, pushToastAtom } from '../atoms/data.atom';
import type { DownloadItem } from '@shared/types/downloads';

export function useDownloadListener(): void {
  const setDownloads = useSetAtom(downloadsAtom);
  const pushToast = useSetAtom(pushToastAtom);

  useEffect(() => {
    const cleanup = (window as any).electronAPI?.on('download:progress', (payload: any) => {
      const name = payload.filename || '文件';

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
        pushToast({ message: `${name} 开始下载`, type: 'info' });
        return [{ ...payload, id: payload.id }, ...prev];
      });

      if (payload.state === 'completed') {
        pushToast({ message: `${name} 下载完成`, type: 'success' });
      } else if (payload.state === 'cancelled') {
        pushToast({ message: `${name} 已取消`, type: 'warning' });
      } else if (payload.state === 'interrupted') {
        pushToast({ message: `${name} 下载失败`, type: 'error' });
      }
    });
    return () => { cleanup?.(); };
  }, [setDownloads, pushToast]);
}
