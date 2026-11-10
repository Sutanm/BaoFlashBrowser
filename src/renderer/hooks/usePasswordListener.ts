import { useEffect } from 'react';
import { useDataStore } from '@renderer/store/useDataStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { CaptureNotification } from '@shared/types/passwords';

/**
 * 保存密码提示的渲染层诊断：只上报"做了什么决定"，不含任何凭据或用户名。
 * 主进程会落成 `[PasswordUI] …`，用于回答"捕获成功了为什么没看到提示"。
 */
function logDecision(message: string): void {
  try { window.electronAPI?.pwd?.uiDiagnostic?.(message); } catch { /* diagnostics must never break the prompt */ }
}

function queueDepth(): number {
  try { return useDataStore.getState().toastQueue.length; } catch { return -1; }
}

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
      logDecision(`captured event host=${host} queue=${queueDepth()}`);

      api.pwd?.status().then((s) => {
        if (!s || !s.initialized) {
          logDecision(`no vault yet host=${host} -> enable prompt queue=${queueDepth()}`);
          pushToast({
            key: `password-capture:${host}`,
            message: LL.password.captureNotify(),
            type: 'info',
            duration: null,
            // 地址栏提示宿主只渲染队首：保存类提示必须插队，否则会被前一条
            // （尤其是同样 sticky 的提示）挡在后面，表现为"登录了却没弹提示"。
            priority: 'high',
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
          logDecision(`store disabled host=${host} -> capture ignored`);
          api.pwd?.ignore(captureId);
          return;
        }

        pushToast({
          key: `password-capture:${host}`,
          message: LL.password.savePrompt({ host }),
          type: 'info',
          duration: null,
          priority: 'high',
          onDismiss: (reason) => {
            if (reason !== 'action') {
              logDecision(`prompt dismissed(${reason}) host=${host} -> capture ignored`);
              void api.pwd.ignore(captureId);
            }
          },
          actions: [
            {
              label: LL.save(),
              primary: true,
              onClick: async () => {
                try {
                  const result = await api.pwd.saveConfirm(captureId);
                  if (result.success) { logDecision(`saved host=${host}`); return; }
                  logDecision(`save failed host=${host} result=${JSON.stringify(result?.error ?? null)}`);
                } catch {
                  logDecision(`save threw host=${host}`);
                }
                pushToast({ key: `password-save-error:${host}`, message: LL.password.saveFailed(), type: 'error' });
              },
            },
            {
              label: LL.password.ignore(),
              onClick: () => {
                logDecision(`user ignored host=${host}`);
                void api.pwd.ignore(captureId);
              },
            },
          ],
        });
        logDecision(`prompt queued host=${host} queue=${queueDepth()}`);
      }).catch((error: unknown) => {
        logDecision(`status failed host=${host} error=${error instanceof Error ? error.message : String(error)}`);
      });
    });

    const unsubFilled = api.on('password:filled', () => {
      pushToast({
        key: 'password-filled',
        message: LL.password.filled(),
        type: 'success',
      });
    });

    // 捕获到但"同账号+同密码已保存过"：按 Chrome 语义不弹保存提示，但完全不反馈
    // 会让用户以为捕获坏了（2026-11-10 真机反复试登录）。这里给一条自动消失的
    // 轻提示，把"已经保存过哪个账号"说清楚。
    const unsubSaved = api.on('password:already-saved', (payload) => {
      logDecision(`already-saved notice host=${payload.host}`);
      pushToast({
        key: `password-already-saved:${payload.host}`,
        message: LL.password.alreadySaved({ username: payload.username || '—' }),
        type: 'info',
        duration: 2500,
      });
    });

    return () => {
      if (unsubCapture) unsubCapture();
      if (unsubFilled) unsubFilled();
      if (unsubSaved) unsubSaved();
    };
  }, [setStoreStatus, setActivePanel, pushToast, LL]);
}
