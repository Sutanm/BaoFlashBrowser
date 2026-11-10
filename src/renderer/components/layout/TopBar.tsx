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
  //
  // 四个阶段，对齐 Chrome 的手感：
  //   pending → drag    位移 > 6px，指针仍在标签栏内：只做重排，页面不动。
  //   drag → tearing    指针离开标签栏：立刻藏 BrowserView（只有藏了，指针进入网页区后
  //                     事件才回得到外壳；藏着等就晚了——松手事件会被 view 吃掉），
  //                     并在进入网页区的那一刻立即 tear-off，不等松手。
  //   tearing → torn    tear-off 完成，新窗口已经在跟手；此后的排版/落点全交给主进程。
  //   torn → 结束       松手：`win:drag-drop` 决定回吸 / 跨窗移动 / 就地放下。
  type DragPhase = 'pending' | 'drag' | 'tearing' | 'torn';
  type DragInfo = {
    tabId: string;
    index: number;
    startX: number;
    startY: number;
    active: boolean;
    overIndex: number | null;
    phase: DragPhase;
  };
  const [dragState, setDragState] = useState<DragInfo | null>(null);
  const dragRef = useRef(dragState);
  useEffect(() => { dragRef.current = dragState; }, [dragState]);
  const dragActive = Boolean(dragState);
  /** 当前 BrowserView 是否已被挪走。 */
  const viewHiddenRef = useRef(false);
  /** tear-off 正在进行：用它保证一次拖拽只开一个新窗口。 */
  const tearOffRef = useRef<Promise<void> | null>(null);
  /** 松手发生在 tear-off 就绪之前：就绪后立刻落定，别把窗口吊在半空。 */
  const dropPendingRef = useRef(false);

  const restoreView = useCallback(() => {
    viewHiddenRef.current = false;
    void window.electronAPI.tab.setViewVisibility(true).catch(() => { /* view gone */ });
  }, []);

  const hideView = useCallback(() => {
    if (viewHiddenRef.current) return;
    viewHiddenRef.current = true;
    void window.electronAPI.tab.setViewVisibility(false).catch(() => { /* view gone */ });
  }, []);

  /** 内容区（网页区）顶部在 clientY 上的位置：决定"什么时候该把 view 藏起来"。 */
  const contentTopRef = useRef(0);

  const beginDrag = useCallback((event: React.PointerEvent<HTMLDivElement>, tabId: string, index: number) => {
    if (event.button !== 0) return;
    dropPendingRef.current = false;
    contentTopRef.current = document.querySelector('.workspace-main')?.getBoundingClientRect().top ?? 0;
    setDragState({ tabId, index, startX: event.clientX, startY: event.clientY, active: false, overIndex: null, phase: 'pending' });
  }, []);

  /** 把标签迁进跟随指针的新窗口（一次拖拽只允许一次）。 */
  const startTearOff = useCallback((tabId: string) => {
    if (tearOffRef.current) return;
    setDragState((prev) => (prev && prev.tabId === tabId ? { ...prev, phase: 'tearing' } : prev));
    tearOffRef.current = (async () => {
      try {
        const result = await window.electronAPI.win.tearOffTab(tabId);
        if (!result?.moved) {
          // busy / renderer 超时：整段拖拽作废，别留下半开的窗口。
          pushToast({ key: 'tab-drag-busy', message: LL.tab.dragBusy(), type: 'warning' });
          setDragState(null);
          restoreView();
          return;
        }
        setDragState((prev) => (prev && prev.tabId === tabId ? { ...prev, phase: 'torn' } : prev));
        if (dropPendingRef.current) {
          dropPendingRef.current = false;
          setDragState(null);
          await window.electronAPI.win.dragDrop(tabId).catch(() => { /* window gone */ });
          // 主进程放开了 viewHold，这里同步本地的隐藏标记并让视图按容器 rect 回来。
          restoreView();
        }
      } catch { /* window gone */ } finally {
        tearOffRef.current = null;
      }
    })();
  }, [pushToast, restoreView]);

  const endDrag = useCallback(async (clientX: number, clientY: number) => {
    const state = dragRef.current;
    if (!state || !state.active) {
      setDragState(null);
      return;
    }
    // 已经分离出窗口：落点由主进程按屏幕坐标裁决，本窗口不再参与排版。
    if (state.phase === 'torn') {
      setDragState(null);
      await window.electronAPI.win.dragDrop(state.tabId).catch(() => { /* window gone */ });
      restoreView();
      return;
    }
    // tear-off 还在路上（新窗口要等 renderer 握手）：先记住"该落定了"。
    if (state.phase === 'tearing') {
      dropPendingRef.current = true;
      return;
    }

    setDragState(null);
    restoreView();
    const element = document.elementFromPoint(clientX, clientY);
    const tabElement = element?.closest?.('[data-tab-id]') as HTMLElement | null;
    if (tabElement?.dataset.tabId) {
      const targetIndex = tabs.findIndex((item) => item.id === tabElement.dataset.tabId);
      if (targetIndex >= 0 && targetIndex !== state.index) onReorder(state.index, targetIndex);
      return;
    }
    // 落点在窗口外或别的窗口上时渲染层拿不到元素（null），跨窗移动交给主进程。
    // 落到本窗口的壳层（顶栏/侧边栏/浮层）= 取消。
    if (element && !element.closest?.('.workspace-main')) return;
    try {
      if (typeof window.electronAPI.win.moveTab !== 'function') return;
      const result = await window.electronAPI.win.moveTab(state.tabId, { zone: element ? 'content' : undefined });
      if (result?.reason === 'busy') {
        pushToast({ key: 'tab-drag-busy', message: LL.tab.dragBusy(), type: 'warning' });
      } else if (result?.reason === 'new-window') {
        await window.electronAPI.win.tearOffTab(state.tabId).catch(() => { /* window gone */ });
      }
    } catch { /* window gone */ }
  }, [tabs, onReorder, pushToast, restoreView]);

  useEffect(() => {
    if (!dragActive) return;
    const handleMove = (event: PointerEvent) => {
      const state = dragRef.current;
      if (!state) return;
      let current = state;
      if (!state.active) {
        if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) < 6) return;
        current = { ...state, active: true, phase: 'drag' };
        setDragState(current);
      }
      if (current.phase === 'tearing' || current.phase === 'torn') return;

      const hovered = document.elementFromPoint(event.clientX, event.clientY);
      const overTabbar = Boolean(hovered?.closest?.('.topbar-tabbar'));
      if (overTabbar) {
        // 还在标签栏里：只是换顺序，页面不该消失（这就是"拖一下闪一下"的来源）。
        if (viewHiddenRef.current) restoreView();
        const tabElement = hovered?.closest?.('[data-tab-id]') as HTMLElement | null;
        const overIndex = tabElement?.dataset.tabId ? tabs.findIndex((item) => item.id === tabElement.dataset.tabId) : null;
        setDragState((prev) => (prev && prev.overIndex !== overIndex ? { ...prev, overIndex } : prev));
        return;
      }
      // 快贴到内容区上沿才藏 view：拖到地址栏/顶栏空白不该让页面消失。
      // 必须比内容区早一帧藏——指针一进网页区就被 BrowserView 接管，那时再藏就晚了。
      if (event.clientY >= contentTopRef.current - 2) hideView();
      // 进入网页区 = 想把它拽出来 → 立即分离，不等松手。
      if (hovered && hovered.closest?.('.workspace-main')) startTearOff(current.tabId);
    };
    const handleUp = (event: PointerEvent) => { void endDrag(event.clientX, event.clientY); };
    const cancel = () => {
      const state = dragRef.current;
      setDragState(null);
      if (!state) return;
      if (state.phase === 'tearing' || state.phase === 'torn') {
        dropPendingRef.current = false;
        void window.electronAPI.win.dragDrop(state.tabId, { cancel: true })
          .then(() => { restoreView(); })
          .catch(() => { /* window gone */ });
        return;
      }
      if (state.active) restoreView();
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
  }, [dragActive, tabs, endDrag, startTearOff, restoreView, hideView]);

  /**
   * 只剩一个标签时禁掉"拖出去"：把唯一标签拖走等于把窗口搬走，用户既没有落点
   * 也没有收益（源窗口会被拖空。Chrome 在这种状态下按住标签是**移动窗口**）。
   * 所以这一个标签改由 `-webkit-app-region: drag` 接管（见 TabItem 的 windowDrag）。
   */
  const singleTab = tabs.length <= 1;

  const tabCallbacks = useMemo(() => {
    const map = new Map<string, { onSelect: () => void; onClose: () => void; onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void }>();
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const index = i;
      map.set(tab.id, {
        onSelect: () => onSelectTab(tab.id),
        onClose: () => onCloseTab(tab.id),
        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
          if (singleTab) return;
          beginDrag(event, tab.id, index);
        },
      });
    }
    return map;
  }, [tabs, singleTab, onSelectTab, onCloseTab, beginDrag]);

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
              windowDrag={singleTab}
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
