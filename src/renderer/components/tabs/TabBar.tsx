import React from 'react';
import { Plus } from 'lucide-react';
import TabItem from './TabItem';
import WindowControls from '../shell/WindowControls';
import type { TabState } from '@renderer/atoms/tabs.atom';

interface TabBarProps {
  tabs: TabState[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onToggleTheme: () => void;
  isDark: boolean;
}

const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleTheme,
  isDark,
}) => {
  return (
    <div
      className="flex items-center h-[34px] flex-shrink-0 overflow-hidden"
      style={{ background: 'var(--bg-tabbar)' }}
    >
      <div className="flex items-center h-full overflow-x-auto overflow-y-hidden" style={{ scrollbarWidth: 'none' }}>
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
      <button className="btn-tab" onClick={onNewTab} title="新标签页 (Ctrl+T)">
        <Plus className="w-4 h-4" />
      </button>
      <div className="flex-1 drag-region h-full" />
      <div className="flex items-center h-full no-drag">
        <button
          onClick={onToggleTheme}
          className="btn-win text-xs"
          title="切换主题"
        >
          {isDark ? '☀️' : '🌙'}
        </button>
        <WindowControls />
      </div>
    </div>
  );
};

export default TabBar;
