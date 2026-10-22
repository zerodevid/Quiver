// Number formats that never fall back to scientific notation (6.98e-8, 7.535e+5). Shared by the
// dashboard (web/src/fmt.js), Telegram, the share/chart cards and engine messages.

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';

// A positive number below 0.0001 with its leading zeros counted in a subscript, as DexScreener
// does: 0.0000000698 -> 0.0₇698. `sep` is the decimal separator of the language in use.
export function tinyDecimal(p, { sig = 3, sep = '.' } = {}) {
  const [m, e] = p.toExponential(Math.max(0, sig - 1)).split('e');
  const zeros = -Number(e) - 1;
  const digits = m.replace('.', '').replace(/0+$/, '') || '0';
  return `0${sep}0${String(zeros).split('').map((d) => SUBSCRIPT[d]).join('')}${digits}`;
}

// 1.23B / 4.5T for figures too long to read in full; `locale` picks the separators.
export function compact(n, { locale = 'en-US', sig = 3 } = {}) {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumSignificantDigits: sig }).format(n);
}

// A token price (any size): subscript zeros below 0.0001, compact above a billion,
// significant digits in between.
export function tokenPrice(p, { locale = 'en-US', sig = 3 } = {}) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  const sep = locale === 'id-ID' ? ',' : '.';
  if (p >= 1e9) return compact(p, { locale });
  if (p >= 1e6) return p.toLocaleString(locale, { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(locale, { maximumSignificantDigits: Math.max(6, sig) });
  if (p >= 1e-4) return p.toLocaleString(locale, { maximumSignificantDigits: sig });
  return tinyDecimal(p, { sig, sep });
}

// A token amount for log lines and notices: 753.5K rather than 7.535e+5, 0.0₆12 rather than 1.2e-7.
export function tokenAmount(n, { sig = 4 } = {}) {
  if (n == null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a === 0) return '0';
  const sign = n < 0 ? '-' : '';
  if (a >= 1000) return sign + compact(a, { sig });
  if (a >= 1e-4) return sign + String(Number(a.toPrecision(sig)));
  return sign + tinyDecimal(a, { sig: Math.min(sig, 3) });
}

// A plain decimal for an input box (no grouping, no exponent): 6.98e-8 -> "0.0000000698".
export function plainDecimal(n, { sig = 6 } = {}) {
  if (n == null || !Number.isFinite(n)) return '';
  return n.toLocaleString('en-US', { maximumSignificantDigits: sig, useGrouping: false });
}
