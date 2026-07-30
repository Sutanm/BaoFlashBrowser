import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { Plus, ArrowLeft, ArrowRight, RotateCw, X, Volume2, VolumeX, Star, PanelLeftOpen, PanelLeftClose } from 'lucide-react';
import TabItem from '../tabs/TabItem';
import WindowControls from '../shell/WindowControls';
import RuffleToggle from '../navigation/RuffleToggle';
import type { TabState } from '@renderer/atoms/tabs.atom';
import type { FlashEngineMode } from '@shared/types/settings';
import { toastQueueAtom } from '@renderer/atoms/data.atom';

interface TopBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isMuted: boolean;
  isDark: boolean;
  zoomPercent: number;
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
  onToggleMute: () => void;
  onToggleRuffle: () => void;
  onToggleBookmark: () => void;
  onToggleSidebar: () => void;
  isBookmarked: boolean;
  sidebarCollapsed: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
}

const TopBar: React.FC<TopBarProps> = ({
  tabs,
  activeTabId,
  url,
  isLoading,
  canGoBack,
  canGoForward,
  isMuted,
  isDark: _isDark,
  zoomPercent,
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
  onToggleMute,
  onToggleRuffle,
  onToggleBookmark,
  onToggleSidebar,
  isBookmarked,
  sidebarCollapsed,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onReorder,
}) => {
  const [addressValue, setAddressValue] = useState(url);
  const addressInputRef = useRef<HTMLInputElement>(null);
  const savedUrlRef = useRef('');
  const prevHadToastRef = useRef(false);
  const [flipping, setFlipping] = useState(false);
  const [toastColor, setToastColor] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const toastQueue = useAtomValue(toastQueueAtom);
  const setToastQueue = useSetAtom(toastQueueAtom);

  // Address bar flip animation for toast queue
  useEffect(() => {
    const toast = toastQueue[0];
    if (!toast) {
      prevHadToastRef.current = false;
      return;
    }
    clearTimeout(toastTimerRef.current);

    if (!prevHadToastRef.current) {
      savedUrlRef.current = addressValue;
    }
    prevHadToastRef.current = true;

    const bg = toast.color || (
      toast.type === 'success' ? '#27ae60'
      : toast.type === 'info' ? '#3498db'
      : toast.type === 'warning' ? '#f39c12'
      : '#e74c3c'
    );

    setFlipping(true);
    setTimeout(() => {
      setAddressValue(toast.message);
      setToastColor(bg);
      setFlipping(false);
    }, 150);

    const duration = toast.duration || 1500;

    toastTimerRef.current = setTimeout(() => {
      setFlipping(true);
      setTimeout(() => {
        setAddressValue(savedUrlRef.current);
        setToastColor(null);
        setFlipping(false);
        setToastQueue((prev) => prev.slice(1));
      }, 150);
    }, duration);

    return () => clearTimeout(toastTimerRef.current);
  }, [toastQueue, setToastQueue]);

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
        className="flex items-center h-[42px] px-1 pt-1 gap-0.5 topbar-tabbar drag-region"
      >
        <div
          className="flex items-center h-full overflow-hidden flex-1 scrollbar-none"
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
          <button className="btn-tab no-drag" onClick={onNewTab} title="新标签页 (Ctrl+T)">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="drag-region h-full" style={{ flex: '0 0 20px' }} />
        <div className="flex items-center h-full no-drag">
          <WindowControls />
        </div>
      </div>
      <div
        className="flex items-center gap-1 h-[40px] px-2 flex-shrink-0 topbar-toolbar"
      >
        <button onClick={onToggleSidebar} className="btn-icon" title={sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'}>
          {sidebarCollapsed ? <PanelLeftClose className="w-4 h-4" /> : <PanelLeftOpen className="w-4 h-4" />}
        </button>
        <button onClick={onBack} disabled={!canGoBack} className="btn-icon" title="后退">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button onClick={onForward} disabled={!canGoForward} className="btn-icon" title="前进">
          <ArrowRight className="w-4 h-4" />
        </button>
        {isLoading ? (
          <button onClick={onStop} className="btn-icon" title="停止 (Esc)">
            <X className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={onReload} className="btn-icon" title="刷新 (F5)">
            <RotateCw className="w-4 h-4" />
          </button>
        )}
        <RuffleToggle engineMode={flashEngineMode} ruffleSource={ruffleSource} onToggle={onToggleRuffle} />
        <input
          ref={addressInputRef}
          type="text"
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          placeholder="输入网址或搜索..."
          className={`input-text no-drag ${flipping ? 'address-flip' : ''}`}
          spellCheck={false}
          autoComplete="off"
          style={toastColor ? {
            background: toastColor,
            color: '#fff',
            fontWeight: 500,
          } : undefined}
        />
        <button onClick={onZoomOut} className="btn-icon btn-icon-sm" title="缩小 (Ctrl+-)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <span className="zoom-capsule" onClick={onZoomReset} title="点击重置为100%" style={{ cursor: 'pointer' }}>
          {zoomPercent}%
        </span>
        <button onClick={onZoomIn} className="btn-icon btn-icon-sm" title="放大 (Ctrl++)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button onClick={onToggleBookmark} className="btn-icon" title={isBookmarked ? '取消收藏' : '收藏当前页'}>
          <Star className="w-4 h-4" style={{ fill: isBookmarked ? '#f5c518' : 'none', color: isBookmarked ? '#f5c518' : 'var(--text-secondary)' }} />
        </button>
        <button
          onClick={onToggleMute}
          className="btn-icon btn-mute"
          title={isMuted ? '取消静音' : '静音'}
          style={{ opacity: isMuted ? 0.5 : 1, background: isMuted ? 'var(--bg-hover)' : 'transparent' }}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};

export default TopBar;