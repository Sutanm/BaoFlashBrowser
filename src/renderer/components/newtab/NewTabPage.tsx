import React, { useState } from 'react';

interface NewTabPageProps {
  onNavigate: (url: string) => void;
  bookmarks: { title: string; url: string }[];
}

const QUICK_LINKS = [
  { title: '4399', url: 'https://www.4399.com/', color: '#ff6b35' },
  { title: '7k7k', url: 'https://www.7k7k.com/', color: '#4ecdc4' },
  { title: 'Bing', url: 'https://cn.bing.com/', color: '#00897b' },
  { title: 'Baidu', url: 'https://www.baidu.com/', color: '#2932e1' },
  { title: 'GitHub', url: 'https://github.com/', color: '#333' },
  { title: 'Bilibili', url: 'https://www.bilibili.com/', color: '#fb7299' },
];

const NewTabPage: React.FC<NewTabPageProps> = ({ onNavigate, bookmarks }) => {
  const [search, setSearch] = useState('');

  const handleSearch = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && search.trim()) {
      onNavigate(search.trim());
    }
  };

  const handleQuickLink = (url: string) => {
    onNavigate(url);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-gray-900 px-4">
      {/* Bookmarks bar */}
      {bookmarks.length > 0 && (
        <div className="flex gap-2 mb-8 flex-wrap justify-center max-w-lg">
          {bookmarks.map((bm) => (
            <button
              key={bm.url}
              onClick={() => handleQuickLink(bm.url)}
              className="px-3 py-1 text-xs rounded-full bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors truncate max-w-[160px] no-drag"
              title={bm.title}
            >
              ⭐ {bm.title}
            </button>
          ))}
        </div>
      )}

      {/* Logo / Title */}
      <h1 className="text-3xl font-light text-gray-300 dark:text-gray-600 mb-8 select-none">
        BaoFlashBrowser
      </h1>

      {/* Search box */}
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        onKeyDown={handleSearch}
        placeholder="Search or enter address"
        className="w-full max-w-lg h-10 px-5 text-sm rounded-full bg-gray-100 dark:bg-gray-800 border border-transparent focus:border-blue-400 dark:focus:border-blue-500 outline-none transition-colors text-gray-700 dark:text-gray-200 placeholder-gray-400 no-drag"
        autoFocus
        spellCheck={false}
      />

      {/* Quick links */}
      <div className="flex gap-3 mt-10 flex-wrap justify-center">
        {QUICK_LINKS.map((link) => (
          <button
            key={link.url}
            onClick={() => handleQuickLink(link.url)}
            className="w-20 h-20 rounded-2xl flex flex-col items-center justify-center gap-1 transition-transform hover:scale-105 no-drag"
            style={{ backgroundColor: link.color }}
          >
            <span className="text-white text-xs font-medium">{link.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default NewTabPage;
