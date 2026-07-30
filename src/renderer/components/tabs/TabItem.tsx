import React, { memo } from 'react';
import { Globe, Loader2, X } from 'lucide-react';
import type { TabState } from '@renderer/atoms/tabs.atom';

interface TabItemProps {
  tab: TabState;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
  onDragStart: () => void;
  onDragOver: () => void;
  onDragEnd: () => void;
  onDrop: () => void;
  isDragOver: boolean;
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  onSelect,
  onClose,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  isDragOver,
}) => {
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.id);
    e.currentTarget.setAttribute('data-dragging', 'true');
    onDragStart();
  };

  const handleDragEnd = (e: React.DragEvent) => {
    e.currentTarget.removeAttribute('data-dragging');
    onDragEnd();
  };

  return (
    <div
      draggable
      onClick={onSelect}
      onDragStart={handleDragStart}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        onDragOver();
      }}
      onDragEnd={handleDragEnd}
      onDrop={(e) => {
        e.preventDefault();
        onDrop();
      }}
      className={`tab-item ${isActive ? 'active' : ''} ${isDragOver ? 'drag-over' : ''}`}
      title={tab.url || tab.title}
    >
      <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
        {tab.isLoading ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-gray-400" />
        ) : tab.favicon ? (
          <img src={tab.favicon} className="w-3.5 h-3.5" alt="" />
        ) : (
          <Globe className="w-3.5 h-3.5 text-gray-400" />
        )}
      </span>
      <span className="truncate leading-none">{tab.title || 'New Tab'}</span>
      {tab.isAudible && (
        <span className="text-[10px] flex-shrink-0">{tab.isMuted ? '🔇' : '🔊'}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="tab-close"
        title="关闭标签页"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export default memo(TabItem);
