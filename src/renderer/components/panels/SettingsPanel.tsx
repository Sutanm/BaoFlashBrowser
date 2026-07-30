import React, { useState, useCallback } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { settingsAtom, defaultSettings, pushToastAtom } from '@renderer/atoms/data.atom';
import type { Settings } from '@shared/types/settings';

interface SettingsPanelProps {
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ zoomPercent, onZoomIn, onZoomOut, onZoomReset }) => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });
  const [saved, setSaved] = useState<boolean | 'restart'>(false);

  const handleChange = useCallback((key: keyof Settings, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleSave = useCallback(() => {
    setSettings(form);
    (window as any).electronAPI?.invoke('save-config', {
      flashVersion: form.flashVersion,
      lowEndMode: form.lowEndMode,
      downloadEngine: form.downloadEngine,
    });

    const needsRestart =
      form.flashVersion !== settings.flashVersion ||
      form.lowEndMode !== settings.lowEndMode;

    if (needsRestart) {
      setSaved('restart');
      pushToast({ message: '设置已保存，需重启生效', type: 'warning' });
    } else {
      setSaved(true);
      pushToast({ message: '设置已保存', type: 'success' });
    }
  }, [form, setSettings, settings, pushToast]);

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
          <select className="input-text" style={{ width: '100%' }} value={form.searchEngine} onChange={(e) => handleChange('searchEngine', e.target.value)}>
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
            value={form.flashVersion}
            onChange={(e) => handleChange('flashVersion', e.target.value)}
            placeholder="34.0.0.330"
          pattern="^\\d+\\.\\d+\\.\\d+\\.\\d+$"
        />
        <div className="field-hint">伪装为指定版本号，部分网站会检测。需重启生效。</div>
        </div>
        <div className="field" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>低性能设备模式</span>
          <div
            className={`toggle-switch ${form.lowEndMode ? 'on' : ''}`}
            onClick={() => handleChange('lowEndMode', !form.lowEndMode)}
          >
            <span className="toggle-knob" />
          </div>
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
            onChange={(e) => handleChange('flashEngineMode', e.target.value)}
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
            onChange={(e) => handleChange('ruffleSource', e.target.value)}
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
            value={form.downloadEngine}
            onChange={(e) => handleChange('downloadEngine', e.target.value)}
          >
            <option value="aria2">aria2 (多连接加速)</option>
            <option value="chromium">Chromium (内置)</option>
          </select>
        </div>
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
