// Secondary currency: the same value as the dollar figure beside it, written small.
//
// Dollars stay the main figure — that is the unit of the engine, pool prices, and all
// PnL calculations, and swapping the two would make two identical pages read differently just
// because the rate moved. All that is added is a sense of scale for people who do not think
// in dollars: "$1,234.56  ≈ Rp22 m".
//
// The rate comes from the server via /api/overview (see src/fx.js) on each poll, the same
// as the chain identity — no network request from the browser is made here.
import { useEffect, useState } from 'react';
import { getLocale } from './i18n';
import { isHidden } from './privacy';

let current = null;          // { currency, rate, at, stale } or null = dollars only
const listeners = new Set();

export function setFx(next) {
  const v = next && next.rate > 0 ? { currency: next.currency, rate: next.rate, at: next.at || null, stale: !!next.stale } : null;
  // Polls every 5 seconds: only notify components if the number really changed.
  if (current?.currency === v?.currency && current?.rate === v?.rate) return;
  current = v;
  listeners.forEach((f) => f(current));
}
export const fxInfo = () => current;

// Components are redrawn when the rate or the currency changes.
export function useFx() {
  const [v, setV] = useState(current);
  useEffect(() => {
    const f = (x) => setV(x);
    listeners.add(f);
    f(current);
    return () => listeners.delete(f);
  }, []);
  return v;
}

// Dollar value -> secondary currency text, or null if there is nothing to write.
// Below half a cent there is nothing ("Rp0" just adds clutter), and amounts in
// the millions are shortened ("Rp22.4 m") because this is an annotation, not a receipt.
export function fxFormat(v, fx = current) {
  if (!fx || !(fx.rate > 0) || v == null || !Number.isFinite(v)) return null;
  if (Math.abs(v) < 0.005) return null;
  const n = v * fx.rate;
  const abs = Math.abs(n);
  const loc = getLocale() === 'en' ? 'en-US' : 'id-ID';
  // minimumFractionDigits must be set too: the "currency" style defaults to 2, and
  // Intl throws a RangeError if the minimum is greater than the maximum.
  const o = { style: 'currency', currency: fx.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 };
  if (abs >= 1e6) { o.notation = 'compact'; o.maximumFractionDigits = 1; }
  else if (abs < 100) { o.maximumFractionDigits = 2; }   // "big" currencies (EUR, GBP): $1.20 -> €1.03
  let s;
  try { s = new Intl.NumberFormat(loc, o).format(abs); }
  catch { return null; }   // currency code unknown to an old browser
  return (n < 0 ? '−' : '') + s;
}
// Uses the currency currently active on the dashboard.
// Value redaction (privacy.js): "≈ •••" adds nothing, so it is omitted.
// Only here, not in fxFormat — the example in Settings is not our money.
export const fxText = (v) => (isHidden() ? null : fxFormat(v, current));
