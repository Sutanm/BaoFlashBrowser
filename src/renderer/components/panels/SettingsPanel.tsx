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

const SettingsPanel: React.FC<SettingsPanelProps> = ({ zoomPercent, onZoomIn, onZoomOut, onZoomReset }) => {
  const settings = useDataStore((s) => s.settings);
  const setSettings = useDataStore((s) => s.setSettings);
  const setStoreStatus = useDataStore((s) => s.setPasswordStoreStatus);
  const pushToast = useDataStore((s) => s.pushToast);
  const { themeMode, setThemeMode } = useTheme();
  const { LL, setLocale } = useI18nContext() as any;

  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });
  const [mainForm, setMainForm] = useState<MainConfigForm>({ ...DEFAULT_MAIN_CONFIG });
  const [saved, setSaved] = useState<boolean | 'restart'>(false);
  const [resetConfirming, setResetConfirming] = useState(false);

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg) setMainForm({ flashVersion: cfg.flashVersion, lowEndMode: cfg.lowEndMode, downloadEngine: cfg.downloadEngine });
    }).catch(() => {});
  }, []);

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
    setStoreStatus({ initialized: false, unlocked: false, enabled: false });
    pushToast({ message: LL.password.resetDone(), type: 'info' });
  }, [resetConfirming, setStoreStatus, pushToast, LL]);

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
