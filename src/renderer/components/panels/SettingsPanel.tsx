import React, { useState, useCallback, useEffect } from 'react';
import { useDataStore, defaultSettings } from '@renderer/store/useDataStore';
import { useTheme } from '@renderer/hooks/useTheme';
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

  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });
  const [mainForm, setMainForm] = useState<MainConfigForm>({ ...DEFAULT_MAIN_CONFIG });
  const [saved, setSaved] = useState<boolean | 'restart'>(false);
  const [resetConfirming, setResetConfirming] = useState(false);

  useEffect(() => {
    window.electronAPI?.config?.get().then((cfg) => {
      if (cfg) setMainForm({ flashVersion: cfg.flashVersion, lowEndMode: cfg.lowEndMode, downloadEngine: cfg.downloadEngine });
    }).catch(() => {});
  }, []);

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
      pushToast({ message: '设置已保存，需重启生效', type: 'warning' });
    } else {
      setSaved(true);
      pushToast({ message: '设置已保存', type: 'success' });
    }
  }, [form, mainForm, setSettings, pushToast]);

  const handleResetPassword = useCallback(async () => {
    if (!resetConfirming) { setResetConfirming(true); return; }
    setResetConfirming(false);
    await window.electronAPI?.pwd?.resetAll();
    setStoreStatus({ initialized: false, unlocked: false, enabled: false });
    pushToast({ message: '密码本已重置', type: 'info' });
  }, [resetConfirming, setStoreStatus, pushToast]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="panel-card">
        <div className="panel-card-title">通用</div>
        <div className="field">
          <div className="field-label">主页地址</div>
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
          <div className="field-label">搜索引擎</div>
          <select className="input-text" style={{ width: '100%' }} value={form.searchEngine} onChange={(e) => handleChange('searchEngine', e.target.value as Settings['searchEngine'])}>
            <option value="baidu">百度</option>
            <option value="bing">Bing</option>
            <option value="google">Google</option>
          </select>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">Flash</div>
        <div className="field">
          <div className="field-label">伪装版本</div>
          <input
            className="input-text"
            style={{ width: '100%' }}
            type="text"
            value={mainForm.flashVersion}
            onChange={(e) => handleMainChange('flashVersion', e.target.value)}
            placeholder="34.0.0.330"
            pattern="^\\d+\\.\\d+\\.\\d+\\.\\d+$"
          />
          <div className="field-hint">伪装为指定版本号，部分网站会检测。需重启生效。</div>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>低性能设备模式</span>
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
        <div className="field-hint">需重启生效</div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">Ruffle</div>
        <div className="field">
          <div className="field-label">新标签默认引擎</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={form.flashEngineMode}
            onChange={(e) => handleChange('flashEngineMode', e.target.value as Settings['flashEngineMode'])}
          >
            <option value="auto">PPAPI (原生 Flash)</option>
            <option value="prefer-ruffle">Ruffle (WASM 模拟)</option>
            <option value="ppapi-only">仅 PPAPI</option>
          </select>
        </div>
        <div className="field">
          <div className="field-label">Ruffle 来源</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={form.ruffleSource}
            onChange={(e) => handleChange('ruffleSource', e.target.value as Settings['ruffleSource'])}
          >
            <option value="bundled">自托管 (离线可用)</option>
            <option value="cdn">CDN (始终最新)</option>
          </select>
        </div>
        <div className="field-hint">
          仅对新建标签页生效，已有标签页用导航栏按钮切换
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">下载</div>
        <div className="field">
          <div className="field-label">下载引擎</div>
          <select
            className="input-text" style={{ width: '100%' }}
            value={mainForm.downloadEngine}
            onChange={(e) => handleMainChange('downloadEngine', e.target.value as DownloadEngine)}
          >
            <option value="aria2">aria2 (多连接加速)</option>
            <option value="chromium">Chromium (内置)</option>
          </select>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">密码</div>
        <div className="field-hint" style={{ marginBottom: 8 }}>重置将清空所有已保存的密码，需重新设置主密码。</div>
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
          {resetConfirming ? '确认重置？再次点击确认' : '重置密码本'}
        </button>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">外观</div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>页面缩放</span>
          <div className="zoom-controls">
            <button onClick={onZoomOut} className="zoom-btn" title="缩小 (Ctrl+-)">−</button>
            <span className="zoom-label">{zoomPercent}%</span>
            <button onClick={onZoomIn} className="zoom-btn" title="放大 (Ctrl++)">+</button>
            <button onClick={onZoomReset} className="zoom-reset" title="重置缩放">重置</button>
          </div>
        </div>
      </div>

      <div className="panel-card">
        <div className="panel-card-title">主题</div>
        <div className="field">
          <div className="field-label">主题模式</div>
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
                {mode === 'light' ? '亮色' : mode === 'dark' ? '暗色' : '跟随系统'}
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
        {saved === 'restart' ? '已保存 — 需重启生效' : saved ? '已保存 ✓' : '保存设置'}
      </button>
    </div>
  );
};

export default SettingsPanel;
