import React, { useCallback, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import TabBar from './components/tabs/TabBar';
import WebviewContainer from './components/tabs/WebviewContainer';
import NavigationBar from './components/navigation/NavigationBar';
import NewTabPage from './components/newtab/NewTabPage';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { favoritesAtom } from './atoms/data.atom';
import { normalizeUrl, generateId } from './services/id.service';
import type { TabState } from './atoms/tabs.atom';

const App: React.FC = () => {
  const { theme, toggle: toggleTheme } = useTheme();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
  const favorites = useAtomValue(favoritesAtom);
  const [isMuted, setIsMuted] = useState(false);
  const [showFavorites, setShowFavorites] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isOnNewTab = !activeTab || activeTab.url === 'about:newtab';

  // --- Tab management ---
  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const tab: TabState = {
      id, url: url || 'about:newtab', title: 'New Tab',
      zoomLevel: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }, [setTabs, setActiveTabId]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  }, [setTabs]);

  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  const updateTab = useCallback((tabId: string, changes: Partial<TabState>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...changes } : t)));
  }, [setTabs]);

  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url });
    setTimeout(() => {
      const el = document.querySelector(`#webview-container webview`) as any;
      if (el) el.loadURL(url);
    }, 50);
  }, [activeTabId, createTab, updateTab]);

  // --- Keyboard shortcuts ---
  useShortcut((action) => {
    switch (action) {
      case 'new-tab': createTab(); break;
      case 'close-tab': if (activeTabId) closeTab(activeTabId); break;
      case 'next-tab': {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
        break;
      }
      case 'prev-tab': {
        const idx = tabs.findIndex((t) => t.id === activeTabId);
        if (idx > 0) switchTab(tabs[idx - 1].id);
        break;
      }
      case 'reload':
      case 'stop-or-dismiss': {
        const el = document.querySelector(`#webview-container webview`) as any;
        if (el) action === 'reload' ? el.reload() : el.stop();
        break;
      }
      case 'fullscreen': window.electronAPI.win.setFullscreen(true); break;
      case 'devtools': {
        const el = document.querySelector(`#webview-container webview`) as any;
        if (el) el.openDevTools();
        break;
      }
      case 'bookmark': setShowFavorites((v) => !v); break;
      case 'history-panel': break;
    }
  });

  // --- Ctrl+1~9 ---
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= Math.min(9, tabs.length)) {
          e.preventDefault();
          switchTab(tabs[num - 1].id);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [tabs, switchTab]);

  // --- Theme ---
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // --- Initial tab ---
  React.useEffect(() => {
    if (tabs.length === 0) createTab();
  }, [tabs.length, createTab]);

  return (
    <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)' }}>
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={switchTab}
        onCloseTab={closeTab}
        onNewTab={() => createTab()}
        onToggleTheme={toggleTheme}
        isDark={theme === 'dark'}
      />

      <NavigationBar
        url={activeTab?.url || ''}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isMuted={isMuted}
        onNavigate={handleNavigate}
        onBack={() => { const el = document.querySelector(`#webview-container webview`) as any; if (el) el.goBack(); }}
        onForward={() => { const el = document.querySelector(`#webview-container webview`) as any; if (el) el.goForward(); }}
        onStop={() => { const el = document.querySelector(`#webview-container webview`) as any; if (el) el.stop(); }}
        onReload={() => { const el = document.querySelector(`#webview-container webview`) as any; if (el) el.reload(); }}
        onToggleMute={() => {
          setIsMuted((m) => {
            const el = document.querySelector(`#webview-container webview`) as any;
            if (el) el.setAudioMuted(!m);
            return !m;
          });
        }}
        onToggleFavorites={() => setShowFavorites((v) => !v)}
        onToggleSettings={() => setShowSettings((v) => !v)}
      />

      {isOnNewTab ? (
        <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
      ) : (
        <WebviewContainer tabs={tabs} activeTabId={activeTabId} onTabUpdate={updateTab} />
      )}
    </div>
  );
};

export default App;
