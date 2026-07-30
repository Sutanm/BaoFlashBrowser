import React, { useCallback } from 'react';
import { useAtom } from 'jotai';
import { X as XIcon } from 'lucide-react';
import { favoritesAtom } from '@renderer/atoms/data.atom';
import type { BookmarkEntry } from '@shared/types/bookmarks';

interface FavoritesPanelProps {
  currentUrl: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
}

function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function getFaviconUrl(favicon: string | undefined, url: string): string {
  if (favicon) return favicon;
  return `https://www.google.com/s2/favicons?domain=${getHost(url)}&sz=16`;
}

const FavoritesPanel: React.FC<FavoritesPanelProps> = ({ currentUrl, onOpenUrl }) => {
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

export default FavoritesPanel;
