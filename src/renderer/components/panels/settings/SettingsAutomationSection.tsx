import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import ToggleSwitch from '../../controls/ToggleSwitch';
import type { SettingsPanelState } from './useSettingsPanel';

type Props = Pick<SettingsPanelState, 'mainForm' | 'handleMainChange'>;

export function SettingsAutomationSection({ mainForm, handleMainChange }: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <div className="panel-card settings-section-card">
      <div className="panel-card-title">{LL.settings.automation()}</div>
      <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span className="field-label" style={{ display: 'block' }}>{LL.settings.automationVisionWarmStart()}</span>
          <span className="field-hint">{LL.settings.automationVisionWarmStartHint()}</span>
        </span>
        <ToggleSwitch
          checked={mainForm.automationVisionWarmStart}
          label={LL.settings.automationVisionWarmStart()}
          onChange={(checked) => handleMainChange('automationVisionWarmStart', checked)}
        />
      </div>
      <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>
          <span className="field-label" style={{ display: 'block' }}>{LL.settings.automationOcrWarmStart()}</span>
          <span className="field-hint">{LL.settings.automationOcrWarmStartHint()}</span>
        </span>
        <ToggleSwitch
          checked={mainForm.automationOcrWarmStart}
          label={LL.settings.automationOcrWarmStart()}
          onChange={(checked) => handleMainChange('automationOcrWarmStart', checked)}
        />
      </div>
    </div>
  );
}
