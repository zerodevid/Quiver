'use strict';
// The Solana "Chain": the object the dashboard, policy and position bookkeeping use in
// place of pools.js Chain on EVM. Field & method names read by shared code
// (network, ADDR, QUOTES, nativeSymbol, isEthLike, quoteSideOf, valueInQuote, tokens,
// ethUsd, …) are kept — "eth" here = SOL, this chain's native asset.
//
// Key difference from EVM: base58 addresses are CASE-SENSITIVE, never lower-cased.
const { PublicKey } = require('@solana/web3.js');
const { build, WSOL } = require('../networks');
const u = require('./units');
const { Jupiter } = require('./jupiter');
const { SwapRouter } = require('./swap-router');
const { MeteoraApi } = require('./meteora-api');
const { MeteoraVenue } = require('./venues/meteora');
const { OrcaVenue } = require('./venues/orca');
const { RaydiumVenue } = require('./venues/raydium');

// Metaplex Metadata program — names/symbols of old SPL tokens Jupiter does not know.
const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

class SolanaChain {
  constructor(rpc, store, log = console.log, network = 'solana', { jupiter = null, meteoraApi = null, router = null } = {}) {
    this.rpc = rpc; this.store = store; this.log = log;
    const p = build(network);
    Object.assign(this, {
      kind: 'solana', network: p.network, label: p.label, ADDR: p.ADDR, QUOTES: p.QUOTES, CHAIN_ID: null,
      venues: p.venues, nativeSymbol: p.nativeSymbol, kyberPath: null, verified: p.verified,
      blockMs: p.blockMs, dexscreener: p.dexscreener, geckoterminal: p.geckoterminal, gmgn: p.gmgn,
      uniswap: null, explorer: p.explorer, explorerApiV2: null, explorerTokenUrl: p.explorerTokenUrl,
      alchemyHost: p.alchemyHost, legacyGasPricing: false,
    });
    this.usdgSymbol = 'USDC'; this.usdgDecimals = 6; this.wethSymbol = 'SOL';
    this.tokenCache = new Map();
    this.jup = jupiter || new Jupiter({ log });
    // Swaps go through the router (Jupiter + Raydium, best output wins); this.jup stays the
    // price / token-info source.
    this.router = router || new SwapRouter({ jupiter: this.jup, log, tokenAccount: (mint, owner) => this.tokenAccountOf(mint, owner) });
    // Meteora DLMM data API: pool stats, creation time, candles (see meteora-api.js).
    this.meteora = meteoraApi || new MeteoraApi({ log });
    this.adapters = {
      meteora: new MeteoraVenue({ rpc, log }),
      orca: new OrcaVenue({ rpc, log }),
      raydium: new RaydiumVenue({ rpc, log }),
    };
    this.poolCache = new Map();   // pool -> {at, state}
  }

  adapter(venue) {
    const a = this.adapters[venue];
    if (!a) throw new Error(`venue Solana tidak dikenal: ${venue}`);
    return a;
  }

  // ---- venue identity (shared interface) ---------------------------------------
  isV3Venue(v) { return false; }     // there are no EVM v3 NFTs here
  isSolVenue(v) { return !!this.adapters[v]; }
  venueOf(v) { return this.venues.find((x) => x.key === v) || null; }
  npmFor() { return null; }
  isEthLike(sym) { return sym === 'SOL' || sym === 'WSOL' || sym === 'wSOL'; }

  quoteSideOf(token0, token1) {
    const q0 = this.QUOTES[token0], q1 = this.QUOTES[token1];
    // Both sides are quote assets (SOL/USDC — including the biggest DLMM pools): the stablecoin
    // is the quote, so the price shows "USDC per SOL" (113), not the reverse, and value is
    // booked in USD.
    if (q0 && q1 && q0.kind !== q1.kind) return q1.kind === 'usd' ? { side: 1, ...q1 } : { side: 0, ...q0 };
    if (q0) return { side: 0, ...q0 };
    if (q1) return { side: 1, ...q1 };
    return null;
  }

  valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
    const q = this.quoteSideOf(token0, token1);
    if (!q) return null;
    const p = u.priceFromSqrtX96(sqrtPriceX96, dec0, dec1);   // token1 per token0
    const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
    const val = q.side === 0 ? a0 + a1 / p : a1 + a0 * p;
    return { value: val, symbol: q.symbol, side: q.side, kind: q.kind };
  }

  // Value in `asSymbol` units (the quote recorded on the position row). A position is always
  // booked in its row's units; when the valuation lands in another quote (an old row, or the
  // quote selection rule changed), it is converted through USD — without this a USDC value
  // reads as SOL (×113) or the reverse.
  valueAs(args, asSymbol, ethUsd) {
    const v = this.valueInQuote(args);
    if (!v) return null;
    if (!asSymbol || v.symbol === asSymbol || this.isEthLike(v.symbol) === this.isEthLike(asSymbol)) return v.value;
    const usd = v.value * (this.isEthLike(v.symbol) ? ethUsd : 1);
    return usd / (this.isEthLike(asSymbol) ? ethUsd : 1);
  }

  // ---- tokens -----------------------------------------------------------------
  // Decimals from the mint account (the source of truth — used to value money); symbol/name from
  // Jupiter, falling back to Metaplex metadata, finally a slice of the address. Decimals that
  // fail to read are never guessed and never stored (see pools.js tokens()).
  async tokens(addrs) {
    const want = [...new Set(addrs.filter(Boolean).map(String))];
    const miss = [];
    for (const a of want) {
      if (this.tokenCache.has(a)) continue;
      const q = this.QUOTES[a];
      if (q) {
        this.tokenCache.set(a, { address: a, symbol: q.symbol, name: q.symbol, decimals: q.decimals });
        // The tokens table is also read directly by the dashboard (symbols in research & pools):
        // quote assets are recorded too, otherwise they show "?".
        this.store.run('INSERT OR IGNORE INTO tokens(chain,address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?,?)', this.network, a, q.symbol, q.symbol, q.decimals, Date.now());
        continue;
      }
      const row = this.store.get('SELECT * FROM tokens WHERE chain=? AND address=?', this.network, a);
      if (row) { this.tokenCache.set(a, row); continue; }
      miss.push(a);
    }
    for (let i = 0; i < miss.length; i += 100) {
      const part = miss.slice(i, i + 100);
      const infos = await this.rpc.run((c) => c.getMultipleParsedAccounts(part.map((a) => new PublicKey(a))));
      const meta = await this.jup.tokenInfo(part).catch(() => new Map());
      for (let k = 0; k < part.length; k++) {
        const a = part[k];
        const parsed = infos.value[k]?.data?.parsed;
        const dec = parsed?.type === 'mint' ? Number(parsed.info.decimals) : null;
        if (dec == null) continue;   // not a mint / unreadable: not stored, read again later
        let symbol = meta.get(a)?.symbol || null, name = meta.get(a)?.name || null;
        if (!symbol) {
          // Token-2022 with the metadata extension keeps the name/symbol in the mint account itself.
          const ext = (parsed.info.extensions || []).find((e) => e.extension === 'tokenMetadata');
          if (ext) { symbol = ext.state?.symbol || null; name = ext.state?.name || null; }
        }
        if (!symbol) { const mp = await this.metaplex(a).catch(() => null); if (mp) ({ symbol, name } = mp); }
        const t = { address: a, symbol: String(symbol || a.slice(0, 4) + '…').slice(0, 24), name: String(name || '').slice(0, 64), decimals: dec };
        this.tokenCache.set(a, t);
        this.store.run('INSERT OR REPLACE INTO tokens(chain,address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?,?)',
          this.network, a, t.symbol, t.name, t.decimals, Date.now());
      }
    }
    return want.map((a) => this.tokenCache.get(a));
  }
  async token(a) { return (await this.tokens([a]))[0]; }

  // The owner's fullest token account for a mint (legacy or Token-2022), for aggregators that
  // need the input account spelled out.
  async tokenAccountOf(mint, owner) {
    const r = await this.rpc.run((c) => c.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }));
    const best = (r?.value || []).sort((a, b) =>
      Number(b.account.data.parsed.info.tokenAmount.amount) - Number(a.account.data.parsed.info.tokenAmount.amount))[0];
    if (!best) throw new Error(`no token account for ${mint}`);
    return best.pubkey.toBase58();
  }
  async decimalsMap(mints) {
    const ts = await this.tokens(mints);
    return new Map(ts.filter(Boolean).map((t) => [t.address, t.decimals]));
  }

  async metaplex(mint) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from('metadata'), METAPLEX.toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX);
    const acc = await this.rpc.run((c) => c.getAccountInfo(pda));
    if (!acc) return null;
    // key(1) updateAuthority(32) mint(32) name(4+32) symbol(4+10) — borsh strings padded with \0
    const d = acc.data;
    const str = (off) => { const n = d.readUInt32LE(off); return { s: d.subarray(off + 4, off + 4 + n).toString('utf8').replace(/\0+$/, '').trim(), next: off + 4 + n }; };
    const nm = str(65), sy = str(nm.next);
    return { name: nm.s, symbol: sy.s };
  }

  // ---- pools -------------------------------------------------------------------
  // Normalised pool state (see venues/*). Held 3 seconds: position sync, entry plans and the
  // dashboard may ask for the same pool close together.
  async pools(venue, addrs, { maxAgeMs = 3000 } = {}) {
    const now = Date.now();
    const out = new Map(), miss = [];
    for (const a of addrs) {
      const h = this.poolCache.get(`${venue}:${a}`);
      if (h && now - h.at < maxAgeMs) out.set(a, h.state); else miss.push(a);
    }
    if (miss.length) {
      const got = await this.adapter(venue).pools(miss, (m) => this.decimalsMap(m));
      for (const [a, st] of got) {
        // decimals not yet read by the adapter (DLMM): filled from the token cache
        if (st.dec0 == null || st.dec1 == null) {
          const dm = await this.decimalsMap([st.token0, st.token1]);
          st.dec0 ??= dm.get(st.token0); st.dec1 ??= dm.get(st.token1);
        }
        this.poolCache.set(`${venue}:${a}`, { at: now, state: st });
        out.set(a, st);
        this.rememberPool(st);
      }
    }
    return out;
  }
  async pool(venue, addr, opts) { return (await this.pools(venue, [addr], opts)).get(addr) || null; }

  rememberPool(st) {
    this.store.run(`INSERT INTO pools(chain,pool_ref,venue,token0,token1,fee,tick_spacing,pool_addr) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(chain,pool_ref) DO UPDATE SET venue=excluded.venue, token0=excluded.token0, token1=excluded.token1,
        fee=excluded.fee, tick_spacing=excluded.tick_spacing, pool_addr=excluded.pool_addr`,
    this.network, st.id, st.venue, st.token0, st.token1, st.fee ?? null, st.tickSpacing ?? null, st.id);
  }

  // EVM interface the dashboard calls for pool prices. On Solana pool_ref = the pool address
  // and its venue is recorded in the pools table; same return shape as slot0V3.
  // A pool's venue from the program owning its account (for pools not recorded yet —
  // e.g. opened from a DexScreener link). null when not a pool of the three venues.
  async venueOfPool(addr) {
    const row = this.store.get('SELECT venue FROM pools WHERE chain=? AND pool_ref=?', this.network, addr);
    if (row && this.adapters[row.venue]) return row.venue;
    const acc = await this.rpc.run((c) => c.getAccountInfo(new PublicKey(addr)));
    const owner = acc?.owner?.toBase58();
    return Object.values(this.adapters).find((a) => a.program === owner)?.key || null;
  }

  async slot0Of(poolRef) {
    const venue = await this.venueOfPool(poolRef).catch(() => null);
    if (!venue) return null;
    const st = await this.pool(venue, poolRef).catch(() => null);
    return st ? { sqrtPriceX96: st.sqrtX96, tick: st.tick, lpFee: st.fee ?? 0 } : null;
  }
  async slot0V3(poolRef) { return this.slot0Of(poolRef); }
  async slot0V4(poolRef) { return this.slot0Of(poolRef); }
  async slot0V4Many(refs) { return Promise.all(refs.map((r) => this.slot0Of(r))); }
  async poolLiquidityMany(refs) {
    return Promise.all(refs.map(async (r) => {
      const venue = await this.venueOfPool(r).catch(() => null);
      const st = venue ? await this.pool(venue, r).catch(() => null) : null;
      return st?.liquidity ?? (st ? 1n : 0n);
    }));
  }
  async poolLiquidity(ref) { return (await this.poolLiquidityMany([ref]))[0] ?? 0n; }
  async markSqrtForPair() { return null; }
  // Pool age (minutes), stored in the pools table (once per pool is enough). Source: the
  // creation time of the Meteora DLMM API for a DLMM pool, else the DexScreener pair creation
  // time. Unreadable = throws; the caller does not block on it.
  async poolAgeMinutes(pool) {
    const row = this.store.get('SELECT first_ts FROM pools WHERE chain=? AND pool_ref=?', this.network, pool);
    if (row?.first_ts) return (Date.now() - row.first_ts) / 60000;
    let ts = null;
    try { ts = (await this.meteora.pool(pool))?.createdAt ?? null; } catch { /* fall through to DexScreener */ }
    if (!(ts > 0)) {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${pool}`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`DexScreener HTTP ${r.status}`);
      const j = await r.json();
      ts = Number((j.pairs || [j.pair]).filter(Boolean)[0]?.pairCreatedAt);
    }
    if (!(ts > 0)) throw new Error('umur pool tidak diketahui (Meteora/DexScreener)');
    this.store.run(`INSERT INTO pools(chain,pool_ref,venue,first_ts) VALUES(?,?,?,?)
      ON CONFLICT(chain,pool_ref) DO UPDATE SET first_ts=excluded.first_ts`, this.network, pool, (await this.venueOfPool(pool).catch(() => null)) || 'solana', ts);
    return (Date.now() - ts) / 60000;
  }

  // ---- SOL price ------------------------------------------------------------------
  // From Jupiter (aggregated over all pools); falls back to the last value / the config
  // fallback on failure. Values outside a sane range are refused — one broken answer must
  // not shift every dollar limit.
  async ethUsd(fallback = 150) {
    const now = Date.now();
    if (this._ethUsd && now - this._ethUsdAt < 60_000) return this._ethUsd;
    try {
      const p = (await this.jup.prices([WSOL])).get(WSOL);
      if (p > 1 && p < 100_000) { this._ethUsd = p; this._ethUsdAt = now; return p; }
    } catch { /* fallback */ }
    return this._ethUsd ?? fallback;
  }
  async ethUsdAt(_block, fallback) { return this.ethUsd(fallback); }

  async blockTs() { return Date.now(); }
}

module.exports = { SolanaChain };
