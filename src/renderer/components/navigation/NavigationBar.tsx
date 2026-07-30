import React, { useRef, useEffect } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, X, Volume2, Star, Clock, Download, Settings as SettingsIcon } from 'lucide-react';
import AddressBar from './AddressBar';

interface NavigationBarProps {
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isMuted: boolean;
  isBookmarked: boolean;
  zoomPercent: number;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onStop: () => void;
  onReload: () => void;
  onToggleMute: () => void;
  onToggleFavorites: () => void;
  onToggleHistory: () => void;
  onToggleDownloads: () => void;
  onToggleSettings: () => void;
}

const NavigationBar: React.FC<NavigationBarProps> = ({
  url,
  isLoading,
  canGoBack,
  canGoForward,
  isMuted,
  isBookmarked,
  zoomPercent,
  onNavigate,
  onBack,
  onForward,
  onStop,
  onReload,
  onToggleMute,
  onToggleFavorites,
  onToggleHistory,
  onToggleDownloads,
  onToggleSettings,
}) => {
  const addressBarRef = useRef<{ focus: () => void }>(null);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        e.preventDefault();
        addressBarRef.current?.focus();
      }
      if (e.altKey && e.key === 'd') {
        e.preventDefault();
        addressBarRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, []);

  return (
    <div
      id="toolbar"
      className="flex items-center gap-1 h-[38px] px-2 flex-shrink-0"
      style={{ background: 'var(--bg-toolbar)', borderBottom: '1px solid var(--border-light)' }}
    >
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="btn-icon"
        title="后退"
      >
        <ArrowLeft className="w-4 h-4" />
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        className="btn-icon"
        title="前进"
      >
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
      <AddressBar ref={addressBarRef} url={url} isLoading={isLoading} zoomPercent={zoomPercent} onNavigate={onNavigate} />
      <button
        onClick={onToggleMute}
        className="btn-icon"
        title={isMuted ? '取消静音' : '静音'}
        style={{ opacity: isMuted ? 0.5 : 1 }}
      >
        <Volume2 className="w-4 h-4" />
      </button>
      <button onClick={onToggleFavorites} className="btn-icon" title={isBookmarked ? '已收藏' : '收藏夹'}>
        <Star className="w-4 h-4" fill={isBookmarked ? '#ffd700' : 'none'} color={isBookmarked ? '#ffd700' : undefined} />
      </button>
      <button onClick={onToggleHistory} className="btn-icon" title="历史记录">
        <Clock className="w-4 h-4" />
      </button>
      <button onClick={onToggleDownloads} className="btn-icon" title="下载">
        <Download className="w-4 h-4" />
      </button>
      <button onClick={onToggleSettings} className="btn-icon" title="设置">
        <SettingsIcon className="w-4 h-4" />
      </button>
    </div>
  );
};

export default NavigationBar;
