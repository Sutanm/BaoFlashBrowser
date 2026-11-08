import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { Settings } from '@shared/types/settings';
import ToggleSwitch from '../../controls/ToggleSwitch';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<
  SettingsPanelState,
  | 'form'
  | 'handleChange'
  | 'mainForm'
  | 'handleMainChange'
  | 'appVersion'
  | 'checkingUpdate'
  | 'updateResult'
  | 'setUpdateResult'
  | 'handleCheckUpdate'
>;

export function SettingsGeneralSection({
  form,
  handleChange,
  mainForm,
  handleMainChange,
  appVersion,
  checkingUpdate,
  updateResult,
  setUpdateResult,
  handleCheckUpdate,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <>
      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.settings.general()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.homepage()}</div>
          <input
            className="input-text"
            style={{ width: '100%' }}
            type="text"
            value={form.homepage}
            onChange={(e) => handleChange('homepage', e.target.value)}
            placeholder="about:newtab"
          />
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.settings.restoreSession()}</span>
            <span className="field-hint">{LL.settings.restoreSessionHint()}</span>
          </span>
          <ToggleSwitch
            checked={form.restoreSession}
            label={LL.settings.restoreSession()}
            onChange={(checked) => handleChange('restoreSession', checked)}
          />
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.settings.suspendInactiveTabs()}</span>
            <span className="field-hint">{LL.settings.suspendInactiveTabsHint()}</span>
          </span>
          <ToggleSwitch
            checked={form.suspendInactiveTabs}
            label={LL.settings.suspendInactiveTabs()}
            onChange={(checked) => handleChange('suspendInactiveTabs', checked)}
          />
        </div>
        <div className="field">
          <div className="field-label">{LL.settings.searchEngine()}</div>
          <select className="input-text" style={{ width: '100%' }} value={form.searchEngine} onChange={(e) => handleChange('searchEngine', e.target.value as Settings['searchEngine'])}>
            <option value="baidu">{LL.settings.baidu()}</option>
            <option value="bing">Bing</option>
            <option value="google">Google</option>
          </select>
        </div>
        <div className="field">
          <div className="field-label">{LL.settings.language()}</div>
          <select className="input-text" style={{ width: '100%' }} value={form.language} onChange={(e) => handleChange('language', e.target.value as Settings['language'])}>
            <option value="zh-CN">简体中文</option>
            <option value="en">English</option>
          </select>
        </div>
      </div>

      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.settings.updateTitle()}</div>
        <div className="field-hint">{LL.settings.updateCurrent({ version: appVersion || '…' })}</div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.settings.updateAutoCheck()}</span>
          </span>
          <ToggleSwitch
            checked={mainForm.updateCheckMode === 'auto'}
            label={LL.settings.updateAutoCheck()}
            onChange={(checked) => handleMainChange('updateCheckMode', checked ? 'auto' : 'manual')}
          />
        </div>
        <button type="button" className="btn-secondary" disabled={checkingUpdate} onClick={() => void handleCheckUpdate()}>
          {checkingUpdate ? LL.settings.updateChecking() : LL.settings.updateCheck()}
        </button>
        <div role="status" aria-live="polite">
          {updateResult?.status === 'current' && LL.settings.updateLatest()}
          {updateResult?.status === 'error' && LL.settings.updateFailed()}
          {updateResult?.status === 'available' && <>
            <p>{LL.settings.updateAvailable({ version: updateResult.latestVersion ?? '' })}</p>
            <button type="button" className="btn-secondary" onClick={() => {
              void window.electronAPI.invoke('app:open-release').catch(() => {
                setUpdateResult({ status: 'error', currentVersion: appVersion });
              });
            }}>{LL.settings.updateDownload()}</button>
          </>}
        </div>
      </div>
    </>
  );
}
