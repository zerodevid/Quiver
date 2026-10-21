'use strict';
// Public read-only API (/api/v1/*), authenticated with API keys.
//
// Why a separate door instead of letting a key open /api/*: the dashboard token can switch on
// LIVE mode and close positions. An API key is meant to be handed to scripts, bots and
// spreadsheets, so it can ONLY reach the GET endpoints listed in ENDPOINTS below, which
// return a trimmed, stable shape (no internal columns, no secrets) built on the dashboard's own
// routes so the numbers are exactly the same as on screen.
//
// Keys are shown once at creation; only a SHA-256 of the key is stored. The keys are
// created and revoked from Settings → Security (dashboard token required, never by a key).
const crypto = require('node:crypto');

const PREFIX = 'lpk_';
const RATE_PER_MIN = 60;            // requests per key per minute
const MAX_KEYS = 20;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v, d = 2) => (v == null || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(d)));
const clamp = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : dflt; };

function createApiV1({ store, chain, callApi, log = () => {} }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, hint TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
    created_ts INTEGER NOT NULL, last_used_ts INTEGER, revoked_ts INTEGER
  )`);

  // ---- key management (called from dashboard-token routes only) ----
  const list = () => store.all('SELECT id, name, hint, created_ts AS createdTs, last_used_ts AS lastUsedTs FROM api_keys WHERE revoked_ts IS NULL ORDER BY id DESC');
  const create = (name) => {
    name = String(name || '').trim().slice(0, 60);
    if (!name) return { error: 'Beri nama untuk key ini.' };
    if (list().length >= MAX_KEYS) return { error: `Maksimal ${MAX_KEYS} key aktif; cabut yang tidak dipakai dulu.` };
    const key = PREFIX + crypto.randomBytes(24).toString('base64url');
    const r = store.run('INSERT INTO api_keys(name, hint, hash, created_ts) VALUES(?,?,?,?)', name, `${key.slice(0, 8)}…${key.slice(-4)}`, sha(key), Date.now());
    log(`API key dibuat: ${name}`);
    return { ok: true, id: Number(r.lastInsertRowid), name, key };
  };
  const revoke = (id) => {
    const r = store.run('UPDATE api_keys SET revoked_ts=? WHERE id=? AND revoked_ts IS NULL', Date.now(), Number(id));
    if (r.changes) log(`API key #${id} dicabut`);
    return r.changes ? { ok: true } : { error: 'Key tidak ditemukan.' };
  };

  // ---- authentication + rate limit ----
  const hits = new Map();           // key id -> { n, resetAt }
  const keyOf = (req) => {
    const h = req.headers.authorization;
    const raw = h && /^Bearer /i.test(h) ? h.slice(7).trim() : String(req.headers['x-api-key'] || '').trim();
    if (!raw.startsWith(PREFIX) || raw.length > 128) return null;
    return store.get('SELECT id, name FROM api_keys WHERE hash=? AND revoked_ts IS NULL', sha(raw)) || null;
  };
  const overLimit = (id) => {
    const now = Date.now(); let e = hits.get(id);
    if (!e || e.resetAt <= now) { e = { n: 0, resetAt: now + 60_000 }; hits.set(id, e); }
    e.n++;
    return e.n > RATE_PER_MIN ? Math.ceil((e.resetAt - now) / 1000) : 0;
  };

  // ---- endpoints: each returns a whitelisted projection of a dashboard route ----
  const posOf = (p) => ({
    id: p.id, venue: p.venue, tokenId: p.token_id ?? null, pool: p.pool_ref ?? null, status: p.status,
    pair: `${p.symbol0 || '?'}/${p.symbol1 || '?'}`, symbol0: p.symbol0 ?? null, symbol1: p.symbol1 ?? null,
    token0: p.token0, token1: p.token1, fee: p.fee ?? null,
    openedAt: p.opened_ts ?? null, closedAt: p.closed_ts ?? null, ageHours: num(p.ageHours, 2),
    inRange: p.inRange ?? null, tickLower: p.tick_lower ?? null, tickUpper: p.tick_upper ?? null, curTick: p.curTick ?? null,
    costUsd: num(p.costUsd), valueUsd: num(p.valueUsd), feeUsd: num(p.feeUsd),
    pnlUsd: num(p.pnlUsd), pnlPct: num(p.pnlPct), outUsd: num(p.outUsd),
    source: p.target || null, sourceLabel: p.targetLabel ?? null, slPct: p.sl_pct ?? null, tpPct: p.tp_pct ?? null,
  });

  const ENDPOINTS = {
    status: {
      desc: 'Bot state: chain, mode, last sync.',
      run: async () => {
        const o = await callApi('GET', '/api/overview');
        return {
          chain: o.chain.key, label: o.chain.label, wallet: o.mode.wallet, dryRun: o.mode.dry_run, paused: o.mode.paused,
          head: o.chain.head, lagBlocks: o.chain.lag, ethUsd: o.chain.ethUsd, lastSyncAt: o.lastSync || null,
          openPositions: o.summary.openCount, uptimeSec: o.stats.uptimeSec,
        };
      },
    },
    balance: {
      desc: 'Wallet balance: total value, cash, value in positions, fees, PnL and net PnL against deposited capital.',
      run: async () => {
        const { now: n, capital } = await callApi('GET', '/api/portfolio', {}, { range: '24h' });
        return {
          chain: chain.network, ts: Date.now(),
          totalUsd: num(n.value), cashUsd: num(n.cash?.usd), positionsUsd: num(n.positionsUsd), unclaimedFeesUsd: num(n.feeUsd),
          leftoverUsd: num(n.leftoverUsd), pnlUsd: num(n.pnl), realizedUsd: num(n.realizedUsd), unrealizedUsd: num(n.unrealizedUsd),
          capitalUsd: num(n.capitalNet), netPnlUsd: num(n.netPnl), gasUsd: num(n.gasUsd), slippageUsd: num(n.slipUsd),
          openPositions: n.openCount, inRange: n.inRange,
          cashAssets: n.cash ? { usd: num(n.cash.usd), ...Object.fromEntries(Object.entries(n.cash).filter(([k, v]) => k !== 'usd' && k !== 'ts' && typeof v === 'number').map(([k, v]) => [k, num(v, 6)])) } : null,
          capitalStartedAt: capital?.baselineTs ?? null,
        };
      },
    },
    positions: {
      desc: 'Positions. ?status=open (default) | closed | all, ?limit=1..100 (closed only).',
      run: async (q) => {
        const d = await callApi('GET', '/api/positions');
        const st = ['open', 'closed', 'all'].includes(q.get('status')) ? q.get('status') : 'open';
        const out = { chain: chain.network, syncedAt: d.syncedAt || null };
        if (st !== 'closed') out.open = d.positions.map(posOf);
        if (st !== 'open') out.closed = d.closed.slice(0, clamp(q.get('limit'), 1, 100, 50)).map(posOf);
        return out;
      },
    },
    position: {
      desc: 'One position by ?id=.',
      run: async (q) => {
        const d = await callApi('GET', '/api/position', {}, { id: q.get('id') });
        return d.error ? d : { position: { ...posOf(d.position), claimedUsd: num(d.position.claimedUsd), withdrawnUsd: num(d.position.withdrawnUsd) }, ethUsd: d.ethUsd, syncedAt: d.syncedAt || null };
      },
    },
    equity: {
      desc: 'Balance / PnL chart series. ?range=6h|12h|24h|3d|7d|14d|30d|90d|180d|365d|all (default 7d). Points: ts, totalUsd, cashUsd, positionsUsd, feesUsd, pnlUsd, netPnlUsd.',
      run: async (q) => {
        const r = await callApi('GET', '/api/portfolio', {}, { range: q.get('range') || '7d' });
        return {
          chain: chain.network, range: r.range, from: r.from,
          series: r.series.map((p) => ({ ts: p.ts, totalUsd: num(p.total), cashUsd: num(p.cash), positionsUsd: num(p.pos), feesUsd: num(p.fee), pnlUsd: num(p.pnl), netPnlUsd: num(p.net), openPositions: p.n })),
          baseline: r.baseline ? { ts: r.baseline.ts, totalUsd: num(r.baseline.total), pnlUsd: num(r.baseline.pnl), netPnlUsd: num(r.baseline.net) } : null,
          extremes: r.extremes,
        };
      },
    },
    pnl: {
      desc: 'Closed-position statistics and result per copied source (all time), plus daily realized PnL for ?range= (default 30d).',
      run: async (q) => {
        const r = await callApi('GET', '/api/portfolio', {}, { range: q.get('range') || '30d' });
        const daily = {};
        for (const [ts, v] of r.closed) { if (ts < r.from || (r.to && ts > r.to)) continue; const k = new Date(ts).toISOString().slice(0, 10); daily[k] = (daily[k] || 0) + v; }
        return {
          chain: chain.network, range: r.range,
          stats: Object.fromEntries(Object.entries(r.stats).map(([k, v]) => [k, num(v)])),
          dailyUtc: Object.entries(daily).sort().map(([date, pnlUsd]) => ({ date, pnlUsd: num(pnlUsd) })),
          bySource: r.byTarget.map((g) => ({ source: g.target, label: g.label, open: g.open, closed: g.closed, wins: g.wins, losses: g.losses, realizedUsd: num(g.realized), unrealizedUsd: num(g.upnl), netUsd: num(g.net) })),
        };
      },
    },
    deposits: {
      desc: 'Tracked deposits / withdrawals that form the capital base for net PnL.',
      run: async () => {
        const { capital } = await callApi('GET', '/api/portfolio', {}, { range: '24h' });
        return capital ? { baselineUsd: num(capital.baselineUsd), capitalUsd: num(capital.capitalUsd), baselineTs: capital.baselineTs, deposits: capital.deposits.map((d) => ({ ts: d.ts, kind: d.kind, symbol: d.symbol, amount: num(d.amount, 6), usd: num(d.usd), txHash: d.txHash })) } : { capitalUsd: null, deposits: [] };
      },
    },
    activity: {
      desc: 'Recent target actions and what the bot decided. ?limit=1..100 (default 50).',
      run: async (q) => {
        const { activity } = await callApi('GET', '/api/activity', {}, { limit: clamp(q.get('limit'), 1, 100, 50) });
        return { activity: activity.map((a) => ({ id: a.id, ts: a.ts, kind: a.kind, venue: a.venue, source: a.target, sourceLabel: a.targetLabel, pair: `${a.symbol0 || '?'}/${a.symbol1 || '?'}`, verdict: a.verdict || null, reason: a.reason || null, txHash: a.decision_tx || null })) };
      },
    },
  };

  // Returns true when the request was answered. Call it BEFORE the dashboard token gate.
  const handle = async (req, res, url, json) => {
    if (!url.pathname.startsWith('/api/v1')) return false;
    if (req.method !== 'GET') { json(res, 405, { error: 'hanya GET' }); return true; }
    const k = keyOf(req);
    if (!k) { json(res, 401, { error: 'API key tidak valid atau tidak ada. Kirim header "Authorization: Bearer lpk_…" atau "X-API-Key".' }); return true; }
    const wait = overLimit(k.id);
    if (wait) { res.setHeader('retry-after', String(wait)); json(res, 429, { error: `terlalu banyak permintaan (maks ${RATE_PER_MIN}/menit per key)` }); return true; }
    store.run('UPDATE api_keys SET last_used_ts=? WHERE id=?', Date.now(), k.id);
    const name = url.pathname.replace(/^\/api\/v1\/?/, '');
    if (!name) { json(res, 200, { version: 1, chain: chain.network, endpoints: Object.fromEntries(Object.entries(ENDPOINTS).map(([n, e]) => [`/api/v1/${n}`, e.desc])), note: 'Tambahkan ?chain=<nama> untuk memilih chain.' }); return true; }
    const ep = Object.hasOwn(ENDPOINTS, name) ? ENDPOINTS[name] : null;
    if (!ep) { json(res, 404, { error: 'endpoint tidak ada' }); return true; }
    try { json(res, 200, await ep.run(url.searchParams)); }
    catch (e) { log(`api v1 ${name}: ${e.message}`); json(res, 500, { error: 'kesalahan server' }); }
    return true;
  };

  return { list, create, revoke, handle, endpoints: ENDPOINTS };
}

module.exports = { createApiV1, PREFIX };
