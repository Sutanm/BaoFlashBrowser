import React, { useState } from 'react';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import { PROJECT_PROVENANCE, PROVENANCE_SHORT_ID } from '@shared/provenance';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { getHost } from '@renderer/services/url-utils';

interface NewTabPageProps {
  onNavigate: (url: string) => void;
  bookmarks: BookmarkEntry[];
}

const COLORS = ['#e67e22', '#e74c3c', '#3498db', '#27ae60', '#9b59b6', '#1abc9c'];

const QUICK_LINKS = [
  { title: '7k7k', url: 'https://www.7k7k.com/', icon: '7', bg: '#e67e22' },
  { title: '4399', url: 'https://www.4399.com/', icon: '4', bg: '#e74c3c' },
  { title: 'Bing', url: 'https://www.bing.com/', icon: 'B', bg: '#00897b' },
  { title: '百度', url: 'https://www.baidu.com/', icon: '百', bg: '#3498db' },
  { title: 'GitHub', url: 'https://github.com/', icon: 'G', bg: '#333' },
  { title: 'B站', url: 'https://www.bilibili.com/', icon: 'B', bg: '#fb7299' },
];

const NewTabPage: React.FC<NewTabPageProps> = ({ onNavigate, bookmarks }) => {
  const { LL } = useI18nContext();
  const [search, setSearch] = useState('');

  const handleSearch = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search.trim()) {
      onNavigate(search.trim());
    }
  };

  return (
    <div className="newtab-shell">
      {/* Bookmarks bar at top */}
      {bookmarks.length > 0 && (
        <div className="newtab-bookmarks-bar">
          {bookmarks.map((fav, i) => {
            const firstChar = (fav.title || fav.url).charAt(0).toUpperCase();
            const color = COLORS[i % COLORS.length];
            const imgSrc = fav.favicon || `https://www.google.com/s2/favicons?domain=${getHost(fav.url)}&sz=16`;
            return (
              <div
                key={fav.url}
                className="no-drag newtab-bookmark"
                onClick={() => onNavigate(fav.url)}
                title={fav.url}
              >
                {fav.favicon ? (
                  <img src={imgSrc} className="newtab-bookmark-favicon" alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="newtab-bookmark-fallback" style={{ background: color }}>{firstChar}</div>
                )}
                <span className="newtab-bookmark-title">{fav.title || fav.url}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Search box */}
      <div className="newtab-search-wrap">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearch}
          placeholder={LL.newtab.searchPlaceholder()}
          className="no-drag newtab-search-input"
          autoFocus
          spellCheck={false}
        />
      </div>

      {/* Quick links */}
      <div className="newtab-links">
        {QUICK_LINKS.map((link) => (
          <div
            key={link.url}
            className="no-drag newtab-link"
            onClick={() => onNavigate(link.url)}
          >
            <div className="newtab-link-icon" style={{ background: link.bg }}>{link.icon}</div>
            <div className="newtab-link-title">
              {link.title}
            </div>
          </div>
        ))}
      </div>

      <div
        className="newtab-author-mark"
        data-origin={PROVENANCE_SHORT_ID}
        aria-label={`Created by ${PROJECT_PROVENANCE.author}`}
        title={`Created by ${PROJECT_PROVENANCE.author} · ${PROVENANCE_SHORT_ID}`}
      >
        {PROJECT_PROVENANCE.author}
      </div>
    </div>
  );
};

export default NewTabPage;
