import React, { lazy, Suspense, useState, useEffect, useRef, useCallback } from 'react';
import TopBar from './components/layout/TopBar';
import DrawerSidebar from './components/layout/DrawerSidebar';
import { isSidebarPanel, SIDEBAR_WIDTH } from './components/layout/DrawerSidebar';
import NewTabPage from './components/newtab/NewTabPage';
import UserscriptsPage from './components/userscripts/UserscriptsPage';
import LoadingProgress from './components/overlays/LoadingProgress';
import FindBar from './components/overlays/FindBar';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { useTabManager } from './hooks/useTabManager';
import { useDownloadListener } from './hooks/useDownloadListener';
import { useDataStore } from './store/useDataStore';
import { usePasswordListener } from './hooks/usePasswordListener';
import { migrateFromLocalStorage } from './services/db';
import DatabaseHydrator from './components/data/DatabaseHydrator';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import { isNewtabUrl } from './services/url-utils';
import TypesafeI18n, { useI18nContext } from './i18n/i18n-react';
import { loadAllLocales } from './i18n/i18n-util.sync';
import { isLocale } from './i18n/i18n-util';
import { computeBrowserViewBounds } from './services/browserview-bounds';

const AutomationPage = lazy(() => import('./components/automation/AutomationPage'));

const AppInner: React.FC = () => {
  const { LL, setLocale } = useI18nContext();
  const { theme } = useTheme();
  const favorites = useDataStore((s) => s.favorites);
  const activeDownloadCount = useDataStore((s) => s.downloads.filter((d) => d.state === 'progressing' || d.state === 'paused').length);
  const settings = useDataStore((s) => s.settings);

  const setFavorites = useDataStore((s) => s.setFavorites);
  const pushToast = useDataStore((s) => s.pushToast);

  const activePanel = useDataStore((s) => s.activePanel);
  const setActivePanel = useDataStore((s) => s.setActivePanel);

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

  const [findBarVisible, setFindBarVisible] = useState(false);
  const lastSidebarPanelRef = useRef<'favorites' | 'history' | 'downloads'>('favorites');
  const sidebarOpen = isSidebarPanel(activePanel);
  const [sidebarMounted, setSidebarMounted] = useState(sidebarOpen);
  const sidebarClosing = sidebarMounted && !sidebarOpen;

  useEffect(() => {
    if (sidebarOpen) {
      setSidebarMounted(true);
      return;
    }
    if (!sidebarMounted) return;
    const timer = window.setTimeout(() => setSidebarMounted(false), 240);
    return () => window.clearTimeout(timer);
  }, [sidebarOpen, sidebarMounted]);

  useEffect(() => {
    const enableKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === 'Tab') document.body.classList.add('keyboard-navigation');
    };
    const disableKeyboardFocus = () => {
      document.body.classList.remove('keyboard-navigation');
    };

    window.addEventListener('keydown', enableKeyboardFocus);
    window.addEventListener('mousedown', disableKeyboardFocus);
    return () => {
      window.removeEventListener('keydown', enableKeyboardFocus);
      window.removeEventListener('mousedown', disableKeyboardFocus);
    };
  }, []);

  useEffect(() => {
    if (activePanel === 'favorites' || activePanel === 'history' || activePanel === 'downloads') {
      lastSidebarPanelRef.current = activePanel;
    }
  }, [activePanel]);

  // --- BrowserView bounds ---
  const bvAreaRef = useRef<HTMLDivElement>(null);

  const calcBounds = useCallback((_animated = false) => {
    if (!bvAreaRef.current) return;
    const r = bvAreaRef.current.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      window.electronAPI.tab.setBounds(-9999, -9999, 1, 1);
      return;
    }
    const animatedSidebarWidth = sidebarMounted
      ? Math.min(SIDEBAR_WIDTH, Math.max(0, r.x))
      : 0;
    const bounds = computeBrowserViewBounds(r, animatedSidebarWidth);
    window.electronAPI.tab.setBounds(bounds.x, bounds.y, bounds.width, bounds.height);
  }, [sidebarMounted]);

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

  useEffect(() => { calcBoundsRef.current(false); }, [sidebarOpen]);

  // --- Tab manager hook (extracted from App.tsx) ---
  const tm = useTabManager(calcBoundsRef);
  const { tabs, activeTabId, activeTab, addressUrl, createTab, closeTab, switchTab, updateTab, handleNavigate, zoomIn, zoomOut, zoomReset } = tm;

  useEffect(() => window.electronAPI.on('userscript:open-tab', (payload: unknown) => {
    const url = (payload as { url?: unknown })?.url;
    if (typeof url === 'string') createTab(url);
  }), [createTab]);

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
  const isOnUserscripts = activeTab?.url === 'about:userscripts';
  const isOnAutomation = activeTab?.url === 'about:automation';
  const [automationMounted, setAutomationMounted] = useState(isOnAutomation);
  useEffect(() => { if (isOnAutomation) setAutomationMounted(true); }, [isOnAutomation]);
  const isCrashed = activeTab?.crashed === true;
  const browserViewHidden = isOnNewTab || isOnUserscripts || isOnAutomation || isCrashed;

  useEffect(() => {
    if (browserViewHidden) window.electronAPI.tab.setBounds(-9999, -9999, 1, 1);
    else calcBoundsRef.current(false);
  }, [browserViewHidden]);

  const toggleMute = () => {
    if (!activeTabId) return;
    const newMuted = !activeTab?.isMuted;
    window.electronAPI.tab.mute(activeTabId, newMuted);
    updateTab(activeTabId, { isMuted: newMuted });
  };

  return (
    <div className="h-full flex flex-col relative" style={{ background: 'var(--bg-primary)' }}>
      <DatabaseHydrator />
      <TopBar
        tabs={tabs}
        activeTabId={activeTabId}
        url={addressUrl}
        isLoading={activeTab?.isLoading || false}
        canGoBack={activeTab?.canGoBack || false}
        canGoForward={activeTab?.canGoForward || false}
        isDark={theme === 'dark'}
        flashEngineMode={ruffleMode === 'ruffle' ? 'prefer-ruffle' : 'auto'}
        ruffleSource={settings.ruffleSource}
        sidebarOpen={sidebarOpen}
        isMuted={activeTab?.isMuted || false}
        onToggleMute={toggleMute}
        onToggleSidebar={() => setActivePanel(sidebarOpen ? null : lastSidebarPanelRef.current)}
        onSelectTab={switchTab}
        onCloseTab={closeTab}
        onNewTab={() => createTab()}
        onNavigate={handleNavigate}
        onBack={() => { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); }}
        onForward={() => { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); }}
        onStop={() => { if (activeTabId) window.electronAPI.tab.stop(activeTabId); }}
        onReload={() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }}
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
        onReorder={tm.reorderTabs}
      />

      <div className="app-workspace">
        {sidebarMounted && <DrawerSidebar
          isClosing={sidebarClosing}
          activeTabId={activeTabId}
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
          downloadCount={activeDownloadCount}
        />}

        <div style={{ display: isOnNewTab ? 'flex' : 'none', flex: '1 1 0%', flexDirection: 'column', minWidth: 0 }}>
          <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
        </div>
        <div style={{ display: isOnUserscripts ? 'flex' : 'none', flex: '1 1 0%', flexDirection: 'column', minWidth: 0 }}>
          <UserscriptsPage />
        </div>
        {automationMounted && <div style={{ display: isOnAutomation ? 'flex' : 'none', flex: '1 1 0%', flexDirection: 'column', minWidth: 0 }}>
          <Suspense fallback={<div className="internal-page-loading">{LL.automation.page.loading()}</div>}><AutomationPage /></Suspense>
        </div>}
        <div style={{ display: isCrashed ? 'flex' : 'none', flex: '1 1 0%', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div style={{ fontSize: 22, fontWeight: 600 }}>{LL.error.pageCrashed()}</div>
          <button
            type="button"
            onClick={() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }}
            style={{ padding: '8px 18px', borderRadius: 8, background: 'var(--accent)', color: '#fff' }}
          >
            {LL.refresh()}
          </button>
        </div>
        <div className="browserview-column" style={{ display: browserViewHidden ? 'none' : 'flex' }}>
          <FindBar
            visible={findBarVisible && !isOnNewTab}
            onClose={() => setFindBarVisible(false)}
            activeTabId={activeTabId}
          />
          <div id="browserview-area" ref={bvAreaRef} className="browserview-native-area" />
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
