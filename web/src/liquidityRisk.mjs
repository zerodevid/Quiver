// Piecewise concentrated-liquidity model. All prices are quote units/base token.
const EPS = 1e-10;
export function makeCurve(d) {
  if (!d || d.error || d.hook || ![0, 1].includes(d.quoteSide) || !(d.quoteUsd > 0) || !Number.isFinite(d.dec0) || !Number.isFinite(d.dec1)) return null;
  const scale = 10 ** (-(d.dec0 + d.dec1) / 2);
  const priceAt = (tick) => { const raw = 1.0001 ** tick * 10 ** (d.dec0 - d.dec1); return d.quoteSide === 0 ? 1 / raw : raw; };
  const raw = (Number(d.sqrt) / 2 ** 96) ** 2 * 10 ** (d.dec0 - d.dec1);
  const price = d.quoteSide === 0 ? 1 / raw : raw;
  const events = d.ticks.map((t) => ({ tick: t.tick, price: priceAt(t.tick), delta: Number(t.net) * scale * (d.quoteSide === 0 ? -1 : 1) })).sort((a, b) => a.price - b.price);
  const index = events.filter((e) => d.quoteSide === 1 ? e.tick <= d.tick : e.tick > d.tick).length;
  const c = { price, L: Number(d.liquidity) * scale, tick: d.tick, index, events, scale, priceAt, quoteSide: d.quoteSide,
    min: Math.min(priceAt(d.start), priceAt(d.end)), max: Math.max(priceAt(d.start), priceAt(d.end)), buyFee: d.buyFee, sellFee: d.sellFee };
  return [price, c.L, c.min, c.max, c.buyFee, c.sellFee].every(Number.isFinite) && price > 0 && c.L >= 0 && c.buyFee >= 0 && c.buyFee < 1 && c.sellFee >= 0 && c.sellFee < 1 ? c : null;
}
export function removeLiquidity(curve, positions = []) {
  if (!curve) return null;
  const c = { ...curve, events: curve.events.map((e) => ({ ...e })) };
  for (const p of positions) {
    const L = Number(p.liquidity) * c.scale;
    if (!(L >= 0) || !(p.lower < p.upper)) return null;
    if (p.lower <= c.tick && c.tick < p.upper) c.L -= L;
    for (const [tick, delta] of [[p.lower, -L], [p.upper, L]]) {
      const e = c.events.find((x) => x.tick === tick);
      if (e) e.delta += delta * (c.quoteSide === 0 ? -1 : 1);
      else if (c.priceAt(tick) > c.min && c.priceAt(tick) < c.max && L > 0) return null;
    }
  }
  if (c.L < -EPS) return null;
  c.L = Math.max(0, c.L);
  return c;
}
export function positionAmounts(curve, p) {
  if (!curve || !p) return null;
  const lo = Math.sqrt(Math.min(curve.priceAt(p.lower), curve.priceAt(p.upper))), hi = Math.sqrt(Math.max(curve.priceAt(p.lower), curve.priceAt(p.upper)));
  const s = Math.sqrt(curve.price), clamped = Math.max(lo, Math.min(hi, s)), L = Number(p.liquidity) * curve.scale;
  return { base: L * (1 / clamped - 1 / hi), quote: L * (clamped - lo) };
}
export function buyToPrice(curve, target) {
  if (!curve || !(target > 0)) return { error: 'unavailable' };
  if (target <= curve.price) return { quote: 0 };
  if (target > curve.max) return { error: 'depth_limit' };
  const c = { ...curve }; let quote = 0;
  while (c.price < target * (1 - 1e-12)) {
    if (!(c.L > 0)) return { error: 'liquidity_gap' };
    const e = c.events[c.index], next = Math.min(target, e?.price ?? c.max);
    quote += c.L * (Math.sqrt(next) - Math.sqrt(c.price)) / (1 - c.buyFee);
    c.price = next;
    if (e && next === e.price) { c.L += e.delta; c.index++; }
    else break;
  }
  return Number.isFinite(quote) ? { quote } : { error: 'unavailable' };
}
export function sellBase(curve, amount) {
  if (!curve || !Number.isFinite(amount) || amount < 0) return { error: 'unavailable' };
  const c = { ...curve }, start = c.price;
  if (amount === 0) return { quote: 0, lossPct: 0, price: c.price, curve: c };
  let remaining = amount * (1 - c.sellFee), quote = 0;
  for (let step = 0; step <= c.events.length + 1 && remaining > amount * 1e-12; step++) {
    if (!(c.L > 0)) return { error: 'liquidity_gap' };
    const e = c.events[c.index - 1], next = e?.price ?? c.min;
    if (next > c.price * (1 + 1e-9)) return { error: 'unavailable' };
    const s = Math.sqrt(c.price), bound = Math.sqrt(next), capacity = c.L * (1 / bound - 1 / s);
    if (remaining < capacity) {
      const end = 1 / (1 / s + remaining / c.L);
      quote += c.L * (s - end); c.price = end * end; remaining = 0;
      const rawTick = Math.log(c.price / c.priceAt(0)) / Math.log(1.0001) * (c.quoteSide === 0 ? -1 : 1);
      c.tick = Math.floor(rawTick);
      break;
    }
    quote += c.L * (s - bound); remaining -= Math.max(0, capacity); c.price = next;
    if (!e) { if (remaining > amount * 1e-12) return { error: 'depth_limit' }; break; }
    c.L -= e.delta; c.index--;
    c.tick = c.quoteSide === 1 ? e.tick - 1 : e.tick;
  }
  if (remaining > amount * 1e-12 || !Number.isFinite(quote)) return { error: 'depth_limit' };
  return { quote, lossPct: Math.max(0, (1 - quote / (amount * start)) * 100), price: c.price, curve: c };
}
export function exitScenarios(d, { ownId, targetOwner, salePct = 100, includeWallet = false, sellUsd = 100 } = {}) {
  const c = makeCurve(d);
  if (!c) return null;
  const own = d.positions.find((p) => p.kind === 'own' && String(p.id) === String(ownId));
  const ownKnown = ownId == null || !!own;
  const targets = d.positions.filter((p) => p.kind === 'target' && (!targetOwner || p.owner === targetOwner));
  const targetTokens = targets.reduce((sum, p) => sum + positionAmounts(c, p).base, 0);
  const wallets = (d.walletBalances || []).filter((w) => !targetOwner || w.owner === targetOwner);
  const totalTokens = targetTokens + (includeWallet ? wallets.reduce((s, w) => s + w.base, 0) : 0);
  const targetSold = totalTokens * Math.max(0, Math.min(100, salePct)) / 100;
  const exit = (state) => {
    if (!ownKnown) return { error: 'unavailable' };
    const amounts = own ? positionAmounts(state, own) : { base: sellUsd / (c.price * d.quoteUsd), quote: 0 };
    const result = sellBase(removeLiquidity(state, own ? [own] : []), amounts.base);
    return result.error ? result : { ...result, receivedUsd: (result.quote + amounts.quote) * d.quoteUsd };
  };
  const current = exit(c);
  const afterRemoval = targets.length && !d.missingPositions ? removeLiquidity(c, targets) : null;
  const lpFirst = afterRemoval ? exit(afterRemoval) : { error: 'target_unknown' };
  const sale = afterRemoval && (!includeWallet || !d.missingWallets) ? sellBase(afterRemoval, targetSold) : { error: 'target_unknown' };
  const sellFirst = sale.error ? sale : exit(sale.curve);
  const activeTarget = targets.filter((p) => p.lower <= d.tick && d.tick < p.upper).reduce((s, p) => s + Number(p.liquidity), 0);
  return { current, lpFirst, sellFirst, targetSold, targetTokens, targetSale: sale, own, targets,
    targetSharePct: Number(d.liquidity) > 0 ? activeTarget / Number(d.liquidity) * 100 : null };
}
