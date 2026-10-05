'use strict';
// Secondary currency for the dashboard: USD -> chosen currency rate (Settings → Display).
//
// The headline numbers on the dashboard stay in dollars — that is the unit the engine, pool
// prices and every PnL calculation use. The rate here only feeds a small annotation next to
// them ("≈ Rp20.3 m"), so the amount has a sense of scale for people who do not think
// in dollars. Because it is only an annotation, nothing depends on it:
// if the rate cannot be fetched, the dashboard keeps working and the annotation disappears.
//
// Two sources, free and keyless: open.er-api.com (daily updates, all
// currencies) with api.frankfurter.app as a fallback (ECB reference rates). The response is
// stored in the state table, so a bot restart does not mean a refetch — and if
// neither source can be reached, the last known rate is still used (flagged stale).

// What the picker offers. A deliberately short list: currencies likely to be
// used by whoever runs this bot, not all 160 codes the API returns.
const CURRENCIES = {
  IDR: 'Rupiah Indonesia', MYR: 'Ringgit Malaysia', SGD: 'Dolar Singapura', THB: 'Baht Thailand',
  VND: 'Dong Vietnam', PHP: 'Peso Filipina', INR: 'Rupee India', CNY: 'Yuan Tiongkok',
  JPY: 'Yen Jepang', KRW: 'Won Korea', HKD: 'Dolar Hong Kong', TWD: 'Dolar Taiwan',
  AUD: 'Dolar Australia', NZD: 'Dolar Selandia Baru', CAD: 'Dolar Kanada',
  EUR: 'Euro', GBP: 'Pound Sterling', CHF: 'Franc Swiss', SEK: 'Krona Swedia',
  TRY: 'Lira Turki', RUB: 'Rubel Rusia', UAH: 'Hryvnia Ukraina', PLN: 'Zloty Polandia',
  BRL: 'Real Brasil', MXN: 'Peso Meksiko', ARS: 'Peso Argentina',
  AED: 'Dirham UEA', SAR: 'Riyal Saudi', ZAR: 'Rand Afrika Selatan', NGN: 'Naira Nigeria',
};

// English names for the same list — used by the setup page, which defaults to
// English. The ISO code remains the reference; this is only a label next to it.
const CURRENCIES_EN = {
  IDR: 'Indonesian rupiah', MYR: 'Malaysian ringgit', SGD: 'Singapore dollar', THB: 'Thai baht',
  VND: 'Vietnamese dong', PHP: 'Philippine peso', INR: 'Indian rupee', CNY: 'Chinese yuan',
  JPY: 'Japanese yen', KRW: 'South Korean won', HKD: 'Hong Kong dollar', TWD: 'Taiwan dollar',
  AUD: 'Australian dollar', NZD: 'New Zealand dollar', CAD: 'Canadian dollar',
  EUR: 'Euro', GBP: 'Pound sterling', CHF: 'Swiss franc', SEK: 'Swedish krona',
  TRY: 'Turkish lira', RUB: 'Russian ruble', UAH: 'Ukrainian hryvnia', PLN: 'Polish zloty',
  BRL: 'Brazilian real', MXN: 'Mexican peso', ARS: 'Argentine peso',
  AED: 'UAE dirham', SAR: 'Saudi riyal', ZAR: 'South African rand', NGN: 'Nigerian naira',
};

const SOURCES = [
  ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', (j) => (j && j.result === 'success' ? j.rates : null)],
  ['frankfurter.app', 'https://api.frankfurter.app/latest?base=USD', (j) => (j && j.rates) || null],
];

