import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import TopBar from './components/layout/TopBar';
import DrawerSidebar from './components/layout/DrawerSidebar';
import NewTabPage from './components/newtab/NewTabPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import FindBar from './components/overlays/FindBar';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { useTabManager } from './hooks/useTabManager';
import { useDownloadListener } from './hooks/useDownloadListener';
import { favoritesAtom, historyAtom, downloadsAtom, settingsAtom, themeAtom, pushToastAtom, activePanelAtom } from './atoms/data.atom';
import { usePasswordListener } from './hooks/usePasswordListener';
import { loadAll, migrateFromLocalStorage, db } from './services/db';
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
  const favorites = useAtomValue(favoritesAtom);
  const history = useAtomValue(historyAtom);
  const downloads = useAtomValue(downloadsAtom);
  const settings = useAtomValue(settingsAtom);

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
    // L36: 水合失败时降级，避免白屏
    }).catch((e) => {
      console.warn('[App] hydration failed, using empty data:', e);
      hydrationDone.current = true;
    });
  }, [setFavorites, setHistory, setDownloads, setSettings, setTheme]);

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

  const [activePanel, setActivePanel] = useAtom(activePanelAtom);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [findBarVisible, setFindBarVisible] = useState(false);

  // --- BrowserView bounds ---
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

  // --- Tab manager hook (extracted from App.tsx) ---
  const tm = useTabManager(calcBoundsRef);
  const { tabs, activeTabId, activeTab, addressUrl, createTab, closeTab, switchTab, updateTab, handleNavigate, zoomIn, zoomOut, zoomReset } = tm;

  // --- Download listener hook ---
  useDownloadListener();
  usePasswordListener();

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

  // Ctrl+F global toggle
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

  // --- Theme ---
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const ruffleMode = activeTab?.ruffleMode ?? 'ppapi';
  const handleToggleRuffle = useCallback(() => {
    if (!activeTabId) return;
    const nextMode = ruffleMode === 'ruffle' ? 'ppapi' : 'ruffle';
    updateTab(activeTabId, { ruffleMode: nextMode });
    if (activeTab?.url && !isNewtabUrl(activeTab.url)) {
      window.electronAPI.tab.setRuffleMode(activeTabId, nextMode === 'ruffle', settings.ruffleSource);
    }
  }, [ruffleMode, activeTabId, activeTab, updateTab, settings.ruffleSource]);

  const isOnNewTab = !activeTab || activeTab.url === NEWTAB_URL;

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
          tm.setTabs((prev) => {
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
          currentUrl={activeTab?.url || ''}
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
