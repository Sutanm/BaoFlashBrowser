import React, { useEffect, useState } from 'react';
import { useI18nContext } from '../../i18n/i18n-react';
import type { ViewGuardMode } from '@shared/types/passwords';

/**
 * PasswordViewGateModal.tsx — 查看明文前的验证/设置模态（规格 §4/G12）。
 *
 * 三种形态：
 * - `os-win`：只显示"请在系统对话框中验证…"——真正的对话框由主进程弹出，
 *   渲染层拿不到也看不到凭据（这正是选 CredUI 的理由）。
 * - `password` + `setup=false`：输入查看密码。
 * - `password` + `setup=true`：设置查看密码（二次确认 + 后果警告）。
 *
 * 计数与锁定由主进程裁决，这里只负责展示剩余次数与倒计时。
 */
export interface PasswordViewGateModalProps {
  mode: ViewGuardMode;
  /** true = 首次设置查看密码。 */
  setup: boolean;
  /**
   * true = 这次设置是被"系统验证降级"逼出来的（常见于未设置 Windows 登录密码的电脑）。
   * 只影响说明文案：用户需要知道为什么突然要用自定义密码。
   */
  degraded?: boolean;
  busy: boolean;
  errorText?: string;
  remainingAttempts?: number;
  /** 锁定剩余毫秒；> 0 时禁止提交。 */
  lockedForMs: number;
  onSubmit: (secret: string) => void;
  onCancel: () => void;
}

/** 查看密码长度下限，与主进程 `VIEW_PASSWORD_MIN` 保持一致。 */
export const VIEW_PASSWORD_MIN_UI = 6;

export function formatLockRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

const PasswordViewGateModal: React.FC<PasswordViewGateModalProps> = ({
  mode, setup, degraded, busy, errorText, remainingAttempts, lockedForMs, onSubmit, onCancel,
}) => {
  const { LL } = useI18nContext();
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [localError, setLocalError] = useState<string | undefined>();

  const locked = lockedForMs > 0;
  const isOsMode = mode === 'os-win' || mode === 'os-mac' || mode === 'keyring';

  useEffect(() => {
    setSecret('');
    setConfirm('');
    setLocalError(undefined);
  }, [setup, mode]);

  const submit = () => {
    if (busy || locked || isOsMode) return;
    if (setup) {
      if (secret.length < VIEW_PASSWORD_MIN_UI) { setLocalError(LL.password.viewGateTooShort()); return; }
      if (secret !== confirm) { setLocalError(LL.password.viewGateMismatch()); return; }
    } else if (secret.length === 0) {
      return;
    }
    setLocalError(undefined);
    onSubmit(secret);
  };

  const shownError = localError ?? errorText;
  const title = setup ? LL.password.viewGateSetupTitle() : LL.password.viewGateTitle();

  return (
    <div className="pwd-gate-overlay" role="dialog" aria-label={title}>
      <div className="pwd-gate-card">
        <p className="pwd-gate-title">{title}</p>

        {isOsMode && <p className="pwd-gate-desc">{LL.password.viewGateOsWaiting()}</p>}
        {!isOsMode && setup && (
          <p className="pwd-gate-desc">
            {degraded ? LL.password.viewGateSetupDescDegraded() : LL.password.viewGateSetupDesc()}
          </p>
        )}
        {!isOsMode && !setup && <p className="pwd-gate-desc">{LL.password.viewGateAskDesc()}</p>}

        {!isOsMode && (
          <>
            <input
              className="pwd-gate-input"
              type="password"
              autoFocus
              aria-label={LL.password.viewGatePasswordLabel()}
              placeholder={LL.password.viewGatePasswordLabel()}
              value={secret}
              disabled={busy || locked}
              onChange={(event) => setSecret(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
            />
            {setup && (
              <input
                className="pwd-gate-input"
                type="password"
                aria-label={LL.password.viewGateConfirmLabel()}
                placeholder={LL.password.viewGateConfirmLabel()}
                value={confirm}
                disabled={busy || locked}
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
              />
            )}
            {setup && <p className="pwd-gate-warn">{LL.password.viewGateSetupWarning()}</p>}
          </>
        )}

        {shownError && <p className="pwd-gate-error">{shownError}</p>}
        {/* 锁定文案与"还剩几次"互斥显示：锁定期间谈剩余次数没有意义。
            但错误提示**不**顶掉剩余次数——用户需要知道还有几次机会（避免突然被锁）。 */}
        {locked ? (
          <p className="pwd-gate-error">
            {LL.password.viewGateLocked({ time: formatLockRemaining(lockedForMs) })}
          </p>
        ) : (
          remainingAttempts !== undefined && remainingAttempts > 0 && (
            <p className="pwd-gate-hint">{LL.password.viewGateRemaining({ count: remainingAttempts })}</p>
          )
        )}

        <div className="pwd-gate-actions">
          <button className="btn-secondary pwd-btn-action" onClick={onCancel}>
            {LL.cancel()}
          </button>
          {!isOsMode && (
            <button
              className="btn-secondary pwd-btn-action"
              disabled={busy || locked}
              onClick={submit}
            >
              {busy ? '…' : (setup ? LL.password.viewGateSaveAndView() : LL.password.viewGateSubmit())}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PasswordViewGateModal;
