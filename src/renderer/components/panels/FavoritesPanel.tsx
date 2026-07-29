import React, { useCallback } from 'react';
import { useAtom } from 'jotai';
import { X as XIcon, Globe } from 'lucide-react';
import { favoritesAtom } from '@renderer/atoms/data.atom';
import type { BookmarkEntry } from '@shared/types/bookmarks';

interface FavoritesPanelProps {
  visible: boolean;
  onClose: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
  currentUrl: string;
  currentTitle: string;
  currentFavicon: string;
}

const STORAGE_KEY = 'baoflash_favorites';

function loadFavorites(): BookmarkEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(favs: BookmarkEntry[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
}

function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getFaviconUrl(favicon: string | undefined, url: string): string {
  if (favicon) return favicon;
  const host = getHost(url);
  return `https://www.google.com/s2/favicons?domain=${host}&sz=16`;
}

const FavoritesPanel: React.FC<FavoritesPanelProps> = ({
  visible,
  onClose,
  onOpenUrl,
  currentUrl,
  currentTitle,
  currentFavicon,
}) => {
  const [favs, setFavs] = useAtom(favoritesAtom);

  React.useEffect(() => {
    setFavs(loadFavorites());
  }, [setFavs]);

  const isBookmarked = favs.some((f) => f.url === currentUrl && currentUrl && currentUrl !== 'about:newtab');

  const toggleBookmark = useCallback(() => {
    if (!currentUrl || currentUrl === 'about:newtab') return;
    const exists = favs.some((f) => f.url === currentUrl);
    const next = exists
      ? favs.filter((f) => f.url !== currentUrl)
      : [{ url: currentUrl, title: currentTitle || currentUrl, favicon: currentFavicon || undefined, addedAt: Date.now() }, ...favs];
    setFavs(next);
    saveFavorites(next);
  }, [currentUrl, currentTitle, currentFavicon, favs, setFavs]);

  const removeFav = useCallback((e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    const next = favs.filter((f) => f.url !== url);
    setFavs(next);
    saveFavorites(next);
  }, [favs, setFavs]);

  if (!visible) return null;

  return (
    <div className="panel-card">
      <div className="panel-header">
        <span>收藏夹</span>
        <button onClick={onClose} className="panel-close">&times;</button>
      </div>
      <div className="fav-add-bar">
        <button onClick={toggleBookmark} className="btn-secondary">
          {isBookmarked ? '★ 已收藏（点击取消）' : '☆ 添加当前页'}
        </button>
      </div>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        {favs.length === 0 ? (
          <div className="text-center py-6 text-xs" style={{ color: 'var(--text-secondary)' }}>
            暂无收藏
          </div>
        ) : (
          favs.map((f) => (
            <div
              key={f.url}
              className="fav-item"
              onClick={() => {
                onOpenUrl(f.url, currentUrl !== 'about:newtab');
                onClose();
              }}
              title={f.url}
            >
              <img
                src={getFaviconUrl(f.favicon, f.url)}
                className="w-4 h-4 flex-shrink-0"
                alt=""
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
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
    </div>
  );
};

export default FavoritesPanel;
