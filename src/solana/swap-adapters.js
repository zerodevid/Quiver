'use strict';
// HTTP swap aggregators for Solana besides Jupiter and Raydium: LI.FI (key optional),
// OKX DEX, OpenOcean and DFlow (key required: inactive until it is entered in Settings).
// Every adapter has the router's shape: name, label, needsKey, hasCredentials(),
// quote(inMint, outMint, amount, {slippageBps}) and swapTx(quote, owner, opts).
//
// A quote is {inputMint, outputMint, inAmount, outAmount, slippageBps, routePlan, priceImpactPct, raw}.
// swapTx() asks again with the real wallet address where the API needs it, and refuses an
// answer that moves the output far below the quote (the market moved or the API is wrong).
const crypto = require('node:crypto');
const { VersionedTransaction } = require('@solana/web3.js');

const WSOL = 'So11111111111111111111111111111111111111112';
const SYSTEM = '11111111111111111111111111111111';   // OKX's address for native SOL
const DUMMY_OWNER = SYSTEM;                          // any valid address works for a quote
const MAX_DRIFT_BPS = 100;                           // a rebuilt route may pay at most 1% less than quoted

const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
// APIs disagree on how they encode a serialized transaction: accept base58 and base64.
function decodeTx(s) {
  const str = String(s || '').trim();
  const tries = B58.test(str) ? ['base58', 'base64'] : ['base64'];
  for (const enc of tries) {
    try {
      const raw = enc === 'base58' ? require('bs58').default.decode(str) : Buffer.from(str, 'base64');
      return VersionedTransaction.deserialize(raw);
    } catch { /* try the next encoding */ }
  }
  throw new Error('unreadable transaction');
}

class HttpAggregator {
  // settings(): this aggregator's config block (api_key, ...). gapMs: minimum spacing of requests.
  constructor({ settings = () => ({}), fetchImpl = globalThis.fetch, log = console.log, gapMs = 0 } = {}) {
    this.settings = settings; this.fetch = fetchImpl; this.log = log; this.gapMs = gapMs; this.last = 0;
  }
  apiKey() { return String(this.settings().api_key || ''); }
  hasCredentials() { return !this.needsKey || !!this.apiKey(); }

  async http(url, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
    const wait = this.last + this.gapMs - Date.now();
    this.last = Date.now() + Math.max(0, wait);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetch(url, {
        method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not JSON (Cloudflare page) */ }
      return { ok: r.ok, status: r.status, j, text };
    } finally { clearTimeout(t); }
  }
  fail(r, what) {
    const why = r.j?.message || r.j?.msg || r.j?.error || r.text || `HTTP ${r.status}`;
    return new Error(`${this.name} ${what}: ${String(why).slice(0, 160)}`);
  }
  mkQuote(inMint, outMint, amount, slippageBps, outAmount, extra = {}) {
    if (!outAmount || BigInt(outAmount) <= 0n) throw new Error(`${this.name}: no route`);
    return { inputMint: inMint, outputMint: outMint, inAmount: String(amount), outAmount: String(outAmount), slippageBps,
      priceImpactPct: '0', routePlan: [{ swapInfo: { label: this.label }, percent: 100 }], ...extra };
  }
  // The rebuilt route may not pay materially less than what was quoted.
  guardDrift(quote, outAmount) {
    const was = BigInt(quote.outAmount), now = BigInt(outAmount);
    if (now * 10_000n < was * BigInt(10_000 - MAX_DRIFT_BPS)) throw new Error(`${this.name}: price moved (${was} → ${now})`);
  }
}

