import React, { useCallback, useState } from 'react';
import { useAtom, useSetAtom } from 'jotai';
import { X as XIcon, Search } from 'lucide-react';
import dayjs from 'dayjs';
import { historyAtom, pushToastAtom } from '@renderer/atoms/data.atom';
import type { HistoryEntry } from '@shared/types/history';

interface HistoryPanelProps {
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older';

function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getDateGroup(ts: number): DateGroup {
  const t = dayjs(ts);
  const now = dayjs();
  if (t.isSame(now, 'day')) return 'today';
  if (t.isSame(now.subtract(1, 'day'), 'day')) return 'yesterday';
  if (t.isAfter(now.subtract(7, 'day'))) return 'thisWeek';
  return 'older';
}

const GROUP_LABELS: Record<DateGroup, string> = { today: '今天', yesterday: '昨天', thisWeek: '本周', older: '更早' };

function formatTime(ts: number): string {
  return dayjs(ts).format('HH:mm');
}

function getHistFaviconUrl(entry: HistoryEntry): string {
  if (entry.favicon) return entry.favicon;
  return `https://www.google.com/s2/favicons?domain=${getHost(entry.url)}&sz=16`;
}

const HistoryPanel: React.FC<HistoryPanelProps> = ({ currentUrl, onOpenUrl }) => {
  const [history, setHistory] = useAtom(historyAtom);
  const pushToast = useSetAtom(pushToastAtom);
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setHistory((prev) => prev.filter((h) => h.id !== id));
  }, [setHistory]);

  const sorted = [...history]
    .filter((h) => {
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q);
    })
    .sort((a, b) => b.lastVisit - a.lastVisit);

  const clearAll = useCallback(() => {
    setHistory([]);
    setConfirmClear(false);
    pushToast({ message: '历史记录已清空', type: 'info' });
  }, [setHistory, pushToast]);

  const groups = new Map<DateGroup, HistoryEntry[]>();
  for (const entry of sorted) {
    const g = getDateGroup(entry.lastVisit);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(entry);
  }

  const orderedGroups: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'older'];
  const hasAny = sorted.length > 0;

  return (
    <div className="flex flex-col h-full">
      <div className="history-search-bar">
        <Search className="w-3.5 h-3.5" style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
        <input
          type="text"
          placeholder="搜索历史记录"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="history-search-input"
        />
        {hasAny && !confirmClear && (
          <button onClick={() => setConfirmClear(true)} className="history-clear-btn">清空</button>
        )}
      </div>
      {confirmClear && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          padding: '10px 12px', background: 'var(--bg-hover)', borderRadius: 8,
          margin: '0 8px 4px', fontSize: 13, flexShrink: 0,
        }}>
          <span style={{ color: 'var(--text-primary)', whiteSpace: 'nowrap' }}>清空所有历史记录？</span>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <button
              onClick={clearAll}
              style={{
                padding: '4px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: '#e81123', color: '#fff', fontSize: 12, whiteSpace: 'nowrap',
              }}
            >
              清空
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              style={{
                padding: '4px 14px', borderRadius: 6, border: 'none', cursor: 'pointer',
                background: 'var(--border)', color: 'var(--text-primary)', fontSize: 12, whiteSpace: 'nowrap',
              }}
            >
              取消
            </button>
          </div>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!hasAny ? (
          <div className="sidebar-empty">暂无历史记录</div>
        ) : (
          orderedGroups.map((group) => {
            const entries = groups.get(group);
            if (!entries || entries.length === 0) return null;
            return (
              <div key={group}>
                <div className="history-group-header">{GROUP_LABELS[group]}</div>
                {entries.map((entry) => (
                  <div
                    key={entry.id}
                    className="fav-item"
                    onClick={() => {
                      onOpenUrl(entry.url, currentUrl !== 'about:newtab');
                    }}
                    title={entry.url}
                  >
                    <img
                      src={getHistFaviconUrl(entry)}
                      style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }}
                      alt=""
                      onError={(e) => { (e.target as HTMLImageElement).src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="%23e0e0e0"/></svg>'; }}
                    />
                    <div className="flex flex-col min-w-0 flex-1">
                      <span className="fav-item-title">{entry.title || getHost(entry.url)}</span>
                      <span className="fav-item-url">
                        {getHost(entry.url)} · {formatTime(entry.lastVisit)}
                        {entry.visitCount > 1 ? ` · ${entry.visitCount} 次访问` : ''}
                      </span>
                    </div>
                    <button onClick={(e) => removeEntry(e, entry.id)} className="fav-remove" title="删除">
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default HistoryPanel;
