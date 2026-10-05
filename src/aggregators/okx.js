'use strict';
// OKX DEX aggregator (API v6). Needs a key, secret and passphrase (Developer Portal);
// every request is signed: base64(HMAC-SHA256(timestamp + METHOD + path?query, secret)).
// Free tier ≈ 1 request/second per key.
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { ApiAggregator, usdOf, isNative } = require('./base');

const API = 'https://web3.okx.com';
const NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const tok = (t) => (isNative(t) ? NATIVE : String(t).toLowerCase());

function sign({ secret, timestamp, method, path, body = '' }) {
  return crypto.createHmac('sha256', secret).update(timestamp + method + path + body).digest('base64');
}
const dexNames = (list) => [...new Set((list || []).map((x) => x?.dexProtocol?.dexName || x?.dexName).filter(Boolean))].join('+');
function toQuote(r) {
  if (!r || r.toTokenAmount == null) return null;
  return {
    amountOut: BigInt(r.toTokenAmount),
    usdIn: usdOf(r.fromTokenAmount, r.fromToken?.tokenUnitPrice, r.fromToken?.decimal),
    usdOut: usdOf(r.toTokenAmount, r.toToken?.tokenUnitPrice, r.toToken?.decimal),
    dex: dexNames(r.dexRouterList) || null,
    honeypot: !!r.toToken?.isHoneyPot,
  };
}

class Okx extends ApiAggregator {
  // web3.okx.com/onchainos/dev-docs/trade/dex-smart-contract; bytecode checked 2026-10-01,
  // approve contracts equal to what /approve-transaction returns.
  static ROUTERS = { 4663: ['0x6e2a35a7ad683cf634d91492d73bb7ff774c6919'], 56: ['0x5994814f2c4040b863a0125a45de152a8c2a4dec'] };
  static APPROVE = { 4663: '0x42170295f1173c9e5874ea9d00c6d137e1a4f53d', 56: '0x2c34a2fb1d0b4f55de51e1d0bdefaddce6b7cdd6' };
  get id() { return 'okx'; }
  get label() { return 'OKX'; }
  get needsKey() { return true; }
  get gapMs() { return 1100; }
  get simReturnsAmount() { return true; }

  creds() { const s = this.settings(); return { key: s.api_key || '', secret: s.secret_key || '', pass: s.passphrase || '', project: s.project_id || '' }; }
  apiKey() { return this.creds().key; }
  hasCredentials() { const c = this.creds(); return !!(c.key && c.secret && c.pass); }
  spender() { return this.settings().approve || Okx.APPROVE[this.chain.CHAIN_ID]; }

  async get(endpoint, params) {
    const c = this.creds();
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString();
    const path = `/api/v6/dex/aggregator/${endpoint}?${qs}`;
    const timestamp = new Date().toISOString();
    const r = await this.http(API + path, {
      headers: {
        'OK-ACCESS-KEY': c.key, 'OK-ACCESS-PASSPHRASE': c.pass, 'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-SIGN': sign({ secret: c.secret, timestamp, method: 'GET', path }),
        ...(c.project ? { 'OK-ACCESS-PROJECT': c.project } : {}),
      },
      rateLimited: (j) => String(j?.code) === '50011',
    });
    if (!r) return null;
    if (!r.ok || String(r.j?.code) !== '0' || !Array.isArray(r.j?.data) || !r.j.data.length) {
      this.warn(`OKX ${endpoint}: ${r.j?.msg || r.error || `HTTP ${r.status}`}${r.j?.code != null ? ` (${r.j.code})` : ''}`);
      return null;
    }
    return r.j.data;
  }

  async quoteRaw(tokenIn, tokenOut, amountIn) {
    const d = await this.get('quote', { chainIndex: String(this.chain.CHAIN_ID), amount: amountIn.toString(), fromTokenAddress: tok(tokenIn), toTokenAddress: tok(tokenOut), swapMode: 'exactIn' });
    return toQuote(d?.[0]?.routerResult || d?.[0]);
  }

  async buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me) {
    const d = await this.get('swap', {
      chainIndex: String(this.chain.CHAIN_ID), amount: amountIn.toString(), fromTokenAddress: tok(tokenIn), toTokenAddress: tok(tokenOut),
      slippagePercent: (slippageBps / 100).toFixed(2), userWalletAddress: me, swapReceiverAddress: me, swapMode: 'exactIn',
    });
    const res = d?.[0];
    if (!res?.tx || !res?.routerResult) return null;
    return {
      quote: toQuote(res.routerResult), fromAmount: res.routerResult.fromTokenAmount,
      minOut: res.tx.minReceiveAmount ?? null,
      tx: { to: res.tx.to, from: res.tx.from, data: res.tx.data, value: res.tx.value || '0' },
    };
  }
}

module.exports = { Okx, sign, toQuote, OKX_NATIVE: NATIVE, ethers };
