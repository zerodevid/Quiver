'use strict';
// 0x Swap API v2, AllowanceHolder flow. Needs a key (dashboard.0x.org, header 0x-api-key).
// The tx goes to AllowanceHolder, which is also the approval spender; the same address on
// every Cancun chain (bytecode checked on Robinhood and BSC 2026-10-01).
const { ApiAggregator, isNative } = require('./base');

const API = 'https://api.0x.org/swap/allowance-holder';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ALLOWANCE_HOLDER = '0x0000000000001ff3684f28c67538d4d072c22734';
const tok = (t) => (isNative(t) ? NATIVE : t);

class ZeroX extends ApiAggregator {
  static ROUTERS = { 4663: [ALLOWANCE_HOLDER], 56: [ALLOWANCE_HOLDER] };
  get id() { return 'zerox'; }
  get label() { return '0x'; }
  get needsKey() { return true; }
  get gapMs() { return 500; }
  // AllowanceHolder.exec returns the Settler's bytes, not an amount; 0x always gives minBuyAmount.
  get simReturnsAmount() { return false; }
  spender(b) {
    const s = String(b?.spender || ALLOWANCE_HOLDER).toLowerCase();
    if (!this.routers().has(s)) { const e = new Error(`0x minta izin ke ${s}, bukan AllowanceHolder`); e.guard = true; throw e; }
    return s;
  }

  async get(endpoint, tokenIn, tokenOut, amountIn, extra = {}) {
    const u = new URL(`${API}/${endpoint}`);
    const p = { chainId: this.chain.CHAIN_ID, sellToken: tok(tokenIn), buyToken: tok(tokenOut), sellAmount: amountIn.toString(), ...extra };
    for (const [k, v] of Object.entries(p)) if (v != null) u.searchParams.set(k, String(v));
    const r = await this.http(u.toString(), { headers: { '0x-api-key': this.apiKey(), '0x-version': 'v2' } });
    if (!r) return null;
    if (!r.ok || r.j?.liquidityAvailable === false || r.j?.buyAmount == null) {
      if (r.j?.liquidityAvailable !== false) this.warn(`0x ${endpoint}: ${r.j?.message || r.j?.name || r.error || `HTTP ${r.status}`}`);
      return null;
    }
    return r.j;
  }
  toQuote(j) {
    const srcs = [...new Set((j.route?.fills || []).map((f) => f.source).filter(Boolean))].join('+');
    return { amountOut: BigInt(j.buyAmount), usdIn: null, usdOut: null, dex: srcs || null };
  }
  async quoteRaw(tokenIn, tokenOut, amountIn) {
    const j = await this.get('price', tokenIn, tokenOut, amountIn, { taker: this.exec?.address?.() || undefined });
    return j ? this.toQuote(j) : null;
  }
  async buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const j = await this.get('quote', tokenIn, tokenOut, amountIn, { taker: me, slippageBps });
    if (!j?.transaction) return null;
    return {
      quote: this.toQuote(j), fromAmount: j.sellAmount, minOut: j.minBuyAmount ?? null,
      spender: j.issues?.allowance?.spender || j.allowanceTarget || null,
      tx: { to: j.transaction.to, data: j.transaction.data, value: j.transaction.value || '0' },
    };
  }
}

module.exports = { ZeroX };
