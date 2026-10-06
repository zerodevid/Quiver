'use strict';
// Client for the free public Meteora DLMM data API (https://dlmm.datapi.meteora.ag, no API
// key, ~30 requests/second). One call answers what otherwise takes DexScreener + GeckoTerminal
// + RPC: pool TVL, volume and fees per window, fee/TVL, APR, bin step, base/dynamic fee, the
// real creation time, and OHLCV candles in the pool's own quote asset.
//
// Every answer is cached briefly (and shared while in flight), so a dashboard polling the same
// pool from several places costs one request. A failed call falls back to the last good answer
// for a while — the callers treat this API as an enrichment, never as a hard dependency.
// "Not a Meteora pool" (HTTP 404/400) is a normal answer (null): Orca and Raydium pool
// addresses are asked here too, and must fall through to the other sources.

const BASE = 'https://dlmm.datapi.meteora.ag';
const TIMEOUT_MS = 8000;
const POOL_TTL_MS = 30_000;
const MISS_TTL_MS = 10 * 60_000;     // an address that is not a DLMM pool stays that way
const STALE_MS = 15 * 60_000;
const MAX_CACHE = 500;
const OHLCV_CHUNK = 90;              // candles per request the API accepts (it refuses ~100)

// Candle windows the API offers (seconds per candle); anything else is not served from here.
const OHLCV_SECS = { '5m': 300, '30m': 1800, '1h': 3600, '2h': 7200, '4h': 14400, '12h': 43200, '24h': 86400 };

const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Number(x) : null);

function normalizeToken(t) {
  if (!t) return null;
  return {
    address: t.address, symbol: t.symbol || '?', name: t.name || null,
    decimals: num(t.decimals), priceUsd: num(t.price), marketCap: num(t.market_cap),
    holders: num(t.holders), verified: t.is_verified === true,
    freezeDisabled: t.freeze_authority_disabled ?? null,
  };
}

// The raw pool object -> the shape the rest of the bot uses (camelCase, numbers or null).
function normalizePool(p) {
  if (!p?.address) return null;
  const win = (o) => ({
    m30: num(o?.['30m']), h1: num(o?.['1h']), h2: num(o?.['2h']), h4: num(o?.['4h']),
    h12: num(o?.['12h']), h24: num(o?.['24h']),
  });
  const cfg = p.pool_config || {};
  return {
    address: p.address, name: p.name || null,
    tokenX: normalizeToken(p.token_x), tokenY: normalizeToken(p.token_y),
    amountX: num(p.token_x_amount), amountY: num(p.token_y_amount),
    createdAt: num(p.created_at),
    tvlUsd: num(p.tvl), currentPrice: num(p.current_price),
    binStep: num(cfg.bin_step), baseFeePct: num(cfg.base_fee_pct), maxFeePct: num(cfg.max_fee_pct),
    protocolFeePct: num(cfg.protocol_fee_pct), dynamicFeePct: num(p.dynamic_fee_pct),
    volume: win(p.volume), fees: win(p.fees), feeTvl: win(p.fee_tvl_ratio),
    // The API's fee_tvl_ratio and apr are already PERCENT of TVL over the window (24h fees /
    // TVL = 0.137 means 0.137% a day); apy is that compounded for a year, in percent.
    // aprPct is the plain (uncompounded) annualised figure: daily % x 365.
    dailyYieldPct: num(p.apr), aprPct: num(p.apr) != null ? num(p.apr) * 365 : null,
    apyPct: num(p.apy),
    hasFarm: p.has_farm === true, farmAprPct: num(p.farm_apr) != null ? num(p.farm_apr) * 365 : null,
    cumulativeVolume: num(p.cumulative_metrics?.volume), cumulativeFees: num(p.cumulative_metrics?.fees),
    blacklisted: p.is_blacklisted === true, launchpad: p.launchpad || null, tags: p.tags || [],
  };
}

class MeteoraApi {
  constructor({ fetch: fetchImpl, log, base = BASE } = {}) {
    this.fetch = fetchImpl || globalThis.fetch;
    this.log = log || (() => {});
    this.base = base;
    this.cache = new Map();   // key -> { until, value: Promise }
    this.good = new Map();    // key -> { at, value }
  }

