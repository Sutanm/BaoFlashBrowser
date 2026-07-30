// Force module evaluation order — this must print first
window.document.title = 'Bao — loaded';

import React from 'react';
import ReactDOM from 'react-dom';
import App from './App';
import './styles.css';

console.log('[Entry] Modules loaded, mounting React...');

const rootEl = document.getElementById('root');
console.log('[Entry] rootEl:', !!rootEl);

if (rootEl) {
  try {
    ReactDOM.render(React.createElement(React.StrictMode, null, React.createElement(App)), rootEl);
    console.log('[Entry] React mounted successfully');
  } catch (e) {
    console.error('[Entry] React mount error:', e);
    rootEl.innerHTML = '<h1 style="color:red;padding:40px">React Error: ' + String(e) + '</h1>';
  }
} else {
  document.body.innerHTML = '<h1 style="color:red;padding:40px">Fatal: #root not found</h1>';
}
