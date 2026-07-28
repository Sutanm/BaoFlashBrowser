import React, { useCallback } from 'react';
import { useAtomValue } from 'jotai';
import WindowControls from './components/shell/WindowControls';
import { useShortcut } from './hooks/useShortcut';
import { useTheme } from './hooks/useTheme';
import { tabsAtom, activeTabIdAtom } from './atoms/tabs.atom';
import { activePanelAtom } from './atoms/ui.atom';
import { addressBarUrlAtom, isLoadingAtom, zoomLevelAtom } from './atoms/navigation.atom';
import { favoritesAtom, historyAtom } from './atoms/data.atom';

const App: React.FC = () => {
  const { theme, toggle: toggleTheme } = useTheme();
  const tabs = useAtomValue(tabsAtom);
  const activeTabId = useAtomValue(activeTabIdAtom);
  const addressBarUrl = useAtomValue(addressBarUrlAtom);

  const handleShortcut = useCallback(
    (action: string) => {
      switch (action) {
        case 'new-tab':
          console.log('[Shortcut] new-tab');
          break;
        case 'close-tab':
          console.log('[Shortcut] close-tab');
          break;
        case 'next-tab':
          console.log('[Shortcut] next-tab');
          break;
        case 'prev-tab':
          console.log('[Shortcut] prev-tab');
          break;
        case 'reload':
          console.log('[Shortcut] reload');
          break;
        case 'stop-or-dismiss':
          console.log('[Shortcut] stop-or-dismiss');
          break;
        case 'focus-address':
          console.log('[Shortcut] focus-address');
          break;
        case 'fullscreen':
          window.electronAPI.win.setFullscreen(true);
          break;
        case 'devtools':
          console.log('[Shortcut] devtools');
          break;
        case 'bookmark':
          console.log('[Shortcut] bookmark');
          break;
        case 'history-panel':
          console.log('[Shortcut] history-panel');
          break;
        case 'find-in-page':
          console.log('[Shortcut] find-in-page');
          break;
        case 'zoom-in':
          console.log('[Shortcut] zoom-in');
          break;
        case 'zoom-out':
          console.log('[Shortcut] zoom-out');
          break;
        case 'zoom-reset':
          console.log('[Shortcut] zoom-reset');
          break;
        default:
          console.log('[Shortcut] unhandled:', action);
      }
    },
    [],
  );

  useShortcut(handleShortcut);

  // Apply dark class on mount
  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return (
    <div className="h-screen flex flex-col bg-gray-100 dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden select-none">
      {/* Title bar */}
      <div className="h-9 bg-gray-200 dark:bg-gray-800 flex items-center justify-between px-3 drag-region shrink-0">
        <span className="text-xs font-medium text-gray-500 dark:text-gray-400">
          BaoFlashBrowser {tabs.length > 0 ? `— ${tabs.length} tab${tabs.length > 1 ? 's' : ''}` : ''}
        </span>
        <WindowControls />
      </div>

      {/* Address bar placeholder */}
      <div className="h-10 bg-white dark:bg-gray-850 border-b border-gray-200 dark:border-gray-700 flex items-center px-3 shrink-0">
        <span className="text-sm text-gray-400">{addressBarUrl || 'Search or enter address'}</span>
      </div>

      {/* Content area */}
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-gray-900">
        <div className="text-center">
          <p className="text-gray-300 dark:text-gray-600 text-2xl font-light">
            BaoFlashBrowser
          </p>
          <p className="text-gray-400 dark:text-gray-500 text-sm mt-2">
            Phase 1 — Core Features In Progress
          </p>
          <button
            onClick={toggleTheme}
            className="mt-4 px-4 py-2 text-xs bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors no-drag"
          >
            {theme === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
