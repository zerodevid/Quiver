'use strict';
// "All chains" view: the dashboard shows every chain's portfolio, positions, activity, and
// transactions together. Selected with the lpcopy_chain=all cookie (see index.js).
//
// Nothing is queried here directly. Each aggregate route asks every chain's own server for the
// same route (server.api — the in-process door the Telegram bot also uses), then merges the
// replies. Every row is tagged with `chain` so the dashboard can route a row's links and
// actions back to its chain (?chain=<key>, honoured by the front door).
//
// USD figures can be summed across chains: each chain has already converted its native-quoted
// figures with its own native price. Native amounts (ETH, BNB, SOL) are never summed.
//
// Which chains are summed: `?chains=a,b` when given (the dashboard's chain filter), otherwise
// every LIVE chain — a simulation chain's paper money must not inflate the real total. With no
// live chain at all, every chain is summed so the view is not empty.

const EQUITY_BUCKET_MS = 300_000;   // the equity snapshot interval (loop.equity_seconds default)
const MAX_POINTS = 360;             // same thinning limit as /api/portfolio

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

// Sum the numeric fields of several objects. A field that is null on every object stays null;
// one that is null on some is summed over the others.
function sumFields(objs, keys = null) {
  const out = {};
  const list = objs.filter(Boolean);
  const names = keys || [...new Set(list.flatMap((o) => Object.keys(o)))];
  for (const k of names) {
    const vals = list.map((o) => o[k]).filter(isNum);
    if (vals.length) out[k] = vals.reduce((a, b) => a + b, 0);
    else if (list.some((o) => o[k] === null)) out[k] = null;
  }
  return out;
}

// Sum of a field that is only meaningful when every chain has it (net PnL needs every chain's
// capital record; a missing one would silently understate the total).
const sumAll = (vals) => (vals.length && vals.every(isNum) ? vals.reduce((a, b) => a + b, 0) : null);

// Merge per-chain time series into one: each chain's last known point is carried forward
// (forward fill) onto a common grid of `bucketMs` buckets, then the points are summed field by
// field. A chain contributes nothing before its first point (it did not exist yet). A field
// listed in `strict` becomes null at a grid point where any contributing chain has it null
// (a cash-less equity point has no legitimate total — see /api/portfolio).
function mergeSeries(seriesByChain, { fields, strict = [], bucketMs = EQUITY_BUCKET_MS, ts = 'ts' } = {}) {
  const lists = seriesByChain.map((s) => (s || []).filter((r) => isNum(r?.[ts])).sort((a, b) => a[ts] - b[ts]));
  const grid = new Map();   // bucket -> latest real ts inside it
  for (const l of lists) for (const r of l) {
    const b = Math.floor(r[ts] / bucketMs);
    grid.set(b, Math.max(grid.get(b) ?? -Infinity, r[ts]));
  }
  const points = [...grid.values()].sort((a, b) => a - b);
  const idx = lists.map(() => -1);
  const out = [];
  for (const t of points) {
    const row = { [ts]: t };
    for (const f of fields) row[f] = null;
    let any = false;
    const bad = new Set();
    lists.forEach((l, i) => {
      while (idx[i] + 1 < l.length && l[idx[i] + 1][ts] <= t) idx[i]++;
      if (idx[i] < 0) return;
      const r = l[idx[i]];
      any = true;
      for (const f of fields) {
        if (r[f] == null) { if (strict.includes(f)) bad.add(f); continue; }
        row[f] = (row[f] ?? 0) + r[f];
      }
    });
    if (!any) continue;
    for (const f of bad) row[f] = null;
    out.push(row);
  }
  return out;
}

// High / low / drawdown per metric, the same rules as /api/portfolio (computed before thinning
// so the extreme points survive it). Returns { extremes, keep } — keep = indexes not to thin.
function extremesOf(rows) {
  const extremes = {};
  const keep = new Set();
  for (const [key, pick] of [['pnl', (r) => r.pnl], ['net', (r) => r.net], ['value', (r) => (r.cash == null ? null : r.total)]]) {
    let hi = -Infinity, lo = Infinity, peak = -Infinity, dd = 0, n = 0;
    let iHi = -1, iLo = -1, iPeak = -1, iDdPeak = -1, iDdTrough = -1;
    rows.forEach((r, i) => {
      const v = pick(r);
      if (v == null) return;
      n++;
      if (v > hi) { hi = v; iHi = i; }
      if (v < lo) { lo = v; iLo = i; }
      if (v > peak) { peak = v; iPeak = i; }
      if (peak - v > dd) { dd = peak - v; iDdPeak = iPeak; iDdTrough = i; }
    });
    if (!n) continue;
    for (const i of [iHi, iLo, iDdPeak, iDdTrough]) if (i >= 0) keep.add(i);
    extremes[key] = { hi, lo, dd, hiTs: rows[iHi].ts, loTs: rows[iLo].ts,
      ddPeakTs: iDdPeak >= 0 ? rows[iDdPeak].ts : null, ddTroughTs: iDdTrough >= 0 ? rows[iDdTrough].ts : null };
  }
  return { extremes, keep };
}

