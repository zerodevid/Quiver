import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api';

// Ambil data dari path lalu perbarui tiap `ms`. Poll berhenti saat tab tidak terlihat.
export function usePoll(path, ms = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const alive = useRef(true);
  // Balasan bisa datang tidak berurutan: /api/targets kadang lama (RPC kena 429),
  // sehingga poll berkala yang berangkat lebih dulu bisa mendarat SETELAH reload
  // yang kita minta usai mengubah sesuatu — dan menimpanya dengan data basi.
  // Hanya balasan dari permintaan terbaru yang dipakai.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    try {
      const d = await get(path);
      if (alive.current && mine === seq.current) { setData(d); setError(d.error || null); }
    } catch (e) { if (alive.current && mine === seq.current) setError(e.message); }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    load();
    if (!ms) return () => { alive.current = false; };
    const t = setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, ms]);
  return { data, error, reload: load, setData };
}

// Slug lama (bahasa Indonesia) → slug baru, supaya bookmark/link lama tetap jalan.
const LEGACY_HASH = {
  ringkasan: 'summary', posisi: 'positions', aktivitas: 'activity', target: 'targets',
  aturan: 'rules', 'lp-manual': 'manual-lp', pengaturan: 'settings',
};

export function useHash(def) {
  const read = () => {
    const h = (location.hash || '#' + def).slice(1);
    const [page, ...rest] = h.split('/');
    const alias = LEGACY_HASH[page];
    if (!alias) return h;
    const fixed = [alias, ...rest].join('/');
    history.replaceState(null, '', '#' + fixed);
    return fixed;
  };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const f = () => setPage(read());
    addEventListener('hashchange', f);
    return () => removeEventListener('hashchange', f);
  }, []);
  return page;
}

export function useTheme() {
  const [theme, setTheme] = useState(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const apply = (t) => {
    const el = document.documentElement;
    el.classList.remove('light', 'dark'); el.classList.add(t); el.setAttribute('data-theme', t);
    try { localStorage.setItem('lpcopy-theme', t); } catch { /* abaikan */ }
    setTheme(t);
  };
  return [theme, () => apply(theme === 'dark' ? 'light' : 'dark')];
}
