// Grafik realtime: lilin GeckoTerminal tertinggal hingga semenit, jadi harga pool
// dibaca langsung dari chain (/api/price, slot0) tiap beberapa detik dan dipakai
// menggerakkan lilin yang sedang berjalan — atau membuka lilin baru kalau
// intervalnya sudah lewat tapi GeckoTerminal belum mengirimnya.
import { useMemo, useRef } from 'react';
import { usePoll } from './hooks';
import { sqrtPrice } from './fmt';

export const LIVE_MS = 3000;

// Harga kini dalam aset kuotasi. null kalau dimatikan, belum terbaca, atau basi
// (poll gagal terus: harga lama tidak boleh tampil seolah-olah live).
export function useLivePrice(pool, { dec0, dec1, quoteSide }, enabled = true) {
  const ref = enabled && pool ? String(pool).toLowerCase() : null;
  const { data } = usePoll(ref ? `/api/price?pool=${ref}` : null, LIVE_MS);
  return useMemo(() => {
    if (!ref || !data || data.error || data.pool !== ref || Date.now() - data.ts > 30_000) return null;
    const price = sqrtPrice(data.sqrt, dec0, dec1, quoteSide);
    return price > 0 ? { price, ts: data.ts } : null;
  }, [ref, data, dec0, dec1, quoteSide]);
}

// candles: [{ t(ms), o, h, l, c, v }] urut naik; secs: panjang satu lilin.
// Tertinggi/terendah harga live di lilin berjalan diingat antar-poll, supaya
// lonjakan yang sempat terbaca tidak hilang saat harga balik lagi.
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
