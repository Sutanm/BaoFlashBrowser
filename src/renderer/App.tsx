import React from 'react';

const App: React.FC = () => {
  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      {/* Title bar */}
      <div className="h-8 bg-gray-100 dark:bg-gray-800 flex items-center px-2 drag-region select-none">
        <span className="text-sm font-medium">BaoFlashBrowser 2.0</span>
      </div>

      {/* Content placeholder */}
      <div className="flex-1 flex items-center justify-center">
        <p className="text-gray-400 text-lg">Phase 0 — Infrastructure Ready</p>
      </div>
    </div>
  );
};

export default App;