class Fx {
  // ttlMs: currency rates move slowly (the source itself updates daily), so six hours
  // is already far more frequent than the data changes.
  constructor({ store = null, log = null, fetch: fetchImpl = null, ttlMs = 6 * 3600_000 } = {}) {
    this.store = store;
    this.log = log || (() => {});
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.ttlMs = ttlMs;
    this.rates = null;
    this.at = 0;
    this.source = null;
    this.error = null;
    this.pending = null;
    try {
      const raw = store && store.getState('fx_rates');
      const j = raw ? JSON.parse(raw) : null;
      if (j && j.rates && j.rates.EUR) { this.rates = j.rates; this.at = j.at || 0; this.source = j.source || null; }
    } catch { /* state rusak: tarik ulang saja */ }
  }

  fresh() { return !!this.rates && Date.now() - this.at < this.ttlMs; }

  // The rate for one currency, for the dashboard. Called from /api/overview, which is polled every
  // 5 seconds, so it does NOT wait on the network: if the rate is stale, a refresh runs
  // in the background and the current response uses the old value (or empty if there never was one).
  view(code) {
    const c = String(code || '').toUpperCase();
    if (!CURRENCIES[c]) return null;
    if (!this.fresh()) this.refresh().catch(() => {});
    const rate = this.rates ? this.rates[c] : null;
    const stale = !this.fresh();
    return {
      currency: c, name: CURRENCIES[c],
      rate: rate || null, at: this.at || null, source: this.source,
      stale: !!rate && stale,
      error: rate && !stale ? null : this.error,
    };
  }

  // force: from the "Refresh rate" button in Settings — ignore the cache age.
  refresh(force = false) {
    if (!force && this.fresh()) return Promise.resolve(true);
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    const errs = [];
    for (const [name, url, pick] of SOURCES) {
      try {
        const r = await this.fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const rates = pick(await r.json());
        // EUR exists in every sane rate source — a marker that what was read really is
        // a rate table, not an error page that happens to be JSON.
        if (!rates || !rates.EUR) throw new Error('jawaban tanpa kurs');
        this.rates = rates; this.at = Date.now(); this.source = name; this.error = null;
        try { if (this.store) this.store.setState('fx_rates', JSON.stringify({ at: this.at, source: name, rates })); } catch { /* biarkan */ }
        return true;
      } catch (e) { errs.push(`${name}: ${e.message}`); }
    }
    this.error = errs.join(' · ');
    this.log(`kurs mata uang gagal diambil (${this.error})`);
    return false;
  }
}

// A dollar value written in the secondary currency, or null if there is nothing to
// write. The rules are exactly the same as the dashboard's (web/src/currency.js): below
// half a cent there is nothing to show, amounts in the millions are shortened ("Rp22.4 m") because
// this is an annotation and not a receipt, and "big" currencies (EUR, GBP) keep two
// decimals so $1.20 does not become "€1".
function fxFormat(v, fx, lang = 'id') {
  if (!fx || !(fx.rate > 0) || v == null || !Number.isFinite(Number(v))) return null;
  if (Math.abs(v) < 0.005) return null;
  const n = v * fx.rate;
  const abs = Math.abs(n);
  // minimumFractionDigits must be set too: the "currency" style defaults to 2, and
  // Intl throws a RangeError if the minimum is greater than the maximum.
  const o = { style: 'currency', currency: fx.currency, minimumFractionDigits: 0, maximumFractionDigits: 0 };
  if (abs >= 1e6) { o.notation = 'compact'; o.maximumFractionDigits = 1; }
  else if (abs < 100) { o.maximumFractionDigits = 2; }
  let s;
  try { s = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'id-ID', o).format(abs); }
  catch { return null; }   // unknown currency code
  return (n < 0 ? '\u2212' : '') + s;
}

// The currency the dashboard uses. Never configured (old config, fresh install)
// = Rupiah: this bot is used from Indonesia, and a small annotation that is there right away is
// more useful than a feature that has to be discovered first. Switched off in Settings
// it is stored as null, and null is NOT read as "never configured".
const currencyOf = (cfg) => (cfg?.display && 'currency' in cfg.display ? cfg.display.currency || '' : 'IDR');

module.exports = { Fx, CURRENCIES, CURRENCIES_EN, currencyOf, fxFormat };
