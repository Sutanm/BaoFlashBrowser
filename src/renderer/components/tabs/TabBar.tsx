import React from 'react';
import TabItem from './TabItem';
import type { TabState } from '@renderer/atoms/tabs.atom';

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

const TabBar: React.FC<TabBarProps> = ({ tabs, activeTabId, onSelectTab, onCloseTab, onNewTab }) => {
  return (
    <div className="flex items-end gap-0.5 bg-gray-100 dark:bg-gray-950 px-2 pt-1 overflow-x-auto shrink-0">
      <div className="flex items-end gap-0.5 flex-1 min-w-0">
        {tabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onSelect={() => onSelectTab(tab.id)}
            onClose={() => onCloseTab(tab.id)}
          />
        ))}
      </div>
      <button
        onClick={onNewTab}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-300 dark:hover:bg-gray-700 transition-colors text-sm mb-0.5 no-drag"
        title="New Tab (Ctrl+T)"
      >
        +
      </button>
    </div>
  );
};

export default TabBar;
