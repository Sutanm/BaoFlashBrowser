import React, { useState, useEffect, useCallback } from 'react';
import { useAtom } from 'jotai';
import { settingsAtom, defaultSettings } from '@renderer/atoms/data.atom';
import type { Settings, LinkBehavior, SearchEngine } from '@shared/types/settings';

interface SettingsPanelProps {
  visible: boolean;
  onClose: () => void;
  currentZoom: number;
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

const SettingsPanel: React.FC<SettingsPanelProps> = ({ visible, onClose, currentZoom }) => {
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

  const inputStyle = {
    height: '30px',
    padding: '0 12px',
    border: '1px solid var(--border-color)',
    borderRadius: '6px',
    background: 'var(--bg-input)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  };

  const selectStyle = { ...inputStyle, cursor: 'pointer' };

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
          style={inputStyle}
        />

        <label>Flash 伪装版本</label>
        <input
          type="text"
          value={form.flashVersion}
          onChange={(e) => handleChange('flashVersion', e.target.value)}
          placeholder="34.0.0.330"
          style={inputStyle}
          pattern="^\d+\.\d+\.\d+\.\d+$"
        />

        <label>链接打开方式</label>
        <select
          value={form.linkBehavior}
          onChange={(e) => handleChange('linkBehavior', e.target.value)}
          style={selectStyle}
        >
          <option value="new-tab">新标签页</option>
          <option value="current-page">当前页</option>
        </select>

        <label>搜索引擎</label>
        <select
          value={form.searchEngine}
          onChange={(e) => handleChange('searchEngine', e.target.value)}
          style={selectStyle}
        >
          <option value="bing">Bing</option>
          <option value="google">Google</option>
          <option value="baidu">百度</option>
        </select>

        <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          页面缩放
          <span style={{ fontWeight: 400, opacity: 0.7 }}>{Math.round(currentZoom * 100)}%</span>
        </label>

        <button onClick={handleSave} className="btn-primary">
          保存
        </button>
      </div>
    </div>
  );
};

export default SettingsPanel;
