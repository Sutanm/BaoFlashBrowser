import React, { useState, useEffect } from 'react';

const WindowControls: React.FC = () => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const checkMax = () => {
      window.electronAPI.win.isMaximized().then(setIsMaximized);
    };
    checkMax();
    const id = setInterval(checkMax, 500);
    return () => clearInterval(id);
  }, []);

  const handleMaximize = () => {
    if (isMaximized) {
      window.electronAPI.win.unmaximize();
    } else {
      window.electronAPI.win.maximize();
    }
  };

  return (
    <div className="flex h-full no-drag">
      <button onClick={() => window.electronAPI.win.minimize()} className="btn-win" title="最小化">
        <svg width="10" height="1" viewBox="0 0 10 1" fill="none">
          <rect width="10" height="1" fill="currentColor"/>
        </svg>
      </button>
      <button onClick={handleMaximize} className="btn-win" title={isMaximized ? '还原' : '最大化'}>
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
      <button onClick={() => window.electronAPI.win.close()} className="btn-win-close" title="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
          <line x1="1" y1="1" x2="9" y2="9"/>
          <line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </button>
    </div>
  );
};

export default WindowControls;
