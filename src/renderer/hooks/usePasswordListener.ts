import { useEffect, useRef } from 'react';
import { useSetAtom } from 'jotai';
import { pushToastAtom, passwordStoreStatusAtom, activePanelAtom, toastQueueAtom } from '@renderer/atoms/data.atom';
import type { CaptureNotification } from '@shared/types/passwords';
import type { AddressToast } from '@renderer/atoms/data.atom';

export function usePasswordListener(): void {
  const pushToast = useSetAtom(pushToastAtom);
  const setStoreStatus = useSetAtom(passwordStoreStatusAtom);
  const setActivePanel = useSetAtom(activePanelAtom);
  const setToastQueue = useSetAtom(toastQueueAtom);

  useEffect(() => {
    (window as any).electronAPI?.pwd?.status().then((s: any) => {
      if (s) setStoreStatus(s);
    }).catch(() => {});
  }, [setStoreStatus]);

  useEffect(() => {
    const api = (window as any).electronAPI;
    if (!api) return;

    const unsub = api.on('password:captured', (data: CaptureNotification) => {
      const { captureId, host } = data;

      api.pwd?.status().then((s: any) => {
        if (!s || !s.initialized) {
          pushToast({
            message: '检测到登录信息，可启用密码本保存',
            type: 'info',
            actions: [{
              label: '启用密码本',
              primary: true,
              onClick: () => { setActivePanel('passwords'); },
            }, {
              label: '忽略',
              onClick: () => { api.pwd?.ignore(captureId); },
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
          actions: [{
            label: '保存',
            primary: true,
            onClick: async () => {
              await api.pwd?.saveConfirm(captureId);
              setToastQueue((prev: AddressToast[]) => prev.slice(1));
            },
          }, {
            label: '忽略',
            onClick: () => {
              api.pwd?.ignore(captureId);
              setToastQueue((prev: AddressToast[]) => prev.slice(1));
            },
          }],
        });
      }).catch(() => {});
    });

    return () => { if (unsub) unsub(); };
  }, [pushToast, setStoreStatus, setActivePanel, setToastQueue]);
}
