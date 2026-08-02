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

    const unsubCapture = api.on('password:captured', (data) => {
      const { captureId, host } = data as CaptureNotification;

      api.pwd?.status().then((s) => {
        if (!s || !s.initialized) {
          pushToast({
            key: `password-capture:${host}`,
            message: LL.password.captureNotify(),
            type: 'info',
            duration: null,
            onDismiss: (reason) => { if (reason !== 'action') void api.pwd.ignore(captureId); },
            actions: [{
              label: LL.password.enableBtn(),
              primary: true,
              onClick: () => { void api.pwd.ignore(captureId); setActivePanel('passwords'); },
            }],
          });
          return;
        }

        if (!s.enabled) {
          api.pwd?.ignore(captureId);
          return;
        }

        pushToast({
          key: `password-capture:${host}`,
          message: LL.password.savePrompt({ host }),
          type: 'info',
          duration: null,
          onDismiss: (reason) => { if (reason !== 'action') void api.pwd.ignore(captureId); },
          actions: [
            {
              label: LL.save(),
              primary: true,
              onClick: async () => {
                try {
                  const result = await api.pwd.saveConfirm(captureId);
                  if (result.success) return;
                } catch {
                  // The original prompt has already closed; report failure separately below.
                }
                pushToast({ key: `password-save-error:${host}`, message: LL.password.saveFailed(), type: 'error' });
              },
            },
            {
              label: LL.password.ignore(),
              onClick: () => { void api.pwd.ignore(captureId); },
            },
          ],
        });
      }).catch(() => {});
    });

    const unsubFilled = api.on('password:filled', () => {
      pushToast({
        key: 'password-filled',
        message: LL.password.filled(),
        type: 'success',
      });
    });

    return () => {
      if (unsubCapture) unsubCapture();
      if (unsubFilled) unsubFilled();
    };
  }, [setStoreStatus, setActivePanel, pushToast, LL]);
}
