import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider, initLocale } from './i18n';
import { hideSplash, armSplashTimeout } from './splash';
import { loadSdk, signIn, paintChrome, wireBackButton, wireLinks } from './telegram';
import './index.css';

// Pages are loaded per chunk with hashed names. After a deploy, a tab
// that is still open holds an old name that has been removed from the server: navigating
// to a page → import fails → white screen. Reload once to get the new list;
// at most once per 15 seconds, so it does not loop if the cause is something else.
window.addEventListener('vite:preloadError', (e) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('quiver-reloaded') || 0); } catch { /* abaikan */ }
  if (Date.now() - last < 15_000) return;
  try { sessionStorage.setItem('quiver-reloaded', String(Date.now())); } catch { /* abaikan */ }
  e.preventDefault();
  window.location.reload();
});

// Entry loaded: an error after this point is not "app failed to load" (see index.html).
window.__quiverBooted = true;
initLocale();

class AppBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { console.error('Dashboard render failed', error, info); hideSplash(); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main role="alert" className="mx-auto my-12 max-w-lg p-6">
        <h1 className="text-xl font-semibold">Halaman gagal dimuat</h1>
        <p className="mt-2 text-sm text-muted">Muat ulang untuk mengambil versi terbaru. Jika masih gagal, sertakan pesan di bawah saat melaporkan masalah.</p>
        <pre className="my-4 whitespace-pre-wrap break-words rounded border border-border p-3 text-xs">{String(this.state.error?.message || this.state.error)}</pre>
        <button type="button" className="rounded bg-accent px-4 py-2 text-accent-foreground" onClick={() => window.location.reload()}>Muat ulang</button>
      </main>
    );
  }
}

const render = () => {
  armSplashTimeout();
  createRoot(document.getElementById('root')).render(
    <StrictMode><AppBoundary><I18nProvider><App /></I18nProvider></AppBoundary></StrictMode>,
  );
};

// /mini is the same dashboard opened inside Telegram (the bot's "Mini app" button). It signs in
// with Telegram's initData instead of the token cookie (see telegram.js), so it renders only
// after that exchange; a refusal stays on the splash with the server's reason.
if (/^\/mini\/?$/.test(location.pathname)) {
  loadSdk().then((tg) => {
    if (!tg) return;
    tg.ready();
    tg.expand();
    // Light or dark comes from Telegram until the user picks one with the theme button.
    let stored = null;
    try { stored = localStorage.getItem('lpcopy-theme'); } catch { /* storage blocked */ }
    const theme = stored || (tg.colorScheme === 'dark' ? 'dark' : 'light');
    const el = document.documentElement;
    el.classList.remove('light', 'dark'); el.classList.add(theme); el.setAttribute('data-theme', theme);
    paintChrome(theme);
    wireBackButton();
    wireLinks();
  }).then(signIn).then((error) => {
    if (!error) return render();
    const splash = document.getElementById('splash');
    const message = document.getElementById('startup-message');
    if (!splash || !message) return;
    message.textContent = error;
    message.hidden = false;
    splash.classList.add('sp-failed');
  });
} else {
  render();
}
