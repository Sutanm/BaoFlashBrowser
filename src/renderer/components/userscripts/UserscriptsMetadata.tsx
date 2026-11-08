import React from 'react';
import type { ParsedUserscriptMetadata } from '@shared/userscript-types';
import { useI18nContext } from '@renderer/i18n/i18n-react';

export function StatusBadge({ enabled }: { enabled: boolean }): React.JSX.Element {
  const { LL } = useI18nContext();
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 999,
        fontWeight: 600,
        color: enabled ? '#0e8345' : 'var(--text-secondary)',
        background: enabled ? 'rgba(14,131,69,0.12)' : 'var(--bg-tertiary)',
      }}
    >
      {enabled ? LL.userscript.statusRunning() : LL.userscript.statusDisabled()}
    </span>
  );
}

export function MatchSummary({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const { LL } = useI18nContext();
  const matches = metadata.match.length > 0 ? metadata.match : metadata.include;
  const text = matches.length > 0 ? matches.join('  ') : (metadata.noframes ? LL.userscript.matchAllPages() : LL.userscript.matchNone());
  return <span style={{ fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>;
}

export function PermissionRows({ metadata }: { metadata: ParsedUserscriptMetadata }): React.JSX.Element {
  const { LL } = useI18nContext();
  const rows: Array<[string, string]> = [];
  if (metadata.grant.length > 0) rows.push([LL.userscript.permission(), metadata.grant.join(', ')]);
  if (metadata.connect.length > 0) rows.push([LL.userscript.permissionCrossOrigin(), metadata.connect.join(', ')]);
  if (metadata.require.length > 0) rows.push([LL.userscript.permissionExternalScript(), metadata.require.join(' ')]);
  if (metadata.resource.length > 0) rows.push([LL.userscript.permissionResources(), metadata.resource.map((r) => r.name ?? r.url).join(', ')]);
  if (rows.length === 0) return <div style={{ opacity: 0.5, fontSize: 12 }}>{LL.userscript.permissionNone()}</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12, opacity: 0.75 }}>
      {rows.map(([key, value]) => (
        <div key={key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600, marginRight: 6 }}>{key}</span>
          <span>{value}</span>
        </div>
      ))}
    </div>
  );
}
