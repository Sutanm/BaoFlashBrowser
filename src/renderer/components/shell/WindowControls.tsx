import React, { useState, useEffect, useCallback } from 'react';
import { useI18nContext } from '@renderer/i18n/i18n-react';

const WindowControls: React.FC = () => {
  const { LL } = useI18nContext();
  const [isMaximized, setIsMaximized] = useState(false);

  const checkMax = useCallback(() => {
    window.electronAPI.win.isMaximized().then(setIsMaximized);
  }, []);

  useEffect(() => {
    checkMax();
    window.addEventListener('resize', checkMax);
    return () => window.removeEventListener('resize', checkMax);
  }, [checkMax]);

  const handleMaximize = () => {
    if (isMaximized) {
      window.electronAPI.win.unmaximize();
    } else {
      window.electronAPI.win.maximize();
    }
  };

  return (
    <div className="flex h-full no-drag">
      <button onClick={() => window.electronAPI.win.minimize()} className="btn-win" title={LL.win.minimize()}>
        <svg width="10" height="1" viewBox="0 0 10 1" fill="none">
          <rect width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button onClick={handleMaximize} className="btn-win" title={isMaximized ? LL.win.restore() : LL.win.maximize()}>
        {isMaximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="2" y="0" width="8" height="8" rx="1"/>
            <rect x="0" y="2" width="8" height="8" rx="1"/>
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
            <rect x="0.5" y="0.5" width="9" height="9" rx="1"/>
          </svg>
        )}
      </button>
      <button onClick={() => window.electronAPI.win.close()} className="btn-win-close" title={LL.win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
          <line x1="1" y1="1" x2="9" y2="9"/>
          <line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </button>
    </div>
  );
};

export default WindowControls;
