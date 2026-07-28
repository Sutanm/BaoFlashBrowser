import React from 'react';

const WindowControls: React.FC = () => {
  return (
    <div className="flex h-full no-drag">
      <button
        onClick={() => window.electronAPI.win.minimize()}
        className="btn-win"
        title="最小化"
      >
        &#8211;
      </button>
      <button
        onClick={() => window.electronAPI.win.maximize()}
        className="btn-win"
        title="最大化"
      >
        &#9633;
      </button>
      <button
        onClick={() => window.electronAPI.win.close()}
        className="btn-win-close"
        title="关闭"
      >
        &times;
      </button>
    </div>
  );
};

export default WindowControls;
