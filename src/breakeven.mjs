// Solve LP value + existing fees + proceeds = deposited capital in quote units.
// Liquidity is rebalanced throughout the range; future fees and exit costs are excluded.
export function breakEven(p, { all = false } = {}) {
  if (p.status === 'closed' || (!all && p.inRange !== false) || p.empty) return null;
  const unavailable = { reason: 'Data BEP belum tersedia.' };
  if (p.valueStale || p.liqStale || p.markRef || ![0, 1].includes(p.quoteSide) ||
      p.tick_lower == null || p.tick_upper == null || p.dec0 == null || p.dec1 == null ||
      p.cost_quote == null || p.fee0 == null || p.fee1 == null) return unavailable;
  const at = tick => {
    const raw = 1.0001 ** tick * 10 ** (p.dec0 - p.dec1);
    return p.quoteSide === 0 ? 1 / raw : raw;
  };
  const lo = Math.min(at(p.tick_lower), at(p.tick_upper));
  const hi = Math.max(at(p.tick_lower), at(p.tick_upper));
  const baseSide = 1 - p.quoteSide;
  let L = Number(p.liquidity) * 10 ** (-(p.dec0 + p.dec1) / 2);
  if (p.venue === 'meteora') {
    // A DLMM position's "liquidity" is a sum of bin shares, not a concentrated-liquidity L:
    // use the L of a v3 range over the same bins that holds the same value at the current price.
    const now = p.curTick != null ? at(p.curTick) : null;
    const base = Number(p[`amount${baseSide}`] ?? NaN) / 10 ** p[`dec${baseSide}`];
    const quote = Number(p[`amount${p.quoteSide}`] ?? NaN) / 10 ** p[`dec${p.quoteSide}`];
    const s = Math.sqrt(Math.max(lo, Math.min(hi, now)));
    const perL = (1 / s - 1 / Math.sqrt(hi)) * now + s - Math.sqrt(lo);
    L = now > 0 && perL > 0 ? (base * now + quote) / perL : NaN;
  }
  const baseFee = Number(p[`fee${baseSide}`]) / 10 ** p[`dec${baseSide}`];
  const quoteFee = Number(p[`fee${p.quoteSide}`]) / 10 ** p[`dec${p.quoteSide}`];
  const target = Number(p.cost_quote) - Number(p.claimed_quote ?? 0) - Number(p.out_quote ?? 0) - quoteFee;
  if (![lo, hi, L, baseFee, quoteFee, target].every(Number.isFinite) || !(lo > 0 && hi > lo && L > 0) || baseFee < 0 || quoteFee < 0) return unavailable;
  if (target <= 0) return { reason: 'Modal sudah tertutup pada semua harga.' };
  const a = Math.sqrt(lo), b = Math.sqrt(hi);
  const value = price => {
    const s = Math.sqrt(Math.max(lo, Math.min(hi, price)));
    return L * ((1 / s - 1 / b) * price + s - a) + baseFee * price;
  };
  const cap = L * (b - a);
  if (!baseFee && target > cap) return { reason: 'BEP tidak tercapai dari perubahan harga saja.' };
  let left = 0, right = Math.max(hi, baseFee > 0 ? (target - cap) / baseFee : hi);
  if (!Number.isFinite(right)) return unavailable;
  for (let i = 0; i < 160; i++) {
    const mid = (left + right) / 2;
    if (value(mid) < target) left = mid; else right = mid;
  }
  return { price: right };
}
