import { useEffect } from 'react';
import { useDataStore } from '@renderer/store/useDataStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { CaptureNotification } from '@shared/types/passwords';

export function usePasswordListener(): void {
  const { LL } = useI18nContext();
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
            message: LL.password.captureNotify(),
            type: 'info',
            actions: [{
              label: LL.password.enableBtn(),
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
          message: LL.password.savePrompt({ host }),
          type: 'info',
          duration: null,
          actions: [
            {
              label: LL.save(),
              primary: true,
              onClick: async () => { await api.pwd?.saveConfirm(captureId); },
            },
            {
              label: LL.password.ignore(),
              onClick: () => { api.pwd?.ignore(captureId); },
            },
          ],
        });
      }).catch(() => {});
    });

    return () => { if (unsub) unsub(); };
  }, [setStoreStatus, setActivePanel, pushToast, LL]);
}
