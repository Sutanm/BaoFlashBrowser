import React, { useState } from 'react';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import { PROJECT_PROVENANCE, PROVENANCE_SHORT_ID } from '@shared/provenance';
import { useI18nContext } from '@renderer/i18n/i18n-react';

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

function getHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

const NewTabPage: React.FC<NewTabPageProps> = ({ onNavigate, bookmarks }) => {
  const { LL } = useI18nContext();
  const [search, setSearch] = useState('');

  const handleSearch = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search.trim()) {
      onNavigate(search.trim());
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', height: 44, padding: '0 20px',
    border: '1px solid var(--border)', borderRadius: 22,
    fontSize: 16, outline: 'none',
    color: 'var(--text-primary)', background: 'var(--bg-input)',
    boxShadow: '0 1px 6px rgba(32,33,36,0.1), 0 0 0 1px rgba(32,33,36,0.05)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, position: 'relative', background: 'var(--bg-primary)', color: 'var(--text-primary)' }}>
      {/* Bookmarks bar at top */}
      {bookmarks.length > 0 && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0,
          display: 'flex', alignItems: 'center', gap: 2,
          padding: '4px 8px', background: 'var(--bg-secondary)',
          borderBottom: '1px solid var(--border)',
          overflowX: 'auto', whiteSpace: 'nowrap' as const, minHeight: 32,
        }}>
          {bookmarks.map((fav, i) => {
            const firstChar = (fav.title || fav.url).charAt(0).toUpperCase();
            const color = COLORS[i % COLORS.length];
            const imgSrc = fav.favicon || `https://www.google.com/s2/favicons?domain=${getHost(fav.url)}&sz=16`;
            return (
              <div
                key={fav.url}
                className="no-drag newtab-bookmark"
                onClick={() => onNavigate(fav.url)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 8px', borderRadius: 4,
                  cursor: 'pointer', fontSize: 12,
                  color: 'var(--text-secondary)', flexShrink: 0,
                }}
                title={fav.url}
              >
                {fav.favicon ? (
                  <img src={imgSrc} style={{ width: 16, height: 16, borderRadius: 3, flexShrink: 0 }} alt="" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div style={{
                    width: 16, height: 16, borderRadius: 3,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 10, fontWeight: 'bold', color: '#fff', flexShrink: 0,
                    background: color,
                  }}>{firstChar}</div>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 100 }}>{fav.title || fav.url}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Search box */}
      <div style={{ width: 560, maxWidth: '90vw', marginBottom: 40 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearch}
          placeholder={LL.newtab.searchPlaceholder()}
          className="no-drag"
          autoFocus
          spellCheck={false}
          style={inputStyle}
        />
      </div>

      {/* Quick links */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', maxWidth: 600 }}>
        {QUICK_LINKS.map((link) => (
          <div
            key={link.url}
            className="no-drag"
            onClick={() => onNavigate(link.url)}
            style={{
              width: 120, padding: '16px 8px', textAlign: 'center',
              borderRadius: 8, cursor: 'pointer',
            }}
          >
            <div style={{
              width: 40, height: 40, borderRadius: 8,
              margin: '0 auto 8px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, fontWeight: 'bold', color: '#fff',
              background: link.bg,
            }}>{link.icon}</div>
            <div style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