function thin(rows, keep, max = MAX_POINTS) {
  if (rows.length <= max + 1) return rows;
  const step = rows.length / max;
  const idx = new Set([0, ...keep]);
  for (let i = 1; i <= max; i++) idx.add(Math.min(rows.length - 1, Math.floor(i * step) - 1));
  return [...idx].sort((a, b) => a - b).map((i) => rows[i]);
}

const tag = (rows, chain) => (rows || []).map((r) => ({ ...r, chain }));
const byTsDesc = (k = 'ts') => (a, b) => (b[k] || 0) - (a[k] || 0) || (b.id || 0) - (a.id || 0);

// ---- merges, one per route (pure: take [{ key, label, data }] and return the merged reply) ----

function mergeOverview(parts, meta = {}) {
  const ok = parts.filter((p) => p.data && !p.data.error);
  if (!ok.length) return { error: 'tidak ada chain yang menjawab' };
  const base = ok[0].data;
  const d = (p) => p.data;
  const wallets = ok.map((p) => d(p).wallet).filter(Boolean);
  const reasons = new Map();
  for (const p of ok) for (const r of d(p).skipReasons || []) reasons.set(r.reason, (reasons.get(r.reason) || 0) + r.n);
  const leftovers = ok.flatMap((p) => tag(d(p).leftovers, p.key));
  const syncs = ok.map((p) => d(p).lastSync).filter(isNum);
  const scans = ok.map((p) => d(p).chain?.lastScan).filter(isNum);
  return {
    ...base,
    mode: {
      ...base.mode,
      dry_run: ok.every((p) => d(p).mode?.dry_run),
      paused: ok.every((p) => d(p).mode?.paused),
      // a drawdown stop or paper-trading status belongs to one chain; see byChain for each
      drawdown: null, sim: null,
    },
    wallet: wallets.length ? {
      value: sumFields(wallets, ['value']).value ?? null,
      pnl: sumFields(wallets, ['pnl']).pnl ?? null,
      netPnl: wallets.length === ok.length ? sumAll(wallets.map((w) => w.netPnl)) : null,
    } : null,
    chain: {
      ...base.chain,
      key: 'all', label: meta.label || 'Semua chain', all: true, chains: ok.map((p) => p.key),
      // the worst chain's health stands for the whole view
      lag: Math.max(...ok.map((p) => d(p).chain?.lag || 0)),
      stuckSec: Math.max(...ok.map((p) => d(p).chain?.stuckSec || 0)),
      lastScan: scans.length ? Math.min(...scans) : null,
    },
    stats: {
      ...base.stats, ...sumFields(ok.map((p) => d(p).stats), ['scanned', 'actions', 'copied', 'skipped', 'errors']),
      lastError: ok.map((p) => d(p).stats?.lastError).find(Boolean) || null,
    },
    totals: sumFields(ok.map((p) => d(p).totals)),
    summary: sumFields(ok.map((p) => d(p).summary)),
    equity: mergeSeries(ok.map((p) => d(p).equity), { fields: ['total_quote', 'realized_quote', 'fees_quote', 'open_positions'] }),
    decisionsTotal: ok.reduce((a, p) => a + (d(p).decisionsTotal || 0), 0),
    skipReasons: [...reasons].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n).slice(0, 6),
    // copy quota is per chain (budget, exposure, cash in that chain's quote)
    room: null,
    rpc: ok.flatMap((p) => (d(p).rpc || []).map((r) => ({ ...r, chain: p.key }))),
    unsupportedSenders: ok.flatMap((p) => tag(d(p).unsupportedSenders, p.key)),
    lastSync: syncs.length === ok.length ? Math.min(...syncs) : null,
    leftovers,
    byChain: ok.map((p) => ({
      key: p.key, label: p.label, nativeSymbol: d(p).chain?.nativeSymbol, ethUsd: d(p).chain?.ethUsd,
      dryRun: !!d(p).mode?.dry_run, paused: !!d(p).mode?.paused, wallet: d(p).wallet,
      openCount: d(p).summary?.openCount || 0, lag: d(p).chain?.lag || 0, stuckSec: d(p).chain?.stuckSec || 0,
    })),
    failed: parts.filter((p) => !p.data || p.data.error).map((p) => ({ key: p.key, error: p.data?.error || 'tidak menjawab' })),
  };
}

