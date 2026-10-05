'use strict';
// The engine's single swap entry point (engine.kyber): picks among every enabled aggregator.
//
// Settings live at the config root, shared by all chains (Settings → Aggregators):
//   aggregators: {
//     mode: 'best' | 'order',            // default 'best'
//     order: ['kyber', 'okx', …],        // fallback order; also the tie-break in 'best'
//     <id>: { enabled, api_key, … },     // per aggregator; secrets may come from .env
//   }
//
// 'best'  — every enabled aggregator is quoted in parallel, the one paying the most output
//           executes; if it has no route at build time, breaks the loss limit or keeps
//           reverting, the next best is tried.
// 'order' — aggregators are tried one after another in the configured order.
//
// What never falls through to the next aggregator: a tx whose receipt is still unknown
// (e.pending — it may yet land), and a tx that landed but whose output did not reach us
// (e.txHash without e.reverted). Either way tokens may already have moved; a second swap
// could spend them twice. A safety guard failing on one aggregator (unknown router, odd
// minimum) only disqualifies that aggregator; if nobody succeeds, that error is reported.
const { Kyber } = require('./kyber');
const { Okx } = require('./aggregators/okx');
const { Lifi } = require('./aggregators/lifi');
const { ZeroX } = require('./aggregators/zerox');
const { OneInch } = require('./aggregators/oneinch');
const { OpenOcean } = require('./aggregators/openocean');

const DEFAULT_ORDER = ['kyber', 'okx', 'lifi', 'zerox', 'oneinch', 'openocean'];
const LABELS = { kyber: 'Kyber', okx: 'OKX', lifi: 'LI.FI', zerox: '0x', oneinch: '1inch', openocean: 'OpenOcean' };
// Display name of the aggregator a quote/swap result came from.
const aggLabel = (q) => LABELS[q?.aggregator] || 'Kyber';
const QUOTE_TIMEOUT_MS = 12_000;

// Kyber keeps its own class (decoded calldata); this gives it the same face as the others.
class KyberAdapter {
  constructor(kyber, cfg) { this.k = kyber; this.cfg = cfg; }
  get id() { return 'kyber'; }
  get label() { return 'Kyber'; }
  get needsKey() { return false; }
  settings() { return this.cfg.aggregators?.kyber || {}; }
  enabled() { return this.settings().enabled !== false && this.k.enabled(); }
  blocker() { return this.enabled() ? null : 'dimatikan'; }
  hasCredentials() { return true; }
  supportsChain() { return true; }
  async quote(a, b, x) { const q = await this.k.quote(a, b, x); return q ? { ...q, aggregator: 'kyber' } : null; }
  async swap(a, b, x, o) { return this.k.swap(a, b, x, o); }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

class SwapRouter {
  constructor({ exec, rpc, cfg, chain, log, adapters = null }) {
    this.cfg = cfg; this.log = log || (() => {});
    const opts = { exec, rpc, cfg, chain, log: this.log };
    this.adapters = adapters || [
      new KyberAdapter(new Kyber(opts), cfg),
      new Okx(opts), new Lifi(opts), new ZeroX(opts), new OneInch(opts), new OpenOcean(opts),
    ];
    this.byId = new Map(this.adapters.map((a) => [a.id, a]));
  }

  mode() { return this.cfg.aggregators?.mode === 'order' ? 'order' : 'best'; }
  order() {
    const want = (this.cfg.aggregators?.order || []).filter((id) => this.byId.has(id));
    return [...new Set([...want, ...DEFAULT_ORDER.filter((id) => this.byId.has(id)), ...this.byId.keys()])];
  }
  active() { return this.order().map((id) => this.byId.get(id)).filter((a) => a.enabled()); }
  enabled() { return this.active().length > 0; }

  async timedQuote(a, tokenIn, tokenOut, amountIn) {
    const t0 = Date.now();
    const q = await withTimeout(a.quote(tokenIn, tokenOut, amountIn).catch(() => null), QUOTE_TIMEOUT_MS);
    return { id: a.id, q, ms: Date.now() - t0 };
  }

