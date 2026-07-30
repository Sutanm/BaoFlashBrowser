import React, { useEffect, useRef } from 'react';
import { Star, Clock, Download, Settings as SettingsIcon, X } from 'lucide-react';
import FavoritesPanel from '../panels/FavoritesPanel';
import HistoryPanel from '../panels/HistoryPanel';
import DownloadsPanel from '../panels/DownloadsPanel';
import SettingsPanel from '../panels/SettingsPanel';

interface DrawerSidebarProps {
  activePanel: 'favorites' | 'history' | 'downloads' | 'settings' | null;
  currentUrl: string;
  onTogglePanel: (panel: 'favorites' | 'history' | 'downloads' | 'settings') => void;
  onClose: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
}

const PANELS = [
  { id: 'favorites' as const, label: '收藏夹', icon: Star },
  { id: 'history' as const, label: '历史记录', icon: Clock },
  { id: 'downloads' as const, label: '下载', icon: Download },
  { id: 'settings' as const, label: '设置', icon: SettingsIcon },
];

const DrawerSidebar: React.FC<DrawerSidebarProps> = ({
  activePanel, currentUrl, onTogglePanel, onClose, onOpenUrl,
  zoomPercent, onZoomIn, onZoomOut, onZoomReset,
}) => {
  const isOpen = activePanel !== null;
  const panelRef = useRef<HTMLDivElement>(null);
  const openedOnce = useRef(false);

  // Initial mount: hide element so first open can animate
  useEffect(() => {
    if (panelRef.current) {
      panelRef.current.style.display = 'none';
    }
  }, []);

  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;

    if (isOpen) {
      // Always show and add class when opening
      el.style.display = 'block';
      // Force reflow so the browser registers display:block before adding class
      void el.offsetHeight;
      el.classList.add('open');
      openedOnce.current = true;
    } else if (openedOnce.current) {
      // Remove class to trigger close animation
      el.classList.remove('open');
      // After animation, hide element
      const timer = setTimeout(() => {
        el.style.display = 'none';
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  return (
    <>
      {/* Icon strip — 48px flex child */}
      <div
        className="sidebar-icons"
        style={{
          width: 48,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          padding: '8px 0',
          gap: 4,
          background: 'var(--bg-secondary)',
          borderRight: '1px solid var(--border-light)',
        }}
      >
        {PANELS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            className={`sidebar-icon ${activePanel === id ? 'active' : ''}`}
            title={label}
            onClick={() => onTogglePanel(id)}
          >
            <Icon className="w-5 h-5" />
          </button>
        ))}
      </div>

      {/* Drawer panel — absolute positioned, NOT a flex child */}
      <div ref={panelRef} className="drawer-panel">
        <div className="drawer-inner">
          {/* Header */}
          <div
            className="flex items-center justify-between px-3 py-2 border-b flex-shrink-0"
            style={{ borderColor: 'var(--border-light)' }}
          >
            <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
              {PANELS.find((p) => p.id === activePanel)?.label}
            </span>
            <button onClick={onClose} className="btn-icon" style={{ width: 24, height: 24 }}>
              <X className="w-4 h-4" />
            </button>
          </div>
          {/* Panel content */}
          <div className="flex-1 overflow-hidden">
            {activePanel === 'favorites' && (
              <FavoritesPanel currentUrl={currentUrl} onOpenUrl={onOpenUrl} />
            )}
            {activePanel === 'history' && (
              <HistoryPanel currentUrl={currentUrl} onOpenUrl={onOpenUrl} />
            )}
            {activePanel === 'downloads' && <DownloadsPanel />}
            {activePanel === 'settings' && (
              <SettingsPanel
                zoomPercent={zoomPercent}
                onZoomIn={onZoomIn}
                onZoomOut={onZoomOut}
                onZoomReset={onZoomReset}
              />
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default DrawerSidebar;