  async get(path, params = null) {
    const q = params ? `?${new URLSearchParams(params)}` : '';
    const r = await this.fetch(`${this.base}${path}${q}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 404 || r.status === 400) return { miss: true, status: r.status };
    if (!r.ok) throw new Error(`Meteora API HTTP ${r.status}`);
    return r.json();
  }

  // Same key within `ttl` shares one request (in flight too). A throw falls back to the last
  // good answer younger than STALE_MS; with none, it throws.
  memo(key, ttl, fn) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value;
    const value = fn().then(
      (v) => { this.good.set(key, { at: Date.now(), value: v }); return v; },
      (e) => {
        const last = this.good.get(key);
        if (last && Date.now() - last.at < STALE_MS) return last.value;
        throw e;
      },
    );
    this.cache.set(key, { until: now + ttl, value });
    if (this.cache.size > MAX_CACHE) for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k);
    if (this.good.size > MAX_CACHE) for (const [k, v] of this.good) if (Date.now() - v.at > STALE_MS) this.good.delete(k);
    return value;
  }

  // One DLMM pool by address, or null when the address is not a Meteora DLMM pool.
  pool(address) {
    if (!address) return Promise.resolve(null);
    return this.memo(`pool:${address}`, POOL_TTL_MS, async () => {
      const j = await this.get(`/pools/${address}`);
      return j.miss ? null : normalizePool(j);
    });
  }

  // A page of pools. query = a token mint, a pool address or a name; sortBy "tvl:desc",
  // "volume_24h:desc", "fee_tvl_ratio_24h:desc"…; filterBy e.g. "tvl>=1000".
  async pools({ query = null, sortBy = null, filterBy = null, page = 1, pageSize = 50 } = {}) {
    const params = { page: String(page), page_size: String(Math.max(1, Math.min(1000, pageSize))) };
    if (query) params.query = query;
    if (sortBy) params.sort_by = sortBy;
    if (filterBy) params.filter_by = filterBy;
    const key = `pools:${new URLSearchParams(params)}`;
    return this.memo(key, POOL_TTL_MS, async () => {
      const j = await this.get('/pools', params);
      if (j.miss) return { total: 0, pools: [] };
      return { total: num(j.total) ?? 0, pools: (j.data || []).map(normalizePool).filter(Boolean) };
    });
  }

  // Candles ascending by time, price = token Y per token X (the pool's own quote direction).
  // Null when the timeframe is not offered here or the address is not a DLMM pool.
  // `endMs` bounds the window (a closed position is viewed around its lifetime).
  async ohlcv(address, tf = '1h', { limit = 300, endMs = null } = {}) {
    const secs = OHLCV_SECS[tf];
    if (!secs || !address) return null;
    const n = Math.max(10, Math.min(1000, Number(limit) || 300));
    const end = Math.ceil((endMs || Date.now()) / 1000 / secs) * secs;
    const ttl = endMs ? 10 * 60_000 : Math.min(60_000, Math.max(15_000, (secs * 1000) / 2));
    return this.memo(`ohlcv:${address}:${tf}:${n}:${endMs ? end : ''}`, ttl, async () => {
      // One request covers at most ~100 candles ("time range too large" beyond that), so a longer
      // window is fetched as consecutive chunks in parallel and stitched together.
      const chunks = Math.ceil(n / OHLCV_CHUNK);
      const parts = await Promise.all(Array.from({ length: chunks }, async (_, i) => {
        const hi = end - i * OHLCV_CHUNK * secs;
        const lo = hi - Math.min(OHLCV_CHUNK, n - i * OHLCV_CHUNK) * secs;
        return this.get(`/pools/${address}/ohlcv`, { timeframe: tf, start_time: String(lo), end_time: String(hi) });
      }));
      if (parts.some((j) => j.miss)) return null;
      const byT = new Map();
      for (const j of parts) for (const c of j.data || []) byT.set(c.timestamp, { t: c.timestamp * 1000, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume });
      return { tf, secs, candles: [...byT.values()].sort((a, b) => a.t - b.t).slice(-n) };
    });
  }

  // Volume and fees per bucket, ascending — the material for "how much did this pool pay".
  async volumeHistory(address, tf = '1h', { startMs = null, endMs = null } = {}) {
    if (!OHLCV_SECS[tf] || !address) return null;
    const params = { timeframe: tf };
    if (startMs) params.start_time = String(Math.floor(startMs / 1000));
    if (endMs) params.end_time = String(Math.floor(endMs / 1000));
    return this.memo(`vol:${address}:${tf}:${startMs || ''}:${endMs || ''}`, POOL_TTL_MS, async () => {
      const j = await this.get(`/pools/${address}/volume/history`, params);
      if (j.miss) return null;
      return (j.data || []).map((b) => ({ t: b.timestamp * 1000, volume: num(b.volume), fees: num(b.fees), protocolFees: num(b.protocol_fees) }))
        .sort((a, b) => a.t - b.t);
    });
  }
}

// Fee/TVL and APR are the numbers an LP actually decides on: expose one compact "stats"
// object for tables and cards (everything in USD or percent, null when unknown).
function poolStats(p) {
  if (!p) return null;
  return {
    tvlUsd: p.tvlUsd, volume24hUsd: p.volume.h24, volume1hUsd: p.volume.h1,
    fees24hUsd: p.fees.h24, feeTvl24Pct: p.feeTvl.h24,
    aprPct: p.aprPct, binStep: p.binStep,
    baseFeePct: p.baseFeePct, dynamicFeePct: p.dynamicFeePct, createdAt: p.createdAt,
    farmAprPct: p.hasFarm ? p.farmAprPct : null, blacklisted: p.blacklisted,
  };
}

module.exports = { MeteoraApi, normalizePool, poolStats, OHLCV_SECS };
