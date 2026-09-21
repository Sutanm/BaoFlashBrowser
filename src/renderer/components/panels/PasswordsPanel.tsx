import React, { useEffect, useState, useCallback } from 'react';
import { Key } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { PasswordEntry, PasswordStoreStatus } from '@shared/types/passwords';
import { useTabsStore } from '@renderer/store/useTabsStore';
import { useDataStore } from '@renderer/store/useDataStore';

/**
 * 侧边栏"密码本"面板 — v2（无主密码/无解锁态）。
 * - 未启用：开启开关。
 * - 已启用未建库：一键"启用密码管理器"（无任何密码输入）。
 * - 已启用：列表常显；"查看/复制"走 reveal 门禁（Task5 view-gate 接线前
 *   后端恒返回 not-authorized，UI 显示占位提示）。
 */
const PasswordsPanel: React.FC = () => {
  const { LL } = useI18nContext();
  const [status, setStatus] = useState<PasswordStoreStatus | null>(null);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [decryptedPasswords, setDecryptedPasswords] = useState<Map<string, string>>(new Map());
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildWord, setRebuildWord] = useState('');
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const pushToast = useDataStore((state) => state.pushToast);

  const api = window.electronAPI?.pwd;

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    const s: PasswordStoreStatus = await api.status();
    setStatus(s);
    if (s.initialized && s.enabled) {
      const list: PasswordEntry[] = await api.list();
      setEntries(list);
    } else {
      setEntries([]);
      setDecryptedPasswords(new Map());
    }
  }, [api]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  // 密码本数据变化通知（保存/删除/设置默认/重置后自动刷新列表）
  useEffect(() => {
    const apiOn = window.electronAPI;
    if (!apiOn?.on) return;
    const unsub = apiOn.on('password:changed', () => { refreshStatus(); });
    return () => { if (unsub) unsub(); };
  }, [refreshStatus]);

  const handleToggleEnabled = async () => {
    await api?.toggleEnabled();
    refreshStatus();
  };

  const handleInit = async () => {
    if (!api) return;
    const result = await api.init();
    if (!result.success) pushToast({ message: LL.password.initFailed(), type: 'error' });
    refreshStatus();
  };

  const handleRetryKey = async () => {
    if (!api) return;
    await api.retryKey();
    refreshStatus();
  };

  const handleRebuild = async () => {
    if (!api) return;
    const result = await api.rebuildVault('REBUILD');
    setRebuildOpen(false);
    setRebuildWord('');
    pushToast({
      message: result.success ? LL.password.keyRebuildDone() : LL.password.keyRebuildFailed(),
      type: result.success ? 'success' : 'error',
    });
    refreshStatus();
  };

  const handleTogglePassword = async (id: string) => {
    if (decryptedPasswords.has(id)) {
      setDecryptedPasswords((prev) => { const m = new Map(prev); m.delete(id); return m; });
      return;
    }
    if (!api) return;
    const result = await api.reveal(id);
    if (result.password) {
      setDecryptedPasswords((prev) => new Map(prev).set(id, result.password!));
    } else if (result.error === 'not-authorized') {
      pushToast({ message: LL.password.viewLocked(), type: 'warning' });
    }
  };

  const handleCopy = (text: string) => { navigator.clipboard.writeText(text).catch(() => {}); };

  const handleFill = async (id: string) => {
    if (!activeTabId) {
      pushToast({ message: LL.password.fillFailed(), type: 'warning' });
      return;
    }
    try {
      const result = await api?.fill(activeTabId, id);
      if (!result?.success) pushToast({ message: LL.password.fillFailed(), type: 'warning' });
    } catch {
      pushToast({ message: LL.password.fillFailed(), type: 'error' });
    }
  };

  const toggleHost = (host: string) => {
    setExpandedHosts((prev) => { const next = new Set(prev); if (next.has(host)) next.delete(host); else next.add(host); return next; });
  };

  if (!status) return <div className="sidebar-empty">{LL.loading()}</div>;

  // --- 未启用 ---
  if (!status.enabled) {
    return (
      <div className="pwd-setup-container">
        <div className="pwd-setup-hero">
          <Key className="w-8 h-8" style={{ color: 'var(--text-secondary)', margin: '0 auto' }} />
          <p className="pwd-setup-hero-title">{LL.password.disabledTitle()}</p>
          <p className="pwd-setup-hero-sub">{LL.password.disabledDesc()}</p>
        </div>
        <button onClick={handleToggleEnabled} className="btn-secondary" style={{ width: '100%' }}>{LL.password.enable()}</button>
      </div>
    );
  }

  // --- 已启用、尚未建库：一键启用（无主密码） ---
  if (!status.initialized) {
    return (
      <div className="pwd-setup-container">
        <div className="pwd-setup-hero">
          <Key className="w-8 h-8" style={{ color: 'var(--text-secondary)', margin: '0 auto' }} />
          <p className="pwd-setup-hero-title">{LL.password.initTitle()}</p>
          <p className="pwd-setup-hero-sub">{LL.password.initDesc()}</p>
        </div>
        <button onClick={handleInit} className="btn-secondary" style={{ width: '100%' }}>{LL.password.initBtn()}</button>
      </div>
    );
  }

  const grouped = new Map<string, PasswordEntry[]>();
  for (const e of entries) { const arr = grouped.get(e.host) || []; arr.push(e); grouped.set(e.host, arr); }
  for (const [, arr] of grouped) { arr.sort((a, b) => b.updatedAt - a.updatedAt); }
  const hosts = [...grouped.keys()].sort();

  const keyStatus = status.keyStatus ?? 'ok';
  const keyIssue = status.keyIssue;
  const showTier = keyStatus === 'ok' && status.tier !== 'C';

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="pwd-settings-bar" style={{ borderBottom: '1px solid var(--border-light)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={status.enabled} onChange={handleToggleEnabled} /> {LL.password.enable()}
        </label>
        {keyStatus !== 'ok' ? (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#b45309' }}>{LL.password.keyBlockedTitle()}</span>
        ) : showTier ? (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#185fa5' }}>{LL.password.tierA()}</span>
        ) : (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#b45309' }}>{LL.password.tierC()}</span>
        )}
      </div>

      {keyStatus === 'retrying' && (
        <div className="pwd-key-banner" data-state="retrying">
          <span>{LL.password.keyRetrying({ attempt: keyIssue?.attempts ?? 0 })}</span>
          <button className="btn-secondary pwd-btn-action" onClick={handleRetryKey}>{LL.password.keyRetry()}</button>
        </div>
      )}

      {keyStatus === 'blocked' && (
        <div className="pwd-key-banner" data-state="blocked">
          <p className="pwd-key-banner-title">{LL.password.keyBlockedTitle()}</p>
          <p className="pwd-key-banner-desc">{LL.password.keyBlockedDesc({ reason: keyIssue?.reason ?? 'unknown' })}</p>
          {!rebuildOpen ? (
            <div className="pwd-key-banner-actions">
              <button className="btn-secondary pwd-btn-action" onClick={handleRetryKey}>{LL.password.keyRetry()}</button>
              <button className="btn-secondary pwd-btn-action pwd-btn-danger" onClick={() => setRebuildOpen(true)}>
                {LL.password.keyRebuild()}
              </button>
            </div>
          ) : (
            <div className="pwd-key-banner-actions">
              <p className="pwd-key-banner-desc">{LL.password.keyRebuildDesc()}</p>
              <label className="pwd-key-confirm-label">
                {LL.password.keyRebuildConfirmLabel({ word: 'REBUILD' })}
                <input
                  type="text"
                  value={rebuildWord}
                  onChange={(event) => setRebuildWord(event.target.value)}
                  aria-label={LL.password.keyRebuildConfirmLabel({ word: 'REBUILD' })}
                />
              </label>
              <button
                className="btn-secondary pwd-btn-action pwd-btn-danger"
                disabled={rebuildWord !== 'REBUILD'}
                onClick={handleRebuild}
              >
                {LL.password.keyRebuild()}
              </button>
              <button className="btn-secondary pwd-btn-action" onClick={() => { setRebuildOpen(false); setRebuildWord(''); }}>
                {LL.password.ignore()}
              </button>
            </div>
          )}
        </div>
      )}

      {hosts.length === 0 ? (
        <div className="sidebar-empty">{LL.password.empty()}</div>
      ) : (
        hosts.map((host) => {
          const items = grouped.get(host)!;
          const defaultId = items[0]?.id;
          return (
            <div key={host} className="pwd-host-group">
              <div className="pwd-host-header" onClick={() => toggleHost(host)}>
                <span>{expandedHosts.has(host) ? '▾' : '▸'} {host}</span>
              </div>
              {expandedHosts.has(host) && items.map((entry) => (
                <div key={entry.id} className="pwd-entry">
                  <div className="pwd-entry-row">
                    <span style={{ color: 'var(--text-primary)' }}>{entry.username}</span>
                    {entry.id === defaultId && <span className="pwd-default-star">★</span>}
                  </div>
                  <div className="pwd-entry-actions">
                    <span className="pwd-pwd-text">
                      {decryptedPasswords.has(entry.id) ? decryptedPasswords.get(entry.id) : '••••••••'}
                    </span>
                    <button className="btn-secondary pwd-btn-action" onClick={() => handleTogglePassword(entry.id)}>
                      {decryptedPasswords.has(entry.id) ? LL.password.hide() : LL.password.view()}
                    </button>
                    {decryptedPasswords.has(entry.id) && (
                      <button className="btn-secondary pwd-btn-action" onClick={() => handleCopy(decryptedPasswords.get(entry.id)!)}>{LL.copy()}</button>
                    )}
                    <button className="btn-secondary pwd-btn-action" onClick={async () => { await api?.setDefault(entry.id); refreshStatus(); }}>{LL.password.setDefault()}</button>
                    <button className="btn-secondary pwd-btn-action" onClick={() => handleFill(entry.id)}>{LL.password.fill()}</button>
                    <button className="btn-secondary pwd-btn-action pwd-btn-danger" onClick={async () => { await api?.delete(entry.id); refreshStatus(); }}>{LL.delete()}</button>
                  </div>
                </div>
              ))}
            </div>
          );
        })
      )}
    </div>
  );
};

export default PasswordsPanel;
