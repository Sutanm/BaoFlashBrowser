import React from 'react';
import { ExternalLink, History, X } from 'lucide-react';
import { useI18nContext } from '../../i18n/i18n-react';
import type { AutomationWorkbench } from './useAutomationWorkbench';

type Props = Pick<
  AutomationWorkbench,
  'historyOpen' | 'historyScope' | 'persistedRunLogs' | 'persistedLogEntries' | 'backToHistoryList' | 'selectHistoryScope' | 'closeHistory' | 'openPersistedRunLog' | 'openPersistedRunLogFile'
>;

const LEVEL_KEY = { info: 'info', success: 'success', error: 'error' } as const;

function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 历史运行抽屉：内存里的 runStatus.logs 只保留最近 2 000 条，
 * 更早的记录走落盘 JSON（automation-logs/YYMMDD-HH-MM-脚本名-记录N.json）在这里回看。
 * 默认只看当前脚本，可切「全部脚本」——归属按日志首行的 packageId 判定。
 */
export function AutomationRunHistoryDrawer({
  historyOpen,
  historyScope,
  persistedRunLogs,
  persistedLogEntries,
  backToHistoryList,
  selectHistoryScope,
  closeHistory,
  openPersistedRunLog,
  openPersistedRunLogFile,
}: Props): React.JSX.Element | null {
  const { LL } = useI18nContext();
  const t = LL.automationWorkbench;
  if (!historyOpen) return null;
  return (
    <div className="awb-history-drawer" role="dialog" aria-label={t.runHistory()}>
      <div className="awb-history-head">
        <strong><History size={14} /> {t.runHistory()}</strong>
        <div className="awb-history-scope" role="group" aria-label={t.runHistory()}>
          <button
            type="button"
            aria-pressed={historyScope === 'current'}
            className={historyScope === 'current' ? 'awb-history-scope-active' : ''}
            onClick={() => void selectHistoryScope('current')}
          >
            {t.historyScopeCurrent()}
          </button>
          <button
            type="button"
            aria-pressed={historyScope === 'all'}
            className={historyScope === 'all' ? 'awb-history-scope-active' : ''}
            onClick={() => void selectHistoryScope('all')}
          >
            {t.historyScopeAll()}
          </button>
        </div>
        <button type="button" className="awb-history-close" onClick={closeHistory} aria-label={t.close()}>
          <X size={14} />
        </button>
      </div>
      {persistedLogEntries === null ? (
        persistedRunLogs.length ? (
          <ul className="awb-history-list">
            {persistedRunLogs.map((entry) => (
              <li key={entry.name}>
                <button type="button" onClick={() => void openPersistedRunLog(entry.name)} title={entry.name}>
                  <span className="awb-history-name">{entry.scriptName || entry.name}</span>
                  <small>{formatTime(entry.startedAt)} · {entry.sizeLabel}</small>
                </button>
                <button
                  type="button"
                  className="awb-history-open"
                  onClick={() => void openPersistedRunLogFile(entry.name)}
                  title={entry.name}
                  aria-label={t.openFile()}
                >
                  <ExternalLink size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="awb-history-empty">
            {historyScope === 'current' ? t.noPersistedRunLogsForScript() : t.noPersistedRunLogs()}
          </p>
        )
      ) : (
        <div className="awb-history-entries">
          <button type="button" className="awb-history-back" onClick={backToHistoryList} title={t.runHistory()}>
            ← {t.runHistory()}
          </button>
          <ul>
            {persistedLogEntries.map((entry, index) => (
              <li key={`${entry.timestamp}-${index}`} className={`level-${LEVEL_KEY[entry.level]}`}>
                <time>{formatTime(entry.timestamp)}</time>
                <p>{entry.message}</p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