function mergeCash(cashes) {
  const list = cashes.filter((c) => c && c.cash);
  if (!list.length) return null;
  return {
    usd: list.reduce((a, c) => a + (c.cash.usd || 0), 0),
    // stablecoins are dollars on every chain; native amounts differ per chain, so they are
    // reported per chain in `natives` and left out of eth/weth
    usdg: list.reduce((a, c) => a + (c.cash.usdg || 0), 0),
    eth: 0, weth: 0,
    natives: list.map((c) => ({
      chain: c.key, symbol: c.nativeSymbol, amount: (c.cash.eth || 0) + (c.cash.weth || 0),
      usd: (c.cash.usd || 0) - (c.cash.usdg || 0),
    })).filter((n) => n.amount > 0 || n.usd > 0.005),
    ts: Math.min(...list.map((c) => c.cash.ts || Date.now())),
  };
}

function mergePortfolio(parts) {
  const ok = parts.filter((p) => p.data && !p.data.error);
  if (!ok.length) return { error: 'tidak ada chain yang menjawab' };
  const base = ok[0].data;
  const d = (p) => p.data;
  const rows = mergeSeries(ok.map((p) => d(p).series), {
    fields: ['cash', 'pos', 'fee', 'total', 'pnl', 'n', 'net'], strict: ['cash', 'net'],
  });
  // the "now" points of every chain land in the last bucket; mark it live like a single chain's
  if (rows.length && ok.some((p) => (d(p).series || []).some((r) => r.live))) rows[rows.length - 1].live = true;
  // Net needs every chain's capital record: a chain without one makes the sum meaningless.
  const allCapital = ok.every((p) => d(p).capital);
  if (!allCapital) for (const r of rows) r.net = null;
  const { extremes, keep } = extremesOf(rows);

  // Baseline: a chain without a point before the window had nothing then — it counts as 0.
  const bases = ok.map((p) => d(p).baseline).filter(Boolean);
  const baseline = bases.length ? {
    ts: Math.max(...bases.map((b) => b.ts)),
    pnl: bases.reduce((a, b) => a + (b.pnl || 0), 0),
    total: bases.reduce((a, b) => a + (b.total || 0), 0),
    cash: bases.some((b) => b.cash == null) ? null : bases.reduce((a, b) => a + (b.cash || 0), 0),
    net: allCapital && bases.every((b) => isNum(b.net)) ? bases.reduce((a, b) => a + b.net, 0) : null,
  } : null;

  const nows = ok.map((p) => d(p).now || {});
  const now = {
    ...sumFields(nows, ['value', 'positionsUsd', 'feeUsd', 'costUsd', 'leftoverUsd', 'pnl', 'realizedUsd', 'unrealizedUsd',
      'openCount', 'inRange', 'gasUsd', 'gasTxCount', 'slipUsd', 'failedCopyUsd']),
    cash: mergeCash(ok.map((p) => ({ key: p.key, nativeSymbol: p.nativeSymbol, cash: d(p).now?.cash }))),
    capital: sumAll(nows.map((n) => n.capital)),
    capitalNet: allCapital ? sumAll(nows.map((n) => n.capitalNet)) : null,
    netPnl: allCapital ? sumAll(nows.map((n) => n.netPnl)) : null,
  };

  const caps = ok.map((p) => d(p).capital).filter(Boolean);
  const capital = allCapital ? {
    ...sumFields(caps, ['baselineUsd', 'depositsUsd', 'withdrawalsUsd', 'count', 'capitalUsd']),
    baselineTs: Math.min(...caps.map((c) => c.baselineTs || Infinity)),
    syncedAt: Math.min(...caps.map((c) => c.syncedAt || Infinity)),
    deposits: ok.flatMap((p) => tag(d(p).capital.deposits, p.key)).sort((a, b) => a.ts - b.ts),
  } : null;
  if (capital && !Number.isFinite(capital.syncedAt)) capital.syncedAt = null;

  // Statistics: counts are summed; averages are weighted by each chain's closed count.
  const sts = ok.map((p) => d(p).stats || {});
  const closedCount = sts.reduce((a, s) => a + (s.closedCount || 0), 0);
  const wins = sts.reduce((a, s) => a + (s.wins || 0), 0);
  const losses = sts.reduce((a, s) => a + (s.losses || 0), 0);
  const weighted = (k) => {
    let w = 0, v = 0;
    for (const s of sts) if (isNum(s[k]) && s.closedCount) { v += s[k] * s.closedCount; w += s.closedCount; }
    return w ? v / w : null;
  };
  const picks = (k) => sts.map((s) => s[k]).filter(isNum);
  const closed = ok.flatMap((p) => d(p).closed || []).sort((a, b) => a[0] - b[0]);

  return {
    range: base.range, from: base.from,
    series: thin(rows, keep), baseline, extremes, now, capital,
    stats: {
      closedCount, wins, losses, flat: closedCount - wins - losses,
      winRatePct: wins + losses ? (wins / (wins + losses)) * 100 : null,
      avgPnl: weighted('avgPnl'),
      best: picks('best').length ? Math.max(...picks('best')) : null,
      worst: picks('worst').length ? Math.min(...picks('worst')) : null,
      avgHoldHours: weighted('avgHoldHours'),
    },
    closed,
    byTarget: ok.flatMap((p) => tag(d(p).byTarget, p.key)).sort((a, b) => (b.net || 0) - (a.net || 0)),
    byChain: ok.map((p) => ({ key: p.key, label: p.label, value: d(p).now?.value ?? null, pnl: d(p).now?.pnl ?? null, netPnl: d(p).now?.netPnl ?? null })),
  };
}

