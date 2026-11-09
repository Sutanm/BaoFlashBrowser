import React, { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import TopBar from './components/layout/TopBar';
import DrawerSidebar from './components/layout/DrawerSidebar';
import { isSidebarPanel, SIDEBAR_WIDTH } from './components/layout/DrawerSidebar';
import NewTabPage from './components/newtab/NewTabPage';
import FindBar from './components/overlays/FindBar';
import DevToolDrawer from './components/devtools/DevToolDrawer';
import { setDevToolStorageScope, useDevToolStore } from './store/useDevToolStore';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { useTabManager } from './hooks/useTabManager';
import { useDownloadListener } from './hooks/useDownloadListener';
import { useDataStore } from './store/useDataStore';
import { usePasswordListener } from './hooks/usePasswordListener';
import FirstRunLanguageGate from './components/overlays/FirstRunLanguageGate';
import DatabaseHydrator from './components/data/DatabaseHydrator';
import type { BookmarkEntry } from '@shared/types/bookmarks';
import { isNewtabUrl } from './services/url-utils';
import TypesafeI18n, { useI18nContext } from './i18n/i18n-react';
import { loadAllLocales } from './i18n/i18n-util.sync';
import { isLocale } from './i18n/i18n-util';
import { computeBrowserViewBounds } from './services/browserview-bounds';

const AutomationPage = MODULE_AUTOMATION ? lazy(() => import('./components/automation/AutomationPage')) : null;
const UserscriptsPage = MODULE_USERSCRIPTS ? lazy(() => import('./components/userscripts/UserscriptsPage')) : null;

const AppInner: React.FC = () => {
  const { LL, locale, setLocale } = useI18nContext();
  useEffect(() => {
    document.documentElement.lang = locale;
    void window.electronAPI.invoke('ui:set-language', locale).catch(() => undefined);
  }, [locale]);
  const favorites = useDataStore((s) => s.favorites);
  const activeDownloadCount = useDataStore((s) => s.downloads.filter((d) => d.state === 'progressing' || d.state === 'paused').length);
  const settings = useDataStore((s) => s.settings);

  const setFavorites = useDataStore((s) => s.setFavorites);
  const pushToast = useDataStore((s) => s.pushToast);

  // 主进程（自动化助手）发来的一次性提示：走地址栏提示条，不覆盖网页画面。
  useEffect(() => window.electronAPI.onUiToast((payload) => {
    pushToast({ message: payload.message, type: payload.type ?? 'info' });
  }), [pushToast]);

  const activePanel = useDataStore((s) => s.activePanel);
  const setActivePanel = useDataStore((s) => s.setActivePanel);

  // Sync i18n locale when settings.language changes
  useEffect(() => {
    if (isLocale(settings.language)) {
      setLocale(settings.language);
    }
  }, [settings.language, setLocale]);

  const [findBarVisible, setFindBarVisible] = useState(false);
  const lastSidebarPanelRef = useRef<'favorites' | 'history' | 'downloads'>('favorites');
  const sidebarOpen = isSidebarPanel(activePanel);
  const devToolDock = useDevToolStore((s) => s.dock);
  /**
   * 侧边栏**常驻挂载**：关着的时候只是 0 宽（`collapsed`），不卸载。
   *
   * 卸载后再打开要重新挂载 + 首帧绘制，实测打开动画开头恒定有 75ms 一帧都出不来
   * （宽度序列 `0,48,72,297…`，时间驱动的动画直接从 72 跳到 297，看上去"没有过渡"）。
   * 对照实验：关闭动画期间立刻重开（组件还没卸载）最大帧间隔只有 21ms，完全流畅。
   * 所以成本在"挂载 + 首帧"，常驻就能根治。
   *
   * 三态：open（打开）/ closing（播收起动画，组件仍可见）/ collapsed（0 宽 + visibility:hidden）。
   */
  const [sidebarPhase, setSidebarPhase] = useState<'open' | 'closing' | 'collapsed'>(
    sidebarOpen ? 'open' : 'collapsed',
  );
  useEffect(() => {
    if (sidebarOpen) {
      setSidebarPhase('open');
      return undefined;
    }
    // 只有"刚从打开状态收起"才播收起动画；本来就没开过就保持 collapsed
    setSidebarPhase((prev) => (prev === 'open' ? 'closing' : prev));
    return undefined;
  }, [sidebarOpen]);
  useEffect(() => {
    if (sidebarPhase !== 'closing') return undefined;
    const timer = window.setTimeout(() => setSidebarPhase('collapsed'), 240);
    return () => window.clearTimeout(timer);
  }, [sidebarPhase]);
  const sidebarState = sidebarPhase;

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

  // 左侧停靠与自带侧边栏互斥：切到左侧时收起侧边栏，离开左侧时恢复原状
  const sidebarBeforeLeftDockRef = useRef<typeof activePanel>(null);
  useEffect(() => {
    if (devToolDock === 'left') {
      if (activePanel && isSidebarPanel(activePanel)) {
        sidebarBeforeLeftDockRef.current = activePanel;
        setActivePanel(null);
      }
      return;
    }
    if (sidebarBeforeLeftDockRef.current) {
      setActivePanel(sidebarBeforeLeftDockRef.current);
      sidebarBeforeLeftDockRef.current = null;
    }
  }, [devToolDock, activePanel, setActivePanel]);

  // --- BrowserView bounds ---
  const bvAreaRef = useRef<HTMLDivElement>(null);

  const calcBounds = useCallback((_animated = false) => {
    if (!bvAreaRef.current) return;
    const r = bvAreaRef.current.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      window.electronAPI.tab.setBounds(-9999, -9999, 1, 1);
      return;
    }
    // 侧边栏的"向右扩展、由窗口裁剪"补偿只在底部/独立窗口时成立：
    // 左右停靠时 drawer 就在页面右侧，扩展出来的部分会直接盖住它。
    // 左侧停靠还会让 r.x 含上 drawer 宽度，按 r.x 反推会算错，故一并归零。
    // 侧边栏常驻后 r.x 在收起时是 0，补偿自然为 0，不需要额外判断。
    const sidebarCompensation = (devToolDock === 'bottom' || devToolDock === 'undocked')
      ? Math.min(SIDEBAR_WIDTH, Math.max(0, r.x))
      : 0;
    const bounds = computeBrowserViewBounds(r, sidebarCompensation);
    window.electronAPI.tab.setBounds(bounds.x, bounds.y, bounds.width, bounds.height);
  }, [devToolDock]);

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

  // P7：告诉主进程本窗口渲染层已就绪（tear-off 迁移的握手条件）。
  useEffect(() => {
    void window.electronAPI.win.rendererReady().catch(() => { /* older preload */ });
  }, []);

  // 多窗口 P5：抽屉布局按窗口 key 分片（拿到上下文后重读本窗口的值）。
  useEffect(() => {
    void window.electronAPI.win.getContext().then((context) => {
      if (context?.windowKey) setDevToolStorageScope(context.windowKey);
    }).catch(() => { /* 拿不到上下文时保持旧的全局布局 */ });
  }, []);

  // --- Keyboard shortcuts ---
  useShortcut((action) => {
    switch (action) {
      case 'new-tab': createTab(); break;
      case 'new-window': void window.electronAPI.win.newWindow(); break;
      case 'close-window': window.electronAPI.win.close(); break;
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
      case 'devtoolbox': useDevToolStore.getState().toggle(); break;
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
  const isOnUserscripts = MODULE_USERSCRIPTS && activeTab?.url === 'about:userscripts';
  const isOnAutomation = MODULE_AUTOMATION && activeTab?.url === 'about:automation';
  const [automationMounted, setAutomationMounted] = useState(isOnAutomation);
  useEffect(() => { if (isOnAutomation) setAutomationMounted(true); }, [isOnAutomation]);
  const isCrashed = activeTab?.crashed === true;
  const browserViewHidden = isOnNewTab || isOnUserscripts || isOnAutomation || isCrashed;

  useEffect(() => {
    if (browserViewHidden) window.electronAPI.tab.setBounds(-9999, -9999, 1, 1);
    else calcBoundsRef.current(false);
  }, [browserViewHidden]);

  const toggleMute = useCallback(() => {
    if (!activeTabId) return;
    const newMuted = !activeTab?.isMuted;
    window.electronAPI.tab.mute(activeTabId, newMuted);
    updateTab(activeTabId, { isMuted: newMuted });
  }, [activeTab?.isMuted, activeTabId, updateTab]);

  const handleBack = useCallback(() => { if (activeTabId) window.electronAPI.tab.goBack(activeTabId); }, [activeTabId]);
  const handleForward = useCallback(() => { if (activeTabId) window.electronAPI.tab.goForward(activeTabId); }, [activeTabId]);
  const handleStop = useCallback(() => { if (activeTabId) window.electronAPI.tab.stop(activeTabId); }, [activeTabId]);
  const handleReload = useCallback(() => { if (activeTabId) window.electronAPI.tab.reload(activeTabId); }, [activeTabId]);
  const isBookmarked = useMemo(() => Boolean(
    activeTab?.url && activeTab.url !== 'about:newtab' && favorites.some((favorite) => favorite.url === activeTab.url),
  ), [activeTab?.url, favorites]);
  const handleToggleBookmark = useCallback(() => {
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
  }, [LL, activeTab, favorites, pushToast, setFavorites]);

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
        onBack={handleBack}
        onForward={handleForward}
        onStop={handleStop}
        onReload={handleReload}
        onToggleRuffle={handleToggleRuffle}
        onToggleBookmark={handleToggleBookmark}
        isBookmarked={isBookmarked}
        onReorder={tm.reorderTabs}
      />

      <div className="app-workspace">
        <DrawerSidebar
          state={sidebarState}
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
        />

        <div className="workspace-main" data-dock={devToolDock}>
          <div className="workspace-view" style={{ display: isOnNewTab ? 'flex' : 'none' }}>
            <NewTabPage onNavigate={handleNavigate} bookmarks={favorites} />
          </div>
          {UserscriptsPage && (
            <div className="workspace-view" style={{ display: isOnUserscripts ? 'flex' : 'none' }}>
              <Suspense fallback={<div className="internal-page-loading">Loading Userscripts…</div>}><UserscriptsPage /></Suspense>
            </div>
          )}
          {automationMounted && (
            <div className="workspace-view" style={{ display: isOnAutomation ? 'flex' : 'none' }}>
              {AutomationPage && <Suspense fallback={<div className="internal-page-loading">Loading Automation 2.0…</div>}><AutomationPage /></Suspense>}
            </div>
          )}
          <div className="workspace-view workspace-view-center" style={{ display: isCrashed ? 'flex' : 'none' }}>
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
          <DevToolDrawer />
        </div>

      </div>
    </div>
  );
};

const App: React.FC = () => {
  const { themeMode } = useTheme();
  useEffect(() => {
    // Send the selected mode, not the resolved color: system must remove the override.
    void window.electronAPI.invoke('theme:set-source', themeMode)
      .catch((error) => console.warn('[Theme] native theme sync failed:', error));
  }, [themeMode]);
  const settings = useDataStore((s) => s.settings);
  const initRef = useRef(false);
  if (!initRef.current) {
    initRef.current = true;
    try { loadAllLocales(); } catch (e) { console.error('[i18n] loadAllLocales failed:', e); }
  }
  return (
    <TypesafeI18n locale={isLocale(settings.language) ? settings.language : 'zh-CN'}>
      <FirstRunLanguageGate><AppInner /></FirstRunLanguageGate>
    </TypesafeI18n>
  );
};

export default App;
