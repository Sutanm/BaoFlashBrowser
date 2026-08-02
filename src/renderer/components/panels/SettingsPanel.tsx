import React, { useState, useCallback, useEffect } from 'react';
import { useDataStore, defaultSettings } from '@renderer/store/useDataStore';
import { useTheme } from '@renderer/hooks/useTheme';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { Settings } from '@shared/types/settings';
import type { DownloadEngine } from '@shared/types/downloads';

interface SettingsPanelProps {
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

interface MainConfigForm {
  flashVersion: string;
  lowEndMode: boolean;
  downloadEngine: DownloadEngine;
}

const DEFAULT_MAIN_CONFIG: MainConfigForm = {
  flashVersion: '34.0.0.330',
  lowEndMode: false,
  downloadEngine: 'aria2',
};

const SettingsPanel: React.FC<SettingsPanelProps> = ({ zoomPercent, onZoomIn, onZoomOut, onZoomReset, onOpenUrl }) => {
  const settings = useDataStore((s) => s.settings);
  const setSettings = useDataStore((s) => s.setSettings);
  const setStoreStatus = useDataStore((s) => s.setPasswordStoreStatus);
  const pushToast = useDataStore((s) => s.pushToast);
  const { themeMode, setThemeMode } = useTheme();
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

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg) setMainForm({ flashVersion: cfg.flashVersion, lowEndMode: cfg.lowEndMode, downloadEngine: cfg.downloadEngine });
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
    });

    const needsRestart =
      mainForm.flashVersion !== DEFAULT_MAIN_CONFIG.flashVersion ||
      mainForm.lowEndMode !== DEFAULT_MAIN_CONFIG.lowEndMode;

    if (needsRestart) {
      setSaved('restart');
      pushToast({ message: LL.settings.savedRestart(), type: 'warning' });
    } else {
      setSaved(true);
      pushToast({ message: LL.settings.saved(), type: 'success' });
    }
  }, [form, mainForm, setSettings, pushToast, LL]);

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

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel-card">
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

      <div className="panel-card">
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

      <div className="panel-card">
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

      <div className="panel-card">
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

      <div className="panel-card">
        <div className="panel-card-title">{LL.sidebar.passwords()}</div>
        <label className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.password.autoCapture()}</span>
            <span className="field-hint">{LL.password.autoCaptureHint()}</span>
          </span>
          <input
            type="checkbox"
            checked={autoCapture}
            onChange={(event) => handleAutoCaptureChange(event.target.checked)}
          />
        </label>
        <label className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}>
          <span>
            <span className="field-label" style={{ display: 'block' }}>{LL.password.autoFill()}</span>
            <span className="field-hint">{LL.password.autoFillHint()}</span>
            {passwordStoreInitialized && autoFill && !autoFillReady && (
              <span className="field-hint" style={{ display: 'block', color: '#e67e22', marginTop: 3 }}>
                {LL.password.autoFillNeedsUnlock()}
              </span>
            )}
          </span>
          <input
            type="checkbox"
            checked={autoFill}
            onChange={(event) => handleAutoFillChange(event.target.checked)}
          />
        </label>
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

      <div className="panel-card">
        <div className="panel-card-title">{LL.settings.appearance()}</div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>{LL.settings.zoom()}</span>
          <div className="zoom-controls">
            <button onClick={onZoomOut} className="zoom-btn" title={LL.addressbar.zoomOut()}>−</button>
            <span className="zoom-label">{zoomPercent}%</span>
            <button onClick={onZoomIn} className="zoom-btn" title={LL.addressbar.zoomIn()}>+</button>
            <button onClick={onZoomReset} className="zoom-reset" title={LL.addressbar.zoomReset()}>{LL.reset()}</button>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">{LL.settings.theme()}</div>
        <div className="field">
          <div className="field-label">{LL.settings.themeMode()}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            {(['light', 'dark', 'system'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setThemeMode(mode)}
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: `1px solid ${themeMode === mode ? 'var(--accent)' : 'var(--border)'}`,
                  background: themeMode === mode ? 'var(--accent)' : 'var(--bg-input)',
                  color: themeMode === mode ? '#fff' : 'var(--text-primary)',
                  fontSize: 13,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                }}
              >
                {mode === 'light' ? LL.settings.light() : mode === 'dark' ? LL.settings.dark() : LL.settings.system()}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel-card">
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

      <button
        onClick={handleSave}
        style={{
          width: '100%', padding: 10, borderRadius: 10, border: 'none',
          background: saved ? (saved === 'restart' ? '#f39c12' : '#27ae60') : 'var(--accent)',
          color: '#fff',
          fontSize: 13, fontWeight: 500, cursor: 'pointer',
          transition: 'background 0.3s',
        }}
      >
        {saved === 'restart' ? LL.settings.savedRestartBtn() : saved ? LL.settings.savedBtn() : LL.settings.saveBtn()}
      </button>
    </div>
  );
};

export default SettingsPanel;
