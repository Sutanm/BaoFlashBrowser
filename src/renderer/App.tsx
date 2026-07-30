import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import TabBar from './components/tabs/TabBar';
import WebviewContainer from './components/tabs/WebviewContainer';
import NavigationBar from './components/navigation/NavigationBar';
import NewTabPage from './components/newtab/NewTabPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import ZoomOverlay from './components/overlays/ZoomOverlay';
import FavoritesPanel from './components/panels/FavoritesPanel';
import SettingsPanel from './components/panels/SettingsPanel';
import HistoryPanel from './components/panels/HistoryPanel';
import DownloadsPanel from './components/panels/DownloadsPanel';
import ContextMenu from './components/overlays/ContextMenu';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { favoritesAtom } from './atoms/data.atom';
import { normalizeUrl, generateId } from './services/id.service';
import type { TabState } from './atoms/tabs.atom';

const NEWTAB_URL = 'about:newtab';

function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL;
}

function displayUrl(url: string): string {
  return isNewtabUrl(url) ? '' : url;
}

const App: React.FC = () => {
  const { theme, toggle: toggleTheme } = useTheme();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);
  const favorites = useAtomValue(favoritesAtom);
  const [isMuted, setIsMuted] = useState(false);
  const [activePanel, setActivePanel] = useState<'favorites' | 'history' | 'downloads' | 'settings' | null>(null);
  const [showZoom, setShowZoom] = useState(false);
  const [zoomPercent, setZoomPercent] = useState(100);
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [addressUrl, setAddressUrl] = useState('');

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isOnNewTab = !activeTab || activeTab.url === NEWTAB_URL;

  const activeWebview = useCallback(() => {
    if (!activeTabId) return null;
    return document.querySelector('#webview-container webview.active') as any;
  }, [activeTabId]);

  // --- Tab management ---
  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const tab: TabState = {
      id, url: url || NEWTAB_URL, title: '新标签页',
      zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
  }, [setTabs, setActiveTabId]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = [...prev];
      next.splice(idx, 1);
      // If closing the active tab, switch to a sibling
      if (tabId === activeTabId) {
        if (next.length > 0) {
          const newIdx = Math.min(idx, next.length - 1);
          setActiveTabId(next[newIdx].id);
        } else {
          setActiveTabId(null);
        }
      }
      return next;
    });
  }, [activeTabId, setActiveTabId, setTabs]);

  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, [setActiveTabId]);

  const updateTab = useCallback((tabId: string, changes: Partial<TabState>) => {
    setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, ...changes } : t)));
    // If this is the active tab, sync address bar from the update
    if (tabId === activeTabId && changes.url !== undefined) {
      const url = changes.url;
      if (isNewtabUrl(url)) {
        setAddressUrl('');
      } else {
        setAddressUrl(url);
      }
    }
  }, [setTabs, activeTabId]);

  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url });
    setAddressUrl(url);
    const el = document.querySelector('#webview-container webview.active') as any;
    if (el) el.loadURL(url);
  }, [activeTabId, createTab, updateTab]);

  // --- Zoom ---
  const showZoomOverlay = useCallback((level: number) => {
    setZoomPercent(Math.round(level * 100));
    setShowZoom(true);
    if (zoomTimerRef.current) clearTimeout(zoomTimerRef.current);
    zoomTimerRef.current = setTimeout(() => setShowZoom(false), 1500);
  }, []);

  const doZoom = useCallback((delta: number) => {
    if (!activeTab) return;
    const lvl = Math.min(5, Math.max(0.25, activeTab.zoomFactor + delta));
    const el = activeWebview();
    if (el) el.setZoomFactor(lvl);
    updateTab(activeTab.id, { zoomFactor: lvl });
    showZoomOverlay(lvl);
  }, [activeTab, updateTab, showZoomOverlay, activeWebview]);

  const zoomIn = useCallback(() => doZoom(0.25), [doZoom]);
  const zoomOut = useCallback(() => doZoom(-0.25), [doZoom]);
  const zoomReset = useCallback(() => {
    if (!activeTab) return;
    const el = activeWebview();
    if (el) el.setZoomFactor(1);
    updateTab(activeTab.id, { zoomFactor: 1 });
    showZoomOverlay(1);
  }, [activeTab, updateTab, showZoomOverlay, activeWebview]);

  // --- Keyboard shortcuts ---
  useShortcut((action) => {
    switch (action) {
      case 'new-tab': createTab(); break;
      case 'close-tab': if (activeTabId) closeTab(activeTabId); break;
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
      case 'stop-or-dismiss': {
        const el = activeWebview();
        if (el) action === 'reload' ? el.reload() : el.stop();
        break;
      }
      case 'fullscreen': window.electronAPI.win.setFullscreen(true); break;
      case 'devtools': {
        const el = activeWebview();
        if (el) el.openDevTools();
        break;
      }
      case 'bookmark': setActivePanel((v) => v === 'favorites' ? null : 'favorites'); break;
      case 'history-panel': setActivePanel((v) => v === 'history' ? null : 'history'); break;
      case 'zoom-in': zoomIn(); break;
      case 'zoom-out': zoomOut(); break;
      case 'zoom-reset': zoomReset(); break;
      case 'go-back': { const el = activeWebview(); if (el) el.goBack(); break; }
      case 'go-forward': { const el = activeWebview(); if (el) el.goForward(); break; }
    }
  });

  // --- Ctrl+wheel zoom (chrome UI area) ---
  useEffect(() => {
    const handler = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      doZoom(e.deltaY < 0 ? 0.25 : -0.25);
    };
    window.addEventListener('wheel', handler, { passive: false });
    return () => window.removeEventListener('wheel', handler);
  }, [doZoom]);
  useEffect(() => {
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

  // --- External URL open (new-window → new tab) ---
  useEffect(() => {
    const unsub = window.electronAPI.on('navigate-url', (url: any) => {
      createTab(String(url));
    });
    return () => { try { unsub(); } catch (_) {} };
  }, [createTab]);

  // --- Theme ---
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  // --- Initial tab when none exist or no active tab ---
  useEffect(() => {
    if (tabs.length === 0 || activeTabId === null) {
      if (tabs.length === 0) {
        createTab();
      } else {
        setActiveTabId(tabs[0].id);
      }
    }
  }, [tabs.length, activeTabId, createTab, setActiveTabId, tabs]);

  // --- Sync address bar when active tab changes ---
  useEffect(() => {
    if (activeTab) {
      setAddressUrl(displayUrl(activeTab.url));
    }
  }, [activeTabId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="h-full flex flex-col relative" style={{ background: 'var(--bg-primary)' }}>
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
        url={addressUrl}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isMuted={isMuted}
        isBookmarked={activeTab ? favorites.some((f) => f.url === activeTab.url && activeTab.url !== 'about:newtab') : false}
        onNavigate={handleNavigate}
        onBack={() => { const el = activeWebview(); if (el) el.goBack(); }}
        onForward={() => { const el = activeWebview(); if (el) el.goForward(); }}
        onStop={() => { const el = activeWebview(); if (el) el.stop(); }}
        onReload={() => { const el = activeWebview(); if (el) el.reload(); }}
        onToggleMute={() => {
          setIsMuted((m) => {
            const el = activeWebview();
            if (el) el.setAudioMuted(!m);
            return !m;
          });
        }}
        onToggleFavorites={() => setActivePanel((v) => v === 'favorites' ? null : 'favorites')}
        onToggleHistory={() => setActivePanel((v) => v === 'history' ? null : 'history')}
        onToggleDownloads={() => setActivePanel((v) => v === 'downloads' ? null : 'downloads')}
        onToggleSettings={() => setActivePanel((v) => v === 'settings' ? null : 'settings')}
      />

      <div style={{ display: isOnNewTab ? 'flex' : 'none', flex: '1 1 0%', flexDirection: 'column' }}>
        <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
      </div>
      <div style={{ display: isOnNewTab ? 'none' : 'flex', flex: '1 1 0%' }}>
        <WebviewContainer tabs={tabs} activeTabId={activeTabId} onTabUpdate={updateTab} />
      </div>
      <LoadingProgress visible={activeTab?.isLoading ?? false} />
      <ZoomOverlay level={zoomPercent / 100} visible={showZoom} />
      <FavoritesPanel
        visible={activePanel === 'favorites'}
        onClose={() => setActivePanel(null)}
        onOpenUrl={(url, newTab) => {
          if (newTab || activeTab?.url !== 'about:newtab') {
            createTab(url);
          } else {
            handleNavigate(url);
          }
        }}
        currentUrl={activeTab?.url || ''}
        currentTitle={activeTab?.title || ''}
        currentFavicon={activeTab?.favicon || ''}
      />
      <HistoryPanel
        visible={activePanel === 'history'}
        onClose={() => setActivePanel(null)}
        onOpenUrl={(url, newTab) => {
          if (newTab || activeTab?.url !== 'about:newtab') {
            createTab(url);
          } else {
            handleNavigate(url);
          }
        }}
        currentUrl={activeTab?.url || ''}
      />
      <DownloadsPanel
        visible={activePanel === 'downloads'}
        onClose={() => setActivePanel(null)}
      />
      <SettingsPanel
        visible={activePanel === 'settings'}
        onClose={() => setActivePanel(null)}
        currentZoom={activeTab?.zoomFactor ?? 1}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
      />
      <ContextMenu
        onOpenUrl={(url, newTab) => {
          if (newTab) {
            createTab(url);
          } else {
            handleNavigate(url);
          }
        }}
      />
    </div>
  );
};

export default App;
