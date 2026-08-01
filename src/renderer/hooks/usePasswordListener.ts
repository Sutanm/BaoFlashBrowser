import { useEffect } from 'react';
import { useDataStore } from '@renderer/store/useDataStore';
import type { CaptureNotification } from '@shared/types/passwords';

export function usePasswordListener(): void {
  const setStoreStatus = useDataStore((s) => s.setPasswordStoreStatus);
  const setActivePanel = useDataStore((s) => s.setActivePanel);
  const pushToast = useDataStore((s) => s.pushToast);

  useEffect(() => {
    window.electronAPI?.pwd?.status().then((s) => {
      if (s) setStoreStatus(s);
    }).catch(() => {});
  }, [setStoreStatus]);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;

    const unsub = api.on('password:captured', (data) => {
      const { captureId, host } = data as CaptureNotification;

      api.pwd?.status().then((s) => {
        if (!s || !s.initialized) {
          pushToast({
            message: '检测到登录信息，可启用密码本保存',
            type: 'info',
            actions: [{
              label: '启用密码本',
              primary: true,
              onClick: () => { setActivePanel('passwords'); },
            }],
          });
          return;
        }

        if (!s.enabled) {
          api.pwd?.ignore(captureId);
          return;
        }

        pushToast({
          message: `为 ${host} 保存密码？`,
          type: 'info',
          duration: null,
          actions: [
            {
              label: '保存',
              primary: true,
              onClick: async () => { await api.pwd?.saveConfirm(captureId); },
            },
            {
              label: '忽略',
              onClick: () => { api.pwd?.ignore(captureId); },
            },
          ],
        });
      }).catch(() => {});
    });

    return () => { if (unsub) unsub(); };
  }, [setStoreStatus, setActivePanel, pushToast]);
}
