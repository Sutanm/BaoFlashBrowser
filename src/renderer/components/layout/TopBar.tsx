import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Plus, ArrowLeft, ArrowRight, RotateCw, X, Volume2, VolumeX } from 'lucide-react';
import TabItem from '../tabs/TabItem';
import WindowControls from '../shell/WindowControls';
import type { TabState } from '@renderer/atoms/tabs.atom';

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
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onStop: () => void;
  onReload: () => void;
  onToggleMute: () => void;
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
  isDark,
  zoomPercent,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onNavigate,
  onBack,
  onForward,
  onStop,
  onReload,
  onToggleMute,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onReorder,
}) => {
  const [addressValue, setAddressValue] = useState(url);
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

  return (
    <div className="flex flex-col flex-shrink-0" style={{ background: 'var(--bg-toolbar)' }}>
      <div
        className="flex items-center h-[36px] px-1 pt-1 gap-0.5"
        style={{ background: 'var(--bg-secondary)' }}
      >
        <div
          className="flex items-center h-full overflow-x-auto overflow-y-hidden flex-1"
          style={{ scrollbarWidth: 'none' }}
        >
          {tabs.map((tab, index) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => onSelectTab(tab.id)}
              onClose={() => onCloseTab(tab.id)}
              onDragStart={() => handleDragStart(index)}
              onDragOver={() => handleDragOver(index)}
              onDragEnd={handleDragEnd}
              onDrop={() => handleDrop(index)}
              isDragOver={dragOverIndex === index && dragIndex !== index}
            />
          ))}
          <button className="btn-tab" onClick={onNewTab} title="新标签页 (Ctrl+T)">
            <Plus className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 drag-region h-full" />
        <div className="flex items-center h-full no-drag">
          <WindowControls />
        </div>
      </div>
      <div
        className="flex items-center gap-1 h-[38px] px-2 flex-shrink-0"
        style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-light)' }}
      >
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
        <input
          ref={addressInputRef}
          type="text"
          value={addressValue}
          onChange={(e) => setAddressValue(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          placeholder="输入网址或搜索..."
          className="input-text no-drag"
          spellCheck={false}
          autoComplete="off"
        />
        <button onClick={onZoomOut} className="btn-icon" title="缩小 (Ctrl+-)" style={{ width: 28, height: 28 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <span className="zoom-capsule" onClick={onZoomReset} title="点击重置为100%" style={{ cursor: 'pointer' }}>
          {zoomPercent}%
        </span>
        <button onClick={onZoomIn} className="btn-icon" title="放大 (Ctrl++)" style={{ width: 28, height: 28 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/></svg>
        </button>
        <button
          onClick={onToggleMute}
          className="btn-icon"
          title={isMuted ? '取消静音' : '静音'}
          style={{ opacity: isMuted ? 0.5 : 1, background: isMuted ? 'var(--bg-hover)' : 'transparent', borderRadius: '4px', padding: '4px' }}
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
      </div>
    </div>
  );
};

export default TopBar;