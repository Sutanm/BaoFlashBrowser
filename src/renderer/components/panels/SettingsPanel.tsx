import React from 'react';
import { ArrowLeft, Cpu, Download, Gauge, Globe2, Shield, Wrench } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import ProxySettingsCard from './ProxySettingsCard';
import { useSettingsPanel } from './settings/useSettingsPanel';
import { SettingsMenu, type SettingsSectionEntry } from './settings/SettingsMenu';
import { SettingsGeneralSection } from './settings/SettingsGeneralSection';
import { SettingsEngineSection } from './settings/SettingsEngineSection';
import { SettingsDownloadsSection } from './settings/SettingsDownloadsSection';
import { SettingsPrivacySection } from './settings/SettingsPrivacySection';
import { SettingsAdvancedSection } from './settings/SettingsAdvancedSection';
import { SettingsAutomationSection } from './settings/SettingsAutomationSection';
import type { SettingsPanelProps, SettingsSection } from './settings/settings-panel-types';

const SettingsPanel: React.FC<SettingsPanelProps> = ({ onOpenUrl }) => {
  const { LL } = useI18nContext();
  const state = useSettingsPanel({ onOpenUrl });
  const { activeSection, setActiveSection, mainForm, handleMainChange, handleSave, saved } = state;

  const sections: SettingsSectionEntry[] = [
    { id: 'general', title: LL.settings.general(), description: `${LL.settings.homepage()} · ${LL.settings.searchEngine()}`, icon: Globe2 },
    { id: 'network', title: LL.settings.proxy.title(), description: LL.settings.proxy.description(), icon: Globe2 },
    { id: 'engine', title: `${LL.ruffle.flash()} / Ruffle`, description: `${LL.settings.spoofVersion()} · ${LL.settings.defaultEngine()}`, icon: Gauge },
    {
      id: 'downloads',
      title: MODULE_DOWNLOAD ? LL.settings.filesTitle() : LL.settings.screenshot.dir(),
      description: MODULE_DOWNLOAD ? LL.settings.filesDescription() : LL.settings.screenshot.selectDir(),
      icon: Download,
    },
    ...(MODULE_PASSWORDS ? [{ id: 'privacy' as const, title: LL.sidebar.passwords(), description: `${LL.password.autoCapture()} · ${LL.password.autoFill()}`, icon: Shield }] : []),
    ...(MODULE_AUTOMATION ? [{ id: 'automation' as const, title: LL.settings.automation(), description: `${LL.settings.automationVisionWarmStart()} · ${LL.settings.automationOcrWarmStart()}`, icon: Cpu }] : []),
    {
      id: 'advanced',
      title: LL.settings.advanced(),
      description: MODULE_USERSCRIPTS ? `${LL.settings.userscriptCapacity.title()} · ${LL.settings.cacheTitle()}` : LL.settings.cacheTitle(),
      icon: Wrench,
    },
  ];

  if (!activeSection) {
    return (
      <SettingsMenu
        categoryLabel={LL.settings.categories()}
        sections={sections}
        onSelect={(id: SettingsSection) => setActiveSection(id)}
      />
    );
  }

  const activeSectionTitle = sections.find((section) => section.id === activeSection)?.title || LL.settings.title();

  return (
    <div className="settings-panel settings-detail-panel">
      <div className="settings-page-head">
        <button type="button" className="btn-icon btn-icon-compact" onClick={() => setActiveSection(null)} title={LL.back()}>
          <ArrowLeft className="w-4 h-4" />
        </button>
        <strong>{activeSectionTitle}</strong>
      </div>
      <div className="settings-grid">
        {activeSection === 'general' && <SettingsGeneralSection {...state} />}
        {activeSection === 'network' && (
          <ProxySettingsCard value={mainForm.proxy} onChange={(proxy) => handleMainChange('proxy', proxy)} />
        )}
        {activeSection === 'engine' && <SettingsEngineSection {...state} />}
        {activeSection === 'advanced' && <SettingsAdvancedSection {...state} />}
        {activeSection === 'downloads' && <SettingsDownloadsSection {...state} />}
        {activeSection === 'privacy' && MODULE_PASSWORDS && <SettingsPrivacySection {...state} />}
        {activeSection === 'automation' && MODULE_AUTOMATION && <SettingsAutomationSection {...state} />}
      </div>

      <button
        onClick={handleSave}
        className={`settings-save-button${saved === 'restart' ? ' restart' : saved ? ' saved' : ''}`}
      >
        {saved === 'restart' ? LL.settings.savedRestartBtn() : saved ? LL.settings.savedBtn() : LL.settings.saveBtn()}
      </button>
    </div>
  );
};

export default SettingsPanel;
