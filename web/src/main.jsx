import { Component, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider, initLocale } from './i18n';
import { hideSplash, armSplashTimeout } from './splash';
import './index.css';

// Halaman dimuat per potongan (chunk) dengan nama ber-hash. Sesudah deploy, tab
// yang masih terbuka memegang nama lama yang sudah dihapus dari server: pindah
// halaman → import gagal → layar putih. Muat ulang sekali supaya dapat daftar baru;
// paling cepat sekali per 15 detik, supaya tidak berputar kalau penyebabnya lain.
window.addEventListener('vite:preloadError', (e) => {
  let last = 0;
  try { last = Number(sessionStorage.getItem('quiver-reloaded') || 0); } catch { /* abaikan */ }
  if (Date.now() - last < 15_000) return;
  try { sessionStorage.setItem('quiver-reloaded', String(Date.now())); } catch { /* abaikan */ }
  e.preventDefault();
  window.location.reload();
});

// Entry termuat: galat sesudah titik ini bukan "aplikasi gagal dimuat" (lihat index.html).
window.__quiverBooted = true;
initLocale();
armSplashTimeout();

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

createRoot(document.getElementById('root')).render(
  <StrictMode><AppBoundary><I18nProvider><App /></I18nProvider></AppBoundary></StrictMode>,
);
