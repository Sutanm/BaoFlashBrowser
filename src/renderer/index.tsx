// Force module evaluation order — this must print first
window.document.title = 'Bao — loaded';

import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import ErrorBoundary from './components/ErrorBoundary';
import './styles.css';

console.log('[Entry] Modules loaded, mounting React...');

const rootEl = document.getElementById('root');
console.log('[Entry] rootEl:', !!rootEl);

if (rootEl) {
  try {
    const root = createRoot(rootEl);
    root.render(
      <React.StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
    console.log('[Entry] React mounted successfully');
  } catch (e) {
    console.error('[Entry] React mount error:', e);
    rootEl.innerHTML = '<h1 style="color:red;padding:40px">React Error: ' + String(e) + '</h1>';
  }
} else {
  document.body.innerHTML = '<h1 style="color:red;padding:40px">Fatal: #root not found</h1>';
}
