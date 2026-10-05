'use strict';
// Rencana entry Solana. Aturannya SAMA dengan policy.js (bentuk rules, filter, plafon,
// sisi tunggal, mode rentang) — yang beda cara mengukur: policy EVM menskala L posisi
// v3, di sini ukuran dinyatakan dalam NILAI (USD), karena "L" DLMM (jumlah saham bin)
// tidak bisa dibandingkan dengan L pool lain dan tidak bisa dipakai menghitung jumlah
// token lewat rumus v3.
//
//   mirror      : nilai = nilai yang ditambahkan target
//   pct         : pct% dari itu
//   multiplier  : ×multiplier
//   fixed_quote : nominal tetap (fixed_quote_usd; pool berkuotasi SOL: fixed_quote_eth SOL)
//
// Komposisi token: kalau rentang kita = rentang target (mode exact), jumlah token yang
// BENAR-BENAR disetor target diskala — pembagian X/Y-nya ikut persis (termasuk bentuk
// strategi DLMM). Kalau rentangnya lain, pembagian dihitung dari harga sekarang.
const m = require('../v3math');
const u = require('./units');
const { planRange, quoteToUsd } = require('../policy');
const { shapeWeight, resolveStrategy, strategyLabel } = require('./dlmm-shape');

const BRIDGE_MARGIN_BPS = 100;
// Orca & Raydium: batas tick program (lebih sempit dari Uniswap).
const CLMM_MAX_TICK = 443636;

// Bagian nilai (0..1) yang berada di token0 untuk rentang [tl, tu) di harga sekarang.
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

// Jumlah mentah token0/1 untuk nilai `quoteAmt` (satuan aset kuotasi pool).
function amountsForValue(pool, q, quoteAmt, s0) {
  const p = u.priceFromSqrtX96(pool.sqrtX96, pool.dec0, pool.dec1);   // token1 per token0
  // nilai dalam token1: token1 = kuotasi → langsung; token0 = kuotasi → ×p
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
 * act: aksi target (watcher.actFromRow). ctx: { chain, rules, pool, ethUsd, openExposureUsd,
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

  // ---- rentang (dihitung di ruang tick setara, lalu ke satuan asli venue) ----
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

  // ---- ukuran ----
  const s = rules.sizing;
  let usd;
  if (s.mode === 'mirror') usd = targetUsd;
  else if (s.mode === 'pct') usd = (targetUsd * s.pct) / 100;
  else if (s.mode === 'multiplier') usd = targetUsd * s.multiplier;
  else if (s.mode === 'fixed_quote') usd = q.kind === 'eth' ? s.fixed_quote_eth * ethUsd : s.fixed_quote_usd;
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
    // Kas di aset kuotasi LAIN harus ditukar dulu (Jupiter) — ruang slippage + margin.
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

  // ---- jumlah token ----
  const quoteAmt = q.kind === 'eth' ? usd / ethUsd : usd;
  let amount0, amount1;
  const t0 = BigInt(act.amount0 || '0'), t1 = BigInt(act.amount1 || '0');
  const tv = sameRange && (t0 > 0n || t1 > 0n) ? valueQuote(chain, pool, t0, t1) : null;
  if (tv && tv.value > 0) {
    const f = BigInt(Math.floor((quoteAmt / tv.value) * 1e12));
    amount0 = (t0 * f) / 10n ** 12n; amount1 = (t1 * f) / 10n ** 12n;
  } else {
    ({ amount0, amount1 } = amountsForValue(pool, q, quoteAmt, share0(act.venue, pool, tl, tu, lower, upper, strategy || 'spot')));
  }
  if (side === 'token0_only') amount1 = 0n;
  if (side === 'token1_only') amount0 = 0n;
  const est = valueQuote(chain, pool, amount0, amount1);
  if (!est || !(est.value > 0)) return skip('tidak bisa menilai posisi');

  return {
    verdict: 'copy',
    reason: `${note || `${s.mode} → $${usd.toFixed(2)}`}${strategy ? ` · ${strategyLabel(strategy)}` : ''}`,
    plan: {
      venue: act.venue, action: adding ? 'increase' : 'mint',
      poolRef: pool.id, token0: pool.token0, token1: pool.token1, fee: pool.fee,
      tickSpacing: pool.tickSpacing, tickLower: tl, tickUpper: tu,
      lower, upper, binStep: pool.binStep ?? null, strategy,
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
