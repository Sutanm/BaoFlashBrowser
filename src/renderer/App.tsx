import React, { useCallback, useState, useEffect, useRef } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import TopBar from './components/layout/TopBar';
import DrawerSidebar from './components/layout/DrawerSidebar';
import NewTabPage from './components/newtab/NewTabPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import FindBar from './components/overlays/FindBar';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { favoritesAtom, historyAtom, downloadsAtom, settingsAtom, themeAtom, pushToastAtom } from './atoms/data.atom';
import { normalizeUrl, generateId } from './services/id.service';
import { loadAll, migrateFromLocalStorage, db } from './services/db';
import type { TabState } from './atoms/tabs.atom';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import type { HistoryEntry } from '@shared/types/history';
import type { DownloadItem } from '@shared/types/downloads';
import type { Settings } from '@shared/types/settings';

const NEWTAB_URL = 'about:newtab';

function isNewtabUrl(url: string): boolean {
  return !url || url === 'about:blank' || url === NEWTAB_URL || url.startsWith('data:');
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
  const settings = useAtomValue(settingsAtom);
  const tabsRef = useRef(tabs);
  useEffect(() => { tabsRef.current = tabs; });

  const setFavorites = useSetAtom(favoritesAtom);
  const setHistory = useSetAtom(historyAtom);
  const setDownloads = useSetAtom(downloadsAtom);
  const setSettings = useSetAtom(settingsAtom);
  const setTheme = useSetAtom(themeAtom);
  const pushToast = useSetAtom(pushToastAtom);

  // Hydrate all atoms from IndexedDB on startup — suppress auto-persist until done
  const hydrationDone = useRef(false);

  useEffect(() => {
    Promise.all([
      migrateFromLocalStorage().then(() => loadAll()),
      (window as any).electronAPI?.config?.get() ?? Promise.resolve(null),
    ]).then(([data, mainConfig]: [any, any]) => {
      setFavorites(data.favorites as BookmarkEntry[]);
      setHistory(data.history as HistoryEntry[]);
      const downloadsData = (data.downloads as DownloadItem[]).filter((d) => d.filename);
      if (downloadsData.length < (data.downloads || []).length) {
        db.downloads.clear().then(() => db.downloads.bulkPut(downloadsData));
      }
      setDownloads(downloadsData);
      if (data.settings) {
        const merged = { ...data.settings } as Settings;
        if (mainConfig) {
          merged.flashVersion = mainConfig.flashVersion;
          merged.lowEndMode = mainConfig.lowEndMode;
          merged.downloadEngine = mainConfig.downloadEngine;
        }
        setSettings(merged);
      }
      if (data.meta?.theme) setTheme(data.meta.theme);
      hydrationDone.current = true;
    });
  }, [setFavorites, setHistory, setDownloads, setSettings, setTheme]);

  // Always-on download:progress listener (not tied to panel mount/unmount)
  useEffect(() => {
    const cleanup = (window as any).electronAPI?.on('download:progress', (payload: any) => {
      const name = payload.filename || '文件';

      setDownloads((prev) => {
        const exists = prev.find((d: DownloadItem) => d.id === payload.id);
        if (exists) {
          return prev.map((d) => {
            if (d.id !== payload.id) return d;
            const merged = { ...d } as any;
            for (const key of Object.keys(payload)) {
              if (payload[key] !== undefined) merged[key] = payload[key];
            }
            return merged as DownloadItem;
          });
        }
        pushToast({ message: `${name} 开始下载`, type: 'info' });
        return [{ ...payload, id: payload.id }, ...prev];
      });

      if (payload.state === 'completed') {
        pushToast({ message: `${name} 下载完成`, type: 'success' });
      } else if (payload.state === 'cancelled') {
        pushToast({ message: `${name} 已取消`, type: 'warning' });
      } else if (payload.state === 'interrupted') {
        pushToast({ message: `${name} 下载失败`, type: 'error' });
      }
    });
    return () => { cleanup?.(); };
  }, [setDownloads, pushToast]);

  // Auto-persist to IndexedDB on atom changes (skip until hydrationDone)
  const favTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const histTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const dlTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!hydrationDone.current) return;
    if (favorites.length === 0) {
      clearTimeout(favTimerRef.current);
      db.favorites.clear().catch((e) => console.error('[DB] favorites clear failed:', e));
      return;
    }
    db.favorites.bulkPut(favorites.map((f, i) => ({ ...f, _idx: i }))).catch((e) => console.error('[DB] favorites persist failed:', e));
  }, [favorites]);

  useEffect(() => {
    if (!hydrationDone.current) return;
    if (history.length === 0) {
      clearTimeout(histTimerRef.current);
      db.history.clear().catch((e) => console.error('[DB] history clear failed:', e));
      return;
    }
    histTimerRef.current = setTimeout(() => {
      db.history.bulkPut(history).catch((e) => console.error('[DB] history persist failed:', e));
    }, 500);
    return () => clearTimeout(histTimerRef.current);
  }, [history]);

  useEffect(() => {
    if (!hydrationDone.current) return;
    if (downloads.length === 0) {
      clearTimeout(dlTimerRef.current);
      db.downloads.clear().catch((e) => console.error('[DB] downloads clear failed:', e));
      return;
    }
    db.downloads.bulkPut(downloads).catch((e) => console.error('[DB] downloads persist failed:', e));
  }, [downloads]);

  useEffect(() => {
    if (!hydrationDone.current) return;
    const { flashVersion, lowEndMode, downloadEngine, ...idbSettings } = settings as any;
    db.settings.put(idbSettings, 'default').catch((e) => console.error('[DB] settings persist failed:', e));
  }, [settings]);

  const [activePanel, setActivePanel] = useState<'favorites' | 'history' | 'downloads' | 'settings' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [findBarVisible, setFindBarVisible] = useState(false);
  const [addressUrl, setAddressUrl] = useState('');

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const isOnNewTab = !activeTab || activeTab.url === NEWTAB_URL;

  // --- Tab management ---
  const switchTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    setTimeout(() => {
      calcBoundsRef.current(false);
      window.electronAPI.tab.activate(tabId);
    }, 50);
  }, [setActiveTabId]);

  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const ruffleMode: 'ppapi' | 'ruffle' = settings.flashEngineMode === 'prefer-ruffle' ? 'ruffle' : 'ppapi';
    const tab: TabState = {
      id, url: url || NEWTAB_URL, title: '新标签页',
      zoomFactor: 1, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
      ruffleMode,
    };
    setTabs((prev) => [...prev, tab]);
    const useRuffle = ruffleMode === 'ruffle';
    window.electronAPI.tab.create(id, url || NEWTAB_URL, {
      enabled: useRuffle,
      source: settings.ruffleSource,
    } as any);
    switchTab(id);
  }, [setTabs, switchTab, settings.flashEngineMode, settings.ruffleSource]);

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
    // Record history when URL changes to a real page
    if (changes.url !== undefined && !isNewtabUrl(changes.url) && changes.url !== 'about:blank') {
      const currentTab = tabsRef.current.find((t) => t.id === tabId);
      const entry: HistoryEntry = {
        id: generateId(),
        url: changes.url,
        title: changes.title || (() => { try { return new URL(changes.url).hostname; } catch { return changes.url; } })(),
        favicon: currentTab?.favicon || (changes as any).favicon || '',
        lastVisit: Date.now(),
        visitCount: 1,
      };
      setHistory((prev) => {
        // Dedupe: if same URL visited recently, update instead of prepend
        const existing = prev.find((h) => h.url === entry.url);
        if (existing) {
          return prev.map((h) => h.url === entry.url
            ? { ...h, lastVisit: Date.now(), visitCount: h.visitCount + 1, title: entry.title || h.title, favicon: entry.favicon || h.favicon }
            : h
          );
        }
        return [entry, ...prev];
      });
    }
    // Update favicon in history when it arrives from page-favicon-updated
    if (changes.favicon) {
      const tabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      if (tabUrl) {
        setHistory((prev) => {
          const idx = prev.findIndex((h) => h.url === tabUrl);
          if (idx >= 0 && !prev[idx].favicon) {
            return prev.map((h) => h.url === tabUrl ? { ...h, favicon: changes.favicon! } : h);
          }
          return prev;
        });
      }
    }
    // Update title in history when it arrives from page-title-updated
    if (changes.title && changes.title !== changes.url) {
      const tabUrl = tabsRef.current.find((t) => t.id === tabId)?.url;
      if (tabUrl && !isNewtabUrl(tabUrl)) {
        setHistory((prev) => {
          const idx = prev.findIndex((h) => h.url === tabUrl);
          if (idx >= 0) {
            return prev.map((h) => h.url === tabUrl ? { ...h, title: changes.title! } : h);
          }
          return prev;
        });
      }
    }
  }, [setTabs, activeTabId, setHistory]);

  const updateTabRef = useRef(updateTab);
  useEffect(() => { updateTabRef.current = updateTab; });

  useEffect(() => {
    const unsub = window.electronAPI.on('tab:updated', (payload: any) => {
      const { tabId, ...changes } = payload;
      updateTabRef.current(tabId, changes as Partial<TabState>);
    });
    const unsubErr = window.electronAPI.on('tab:load-error', (payload: any) => {
      const msg = payload.errorCode === -105 ? 'DNS 解析失败' : '页面加载失败';
      pushToast({ message: `${msg} (-${payload.errorCode})`, type: 'error' });
    });
    return () => { try { unsub(); unsubErr(); } catch {} };
  }, []);

  const handleNavigate = useCallback((input: string) => {
    const url = normalizeUrl(input, settings.searchEngine);
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
      pushToast({ message: '页面崩溃了', type: 'error' });
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
  const bvAnimRef = useRef(0);

  const calcBounds = useCallback((animated = false) => {
    if (!bvAreaRef.current) return;
    const r = bvAreaRef.current.getBoundingClientRect();
    const targetX = (!sidebarCollapsed && activePanel !== null) ? 280 : 0;

    if (!animated) {
      window.electronAPI.tab.setBounds(
        Math.round(r.x + targetX),
        Math.round(r.y),
        Math.round(r.width),
        Math.round(r.height),
      );
      return;
    }

    // Animate BrowserView x position over 250ms to match drawer CSS transition
    cancelAnimationFrame(bvAnimRef.current);
    const startX = (!sidebarCollapsed && activePanel !== null) ? 0 : 280;
    const startTime = performance.now();
    const duration = 250;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(elapsed / duration, 1);
      // ease-out cubic
      const ease = 1 - Math.pow(1 - t, 3);
      const x = Math.round(r.x + startX + (targetX - startX) * ease);
      window.electronAPI.tab.setBounds(x, Math.round(r.y), Math.round(r.width), Math.round(r.height));
      if (t < 1) bvAnimRef.current = requestAnimationFrame(step);
    };
    bvAnimRef.current = requestAnimationFrame(step);
  }, [activePanel, sidebarCollapsed]);

  const calcBoundsRef = useRef(calcBounds);
  useEffect(() => { calcBoundsRef.current = calcBounds; });

  useEffect(() => {
    calcBoundsRef.current(false);
    const area = bvAreaRef.current;
    const onResize = () => calcBoundsRef.current(false);
    const ro = new ResizeObserver(onResize);
    if (area) ro.observe(area);
    window.addEventListener('resize', onResize);
    return () => { ro.disconnect(); window.removeEventListener('resize', onResize); };
  }, [calcBounds, findBarVisible]);

  // Animate BrowserView when drawer opens/closes (not on panel switch)
  const prevDrawerOpen = useRef(false);
  useEffect(() => {
    const isOpen = activePanel !== null;
    if (prevDrawerOpen.current === isOpen) return;
    prevDrawerOpen.current = isOpen;
    calcBoundsRef.current(true);
    const timer = setTimeout(() => calcBoundsRef.current(false), 300);
    return () => clearTimeout(timer);
  }, [activePanel]);

  const ruffleMode = activeTab?.ruffleMode ?? 'ppapi';
  const handleToggleRuffle = useCallback(() => {
    if (!activeTabId) return;
    const nextMode = ruffleMode === 'ruffle' ? 'ppapi' : 'ruffle';
    updateTab(activeTabId, { ruffleMode: nextMode });
    if (activeTab?.url && !isNewtabUrl(activeTab.url)) {
      window.electronAPI.tab.setRuffleMode(activeTabId, nextMode === 'ruffle', settings.ruffleSource);
    }
  }, [ruffleMode, activeTabId, activeTab, updateTab, settings.ruffleSource]);

  return (
    <div className="h-full flex flex-col relative" style={{ background: 'var(--bg-primary)' }}>
      <TopBar
        tabs={tabs}
        activeTabId={activeTabId}
        url={addressUrl}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isMuted={activeTab?.isMuted || false}
        isDark={theme === 'dark'}
        zoomPercent={Math.round((activeTab?.zoomFactor ?? 1) * 100)}
        flashEngineMode={ruffleMode === 'ruffle' ? 'prefer-ruffle' : 'auto'}
        ruffleSource={settings.ruffleSource}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={() => setSidebarCollapsed((v) => !v)}
        onSelectTab={switchTab}
        onCloseTab={closeTab}
        onNewTab={() => createTab()}
        onNavigate={handleNavigate}
        onBack={() => { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); }}
        onForward={() => { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); }}
        onStop={() => { if (activeTabId) window.electronAPI.tab.stop(activeTabId); }}
        onReload={() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }}
        onToggleMute={() => {
          if (activeTabId) {
            const newMuted = !activeTab?.isMuted;
            window.electronAPI.tab.mute(activeTabId, newMuted);
            updateTab(activeTabId, { isMuted: newMuted });
          }
        }}
        onToggleRuffle={handleToggleRuffle}
        onToggleBookmark={() => {
          if (!activeTab?.url || activeTab.url === 'about:newtab') return;
          const url = activeTab.url;
          const rawTitle = activeTab.title || url;
          const title = /^https?:\/\//.test(rawTitle) ? (() => { try { return new URL(rawTitle).hostname; } catch { return rawTitle; } })() : rawTitle;
          setFavorites((prev) => {
            const exists = prev.some((f) => f.url === url);
            if (exists) {
              pushToast({ message: `已取消收藏 ${title}`, type: 'info' });
              return prev.filter((f) => f.url !== url);
            }
            pushToast({ message: `已收藏 ${title}`, type: 'success' });
            return [{ url, title, favicon: activeTab.favicon, addedAt: Date.now() } as BookmarkEntry, ...prev];
          });
        }}
        isBookmarked={favorites.some((f) => f.url === activeTab?.url && activeTab?.url && activeTab.url !== 'about:newtab')}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
        onReorder={(from, to) => {
          setTabs((prev) => {
            const next = [...prev];
            const [moved] = next.splice(from, 1);
            next.splice(to, 0, moved);
            return next;
          });
        }}
      />

      {/* Content area: sidebar icon strip + drawer panel + main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative' }}>
        <DrawerSidebar
          collapsed={sidebarCollapsed}
          activePanel={activePanel}
          currentUrl={activeTab?.url || ''}
          onTogglePanel={(panel) => setActivePanel((v) => v === panel ? null : panel)}
          onClose={() => setActivePanel(null)}
          onOpenUrl={(url, newTab) => {
            setActivePanel(null);
            if (newTab || activeTab?.url !== 'about:newtab') {
              createTab(url);
            } else {
              handleNavigate(url);
            }
          }}
          zoomPercent={Math.round((activeTab?.zoomFactor ?? 1) * 100)}
          onZoomIn={zoomIn}
          onZoomOut={zoomOut}
          onZoomReset={zoomReset}
          downloadCount={downloads.filter((d) => d.state === 'progressing' || d.state === 'paused').length}
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
