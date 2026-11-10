import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Plus, ArrowLeft, ArrowRight, RotateCw, X, Star, PanelLeftOpen, PanelLeftClose, Camera, Volume2, VolumeX, Terminal } from 'lucide-react';
import TabItem from '../tabs/TabItem';
import WindowControls from '../shell/WindowControls';
import RuffleToggle from '../navigation/RuffleToggle';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { TabState } from '@renderer/store/useTabsStore';
import type { FlashEngineMode } from '@shared/types/settings';
import AddressToastHost from '../overlays/AddressToastHost';
import LoadingProgress from '../overlays/LoadingProgress';
import ThemeToggle from '../panels/ThemeToggle';
import { useDataStore } from '@renderer/store/useDataStore';
import { useDevToolStore } from '@renderer/store/useDevToolStore';

interface TopBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  flashEngineMode: FlashEngineMode;
  ruffleSource: 'bundled' | 'cdn';
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onStop: () => void;
  onReload: () => void;
  onToggleRuffle: () => void;
  onToggleBookmark: () => void;
  onToggleSidebar: () => void;
  isBookmarked: boolean;
  sidebarOpen: boolean;
  isMuted: boolean;
  onToggleMute: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

const TopBar: React.FC<TopBarProps> = ({
  tabs,
  activeTabId,
  url,
  isLoading,
  canGoBack,
  canGoForward,
  flashEngineMode,
  ruffleSource,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNavigate,
  onBack,
  onForward,
  onStop,
  onReload,
  onToggleRuffle,
  onToggleBookmark,
  onToggleSidebar,
  isBookmarked,
  sidebarOpen,
  isMuted,
  onToggleMute,
  onReorder,
}) => {
  const { LL } = useI18nContext();
  const pushToast = useDataStore((state) => state.pushToast);
  const [addressValue, setAddressValue] = useState(url);
  const [screenshotting, setScreenshotting] = useState(false);
  const addressInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAddressValue(url);
  }, [url]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        addressInputRef.current?.focus();
      }
      if (e.altKey && e.key === 'd') {
        e.preventDefault();
        addressInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  const handleAddressKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const trimmed = addressValue.trim();
      if (trimmed) onNavigate(trimmed);
      addressInputRef.current?.blur();
    }
  };

  const handleScreenshot = useCallback(async () => {
    if (screenshotting) return;
    setScreenshotting(true);
    try {
      const result = await window.electronAPI.screenshot.captureActive({ save: true, returnData: false });
      if (result.success && result.filePath) {
        pushToast({
          message: `${LL.settings.screenshot.captured()} (${result.filePath.split(/[\\/]/).pop()})`,
          type: 'success',
          actions: [{
            label: LL.settings.screenshot.openFolder(),
            primary: true,
            onClick: () => { void window.electronAPI.screenshot.reveal(result.filePath as string); },
          }],
        });
      } else {
        pushToast({ message: `${LL.settings.screenshot.captureFailed()}: ${result.error || ''}`, type: 'error' });
      }
    } catch {
      pushToast({ message: LL.settings.screenshot.captureFailed(), type: 'error' });
    } finally {
      setScreenshotting(false);
    }
  }, [LL, pushToast, screenshotting]);

  // P7：指针拖拽（替换 HTML5 draggable，窗口外也能收到 pointerup）。
  const [dragState, setDragState] = useState<{ tabId: string; index: number; startX: number; startY: number; active: boolean; overIndex: number | null } | null>(null);
  const dragRef = useRef(dragState);
  useEffect(() => { dragRef.current = dragState; }, [dragState]);
  const dragActive = Boolean(dragState);

  const restoreView = useCallback(() => {
    void window.electronAPI.tab.setViewVisibility(true).catch(() => { /* view gone */ });
  }, []);

  const beginDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, tabId: string, index: number) => {
    if (event.button !== 0) return;
    setDragState({ tabId, index, startX: event.clientX, startY: event.clientY, active: false, overIndex: null });
  }, []);

  const endDrag = useCallback(async (clientX: number, clientY: number) => {
    const state = dragRef.current;
    setDragState(null);
    if (!state || !state.active) return;
    restoreView();
    const element = document.elementFromPoint(clientX, clientY);
    const tabElement = element?.closest?.('[data-tab-id]') as HTMLElement | null;
    if (tabElement?.dataset.tabId) {
      const targetIndex = tabs.findIndex((item) => item.id === tabElement.dataset.tabId);
      if (targetIndex >= 0 && targetIndex !== state.index) onReorder(state.index, targetIndex);
      return;
    }
    if (element?.closest?.('.topbar-tabbar')) return;
    try {
      if (typeof window.electronAPI.win.moveTab !== 'function') return;
      const result = await window.electronAPI.win.moveTab(state.tabId);
      if (result?.reason === 'new-window' && typeof window.electronAPI.win.tearOffTab === 'function') {
        await window.electronAPI.win.tearOffTab(state.tabId);
      } else if (result?.reason === 'busy') {
        pushToast({ key: 'tab-drag-busy', message: LL.tab.dragBusy(), type: 'warning' });
      }
    } catch { /* window gone */ }
  }, [tabs, onReorder, pushToast, restoreView]);

  useEffect(() => {
    if (!dragActive) return;
    const handleMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 6) return;
        void window.electronAPI.tab.setViewVisibility(false).catch(() => { /* view gone */ });
        setDragState({ ...state, active: true });
      }
      const tabElement = document.elementFromPoint(event.clientX, event.clientY)?.closest?.('[data-tab-id]') as HTMLElement | null;
      const overIndex = tabElement?.dataset.tabId ? tabs.findIndex((item) => item.id === tabElement.dataset.tabId) : null;
      setDragState((prev) => (prev && prev.overIndex !== overIndex ? { ...prev, overIndex } : prev));
    };
    const handleUp = (event: PointerEvent) => { void endDrag(event.clientX, event.clientY); };
    const cancel = () => {
      const state = dragRef.current;
      setDragState(null);
      if (state?.active) restoreView();
    };
    const handleKey = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', handleKey);
      if (dragRef.current?.active) restoreView();
    };
  }, [dragActive, tabs, endDrag, restoreView]);

  const tabCallbacks = useMemo(() => {
    const map = new Map<string, { onSelect: () => void; onClose: () => void; onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void }>();
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const index = i;
      map.set(tab.id, {
        onSelect: () => onSelectTab(tab.id),
        onClose: () => onCloseTab(tab.id),
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => beginDrag(event, tab.id, index),
      });
    }
    return map;
  }, [tabs, onSelectTab, onCloseTab, beginDrag]);

  return (
    <div className="flex flex-col flex-shrink-0 relative topbar-toolbar">
      <div
        /* 顶部 pt-2（8px）是**故意留给系统**的：标签条自身不能是 drag-region，
           否则 Electron 的 WM_NCHITTEST 会先命中拖拽区返回 HTCAPTION，把系统那条约
           8 DIP 的顶部 sizing border 盖掉 —— 上边与上两角就拉不动（左右下三边不在
           拖拽区里，所以一直正常）。drag 下沉到下面的标签行，顶部这片空白交回系统，
           走原生拉伸（DWM 拖动、双击最大化、系统级尺寸约束都由系统管）。
           标签 36px 本来就 items-end 贴底、上方留 9px，让出 8px 后视觉不变。 */
        className="flex items-stretch h-[45px] px-1 pt-2 gap-0.5 topbar-tabbar relative"
      >
        <div
          className="flex items-end h-full overflow-hidden flex-1 scrollbar-none drag-region"
        >
          {tabs.map((tab, index) => {
            const cb = tabCallbacks.get(tab.id);
            return (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={cb?.onSelect ?? (() => {})}
              onClose={cb?.onClose ?? (() => {})}
              onPointerDown={cb?.onPointerDown ?? (() => {})}
              isDragOver={dragState?.overIndex === index && dragState?.index !== index}
              isDragging={dragState?.active === true && dragState.tabId === tab.id}
            />
            );
          })}
          <button className="btn-tab no-drag" onClick={onNewTab} title={LL.tab.newTabHint()}>
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="drag-region h-full" style={{ flex: '0 0 20px' }} />
        <div className="flex items-center h-full no-drag">
          <WindowControls />
        </div>
      </div>
      <div className="browser-toolbar topbar-toolbar">
        <button onClick={onToggleSidebar} className="btn-icon sidebar-toggle-button" title={sidebarOpen ? LL.sidebar.collapse() : LL.sidebar.expand()} aria-pressed={sidebarOpen}>
          {sidebarOpen ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>
        <span className="toolbar-divider" />
        <div className="toolbar-button-group">
          <button onClick={onBack} disabled={!canGoBack} className="btn-icon" title={LL.back()}>
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button onClick={onForward} disabled={!canGoForward} className="btn-icon" title={LL.forward()}>
            <ArrowRight className="w-4 h-4" />
          </button>
          {isLoading ? (
            <button onClick={onStop} className="btn-icon" title={`${LL.stop()} (Esc)`}>
              <X className="w-4 h-4" />
            </button>
          ) : (
            <button onClick={onReload} className="btn-icon" title={`${LL.refresh()} (F5)`}>
              <RotateCw className="w-4 h-4" />
            </button>
          )}
        </div>
        <div className="address-shell">
          <input
            ref={addressInputRef}
            type="text"
            value={addressValue}
            onChange={(e) => setAddressValue(e.target.value)}
            onKeyDown={handleAddressKeyDown}
            placeholder={LL.addressbar.placeholder()}
            className="input-text address-input no-drag"
            spellCheck={false}
            autoComplete="off"
          />
          <button onClick={onToggleBookmark} className="btn-icon address-bookmark-button" title={isBookmarked ? LL.addressbar.bookmarkRemove() : LL.addressbar.bookmarkAdd()}>
            <Star className="w-4 h-4" style={{ fill: isBookmarked ? '#f5c518' : 'none', color: isBookmarked ? '#f5c518' : 'var(--text-secondary)' }} />
          </button>
          <AddressToastHost closeLabel={LL.close()} />
        </div>
        <span className="toolbar-divider toolbar-divider-mode" />
        <div className="toolbar-mode-group">
          <ThemeToggle width={62} height={26} compact />
          <RuffleToggle engineMode={flashEngineMode} ruffleSource={ruffleSource} onToggle={onToggleRuffle} />
        </div>
        <span className="toolbar-divider toolbar-divider-mode" />
        <div className="toolbar-button-group">
          <button
            type="button"
            data-devtoolbox-toggle
            onClick={useDevToolStore.getState().toggle}
            aria-pressed={useDevToolStore((s) => s.open)}
            className="btn-icon"
            title={`${LL.devtools.title()} (F12)`}
          >
            <Terminal className="w-4 h-4" />
          </button>
          <button type="button" onClick={() => void handleScreenshot()} disabled={screenshotting} className="btn-icon" title={LL.settings.screenshot.capture()}>
            <Camera className="w-4 h-4" />
          </button>
          <button type="button" onClick={onToggleMute} className="btn-icon" title={isMuted ? LL.addressbar.unmute() : LL.addressbar.mute()}>
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
      <LoadingProgress visible={isLoading} />
    </div>
  );
};

export default TopBar;
