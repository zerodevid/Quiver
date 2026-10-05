'use strict';
// OpenOcean Swap API v4. The public host sits behind a Cloudflare challenge that scripts
// cannot pass (seen from the VPS and from a home connection, 2026-10-01), so in practice it
// needs a key: open-api-pro.openocean.finance with header `apikey`. Amounts are sent raw
// (amountDecimals / gasPriceDecimals). The exchange proxy is the same on Robinhood and BSC
// (bytecode checked) and is also the approval spender.
const { ApiAggregator, isNative } = require('./base');

const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const ROUTER = '0x6352a56caadc4f1e25cd6c75970fa768a3304e64';
const tok = (t) => (isNative(t) ? NATIVE : t);

class OpenOcean extends ApiAggregator {
  static ROUTERS = { 4663: [ROUTER], 56: [ROUTER] };
  get id() { return 'openocean'; }
  get label() { return 'OpenOcean'; }
  get needsKey() { return true; }
  get gapMs() { return 300; }
  get simReturnsAmount() { return true; }
  spender() { return ROUTER; }
  host() { return this.apiKey() ? 'https://open-api-pro.openocean.finance' : 'https://open-api.openocean.finance'; }

  async gasPrice() {
    try { return BigInt(await this.rpc.call('eth_gasPrice', [])); } catch { return 1_000_000_000n; }
  }
  async get(endpoint, params) {
    const u = new URL(`${this.host()}/v4/${this.chain.CHAIN_ID}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, String(v));
    const r = await this.http(u.toString(), { headers: this.apiKey() ? { apikey: this.apiKey() } : {} });
    if (!r) return null;
    const d = r.j?.data;
    if (!r.ok || Number(r.j?.code) !== 200 || !d?.outAmount) {
      this.warn(`OpenOcean ${endpoint}: ${r.j?.error || r.j?.message || r.error || (r.j ? `kode ${r.j.code}` : `HTTP ${r.status} (Cloudflare?)`)}`);
      return null;
    }
    return d;
  }
  toQuote(d) {
    const names = [...new Set((d.dexes || []).filter((x) => Number(x.swapAmount) > 0).map((x) => x.dexCode).filter(Boolean))].slice(0, 3).join('+');
    return { amountOut: BigInt(d.outAmount), usdIn: null, usdOut: null, dex: names || null };
  }
  async quoteRaw(tokenIn, tokenOut, amountIn) {
    const d = await this.get('quote', { inTokenAddress: tok(tokenIn), outTokenAddress: tok(tokenOut), amountDecimals: amountIn.toString(), gasPriceDecimals: (await this.gasPrice()).toString() });
    return d ? this.toQuote(d) : null;
  }
  async buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const d = await this.get('swap', {
      inTokenAddress: tok(tokenIn), outTokenAddress: tok(tokenOut), amountDecimals: amountIn.toString(),
      gasPriceDecimals: (await this.gasPrice()).toString(), slippage: (slippageBps / 100).toFixed(2), account: me,
    });
    if (!d?.to || !d?.data) return null;
    return { quote: this.toQuote(d), fromAmount: d.inAmount ?? null, minOut: d.minOutAmount ?? null, tx: { to: d.to, from: d.from, data: d.data, value: d.value || '0' } };
  }
}

module.exports = { OpenOcean };
