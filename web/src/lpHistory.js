// "LP history" on the price charts: the bot's closed positions drawn over the candles as range
// bands with their PnL (AdvancedChart's `history` prop). Shared by the pool, token and Monitor
// charts: the on/off switch, the rows -> bands conversion, and the conversion of the pool's
// quote prices into the chart's unit at the rate of each position's own time.
import { useEffect, useMemo, useState } from 'react';
import { sqrtPrice, tickPrice, shortId } from './fmt';
import { canonAddr, chainInfo, isEthLike } from './chain';

// One switch for every chart, remembered per browser; charts open at the same time follow each other.
const KEY = 'lpcopy-chart-lp-history';
const EVENT = 'lpcopy-lp-history';
const read = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };
export function useLpHistoryToggle() {
  const [on, setOn] = useState(read);
  useEffect(() => {
    const sync = () => setOn(read());
    window.addEventListener(EVENT, sync);
    return () => window.removeEventListener(EVENT, sync);
  }, []);
  const set = (v) => {
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* storage blocked */ }
    setOn(v);
    window.dispatchEvent(new Event(EVENT));
  };
  return [on, set];
}

const fullRange = (p) => p.tick_lower <= -880000 && p.tick_upper >= 880000;

// Closed position rows -> history bands, prices in the pool's quote asset. `geo` (the pool's
// dec0 / dec1 / quoteSide) fills in for rows that do not carry them (/api/positions closed rows);
// `skip` is a position id drawn elsewhere; with `token`, only positions where it is the base.
export function lpHistoryOf(rows, { geo = null, skip = null, token = null } = {}) {
  const out = [];
  for (const p of rows || []) {
    if (p.status !== 'closed' || !p.closed_ts || p.id === skip || p.tick_lower == null || p.tick_upper == null || fullRange(p)) continue;
    const dec0 = p.dec0 ?? geo?.dec0, dec1 = p.dec1 ?? geo?.dec1, side = p.quoteSide ?? geo?.quoteSide;
    if (dec0 == null || dec1 == null || side == null) continue;
    if (token && canonAddr(side === 0 ? p.token1 : p.token0) !== canonAddr(token)) continue;
    const a = tickPrice(p.tick_lower, dec0, dec1, side), b = tickPrice(p.tick_upper, dec0, dec1, side);
    const es = p.entrySqrt ?? p.entry_sqrt, xs = p.exitSqrt ?? p.exit_sqrt;
    out.push({
      id: p.id, lo: Math.min(a, b), hi: Math.max(a, b), from: p.opened_ts || null, to: p.closed_ts,
      entry: es ? sqrtPrice(es, dec0, dec1, side) : null, exit: xs ? sqrtPrice(xs, dec0, dec1, side) : null,
      pnl: p.pnlUsd ?? null, pnlPct: p.pnlPct ?? null, fee: p.feeUsd ?? null, cost: p.costUsd ?? null,
      label: p.token_id ? `#${shortId(p.token_id)}` : `#${p.id}`,
      quote: p.quote_symbol || (side === 0 ? p.symbol0 : p.symbol1) || null,
      pair: token && p.symbol0 && p.symbol1 ? `${p.symbol0}/${p.symbol1}` : null,   // positions from several pools
    });
  }
  return out;
}

// USDG and ETH / WETH: their USD rate is known (1, or today's ETH price — it moves slowly next to
// the tokens charted), so a position quoted in them needs no per-moment estimate.
export const steadyQuote = (sym) => sym === chainInfo().usdgSymbol || isEthLike(sym);

// quote -> chart-unit rate at a moment. On candles in the pool's own quote, or on USD candles of a
// pool quoted in USDG / ETH, it is just `k` — `timeRates` false there. On USD candles of a pool
// quoted in some other token, today's rate puts the past off its candles: the rate then is the
// candle at that moment divided by the pool price at that moment. That is only an estimate (a
// candle spans minutes of a volatile token), hence the steady quotes first. Outside the candles,
// `k` (today's rate, or null = unknown).
export function rateFinder(candles, secs, k, timeRates) {
  return (ts, poolPrice) => {
    if (!timeRates || !(ts > 0) || !(poolPrice > 0) || !candles?.length) return k;
    let lo = 0, hi = candles.length - 1;
    if (ts < candles[0].t || ts >= candles[hi].t + secs * 1000) return k;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (candles[mid].t <= ts) lo = mid; else hi = mid - 1; }
    return candles[lo].c > 0 ? candles[lo].c / poolPrice : k;
  };
}

// History bands in the chart's unit: the range at the entry rate where it opened and at the exit
// rate where it closed (a slanted band when the quote moved), the entry / exit prices at their own rate.
// `rateAt(ts, poolPrice, item)`.
export function useChartHistory(history, rateAt) {
  return useMemo(() => (history ? history.map((h) => {
    const ke = rateAt(h.from, h.entry, h), kx = rateAt(h.to, h.exit, h);
    if (!ke || !kx) return null;
    return { ...h, lo: h.lo * ke, hi: h.hi * ke, loEnd: h.lo * kx, hiEnd: h.hi * kx,
      entry: h.entry != null ? h.entry * ke : null, exit: h.exit != null ? h.exit * kx : null };
  }).filter(Boolean) : null), [history, rateAt]);
}
