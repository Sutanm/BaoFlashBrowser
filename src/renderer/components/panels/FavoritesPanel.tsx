import React, { useCallback } from 'react';
import { useAtom } from 'jotai';
import { X as XIcon } from 'lucide-react';
import { favoritesAtom } from '@renderer/atoms/data.atom';

interface FavoritesPanelProps {
  visible: boolean;
  onClose: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
  currentUrl: string;
  currentTitle: string;
}

const STORAGE_KEY = 'baoflash_favorites';

function loadFavorites(): { url: string; title: string }[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFavorites(favs: { url: string; title: string }[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(favs));
}

const FavoritesPanel: React.FC<FavoritesPanelProps> = ({
  visible,
  onClose,
  onOpenUrl,
  currentUrl,
  currentTitle,
}) => {
  const [favs, setFavs] = useAtom(favoritesAtom);

  React.useEffect(() => {
    setFavs(loadFavorites());
  }, [setFavs]);

  const isBookmarked = favs.some((f) => f.url === currentUrl && currentUrl && currentUrl !== 'about:newtab');

  const toggleBookmark = useCallback(() => {
    if (!currentUrl || currentUrl === 'about:newtab') return;
    const next = favs.some((f) => f.url === currentUrl)
      ? favs.filter((f) => f.url !== currentUrl)
      : [{ url: currentUrl, title: currentTitle || currentUrl }, ...favs];
    setFavs(next);
    saveFavorites(next);
  }, [currentUrl, currentTitle, favs, setFavs]);

  const removeFav = useCallback((url: string) => {
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
          <div className="text-center py-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
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
            >
              <div className="min-w-0 flex-1">
                <div className="fav-item-title">{f.title || f.url}</div>
                <div className="fav-item-url">{f.url}</div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeFav(f.url);
                }}
                className="fav-remove"
                title="删除"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

export default FavoritesPanel;
