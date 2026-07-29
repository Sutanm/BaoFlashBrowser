import React, { useState, useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { settingsAtom, defaultSettings } from '@renderer/atoms/data.atom';
import type { Settings } from '@shared/types/settings';

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  currentZoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

const SETTINGS_KEY = 'baoflash_settings';

function load(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

function save(s: Settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const SettingsPanel: React.FC<SettingsPanelProps> = ({ visible, onClose, currentZoom, onZoomIn, onZoomOut, onZoomReset }) => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [form, setForm] = useState<Settings>(load());

  useEffect(() => { setForm(load()); }, [visible]);

  const handleChange = useCallback((key: keyof Settings, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    setSettings(form);
    save(form);
    onClose();
  }, [form, setSettings, onClose]);

  if (!visible) return null;

  return (
    <div className="panel-card">
      <div className="panel-header">
        <span>设置</span>
        <button onClick={onClose} className="panel-close">&times;</button>
      </div>
      <div className="settings-body">
        <label>主页网址</label>
        <input
          type="text"
          value={form.homepage}
          onChange={(e) => handleChange('homepage', e.target.value)}
          placeholder="about:newtab"
        />

        <label>Flash 伪装版本</label>
        <input
          type="text"
          value={form.flashVersion}
          onChange={(e) => handleChange('flashVersion', e.target.value)}
          placeholder="34.0.0.330"
          pattern="^\d+\.\d+\.\d+\.\d+$"
        />

        <label>链接打开方式</label>
        <select value={form.linkBehavior} onChange={(e) => handleChange('linkBehavior', e.target.value)}>
          <option value="new-tab">新标签页</option>
          <option value="current-page">当前页</option>
        </select>

        <label>搜索引擎</label>
        <select value={form.searchEngine} onChange={(e) => handleChange('searchEngine', e.target.value)}>
          <option value="bing">Bing</option>
          <option value="google">Google</option>
          <option value="baidu">百度</option>
        </select>

        <div className="setting-row">
          <span>页面缩放</span>
          <div className="zoom-controls">
            <button onClick={onZoomOut} className="btn-secondary zoom-btn" title="缩小 (Ctrl+-)">−</button>
            <span className="zoom-label">{Math.round(currentZoom * 100)}%</span>
            <button onClick={onZoomIn} className="btn-secondary zoom-btn" title="放大 (Ctrl++)">+</button>
            <button onClick={onZoomReset} className="btn-secondary zoom-btn" title="重置 (Ctrl+0)">重置</button>
          </div>
        </div>

        <button onClick={handleSave} className="btn-primary">保存</button>
      </div>
    </div>
  );
};

export default SettingsPanel;
