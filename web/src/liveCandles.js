// Realtime chart: GeckoTerminal candles lag by up to a minute, so the pool price
// is read straight from the chain (/api/price, slot0) every few seconds and used to
// move the running candle — or to open a new candle when the
// interval has passed but GeckoTerminal has not sent it yet.
import { useMemo, useRef } from 'react';
import { usePoll } from './hooks';
import { sqrtPrice } from './fmt';
import { canonAddr } from './chain';

export const LIVE_MS = 3000;

// Current price in the quote asset. null when disabled, not yet read, or stale
// (polls keep failing: an old price must not be shown as if it were live).
export function useLivePrice(pool, { dec0, dec1, quoteSide }, enabled = true) {
  const ref = enabled && pool ? canonAddr(pool) : null;
  const { data } = usePoll(ref ? `/api/price?pool=${ref}` : null, LIVE_MS);
  return useMemo(() => {
    if (!ref || !data || data.error || data.pool !== ref || Date.now() - data.ts > 30_000) return null;
    const price = sqrtPrice(data.sqrt, dec0, dec1, quoteSide);
    return price > 0 ? { price, ts: data.ts } : null;
  }, [ref, data, dec0, dec1, quoteSide]);
}

// candles: [{ t(ms), o, h, l, c, v }] ascending; secs: length of one candle.
// The live high/low on the running candle are remembered between polls, so
// a spike that was briefly seen is not lost when the price comes back.
export function useLiveCandles(candles, secs, live, key) {
  const ext = useRef(null);
  return useMemo(() => {
    const last = candles[candles.length - 1];
    if (!(live?.price > 0) || !last || !secs) return candles;
    const t = Math.floor(live.ts / 1000 / secs) * secs * 1000;
    if (t < last.t) return candles;
    const e0 = ext.current;
    const e = e0 && e0.t === t && e0.key === key
      ? { t, key, h: Math.max(e0.h, live.price), l: Math.min(e0.l, live.price) }
      : { t, key, h: live.price, l: live.price };
    ext.current = e;
    if (t === last.t) {
      return [...candles.slice(0, -1), { ...last, h: Math.max(last.h, e.h), l: Math.min(last.l, e.l), c: live.price }];
    }
    return [...candles, { t, o: last.c, h: Math.max(last.c, e.h), l: Math.min(last.c, e.l), c: live.price, v: 0 }];
  }, [candles, secs, live, key]);
}
