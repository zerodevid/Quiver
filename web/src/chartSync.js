// Shared state of every advanced chart on the page: the user's drawings and the indicator set.
//
// Drawings belong to a TOKEN, not to one chart instance: a line drawn on the Monitor card shows
// up on the position page, the pool page and the token page of the same token, on every
// timeframe, in every open tab (BroadcastChannel) and on other devices (the server copy is
// polled while a chart is open). Each drawing is synced on its own (upsert/remove by id), so
// two charts editing different drawings never overwrite each other.
//
// Prices are stored in USD whenever the chart knows its quote -> USD rate, so a line drawn on a
// WETH-quoted chart lands on the same level on a USD-quoted (GMGN / token page) chart. Without a
// rate the drawing is stored in the chart's own quote asset (`unit: 'q:<SYMBOL>'`) and only
// shown on charts with that same quote.
import { get, post } from './api';
import { getScope, canonAddr } from './chain';

const POLL_MS = 20_000;
const SAVE_MS = 350;
const PREFS_LS = 'lpcopy-chart-prefs';
const DEFAULT_PREFS = { indicators: ['VOL'] };

const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('lpcopy-chart-sync') : null;
const docs = new Map();   // scoped key -> { key, items: Map, subs: Set, pending: Map, timer, loadedAt, loading }

const scopedKey = (key) => `${getScope() || ''}|${key}`;
export const newDrawingId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

function docFor(key) {
  const sk = scopedKey(key);
  let d = docs.get(sk);
  if (!d) {
    d = { key, sk, items: new Map(), subs: new Set(), pending: new Map(), timer: null, loadedAt: 0, loading: null, legacy: null };
    docs.set(sk, d);
  }
  return d;
}

const emit = (d, origin) => { for (const s of d.subs) if (s.origin !== origin) s.fn(d.items); };

// Server reply -> local items. Drawings with an edit not yet saved keep the local copy, so a
// poll landing mid-drag does not snap the line back.
function merge(d, list) {
  const next = new Map();
  for (const it of list || []) if (it?.id) next.set(it.id, it);
  for (const [id, op] of d.pending) {
    if (op === null) next.delete(id);
    else next.set(id, op);
  }
  d.items = next;
}

async function load(d) {
  if (d.loading) return d.loading;
  d.loading = (async () => {
    const q = new URLSearchParams({ key: d.key });
    if (d.legacy) q.set('legacy', d.legacy);
    const res = await get(`/api/chart/drawings?${q}`).catch(() => null);
    d.loading = null;
    if (!res || res.error) return;
    d.loadedAt = Date.now();
    // Drawings from the old per-pool storage come back without a `unit`: the first chart that
    // shows them rewrites them in its own unit (see AdvancedChart), which saves them here.
    merge(d, res.items);
    emit(d, null);
  })();
  return d.loading;
}

function flush(d) {
  clearTimeout(d.timer); d.timer = null;
  if (!d.pending.size) return;
  const upsert = [], remove = [];
  for (const [id, op] of d.pending) (op === null ? remove.push(id) : upsert.push(op));
  d.pending.clear();
  post('/api/chart/drawings', { key: d.key, upsert, remove }).catch(() => {
    // back into the queue so the next edit (or the next poll) tries again
    for (const it of upsert) if (!d.pending.has(it.id)) d.pending.set(it.id, it);
    for (const id of remove) if (!d.pending.has(id)) d.pending.set(id, null);
  });
}

function queue(d, id, op) {
  d.pending.set(id, op);
  clearTimeout(d.timer);
  d.timer = setTimeout(() => flush(d), SAVE_MS);
}

// Leaving the page (or switching tab) must not drop an edit made in the last few hundred ms.
if (typeof window !== 'undefined') {
  const flushAll = () => { for (const d of docs.values()) flush(d); };
  addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushAll();
    else for (const d of docs.values()) if (d.subs.size && Date.now() - d.loadedAt > 5000) load(d);
  });
  setInterval(() => {
    if (document.hidden) return;
    for (const d of docs.values()) if (d.subs.size && !d.pending.size && Date.now() - d.loadedAt >= POLL_MS) load(d);
  }, 5000);
}

channel?.addEventListener('message', ({ data: m }) => {
  if (m?.type === 'drawings') {
    const d = docs.get(m.sk);
    if (!d) return;
    if (m.op === null) d.items.delete(m.id); else d.items.set(m.id, m.op);
    d.items = new Map(d.items);
    emit(d, null);
  } else if (m?.type === 'prefs') {
    prefs = { ...prefs, ...m.prefs };
    for (const fn of prefSubs) fn(prefs);
  }
});

