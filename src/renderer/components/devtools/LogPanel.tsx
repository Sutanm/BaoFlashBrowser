import React, { useCallback, useEffect, useRef } from 'react';
import type { DevToolEntry } from '@shared/types/devtoolbox';
import { useI18nContext } from '@renderer/i18n/i18n-react';

/**
 * 日志列表（捕获 / 主进程两个标签共用）。
 *
 * DOM 里最多渲染 600 行：Flash 页面一旦疯狂 console，全量渲染 2000 行会让
 * 每次 80ms 批量推送都变成一次长任务。完整历史仍留在 store 里，滚动到顶部
 * 时只是折叠更早的行，不丢数据。
 *
 * 求值不再放在这里：真 DevTools 已经在抽屉里，Console 由它负责。
 */
const MAX_ROWS = 600;

interface LogPanelProps {
  entries: DevToolEntry[];
  empty: string;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function levelColor(level: DevToolEntry['level']): string {
  if (level === 'error') return '#e5484d';
  if (level === 'warning') return '#d97706';
  if (level === 'verbose') return 'var(--text-secondary)';
  return 'var(--text-primary)';
}

const LogPanel: React.FC<LogPanelProps> = ({ entries, empty }) => {
  const { LL } = useI18nContext();
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = listRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [entries]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 min-h-0 overflow-auto px-3 py-2 font-mono text-[12px] leading-[1.7]"
        style={{ background: 'var(--bg-panel)' }}
      >
        {entries.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)' }}>{empty}</div>
        ) : (
          <>
            {entries.length > MAX_ROWS && (
              <div className="mb-1" style={{ color: 'var(--text-secondary)' }}>
                {LL.devtools.olderHidden({ count: entries.length - MAX_ROWS })}
              </div>
            )}
            {entries.slice(Math.max(0, entries.length - MAX_ROWS)).map((entry) => (
              <div key={entry.id} className="flex gap-2 break-all whitespace-pre-wrap">
                <span className="shrink-0" style={{ color: 'var(--text-secondary)' }}>{formatTime(entry.ts)}</span>
                <span style={{ color: levelColor(entry.level) }}>{entry.text}</span>
                {entry.origin && <span className="shrink-0" style={{ color: 'var(--text-secondary)' }}>{entry.origin}</span>}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
};

export default LogPanel;