  // Every enabled aggregator's quote, best first: [{ id, q, ms }]. Missing routes are left out.
  async quoteAll(tokenIn, tokenOut, amountIn) {
    const rank = new Map(this.order().map((id, i) => [id, i]));
    const res = await Promise.all(this.active().map((a) => this.timedQuote(a, tokenIn, tokenOut, amountIn)));
    return res.filter((r) => r.q && r.q.amountOut > 0n)
      .sort((x, y) => (y.q.amountOut > x.q.amountOut ? 1 : y.q.amountOut < x.q.amountOut ? -1 : rank.get(x.id) - rank.get(y.id)));
  }

  // Quote of one chosen aggregator (null when it is off or has no route).
  async quoteOne(id, tokenIn, tokenOut, amountIn) {
    const a = this.byId.get(id);
    if (!a || !a.enabled()) return null;
    return (await this.timedQuote(a, tokenIn, tokenOut, amountIn)).q;
  }

  // The Swap page's scan: one row per aggregator, in configured order, whether or not it can
  // quote. state: 'ok' (has a route), 'noroute', or 'off' (blocker says why).
  async scan(tokenIn, tokenOut, amountIn) {
    return Promise.all(this.order().map(async (id) => {
      const a = this.byId.get(id);
      if (!a.enabled()) return { id, label: a.label, state: 'off', blocker: a.blocker() || 'dimatikan', q: null, ms: null };
      const r = await this.timedQuote(a, tokenIn, tokenOut, amountIn);
      return { id, label: a.label, state: r.q && r.q.amountOut > 0n ? 'ok' : 'noroute', blocker: null, q: r.q, ms: r.ms };
    }));
  }

  async quote(tokenIn, tokenOut, amountIn) {
    if (this.mode() === 'best') return (await this.quoteAll(tokenIn, tokenOut, amountIn))[0]?.q || null;
    for (const a of this.active()) {
      const q = await a.quote(tokenIn, tokenOut, amountIn).catch(() => null);
      if (q) return q;
    }
    return null;
  }

  async quoteRetry(tokenIn, tokenOut, amountIn, tries = 3) {
    for (let i = 0; ; i++) {
      const q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q || i >= tries - 1) return q;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }

  // opts.only = an aggregator id: use exactly that one, no fallback to the others (the Swap
  // page lets the user pick a route; silently swapping elsewhere would defeat the choice).
  async swap(tokenIn, tokenOut, amountIn, opts = {}) {
    let candidates;
    if (opts.only) {
      const a = this.byId.get(opts.only);
      if (!a) throw new Error(`Agregator ${opts.only} tidak dikenal`);
      if (!a.enabled()) throw new Error(`Agregator ${a.label} tidak aktif (${a.blocker()})`);
      candidates = [a];
    } else if (this.mode() === 'best') {
      const ranked = await this.quoteAll(tokenIn, tokenOut, amountIn);
      candidates = ranked.map((r) => this.byId.get(r.id));
      if (ranked.length > 1) {
        const top = ranked.slice(0, 4).map((r) => `${this.byId.get(r.id).label} ${r.q.amountOut}`).join(' > ');
        this.log(`rute terbaik: ${top}`);
      }
      if (!candidates.length) return null;
    } else {
      candidates = this.active();
    }
    let firstErr = null;
    for (const a of candidates) {
      try {
        const r = await a.swap(tokenIn, tokenOut, amountIn, opts);
        if (r) return r;
        this.log(`${a.label}: tidak ada rute saat eksekusi — mencoba agregator berikutnya`);
      } catch (e) {
        // Tokens may have moved: stop here, never swap twice.
        if (e.pending || (e.txHash && !e.reverted)) throw e;
        if (!firstErr || (!firstErr.loss && e.loss)) firstErr = e;
        this.log(`${a.label}: ${e.message} — mencoba agregator berikutnya`);
      }
    }
    if (firstErr) throw firstErr;
    return null;
  }
}

module.exports = { SwapRouter, KyberAdapter, DEFAULT_ORDER, LABELS, aggLabel };
