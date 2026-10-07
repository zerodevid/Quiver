'use strict';
// Solana entry plan. The rules are THE SAME as policy.js (rules shape, filters, caps,
// one-sided, range modes) — what differs is how size is measured: the EVM policy scales a v3
// position's L, here size is expressed as VALUE (USD), because DLMM "L" (bin shares) cannot
// be compared with another pool's L nor used to compute token amounts through the v3 formula.
//
//   mirror      : value = the value the target added
//   pct         : pct% of that
//   multiplier  : ×multiplier
//   fixed_quote : a fixed amount (fixed_quote_usd; SOL-quoted pools: fixed_quote_eth SOL)
//   equity      : the target's share of its equity × our equity (policy.equitySizing; pct when
//                 either equity is unknown)
//
// Token composition: when our range = the target's range (exact mode), the token amounts the
// target ACTUALLY deposited are scaled — its X/Y split follows exactly. When the range
// differs, the split is computed from the current price (and the DLMM shape, see share0).
const m = require('../v3math');
const u = require('./units');
const { planRange, quoteToUsd, equitySizing } = require('../policy');
const { shapeWeight, resolveStrategy, strategyLabel, weightShare0 } = require('./dlmm-shape');

const BRIDGE_MARGIN_BPS = 100;
// Orca & Raydium: the program's tick bounds (narrower than Uniswap's).
const CLMM_MAX_TICK = 443636;

// Share of value (0..1) held in token0 for the range [tl, tu) at the current price.
function share0(venue, pool, tl, tu, lowerNative, upperNative, strategy = 'spot') {
  if (venue === 'meteora') {
    // Bins above the active bin hold X only, bins below Y only, the active bin half of
    // each; each bin's value follows the strategy's shape (spot: equal per bin).
    const a = pool.current;
    if (a < lowerNative) return 1;
    if (a > upperNative) return 0;
    const n = Math.max(a - lowerNative, upperNative - a);
    let x = 0, all = 0;
    for (let b = lowerNative; b <= upperNative; b++) {
      const w = shapeWeight(strategy, Math.abs(b - a), n);
      all += w;
      if (b > a) x += w; else if (b === a) x += w / 2;
    }
    return all > 0 ? x / all : 0.5;
  }
  const L = 10n ** 18n;
  const r = m.amountsForLiquidity(pool.sqrtX96, m.getSqrtRatioAtTick(tl), m.getSqrtRatioAtTick(tu), L);
  const p = u.priceFromSqrtX96(pool.sqrtX96, pool.dec0, pool.dec1);   // token1 per token0
  const v0 = (Number(r.amount0) / 10 ** pool.dec0) * p, v1 = Number(r.amount1) / 10 ** pool.dec1;
  return v0 + v1 > 0 ? v0 / (v0 + v1) : 0.5;
}

// Raw token0/1 amounts for the value `quoteAmt` (in the pool's quote asset units).
function amountsForValue(pool, q, quoteAmt, s0) {
  const p = u.priceFromSqrtX96(pool.sqrtX96, pool.dec0, pool.dec1);   // token1 per token0
  // value in token1: token1 = quote → as is; token0 = quote → ×p
  const inT1 = q.side === 1 ? quoteAmt : quoteAmt * p;
  const v0 = inT1 * s0, v1 = inT1 * (1 - s0);
  const a0 = p > 0 ? v0 / p : 0;
  return {
    amount0: BigInt(Math.floor(a0 * 10 ** pool.dec0)),
    amount1: BigInt(Math.floor(v1 * 10 ** pool.dec1)),
  };
}

function valueQuote(chain, pool, a0, a1) {
  return chain.valueInQuote({ sqrtPriceX96: pool.sqrtX96, amount0: a0, amount1: a1, dec0: pool.dec0, dec1: pool.dec1, token0: pool.token0, token1: pool.token1 });
}

/**
 * act: the target action (watcher.actFromRow). ctx: { chain, rules, pool, ethUsd, openExposureUsd,
 * spentTodayUsd, openCount, cash: {usd, sol}|null, existingUsd }
 */
