import React, { useCallback, useState, useEffect } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { X as XIcon, Search, Download, CheckCircle, XCircle } from 'lucide-react';
import { favoritesAtom, historyAtom, downloadsAtom, settingsAtom, defaultSettings } from '@renderer/atoms/data.atom';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

interface UnifiedSidebarProps {
  activePanel: string | null;
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
  onClose: () => void;
  onTogglePanel: (panel: string) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

type PanelId = 'bookmarks' | 'history' | 'downloads' | 'settings';

const PANELS: { id: PanelId; label: string; icon: string }[] = [
  { id: 'bookmarks', label: '收藏夹', icon: '⭐' },
  { id: 'history',   label: '历史记录', icon: '🕐' },
  { id: 'downloads', label: '下载', icon: '⬇' },
  { id: 'settings',  label: '设置', icon: '⚙' },
];

const UnifiedSidebar: React.FC<UnifiedSidebarProps> = ({
  activePanel, currentUrl, onOpenUrl, onClose, onTogglePanel,
  zoomPercent, onZoomIn, onZoomOut, onZoomReset,
}) => {
  const [selected, setSelected] = React.useState<PanelId>('bookmarks');

  const isExpanded = activePanel !== null;
  const panelId = (activePanel === 'favorites' ? 'bookmarks' :
                   activePanel === 'history' ? 'history' :
                   activePanel === 'downloads' ? 'downloads' :
                   activePanel === 'settings' ? 'settings' : null) as PanelId | null;

  React.useEffect(() => { if (panelId) setSelected(panelId); }, [panelId]);

  const icons = (
    <div className="sidebar-icons">
      {PANELS.map(p => (
        <button key={p.id} className={`sidebar-icon ${panelId === p.id ? 'active' : ''}`}
          title={p.label}
          onClick={() => {
            if (isExpanded && panelId === p.id) { onClose(); }
            else { onTogglePanel(p.id); }
          }}
        >{p.icon}</button>
      ))}
    </div>
  );

  if (!isExpanded) {
    return <div className="sidebar collapsed">{icons}</div>;
  }

  return (
    <div className="sidebar expanded">
      {icons}
      <div className="sidebar-panel">
        <div className="sidebar-panel-header">
          <span>{PANELS.find(p => p.id === selected)?.label}</span>
          <button onClick={onClose} className="panel-close-btn">&times;</button>
        </div>
        <div className="sidebar-panel-body">
          {selected === 'bookmarks' && <BookmarkContent onOpenUrl={onOpenUrl} currentUrl={currentUrl} />}
          {selected === 'history' && <HistoryContent onOpenUrl={onOpenUrl} currentUrl={currentUrl} />}
          {selected === 'downloads' && <DownloadContent />}
          {selected === 'settings' && (
            <SettingsContent
              zoomPercent={zoomPercent}
              onZoomIn={onZoomIn}
              onZoomOut={onZoomOut}
              onZoomReset={onZoomReset}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Favorites (ported from FavoritesPanel) ───────────────────────

function getHost(url: string): string { try { return new URL(url).hostname; } catch { return url; } }
function getFaviconUrl(favicon: string | undefined, url: string): string {
  if (favicon) return favicon;
  return `https://www.google.com/s2/favicons?domain=${getHost(url)}&sz=16`;
}

const BookmarkContent: React.FC<{ onOpenUrl: (url: string, newTab: boolean) => void; currentUrl: string }> =
  ({ onOpenUrl, currentUrl }) => {
    const [favs, setFavs] = useAtom(favoritesAtom);

    const isBookmarked = favs.some((f) => f.url === currentUrl && currentUrl && currentUrl !== 'about:newtab');

    const toggleBookmark = useCallback(() => {
      if (!currentUrl || currentUrl === 'about:newtab') return;
      const exists = favs.some((f) => f.url === currentUrl);
      const next = exists
        ? favs.filter((f) => f.url !== currentUrl)
        : [{ url: currentUrl, title: currentUrl, favicon: undefined, addedAt: Date.now() } as BookmarkEntry, ...favs];
      setFavs(next);
    }, [currentUrl, favs, setFavs]);

    const removeFav = useCallback((e: React.MouseEvent, url: string) => {
      e.stopPropagation();
      setFavs(favs.filter((f) => f.url !== url));
    }, [favs, setFavs]);

    return (
      <>
        <div className="fav-add-bar">
          <button onClick={toggleBookmark} className="btn-secondary">
            {isBookmarked ? '★ 已收藏（点击取消）' : '☆ 添加当前页'}
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {favs.length === 0 ? (
            <div className="sidebar-empty">暂无收藏</div>
          ) : (
            favs.map((f) => (
              <div key={f.url} className="fav-item"
                onClick={() => onOpenUrl(f.url, currentUrl !== 'about:newtab')}
                title={f.url}
              >
                <img src={getFaviconUrl(f.favicon, f.url)} className="w-4 h-4 flex-shrink-0" alt=""
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="fav-item-title">{f.title || f.url}</span>
                  <span className="fav-item-url">{f.url}</span>
                </div>
                <button onClick={(e) => removeFav(e, f.url)} className="fav-remove" title="删除">
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </>
    );
  };

// ─── History (ported from HistoryPanel) ──────────────────────────

type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'older';

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

const HistoryContent: React.FC<{ onOpenUrl: (url: string, newTab: boolean) => void; currentUrl: string }> =
  ({ onOpenUrl, currentUrl }) => {
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
      <>
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
      </>
    );
  };

// ─── Downloads (ported from DownloadsPanel) ─────────────────────

function formatFileSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

const DownloadContent: React.FC = () => {
  const [downloads, setDownloads] = useAtom(downloadsAtom);

  useEffect(() => {
    const cleanup = (window as any).electronAPI?.on('download:updated', (payload: any) => {
      setDownloads((prev) => {
        const exists = prev.find((d: DownloadItem) => d.id === payload.id);
        if (exists) {
          return prev.map((d: DownloadItem) => d.id === payload.id ? { ...d, ...payload } : d);
        }
        return [{ ...payload, id: payload.id }, ...prev];
      });
    });
    return () => { cleanup?.(); };
  }, [setDownloads]);

  const removeEntry = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.id !== id));
  }, [setDownloads]);

  const clearCompleted = useCallback(() => {
    setDownloads((prev) => prev.filter((d: DownloadItem) => d.state !== 'completed' && d.state !== 'cancelled'));
  }, [setDownloads]);

  const sorted = [...downloads].reverse();
  const hasCompleted = sorted.some((d: DownloadItem) => d.state === 'completed' || d.state === 'cancelled');

  return (
    <>
      {hasCompleted && (
        <div className="fav-add-bar">
          <button onClick={clearCompleted} className="btn-secondary">清除已完成</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {sorted.length === 0 ? (
          <div className="sidebar-empty">暂无下载</div>
        ) : (
          sorted.map((entry: DownloadItem) => (
            <div key={entry.id} className="download-item" title={entry.url}>
              <div className="download-icon">
                {entry.state === 'completed' ? (
                  <CheckCircle className="w-4 h-4" style={{ color: '#27ae60' }} />
                ) : entry.state === 'cancelled' || entry.state === 'interrupted' ? (
                  <XCircle className="w-4 h-4" style={{ color: '#e74c3c' }} />
                ) : (
                  <Download className="w-4 h-4" style={{ color: 'var(--accent)' }} />
                )}
              </div>
              <div className="download-info">
                <span className="download-filename">{entry.filename}</span>
                <span className="download-meta">
                  {entry.state === 'progressing' && entry.speed ? entry.speed + ' · ' : ''}
                  {entry.state === 'completed' ? '已完成' :
                   entry.state === 'cancelled' ? '已取消' :
                   entry.state === 'interrupted' ? '已中断' :
                   entry.progress + '%'}
                  {entry.totalBytes > 0 ? ' · ' + formatFileSize(entry.totalBytes) : ''}
                </span>
                {entry.state === 'progressing' && (
                  <div className="download-progress">
                    <div className="download-progress-bar" style={{ width: entry.progress + '%' }} />
                  </div>
                )}
              </div>
              <button onClick={(e) => removeEntry(e, entry.id)} className="fav-remove" title="删除">
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
};

// ─── Settings (ported from SettingsPanel) ────────────────────────

const SettingsContent: React.FC<{
  zoomPercent: number;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
}> = ({ zoomPercent, onZoomIn, onZoomOut, onZoomReset }) => {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [form, setForm] = useState<Settings>({ ...defaultSettings, ...settings });

  const handleChange = useCallback((key: keyof Settings, value: unknown) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    setSettings(form);
    (window as any).electronAPI?.invoke('save-config', {
      flashVersion: form.flashVersion,
      lowEndMode: form.lowEndMode,
    });
  }, [form, setSettings]);

  return (
    <div className="settings-body">
      <label>主页网址</label>
      <input
        type="text"
        value={form.homepage}
        onChange={(e) => handleChange('homepage', e.target.value)}
        placeholder="about:newtab"
      />

      <label>Flash 伪装版本</label>
      <input
        type="text"
        value={form.flashVersion}
        onChange={(e) => handleChange('flashVersion', e.target.value)}
        placeholder="34.0.0.330"
        pattern="^\\d+\\.\\d+\\.\\d+\\.\\d+$"
      />

      <label>链接打开方式</label>
      <select value={form.linkBehavior} onChange={(e) => handleChange('linkBehavior', e.target.value)}>
        <option value="new-tab">新标签页</option>
        <option value="current-page">当前页</option>
      </select>

      <label>搜索引擎</label>
      <select value={form.searchEngine} onChange={(e) => handleChange('searchEngine', e.target.value)}>
        <option value="bing">Bing</option>
        <option value="google">Google</option>
        <option value="baidu">百度</option>
      </select>

      <div className="setting-row">
        <span>低端设备模式</span>
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={form.lowEndMode}
            onChange={(e) => handleChange('lowEndMode', e.target.checked)}
          />
          <span className="toggle-slider" />
        </label>
      </div>
      <small className="setting-hint">减少 GPU 纹理缓存，改善长时间游玩 Flash 游戏卡顿。需重启应用生效。</small>

      <div className="setting-row">
        <span>页面缩放</span>
        <div className="zoom-controls">
          <button onClick={onZoomOut} className="btn-secondary zoom-btn" title="缩小 (Ctrl+-)">−</button>
          <span className="zoom-label">{zoomPercent}%</span>
          <button onClick={onZoomIn} className="btn-secondary zoom-btn" title="放大 (Ctrl++)">+</button>
          <button onClick={onZoomReset} className="btn-secondary zoom-btn" title="重置 (Ctrl+0)">重置</button>
        </div>
      </div>

      <button onClick={handleSave} className="btn-primary">保存</button>
    </div>
  );
};

export default UnifiedSidebar;
