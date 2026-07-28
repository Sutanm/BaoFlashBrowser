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
        &#8211;
      </button>
      <button onClick={handleMaximize} className="btn-win" title={isMaximized ? '还原' : '最大化'}>
        {isMaximized ? '❐' : '□'}
      </button>
      <button onClick={() => window.electronAPI.win.close()} className="btn-win-close" title="关闭">
        &times;
      </button>
    </div>
  );
};

export default WindowControls;