function mergePositions(parts) {
  const ok = parts.filter((p) => p.data && !p.data.error);
  const syncs = ok.map((p) => p.data.syncedAt).filter(isNum);
  return {
    positions: ok.flatMap((p) => tag(p.data.positions, p.key)).sort((a, b) => (a.opened_ts || 0) - (b.opened_ts || 0)),
    closed: ok.flatMap((p) => tag(p.data.closed, p.key)).sort(byTsDesc('closed_ts')),
    syncedAt: syncs.length === ok.length && syncs.length ? Math.min(...syncs) : null,
  };
}

function mergeList(parts, field, limit) {
  const ok = parts.filter((p) => p.data && !p.data.error);
  return { [field]: ok.flatMap((p) => tag(p.data[field], p.key)).sort(byTsDesc()).slice(0, limit) };
}

// Alert feed: action ids and close times are per chain, so the cursor is a per-chain map,
// sent to the browser as an opaque string ("robinhood:120:1760000000000,bsc:44:0").
const parseCursor = (s) => {
  const m = new Map();
  for (const part of String(s || '').split(',')) {
    const [k, id, ts] = part.split(':');
    if (k && Number.isFinite(Number(id))) m.set(k, { id: Number(id), ts: Number(ts) || 0 });
  }
  return m;
};
const formatCursor = (m) => [...m].map(([k, c]) => `${k}:${c.id}:${c.ts}`).join(',');

function mergeFeed(parts, prev) {
  const ok = parts.filter((p) => p.data && !p.data.error);
  const next = new Map(prev);
  const items = [];
  for (const p of ok) {
    const c = prev.get(p.key);
    const items0 = c ? tag(p.data.items, p.key) : [];   // a chain new to the cursor only sets its start
    items.push(...items0.map((it) => ({ ...it, id: `${p.key}:${it.id}` })));
    const closedTs = items0.filter((it) => it.kind === 'close').map((it) => it.ts);
    next.set(p.key, {
      id: Math.max(c?.id ?? 0, p.data.lastId ?? 0),
      ts: Math.max(c?.ts ?? 0, p.data.lastClosed ?? 0, ...closedTs),
    });
  }
  return { cursor: formatCursor(next), items: items.sort((a, b) => (a.ts || 0) - (b.ts || 0)) };
}