function planEntrySol(act, ctx) {
  const { rules, chain, pool, ethUsd } = ctx;
  const skip = (reason) => ({ verdict: 'skip', reason });
  if (!pool || pool.dec0 == null || pool.dec1 == null) return skip('state pool tidak terbaca');
  if (pool.enabled === false) return skip('pool sedang dinonaktifkan programnya');
  if (!rules.filters.venues.includes(act.venue)) return skip(`venue ${act.venue} dimatikan`);
  if (pool.fee != null && pool.fee > rules.filters.max_fee_bps) return skip(`fee pool ${(pool.fee / 1e4).toFixed(2)}% di atas batas`);

  const q = chain.quoteSideOf(pool.token0, pool.token1);
  if (!q) return skip(`pool tanpa aset kuotasi yang dikenal (${Object.values(chain.QUOTES).map((x) => x.symbol).join('/')})`);
  if (rules.filters.quote_whitelist.length && !rules.filters.quote_whitelist.includes(q.symbol)) return skip(`kuotasi ${q.symbol} tidak diizinkan`);
  const other = q.side === 0 ? pool.token1 : pool.token0;
  if (rules.filters.token_blacklist.includes(other)) return skip('token masuk daftar hitam');
  if (rules.filters.token_whitelist.length && !rules.filters.token_whitelist.includes(other)) return skip('token di luar daftar putih');

  const targetUsd = quoteToUsd(act.valueQuote || 0, q.kind, ethUsd);
  if (targetUsd < rules.filters.min_target_quote_usd) return skip(`tambahan target cuma $${targetUsd.toFixed(2)} (< $${rules.filters.min_target_quote_usd})`);
  const adding = ctx.existingUsd != null;
  if (!adding && ctx.openCount >= rules.filters.max_open_positions) return skip('jumlah posisi terbuka sudah mentok');

  // ---- range (computed in equivalent tick space, then to the venue's native units) ----
  const adapter = chain.adapter(act.venue);
  const exact = rules.range.mode === 'exact' && act.lower != null && act.upper != null;
  let lower, upper, tl, tu;
  if (exact) {
    lower = Number(act.lower); upper = Number(act.upper);
    ({ tickLower: tl, tickUpper: tu } = adapter.ticksOf(pool, lower, upper));
  } else {
    const r = planRange(rules, { tickLower: act.tickLower, tickUpper: act.tickUpper, tickSpacing: pool.tickSpacing }, pool.tick);
    ({ lower, upper } = adapter.nativeRange(pool, r.tickLower, r.tickUpper));
    ({ tickLower: tl, tickUpper: tu } = adapter.ticksOf(pool, lower, upper));
  }
  if (act.venue !== 'meteora') {
    const lim = Math.floor(CLMM_MAX_TICK / pool.spacing) * pool.spacing;
    lower = Math.max(-lim, lower); upper = Math.min(lim, upper); tl = lower; tu = upper;
  }
  let side = m.sideOfRange(pool.tick, tl, tu);
  if (side !== 'both') {
    if (rules.onesided.policy === 'skip') return skip(`posisi satu sisi (${side}) dan aturannya lewati`);
    if (rules.onesided.policy === 'recenter') {
      const half = Math.round((tu - tl) / 2);
      ({ lower, upper } = adapter.nativeRange(pool, pool.tick - half, pool.tick + half));
      ({ tickLower: tl, tickUpper: tu } = adapter.ticksOf(pool, lower, upper));
      side = m.sideOfRange(pool.tick, tl, tu);
    }
  }
  if (act.venue === 'meteora' && upper - lower + 1 > 1400) return skip(`rentang ${upper - lower + 1} bin melebihi batas posisi DLMM (1400)`);
  const sameRange = exact && Number(act.lower) === lower && Number(act.upper) === upper;
  const strategy = act.venue === 'meteora' ? resolveStrategy(rules.range.dlmm_strategy, act.ext?.strategy) : null;
  // 'mirror' over the target's own bins: copy its per-bin shape exactly (by-weight deposit) — a
  // preset only approximates it, and an automation's custom weights match none of them.
  const tw = act.ext?.weights;
  const weights = strategy && rules.range.dlmm_strategy === 'mirror' && sameRange && !adding && Array.isArray(tw) && tw.length === upper - lower + 1 && tw.some((w) => w > 0) ? tw : null;

  // ---- size ----
  const s = rules.sizing;
  let usd, mode = s.mode, eqNote = null;
  if (mode === 'equity') {
    const e = equitySizing(s, ctx, targetUsd);
    if (e.skip) return skip(e.skip);
    eqNote = e.note;
    if (e.fallback) mode = 'pct';
    else usd = e.usd;
  }
  if (usd != null) { /* sized by equity */ }
  else if (mode === 'mirror') usd = targetUsd;
  else if (mode === 'pct') usd = (targetUsd * s.pct) / 100;
  else if (mode === 'multiplier') usd = targetUsd * s.multiplier;
  else if (mode === 'fixed_quote') usd = q.kind === 'eth' ? s.fixed_quote_eth * ethUsd : s.fixed_quote_usd;
  else usd = targetUsd;
  if (!(usd > 0)) return skip('ukuran hasil hitung nol');

  const limits = [];
  let capPer = s.max_quote_per_position_usd, capSide = side !== 'both' ? rules.onesided.max_quote_usd : Infinity;
  if (adding) { capPer = Math.max(0, capPer - Math.max(0, ctx.existingUsd)); capSide = Math.max(0, capSide - Math.max(0, ctx.existingUsd)); }
  limits.push(['batas per posisi', capPer]);
  if (side !== 'both') limits.push(['batas satu sisi', capSide]);
  limits.push(['sisa jatah eksposur total', Math.max(0, s.max_total_exposure_usd - ctx.openExposureUsd)]);
  limits.push(['sisa anggaran harian', Math.max(0, s.daily_budget_usd - ctx.spentTodayUsd)]);
  if (ctx.cash) {
    // Cash in ANOTHER quote asset must be swapped first (Jupiter) — room for slippage + margin.
    const solUsd = ctx.cash.sol * ethUsd;
    const [same, oth] = q.kind === 'eth' ? [solUsd, ctx.cash.usd] : [ctx.cash.usd, solUsd];
    const bridge = 1 + (rules.swap.max_slippage_bps + BRIDGE_MARGIN_BPS) / 10000;
    limits.push(['kas tersedia', Math.max(0, (same + oth / bridge) / 1.05)]);
  }
  const [capWhy, capUsd] = limits.sort((a, b) => a[1] - b[1])[0];
  let note = null;
  if (usd > capUsd) {
    if (capUsd <= 0) return skip(`${capWhy} habis`);
    note = `dipotong oleh ${capWhy} ($${capUsd.toFixed(2)})`;
    usd = capUsd;
  }
  if (usd < s.min_quote_usd) {
    const small = `hasilnya $${usd.toFixed(2)} (< minimum $${s.min_quote_usd})`;
    if (!s.force_min || s.force_min_usd <= 0) return skip(`${small}${note ? ` — ${note}` : ''}`);
    if (s.force_min_usd > capUsd) return skip(`${small} dan paksa $${s.force_min_usd} tidak muat — ${capWhy} tinggal $${capUsd.toFixed(2)}`);
    note = `dipaksa ke $${s.force_min_usd.toFixed(2)} (hitungan $${usd.toFixed(2)} < minimum $${s.min_quote_usd})`;
    usd = s.force_min_usd;
  }

  // ---- token amounts ----
  const quoteAmt = q.kind === 'eth' ? usd / ethUsd : usd;
  let amount0, amount1;
  const t0 = BigInt(act.amount0 || '0'), t1 = BigInt(act.amount1 || '0');
  const tv = sameRange && (t0 > 0n || t1 > 0n) ? valueQuote(chain, pool, t0, t1) : null;
  if (tv && tv.value > 0) {
    const f = BigInt(Math.floor((quoteAmt / tv.value) * 1e12));
    amount0 = (t0 * f) / 10n ** 12n; amount1 = (t1 * f) / 10n ** 12n;
  } else {
    const s0 = weights ? weightShare0(weights, lower, pool.current) : share0(act.venue, pool, tl, tu, lower, upper, strategy || 'spot');
    ({ amount0, amount1 } = amountsForValue(pool, q, quoteAmt, s0));
  }
  if (side === 'token0_only') amount1 = 0n;
  if (side === 'token1_only') amount0 = 0n;
  const est = valueQuote(chain, pool, amount0, amount1);
  if (!est || !(est.value > 0)) return skip('tidak bisa menilai posisi');

  return {
    verdict: 'copy',
    reason: `${eqNote ? `${eqNote} · ` : ''}${note || `${mode} → $${usd.toFixed(2)}`}${strategy ? ` · ${weights ? 'bentuk per-bin target' : strategyLabel(strategy)}` : ''}`,
    plan: {
      venue: act.venue, action: adding ? 'increase' : 'mint',
      poolRef: pool.id, token0: pool.token0, token1: pool.token1, fee: pool.fee,
      tickSpacing: pool.tickSpacing, tickLower: tl, tickUpper: tu,
      lower, upper, binStep: pool.binStep ?? null, strategy, weights,
      amount0: amount0.toString(), amount1: amount1.toString(),
      valueQuote: est.value, quoteSymbol: q.symbol, quoteKind: q.kind, quoteSide: q.side,
      valueUsd: quoteToUsd(est.value, q.kind, ethUsd),
      side, mirrorOf: act.tokenId, target: act.target, curTick: pool.tick,
      targetRange: [act.tickLower, act.tickUpper], targetValueUsd: targetUsd,
      slippageBps: rules.swap.max_slippage_bps,
    },
  };
}

module.exports = { planEntrySol, share0, amountsForValue, CLMM_MAX_TICK };