// ---- LI.FI ----------------------------------------------------------------------------
class LifiSwap extends HttpAggregator {
  get name() { return 'lifi'; } get label() { return 'LI.FI'; } get needsKey() { return false; }
  async get(inMint, outMint, amount, slippageBps, owner) {
    const q = new URLSearchParams({
      fromChain: 'SOL', toChain: 'SOL', fromToken: inMint, toToken: outMint, fromAmount: String(amount),
      fromAddress: owner, slippage: (slippageBps / 10_000).toFixed(4), integrator: 'quiver', fee: '0',
    });
    const r = await this.http(`https://li.quest/v1/quote?${q}`, { headers: this.apiKey() ? { 'x-lifi-api-key': this.apiKey() } : {} });
    if (!r.ok || !r.j?.estimate) throw this.fail(r, 'quote');
    return r.j;
  }
  async quote(inMint, outMint, amount, { slippageBps = 100 } = {}) {
    const j = await this.get(inMint, outMint, amount, slippageBps, DUMMY_OWNER);
    return this.mkQuote(inMint, outMint, amount, slippageBps, j.estimate.toAmount,
      { routePlan: [{ swapInfo: { label: `LI.FI · ${j.toolDetails?.name || j.tool || '?'}` }, percent: 100 }] });
  }
  async swapTx(quote, owner) {
    const j = await this.get(quote.inputMint, quote.outputMint, quote.inAmount, quote.slippageBps, owner);
    this.guardDrift(quote, j.estimate.toAmount);
    if (!j.transactionRequest?.data) throw new Error('lifi: no transaction');
    return { tx: decodeTx(j.transactionRequest.data), lastValidBlockHeight: null };
  }
}

// ---- OKX DEX (v6; HMAC-signed requests) -------------------------------------------------
class OkxSwap extends HttpAggregator {
  get name() { return 'okx'; } get label() { return 'OKX'; } get needsKey() { return true; }
  creds() { const s = this.settings(); return { key: s.api_key || '', secret: s.secret_key || '', pass: s.passphrase || '', project: s.project_id || '' }; }
  hasCredentials() { const c = this.creds(); return !!(c.key && c.secret && c.pass); }
  async get(endpoint, params) {
    const c = this.creds();
    const qs = new URLSearchParams(params).toString();
    const path = `/api/v6/dex/aggregator/${endpoint}?${qs}`;
    const ts = new Date().toISOString();
    const sign = crypto.createHmac('sha256', c.secret).update(ts + 'GET' + path).digest('base64');
    const r = await this.http(`https://web3.okx.com${path}`, { headers: {
      'OK-ACCESS-KEY': c.key, 'OK-ACCESS-PASSPHRASE': c.pass, 'OK-ACCESS-TIMESTAMP': ts, 'OK-ACCESS-SIGN': sign,
      ...(c.project ? { 'OK-ACCESS-PROJECT': c.project } : {}),
    } });
    if (!r.ok || String(r.j?.code) !== '0' || !r.j?.data?.[0]) throw this.fail(r, endpoint);
    return r.j.data[0];
  }
  tok(m) { return m === WSOL ? SYSTEM : m; }
  base(inMint, outMint, amount) {
    return { chainIndex: '501', amount: String(amount), fromTokenAddress: this.tok(inMint), toTokenAddress: this.tok(outMint), swapMode: 'exactIn' };
  }
  async quote(inMint, outMint, amount, { slippageBps = 100 } = {}) {
    const d = await this.get('quote', this.base(inMint, outMint, amount));
    const r = d.routerResult || d;
    const dex = [...new Set((r.dexRouterList || []).map((x) => x?.dexProtocol?.dexName || x?.dexName).filter(Boolean))].join(' → ');
    return this.mkQuote(inMint, outMint, amount, slippageBps, r.toTokenAmount,
      { routePlan: [{ swapInfo: { label: dex || 'OKX' }, percent: 100 }], priceImpactPct: String((Number(r.priceImpactPercentage) || 0) / 100) });
  }
  async swapTx(quote, owner) {
    const d = await this.get('swap', { ...this.base(quote.inputMint, quote.outputMint, quote.inAmount),
      slippagePercent: (quote.slippageBps / 100).toFixed(2), userWalletAddress: owner });
    this.guardDrift(quote, d.routerResult?.toTokenAmount ?? quote.outAmount);
    if (!d.tx?.data) throw new Error('okx: no transaction');
    return { tx: decodeTx(d.tx.data), lastValidBlockHeight: null };
  }
}

