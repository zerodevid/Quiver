'use strict';
// Shared cache for LIVE RPC reads (answers that are only valid for a moment).
//
// rpccache.js stores answers that can never change again (past blocks). This module
// covers the opposite: reads at `latest` that every tenant sharing one RPC pool repeats at
// the same time — the chain head, the gas price, the state of a pool several accounts
// hold a position in. Two mechanisms, both bounded in time:
//   1. single-flight: while one identical call is in flight, others wait for its answer
//      instead of sending their own;
//   2. a short TTL: the answer is reused for a fraction of a second after it lands.
//
// What may enter is an allow-list. Anything wallet-specific or decision-critical right
// after a write (nonce, balance, allowance, simulations with `from`) never does.
// eth_call at `latest` is OPT-IN per call (`share: true`): an allowance read right after an
// approve must never be served from a moment before it.
const { keyOf } = require('./rpccache');

const DEFAULT_TTL_MS = {
  eth_blockNumber: 400,
  eth_gasPrice: 2000,
  eth_maxPriorityFeePerGas: 2000,
  eth_getBlockByNumber: 400,   // only the 'latest' tag
  eth_call: 1000,              // only with share:true, tag 'latest', no from/value
};

// null = this call is never shared.
function livePlan(call) {
  const { method, params } = call;
  if (call.nocache || call.fresh) return null;
  switch (method) {
    case 'eth_blockNumber':
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return { method, key: keyOf(method, params) };
    case 'eth_getBlockByNumber':
      return params?.[0] === 'latest' ? { method, key: keyOf(method, params) } : null;
    case 'eth_call': {
      if (!call.share) return null;
      const tx = params?.[0];
      if (!tx || tx.from || (tx.value && BigInt(tx.value) > 0n)) return null;
      if (params?.[1] !== 'latest') return null;
      return { method, key: keyOf(method, params) };
    }
    default: return null;
  }
}

const copy = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

class LiveCache {
  constructor({ enabled = true, ttl_ms = {}, max_entries = 2000 } = {}) {
    this.enabled = enabled !== false;
    this.ttl = { ...DEFAULT_TTL_MS, ...ttl_ms };
    this.max = Math.max(1, max_entries);
    this.fresh = new Map();     // key -> { item, until }
    this.flying = new Map();    // key -> Promise<item>
    this.hits = 0; this.joined = 0; this.sent = 0;
    this.by = {};
  }

  plan(call) { return this.enabled ? livePlan(call) : null; }

  tally(method, field) {
    const b = this.by[method] || (this.by[method] = { hit: 0, joined: 0, sent: 0 });
    b[field]++;
  }

  // A stored answer still inside its TTL, or undefined.
  peek(plan) {
    const e = this.fresh.get(plan.key);
    if (!e) return undefined;
    if (e.until < Date.now()) { this.fresh.delete(plan.key); return undefined; }
    this.hits++; this.tally(plan.method, 'hit');
    return { result: copy(e.result) };
  }

  store(plan, result) {
    const ttl = this.ttl[plan.method];
    if (!ttl || ttl <= 0) return;
    this.fresh.set(plan.key, { result: copy(result), until: Date.now() + ttl });
    if (this.fresh.size > this.max) {
      const now = Date.now();
      for (const [k, e] of this.fresh) if (e.until < now) this.fresh.delete(k);
      while (this.fresh.size > this.max) this.fresh.delete(this.fresh.keys().next().value);
    }
  }

  stats() {
    const asked = this.hits + this.joined + this.sent;
    return {
      enabled: this.enabled, hits: this.hits, joined: this.joined, sent: this.sent, by: this.by,
      savedPct: asked ? Math.round(((this.hits + this.joined) / asked) * 100) : 0,
    };
  }
}

module.exports = { LiveCache, livePlan, DEFAULT_TTL_MS };
