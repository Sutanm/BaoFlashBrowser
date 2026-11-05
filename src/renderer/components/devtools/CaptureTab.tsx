import React from 'react';
import type { DevToolEntry } from '@shared/types/devtoolbox';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import LogPanel from './LogPanel';

interface CaptureTabProps {
  entries: DevToolEntry[];
  cdpOwner: string | null;
  onRefresh: () => void;
}

const CaptureTab: React.FC<CaptureTabProps> = ({ entries, cdpOwner, onRefresh }) => {
  const { LL } = useI18nContext();
  const busy = Boolean(cdpOwner);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-2 px-3 py-1.5" style={{ borderBottom: '0.5px solid var(--border)', background: 'var(--bg-secondary)' }}>
        <span className="text-[11px] px-[6px] py-[2px] rounded" style={{
          background: busy ? 'var(--bg-tertiary)' : 'var(--bg-panel)',
          color: busy ? 'var(--accent)' : 'var(--text-secondary)',
          border: '0.5px solid var(--border)',
        }}>
          CDP: {cdpOwner ?? LL.devtools.cdpFree()}
        </span>
        <span className="text-[11px] min-w-0 truncate" style={{ color: 'var(--text-secondary)' }}>{LL.devtools.cdpNote()}</span>
        <button type="button" className="ml-auto shrink-0 text-[12px] px-2 py-[2px] rounded" style={{ border: '0.5px solid var(--border)', color: 'var(--text-primary)' }} onClick={onRefresh}>
          {LL.devtools.refresh()}
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <LogPanel
          entries={entries}
          empty={LL.devtools.emptyCapture()}
        />
      </div>
    </div>
  );
};

export default CaptureTab;
