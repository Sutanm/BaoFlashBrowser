import React, { useEffect, useState } from 'react';
import { db, migrateFromLocalStorage } from '../../services/db';
import { defaultSettings, hydrateFromDb, useDataStore } from '../../store/useDataStore';
import { useI18nContext } from '../../i18n/i18n-react';
import { isLocale } from '../../i18n/i18n-util';
import './first-run-language.css';

/** Mount the browser only after preferences are loaded, so native views cannot cover the dialog. */
export default function FirstRunLanguageGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { LL, setLocale } = useI18nContext();
  const [phase, setPhase] = useState<'loading' | 'choose' | 'ready'>('loading');
  const [language, setLanguage] = useState<'zh-CN' | 'en'>('zh-CN');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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
        setPhase('choose');
      }
    })().catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [attempt, setLocale]);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(false);
    try {
      const saved = await db.settingsSingleton.get('default');
      const settings = { ...useDataStore.getState().settings, ...saved, language };
      await db.settingsSingleton.put(settings, 'default');
      hydrateFromDb({ settings });
      setLocale(language);
      setPhase('ready');
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  if (phase === 'ready') return <>{children}</>;
  return <div className="first-run-overlay">
    <section className="first-run-dialog" role="dialog" aria-modal="true" aria-labelledby="first-run-title" aria-describedby="first-run-description" aria-busy={busy}>
      <h1 id="first-run-title">{LL.firstRun.title()}</h1>
      <p id="first-run-description">{LL.firstRun.description()}</p>
      {phase === 'choose' ? <form onSubmit={(event) => { event.preventDefault(); void confirm(); }}>
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
      </form> : !error && <p role="status">{LL.firstRun.loading()}</p>}
      {error && <p role="alert">{LL.firstRun.error()}</p>}
      {error && phase === 'loading' && <button type="button" onClick={() => { setError(false); setAttempt((value) => value + 1); }}>{LL.firstRun.retry()}</button>}
    </section>
  </div>;
}
