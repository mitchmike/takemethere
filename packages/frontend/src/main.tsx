import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.js';
import './index.css';

// Expose stores to window in dev so Playwright tests can inject data without a live backend.
if (import.meta.env.DEV) {
  Promise.all([
    import('./store/trainsStore.js'),
    import('./store/linesStore.js'),
    import('./store/uiStore.js'),
  ]).then(([trains, lines, ui]) => {
    (window as any).__stores__ = {
      trainsStore: trains.useTrainsStore,
      linesStore:  lines.useLinesStore,
      uiStore:     ui.useUiStore,
    };
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
