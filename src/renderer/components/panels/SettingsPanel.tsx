import React, { useState, useCallback, useEffect } from 'react';
import { useDataStore, defaultSettings } from '@renderer/store/useDataStore';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { Settings } from '@shared/types/settings';
import type { DownloadEngine } from '@shared/types/downloads';
import { ArrowLeft, ChevronRight, Download, Gauge, Globe2, Shield, Wrench } from 'lucide-react';

interface SettingsPanelProps {
  onOpenUrl: (url: string, newTab: boolean) => void;
}

type SettingsSection = 'general' | 'engine' | 'downloads' | 'privacy' | 'advanced';

interface MainConfigForm {
  flashVersion: string;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
  screenshotDir: string;
  userscriptMaxResponseMB: number;
  userscriptTimeoutSeconds: number;
  userscriptMaxConcurrentPerScript: number;
  userscriptMaxConcurrentGlobal: number;
  userscriptDownloadMaxMB: number;
  userscriptDownloadConcurrent: number;
  userscriptMaxValueKB: number;
}

const DEFAULT_MAIN_CONFIG: MainConfigForm = {
  flashVersion: '34.0.0.330',
  lowEndMode: false,
  downloadEngine: 'aria2',
  screenshotDir: '',
  userscriptMaxResponseMB: 2,
  userscriptTimeoutSeconds: 15,
  userscriptMaxConcurrentPerScript: 4,
  userscriptMaxConcurrentGlobal: 16,
  userscriptDownloadMaxMB: 8,
  userscriptDownloadConcurrent: 4,
  userscriptMaxValueKB: 16,
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ onOpenUrl }) => {
  const settings = useDataStore((s) => s.settings);
  const setSettings = useDataStore((s) => s.setSettings);
  const setStoreStatus = useDataStore((s) => s.setPasswordStoreStatus);
  const pushToast = useDataStore((s) => s.pushToast);
  const { LL, setLocale } = useI18nContext();

  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });
  const [mainForm, setMainForm] = useState<MainConfigForm>({ ...DEFAULT_MAIN_CONFIG });
  const [saved, setSaved] = useState<boolean | 'restart'>(false);
  const [resetConfirming, setResetConfirming] = useState(false);
  const [autoCapture, setAutoCapture] = useState(true);
  const [autoFill, setAutoFill] = useState(true);
  const [autoFillReady, setAutoFillReady] = useState(false);
  const [passwordStoreInitialized, setPasswordStoreInitialized] = useState(false);
  const [excludedSitesText, setExcludedSitesText] = useState('');
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false);
  const [activeSection, setActiveSection] = useState<SettingsSection | null>(null);

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg) setMainForm({
        flashVersion: cfg.flashVersion,
        lowEndMode: cfg.lowEndMode,
        downloadEngine: cfg.downloadEngine,
        screenshotDir: cfg.screenshotDir ?? '',
        userscriptMaxResponseMB: cfg.userscriptMaxResponseMB,
        userscriptTimeoutSeconds: cfg.userscriptTimeoutSeconds,
        userscriptMaxConcurrentPerScript: cfg.userscriptMaxConcurrentPerScript,
        userscriptMaxConcurrentGlobal: cfg.userscriptMaxConcurrentGlobal,
        userscriptDownloadMaxMB: cfg.userscriptDownloadMaxMB,
        userscriptDownloadConcurrent: cfg.userscriptDownloadConcurrent,
        userscriptMaxValueKB: cfg.userscriptMaxValueKB,
      });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.electronAPI?.pwd?.status().then((status) => {
      setAutoCapture(status.autoCapture);
      setAutoFill(status.autoFill);
      setAutoFillReady(status.autoFillReady);
      setPasswordStoreInitialized(status.initialized);
      setExcludedSitesText(status.excludedSites.join('\n'));
    }).catch(() => {});
  }, []);

  const handleAutoCaptureChange = useCallback(async (enabled: boolean) => {
    setAutoCapture(enabled);
    try {
      const result = await window.electronAPI.pwd.setAutoCapture(enabled);
      setAutoCapture(result.enabled);
    } catch {
      setAutoCapture(!enabled);
    }
  }, []);

  const handleAutoFillChange = useCallback(async (enabled: boolean) => {
    setAutoFill(enabled);
    try {
      const result = await window.electronAPI.pwd.setAutoFill(enabled);
      setAutoFill(result.enabled);
      setAutoFillReady(result.ready);
    } catch {
      setAutoFill(!enabled);
    }
  }, []);

  const handleExcludedSitesSave = useCallback(async () => {
    const sites = excludedSitesText.split(/[\s,;]+/).map((site) => site.trim()).filter(Boolean);
    try {
      const result = await window.electronAPI.pwd.setExcludedSites(sites);
      setExcludedSitesText(result.excludedSites.join('\n'));
      pushToast({ message: LL.password.excludedSitesSaved(), type: 'success' });
    } catch {
      pushToast({ message: LL.password.excludedSitesSaveFailed(), type: 'error' });
    }
  }, [excludedSitesText, pushToast, LL]);

  // Eagerly sync locale when language dropdown changes (before save)
  useEffect(() => {
    if (form.language) setLocale(form.language);
  }, [form.language, setLocale]);

  const handleChange = useCallback(<K extends keyof Settings>(key: K, value: Settings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleMainChange = useCallback(<K extends keyof MainConfigForm>(key: K, value: MainConfigForm[K]) => {
    setMainForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleSave = useCallback(async () => {
    setSettings(form);
    await window.electronAPI?.invoke('save-config', {
      flashVersion: mainForm.flashVersion,
      lowEndMode: mainForm.lowEndMode,
      downloadEngine: mainForm.downloadEngine,
      screenshotDir: mainForm.screenshotDir,
      userscriptMaxResponseMB: mainForm.userscriptMaxResponseMB,
      userscriptTimeoutSeconds: mainForm.userscriptTimeoutSeconds,
      userscriptMaxConcurrentPerScript: mainForm.userscriptMaxConcurrentPerScript,
      userscriptMaxConcurrentGlobal: mainForm.userscriptMaxConcurrentGlobal,
      userscriptDownloadMaxMB: mainForm.userscriptDownloadMaxMB,
      userscriptDownloadConcurrent: mainForm.userscriptDownloadConcurrent,
      userscriptMaxValueKB: mainForm.userscriptMaxValueKB,
    });

    const needsRestart =
      mainForm.flashVersion !== DEFAULT_MAIN_CONFIG.flashVersion ||
      mainForm.lowEndMode !== DEFAULT_MAIN_CONFIG.lowEndMode ||
      mainForm.userscriptMaxValueKB !== DEFAULT_MAIN_CONFIG.userscriptMaxValueKB;

    if (needsRestart) {
      setSaved('restart');
      pushToast({ message: LL.settings.savedRestart(), type: 'warning' });
    } else {
      setSaved(true);
      pushToast({ message: LL.settings.saved(), type: 'success' });
    }
  }, [form, mainForm, setSettings, pushToast, LL]);

  const handleSelectScreenshotDir = useCallback(async () => {
    try {
      const result = await window.electronAPI.screenshot.setDir(LL.settings.screenshot.dialogTitle());
      if (result.canceled) return;
      if (result.success && result.dir) {
        setMainForm((prev) => ({ ...prev, screenshotDir: result.dir as string }));
        pushToast({ message: LL.settings.screenshot.dirChanged(), type: 'success' });
      } else {
        const msg = result.code === 'DIR_NOT_WRITABLE'
          ? LL.settings.screenshot.dirNotWritable()
          : result.code === 'DIR_DENIED'
            ? LL.settings.screenshot.dirDenied()
            : LL.settings.screenshot.dirSelectFailed();
        pushToast({ message: msg, type: 'error' });
      }
    } catch {
      pushToast({ message: LL.settings.screenshot.dirSelectFailed(), type: 'error' });
    }
  }, [setMainForm, pushToast, LL]);

  const handleResetPassword = useCallback(async () => {
    if (!resetConfirming) { setResetConfirming(true); return; }
    setResetConfirming(false);
    await window.electronAPI?.pwd?.resetAll();
    const status = await window.electronAPI.pwd.status();
    setStoreStatus(status);
    setAutoCapture(status.autoCapture);
    setAutoFill(status.autoFill);
    setAutoFillReady(status.autoFillReady);
    setPasswordStoreInitialized(status.initialized);
    setExcludedSitesText(status.excludedSites.join('\n'));
    pushToast({ message: LL.password.resetDone(), type: 'info' });
  }, [resetConfirming, setStoreStatus, pushToast, LL]);

  const handleExportDiagnostics = useCallback(async () => {
    setExportingDiagnostics(true);
    try {
      const result = await window.electronAPI.diagnostics.export();
      if (result.saved) pushToast({ message: LL.settings.diagnosticsSaved(), type: 'success' });
    } catch {
      pushToast({ message: LL.settings.diagnosticsFailed(), type: 'error' });
    } finally {
      setExportingDiagnostics(false);
    }
  }, [pushToast, LL]);

  const handleOpenSwf = useCallback(async () => {
    const url = await window.electronAPI.file.openSwf();
    if (url) onOpenUrl(url, true);
  }, [onOpenUrl]);

  const sections: Array<{
    id: SettingsSection;
    title: string;
    description: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: 'general', title: LL.settings.general(), description: `${LL.settings.homepage()} · ${LL.settings.searchEngine()}`, icon: Globe2 },
    { id: 'engine', title: `${LL.ruffle.flash()} / Ruffle`, description: `${LL.settings.spoofVersion()} · ${LL.settings.defaultEngine()}`, icon: Gauge },
    { id: 'downloads', title: `${LL.settings.download()} / ${LL.settings.screenshot.dir()}`, description: `${LL.settings.downloadEngine()} · ${LL.settings.screenshot.selectDir()}`, icon: Download },
    { id: 'privacy', title: LL.sidebar.passwords(), description: `${LL.password.autoCapture()} · ${LL.password.autoFill()}`, icon: Shield },
    { id: 'advanced', title: LL.settings.diagnostics(), description: `${LL.settings.userscriptCapacity.title()} · ${LL.settings.openLocalSwf()}`, icon: Wrench },
  ];

  if (!activeSection) {
    return (
      <div className="settings-panel settings-menu-panel">
        <div className="settings-category-label">{LL.settings.categories()}</div>
        <div className="settings-category-list">
          {sections.map(({ id, title, description, icon: Icon }) => (
            <button key={id} type="button" className="settings-category-row" onClick={() => setActiveSection(id)}>
              <span className="settings-category-icon"><Icon className="w-4 h-4" /></span>
              <span className="settings-category-copy"><strong>{title}</strong><small>{description}</small></span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ))}
        </div>
      </div>
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
      <div className={`panel-card settings-section-card${activeSection !== 'general' ? ' settings-section-hidden' : ''}`}>
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
          <button
            type="button"
            role="switch"
            aria-checked={form.restoreSession}
            className={`toggle-switch ${form.restoreSession ? 'on' : ''}`}
            onClick={() => handleChange('restoreSession', !form.restoreSession)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.settings.suspendInactiveTabs()}</span>
            <span className="field-hint">{LL.settings.suspendInactiveTabsHint()}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={form.suspendInactiveTabs}
            className={`toggle-switch ${form.suspendInactiveTabs ? 'on' : ''}`}
            onClick={() => handleChange('suspendInactiveTabs', !form.suspendInactiveTabs)}
          >
            <span className="toggle-knob" />
          </button>
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

      <div className={`panel-card settings-section-card${activeSection !== 'engine' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.ruffle.flash()}</div>
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
          <button
            type="button"
            role="switch"
            aria-checked={mainForm.lowEndMode}
            className={`toggle-switch ${mainForm.lowEndMode ? 'on' : ''}`}
            onClick={() => handleMainChange('lowEndMode', !mainForm.lowEndMode)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="field-hint">{LL.settings.lowEndModeHint()}</div>
      </div>

      <div className={`panel-card settings-section-card${activeSection !== 'advanced' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.settings.userscriptCapacity.title()}</div>
        <div className="field-hint" style={{ marginBottom: 8 }}>{LL.settings.userscriptCapacity.hint()}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 }}>
          {([
            ['userscriptMaxResponseMB', LL.settings.userscriptCapacity.maxResponseMB(), 1, 64],
            ['userscriptTimeoutSeconds', LL.settings.userscriptCapacity.timeoutSeconds(), 1, 120],
            ['userscriptMaxConcurrentPerScript', LL.settings.userscriptCapacity.concurrentPerScript(), 1, 16],
            ['userscriptMaxConcurrentGlobal', LL.settings.userscriptCapacity.concurrentGlobal(), 1, 64],
            ['userscriptDownloadMaxMB', LL.settings.userscriptCapacity.downloadMaxMB(), 1, 64],
            ['userscriptDownloadConcurrent', LL.settings.userscriptCapacity.downloadConcurrent(), 1, 16],
            ['userscriptMaxValueKB', LL.settings.userscriptCapacity.maxValueKB(), 1, 1024],
          ] as Array<[keyof MainConfigForm, string, number, number]>).map(([key, label, min, max]) => (
            <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }}>
              <span style={{ opacity: 0.7 }}>{label}</span>
              <input
                type="number"
                min={min}
                max={max}
                step={1}
                value={String(mainForm[key] as number)}
                onChange={(e) => handleMainChange(key, Number(e.target.value))}
                style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid var(--border)', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className={`panel-card settings-section-card${activeSection !== 'engine' ? ' settings-section-hidden' : ''}`}>
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

      <div className={`panel-card settings-section-card${activeSection !== 'downloads' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.settings.download()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.downloadEngine()}</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={mainForm.downloadEngine}
            onChange={(e) => handleMainChange('downloadEngine', e.target.value as DownloadEngine)}
          >
            <option value="aria2">{LL.settings.aria2()}</option>
            <option value="chromium">{LL.settings.chromium()}</option>
          </select>
        </div>
      </div>

      <div className={`panel-card settings-section-card${activeSection !== 'downloads' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.settings.screenshot.dir()}</div>
        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {mainForm.screenshotDir || LL.settings.screenshot.captureHint()}
            </span>
            <button
              style={{ padding: '6px 12px', borderRadius: 6, border: 'none', background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, cursor: 'pointer', flexShrink: 0 }}
              onClick={handleSelectScreenshotDir}
            >
              {LL.settings.screenshot.selectDir()}
            </button>
          </div>
          <div className="field-hint">{LL.settings.screenshot.captureHint()}</div>
        </div>
      </div>

      <div className={`panel-card settings-section-card${activeSection !== 'privacy' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.sidebar.passwords()}</div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.password.autoCapture()}</span>
            <span className="field-hint">{LL.password.autoCaptureHint()}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoCapture}
            className={`toggle-switch ${autoCapture ? 'on' : ''}`}
            onClick={() => handleAutoCaptureChange(!autoCapture)}
          >
            <span className="toggle-knob" />
          </button>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.password.autoFill()}</span>
            <span className="field-hint">{LL.password.autoFillHint()}</span>
            {passwordStoreInitialized && autoFill && !autoFillReady && (
              <span className="field-hint" style={{ display: 'block', color: '#e67e22', marginTop: 3 }}>
                {LL.password.autoFillNeedsUnlock()}
              </span>
            )}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoFill}
            className={`toggle-switch ${autoFill ? 'on' : ''}`}
            onClick={() => handleAutoFillChange(!autoFill)}
          >
            <span className="toggle-knob" />
          </button>
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

      <div className={`panel-card settings-section-card${activeSection !== 'advanced' ? ' settings-section-hidden' : ''}`}>
        <div className="panel-card-title">{LL.settings.diagnostics()}</div>
        <button
          onClick={handleOpenSwf}
          style={{
            width: '100%', padding: 8, marginBottom: 8, borderRadius: 6, border: 'none',
            background: 'var(--accent)', color: '#fff', fontSize: 13, cursor: 'pointer',
          }}
        >
          {LL.settings.openLocalSwf()}
        </button>
        <div className="field-hint" style={{ marginBottom: 8 }}>{LL.settings.diagnosticsHint()}</div>
        <button
          disabled={exportingDiagnostics}
          onClick={handleExportDiagnostics}
          style={{
            width: '100%', padding: 8, borderRadius: 6, border: 'none',
            background: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13,
            cursor: exportingDiagnostics ? 'wait' : 'pointer', opacity: exportingDiagnostics ? 0.7 : 1,
          }}
        >
          {exportingDiagnostics ? LL.settings.diagnosticsExporting() : LL.settings.diagnosticsExport()}
        </button>
      </div>
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
