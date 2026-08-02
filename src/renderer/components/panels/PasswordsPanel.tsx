import React, { useEffect, useState, useCallback } from 'react';
import { Key } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { PasswordEntry } from '@shared/types/passwords';
import { useTabsStore } from '@renderer/store/useTabsStore';
import { useDataStore } from '@renderer/store/useDataStore';

function maskMiddle(str: string, keepStart: number, keepEnd: number): string {
  if (str.length <= keepStart + keepEnd + 2) return str;
  return str.slice(0, keepStart) + '******' + str.slice(-keepEnd);
}

interface StoreStatus { initialized: boolean; unlocked: boolean; enabled: boolean; }

const PasswordsPanel: React.FC = () => {
  const { LL } = useI18nContext();
  const [status, setStatus] = useState<StoreStatus | null>(null);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [unlockPwd, setUnlockPwd] = useState('');
  const [setupPwd, setSetupPwd] = useState('');
  const [setupPwd2, setSetupPwd2] = useState('');
  const [unlockError, setUnlockError] = useState(false);
  const [setupError, setSetupError] = useState('');
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [decryptedPasswords, setDecryptedPasswords] = useState<Map<string, string>>(new Map());
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const pushToast = useDataStore((state) => state.pushToast);

  const api = window.electronAPI?.pwd;

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    const s: StoreStatus = await api.status();
    setStatus(s);
    if (s.unlocked) {
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
    const api = window.electronAPI;
    if (!api?.on) return;
    const unsub = api.on('password:changed', () => { refreshStatus(); });
    return () => { if (unsub) unsub(); };
  }, [refreshStatus]);

  const handleUnlock = async () => {
    const result = await api.unlock(unlockPwd);
    if (result.success) { setUnlockError(false); setUnlockPwd(''); refreshStatus(); }
    else { setUnlockError(true); }
  };

  const handleSetup = async () => {
    if (setupPwd !== setupPwd2) { setSetupError(LL.password.mismatch()); return; }
    if (setupPwd.length < 8) { setSetupError(LL.password.tooShort()); return; }
    if (!/[A-Z]/.test(setupPwd) || !/[a-z]/.test(setupPwd) || !/\d/.test(setupPwd)) {
      setSetupError(LL.password.complexityFail()); return;
    }
    const result = await api.setup(setupPwd);
    if (result.success) { setSetupError(''); refreshStatus(); }
    else { setSetupError(result.error || LL.password.setupFailed()); }
  };

  const handleToggleEnabled = async () => {
    await api.toggleEnabled();
    refreshStatus();
  };

  const handleDelete = async (id: string) => {
    await api.delete(id);
    refreshStatus();
  };

  const handleTogglePassword = async (id: string) => {
    if (decryptedPasswords.has(id)) {
      setDecryptedPasswords((prev) => { const m = new Map(prev); m.delete(id); return m; });
    } else {
      const pwd = await api.getPassword(id);
      if (pwd) setDecryptedPasswords((prev) => new Map(prev).set(id, pwd));
    }
  };

  const handleCopy = (text: string) => { navigator.clipboard.writeText(text).catch(() => {}); };

  const handleFill = async (id: string) => {
    if (!activeTabId) {
      pushToast({ message: LL.password.fillFailed(), type: 'warning' });
      return;
    }
    try {
      const result = await api.fill(activeTabId, id);
      if (!result.success) pushToast({ message: LL.password.fillFailed(), type: 'warning' });
    } catch {
      pushToast({ message: LL.password.fillFailed(), type: 'error' });
    }
  };

  const toggleHost = (host: string) => {
    setExpandedHosts((prev) => { const next = new Set(prev); if (next.has(host)) next.delete(host); else next.add(host); return next; });
  };

  if (!status) return <div className="sidebar-empty">{LL.loading()}</div>;

  if (!status.initialized) {
    return (
      <div className="pwd-setup-container">
        <div className="pwd-setup-hero">
          <Key className="w-8 h-8" style={{ color: 'var(--text-secondary)', margin: '0 auto' }} />
          <p className="pwd-setup-hero-title">{LL.password.notSetup()}</p>
          <p className="pwd-setup-hero-sub">{LL.password.notSetupDesc()}</p>
        </div>
        <input type="password" className="input-text" placeholder={LL.password.setupPlaceholder()} value={setupPwd} onChange={(e) => setSetupPwd(e.target.value)} style={{ width: '100%' }} />
        <input type="password" className="input-text" placeholder={LL.password.confirmPlaceholder()} value={setupPwd2} onChange={(e) => setSetupPwd2(e.target.value)} style={{ width: '100%' }} />
        {setupError && <span className="pwd-error">{setupError}</span>}
        <button onClick={handleSetup} className="btn-secondary" style={{ width: '100%' }}>{LL.password.setupBtn()}</button>
      </div>
    );
  }

  if (!status.unlocked) {
    return (
      <div className="pwd-setup-container">
        <div className="pwd-settings-bar">
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
            <input type="checkbox" checked={status.enabled} onChange={handleToggleEnabled} />
            {LL.password.enable()}
          </label>
        </div>
        <div className="pwd-unlock-row">
          <input type="password" className="input-text" placeholder={LL.password.unlockPlaceholder()} value={unlockPwd}
            onChange={(e) => setUnlockPwd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleUnlock()} style={{ width: '100%' }} />
          <button className="btn-secondary" onClick={handleUnlock} style={{ width: '100%' }}>{LL.password.unlockBtn()}</button>
        </div>
        {unlockError && <span className="pwd-error">{LL.password.wrongPassword()}</span>}
      </div>
    );
  }

  const grouped = new Map<string, PasswordEntry[]>();
  for (const e of entries) { const arr = grouped.get(e.host) || []; arr.push(e); grouped.set(e.host, arr); }
  for (const [, arr] of grouped) { arr.sort((a, b) => b.updatedAt - a.updatedAt); }
  const hosts = [...grouped.keys()].sort();

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className="pwd-settings-bar" style={{ borderBottom: '1px solid var(--border-light)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-primary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={status.enabled} onChange={handleToggleEnabled} /> {LL.password.enable()}
        </label>
        <button className="btn-secondary" onClick={async () => { await api.lock(); setUnlockPwd(''); refreshStatus(); }} style={{ marginLeft: 'auto', fontSize: 12, padding: '2px 8px' }}>{LL.password.lock()}</button>
      </div>
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
                    <span style={{ color: 'var(--text-primary)' }}>
                      {status.unlocked ? entry.username : maskMiddle(entry.username, 3, 2)}
                    </span>
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
                    <button className="btn-secondary pwd-btn-action" onClick={async () => { await api.setDefault(entry.id); refreshStatus(); }}>{LL.password.setDefault()}</button>
                    <button className="btn-secondary pwd-btn-action" onClick={() => handleFill(entry.id)}>{LL.password.fill()}</button>
                    <button className="btn-secondary pwd-btn-action pwd-btn-danger" onClick={() => handleDelete(entry.id)}>{LL.delete()}</button>
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
