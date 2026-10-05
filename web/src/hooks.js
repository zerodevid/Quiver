import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from './api';

// Fetch data from a path then refresh every `ms`. Polling stops when the tab is not visible.
// `loading` only turns on if the reply takes longer than 400 ms: a poll that finishes
// instantly does not make the indicator blink every few seconds.
export function usePoll(path, ms = 5000) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const alive = useRef(true);
  // Replies can arrive out of order: /api/targets is sometimes slow (RPC hit by 429),
  // so a periodic poll that left earlier can land AFTER the reload
  // we requested after changing something — and overwrite it with stale data.
  // Only the reply of the latest request is used.
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

// A "Refresh" button that really refreshes: ask the server to read the chain again
// (POST …/sync), then fetch the list. Calling reload() alone is not enough — it
// only repeats the last sync result, which can be 30 seconds old, so
// the button blinks and then gives exactly the same numbers.
//
// The list is still refetched even if the sync fails: if a single RPC misses, the
// right thing is to show the last known numbers as they are, not stay silent.
export function useResync(reload, path = '/api/positions/sync') {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const run = useCallback(async () => {
    setBusy(true);
    try { await post(path); } catch { /* the error surfaces through the data fetched below */ }
    try { await reload(); } finally { if (alive.current) setBusy(false); }
  }, [path, reload]);
  return [run, busy];
}

// A ticking clock: makes the component redraw every `ms` so relative time
// text ("12 s ago") keeps moving without waiting for the next poll.
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) set((n) => n + 1); }, ms);
    return () => clearInterval(t);
  }, [ms]);
}

// Old (Indonesian) slug → new slug, so old bookmarks/links keep working.
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
