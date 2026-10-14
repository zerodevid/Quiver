'use strict';
// Value of a position in a pair with NO quote asset (memecoin / memecoin, e.g. HOOD/CUCK).
//
// Everything else in the app values positions in a quote asset (USDG/ETH/WETH), so such a
// pair used to read as $0.00 everywhere. Here one token of the pair is anchored to a USD
// price from DexScreener, and the other token is converted through the pool's own price:
//   value = (a0 + a1 / price1per0) * usd0      (anchor on token0)
//   value = (a1 + a0 * price1per0) * usd1      (anchor on token1)
// The anchor is the CURRENT price, also for historical events, so past values are an
// approximation; the ratio between the two tokens is still the pool price at that event.
// Only the research/wallet views use this — copy-trading still skips these pools.
const m = require('./v3math');

const TTL_MS = 60_000;
const FAIL_TTL_MS = 30_000;
// Switch (Settings → Display, cfg.prices.usd_anchor). Off: research views never call DexScreener.
// It only gates FETCHING (copy-trading passes `force`, see filters.allow_no_quote); valuation
// reads the cache, so a pair nobody fetched stays unknown.
let enabled = true;
const setEnabled = (v) => { enabled = v !== false; };
const cache = new WeakMap();   // chain -> Map(token -> { usd, ts })

const lc = (a) => String(a || '').toLowerCase();
const cacheOf = (chain) => { let c = cache.get(chain); if (!c) { c = new Map(); cache.set(chain, c); } return c; };

// USD price of one token from its deepest DexScreener pair; null if unknown.
async function fetchUsd(chain, token, fetchImpl) {
  const slug = chain.dexscreener;
  if (!slug) return null;
  const r = await fetchImpl(`https://api.dexscreener.com/token-pairs/v1/${slug}/${lc(token)}`,
    { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const j = await r.json();
  const list = (Array.isArray(j) ? j : j?.pairs || []).slice().sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  for (const p of list) {
    const usd = Number(p.priceUsd), native = Number(p.priceNative);
    if (!(usd > 0)) continue;
    if (lc(p.baseToken?.address) === lc(token)) return usd;
    // The token is the quote side of that pair: priceUsd belongs to the base token.
    if (lc(p.quoteToken?.address) === lc(token) && native > 0) return usd / native;
  }
  return null;
}

// Make sure the cache holds a USD price for the pair's tokens (best effort, never throws).
async function ensureAnchor(chain, token0, token1, fetchImpl = globalThis.fetch, { force = false } = {}) {
  if (!enabled && !force) return;
  if (chain.quoteSideOf(token0, token1)) return;   // a quote asset exists: nothing to anchor
  const c = cacheOf(chain);
  const now = Date.now();
  for (const t of [lc(token0), lc(token1)]) {
    const hit = c.get(t);
    if (hit && now - hit.ts < (hit.usd ? TTL_MS : FAIL_TTL_MS)) continue;
    let usd = null;
    try { usd = await fetchUsd(chain, t, fetchImpl); } catch { /* keep the old figure below */ }
    c.set(t, { usd: usd ?? hit?.usd ?? null, ts: now });
  }
}

// Synchronous valuation from the cached anchor. Returns USD, or null when the pair has no
// usable anchor / pool price.
function valueAnchoredUsd(chain, { sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
  if (!sqrtPriceX96) return null;
  const c = cacheOf(chain);
  const usd0 = c.get(lc(token0))?.usd, usd1 = c.get(lc(token1))?.usd;
  const price1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1);
  const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
  let v = null;
  if (usd0 > 0 && price1per0 > 0) v = (a0 + a1 / price1per0) * usd0;
  else if (usd1 > 0) v = (a1 + a0 * price1per0) * usd1;
  return Number.isFinite(v) ? v : null;
}

// For tests: seed or clear the cache.
function setAnchor(chain, token, usd) { cacheOf(chain).set(lc(token), { usd, ts: Date.now() }); }

module.exports = { ensureAnchor, valueAnchoredUsd, setAnchor, setEnabled };
