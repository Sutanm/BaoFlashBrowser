import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { Settings } from '@shared/types/settings';
import type { FlashPluginChannel } from '@shared/types/flash';
import ToggleSwitch from '../../controls/ToggleSwitch';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<SettingsPanelState, 'form' | 'handleChange' | 'mainForm' | 'handleMainChange'>;

export function SettingsEngineSection({
  form,
  handleChange,
  mainForm,
  handleMainChange,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <>
      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.ruffle.flash()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.flashPluginChannel()}</div>
          <select
            className="input-text"
            style={{ width: '100%' }}
            value={mainForm.flashPluginChannel}
            onChange={(e) => handleMainChange('flashPluginChannel', e.target.value as FlashPluginChannel)}
          >
            <option value="stable">{LL.settings.flashPluginStable()}</option>
            <option value="experimental">{LL.settings.flashPluginExperimental()}</option>
          </select>
          <div className="field-hint">
            {mainForm.flashPluginChannel === 'experimental'
              ? LL.settings.flashPluginExperimentalWarning()
              : LL.settings.flashPluginStableHint()}
          </div>
        </div>
        <div className="field">
          <div className="field-label">{LL.settings.spoofVersion()}</div>
          <input
            className="input-text"
            style={{ width: '100%' }}
            type="text"
            value={mainForm.flashVersion}
            onChange={(e) => handleMainChange('flashVersion', e.target.value)}
            placeholder="34.0.0.330"
            pattern="^\\d+\\.\\d+\\.\\d+\\.\\d+$"
          />
          <div className="field-hint">{LL.settings.spoofVersionHint()}</div>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{LL.settings.lowEndMode()}</span>
          <ToggleSwitch
            checked={mainForm.lowEndMode}
            label={LL.settings.lowEndMode()}
            onChange={(checked) => handleMainChange('lowEndMode', checked)}
          />
        </div>
        <div className="field-hint">{LL.settings.lowEndModeHint()}</div>
      </div>

      <div className="panel-card settings-section-card">
        <div className="panel-card-title">{LL.settings.ruffle()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.defaultEngine()}</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={form.flashEngineMode}
            onChange={(e) => handleChange('flashEngineMode', e.target.value as Settings['flashEngineMode'])}
          >
            <option value="auto">PPAPI ({LL.ruffle.flash()})</option>
            <option value="prefer-ruffle">{LL.settings.preferRuffle()}</option>
            <option value="ppapi-only">{LL.settings.ppapiOnly()}</option>
          </select>
        </div>
        <div className="field">
          <div className="field-label">{LL.settings.ruffleSource()}</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={form.ruffleSource}
            onChange={(e) => handleChange('ruffleSource', e.target.value as Settings['ruffleSource'])}
          >
            <option value="bundled">{LL.settings.bundled()}</option>
            <option value="cdn">{LL.settings.cdn()}</option>
          </select>
        </div>
        <div className="field-hint">{LL.settings.ruffleHint()}</div>
      </div>
    </>
  );
}
