'use strict';
// Multi-aggregator swap router for Solana. Every aggregator is asked for a quote in parallel;
// the one with the largest output wins, the others are kept as fallbacks. swapTx() builds the
// transaction with the aggregator that produced the quote and, when that fails, retries with
// the next best one.
//
// Settings (config root `aggregators`, edited in Settings → Swap aggregators):
//   mode: 'best' (default) — largest output wins | 'order' — first aggregator in `order` with a route
//   order: ['jupiter', 'raydium']    <id>: { enabled }  (false = never asked)
const { Jupiter } = require('./jupiter');
const { RaydiumSwap } = require('./swap-raydium');

const QUOTE_TIMEOUT_MS = 8_000;

const withTimeout = (p, ms) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms);
  p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
});

class SwapRouter {
  // aggregators: [{name, label, quote(), swapTx()}]. tokenAccount(mint, owner) -> address of
  // the owner's token account (needed by aggregators that cannot resolve it themselves).
  constructor({ jupiter, raydium = null, aggregators = null, tokenAccount = null, cfg = {}, log = console.log } = {}) {
    this.log = log; this.tokenAccount = tokenAccount; this.cfg = cfg;
    const jup = jupiter || new Jupiter({ log });
    if (!jup.name) { jup.name = 'jupiter'; jup.label = 'Jupiter'; }
    this.jupiter = jup;
    this.aggregators = aggregators || [jup, raydium || new RaydiumSwap({ log })];
    // The settings page's view of each aggregator (same face as the EVM router's adapters).
    this.byId = new Map(this.aggregators.map((a) => [a.name, {
      id: a.name, label: a.label, needsKey: false,
      enabled: () => this.isEnabled(a.name), blocker: () => (this.isEnabled(a.name) ? null : 'dimatikan'),
      supportsChain: () => true,
      quote: (i, o, x, opts) => a.quote(i, o, x, opts),
    }]));
  }

  setConfig(cfg) { this.cfg = cfg || {}; }
  isEnabled(id) { return this.cfg.aggregators?.[id]?.enabled !== false; }
  mode() { return this.cfg.aggregators?.mode === 'order' ? 'order' : 'best'; }
  // Configured order first (known ids only), then any aggregator it does not mention.
  order() {
    const ids = this.aggregators.map((a) => a.name);
    const set = Array.isArray(this.cfg.aggregators?.order) ? this.cfg.aggregators.order.filter((id) => ids.includes(id)) : [];
    return [...new Set([...set, ...ids])];
  }

  // Quotes from every aggregator. Returns routes best-first (ok routes by outAmount, then
  // failures) with timing, so the UI / logs can show the comparison.
  async quoteAll(inMint, outMint, amount, opts = {}) {
    const rank = new Map(this.order().map((id, i) => [id, i]));
    const active = this.aggregators.filter((a) => this.isEnabled(a.name));
    const routes = await Promise.all(active.map(async (a) => {
      const t0 = Date.now();
      try {
        const q = await withTimeout(a.quote(inMint, outMint, amount, opts), QUOTE_TIMEOUT_MS);
        if (!q?.outAmount) throw new Error('no route');
        q.aggregator = a.name;
        return { id: a.name, label: a.label, state: 'ok', ms: Date.now() - t0, q, out: BigInt(q.outAmount) };
      } catch (e) {
        return { id: a.name, label: a.label, state: 'error', ms: Date.now() - t0, error: e.message, q: null, out: 0n };
      }
    }));
    // ok routes first; among them 'best' ranks by output (configured order breaks ties),
    // 'order' ranks by the configured order alone.
    const byOrder = (x, y) => rank.get(x.id) - rank.get(y.id);
    const byOut = (x, y) => (x.out === y.out ? byOrder(x, y) : x.out > y.out ? -1 : 1);
    routes.sort((x, y) => (x.state === y.state ? (this.mode() === 'order' ? byOrder(x, y) : byOut(x, y)) : x.state === 'ok' ? -1 : 1));
    return routes;
  }

  // Top quote (by mode); throws when no aggregator has a route. The quote carries `aggregator` and
  // `alternatives` (the other ok quotes, best-first) for swapTx() fallback.
  async quote(inMint, outMint, amount, opts = {}) {
    const routes = await this.quoteAll(inMint, outMint, amount, opts);
    const ok = routes.filter((r) => r.state === 'ok');
    if (!routes.length) throw new Error('semua agregator swap dimatikan (Pengaturan → Agregator swap)');
    if (!ok.length) {
      throw new Error(`jupiter: tidak ada rute ${inMint.slice(0, 6)}→${outMint.slice(0, 6)} (${routes.map((r) => `${r.id}: ${r.error}`).join('; ')})`);
    }
    if (ok.length > 1) {
      const gap = Number(((ok[0].out - ok[1].out) * 10_000n) / (ok[0].out || 1n));
      this.log(`[swap-router] ${ok.map((r) => `${r.id} ${r.out}`).join(' | ')} → ${ok[0].id} (+${gap} bps)`);
    }
    return Object.assign(ok[0].q, { alternatives: ok.slice(1).map((r) => r.q), routes });
  }

  // Transaction for the quote; on failure falls back to the next best aggregator's quote.
  // Returns {tx, lastValidBlockHeight, quote} where quote is the one actually used.
  async swapTx(quote, owner, opts = {}) {
    const tried = [];
    for (const q of [quote, ...(quote.alternatives || [])]) {
      const a = this.aggregators.find((x) => x.name === q.aggregator);
      if (!a) continue;
      try {
        const inputAccount = a.name !== 'jupiter' && this.tokenAccount
          ? await this.tokenAccount(q.inputMint, owner) : null;
        const r = await a.swapTx(q, owner, { ...opts, inputAccount });
        return { ...r, quote: q };
      } catch (e) {
        tried.push(`${a.name}: ${e.message}`);
        this.log(`[swap-router] ${a.name} swapTx failed: ${e.message}`);
      }
    }
    throw new Error(`swap tx failed on every aggregator (${tried.join('; ')})`);
  }
}

module.exports = { SwapRouter };
