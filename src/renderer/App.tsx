import React, { useCallback } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useTheme } from './hooks/useTheme';
import { useShortcut } from './hooks/useShortcut';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { generateId, normalizeUrl } from './services/id.service';
import type { TabState } from './atoms/tabs.atom';

const App: React.FC = () => {
  const { theme, toggle } = useTheme();
  const [tabs, setTabs] = useAtom(tabsAtom);
  const [activeTabId, setActiveTabId] = useAtom(activeTabIdAtom);

  const createTab = useCallback((url?: string) => {
    const id = generateId();
    const tab: TabState = {
      id, url: url || 'about:newtab', title: 'New Tab',
      zoomLevel: 1.0, isLoading: false, isAudible: false, isMuted: false,
      canGoBack: false, canGoForward: false, createdAt: Date.now(),
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabId(id);
    return id;
  }, [setTabs, setActiveTabId]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => prev.filter((t) => t.id !== tabId));
  }, [setTabs]);

  React.useEffect(() => { if (tabs.length === 0) createTab(); }, [tabs.length, createTab]);

  useShortcut((action) => {
    if (action === 'new-tab') createTab();
    if (action === 'close-tab' && activeTabId) closeTab(activeTabId);
  });

  return React.createElement('div', {
    className: 'h-screen flex flex-col bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100',
    style: { fontFamily: 'sans-serif' }
  },
    React.createElement('div', {
      className: 'h-9 bg-gray-200 dark:bg-gray-800 flex items-center justify-between px-3'
    },
      React.createElement('span', { className: 'text-xs' }, 'BaoFlashBrowser'),
      React.createElement('button', { onClick: toggle, className: 'text-xs px-2 py-0.5 rounded bg-gray-300 dark:bg-gray-700' },
        theme === 'light' ? '🌙' : '☀️'),
    ),
    React.createElement('div', { className: 'flex-1 flex items-center justify-center' },
      React.createElement('div', { className: 'text-center' },
        React.createElement('p', { className: 'text-gray-400 text-2xl' }, 'BaoFlashBrowser'),
        React.createElement('p', { className: 'text-gray-500 text-sm mt-2' }, `Tabs: ${tabs.length}`),
        React.createElement('button', {
          onClick: () => createTab(),
          className: 'mt-4 px-4 py-2 text-sm bg-blue-500 text-white rounded hover:bg-blue-600'
        }, '+ New Tab'),
      ),
    ),
  );
};

export default App;
