import React, { useCallback } from 'react';
import { X as XIcon } from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useDataStore } from '@renderer/store/useDataStore';
import type { BookmarkEntry } from '@shared/types/bookmarks';

interface FavoritesPanelProps {
  currentUrl: string;
  currentTitle: string;
  currentFavicon?: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getFaviconUrl(favicon: string | undefined, url: string): string {
  if (favicon) return favicon;
  return `https://www.google.com/s2/favicons?domain=${getHost(url)}&sz=16`;
}

// 与标签栏收藏按钮保持一致：若 title 缺失或本身就是 http(s) URL，则退化为 hostname
function resolveBookmarkTitle(rawTitle: string, url: string): string {
  const fallback = rawTitle || url;
  if (/^https?:\/\//.test(fallback)) {
    try { return new URL(fallback).hostname; } catch { return fallback; }
  }
  return fallback;
}

const FavoritesPanel: React.FC<FavoritesPanelProps> = ({ currentUrl, currentTitle, currentFavicon, onOpenUrl }) => {
  const { LL } = useI18nContext();
  const favs = useDataStore((s) => s.favorites);
  const setFavs = useDataStore((s) => s.setFavorites);

  const isBookmarked = favs.some((f) => f.url === currentUrl && currentUrl && currentUrl !== 'about:newtab');

  const toggleBookmark = useCallback(() => {
    if (!currentUrl || currentUrl === 'about:newtab') return;
    const title = resolveBookmarkTitle(currentTitle, currentUrl);
    setFavs((prev) => {
      const exists = prev.some((f) => f.url === currentUrl);
      if (exists) return prev.filter((f) => f.url !== currentUrl);
      return [{ url: currentUrl, title, favicon: currentFavicon, addedAt: Date.now() } as BookmarkEntry, ...prev];
    });
  }, [currentUrl, currentTitle, currentFavicon, setFavs]);

  const removeFav = useCallback((e: React.MouseEvent, url: string) => {
    e.stopPropagation();
    setFavs((prev) => prev.filter((f) => f.url !== url));
  }, [setFavs]);

  return (
    <>
      <div className="fav-add-bar">
        <button onClick={toggleBookmark} className="btn-secondary">
          {isBookmarked ? LL.favorites.bookmarkRemove() : LL.favorites.bookmarkAdd()}
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {favs.length === 0 ? (
          <div className="sidebar-empty">{LL.favorites.empty()}</div>
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
              <button onClick={(e) => removeFav(e, f.url)} className="fav-remove" title={LL.delete()}>
                <XIcon className="w-3.5 h-3.5" />
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
};

export default FavoritesPanel;
