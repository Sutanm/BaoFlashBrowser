import React, { useRef } from 'react';
import AddressBar from './AddressBar';

interface NavigationBarProps {
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onStop: () => void;
  onReload: () => void;
}

const NavigationBar: React.FC<NavigationBarProps> = ({
  url,
  isLoading,
  canGoBack,
  canGoForward,
  onNavigate,
  onBack,
  onForward,
  onStop,
  onReload,
}) => {
  const addressBarRef = useRef<{ focus: () => void }>(null);

  React.useEffect(() => {
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
    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 shrink-0">
      <button
        onClick={onBack}
        disabled={!canGoBack}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default transition-colors text-sm no-drag"
        title="Back"
      >
        ◀
      </button>
      <button
        onClick={onForward}
        disabled={!canGoForward}
        className="shrink-0 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 disabled:cursor-default transition-colors text-sm no-drag"
        title="Forward"
      >
        ▶
      </button>
      <AddressBar
        ref={addressBarRef}
        url={url}
        isLoading={isLoading}
        onNavigate={onNavigate}
        onStop={onStop}
        onReload={onReload}
      />
    </div>
  );
};

export default NavigationBar;
