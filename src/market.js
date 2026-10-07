'use strict';
const crypto = require('node:crypto');
// Third-party market data for the position detail page: pool stats from
// DexScreener and OHLCV candles from GeckoTerminal. Two sources because each
// excels at one thing — DexScreener has neat current volume/transactions/liquidity,
// GeckoTerminal has OHLCV per pool (DexScreener does not expose a candle API).
//
// Both limit calls per IP (GeckoTerminal ~30/minute), so the answers
// are kept briefly in memory: a dashboard open in two tabs, or the periodic poll of the
// detail page, must not double the outbound calls.
// The chain slug at each service comes from the chain profile (networks.js: dexscreener,
// geckoterminal) — one Market instance per chain.
const dsBase = (slug) => `https://api.dexscreener.com/latest/dex/pairs/${slug}/`;
// All pools containing the token (max 30) — /tokens/v1 only gives one per token.
const dsTokenBase = (slug) => `https://api.dexscreener.com/token-pairs/v1/${slug}/`;
const gtBase = (slug) => `https://api.geckoterminal.com/api/v2/networks/${slug}/pools/`;
const { gtTradesUrl, normalizeTrades } = require('./trades.mjs');
// The official GMGN OpenAPI (needs an API key from gmgn.ai/ai): GMGN's price candles — the same
// data as the chart on gmgn.ai, but drawn on our own chart so the position
// range can be overlaid. For read-only, the X-APIKEY header is enough; the free plan is
// ~1 request/second per key.
const GMGN_API = 'https://openapi.gmgn.ai';
// Weight of each route on the GMGN quota bucket (docs: gmgn-skills, "Rate Limit Handling").
const GMGN_WEIGHT = {
  '/v1/token/info': 1, '/v1/token/security': 1, '/v1/token/pool_info': 1,
  '/v1/market/token_top_holders': 5, '/v1/market/token_top_traders': 5,
  '/v1/market/token_kline': 2, '/v1/user/wallet_stats': 3,
};
const gmgnNorm = require('./gmgn');

// Candle time ranges offered by the UI -> GeckoTerminal (timeframe, aggregate).
const TF = {
  '1m': ['minute', 1, 60], '5m': ['minute', 5, 300], '15m': ['minute', 15, 900],
  '1h': ['hour', 1, 3600], '4h': ['hour', 4, 14400], '1d': ['day', 1, 86400],
};

class Market {
  // gmgnKey: a function that returns the current GMGN API key (it can change from the
  // Settings page without a restart), or null if not yet set.
  constructor({ log, fetch: fetchImpl, chain = null, gmgnKey = null } = {}) {
    this.log = log || (() => {});
    this.fetch = fetchImpl || globalThis.fetch;
    this.gmgnKey = typeof gmgnKey === 'function' ? gmgnKey : () => gmgnKey;
    this.gmgnSlug = chain?.gmgn || chain?.network || 'robinhood';
    this.gmgnCooldown = 0;    // ms — the GMGN OpenAPI is not called before this (just hit the limit)
    this.gmgnNext = 0;        // ms — the earliest the next GMGN call may go (spacing between calls)
    this.gmgnQueue = null;    // promise chain of the GMGN queue
    this.network = chain?.network || 'robinhood';
    // Solana only: the Meteora DLMM data API (src/solana/meteora-api.js). Preferred for DLMM pools —
    // exact TVL/volume/fees/creation time and candles in the pool's own quote — with
    // DexScreener/GeckoTerminal as the fallback and for every other venue.
    this.meteora = chain?.meteora || null;
    // Alamat EVM dibandingkan dalam huruf kecil; alamat Solana (base58) peka huruf.
    this.lc = chain?.kind === 'solana' ? (x) => String(x || '') : (x) => String(x || '').toLowerCase();
    this.DS = dsBase(chain?.dexscreener || 'robinhood');
    this.DS_TOKEN = dsTokenBase(chain?.dexscreener || 'robinhood');
    this.gtSlug = chain?.geckoterminal || 'robinhood';
    this.GT = gtBase(this.gtSlug);
    this.cache = new Map();   // key -> { until, value: Promise }
    this.good = new Map();    // key -> { at, value } — the last good answer (fallback)
    this.gtCooldown = 0;      // ms — GeckoTerminal is not called before this (just hit 429)
  }

