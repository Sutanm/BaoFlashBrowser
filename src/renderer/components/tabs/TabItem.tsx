import React from 'react';
import type { TabState } from '@renderer/atoms/tabs.atom';

interface TabItemProps {
  tab: TabState;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

const TabItem: React.FC<TabItemProps> = ({ tab, isActive, onSelect, onClose }) => {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg cursor-pointer text-xs max-w-48 shrink-0 transition-colors select-none no-drag ${
        isActive
          ? 'bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100'
          : 'bg-gray-200 dark:bg-gray-800 text-gray-500 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-700'
      }`}
    >
      <span className="text-xs shrink-0">
        {tab.isLoading ? '⏳' : tab.favicon ? (
          <img src={tab.favicon} className="w-3.5 h-3.5" alt="" />
        ) : (
          '🌐'
        )}
      </span>
      <span className="truncate">{tab.title || 'New Tab'}</span>
      {tab.isAudible && (
        <span className="text-[10px] shrink-0">{tab.isMuted ? '🔇' : '🔊'}</span>
      )}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 w-4 h-4 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-gray-400 dark:hover:bg-gray-600 transition-all text-[10px]"
      >
        ✕
      </button>
    </div>
  );
};

export default TabItem;
