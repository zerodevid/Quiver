import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { I18nProvider, initLocale } from './i18n';
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

initLocale();
createRoot(document.getElementById('root')).render(
  <StrictMode><I18nProvider><App /></I18nProvider></StrictMode>,
);
