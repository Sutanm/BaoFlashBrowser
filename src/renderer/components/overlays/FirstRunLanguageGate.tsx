import React, { useEffect, useState } from 'react';
import { db, migrateFromLocalStorage } from '../../services/db';
import { defaultSettings, hydrateFromDb, useDataStore } from '../../store/useDataStore';
import { useI18nContext } from '../../i18n/i18n-react';
import { isLocale } from '../../i18n/i18n-util';
import { VIEW_PASSWORD_MIN_UI } from '../panels/PasswordViewGateModal';
import './first-run-language.css';

/** 'language' → 'vault' 是首次启动向导的两步；'ready' 之后才挂载浏览器本体。 */
type Phase = 'loading' | 'language' | 'vault' | 'ready';

/** Mount the browser only after preferences are loaded, so native views cannot cover the dialog. */
export default function FirstRunLanguageGate({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { LL, setLocale } = useI18nContext();
  const [phase, setPhase] = useState<Phase>('loading');
  const [language, setLanguage] = useState<'zh-CN' | 'en'>('zh-CN');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  /**
   * 查看保护会落在哪一档（`password:guard-preview`，建库前预判）：
   * `null` = 还没问到。**系统验证可用时不问用户要密码**——A 档由 Windows Hello/凭据对话框保护，
   * 让用户再敲一个查看密码是多余负担（用户 2026-11-08 反馈）。
   */
  const [guardMode, setGuardMode] = useState<'os-win' | 'password' | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    void (async () => {
      await migrateFromLocalStorage();
      const saved = await db.settingsSingleton.get('default');
      if (!live) return;
      if (saved && isLocale(saved.language)) {
        hydrateFromDb({ settings: { ...defaultSettings, ...saved } });
        setLocale(saved.language);
        setPhase('ready');
      } else {
        setPhase('language');
      }
    })().catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [attempt, setLocale]);

  /** 进入第二步时问一次"要不要密码"，决定这一步的形态。 */
  useEffect(() => {
    if (phase !== 'vault' || guardMode !== null) return;
    let live = true;
    void (async () => {
      const api = window.electronAPI?.pwd;
      if (!api?.guardPreview) { setGuardMode('password'); return; }
      try {
        const preview = await api.guardPreview();
        if (live) setGuardMode(preview.mode === 'os-win' ? 'os-win' : 'password');
      } catch {
        if (live) setGuardMode('password');
      }
    })();
    return () => { live = false; };
  }, [phase, guardMode]);

  /** 向导走完：把（仅在此时才写盘的）设置落库并挂载浏览器本体。 */
  const finish = async (): Promise<void> => {
    const saved = await db.settingsSingleton.get('default');
    const settings = { ...useDataStore.getState().settings, ...saved, language };
    await db.settingsSingleton.put(settings, 'default');
    hydrateFromDb({ settings });
    setLocale(language);
    setPhase('ready');
  };

  /**
   * 第二步提交。
   * - 启用：先确保 enabled + `password:init` 建库；只有在查看保护落到 C 档（无系统钥匙串）时，
   *   才把输入框里的密码设为查看密码。A 档由系统验证保护，不设查看密码（`set-view-password`
   *   在这种机器上会返回 not-available，属预期）。
   * - 不启用：把密码本置为关闭（出厂默认是"启用但未建库"，所以必须显式关掉）。
   * 校验沿用仓库既有的查看密码规则（长度下限 VIEW_PASSWORD_MIN，不做大小写等复杂度强制）。
   */
  const applyVault = async (enable: boolean, secret: string | null): Promise<void> => {
    if (secret !== null && secret.length < VIEW_PASSWORD_MIN_UI) {
      setVaultError(LL.password.viewGateTooShort());
      return;
    }
    setVaultError(null);
    setBusy(true);
    try {
      const api = window.electronAPI?.pwd;
      if (api) {
        const current = await api.status();
        if (enable) {
          if (!current.enabled) await api.toggleEnabled();
          const created = await api.init();
          if (!created.success) { setVaultError(LL.firstRun.vaultFailed()); return; }
          if (secret !== null) {
            const next = await api.status();
            if (next.viewGuard.mode === 'password') {
              const result = await api.setViewPassword(secret);
              if (!result.success && result.error !== 'not-available') {
                setVaultError(LL.firstRun.vaultFailed());
                return;
              }
            }
          }
        } else if (current.enabled) {
          await api.toggleEnabled();
        }
      }
      await finish();
    } catch {
      setVaultError(LL.firstRun.vaultFailed());
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'ready') return <>{children}</>;

  // 读取设置期间**什么都不画**。
  // 已配置过的机器（见上面的 saved 分支）读到设置后会立刻切 'ready'，如果这段时间先渲染
  // 对话框，用户看到的就是向导"一闪而过"（2026-11-08 反馈）。等待期只有一次 IndexedDB 读，
  // 留白比闪一下更像正常启动。
  // 出错时仍然要把对话框亮出来：否则用户只看到一片空白，且没有重试入口。
  if (phase === 'loading' && !error) return null;

  const isVault = phase === 'vault';
  const entered = password.length > 0;
  /** 系统验证可用（A 档）→ 只问"要不要"，不问查看密码。 */
  const isOsGuard = guardMode === 'os-win';

  return <div className="first-run-overlay">
    <section className="first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="first-run-title" aria-describedby="first-run-description" aria-busy={busy}>
      <h1 id="first-run-title">{isVault ? LL.firstRun.vaultTitle() : LL.firstRun.title()}</h1>
      <p id="first-run-description">{isVault ? LL.firstRun.vaultDescription() : LL.firstRun.description()}</p>

      {phase === 'language' && <form onSubmit={(event) => {
        event.preventDefault();
        setLocale(language);
        setPhase('vault');
      }}>
        <label htmlFor="first-run-language">简体中文 / English</label>
        <select id="first-run-language" autoFocus value={language} disabled={busy} onChange={(event) => {
          const next = event.target.value === 'en' ? 'en' : 'zh-CN';
          setLanguage(next);
          setLocale(next);
        }}>
          <option value="zh-CN" lang="zh-CN">简体中文</option>
          <option value="en" lang="en">English</option>
        </select>
        <button type="submit" disabled={busy}>{LL.firstRun.continue()}</button>
      </form>}

      {/* 形态未定（还在探系统验证档位）时先不渲染表单：否则会先闪一个用不上的密码框，
          用户刚填完就被切走（e2e 里表现为按钮 detached）。 */}
      {isVault && (guardMode === null
        ? <p className="first-run-hint" role="status">{LL.firstRun.loading()}</p>
        : <form onSubmit={(event) => {
        event.preventDefault();
        if (isOsGuard) void applyVault(true, null);
        else void applyVault(entered, entered ? password : null);
      }}>
        {isOsGuard ? <p className="first-run-hint">{LL.firstRun.vaultOsDescription()}</p> : <>
          <label htmlFor="first-run-vault-password">{LL.firstRun.vaultPasswordLabel()}</label>
          <input
            id="first-run-vault-password"
            type="password"
            autoFocus
            value={password}
            disabled={busy}
            placeholder={LL.firstRun.vaultPasswordLabel()}
            onChange={(event) => { setPassword(event.target.value); setVaultError(null); }}
          />
          {entered && <p className="first-run-hint">{LL.firstRun.vaultWarning()}</p>}
        </>}

        {isOsGuard ? <>
          <button type="submit" disabled={busy || guardMode === null}>{LL.firstRun.vaultEnable()}</button>
          <button
            id="first-run-vault-skip"
            type="button"
            className="secondary"
            disabled={busy || guardMode === null}
            onClick={() => void applyVault(false, null)}
          >
            {LL.firstRun.vaultDisable()}
          </button>
        </> : <button
          /* 一个按钮两种身份：没输入密码时是"跳过"（=不启用），输入后变"确认"。
             id 只在"跳过"这一态挂上，供 e2e 稳定定位"不启用"这条路。 */
          id={entered ? undefined : 'first-run-vault-skip'}
          type="submit"
          className={entered ? undefined : 'secondary'}
          disabled={busy || guardMode === null}
        >
          {entered ? LL.firstRun.vaultConfirm() : LL.firstRun.vaultSkip()}
        </button>}
        {!isOsGuard && <p className="first-run-hint">{LL.firstRun.vaultHint()}</p>}
      </form>)}

      {error && <p role="alert">{LL.firstRun.error()}</p>}
      {error && phase === 'loading' && <button type="button" onClick={() => { setError(false); setAttempt((value) => value + 1); }}>{LL.firstRun.retry()}</button>}
      {vaultError && <p role="alert">{vaultError}</p>}
    </section>
  </div>;
}
