'use strict';
// 1inch Classic Swap API v6.0. Needs a key (business.1inch.com portal, Bearer auth).
// AggregationRouterV6 has the same address on every chain and is also the approval spender
// (bytecode checked on Robinhood and BSC 2026-10-01). The API gives no minimum output, so
// the router's returned amount from the eth_call dry run is the check (simReturnsAmount).
const { ApiAggregator, isNative } = require('./base');

const API = 'https://api.1inch.dev/swap/v6.0';
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ROUTER = '0x111111125421ca6dc452d289314280a0f8842a65';
const tok = (t) => (isNative(t) ? NATIVE : t);
const protoNames = (p) => [...new Set((p || []).flat(3).map((x) => x?.name).filter(Boolean))].join('+');

class OneInch extends ApiAggregator {
  static ROUTERS = { 4663: [ROUTER], 56: [ROUTER] };
  get id() { return 'oneinch'; }
  get label() { return '1inch'; }
  get needsKey() { return true; }
  get gapMs() { return 1100; }
  get simReturnsAmount() { return true; }
  spender() { return ROUTER; }

  async get(endpoint, params) {
    const u = new URL(`${API}/${this.chain.CHAIN_ID}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    const r = await this.http(u.toString(), { headers: { Authorization: `Bearer ${this.apiKey()}` } });
    if (!r) return null;
    if (!r.ok || r.j?.dstAmount == null) {
      if (r.status !== 400) this.warn(`1inch ${endpoint}: ${r.j?.description || r.j?.error || r.error || `HTTP ${r.status}`}`);
      return null;
    }
    return r.j;
  }
  toQuote(j) {
    return { amountOut: BigInt(j.dstAmount), usdIn: null, usdOut: null, dex: protoNames(j.protocols) || null };
  }
  async quoteRaw(tokenIn, tokenOut, amountIn) {
    const j = await this.get('quote', { src: tok(tokenIn), dst: tok(tokenOut), amount: amountIn.toString(), includeProtocols: 'true' });
    return j ? this.toQuote(j) : null;
  }
  async buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const j = await this.get('swap', {
      src: tok(tokenIn), dst: tok(tokenOut), amount: amountIn.toString(), from: me, origin: me, receiver: me,
      slippage: (slippageBps / 100).toFixed(2), disableEstimate: 'true', includeProtocols: 'true',
    });
    if (!j?.tx) return null;
    return { quote: this.toQuote(j), fromAmount: null, minOut: null, tx: { to: j.tx.to, from: j.tx.from, data: j.tx.data, value: j.tx.value || '0' } };
  }
}

module.exports = { OneInch };
