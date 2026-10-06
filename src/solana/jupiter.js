'use strict';
// Jupiter: the Solana swap aggregator (Kyber's role on EVM), the USD price source, and token
// names. Without an API key it uses lite-api.jup.ag (free, rate-limited); with
// JUPITER_API_KEY it uses api.jup.ag.
const { VersionedTransaction } = require('@solana/web3.js');

class Jupiter {
  constructor({ log = console.log, apiKey = process.env.JUPITER_API_KEY || null, fetchImpl = globalThis.fetch } = {}) {
    this.log = log;
    this.name = 'jupiter'; this.label = 'Jupiter';
    this.apiKey = apiKey;
    this.base = apiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
    this.fetch = fetchImpl;
    this.priceCache = new Map();   // mint -> {at, usd}
    this.infoCache = new Map();
  }

  async req(path, { method = 'GET', body = null, timeoutMs = 15_000 } = {}) {
    const h = { accept: 'application/json' };
    if (this.apiKey) h['x-api-key'] = this.apiKey;
    if (body) h['content-type'] = 'application/json';
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await this.fetch(`${this.base}${path}`, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
      const text = await r.text();
      let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
      if (!r.ok) throw new Error(`jupiter ${r.status}: ${(j?.error || j?.message || text).toString().slice(0, 200)}`);
      return j;
    } finally { clearTimeout(t); }
  }

  // Exact-in swap quote. amount: BigInt/str raw amount of the input token.
  async quote(inMint, outMint, amount, { slippageBps = 100, onlyDirect = false, maxAccounts = null } = {}) {
    const q = new URLSearchParams({
      inputMint: inMint, outputMint: outMint, amount: String(amount), slippageBps: String(slippageBps),
      restrictIntermediateTokens: 'true', ...(onlyDirect ? { onlyDirectRoutes: 'true' } : {}), ...(maxAccounts ? { maxAccounts: String(maxAccounts) } : {}),
    });
    const r = await this.req(`/swap/v1/quote?${q}`);
    if (!r?.outAmount) throw new Error(`jupiter: tidak ada rute ${inMint.slice(0, 6)}→${outMint.slice(0, 6)}`);
    return r;
  }

  // A swap transaction ready to sign (v0). Jupiter sets the priority fee within
  // maxLamports; SOL is wrapped/unwrapped automatically.
  async swapTx(quote, owner, { maxPriorityLamports = 2_000_000, priorityLevel = 'high' } = {}) {
    const r = await this.req('/swap/v1/swap', {
      method: 'POST',
      body: {
        quoteResponse: quote, userPublicKey: owner, wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true, dynamicSlippage: false,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: maxPriorityLamports, priorityLevel } },
      },
    });
    if (!r?.swapTransaction) throw new Error('jupiter: transaksi swap kosong');
    return { tx: VersionedTransaction.deserialize(Buffer.from(r.swapTransaction, 'base64')), lastValidBlockHeight: r.lastValidBlockHeight };
  }

  // USD prices of many mints (max 50 per call), held for 30 seconds.
  async prices(mints) {
    const now = Date.now();
    const out = new Map(), miss = [];
    for (const m of new Set(mints)) {
      const h = this.priceCache.get(m);
      if (h && now - h.at < 30_000) out.set(m, h.usd); else miss.push(m);
    }
    for (let i = 0; i < miss.length; i += 50) {
      const part = miss.slice(i, i + 50);
      const r = await this.req(`/price/v3?ids=${part.join(',')}`);
      for (const m of part) {
        const usd = Number(r?.[m]?.usdPrice);
        if (Number.isFinite(usd) && usd > 0) { out.set(m, usd); this.priceCache.set(m, { at: now, usd }); }
      }
    }
    return out;
  }

  // Token names & symbols (max 100 per call). Mints Jupiter does not know are absent
  // from the result.
  async tokenInfo(mints) {
    const out = new Map(), miss = [];
    for (const m of new Set(mints)) { if (this.infoCache.has(m)) out.set(m, this.infoCache.get(m)); else miss.push(m); }
    for (let i = 0; i < miss.length; i += 100) {
      const part = miss.slice(i, i + 100);
      const r = await this.req(`/tokens/v2/search?query=${part.join(',')}`);
      for (const t of Array.isArray(r) ? r : []) {
        if (!part.includes(t.id)) continue;
        const v = { symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon || null, verified: !!t.isVerified };
        this.infoCache.set(t.id, v); out.set(t.id, v);
      }
    }
    return out;
  }

  // Jupiter's token record as is (no cache): holderCount, audit, etc.
  async tokenRecord(mint) {
    const r = await this.req(`/tokens/v2/search?query=${mint}`);
    return (Array.isArray(r) ? r : []).find((t) => t.id === mint) || null;
  }
}

module.exports = { Jupiter };
