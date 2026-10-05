'use strict';
// LI.FI (li.quest). Works without a key (tight rate limit); a free key from portal.li.fi
// raises it (header x-lifi-api-key). Same-chain swaps route through LI.FI's own Diamond,
// whose address per chain comes from GET /v1/chains (checked on chain 2026-10-01).
// LI.FI itself routes through other aggregators and DEXes.
const { ApiAggregator, usdOf } = require('./base');

const API = 'https://li.quest/v1';

class Lifi extends ApiAggregator {
  static ROUTERS = { 4663: ['0xb477751b76cf82d00a686a1232f5fcd772414af3'], 56: ['0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae'] };
  get id() { return 'lifi'; }
  get label() { return 'LI.FI'; }
  get needsKey() { return false; }
  get gapMs() { return this.apiKey() ? 400 : 1500; }
  // Diamond facets do not return the output amount; LI.FI always gives toAmountMin.
  get simReturnsAmount() { return false; }
  spender(b) { return b?.approval || [...this.routers()][0]; }

  async get(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const u = new URL(`${API}/quote`);
    const p = {
      fromChain: this.chain.CHAIN_ID, toChain: this.chain.CHAIN_ID, fromToken: tokenIn, toToken: tokenOut,
      fromAmount: amountIn.toString(), fromAddress: me || '0x000000000000000000000000000000000000dEaD',
      slippage: (slippageBps / 10_000).toFixed(4), order: 'CHEAPEST',
    };
    for (const [k, v] of Object.entries(p)) u.searchParams.set(k, String(v));
    const r = await this.http(u.toString(), { headers: this.apiKey() ? { 'x-lifi-api-key': this.apiKey() } : {} });
    if (!r) return null;
    if (!r.ok || !r.j?.estimate || !r.j?.transactionRequest) {
      if (r.status !== 404) this.warn(`LI.FI quote: ${r.j?.message || r.error || `HTTP ${r.status}`}`);
      return null;
    }
    return r.j;
  }
  toQuote(j) {
    const e = j.estimate;
    return {
      amountOut: BigInt(e.toAmount),
      usdIn: Number(e.fromAmountUSD) || usdOf(e.fromAmount, j.action?.fromToken?.priceUSD, j.action?.fromToken?.decimals),
      usdOut: Number(e.toAmountUSD) || usdOf(e.toAmount, j.action?.toToken?.priceUSD, j.action?.toToken?.decimals),
      dex: j.toolDetails?.name || j.tool || null,
    };
  }
  async quoteRaw(tokenIn, tokenOut, amountIn) {
    const j = await this.get(tokenIn, tokenOut, amountIn, 100, this.exec?.address?.());
    return j ? this.toQuote(j) : null;
  }
  async buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const j = await this.get(tokenIn, tokenOut, amountIn, slippageBps, me);
    if (!j) return null;
    const approval = String(j.estimate.approvalAddress || '').toLowerCase();
    // The approval target must be the same whitelisted Diamond — never an address we only saw in a reply.
    if (approval && !this.routers().has(approval)) {
      const e = new Error(`LI.FI minta izin ke ${approval}, bukan Diamond yang dikenal`); e.guard = true; throw e;
    }
    const t = j.transactionRequest;
    return {
      quote: this.toQuote(j), fromAmount: j.estimate.fromAmount ?? j.action?.fromAmount, minOut: j.estimate.toAmountMin ?? null,
      approval: approval || null,
      tx: { to: t.to, from: t.from, data: t.data, value: t.value ? BigInt(t.value).toString() : '0' },
    };
  }
}

module.exports = { Lifi };
