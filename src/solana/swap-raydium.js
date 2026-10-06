'use strict';
// Raydium trade API as a swap aggregator (free, no key). Quotes come back in the same shape
// the router uses for Jupiter, so the two can be compared by outAmount.
const { VersionedTransaction } = require('@solana/web3.js');

const WSOL = 'So11111111111111111111111111111111111111112';
const COMPUTE_UNITS_GUESS = 400_000;   // used to turn a lamport cap into micro-lamports per CU

class RaydiumSwap {
  constructor({ log = console.log, fetchImpl = globalThis.fetch, base = 'https://transaction-v1.raydium.io' } = {}) {
    this.log = log; this.fetch = fetchImpl; this.base = base;
    this.name = 'raydium'; this.label = 'Raydium';
  }

  async req(url, { method = 'GET', body = null, timeoutMs = 12_000 } = {}) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetch(url, {
        method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: ctl.signal,
      });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not JSON (Cloudflare page) */ }
      if (!r.ok || j?.success === false) throw new Error(`raydium ${r.status}: ${(j?.msg || j?.error || text).toString().slice(0, 200)}`);
      return j;
    } finally { clearTimeout(t); }
  }

  async quote(inMint, outMint, amount, { slippageBps = 100 } = {}) {
    const q = new URLSearchParams({
      inputMint: inMint, outputMint: outMint, amount: String(amount), slippageBps: String(slippageBps), txVersion: 'V0',
    });
    const r = await this.req(`${this.base}/compute/swap-base-in?${q}`);
    const d = r?.data;
    if (!d?.outputAmount || BigInt(d.outputAmount) <= 0n) throw new Error('raydium: no route');
    return {
      aggregator: 'raydium', inputMint: inMint, outputMint: outMint, inAmount: String(amount),
      outAmount: String(d.outputAmount), otherAmountThreshold: String(d.otherAmountThreshold),
      // Raydium reports a percentage, Jupiter a fraction: normalise to a fraction.
      priceImpactPct: String((Number(d.priceImpactPct) || 0) / 100),
      routePlan: (d.routePlan || []).map(() => ({ swapInfo: { label: 'Raydium' }, percent: 100 })),
      raw: r,
    };
  }

  async swapTx(quote, owner, { maxPriorityLamports = 2_000_000, inputAccount = null } = {}) {
    const fee = await this.req('https://api-v3.raydium.io/main/auto-fee').catch(() => null);
    const wanted = Number(fee?.data?.default?.h) || 10_000;
    const micro = Math.max(1, Math.min(wanted, Math.floor((maxPriorityLamports * 1_000_000) / COMPUTE_UNITS_GUESS)));
    const inSol = quote.inputMint === WSOL, outSol = quote.outputMint === WSOL;
    if (!inSol && !inputAccount) throw new Error('raydium: input token account unknown');
    const r = await this.req(`${this.base}/transaction/swap-base-in`, {
      method: 'POST',
      body: {
        computeUnitPriceMicroLamports: String(micro), swapResponse: quote.raw, txVersion: 'V0', wallet: owner,
        wrapSol: inSol, unwrapSol: outSol, ...(inSol ? {} : { inputAccount }),
      },
    });
    const txs = r?.data || [];
    // A route too big for one tx comes back as several; the executor sends exactly one.
    if (txs.length !== 1) throw new Error(`raydium: ${txs.length} transactions (need exactly 1)`);
    return { tx: VersionedTransaction.deserialize(Buffer.from(txs[0].transaction, 'base64')), lastValidBlockHeight: null };
  }
}

module.exports = { RaydiumSwap };
