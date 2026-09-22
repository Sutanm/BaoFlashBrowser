import React, { useEffect, useState, useCallback } from 'react';
import { Key } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { PasswordEntry, PasswordStoreStatus } from '@shared/types/passwords';
import { useTabsStore } from '@renderer/store/useTabsStore';
import { useDataStore } from '@renderer/store/useDataStore';
import PasswordViewGateModal, { formatLockRemaining } from './PasswordViewGateModal';

/**
 * 侧边栏"密码本"面板 — v2（无主密码/无解锁态）。
 * - 未启用：开启开关。
 * - 已启用未建库：一键"启用密码管理器"（无任何密码输入）。
 * - 已启用：列表常显；"查看"走 view-gate 门禁（规格 2026-09-22）——
 *   每次查看都验证：A 档弹系统对话框，C 档输入自定义查看密码；
 *   未通过一律只显示掩码，明文只在 reveal 返回时短暂存在于组件状态里。
 */
const PasswordsPanel: React.FC = () => {
  const { LL } = useI18nContext();
  const [status, setStatus] = useState<PasswordStoreStatus | null>(null);
  const [entries, setEntries] = useState<PasswordEntry[]>([]);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [decryptedPasswords, setDecryptedPasswords] = useState<Map<string, string>>(new Map());
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const [rebuildWord, setRebuildWord] = useState('');
  // --- 查看门禁（规格 2026-09-22）：每次查看都验证，因此没有"已授权"状态可缓存 ---
  const [gateTargetId, setGateTargetId] = useState<string | null>(null);
  const [gateSetup, setGateSetup] = useState(false);
  /** true = 本次设置是被"系统验证降级"逼出来的（只影响说明文案）。 */
  const [gateDegraded, setGateDegraded] = useState(false);
  const [gateBusy, setGateBusy] = useState(false);
  const [gateError, setGateError] = useState<{ text?: string; remaining?: number } | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const activeTabId = useTabsStore((state) => state.activeTabId);
  const pushToast = useDataStore((state) => state.pushToast);

  const api = window.electronAPI?.pwd;
  const lockRemaining = lockedUntil ? Math.max(0, lockedUntil - clock) : 0;

  /**
   * 落定锁定时必须同时校准 `clock`：否则基准还停在挂载时刻，
   * 倒计时会多算出"挂载到现在"的时间（实测显示 01:31 而实际 01:30）。
   */
  const applyLock = useCallback((ms: number) => {
    const now = Date.now();
    setClock(now);
    setLockedUntil(now + ms);
  }, []);

  /** 取回权威状态并把锁定剩余时间落到本地；返回该状态供调用方接着决策。 */
  const refreshStatus = useCallback(async (): Promise<PasswordStoreStatus | null> => {
    if (!api) return null;
    const s: PasswordStoreStatus = await api.status();
    setStatus(s);
    // 锁定由主进程裁决：把剩余时间落到本地，用于倒计时展示。
    if (s.viewGuard.lockedForMs) applyLock(s.viewGuard.lockedForMs);
    else setLockedUntil(null);
    if (s.initialized && s.enabled) {
      const list: PasswordEntry[] = await api.list();
      setEntries(list);
    } else {
      setEntries([]);
      setDecryptedPasswords(new Map());
    }
    return s;
  }, [api, applyLock]);

  // 仅在锁定期间走秒，其它时候不产生定时器。
  useEffect(() => {
    if (!lockedUntil || lockedUntil <= Date.now()) return;
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  // 倒计时到点：清掉本地锁定态并回主进程取权威状态。
  useEffect(() => {
    if (lockedUntil && lockRemaining === 0) {
      setLockedUntil(null);
      void refreshStatus();
    }
  }, [lockedUntil, lockRemaining, refreshStatus]);

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
    if (!api || !status) return;
    const guard = status.viewGuard;
    // 门禁不可用（未建库 / 密钥不可用）就不该弹输入框——先修根因。
    if (guard.mode === 'none') {
      pushToast({
        message: guard.reason === 'key-unavailable' ? LL.password.viewGateNoKey() : LL.password.viewGateNoVault(),
        type: 'warning',
      });
      return;
    }
    if (lockRemaining > 0) {
      pushToast({ message: LL.password.viewGateLocked({ time: formatLockRemaining(lockRemaining) }), type: 'warning' });
      return;
    }
    setGateError(null);
    setGateTargetId(id);
    if (guard.mode === 'password' && !guard.passwordSet) {
      // 之前已经降级过（reason 持久化）→ 说明文案要讲清"为什么突然要设自定义密码"。
      setGateDegraded(guard.reason === 'os-auth-unavailable');
      setGateSetup(true);
      return;
    }
    setGateDegraded(false);
    setGateSetup(false);
    // A 档：主进程弹系统对话框；模态只作"等待验证"提示。
    if (guard.mode !== 'password') void attemptReveal(id);
  };

  const attemptReveal = async (id: string, secret?: string, afterSetup = false) => {
    if (!api) return;
    setGateBusy(true);
    try {
      const result = await api.reveal(id, secret);
      if (result.password) {
        setDecryptedPasswords((prev) => new Map(prev).set(id, result.password!));
        setGateTargetId(null);
        setGateError(null);
        setGateSetup(false);
        setGateDegraded(false);
        if (afterSetup) pushToast({ message: LL.password.viewGateSaved(), type: 'success' });
        return;
      }
      switch (result.error) {
        case 'cancelled':
          // 用户主动取消：静默关闭，不报错（也不计入失败）。
          setGateTargetId(null);
          setGateError(null);
          return;
        case 'needs-setup':
          setGateSetup(true);
          setGateError(null);
          return;
        case 'wrong-credential':
          setGateError({ text: LL.password.viewGateWrong(), remaining: result.remainingAttempts });
          if (result.lockedForMs) applyLock(result.lockedForMs);
          return;
        case 'locked':
          applyLock(result.lockedForMs ?? 0);
          setGateError({ text: undefined });
          return;
        case 'degraded': {
          // 系统验证用不了（1327 空密码受限 / 1385 策略拒绝等，常见于未设 Windows 登录密码的账户）。
          // 主进程已持久降级 → 先取回权威状态：mode 会变成 'password'，模态才渲染得出输入框。
          // 必须 await：否则还会用旧的 'os-win' 渲染，用户看到一个没有输入框的"设置"框。
          const next = await refreshStatus();
          const passwordSet = next?.viewGuard.passwordSet ?? status?.viewGuard.passwordSet ?? false;
          if (!passwordSet) {
            setGateDegraded(true);
            setGateSetup(true);
            setGateError(null);
          } else {
            setGateError({ text: LL.password.viewGateDegraded() });
          }
          return;
        }
        case 'account-locked':
          setGateError({ text: LL.password.viewGateAccountLocked() });
          return;
        case 'unavailable':
          setGateError({ text: LL.password.viewGateUnavailable({ reason: result.reason ?? 'unknown' }) });
          return;
        default:
          setGateError({ text: LL.password.viewGateWrong() });
          return;
      }
    } finally {
      setGateBusy(false);
    }
  };

  const handleGateSubmit = async (secret: string) => {
    const id = gateTargetId;
    if (!id || !api) return;
    if (!gateSetup) {
      await attemptReveal(id, secret);
      return;
    }
    setGateBusy(true);
    try {
      const result = await api.setViewPassword(secret);
      if (!result.success) {
        setGateError({
          text: result.error === 'weak-password'
            ? LL.password.viewGateTooShort()
            : LL.password.viewGateChangeFailed(),
          remaining: result.remainingAttempts,
        });
        return;
      }
      await refreshStatus();
      setGateSetup(false);
      // 规格 §5：设置成功后当次直接视为已授权（同一次交互意图），立刻把明文给他。
      await attemptReveal(id, secret, true);
    } finally {
      setGateBusy(false);
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
    <div style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
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
                    <span style={{ color: 'var(--text-primary)' }}>{entry.username || LL.password.noUsername()}</span>
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

      {gateTargetId && (
        <PasswordViewGateModal
          mode={status.viewGuard.mode}
          setup={gateSetup}
          degraded={gateDegraded}
          busy={gateBusy}
          errorText={gateError?.text}
          remainingAttempts={gateError?.remaining}
          lockedForMs={lockRemaining}
          onSubmit={(secret) => { void handleGateSubmit(secret); }}
          onCancel={() => { setGateTargetId(null); setGateError(null); setGateSetup(false); setGateDegraded(false); }}
        />
      )}
    </div>
  );
};

export default PasswordsPanel;