  // The same request within a `ttl` ms window is answered from the cache — including
  // one still in flight, so two tabs opening the detail at the same time share a single
  // call. A failed answer is not stored for long: retry 10 seconds later.
  //
  // If the call FAILS but we once had a good answer that is not too old,
  // that old answer is returned with a `stale` flag. GeckoTerminal
  // limits calls per IP (429) and this one VPS is used by several instances
  // at once: without this fallback, a chart that was just shown would suddenly be replaced by an error
  // message only because its neighbour happened to pull data in the same second.
  memo(key, ttl, fn, { staleMs = 15 * 60_000 } = {}) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value;
    const fallback = (err) => {
      const last = this.good.get(key);
      if (last && Date.now() - last.at < staleMs) {
        const v = { ...last.value, stale: true, staleAt: last.at, staleReason: err };
        this.cache.set(key, { until: Date.now() + 10_000, value: Promise.resolve(v) });
        return v;
      }
      const v = { error: err };
      this.cache.set(key, { until: Date.now() + 10_000, value: Promise.resolve(v) });
      return v;
    };
    const value = fn().then(
      (v) => {
        if (v?.error) return fallback(v.error);
        if (v && typeof v === 'object') this.good.set(key, { at: Date.now(), value: v });
        return v;
      },
      (e) => fallback(e.message),
    );
    this.cache.set(key, { until: now + ttl, value });
    if (this.cache.size > 200) { for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k); }
    if (this.good.size > 200) { for (const [k, v] of this.good) if (Date.now() - v.at > staleMs) this.good.delete(k); }
    return value;
  }

  // `tries` > 1 only for callers that really need the answer now (the Telegram chart
  // card): from the VPS, GeckoTerminal can take 10+ seconds to answer, and once
  // the timeout hits, the button replies with an error although the second attempt would have passed.
  // What the dashboard polls stays at a single try so the page does not wait twice.
  //
  // Once GeckoTerminal answers 429, ALL calls to it are held for 20 seconds
  // (the memo then serves the fallback/stale): continuing to hit it when the quota is exhausted only
  // prolongs the block for all three instances on this IP.
  async json(url, { timeoutMs = 12_000, tries = 1 } = {}) {
    const gt = url.startsWith('https://api.geckoterminal.com/');
    if (gt && this.gtCooldown > Date.now()) throw new Error('batas panggilan (429) — coba lagi sebentar');
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await this.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 429) {
          if (gt) this.gtCooldown = Date.now() + 20_000;
          throw new Error('batas panggilan (429) — coba lagi sebentar');
        }
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      } catch (e) {
        last = e;
        // What is worth retrying: timeouts, dropped connections, and server-side errors
        // (502/503/504 — GeckoTerminal occasionally answers those for a few seconds).
        // 429 is NOT retried: it is precisely asking us to stop for a moment.
        const layak = /abort|timeout|timed out|fetch failed|network|ECONN|socket/i.test(String(e.message))
          || /^HTTP 5\d\d$/.test(String(e.message));
        if (!layak || i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw last;
  }

  // Pool stats from DexScreener. v4 pool = poolId (bytes32), v3 = pool address.
  pair(ref) {
    const key = `ds:${this.lc(ref)}`;
    return this.memo(key, 30_000, async () => {
      const mp = this.meteora ? await this.meteora.pool(ref).catch(() => null) : null;
      if (mp) return this.pairFromMeteora(mp, ref);
      const j = await this.json(this.DS + ref);
      const p = j?.pairs?.[0] || j?.pair;
      if (!p) return { error: 'pool ini belum terindeks di DexScreener' };
      const lc = this.lc;
      return {
        url: p.url, dexId: p.dexId, labels: p.labels || [],
        base: { address: lc(p.baseToken?.address), symbol: p.baseToken?.symbol },
        quote: { address: lc(p.quoteToken?.address), symbol: p.quoteToken?.symbol },
        priceUsd: Number(p.priceUsd) || null, priceNative: Number(p.priceNative) || null,
        priceChange: p.priceChange || {}, volume: p.volume || {}, txns: p.txns || {},
        liquidityUsd: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, marketCap: p.marketCap ?? null,
        pairCreatedAt: p.pairCreatedAt ?? null,
        imageUrl: p.info?.imageUrl || null,
        websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
        fetchedAt: Date.now(),
      };
    });
  }

  // A Meteora DLMM pool in the DexScreener `pair()` shape, so every consumer keeps working.
  // Meteora is authoritative for what it knows exactly (TVL, volume, fees, creation time);
  // DexScreener (best effort, never required) only adds price changes, trade counts and the
  // token image/links, which the Meteora API does not have.
  async pairFromMeteora(mp, ref) {
    const ds = await this.json(this.DS + ref).then((j) => j?.pairs?.[0] || j?.pair || null).catch(() => null);
    const x = mp.tokenX, y = mp.tokenY;
    return {
      url: `https://app.meteora.ag/dlmm/${ref}`, dexId: 'meteora',
      labels: ['DLMM', ...(mp.binStep != null ? [`bin ${mp.binStep}`] : [])],
      base: { address: x?.address, symbol: x?.symbol }, quote: { address: y?.address, symbol: y?.symbol },
      priceUsd: x?.priceUsd ?? (Number(ds?.priceUsd) || null), priceNative: mp.currentPrice ?? (Number(ds?.priceNative) || null),
      priceChange: ds?.priceChange || {}, txns: ds?.txns || {},
      // h6 is not offered by Meteora (windows: 30m 1h 2h 4h 12h 24h); the rest map straight over.
      volume: { ...(ds?.volume || {}), m30: mp.volume.m30, h1: mp.volume.h1, h2: mp.volume.h2, h4: mp.volume.h4, h12: mp.volume.h12, h24: mp.volume.h24 },
      liquidityUsd: mp.tvlUsd, fdv: ds?.fdv ?? null, marketCap: x?.marketCap ?? ds?.marketCap ?? null,
      pairCreatedAt: mp.createdAt ?? ds?.pairCreatedAt ?? null,
      imageUrl: ds?.info?.imageUrl || null,
      websites: (ds?.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
      meteora: {
        binStep: mp.binStep, baseFeePct: mp.baseFeePct, dynamicFeePct: mp.dynamicFeePct, maxFeePct: mp.maxFeePct,
        fees: mp.fees, feeTvl: mp.feeTvl, aprPct: mp.aprPct, apyPct: mp.apyPct, farmAprPct: mp.hasFarm ? mp.farmAprPct : null,
        blacklisted: mp.blacklisted,
      },
      fetchedAt: Date.now(),
    };
  }

  // All of a token's pools from DexScreener, the largest liquidity first — the material for
  // the token detail page. The first pool becomes the source of its price chart.
  token(address) {
    const a = this.lc(address);
    return this.memo(`dst:${a}`, 30_000, async () => {
      // Solana: the Meteora DLMM list runs alongside DexScreener; either may fail on its own.
      const [j, mps] = await Promise.all([
        this.json(this.DS_TOKEN + a).catch((e) => (this.meteora ? null : Promise.reject(e))),
        this.meteora ? this.meteora.pools({ query: a, sortBy: 'tvl:desc', pageSize: 50 }).then((r) => r.pools).catch(() => []) : [],
      ]);
      const list = Array.isArray(j) ? j : j?.pairs || [];
      const lc = this.lc;
      const pairs = list.filter((p) => p?.pairAddress).map((p) => ({
        pool: lc(p.pairAddress), url: p.url, dexId: p.dexId, labels: p.labels || [],
        base: { address: lc(p.baseToken?.address), symbol: p.baseToken?.symbol, name: p.baseToken?.name },
        quote: { address: lc(p.quoteToken?.address), symbol: p.quoteToken?.symbol, name: p.quoteToken?.name },
        priceUsd: Number(p.priceUsd) || null, priceNative: Number(p.priceNative) || null,
        priceChange: p.priceChange || {}, volume: p.volume || {}, txns: p.txns || {},
        liquidityUsd: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, marketCap: p.marketCap ?? null,
        pairCreatedAt: p.pairCreatedAt ?? null,
        websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
        socials: (p.info?.socials || []).filter((x) => x?.url).map((x) => ({ type: x.type, url: x.url })).slice(0, 4),
      }));
      // Overlay what Meteora knows exactly onto DexScreener's rows; pools DexScreener has not
      // indexed (new DLMM pools) are added.
      const byPool = new Map(pairs.map((p) => [p.pool, p]));
      for (const mp of mps) {
        const row = byPool.get(mp.address);
        const x = mp.tokenX, y = mp.tokenY;
        const vol = { m30: mp.volume.m30, h1: mp.volume.h1, h2: mp.volume.h2, h4: mp.volume.h4, h12: mp.volume.h12, h24: mp.volume.h24 };
        if (row) {
          Object.assign(row, { dexId: 'meteora', url: `https://app.meteora.ag/dlmm/${mp.address}`, liquidityUsd: mp.tvlUsd ?? row.liquidityUsd,
            volume: { ...row.volume, ...vol }, pairCreatedAt: mp.createdAt ?? row.pairCreatedAt });
        } else {
          pairs.push({
            pool: mp.address, url: `https://app.meteora.ag/dlmm/${mp.address}`, dexId: 'meteora', labels: ['DLMM'],
            base: { address: x?.address, symbol: x?.symbol, name: x?.name }, quote: { address: y?.address, symbol: y?.symbol, name: y?.name },
            priceUsd: x?.priceUsd ?? null, priceNative: mp.currentPrice, priceChange: {}, volume: vol, txns: {},
            liquidityUsd: mp.tvlUsd, fdv: null, marketCap: x?.marketCap ?? null, pairCreatedAt: mp.createdAt,
            websites: [], socials: [],
          });
        }
        (row || pairs[pairs.length - 1]).meteora = { binStep: mp.binStep, baseFeePct: mp.baseFeePct, feeTvl: mp.feeTvl, aprPct: mp.aprPct };
      }
      pairs.sort((x, y) => (y.liquidityUsd || 0) - (x.liquidityUsd || 0));
      if (!pairs.length && !j) return { error: 'tidak ada pool untuk token ini' };
      return { pairs, fetchedAt: Date.now() };
    });
  }

  // OHLCV candles from GeckoTerminal, ascending by time.
  //  - token: the token address that is the price base (the speculative token), so the direction
  //    of the price is the same as the position range in the UI — not up to GeckoTerminal.
  //  - currency 'token': price in the pool's quote asset (USDG/ETH), not USD, so it is
  //    aligned with the position's tick range.
  //  - before: end bound (ms) — a closed position is viewed around its
  //    lifetime, not up to now. Rounded to a candle so the cache gets hits.
  candles(ref, tf = '1h', { limit = 300, token = null, currency = 'token', before = null, patient = false } = {}) {
    const [frame, agg, secs] = TF[tf] || TF['1h'];
    const n = Math.max(10, Math.min(1000, Number(limit) || 300));
    const beforeS = before ? Math.ceil(before / 1000 / secs) * secs : null;
    const key = `gt:${this.lc(ref)}:${tf}:${n}:${token || ''}:${currency}:${beforeS || ''}`;
    // Cache for half a candle, at most 60 seconds: the running candle
    // still visibly moves without flooding GeckoTerminal. History that has already
    // passed (before) no longer changes — store it longer.
    return this.memo(key, beforeS ? 10 * 60_000 : Math.min(60_000, Math.max(15_000, (secs * 1000) / 2)), async () => {
      // Solana DLMM pool: Meteora's own candles, in the pool's quote asset (the 'token' currency).
      // GeckoTerminal still serves USD prices, timeframes Meteora lacks (1m, 15m) and other venues.
      if (this.meteora && currency === 'token') {
        const mc = await this.meteora.ohlcv(ref, tf, { limit: n, endMs: beforeS ? beforeS * 1000 : null }).catch(() => null);
        if (mc?.candles?.length) return this.candlesFromMeteora(ref, mc, token);
      }
      const q = new URLSearchParams({ aggregate: String(agg), limit: String(n), currency });
      if (token) q.set('token', token);
      if (beforeS) q.set('before_timestamp', String(beforeS));
      const j = await this.json(`${this.GT}${ref}/ohlcv/${frame}?${q}`, patient ? { timeoutMs: 25_000, tries: 2 } : {});
      if (!j) return { error: 'pool ini belum terindeks di GeckoTerminal' };
      const list = j?.data?.attributes?.ohlcv_list || [];
      // Occasionally there are two candles with the same time: the later one wins.
      const byT = new Map(list.map(([t, o, h, l, c, v]) => [t, { t: t * 1000, o, h, l, c, v }]));
      const candles = [...byT.values()].sort((a, b) => a.t - b.t);
      return {
        tf, secs, candles,
        base: j?.meta?.base ? { address: this.lc(j.meta.base.address || ''), symbol: j.meta.base.symbol } : null,
        quote: j?.meta?.quote ? { address: this.lc(j.meta.quote.address || ''), symbol: j.meta.quote.symbol } : null,
        fetchedAt: Date.now(),
      };
    });
  }

  // Meteora candles price token X in token Y. The caller names the price base (`token`): when
  // that is token Y the series is inverted so the direction matches the position range.
  async candlesFromMeteora(ref, mc, token) {
    const mp = await this.meteora.pool(ref).catch(() => null);
    const invert = !!(token && mp?.tokenY?.address === token);
    const candles = invert
      ? mc.candles.map((c) => ({ t: c.t, o: 1 / c.o, h: 1 / c.l, l: 1 / c.h, c: 1 / c.c, v: c.v }))
      : mc.candles;
    const [b, q] = invert ? [mp.tokenY, mp.tokenX] : [mp?.tokenX, mp?.tokenY];
    return {
      tf: mc.tf, secs: mc.secs, candles, source: 'meteora',
      base: b ? { address: b.address, symbol: b.symbol } : null, quote: q ? { address: q.address, symbol: q.symbol } : null,
      fetchedAt: Date.now(),
    };
  }

  // GMGN call queue: one at a time, with a gap of weight/5 seconds
  // after each call (a 5 points/second bucket) so this process itself never
  // exceeds the quota — other instances on the same IP remain outside our control.
  gmgnSlot(weight, fn) {
    const run = async () => {
      const wait = this.gmgnNext - Date.now();
      if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
      try { return await fn(); }
      finally { this.gmgnNext = Date.now() + Math.ceil((weight / 5) * 1000); }
    };
    const p = (this.gmgnQueue || Promise.resolve()).then(run, run);
    this.gmgnQueue = p.catch(() => {});
    return p;
  }

  // OHLCV candles from the GMGN OpenAPI for one token (USD price, not the pool's quote asset
  // — GMGN prices tokens, not pools). The shape of the answer is aligned with
  // candles() so the UI uses the same path; `source: 'gmgn'` and
  // `currency: 'usd'` tell the UI that the position range needs converting to USD.
  // Without a key: { error } so the UI falls back to GeckoTerminal.
  gmgnEnabled() { return !!this.gmgnKey(); }
  candlesGmgn(token, tf = '1h', { limit = 300, before = null } = {}) {
    const key = this.gmgnKey();
    if (!key) return Promise.resolve({ error: 'API key GMGN belum diisi (Pengaturan → GMGN)' });
    const [, , secs] = TF[tf] || TF['1h'];
    const n = Math.max(10, Math.min(1000, Number(limit) || 300));
    const beforeS = before ? Math.ceil(before / 1000 / secs) * secs : null;
    const ck = `gmgn:${this.lc(token)}:${tf}:${n}:${beforeS || ''}`;
    return this.memo(ck, beforeS ? 10 * 60_000 : Math.min(60_000, Math.max(15_000, (secs * 1000) / 2)), async () => {
      const to = beforeS ? beforeS : Math.floor(Date.now() / 1000);
      const j = await this.gmgn('/v1/market/token_kline', { address: this.lc(token), resolution: tf, from: (to - n * secs) * 1000, to: to * 1000 });
      if (j?.error) return j;
      const byT = new Map();
      for (const c of j?.list || []) {
        const t = Number(c.time), o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
        if (!(t > 0) || !(o > 0) || !(h > 0) || !(l > 0) || !(cl > 0)) continue;
        // volume = token amount, amount = USD value — the UI uses the USD value as the volume.
        byT.set(t, { t: t * 1000, o, h, l, c: cl, v: Number(c.amount) || 0 });
      }
      const candles = [...byT.values()].sort((a, b) => a.t - b.t);
      return { tf, secs, candles, source: 'gmgn', currency: 'usd', base: { address: this.lc(token) }, quote: null, fetchedAt: Date.now() };
    });
  }

  // Token profile per GMGN: info + security (weight 1 + 1), once per minute per
  // token. One may fail — the other is still used and the error carried along.
  gmgnToken(address) {
    const a = this.lc(address);
    if (!this.gmgnKey()) return Promise.resolve({ enabled: false });
    return this.memo(`gmgn-token:${a}`, 60_000, async () => {
      const [info, sec] = await Promise.all([
        this.gmgn('/v1/token/info', { address: a }).catch((e) => ({ error: e.message })),
        this.gmgn('/v1/token/security', { address: a }).catch((e) => ({ error: e.message })),
      ]);
      if (info?.error && sec?.error) return { error: info.error };
      return {
        enabled: true, address: a,
        ...(info?.error ? { infoError: info.error } : gmgnNorm.normalizeTokenInfo(info)),
        security: sec?.error ? null : gmgnNorm.normalizeTokenSecurity(sec),
        securityError: sec?.error || null,
        fetchedAt: Date.now(),
      };
    });
  }

  // Top holders / traders of a token (weight 5 — a single call exhausts the free plan's
  // bucket), so stored for 3 minutes and only pulled when its panel is opened.
  gmgnWallets(address, { kind = 'holders', limit = 50, orderBy = null } = {}) {
    const a = this.lc(address);
    if (!this.gmgnKey()) return Promise.resolve({ enabled: false });
    const n = Math.max(5, Math.min(100, Number(limit) || 50));
    const path = kind === 'traders' ? '/v1/market/token_top_traders' : '/v1/market/token_top_holders';
    return this.memo(`gmgn-${kind}:${a}:${n}:${orderBy || ''}`, 180_000, async () => {
      const d = await this.gmgn(path, { address: a, limit: n, ...(orderBy ? { order_by: orderBy } : {}) });
      if (d?.error) return d;
      return { enabled: true, address: a, kind, rows: gmgnNorm.normalizeWallets(d), fetchedAt: Date.now() };
    });
  }

  // Trading stats of one wallet per GMGN (weight 3), 5 minutes.
  gmgnWallet(address, { period = '7d' } = {}) {
    const a = this.lc(address);
    if (!this.gmgnKey()) return Promise.resolve({ enabled: false });
    const per = period === '30d' ? '30d' : '7d';
    return this.memo(`gmgn-wallet:${a}:${per}`, 300_000, async () => {
      const d = await this.gmgn('/v1/user/wallet_stats', { wallet_address: a, period: per });
      if (d?.error) return d;
      return { enabled: true, address: a, ...gmgnNorm.normalizeWalletStats(d, per), fetchedAt: Date.now() };
    });
  }

  // One read call to the GMGN OpenAPI. The answer is wrapped { code, data, error,
  // message }: code 0 = success.
  //
  // The free plan's quota is a leaky bucket of 5 points / 5 points per second PER IP — and
  // one VPS IP is used by three bot instances. A weight-5 call (holders/traders)
  // almost certainly collides with other calls, so: (1) calls are queued
  // and spaced by their weight, (2) hitting the limit is retried once after
  // 1.5 seconds, (3) still limited -> all calls are held for 10 seconds so the memo
  // serves the fallback, instead of continuing to hit it.
  async gmgn(subPath, params = {}, { timeoutMs = 12_000, weight = GMGN_WEIGHT[subPath] || 1 } = {}) {
    const key = this.gmgnKey();
    if (!key) return { error: 'API key GMGN belum diisi' };
    if (this.gmgnCooldown > Date.now()) throw new Error('batas panggilan GMGN — coba lagi sebentar');
    const q = new URLSearchParams({ chain: this.gmgnSlug, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() });
    const call = async () => {
      const r = await this.fetch(`${GMGN_API}${subPath}?${q}`, { headers: { accept: 'application/json', 'X-APIKEY': key }, signal: AbortSignal.timeout(timeoutMs) });
      return { r, j: await r.json().catch(() => null) };
    };
    const limited = ({ r, j }) => r.status === 429 || /RATE_LIMIT/.test(String(j?.error || ''));
    let res = await this.gmgnSlot(weight, call);
    if (limited(res)) {
      await new Promise((ok) => setTimeout(ok, 1500));
      res = await this.gmgnSlot(weight, call);
    }
    const { r, j } = res;
    if (limited(res)) {
      this.gmgnCooldown = Date.now() + 10_000;
      throw new Error(`batas panggilan GMGN (${j?.error || 429})${j?.message ? ` — ${j.message}` : ''}`);
    }
    if (r.status === 401 || r.status === 403) return { error: `GMGN menolak API key (HTTP ${r.status}${j?.message ? `: ${j.message}` : ''})` };
    if (!r.ok) throw new Error(`GMGN HTTP ${r.status}`);
    if (!j || j.code !== 0) return { error: `GMGN: ${j?.message || j?.error || 'jawaban tidak dikenal'}` };
    return j.data ?? {};
  }

  // The latest swap transactions in one pool from GeckoTerminal (max. 300 in the last
  // 24 hours), newest first — the fallback of the "running trade" tape if the browser
  // cannot call GeckoTerminal itself (see trades.mjs). 15-second cache: this VPS's IP
  // is used by three instances at once and its quota is ~30 calls/minute.
  trades(ref, { token = null, limit = 80 } = {}) {
    const t = this.lc(token || '');
    return this.memo(`gtt:${this.lc(ref)}:${t}:${limit}`, 15_000, async () => {
      const j = await this.json(gtTradesUrl(this.gtSlug, ref));
      if (!j) return { error: 'pool ini belum terindeks di GeckoTerminal' };
      return { trades: normalizeTrades(j, { token: t || null, limit }), fetchedAt: Date.now() };
    });
  }
}

module.exports = { Market, TF };
