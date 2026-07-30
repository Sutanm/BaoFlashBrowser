import React, { useEffect, useRef, useState } from 'react';
import { Star, Clock, Download, Settings as SettingsIcon, X } from 'lucide-react';
import FavoritesPanel from '../panels/FavoritesPanel';
import HistoryPanel from '../panels/HistoryPanel';
import DownloadsPanel from '../panels/DownloadsPanel';
import SettingsPanel from '../panels/SettingsPanel';

interface DrawerSidebarProps {
  collapsed: boolean;
  activePanel: 'favorites' | 'history' | 'downloads' | 'settings' | null;
  currentUrl: string;
  onTogglePanel: (panel: 'favorites' | 'history' | 'downloads' | 'settings') => void;
  onClose: () => void;
  onOpenUrl: (url: string, newTab: boolean) => void;
  zoomPercent: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  downloadCount: number;
}

const PANELS = [
  { id: 'favorites' as const, label: '收藏夹', icon: Star },
  { id: 'history' as const, label: '历史记录', icon: Clock },
  { id: 'downloads' as const, label: '下载', icon: Download },
  { id: 'settings' as const, label: '设置', icon: SettingsIcon },
];

const DrawerSidebar: React.FC<DrawerSidebarProps> = ({
  collapsed,
  activePanel, currentUrl, onTogglePanel, onClose, onOpenUrl,
  zoomPercent, onZoomIn, onZoomOut, onZoomReset,
  downloadCount,
}) => {
  const isOpen = activePanel !== null;
  const [drawerMounted, setDrawerMounted] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const rafRef = useRef(0);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (isOpen) {
      cancelAnimationFrame(rafRef.current);
      setDrawerMounted(true);
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = requestAnimationFrame(() => {
          setDrawerOpen(true);
        });
      });
    } else if (drawerMounted) {
      setDrawerOpen(false);
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = setTimeout(() => setDrawerMounted(false), 300);
    }
    return () => {
      cancelAnimationFrame(rafRef.current);
      clearTimeout(closeTimerRef.current);
    };
  }, [isOpen, drawerMounted]);

  if (collapsed) return null;

  return (
    <>
      {/* Icon strip */}
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
        {PANELS.map(({ id, label, icon: Icon }) => {
          const showBadge = id === 'downloads' && downloadCount > 0;
          return (
          <button
            key={id}
            className={`sidebar-icon ${activePanel === id ? 'active' : ''}`}
            title={label}
            onClick={() => onTogglePanel(id)}
            style={{ position: 'relative' }}
          >
            <Icon className="w-5 h-5" />
            {showBadge && (
              <span style={{
                position: 'absolute', top: 2, right: 2,
                minWidth: 16, height: 16, borderRadius: 8,
                background: '#e74c3c', color: '#fff',
                fontSize: 10, fontWeight: 600,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                padding: '0 4px',
              }}>
                {downloadCount}
              </span>
            )}
          </button>
          );
        })}
      </div>

      {/* Drawer panel */}
      {drawerMounted && (
        <div className={`drawer-panel ${drawerOpen ? 'open' : ''}`}>
          <div className="drawer-inner">
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
            <div className="flex-1 overflow-y-auto">
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
      )}
    </>
  );
};

export default DrawerSidebar;
