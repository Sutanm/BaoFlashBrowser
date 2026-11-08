import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import ToggleSwitch from '../../controls/ToggleSwitch';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<
  SettingsPanelState,
  | 'autoCapture'
  | 'handleAutoCaptureChange'
  | 'autoFill'
  | 'handleAutoFillChange'
  | 'autoFillReady'
  | 'passwordTier'
  | 'passwordStoreInitialized'
  | 'passwordKeyStatus'
  | 'passwordKeyReason'
  | 'viewGuard'
  | 'viewPwdOpen'
  | 'setViewPwdOpen'
  | 'viewPwdCurrent'
  | 'setViewPwdCurrent'
  | 'viewPwdNext'
  | 'setViewPwdNext'
  | 'viewPwdConfirm'
  | 'setViewPwdConfirm'
  | 'viewPwdBusy'
  | 'viewPwdError'
  | 'setViewPwdError'
  | 'handleViewPwdSave'
  | 'handleRecheckOsAuth'
  | 'excludedSitesText'
  | 'setExcludedSitesText'
  | 'handleExcludedSitesSave'
  | 'resetConfirming'
  | 'setResetConfirming'
  | 'handleResetPassword'
>;

/** 查看保护区块里的次要按钮（与既有内联按钮风格一致）。 */
const compactButtonStyle: React.CSSProperties = {
  width: '100%', padding: 8, borderRadius: 6, border: 'none',
  background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer',
};