// "ref@chain,ref@chain,…" -> Map(chain -> [ref]); an unknown or missing chain = the primary.
function splitRefs(raw, keys, primaryKey) {
  const groups = new Map();
  for (const item of String(raw || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const at = item.lastIndexOf('@');
    const ref = at > 0 ? item.slice(0, at) : item;
    const key = at > 0 && keys.includes(item.slice(at + 1)) ? item.slice(at + 1) : primaryKey;
    if (!groups.has(key)) groups.set(key, []);
    if (!groups.get(key).includes(ref)) groups.get(key).push(ref);
  }
  return groups;
}

// ---- the route table --------------------------------------------------------

// servers(): { <chainKey>: server } (server.api = the in-process route door)
// nets(): { <chainKey>: { label, engine, chain } }
function createAllChains({ servers, nets, primaryKey, label = 'Semua chain' }) {
  const chainsOf = (url) => {
    const all = Object.keys(servers());
    const want = String(url.searchParams.get('chains') || '').split(',').map((s) => s.trim()).filter((k) => all.includes(k));
    if (want.length) return want;
    const live = all.filter((k) => !nets()[k]?.engine?.dryRun?.());
    const list = live.length ? live : all;
    // primary first: its reply is the base for fields that are not merged
    return [...list].sort((a, b) => (a === primaryKey ? -1 : b === primaryKey ? 1 : 0));
  };
  const ask = async (keys, pathname, query = {}) => Promise.all(keys.map(async (key) => {
    const n = nets()[key];
    let data;
    try { data = await servers()[key].api('GET', pathname, {}, query); }
    catch (e) { data = { error: e.message }; }
    return { key, label: n?.label || n?.chain?.label || key, nativeSymbol: n?.chain?.nativeSymbol, data };
  }));
  const askSplit = async (url, param, pathname) => {
    const groups = splitRefs(url.searchParams.get(param), Object.keys(servers()), primaryKey);
    return Promise.all([...groups].map(async ([key, refs]) => {
      try { return { key, data: await servers()[key].api('GET', pathname, {}, { [param]: refs.join(',') }) }; }
      catch (e) { return { key, data: { error: e.message } }; }
    }));
  };
  const q = (url, names) => Object.fromEntries(names.map((k) => [k, url.searchParams.get(k)]).filter(([, v]) => v != null));

  const routes = {
    'GET /api/overview': async (url) => mergeOverview(await ask(chainsOf(url), '/api/overview'), { label }),
    'GET /api/portfolio': async (url) => mergePortfolio(await ask(chainsOf(url), '/api/portfolio', q(url, ['range']))),
    'GET /api/positions': async (url) => mergePositions(await ask(chainsOf(url), '/api/positions')),
    'GET /api/activity': async (url) => {
      const limit = Math.min(300, Number(url.searchParams.get('limit') || 120));
      return mergeList(await ask(chainsOf(url), '/api/activity', { limit }), 'activity', limit);
    },
    'GET /api/txs': async (url) => mergeList(await ask(chainsOf(url), '/api/txs'), 'txs', 100),
    // Alerts follow every chain that runs, live or simulated — the feed only announces.
    'GET /api/feed': async (url) => {
      const prev = parseCursor(url.searchParams.get('after'));
      const keys = Object.keys(servers());
      const parts = await Promise.all(keys.map(async (key) => {
        const c = prev.get(key);
        const query = c ? { after: c.id, closedAfter: c.ts } : {};
        let data;
        try { data = await servers()[key].api('GET', '/api/feed', {}, query); } catch (e) { data = { error: e.message }; }
        return { key, data };
      }));
      return mergeFeed(parts, prev);
    },
    // Market lookups for rows of several chains: each reference arrives as `<ref>@<chain>` and is
    // asked of its own chain (DexScreener / GMGN are keyed by chain); a bare one goes to the primary.
    'GET /api/monitor/market': async (url) => {
      const parts = await askSplit(url, 'pools', '/api/monitor/market');
      return { pairs: Object.assign({}, ...parts.map((p) => p.data?.pairs || {})), ts: Date.now() };
    },
    'GET /api/gmgn/tokens': async (url) => {
      const parts = await askSplit(url, 'addresses', '/api/gmgn/tokens');
      return { enabled: parts.some((p) => p.data?.enabled), tokens: Object.assign({}, ...parts.map((p) => p.data?.tokens || {})), ts: Date.now() };
    },
    // "Refresh" on a merged page re-reads every chain it shows.
    'POST /api/positions/sync': async (url) => {
      const keys = chainsOf(url);
      const rs = await Promise.all(keys.map((key) => servers()[key].api('POST', '/api/positions/sync').catch((e) => ({ error: e.message }))));
      const err = rs.find((r) => r?.error)?.error;
      const syncs = rs.map((r) => r?.syncedAt).filter(isNum);
      return { ...(err ? { error: err } : { ok: true }), syncedAt: syncs.length ? Math.min(...syncs) : null };
    },
    'GET /api/chains': async () => {
      const r = await servers()[primaryKey].api('GET', '/api/chains');
      return { ...r, chains: (r.chains || []).map((c) => ({ ...c, current: false })), current: 'all' };
    },
  };
  return { routes };
}

module.exports = { createAllChains, splitRefs, mergeSeries, mergeOverview, mergePortfolio, mergePositions, mergeList, mergeFeed, parseCursor, formatCursor, sumFields };
