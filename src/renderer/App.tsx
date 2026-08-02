import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import TopBar from './components/layout/TopBar';
import DrawerSidebar from './components/layout/DrawerSidebar';
import NewTabPage from './components/newtab/NewTabPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import FindBar from './components/overlays/FindBar';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { useTabManager } from './hooks/useTabManager';
import { useDownloadListener } from './hooks/useDownloadListener';
import { useDataStore, hydrateFromDb } from './store/useDataStore';
import { usePasswordListener } from './hooks/usePasswordListener';
import { migrateFromLocalStorage, db } from './services/db';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import { isNewtabUrl } from './services/url-utils';
import TypesafeI18n, { useI18nContext } from './i18n/i18n-react';
import { loadAllLocales } from './i18n/i18n-util.sync';
import { isLocale } from './i18n/i18n-util';

const AppInner: React.FC = () => {
  const { LL, setLocale } = useI18nContext();
  const { theme } = useTheme();
  const favorites = useDataStore((s) => s.favorites);
  const downloads = useDataStore((s) => s.downloads);
  const settings = useDataStore((s) => s.settings);

  const setFavorites = useDataStore((s) => s.setFavorites);
  const setDownloads = useDataStore((s) => s.setDownloads);
  const pushToast = useDataStore((s) => s.pushToast);

  const activePanel = useDataStore((s) => s.activePanel);
  const setActivePanel = useDataStore((s) => s.setActivePanel);
  const downloadSyncDoneRef = useRef(false);

  // L36: useLiveQuery 自动订阅 db 变化，启动时水合 + 持续同步到 store
  // 写操作在 store 的 setX 内部直接写 db，db 变化触发 useLiveQuery → hydrateFromDb 注入 store
  // hydrateFromDb 用 skipPersist 标志跳过 db 写入，避免循环
  const dbSnapshot = useLiveQuery(async () => {
    const [favs, hist, dls, settsArr, metaThemeMode] = await Promise.all([
      db.favorites.toArray(),
      db.history.orderBy('lastVisit').reverse().toArray(),
      db.downloads.toArray(),
      db.settings.toArray(),
      db.meta.get('themeMode'),
    ]);
    // L36: 过滤历史遗留的无效下载项（无 filename），不写回 db，下次 setDownloads 时自动清理
    const dlsFiltered = dls.filter((d) => d.filename).map((download) =>
      download.state === 'progressing' || download.state === 'paused'
        ? { ...download, state: 'interrupted' as const, speed: 0 }
        : download
    );
    favs.sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
    dlsFiltered.sort((a, b) => (a._idx ?? 0) - (b._idx ?? 0));
    return {
      favorites: favs,
      history: hist,
      downloads: dlsFiltered,
      settings: settsArr[0] || null,
      themeMode: metaThemeMode?.value as 'light' | 'dark' | 'system' | undefined,
    };
  }, [], undefined);

  useEffect(() => {
    if (!dbSnapshot) return;
    const patch: Parameters<typeof hydrateFromDb>[0] = {
      favorites: dbSnapshot.favorites,
      history: dbSnapshot.history,
      downloads: dbSnapshot.downloads,
    };
    if (dbSnapshot.settings) patch.settings = { ...useDataStore.getState().settings, ...dbSnapshot.settings };
    if (dbSnapshot.themeMode) patch.themeMode = dbSnapshot.themeMode;
    hydrateFromDb(patch);
    if (!downloadSyncDoneRef.current) {
      downloadSyncDoneRef.current = true;
      window.electronAPI.dl.syncRecords(dbSnapshot.downloads).then((records) => {
        setDownloads(records);
      }).catch((error) => console.warn('[Download] main-process state sync failed:', error));
    }
  }, [dbSnapshot, setDownloads]);

  // L36: localStorage → IndexedDB 一次性迁移（仅首次启动执行）
  useEffect(() => {
    migrateFromLocalStorage().catch((e) => console.warn('[App] migrate failed:', e));
  }, []);

  // Sync i18n locale when settings.language changes
  useEffect(() => {
    if (isLocale(settings.language)) {
      setLocale(settings.language);
    }
  }, [settings.language, setLocale]);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [findBarVisible, setFindBarVisible] = useState(false);

  // --- BrowserView bounds ---
  const bvAreaRef = useRef<HTMLDivElement>(null);
  const bvAnimRef = useRef(0);
  const bvAnimatingRef = useRef(false);

  const calcBounds = useCallback((animated = false) => {
    if (!bvAreaRef.current) return;
    const r = bvAreaRef.current.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      window.electronAPI.tab.setBounds(-9999, -9999, 1, 1);
      return;
    }
    const targetX = (!sidebarCollapsed && activePanel !== null) ? 280 : 0;

    if (!animated) {
      if (bvAnimatingRef.current) return; // 动画中跳过非动画调用，避免频闪
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
    bvAnimatingRef.current = true;
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
      if (t < 1) {
        bvAnimRef.current = requestAnimationFrame(step);
      } else {
        bvAnimatingRef.current = false;
      }
    };
    bvAnimRef.current = requestAnimationFrame(step);
  }, [activePanel, sidebarCollapsed]);

  const calcBoundsRef = useRef(calcBounds);
  useEffect(() => { calcBoundsRef.current = calcBounds; });

  useEffect(() => {
    if (!bvAnimatingRef.current) calcBoundsRef.current(false);
    const area = bvAreaRef.current;
    const onResize = () => { if (!bvAnimatingRef.current) calcBoundsRef.current(false); };
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

  // --- Theme ---
  // Note: useTheme hook handles DOM class toggling

  const ruffleMode = activeTab?.ruffleMode ?? 'ppapi';
  const handleToggleRuffle = useCallback(() => {
    if (!activeTabId) return;
    const nextMode = ruffleMode === 'ruffle' ? 'ppapi' : 'ruffle';
    updateTab(activeTabId, { ruffleMode: nextMode });
    if (activeTab?.url && !isNewtabUrl(activeTab.url)) {
      window.electronAPI.tab.setRuffleMode(activeTabId, nextMode === 'ruffle', settings.ruffleSource);
    }
  }, [ruffleMode, activeTabId, activeTab, updateTab, settings.ruffleSource]);

  const isOnNewTab = !activeTab || activeTab.url === 'about:newtab';

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
          const exists = favorites.some((favorite) => favorite.url === url);
          setFavorites((prev) => exists
            ? prev.filter((favorite) => favorite.url !== url)
            : [{ url, title, favicon: activeTab.favicon, addedAt: Date.now() } as BookmarkEntry, ...prev]);
          pushToast({
            key: `bookmark:${url}`,
            message: exists ? LL.bookmark.removed({ title }) : LL.bookmark.added({ title }),
            type: exists ? 'info' : 'success',
          });
        }}
        isBookmarked={favorites.some((f) => f.url === activeTab?.url && activeTab?.url && activeTab.url !== 'about:newtab')}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
        onZoomReset={zoomReset}
        onReorder={tm.reorderTabs}
      />

      {/* Content area: sidebar icon strip + drawer panel + main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, position: 'relative' }}>
        <DrawerSidebar
          collapsed={sidebarCollapsed}
          currentUrl={activeTab?.url || ''}
          currentTitle={activeTab?.title || ''}
          currentFavicon={activeTab?.favicon}
          onOpenUrl={(url, newTab) => {
            setActivePanel(null);
            if (settings.linkBehavior === 'new-tab' && (newTab || activeTab?.url !== 'about:newtab')) {
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

const App: React.FC = () => {
  const settings = useDataStore((s) => s.settings);
  const initRef = useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    try { loadAllLocales(); } catch (e) { console.error('[i18n] loadAllLocales failed:', e); }
  }
  return (
    <TypesafeI18n locale={isLocale(settings.language) ? settings.language : 'zh-CN'}>
      <AppInner />
    </TypesafeI18n>
  );
};

export default App;