// Subscribe a chart to a token's drawings. `fn(items)` runs on every change made elsewhere
// (another chart, another tab, the server); the chart's own edits are not echoed back.
// `legacy` = old per-pool storage key to adopt from when the token has no drawings yet.
export function subscribeDrawings(key, fn, { legacy = null } = {}) {
  const d = docFor(key);
  if (legacy && !d.legacy) d.legacy = legacy;
  const sub = { fn, origin: Symbol('chart') };
  d.subs.add(sub);
  if (d.loadedAt && Date.now() - d.loadedAt < POLL_MS) queueMicrotask(() => fn(d.items));
  else if (d.loadedAt) { fn(d.items); load(d); }
  else load(d);
  return {
    origin: sub.origin,
    unsubscribe: () => { d.subs.delete(sub); flush(d); },
  };
}

// `op` = the drawing, or null to remove it. Returns the stored copy (with its `updated` stamp).
export function writeDrawing(key, id, op, origin) {
  const d = docFor(key);
  const items = new Map(d.items);
  if (op === null) items.delete(id); else items.set(id, { ...op, id, updated: Date.now() });
  d.items = items;
  queue(d, id, op === null ? null : items.get(id));
  emit(d, origin);
  channel?.postMessage({ type: 'drawings', sk: d.sk, id, op: op === null ? null : items.get(id) });
  return op === null ? null : items.get(id);
}

export const drawingsOf = (key) => docFor(key).items;

// ---- chart preferences (indicators): one set for every chart ----

const readLocal = () => { try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_LS) || '{}') }; } catch { return { ...DEFAULT_PREFS }; } };
let prefs = readLocal();
let prefsLoaded = false;
const prefSubs = new Set();
let prefTimer = null;

export const chartPrefs = () => prefs;

export function subscribePrefs(fn) {
  prefSubs.add(fn);
  if (!prefsLoaded) {
    prefsLoaded = true;
    get('/api/chart/prefs').then((res) => {
      if (!res || res.error || !res.prefs) return;
      prefs = { ...DEFAULT_PREFS, ...res.prefs };
      try { localStorage.setItem(PREFS_LS, JSON.stringify(prefs)); } catch { /* ignore */ }
      for (const f of prefSubs) f(prefs);
    }).catch(() => { prefsLoaded = false; });
  }
  return () => prefSubs.delete(fn);
}

export function setChartPrefs(patch) {
  prefs = { ...prefs, ...patch };
  try { localStorage.setItem(PREFS_LS, JSON.stringify(prefs)); } catch { /* ignore */ }
  for (const fn of prefSubs) fn(prefs);
  channel?.postMessage({ type: 'prefs', prefs: patch });
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => post('/api/chart/prefs', { prefs }).catch(() => {}), SAVE_MS);
}

// Shared drawing list of a chart: the base token's, else the pool's.
export const drawKeyOf = (token, pool) => (token ? `tok:${canonAddr(token)}` : pool ? `pool:${canonAddr(pool)}` : null);

// ---- per-token view: timeframe, Price/MCap, Lin/Log/% ----
//
// What the user last picked on a token's chart is remembered per token (the same key as its
// drawings) and applied to every chart of that token: Monitor card, position page, pool page,
// token page — also in other tabs. Kept in this browser only; an "auto" axis is never stored,
// so a token without an explicit pick still chooses its own scale.
const VIEW_LS = 'lpcopy-chart-view';
const VIEW_MAX = 300;
const viewSubs = new Map();   // scoped key -> Set<{ fn, origin }>
const readViews = () => { try { return JSON.parse(localStorage.getItem(VIEW_LS) || '{}') || {}; } catch { return {}; } };

export const viewOf = (key) => (key ? readViews()[scopedKey(key)] || {} : {});

// The saved timeframe, if it is one the caller can draw (`valid(tf)`); null otherwise.
export const savedTf = (key, valid = () => true) => { const tf = viewOf(key).tf; return tf && valid(tf) ? tf : null; };

const notifyView = (sk, view, origin) => { for (const s of viewSubs.get(sk) || []) if (s.origin !== origin) s.fn(view); };

// `patch` = any of { tf, metric, axis }. `origin` = the caller's own subscription symbol, which is not echoed.
export function saveView(key, patch, origin = null) {
  if (!key) return;
  const sk = scopedKey(key), all = readViews();
  const next = { ...(all[sk] || {}), ...patch, t: Date.now() };
  all[sk] = next;
  const keys = Object.keys(all);
  if (keys.length > VIEW_MAX) for (const k of keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0)).slice(0, keys.length - VIEW_MAX)) delete all[k];
  try { localStorage.setItem(VIEW_LS, JSON.stringify(all)); } catch { /* ignore */ }
  notifyView(sk, next, origin);
  channel?.postMessage({ type: 'view', sk, view: next });
}

// `fn(view)` runs when another chart (or tab) of the same token changes the view.
export function subscribeView(key, fn, origin) {
  if (!key) return () => {};
  const sk = scopedKey(key), sub = { fn, origin };
  if (!viewSubs.has(sk)) viewSubs.set(sk, new Set());
  viewSubs.get(sk).add(sub);
  return () => viewSubs.get(sk)?.delete(sub);
}

channel?.addEventListener('message', ({ data: m }) => { if (m?.type === 'view') notifyView(m.sk, m.view, null); });
