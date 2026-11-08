import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { UserscriptsPageState } from './useUserscriptsPage';

type Props = Pick<UserscriptsPageState, 'valuesPanel' | 'setValuesPanel' | 'saveValue' | 'deleteValue'> & {
  valuesPanel: NonNullable<UserscriptsPageState['valuesPanel']>;
};

export function UserscriptsValuesDialog({
  valuesPanel,
  setValuesPanel,
  saveValue,
  deleteValue,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, width: 540, maxHeight: '70vh', overflow: 'auto', color: 'var(--text-primary)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
          <span style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>{LL.userscript.values.title()}</span>
          <button type="button" onClick={() => setValuesPanel(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 16 }}>×</button>
        </div>
        {valuesPanel.error ? <p style={{ color: '#e5484d', fontSize: 12, marginBottom: 8 }}>{valuesPanel.error}</p> : null}
        {Object.keys(valuesPanel.values).length === 0 ? (
          <p style={{ opacity: 0.5, fontSize: 13 }}>{LL.userscript.values.empty()}</p>
        ) : (
          Object.entries(valuesPanel.values).map(([key, value]) => (
            <div key={key} style={{ border: '1px solid var(--border-light)', borderRadius: 8, padding: 8, marginBottom: 8 }}>
              {valuesPanel.dirty === key ? (
                <>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{key}</div>
                  <textarea
                    value={valuesPanel.draft}
                    onChange={(e) => setValuesPanel({ ...valuesPanel, draft: e.target.value })}
                    spellCheck={false}
                    style={{ width: '100%', height: 60, padding: 6, borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text-primary)', fontFamily: 'Consolas, monospace', fontSize: 12 }}
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                    <button type="button" onClick={() => void saveValue(key)} style={{ padding: '3px 10px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 12, border: 'none' }}>
                      {LL.userscript.values.save()}
                    </button>
                    <button type="button" onClick={() => setValuesPanel({ ...valuesPanel, dirty: null, draft: '', error: null })} style={{ padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}>
                      {LL.userscript.values.cancel()}
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600 }}>{key}</div>
                    <div style={{ fontSize: 12, opacity: 0.75, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'Consolas, monospace' }}>
                      {JSON.stringify(value)}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setValuesPanel({ ...valuesPanel, dirty: key, draft: JSON.stringify(value), error: null })}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: 12, flexShrink: 0 }}
                  >
                    {LL.userscript.values.edit()}
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteValue(key)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#e5484d', fontSize: 12, flexShrink: 0 }}
                  >
                    {LL.userscript.values.delete()}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
