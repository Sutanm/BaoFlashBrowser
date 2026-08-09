import React, { useEffect, useRef } from 'react';
import {
  Clock,
  Download,
  Key,
  Minus,
  Plus,
  Puzzle,
  Settings as SettingsIcon,
  Star,
  X,
} from 'lucide-react';
import { useI18nContext } from '@renderer/i18n/i18n-react';
import { useDataStore } from '@renderer/store/useDataStore';
import FavoritesPanel from '../panels/FavoritesPanel';
import HistoryPanel from '../panels/HistoryPanel';
import DownloadsPanel from '../panels/DownloadsPanel';
import PasswordsPanel from '../panels/PasswordsPanel';
import SettingsPanel from '../panels/SettingsPanel';
import UserscriptsPanel from '../panels/UserscriptsPanel';
import type { ActivePanel } from '@shared/types/passwords';

export const SIDEBAR_WIDTH = 340;

type PrimarySidebarPanel = Extract<ActivePanel, 'favorites' | 'history' | 'downloads'>;
type SidebarPanel = Exclude<ActivePanel, null>;

interface DrawerSidebarProps {
  isClosing: boolean;
  currentUrl: string;
  activeTabId: string | null;
  currentTitle: string;
  currentFavicon?: string;
  onOpenUrl: (url: string, newTab: boolean) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  downloadCount: number;
}

const PRIMARY_PANELS: PrimarySidebarPanel[] = ['favorites', 'history', 'downloads'];
const SIDEBAR_PANELS: SidebarPanel[] = ['favorites', 'history', 'downloads', 'userscripts', 'passwords', 'settings'];

export function isSidebarPanel(panel: ActivePanel): panel is SidebarPanel {
  return panel !== null && SIDEBAR_PANELS.includes(panel as SidebarPanel);
}

const DrawerSidebar: React.FC<DrawerSidebarProps> = ({
  isClosing,
  currentUrl,
  activeTabId,
  currentTitle,
  currentFavicon,
  onOpenUrl,
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  downloadCount,
}) => {
  const activePanel = useDataStore((state) => state.activePanel);
  const setActivePanel = useDataStore((state) => state.setActivePanel);
  const { LL } = useI18nContext();
  const lastPrimaryPanel = useRef<PrimarySidebarPanel>('favorites');
  const lastVisiblePanel = useRef<SidebarPanel>('favorites');

  useEffect(() => {
    if (isSidebarPanel(activePanel)) {
      lastVisiblePanel.current = activePanel;
    }
    if (activePanel && PRIMARY_PANELS.includes(activePanel as PrimarySidebarPanel)) {
      lastPrimaryPanel.current = activePanel as PrimarySidebarPanel;
    }
  }, [activePanel]);

  const displayedPanel = isSidebarPanel(activePanel) ? activePanel : lastVisiblePanel.current;

  const activeTitle = displayedPanel === 'favorites'
    ? LL.sidebar.favorites()
    : displayedPanel === 'history'
      ? LL.sidebar.history()
      : displayedPanel === 'downloads'
        ? LL.sidebar.downloads()
        : displayedPanel === 'userscripts'
          ? LL.sidebar.userscripts()
          : displayedPanel === 'passwords'
            ? LL.sidebar.passwords()
            : LL.sidebar.settings();

  const panelTabs: Array<{ id: PrimarySidebarPanel; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: 'favorites', label: LL.sidebar.favorites(), icon: Star },
    { id: 'history', label: LL.sidebar.history(), icon: Clock },
    { id: 'downloads', label: LL.sidebar.downloads(), icon: Download },
  ];

  return (
    <aside className={`library-sidebar${isClosing ? ' closing' : ''}`} style={{ width: SIDEBAR_WIDTH }} aria-hidden={isClosing}>
      <div className="library-sidebar-inner" style={{ width: SIDEBAR_WIDTH }}>
      <div className="library-sidebar-header">
        <strong>{activeTitle}</strong>
        <button type="button" className="btn-icon btn-icon-compact" onClick={() => setActivePanel(null)} title={LL.close()}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="library-sidebar-tabs" role="tablist" hidden={!PRIMARY_PANELS.includes(displayedPanel as PrimarySidebarPanel)}>
        {panelTabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={displayedPanel === id}
            className="library-sidebar-tab"
            onClick={() => setActivePanel(id)}
          >
            <Icon className="w-4 h-4" />
            <span>{label}</span>
            {id === 'downloads' && downloadCount > 0 && <span className="sidebar-count">{downloadCount}</span>}
          </button>
        ))}
      </div>

      <div className="library-sidebar-content">
        {displayedPanel === 'favorites' && (
          <FavoritesPanel
            currentUrl={currentUrl}
            currentTitle={currentTitle}
            currentFavicon={currentFavicon}
            onOpenUrl={onOpenUrl}
          />
        )}
        {displayedPanel === 'history' && <HistoryPanel currentUrl={currentUrl} onOpenUrl={onOpenUrl} />}
        {displayedPanel === 'downloads' && <DownloadsPanel />}
        {displayedPanel === 'userscripts' && <UserscriptsPanel tabId={activeTabId} currentUrl={currentUrl} onOpenUrl={onOpenUrl} />}
        {displayedPanel === 'passwords' && <PasswordsPanel />}
        {displayedPanel === 'settings' && (
          <SettingsPanel
            onOpenUrl={onOpenUrl}
          />
        )}
      </div>

      <div className="library-sidebar-tools">
        <div className="sidebar-zoom-controls">
          <button type="button" onClick={onZoomOut} title={LL.addressbar.zoomOut()}><Minus className="w-3.5 h-3.5" /></button>
          <button type="button" onClick={onZoomReset} className="sidebar-zoom-value">{zoomPercent}%</button>
          <button type="button" onClick={onZoomIn} title={LL.addressbar.zoomIn()}><Plus className="w-3.5 h-3.5" /></button>
        </div>
      </div>

      <div className="library-sidebar-footer">
        <button type="button" aria-pressed={displayedPanel === 'userscripts'} onClick={() => setActivePanel(displayedPanel === 'userscripts' ? lastPrimaryPanel.current : 'userscripts')}>
          <Puzzle className="w-4 h-4" /><span>{LL.sidebar.userscripts()}</span>
        </button>
        <button type="button" aria-pressed={displayedPanel === 'passwords'} onClick={() => setActivePanel(displayedPanel === 'passwords' ? lastPrimaryPanel.current : 'passwords')}>
          <Key className="w-4 h-4" /><span>{LL.sidebar.passwords()}</span>
        </button>
        <button type="button" aria-pressed={displayedPanel === 'settings'} onClick={() => setActivePanel(displayedPanel === 'settings' ? lastPrimaryPanel.current : 'settings')}>
          <SettingsIcon className="w-4 h-4" /><span>{LL.sidebar.settings()}</span>
        </button>
      </div>
      </div>
    </aside>
  );
};

export default DrawerSidebar;
