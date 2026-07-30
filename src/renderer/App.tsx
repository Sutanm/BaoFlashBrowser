import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import TabBar from './components/tabs/TabBar';
import NavigationBar from './components/navigation/NavigationBar';
import NewTabPage from './components/newtab/NewTabPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import UnifiedSidebar from './components/panels/UnifiedSidebar';
import FindBar from './components/overlays/FindBar';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { favoritesAtom, historyAtom, downloadsAtom, settingsAtom, themeAtom } from './atoms/data.atom';
import { normalizeUrl, generateId } from './services/id.service';
import { loadAll, migrateFromLocalStorage, db } from './services/db';
import type { TabState } from './atoms/tabs.atom';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

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
  const history = useAtomValue(historyAtom);
  const downloads = useAtomValue(downloadsAtom);
  const [isMuted, setIsMuted] = useState(false);

  const setFavorites = useSetAtom(favoritesAtom);
  const setHistory = useSetAtom(historyAtom);
  const setDownloads = useSetAtom(downloadsAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setTheme = useSetAtom(themeAtom);

  // Hydrate all atoms from IndexedDB on startup
  useEffect(() => {
    migrateFromLocalStorage().then(() => loadAll()).then((data) => {
      setFavorites(data.favorites as BookmarkEntry[]);
      setHistory(data.history as HistoryEntry[]);
      setDownloads(data.downloads as DownloadItem[]);
      if (data.settings) setSettings(data.settings as Settings);
      if (data.meta?.theme) setTheme(data.meta.theme);
    });
  }, [setFavorites, setHistory, setDownloads, setSettings, setTheme]);

  // Auto-persist to IndexedDB on atom changes
  useEffect(() => {
    db.favorites.bulkPut(favorites.map((f, i) => ({ ...f, _idx: i })));
  }, [favorites]);

  useEffect(() => {
    if (history.length > 0) db.history.bulkPut(history);
  }, [history]);

  useEffect(() => {
    if (downloads.length > 0) db.downloads.bulkPut(downloads);
  }, [downloads]);
  const [activePanel, setActivePanel] = useState<'favorites' | 'history' | 'downloads' | 'settings' | null>(null);
  const [findBarVisible, setFindBarVisible] = useState(false);
  const [addressUrl, setAddressUrl] = useState('');

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isOnNewTab = !activeTab || activeTab.url === NEWTAB_URL;

  // --- Tab management ---
  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setTimeout(() => {
      if (bvAreaRef.current) {
        const r = bvAreaRef.current.getBoundingClientRect();
        window.electronAPI.tab.setBounds(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
      }
      window.electronAPI.tab.activate(tabId);
    }, 50);
  }, [setActiveTabId]);

  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const tab: TabState = {
      id, url: url || NEWTAB_URL, title: '新标签页',
      zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, tab]);
    window.electronAPI.tab.create(id, url || NEWTAB_URL);
    switchTab(id);
  }, [setTabs, switchTab]);

  const closeTab = useCallback((tabId: string) => {
    window.electronAPI.tab.close(tabId);
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
          window.electronAPI.tab.activate(next[newIdx].id);
        } else {
          setActiveTabId(null);
        }
      }
      return next;
    });
  }, [activeTabId, setActiveTabId, setTabs]);

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

  const updateTabRef = useRef(updateTab);
  updateTabRef.current = updateTab;

  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload: any) => {
      const { tabId, ...changes } = payload;
      updateTabRef.current(tabId, changes as Partial<TabState>);
    });
    return () => { try { unsub(); } catch {} };
  }, []);

  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input);
    if (!activeTabId) { createTab(url); return; }
    updateTab(activeTabId, { url, title: url });
    setAddressUrl(url);
    if (activeTabId) {
      window.electronAPI.tab.stop(activeTabId);
      window.electronAPI.tab.navigate(activeTabId, url);
    }
  }, [activeTabId, createTab, updateTab]);

  // --- Zoom ---
  const doZoom = useCallback((delta: number) => {
    if (!activeTab) return;
    const lvl = Math.min(5, Math.max(0.25, activeTab.zoomFactor + delta));
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, lvl);
    updateTab(activeTab.id, { zoomFactor: lvl });
  }, [activeTab, updateTab, activeTabId]);

  const zoomIn = useCallback(() => doZoom(0.25), [doZoom]);
  const zoomOut = useCallback(() => doZoom(-0.25), [doZoom]);
  const zoomReset = useCallback(() => {
    if (!activeTab) return;
    if (activeTabId) window.electronAPI.tab.zoom(activeTabId, 1);
    updateTab(activeTab.id, { zoomFactor: 1 });
  }, [activeTab, updateTab, activeTabId]);

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
      case 'reload': { if (activeTabId) window.electronAPI.tab.reload(activeTabId); break; }
      case 'stop-or-dismiss': { if (activeTabId) window.electronAPI.tab.stop(activeTabId); break; }
      case 'fullscreen': window.electronAPI.win.toggleFullscreen(); break;
      case 'devtools': { if (activeTabId) window.electronAPI.tab.devtools(activeTabId); break; }
      case 'bookmark': setActivePanel((v) => v === 'favorites' ? null : 'favorites'); break;
      case 'history-panel': setActivePanel((v) => v === 'history' ? null : 'history'); break;
      case 'zoom-in': zoomIn(); break;
      case 'zoom-out': zoomOut(); break;
      case 'zoom-reset': zoomReset(); break;
      case 'go-back': { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); break; }
      case 'go-forward': { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); break; }
      case 'find-in-page': setFindBarVisible((v) => !v); break;
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

  // Ctrl+F global toggle — works even when focus is outside webview (address bar etc.)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'f' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        setFindBarVisible((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // --- External URL open (new-window → delayed tab to avoid Flash crash) ---
  useEffect(() => {
    let pendingUrl: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const unsub = window.electronAPI.on('navigate-url', (url: any) => {
      const delay = activeTab?.isLoading ? 600 : 0;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        createTab(String(url));
        timer = null;
      }, delay);
    });

    return () => {
      try { unsub(); } catch (_) {}
      if (timer) clearTimeout(timer);
    };
  }, [createTab, activeTab]);

  useEffect(() => {
    const u1 = window.electronAPI.on('tab:newwindow', (payload: any) => {
      createTab(String((payload as any).url || payload));
    });
    const u2 = window.electronAPI.on('tab:crashed', (payload: any) => {
      updateTabRef.current(payload.tabId, { url: 'about:crash', title: '页面崩溃了' });
    });
    return () => { try { u1(); u2(); } catch {} };
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

  const bvAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const calc = () => {
      if (!bvAreaRef.current) return;
      const r = bvAreaRef.current.getBoundingClientRect();
      window.electronAPI.tab.setBounds(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
    };
    calc();
    const area = bvAreaRef.current;
    const ro = new ResizeObserver(() => calc());
    if (area) ro.observe(area);
    window.addEventListener('resize', calc);
    return () => { ro.disconnect(); window.removeEventListener('resize', calc); };
  }, [activePanel, findBarVisible]);

  useEffect(() => {
    setTimeout(() => {
      if (bvAreaRef.current) {
        const r = bvAreaRef.current.getBoundingClientRect();
        window.electronAPI.tab.setBounds(Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height));
      }
    }, 270);
  }, [activePanel]);

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
        onReorder={(from, to) => {
          setTabs((prev) => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
          });
        }}
      />

      <NavigationBar
        url={addressUrl}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isMuted={isMuted}
        isBookmarked={activeTab ? favorites.some((f) => f.url === activeTab.url && activeTab.url !== 'about:newtab') : false}
        zoomPercent={Math.round((activeTab?.zoomFactor ?? 1) * 100)}
        onNavigate={handleNavigate}
        onBack={() => { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); }}
        onForward={() => { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); }}
        onStop={() => { if (activeTabId) window.electronAPI.tab.stop(activeTabId); }}
        onReload={() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }}
        onToggleMute={() => {
          setIsMuted((m) => {
            if (activeTabId) window.electronAPI.tab.mute(activeTabId, !m);
            return !m;
          });
        }}
        onToggleFavorites={() => setActivePanel((v) => v === 'favorites' ? null : 'favorites')}
        onToggleHistory={() => setActivePanel((v) => v === 'history' ? null : 'history')}
        onToggleDownloads={() => setActivePanel((v) => v === 'downloads' ? null : 'downloads')}
        onToggleSettings={() => setActivePanel((v) => v === 'settings' ? null : 'settings')}
      />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <UnifiedSidebar
          activePanel={activePanel}
          currentUrl={activeTab?.url || ''}
          onOpenUrl={(url, newTab) => {
            if (newTab || activeTab?.url !== 'about:newtab') {
              createTab(url);
            } else {
              handleNavigate(url);
            }
          }}
          onClose={() => setActivePanel(null)}
          onTogglePanel={(panel) => {
            const type = panel === 'bookmarks' ? 'favorites' :
                         panel === 'history' ? 'history' :
                         panel === 'downloads' ? 'downloads' :
                         panel === 'settings' ? 'settings' : 'favorites';
            setActivePanel((v) => v === type ? null : type);
          }}
          zoomPercent={Math.round((activeTab?.zoomFactor ?? 1) * 100)}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomReset={zoomReset}
        />

        <div style={{ display: isOnNewTab ? 'flex' : 'none', flex: '1 1 0%', flexDirection: 'column' }}>
          <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
        </div>
        <div
          id="browserview-area"
          ref={bvAreaRef}
          style={{ display: isOnNewTab ? 'none' : 'flex', flex: '1 1 0%', position: 'relative', flexDirection: 'column' }}
        >
          <FindBar
            visible={findBarVisible && !isOnNewTab}
            onClose={() => setFindBarVisible(false)}
            activeTabId={activeTabId}
          />
        </div>
      </div>
      <LoadingProgress visible={activeTab?.isLoading ?? false} />
    </div>
  );
};

export default App;
