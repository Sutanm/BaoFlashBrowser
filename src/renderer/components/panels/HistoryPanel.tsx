import React, { useCallback, useState } from 'react';
import { useAtom } from 'jotai';
import { X as XIcon, Search } from 'lucide-react';
import { historyAtom } from '@renderer/atoms/data.atom';
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
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const weekStart = todayStart - 6 * 86400000;
  if (ts >= todayStart) return 'today';
  if (ts >= yesterdayStart) return 'yesterday';
  if (ts >= weekStart) return 'thisWeek';
  return 'older';
}

const GROUP_LABELS: Record<DateGroup, string> = { today: '今天', yesterday: '昨天', thisWeek: '更早', older: '更早' };

function formatTime(ts: number): string {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function getHistFaviconUrl(entry: HistoryEntry): string {
  if (entry.favicon) return entry.favicon;
  return `https://www.google.com/s2/favicons?domain=${getHost(entry.url)}&sz=16`;
}

const HistoryPanel: React.FC<HistoryPanelProps> = ({ currentUrl, onOpenUrl }) => {
  const [history, setHistory] = useAtom(historyAtom);
  const [filter, setFilter] = useState('');

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setHistory(history.filter((h) => h.id !== id));
  }, [history, setHistory]);

  const clearAll = useCallback(() => {
    setHistory([]);
  }, [setHistory]);

  const sorted = [...history]
    .filter((h) => {
      if (!filter.trim()) return true;
      const q = filter.toLowerCase();
      return h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q);
    })
    .sort((a, b) => b.lastVisit - a.lastVisit);

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
        {hasAny && (
          <button onClick={clearAll} className="history-clear-btn">清空</button>
        )}
      </div>
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