export function SettingsPrivacySection({
  autoCapture,
  handleAutoCaptureChange,
  autoFill,
  handleAutoFillChange,
  autoFillReady,
  passwordTier,
  passwordStoreInitialized,
  passwordKeyStatus,
  passwordKeyReason,
  viewGuard,
  viewPwdOpen,
  setViewPwdOpen,
  viewPwdCurrent,
  setViewPwdCurrent,
  viewPwdNext,
  setViewPwdNext,
  viewPwdConfirm,
  setViewPwdConfirm,
  viewPwdBusy,
  viewPwdError,
  setViewPwdError,
  handleViewPwdSave,
  handleRecheckOsAuth,
  excludedSitesText,
  setExcludedSitesText,
  handleExcludedSitesSave,
  resetConfirming,
  setResetConfirming,
  handleResetPassword,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <div className="panel-card settings-section-card">
      <div className="panel-card-title">{LL.sidebar.passwords()}</div>
      <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span className="field-label" style={{ display: 'block' }}>{LL.password.autoCapture()}</span>
          <span className="field-hint">{LL.password.autoCaptureHint()}</span>
        </span>
        <ToggleSwitch
          checked={autoCapture}
          label={LL.password.autoCapture()}
          onChange={(checked) => void handleAutoCaptureChange(checked)}
        />
      </div>
      <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span className="field-label" style={{ display: 'block' }}>{LL.password.autoFill()}</span>
          <span className="field-hint">{LL.password.autoFillHint()}</span>
          {passwordStoreInitialized && autoFillReady && (
            <span className="field-hint" style={{ display: 'block', marginTop: 3 }}>
              {passwordTier === 'C' ? LL.password.tierC() : LL.password.tierA()}
            </span>
          )}
          {passwordStoreInitialized && passwordKeyStatus !== 'ok' && (
            <span className="field-hint" style={{ display: 'block', marginTop: 3, color: '#b45309' }}>
              {LL.password.keyBlockedTitle()} · {passwordKeyReason ?? 'unknown'}
            </span>
          )}
        </span>
        <ToggleSwitch
          checked={autoFill}
          label={LL.password.autoFill()}
          onChange={(checked) => void handleAutoFillChange(checked)}
        />
      </div>
      <div className="field">
        <div className="field-label">{LL.password.viewProtectionTitle()}</div>
        <div className="field-hint" style={{ marginBottom: 6 }}>
          {viewGuard?.mode === 'os-win'
            ? LL.password.viewProtectionOsWin()
            : viewGuard?.mode === 'password'
              ? (viewGuard.passwordSet
                ? LL.password.viewProtectionPassword()
                : LL.password.viewProtectionPasswordUnset())
              : viewGuard?.reason === 'key-unavailable'
                ? LL.password.viewProtectionNoneKey()
                : LL.password.viewProtectionNoneInit()}
        </div>
        {viewGuard?.reason === 'os-auth-unavailable' && (
          <div className="field-hint" style={{ marginBottom: 6, color: '#b45309' }}>
            {LL.password.viewProtectionDegraded()}
          </div>
        )}

        {viewGuard?.mode === 'password' && !viewPwdOpen && (
          <button
            style={compactButtonStyle}
            onClick={() => { setViewPwdOpen(true); setViewPwdError(null); }}
          >
            {viewGuard.passwordSet ? LL.password.viewProtectionChangeBtn() : LL.password.viewProtectionSetBtn()}
          </button>
        )}

        {viewGuard?.reason === 'os-auth-unavailable' && (
          <button style={{ ...compactButtonStyle, marginTop: 6 }} onClick={() => void handleRecheckOsAuth()}>
            {LL.password.viewProtectionRecheck()}
          </button>
        )}

        {viewGuard?.mode === 'password' && viewPwdOpen && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {viewGuard.passwordSet && (
              <input
                className="pwd-gate-input"
                type="password"
                aria-label={LL.password.viewGateCurrentLabel()}
                placeholder={LL.password.viewGateCurrentLabel()}
                value={viewPwdCurrent}
                onChange={(event) => setViewPwdCurrent(event.target.value)}
              />
            )}
            <input
              className="pwd-gate-input"
              type="password"
              aria-label={LL.password.viewGatePasswordLabel()}
              placeholder={LL.password.viewGatePasswordLabel()}
              value={viewPwdNext}
              onChange={(event) => setViewPwdNext(event.target.value)}
            />
            <input
              className="pwd-gate-input"
              type="password"
              aria-label={LL.password.viewGateConfirmLabel()}
              placeholder={LL.password.viewGateConfirmLabel()}
              value={viewPwdConfirm}
              onChange={(event) => setViewPwdConfirm(event.target.value)}
            />
            <div className="field-hint">{LL.password.viewGateSetupWarning()}</div>
            {viewPwdError && <div className="field-hint" style={{ color: '#e74c3c' }}>{viewPwdError}</div>}
            <div style={{ display: 'flex', gap: 6 }}>
              <button style={compactButtonStyle} disabled={viewPwdBusy} onClick={() => void handleViewPwdSave()}>
                {LL.save()}
              </button>
              <button
                style={compactButtonStyle}
                onClick={() => { setViewPwdOpen(false); setViewPwdError(null); }}
              >
                {LL.cancel()}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="field">
        <div className="field-label">{LL.password.excludedSites()}</div>
        <div className="field-hint" style={{ marginBottom: 6 }}>{LL.password.excludedSitesHint()}</div>
        <textarea
          className="input-text"
          style={{ width: '100%', minHeight: 72, resize: 'vertical' }}
          value={excludedSitesText}
          onChange={(event) => setExcludedSitesText(event.target.value)}
          placeholder="example.com"
        />
        <button
          style={{
            width: '100%', marginTop: 6, padding: 8, borderRadius: 6, border: 'none',
            background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer',
          }}
          onClick={handleExcludedSitesSave}
        >
          {LL.password.saveExcludedSites()}
        </button>
      </div>
      <div className="field-hint" style={{ marginBottom: 8 }}>{LL.password.resetDesc()}</div>
      <button
        onClick={handleResetPassword}
        style={{
          width: '100%', padding: 8, borderRadius: 6, border: 'none',
          background: resetConfirming ? '#e74c3c' : 'var(--bg-hover)',
          color: resetConfirming ? '#fff' : '#e74c3c',
          fontSize: 13, cursor: 'pointer',
        }}
        onBlur={() => setResetConfirming(false)}
      >
        {resetConfirming ? LL.password.resetConfirm() : LL.password.resetBtn()}
      </button>
    </div>
  );
}
