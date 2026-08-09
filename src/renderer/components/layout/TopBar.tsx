import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Plus, ArrowLeft, ArrowRight, RotateCw, X, Star, PanelLeftOpen, PanelLeftClose, Camera, Volume2, VolumeX } from 'lucide-react';
import TabItem from '../tabs/TabItem';
import WindowControls from '../shell/WindowControls';
import RuffleToggle from '../navigation/RuffleToggle';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import type { TabState } from '@renderer/store/useTabsStore';
import type { FlashEngineMode } from '@shared/types/settings';
import AddressToastHost from '../overlays/AddressToastHost';
import ThemeToggle from '../panels/ThemeToggle';
import { useDataStore } from '@renderer/store/useDataStore';

interface TopBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isDark: boolean;
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
  isDark: _isDark,
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

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index);
  }, []);

  const handleDragOver = useCallback((index: number) => {
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => {
    if (dragIndex !== null && dragIndex !== index) {
      onReorder(dragIndex, index);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  }, [dragIndex, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  const tabCallbacks = useMemo(() => {
    const map = new Map<string, { onSelect: () => void; onClose: () => void; onDragStart: () => void; onDragOver: () => void; onDrop: () => void }>();
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i];
      const index = i;
      map.set(tab.id, {
        onSelect: () => onSelectTab(tab.id),
        onClose: () => onCloseTab(tab.id),
        onDragStart: () => handleDragStart(index),
        onDragOver: () => handleDragOver(index),
        onDrop: () => handleDrop(index),
      });
    }
    return map;
  }, [tabs, onSelectTab, onCloseTab, handleDragStart, handleDragOver, handleDrop]);

  return (
    <div className="flex flex-col flex-shrink-0 topbar-toolbar">
      <div
        className="flex items-stretch h-[45px] px-1 gap-0.5 topbar-tabbar drag-region"
      >
        <div
          className="flex items-end h-full overflow-hidden flex-1 scrollbar-none"
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
              onDragStart={cb?.onDragStart ?? (() => {})}
              onDragOver={cb?.onDragOver ?? (() => {})}
              onDragEnd={handleDragEnd}
              onDrop={cb?.onDrop ?? (() => {})}
              isDragOver={dragOverIndex === index && dragIndex !== index}
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
          <button type="button" onClick={() => void handleScreenshot()} disabled={screenshotting} className="btn-icon" title={LL.settings.screenshot.capture()}>
            <Camera className="w-4 h-4" />
          </button>
          <button type="button" onClick={onToggleMute} className="btn-icon" title={isMuted ? LL.addressbar.unmute() : LL.addressbar.mute()}>
            {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
        </div>
      </div>
    </div>
  );
};

export default TopBar;
