import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from './api';

// Ambil data dari path lalu perbarui tiap `ms`. Poll berhenti saat tab tidak terlihat.
// `loading` baru menyala kalau balasan lebih lama dari 400 ms: poll yang selesai
// sekejap tidak membuat indikator berkedip tiap beberapa detik.
export function usePoll(path, ms = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Balasan bisa datang tidak berurutan: /api/targets kadang lama (RPC kena 429),
  // sehingga poll berkala yang berangkat lebih dulu bisa mendarat SETELAH reload
  // yang kita minta usai mengubah sesuatu — dan menimpanya dengan data basi.
  // Hanya balasan dari permintaan terbaru yang dipakai.
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const mine = ++seq.current;
    const latest = () => alive.current && mine === seq.current;
    const slow = setTimeout(() => { if (latest()) setLoading(true); }, 400);
    try {
      const d = await get(path);
      if (latest()) { setData(d); setError(d.error || null); }
    } catch (e) { if (latest()) setError(e.message); }
    finally { clearTimeout(slow); if (latest()) setLoading(false); }
  }, [path]);
  useEffect(() => {
    alive.current = true;
    load();
    if (!ms) return () => { alive.current = false; };
    const t = setInterval(() => { if (!document.hidden) load(); }, ms);
    return () => { alive.current = false; clearInterval(t); };
  }, [load, ms]);
  return { data, error, loading, reload: load, setData };
}

// Tombol "Perbarui" yang benar-benar memperbarui: minta server membaca chain lagi
// (POST …/sync), baru ambil daftarnya. Memanggil reload() saja tidak cukup — itu
// hanya mengulang hasil sinkron terakhir, yang umurnya bisa 30 detik, sehingga
// tombolnya berkedip lalu memberi angka yang sama persis.
//
// Daftar tetap diambil ulang walau sinkronnya gagal: kalau satu RPC meleset, yang
// benar adalah menunjukkan angka terakhir yang diketahui apa adanya, bukan diam.
export function useResync(reload, path = '/api/positions/sync') {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async () => {
    setBusy(true);
    try { await post(path); } catch { /* galat muncul lewat data yang diambil di bawah */ }
    try { await reload(); } finally { if (alive.current) setBusy(false); }
  }, [path, reload]);
  return [run, busy];
}

// Jam yang berdetak: bikin komponen menggambar ulang tiap `ms` supaya teks waktu
// relatif ("12 dtk lalu") ikut berjalan tanpa menunggu poll berikutnya.
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) set((n) => n + 1); }, ms);
    return () => clearInterval(t);
  }, [ms]);
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
