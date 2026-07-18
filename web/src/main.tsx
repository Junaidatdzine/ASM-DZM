import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';
import { reloadForNewBuild } from './components/RouteError';
import { installFunToasts } from './lib/funToast';

// Every toast gets a mood-matched emoji — installed before anything can fire one.
installFunToasts();

// A deploy renames the hashed chunks; tabs opened before it fail to fetch them on
// their next navigation. Vite surfaces that as `vite:preloadError` — reload once
// (guarded against loops) so the tab silently picks up the new build.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewBuild()) event.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
