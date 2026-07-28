import React, { useCallback, useRef } from 'react';
import { useAtomValue } from 'jotai';
import TabBar from './components/tabs/TabBar';
import WebviewContainer from './components/tabs/WebviewContainer';
import NavigationBar from './components/navigation/NavigationBar';
import NewTabPage from './components/newtab/NewTabPage';
import WindowControls from './components/shell/WindowControls';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { useTabManager } from './services/tabs.service';
import { normalizeUrl } from './services/id.service';
import { favoritesAtom } from './atoms/data.atom';

const App: React.FC = () => {
  const { theme, toggle: toggleTheme } = useTheme();
  const { tabs, activeTabId, createTab, closeTab, switchTab, updateTab } = useTabManager();
  const favorites = useAtomValue(favoritesAtom);
  const addressBarRef = useRef<{ focus: () => void }>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isOnNewTab = !activeTab || activeTab.url === 'about:newtab';

  const handleNavigate = useCallback(
    (input: string) => {
      const url = normalizeUrl(input);
      if (activeTabId) {
        updateTab(activeTabId, { url });
        // Reload the webview by re-setting its src
        const webviewEl = document.querySelector(`#webview-container webview[data-tab-id="${activeTabId}"]`);
        if (webviewEl) {
          (webviewEl as any).loadURL(url);
        }
      }
    },
    [activeTabId, updateTab],
  );

  const handleNewTab = useCallback(() => {
    createTab('about:newtab');
  }, [createTab]);

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeTab(tabId);
    },
    [closeTab],
  );

  const handleShortcut = useCallback(
    (action: string) => {
      switch (action) {
        case 'new-tab':
          createTab('about:newtab');
          break;
        case 'close-tab':
          if (activeTabId) closeTab(activeTabId);
          break;
        case 'next-tab': {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
          else if (tabs.length > 0) switchTab(tabs[0].id);
          break;
        }
        case 'prev-tab': {
          const idx = tabs.findIndex((t) => t.id === activeTabId);
          if (idx > 0) switchTab(tabs[idx - 1].id);
          else if (tabs.length > 0) switchTab(tabs[tabs.length - 1].id);
          break;
        }
        case 'reload':
          if (activeTabId) {
            const el = document.querySelector(`#webview-container webview`);
            if (el) (el as any).reload();
          }
          break;
        case 'stop-or-dismiss':
          if (activeTabId) {
            const el = document.querySelector(`#webview-container webview`);
            if (el) (el as any).stop();
          }
          break;
        case 'focus-address':
          addressBarRef.current?.focus();
          break;
        case 'fullscreen':
          window.electronAPI.win.setFullscreen(true);
          break;
        case 'bookmark':
          if (activeTab) {
            toggleTheme(); // placeholder
          }
          break;
        case 'devtools':
          if (activeTabId) {
            const el = document.querySelector(`#webview-container webview`);
            if (el) (el as any).openDevTools();
          }
          break;
        case 'zoom-in':
        case 'zoom-out':
        case 'zoom-reset':
          break;
        default:
          break;
      }
    },
    [tabs, activeTabId, activeTab, createTab, closeTab, switchTab, toggleTheme],
  );

  useShortcut(handleShortcut);

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // Create initial tab if none
  React.useEffect(() => {
    if (tabs.length === 0) {
      createTab('about:newtab');
    }
  }, [tabs.length, createTab]);

  const switchTabHandle = useCallback((handler: number | string) => {
    if (typeof handler === 'string') {
      const idx = tabs.findIndex((t) => t.id === handler);
      if (idx >= 0) switchTab(handler);
    } else {
      const idx = handler - 1;
      if (idx >= 0 && idx < tabs.length) switchTab(tabs[idx].id);
    }
  }, [tabs, switchTab]);

  // Register Ctrl+1-9 handler
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9) {
          e.preventDefault();
          switchTabHandle(num);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [switchTabHandle]);

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden select-none">
      {/* Title bar */}
      <div className="h-9 bg-gray-200 dark:bg-gray-800 flex items-center justify-between px-3 drag-region shrink-0">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {activeTab?.title || 'BaoFlashBrowser'}
        </span>
        <div className="flex items-center gap-3">
          <button
            onClick={toggleTheme}
            className="text-xs px-2 py-0.5 rounded bg-gray-300 dark:bg-gray-700 hover:bg-gray-400 dark:hover:bg-gray-600 transition-colors no-drag"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
          <WindowControls />
        </div>
      </div>

      {/* Tab bar */}
      <TabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelectTab={switchTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
      />

      {/* Navigation bar */}
      <NavigationBar
        url={activeTab?.url || ''}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        onNavigate={handleNavigate}
        onBack={() => {
          const el = document.querySelector(`#webview-container webview`);
          if (el) (el as any).goBack();
        }}
        onForward={() => {
          const el = document.querySelector(`#webview-container webview`);
          if (el) (el as any).goForward();
        }}
        onStop={() => {
          const el = document.querySelector(`#webview-container webview`);
          if (el) (el as any).stop();
        }}
        onReload={() => {
          const el = document.querySelector(`#webview-container webview`);
          if (el) (el as any).reload();
        }}
      />

      {/* Content */}
      {isOnNewTab ? (
        <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
      ) : (
        <WebviewContainer
          tabs={tabs}
          activeTabId={activeTabId}
          onTabUpdate={updateTab}
        />
      )}
    </div>
  );
};

export default App;
