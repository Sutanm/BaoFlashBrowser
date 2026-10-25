import React, { useState } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { DEFAULT_PROXY, proxySettingsSchema, type ProxySettings, type ProxyTestResult } from '@shared/types/proxy';

export default function ProxySettingsCard({ value, onChange }: {
  value: ProxySettings;
  onChange: (proxy: ProxySettings) => void;
}) {
  const { LL } = useI18nContext();
  const text = LL.settings.proxy;
  const [url, setUrl] = useState('https://example.com/');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProxyTestResult | null>(null);
  const update = <K extends keyof ProxySettings>(key: K, next: ProxySettings[K]) => {
    setResult(null);
    onChange({
      ...value,
      // An invalid hidden port must not block saving system, direct or PAC mode.
      ...(key === 'mode' && (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535)
        ? { port: DEFAULT_PROXY.port } : {}),
      [key]: next,
    });
  };
  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const parsed = proxySettingsSchema.safeParse(value);
      const target = new URL(url);
      if (!parsed.success || !['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
        setResult({ ok: false, route: '', error: 'INVALID_CONFIG' });
        return;
      }
      setResult(await window.electronAPI.config.testProxy(parsed.data, url));
    } catch {
      setResult({ ok: false, route: '', error: 'INVALID_CONFIG' });
    } finally { setBusy(false); }
  };

  return (
    <div className="panel-card settings-section-card">
      <div className="panel-card-title">{text.title()}</div>
      <p className="field-hint">{text.hint()}</p>
      <div className="field">
        <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-mode">{text.mode()}</label>
        <select id="proxy-mode" className="input-text" style={{ width: '100%' }} disabled={busy} value={value.mode} onChange={(e) => update('mode', e.target.value as ProxySettings['mode'])}>
          <option value="system">{text.system()}</option>
          <option value="direct">{text.direct()}</option>
          <option value="manual">{text.manual()}</option>
          <option value="pac">{text.pac()}</option>
        </select>
      </div>
      {value.mode === 'manual' && <>
        <div className="field">
          <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-protocol">{text.protocol()}</label>
          <select id="proxy-protocol" className="input-text" disabled={busy} value={value.protocol} onChange={(e) => update('protocol', e.target.value as ProxySettings['protocol'])}>
            <option value="http">HTTP</option><option value="socks5">SOCKS5</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-host">{text.host()}</label>
          <input id="proxy-host" className="input-text" style={{ width: '100%' }} disabled={busy} value={value.host} placeholder="127.0.0.1" maxLength={253} onChange={(e) => update('host', e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-port">{text.port()}</label>
          <input id="proxy-port" className="input-text" type="number" min={1} max={65535} disabled={busy} value={value.port || ''} onChange={(e) => update('port', Number(e.target.value))} />
        </div>
        <div className="field">
          <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-bypass">{text.bypass()}</label>
          <input id="proxy-bypass" className="input-text" style={{ width: '100%' }} disabled={busy} value={value.bypass} placeholder="*.example.com;192.168.0.0/16" maxLength={4096} onChange={(e) => update('bypass', e.target.value)} />
          <div className="field-hint">{text.bypassHint()}</div>
        </div>
      </>}
      {value.mode === 'pac' && <div className="field">
        <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-pac">{text.pacUrl()}</label>
        <input id="proxy-pac" className="input-text" style={{ width: '100%' }} disabled={busy} value={value.pacUrl} placeholder="http://127.0.0.1:7890/proxy.pac" maxLength={2048} onChange={(e) => update('pacUrl', e.target.value)} />
      </div>}
      <p className="field-hint">{text.downloadHint()}</p>
      <p className="field-hint">{text.authHint()}</p>
      <div className="field">
        <label className="field-label" style={{ display: 'block' }} htmlFor="proxy-test-url">{text.testUrl()}</label>
        <input id="proxy-test-url" className="input-text" style={{ width: '100%' }} disabled={busy} value={url} maxLength={2048} onChange={(e) => { setUrl(e.target.value); setResult(null); }} />
      </div>
      <button type="button" className="input-text" disabled={busy} onClick={() => void test()}>{busy ? text.testing() : text.test()}</button>
      <p className="field-hint">{text.testHint()}</p>
      {result && <div role="status" style={{ overflowWrap: 'anywhere' }}>
        <div>{result.ok ? text.success() : text.failure()}</div>
        {result.route && <div>{text.route()}: {result.route}</div>}
        {result.statusCode && <div>HTTP {result.statusCode}</div>}
        {result.error && <div>{result.error === 'INVALID_CONFIG' ? text.invalid() : result.error === 'PROXY_AUTH_REQUIRED' ? text.authHint() : result.error === 'TIMEOUT' ? text.timeout() : result.error === 'TEST_LIMIT' ? text.testLimit() : text.networkError()}</div>}
      </div>}
    </div>
  );
}
