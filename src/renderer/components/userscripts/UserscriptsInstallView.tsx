import React from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { MatchSummary, PermissionRows } from './UserscriptsMetadata';
import type { UserscriptsPageState } from './useUserscriptsPage';

type Props = Pick<UserscriptsPageState, 'install' | 'requestSection' | 'confirmInstall'> & {
  install: NonNullable<UserscriptsPageState['install']>;
};

export function UserscriptsInstallView({
  install,
  requestSection,
  confirmInstall,
}: Props): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 20, background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <button type="button" style={{ padding: '4px 12px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer' }} onClick={() => requestSection('installed', null)}>
          {LL.userscript.backToList()}
        </button>
        <h1 style={{ fontSize: 18, fontWeight: 700, flex: 1 }}>{LL.userscript.installConfirm()}</h1>
        {install.metadata ? (
          <button type="button" style={{ padding: '6px 16px', borderRadius: 6, background: 'var(--accent)', color: '#fff', cursor: 'pointer' }} onClick={() => void confirmInstall()}>
            {LL.userscript.install()}
          </button>
        ) : null}
      </div>
      <p style={{ opacity: 0.6, fontSize: 13, marginBottom: 12 }}>{LL.userscript.installSource({ from: install.from })}</p>
      {install.error ? (
        <p style={{ color: '#e5484d' }}>{install.error}</p>
      ) : install.metadata ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 720 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18, fontWeight: 700 }}>{install.metadata.name}</span>
            {install.metadata.version ? <span style={{ opacity: 0.6, fontSize: 12 }}>v{install.metadata.version}</span> : null}
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 999, fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-tertiary)' }}>{LL.userscript.installBadge()}</span>
          </div>
          {install.metadata.namespace ? <div style={{ opacity: 0.6, fontSize: 12 }}>{install.metadata.namespace}</div> : null}
          {install.metadata.description ? <div style={{ fontSize: 13 }}>{install.metadata.description}</div> : null}
          <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div><span style={{ fontWeight: 600, marginRight: 8 }}>{LL.userscript.installMatchScope()}</span><MatchSummary metadata={install.metadata} /></div>
            <PermissionRows metadata={install.metadata} />
          </div>
          <p style={{ opacity: 0.5, fontSize: 12, marginTop: 8 }}>{LL.userscript.installWarning()}</p>
        </div>
      ) : null}
    </div>
  );
}
