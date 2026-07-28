import React from 'react';

const WindowControls: React.FC = () => {
  const handleMinimize = () => window.electronAPI.win.minimize();
  const handleMaximize = () => window.electronAPI.win.maximize();
  const handleClose = () => window.electronAPI.win.close();

  return (
    <div className="flex items-center gap-1 no-drag">
      <button
        onClick={handleMinimize}
        className="w-3 h-3 rounded-full bg-yellow-400 hover:bg-yellow-300 transition-colors"
        title="Minimize"
      />
      <button
        onClick={handleMaximize}
        className="w-3 h-3 rounded-full bg-green-400 hover:bg-green-300 transition-colors"
        title="Maximize"
      />
      <button
        onClick={handleClose}
        className="w-3 h-3 rounded-full bg-red-400 hover:bg-red-300 transition-colors"
        title="Close"
      />
    </div>
  );
};

export default WindowControls;
