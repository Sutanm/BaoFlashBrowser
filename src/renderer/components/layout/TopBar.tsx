import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { Plus, ArrowLeft, ArrowRight, RotateCw, X, Volume2, VolumeX, Star, PanelLeftOpen, PanelLeftClose, ZoomIn, ZoomOut } from 'lucide-react';
import TabItem from '../tabs/TabItem';
import WindowControls from '../shell/WindowControls';
import RuffleToggle from '../navigation/RuffleToggle';
import { useDataStore } from '@renderer/store/useDataStore';
import type { AddressToast } from '@renderer/store/useDataStore';
import type { TabState } from '@renderer/store/useTabsStore';
import type { FlashEngineMode } from '@shared/types/settings';

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

  // --- Toast 队列：订阅 store，逐条消费，触发地址栏翻转 ---
  const toastQueue = useDataStore((s) => s.toastQueue);
  const setToastQueue = useDataStore((s) => s.setToastQueue);
  const [currentToast, setCurrentToast] = useState<AddressToast | null>(null);
  const [flipping, setFlipping] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const toastColorMap = { success: '#27ae60', info: '#3498db', warning: '#f39c12', error: '#e74c3c' };

  // 队列推送新 toast 时，若当前无显示则立即消费
  useEffect(() => {
    if (toastQueue.length > 0 && !currentToast) {
      const next = toastQueue[0];
      setToastQueue((prev) => prev.slice(1));
      setCurrentToast(next);
      setFlipping(true);
      const flipOff = setTimeout(() => setFlipping(false), 300);
      // 有 actions 的 toast 不自动消失（等用户操作），其它按 duration 或默认 2500ms
      const hasActions = next.actions && next.actions.length > 0;
      const dur = hasActions ? null : (next.duration ?? 2500);
      clearTimeout(toastTimerRef.current);
      if (dur !== null) {
        toastTimerRef.current = setTimeout(() => {
          setFlipping(true);
          setTimeout(() => { setFlipping(false); setCurrentToast(null); }, 300);
        }, dur);
      }
      return () => clearTimeout(flipOff);
    }
  }, [toastQueue, currentToast, setToastQueue]);

  const dismissToast = useCallback(() => {
    clearTimeout(toastTimerRef.current);
    setFlipping(true);
    setTimeout(() => { setFlipping(false); setCurrentToast(null); }, 300);
  }, []);

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
        <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
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
          />
          {currentToast && (
            <div
              className={`toast-overlay ${flipping ? 'address-flip' : ''}`}
              onClick={dismissToast}
              style={{
                background: currentToast.color || toastColorMap[currentToast.type],
              }}
            >
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {currentToast.message}
              </span>
              {currentToast.actions && currentToast.actions.length > 0 && (
                <div className="toast-actions">
                  {currentToast.actions.map((action, i) => (
                    <button
                      key={i}
                      className={`toast-btn ${action.primary ? 'toast-btn-primary' : ''}`}
                      onClick={(e) => { e.stopPropagation(); action.onClick(); dismissToast(); }}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <button onClick={onZoomOut} className="btn-icon btn-icon-sm" title="缩小 (Ctrl+-)">
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <span className="zoom-capsule" onClick={onZoomReset} title="点击重置为100%" style={{ cursor: 'pointer' }}>
          {zoomPercent}%
        </span>
        <button onClick={onZoomIn} className="btn-icon btn-icon-sm" title="放大 (Ctrl++)">
          <ZoomIn className="w-3.5 h-3.5" />
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