// ---- OpenOcean (pro host with an apikey header; the public host is behind Cloudflare) ----
class OpenOceanSwap extends HttpAggregator {
  // decimalsOf(mint) -> Promise<number>: the v4 Solana API takes human-readable amounts.
  constructor(o = {}) { super({ gapMs: 300, ...o }); this.decimalsOf = o.decimalsOf || (async () => 9); }
  get name() { return 'openocean'; } get label() { return 'OpenOcean'; } get needsKey() { return true; }
  async get(endpoint, inMint, outMint, amount, extra = {}) {
    const dec = await this.decimalsOf(inMint);
    const q = new URLSearchParams({
      inTokenAddress: inMint, outTokenAddress: outMint, amount: (Number(amount) / 10 ** dec).toFixed(Math.min(dec, 12)),
      gasPrice: '0.000005', ...extra,
    });
    const r = await this.http(`https://open-api-pro.openocean.finance/v4/solana/${endpoint}?${q}`, { headers: { apikey: this.apiKey() } });
    if (!r.ok || Number(r.j?.code) !== 200 || !r.j?.data?.outAmount) throw this.fail(r, endpoint);
    return r.j.data;
  }
  async quote(inMint, outMint, amount, { slippageBps = 100 } = {}) {
    const d = await this.get('quote', inMint, outMint, amount);
    return this.mkQuote(inMint, outMint, amount, slippageBps, d.outAmount,
      { routePlan: [{ swapInfo: { label: 'OpenOcean' }, percent: 100 }] });
  }
  async swapTx(quote, owner) {
    const d = await this.get('swap', quote.inputMint, quote.outputMint, quote.inAmount,
      { slippage: (quote.slippageBps / 100).toFixed(2), account: owner });
    this.guardDrift(quote, d.outAmount);
    const raw = [d.data, d.tx, d.transaction].find((x) => typeof x === 'string' && x.length > 100);
    if (!raw) throw new Error('openocean: no transaction');
    return { tx: decodeTx(raw), lastValidBlockHeight: null };
  }
}

// ---- DFlow (Jupiter-style API, x-api-key) -------------------------------------------------
class DflowSwap extends HttpAggregator {
  get name() { return 'dflow'; } get label() { return 'DFlow'; } get needsKey() { return true; }
  async quote(inMint, outMint, amount, { slippageBps = 100 } = {}) {
    const q = new URLSearchParams({ inputMint: inMint, outputMint: outMint, amount: String(amount), slippageBps: String(slippageBps) });
    const r = await this.http(`https://quote-api.dflow.net/quote?${q}`, { headers: { 'x-api-key': this.apiKey() } });
    if (!r.ok || !r.j?.outAmount) throw this.fail(r, 'quote');
    const labels = [...new Set((r.j.routePlan || []).map((p) => p.venue || p.swapInfo?.label || p.label).filter(Boolean))].join(' → ');
    return this.mkQuote(inMint, outMint, amount, slippageBps, r.j.outAmount,
      { routePlan: [{ swapInfo: { label: labels || 'DFlow' }, percent: 100 }], priceImpactPct: String(r.j.priceImpactPct ?? 0), raw: r.j });
  }
  async swapTx(quote, owner, { maxPriorityLamports = 2_000_000 } = {}) {
    const r = await this.http('https://quote-api.dflow.net/swap', {
      method: 'POST', headers: { 'x-api-key': this.apiKey() },
      body: { userPublicKey: owner, quoteResponse: quote.raw, dynamicComputeUnitLimit: true, prioritizationFeeLamports: maxPriorityLamports },
    });
    if (!r.ok || !r.j?.swapTransaction) throw this.fail(r, 'swap');
    return { tx: decodeTx(r.j.swapTransaction), lastValidBlockHeight: r.j.lastValidBlockHeight || null };
  }
}

module.exports = { LifiSwap, OkxSwap, OpenOceanSwap, DflowSwap, decodeTx, HttpAggregator };
