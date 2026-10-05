'use strict';
// Pool state reader + token metadata cache, for v4 (PoolManager.extsload) and v3 (slot0).
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { build } = require('./networks');
const m = require('./v3math');

const coder = ethers.AbiCoder.defaultAbiCoder();
const IF_EXT = new ethers.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);
const IF_ERC20 = new ethers.Interface(ABI.erc20);
const IF_POOL3 = new ethers.Interface(ABI.poolV3);
const IF_FACT = new ethers.Interface(ABI.v3Factory);

// Slot of the `_pools` mapping in the v4 PoolManager — verified on Robinhood Chain:
// keccak256(abi.encode(poolId, uint256(6))) holds the packed Slot0.
const POOLS_SLOT = 6n;

function computePoolId(pk) {
  return ethers.keccak256(coder.encode(
    ['address', 'address', 'uint24', 'int24', 'address'],
    [pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks],
  ));
}

function unpackSlot0(word) {
  const bi = BigInt(word);
  return {
    sqrtPriceX96: bi & ((1n << 160n) - 1n),
    tick: Number(BigInt.asIntN(24, (bi >> 160n) & 0xffffffn)),
    protocolFee: Number((bi >> 184n) & 0xffffffn),
    lpFee: Number((bi >> 208n) & 0xffffffn),
  };
}

class Chain {
  constructor(rpc, store, log = console.log, network = 'robinhood') {
    this.rpc = rpc; this.store = store; this.log = log;
    const p = build(network);
    this.network = p.network; this.label = p.label;
    this.ADDR = p.ADDR; this.QUOTES = p.QUOTES; this.CHAIN_ID = p.CHAIN_ID;
    this.venues = p.venues; this.nativeSymbol = p.nativeSymbol; this.kyberPath = p.kyberPath;
    this.nativeUsdMode = p.nativeUsd?.mode || 'v4pool'; this.nativeUsdPools = p.nativeUsd?.pools || []; this.verified = p.verified;
    this.legacyGasPricing = p.legacyGasPricing; this.blockMs = p.blockMs;
    this.dexscreener = p.dexscreener; this.geckoterminal = p.geckoterminal; this.explorer = p.explorer;
    this.explorerApiV2 = p.explorerApiV2; this.explorerTokenUrl = p.explorerTokenUrl; this.alchemyHost = p.alchemyHost;
    // Generic slots "quote stablecoin" (usdg) and "wrapped native" (weth): the symbol and
    // decimals differ per chain (USDG 6 decimals vs BSC USDT 18 decimals).
    this.usdgSymbol = this.QUOTES[this.ADDR.usdg]?.symbol || 'USDG';
    this.usdgDecimals = this.QUOTES[this.ADDR.usdg]?.decimals ?? 6;
    this.wethSymbol = this.QUOTES[this.ADDR.weth]?.symbol || 'WETH';
    this.tokenCache = new Map();
    this.poolCache = new Map();
    this.v3Factory = null;
    this.v3FactoryByNpm = new Map(); // npmV3 addr -> factory addr (other venues, e.g. pancakev3)
    this.blockTimeCache = { block: 0, ts: 0 };
  }

  // ---- token -------------------------------------------------------------
  async tokens(addrs) {
    const want = [...new Set(addrs.map((a) => (a || '').toLowerCase()))].filter(Boolean);
    const miss = [];
    for (const a of want) {
      if (this.tokenCache.has(a)) continue;
      if (a === this.ADDR.native) { this.tokenCache.set(a, { address: a, symbol: this.nativeSymbol, name: this.nativeSymbol, decimals: 18 }); continue; }
      const row = this.store.get('SELECT * FROM tokens WHERE chain=? AND address=?', this.network, a);
      if (row) { this.tokenCache.set(a, row); continue; }
      miss.push(a);
    }
    if (miss.length) {
      const calls = [];
      for (const a of miss) {
        calls.push({ to: a, data: IF_ERC20.encodeFunctionData('symbol') });
        calls.push({ to: a, data: IF_ERC20.encodeFunctionData('decimals') });
        calls.push({ to: a, data: IF_ERC20.encodeFunctionData('name') });
      }
      // strict: a temporary RPC error (quota) throws, NOT treated as "decimals 18". A failed
      // read used to be stored permanently in the tokens table — a 9-decimal token (NUKE)
      // that was once read as 18 would be valued 10⁹× wrong forever: position size, the
      // $ per position limit, and PnL all go haywire. A decimals() that truly reverts (a
      // non-standard token) still falls back to 18, but a result that was unreadable is not stored.
      const res = await this.rpc.ethCallMany(calls, 'latest', { strict: true });
      miss.forEach((a, i) => {
        const dec = (h) => { try { return IF_ERC20.decodeFunctionResult('decimals', h)[0]; } catch { return null; } };
        const str = (h, fn) => { try { return IF_ERC20.decodeFunctionResult(fn, h)[0]; } catch { return '?'; } };
        const d = res[i * 3 + 1] ? dec(res[i * 3 + 1]) : null;
        const t = {
          address: a,
          symbol: res[i * 3] ? String(str(res[i * 3], 'symbol')).slice(0, 24) : '?',
          decimals: d != null ? Number(d) : 18,
          name: res[i * 3 + 2] ? String(str(res[i * 3 + 2], 'name')).slice(0, 64) : '',
        };
        // Without symbol AND decimals: most likely not a legitimate answer (a lagging node
        // does not know the contract yet) — used once, not stored, re-read later.
        if (d == null && t.symbol === '?') return this.tokenCache.set(a, { ...t, unverified: true });
        this.tokenCache.set(a, t);
        this.store.run('INSERT OR REPLACE INTO tokens(chain,address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?,?)',
          this.network, t.address, t.symbol, t.name, t.decimals, Date.now());
      });
    }
    const out = want.map((a) => this.tokenCache.get(a));
    for (const t of out) if (t?.unverified) this.tokenCache.delete(t.address);
    return out;
  }
  async token(a) { return (await this.tokens([a]))[0]; }

  // ---- v4 pool state ------------------------------------------------------
  async slot0V4(poolId) {
    const slot = ethers.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, POOLS_SLOT]));
    const [w] = await this.rpc.ethCallMany([{ to: this.ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', [slot]) }]);
    if (!w || /^0x0*$/.test(w)) return null;
    const s = unpackSlot0(w);
    return s.sqrtPriceX96 > 0n ? s : null;
  }
  async slot0V4Many(poolIds) {
    const calls = poolIds.map((id) => ({
      to: this.ADDR.poolManager,
      data: IF_EXT.encodeFunctionData('extsload', [ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, POOLS_SLOT]))]),
    }));
    const res = await this.rpc.ethCallMany(calls);
    return res.map((w) => (w && !/^0x0*$/.test(w) ? unpackSlot0(w) : null));
  }

  // ---- v3 pool state ------------------------------------------------------
  async slot0V3(poolAddr) {
    const [w] = await this.rpc.ethCallMany([{ to: poolAddr, data: IF_POOL3.encodeFunctionData('slot0') }]);
    if (!w || w === '0x') return null;
    try {
      const d = IF_POOL3.decodeFunctionResult('slot0', w);
      return { sqrtPriceX96: d[0], tick: Number(d[1]), lpFee: 0 };
    } catch { return null; }
  }

  // npmAddr: the NonfungiblePositionManager address of the venue in question (default: the main
  // 'v3' venue). Used for the second v3 venue on a chain that has more than one
  // v3 deployment (e.g. BSC: Uniswap v3 and PancakeSwap v3).
  async factoryV3(npmAddr = this.ADDR.npmV3) {
    if (npmAddr === this.ADDR.npmV3 && this.v3Factory) return this.v3Factory;
    if (this.v3FactoryByNpm.has(npmAddr)) return this.v3FactoryByNpm.get(npmAddr);
    const stateKey = `v3_factory:${this.network}:${npmAddr}`;
    const cached = this.store.getState(stateKey);
    if (cached) { this.v3FactoryByNpm.set(npmAddr, cached); if (npmAddr === this.ADDR.npmV3) this.v3Factory = cached; return cached; }
    const IF = new ethers.Interface(ABI.npmV3);
    const [w] = await this.rpc.ethCallMany([{ to: npmAddr, data: IF.encodeFunctionData('factory') }]);
    const factory = ethers.getAddress('0x' + w.slice(-40)).toLowerCase();
    this.v3FactoryByNpm.set(npmAddr, factory);
    if (npmAddr === this.ADDR.npmV3) this.v3Factory = factory;
    this.store.setState(stateKey, factory);
    return factory;
  }

  async poolV3Addr(token0, token1, fee, npmAddr = this.ADDR.npmV3) {
    const key = `${npmAddr}|${token0}|${token1}|${fee}`.toLowerCase();
    if (this.poolCache.has(key)) return this.poolCache.get(key);
    const f = await this.factoryV3(npmAddr);
    const [w] = await this.rpc.ethCallMany([{ to: f, data: IF_FACT.encodeFunctionData('getPool', [token0, token1, fee]) }]);
    const addr = w && w !== '0x' ? ethers.getAddress('0x' + w.slice(-40)).toLowerCase() : null;
    this.poolCache.set(key, addr);
    return addr;
  }

  // ---- valuation ----------------------------------------------------------
  // Position value in the pool's quote asset. If no quote side is known,
  // the value is estimated via the quote side only (the speculative token valued from the pool price).
  // Symbols converted via the chain's native price (chain.ethUsd()) — the native coin
  // itself and its wrapped form. This field/method name stays "eth" because
  // the concept is exactly the same on every EVM chain (BNB/WBNB on BSC, etc).
  isEthLike(symbol) {
    return symbol === this.nativeSymbol || symbol === this.QUOTES[this.ADDR.weth]?.symbol;
  }

  // v3 venues (NFT positions via the NonfungiblePositionManager): 'v3' on every chain, plus
  // other v3 deployments on chains that have more than one (BSC: 'pancakev3'). All
  // run through the same v3 code path, only the NPM/factory address differs.
  isV3Venue(venue) { return this.venues.some((v) => v.key === venue); }
  venueOf(venue) { return this.venues.find((v) => v.key === venue) || null; }
  npmFor(venue) { return this.venueOf(venue)?.npmV3 || this.ADDR.npmV3; }

  quoteSideOf(token0, token1) {
    const q0 = this.QUOTES[(token0 || '').toLowerCase()];
    const q1 = this.QUOTES[(token1 || '').toLowerCase()];
    if (q0) return { side: 0, ...q0 };
    if (q1) return { side: 1, ...q1 };
    return null;
  }

  // Total position value (both sides) in quote asset units.
  valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
    const q = this.quoteSideOf(token0, token1);
    if (!q) return null;
    const price1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1); // token1 per token0
    const a0 = Number(amount0) / 10 ** dec0;
    const a1 = Number(amount1) / 10 ** dec1;
    const val = q.side === 0 ? a0 + a1 / price1per0 : a1 + a0 * price1per0;
    return { value: val, symbol: q.symbol, side: q.side, kind: q.kind };
  }

  // Estimated block timestamp — RH chain blocks are ~0.101 seconds, but we still take
  // a real reference occasionally so it does not drift far.
  async blockTs(block) {
    const now = Date.now();
    if (!this.blockTimeCache.block || now - this.blockTimeCache.at > 300_000) {
      const b = await this.rpc.call('eth_getBlockByNumber', ['latest', false]);
      this.blockTimeCache = { block: parseInt(b.number, 16), ts: parseInt(b.timestamp, 16) * 1000, at: now };
    }
    const c = this.blockTimeCache;
    return Math.round(c.ts + (block - c.block) * this.blockMs);
  }
}

module.exports = { Chain, computePoolId, unpackSlot0, POOLS_SLOT };

// ---- ETH price in USDG -------------------------------------------------
// Derived ourselves from the native-ETH/USDG pools on this chain (no external source needed).
// The pools are found via the Initialize event that indexes currency0 & currency1.
const { TOPIC } = require('./chain');

Chain.prototype.findEthUsdgPools = async function findEthUsdgPools(headBlock, blocks = 4_000_000) {
  const stateKey = `eth_usdg_pools:${this.network}`;
  // This list used to be cached FOREVER: once filled, an ETH/USDG pool born
  // later was never seen — including pools without a hook, the only kind whose
  // direct swap the router surely accepts. Now rescanned once a day.
  // A failed scan KEEPS the old list (getLogs on this chain often goes down),
  // and within one process is not repeated more often than hourly so the RPC is not hammered.
  const TTL = 24 * 3600_000;
  let old = null;
  const cached = this.store.getState(stateKey);
  if (cached) {
    try {
      const j = JSON.parse(cached);
      const pools = Array.isArray(j) ? j : j.pools;      // old shape: a bare array
      if (Array.isArray(pools) && pools.length) {
        if (Date.now() - (Array.isArray(j) ? 0 : j.ts || 0) < TTL) return pools;
        old = pools;
      }
    } catch { /* lanjut pindai */ }
  }
  if (old && this._ethUsdgScanAt && Date.now() - this._ethUsdgScanAt < 3600_000) return old;
  this._ethUsdgScanAt = Date.now();
  const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const found = [];
  const chunk = 400_000;
  for (let hi = headBlock; hi > headBlock - blocks && found.length < 12;) {
    const lo = Math.max(0, hi - chunk);
    let logs = [];
    try {
      logs = await this.rpc.getLogs({
        address: this.ADDR.poolManager,
        topics: [TOPIC.initializeV4, null, pad(this.ADDR.native), pad(this.ADDR.usdg)],
        fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16),
      });
    } catch { /* range too large: skip this chunk */ }
    for (const l of logs) {
      const b = ethers.getBytes(l.data);
      const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
      found.push({
        poolId: l.topics[1],
        fee: Number(w(0)), tickSpacing: Number(BigInt.asIntN(24, w(1))),
        hooks: '0x' + ethers.hexlify(b.slice(2 * 32 + 12, 3 * 32)).slice(2),
      });
    }
    if (lo === 0) break;
    hi = lo - 1;
  }
  if (found.length) {
    // The scan result is MERGED with the old list, not overwriting it. A block chunk whose
    // getLogs failed is silently skipped above, so one unlucky scan gives a
    // shorter list — yet a v4 pool that has been born never disappears from the
    // chain, so a shrinking list ALWAYS means the scan fell short. The first
    // rescan (25 Sep 2026) did return only 9 of the 12 recorded pools.
    const exists = new Set(found.map((p) => String(p.poolId).toLowerCase()));
    const gabung = [...found, ...(old || []).filter((p) => !exists.has(String(p.poolId).toLowerCase()))];
    this.store.setState(stateKey, JSON.stringify({ ts: Date.now(), pools: gabung }));
    return gabung;
  }
  // An empty scan is not time-stamped: the hourly guard above holds back repetition,
  // so the old list is not locked for 24 hours because of an RPC that happens to be down.
  return old || found;
};

// Global spot ETH/USD sources, queried in parallel; the median of the answers is the price.
const GLOBAL_ETH_SOURCES = [
  ['https://api.coinbase.com/v2/prices/ETH-USD/spot', (j) => j?.data?.amount],
  ['https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', (j) => j?.price],
  ['https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', (j) => j?.ethereum?.usd],
];

// Median of the sane prices the global sources return; null if none answered.
Chain.globalEthPrice = async function globalEthPrice(fetchImpl = globalThis.fetch) {
  const got = await Promise.all(GLOBAL_ETH_SOURCES.map(async ([url, pick]) => {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return null;
      const v = Number(pick(await r.json()));
      return v > 100 && v < 100_000 ? v : null;
    } catch { return null; }
  }));
  const ok = got.filter((v) => v != null).sort((a, b) => a - b);
  if (!ok.length) return null;
  return ok.length % 2 ? ok[(ok.length - 1) / 2] : (ok[ok.length / 2 - 1] + ok[ok.length / 2]) / 2;
};

Chain.prototype.ethUsd = async function ethUsd(fallback = 2500) {
  const now = Date.now();
  if (this._ethUsd && now - this._ethUsdAt < 60_000) return this._ethUsd;
  // 'global' mode: the market price from public APIs; if none answers, fall through to the
  // on-chain pools below so the price never goes missing.
  if (this.nativeUsdMode === 'global') {
    const g = await Chain.globalEthPrice();
    if (g) { this._ethUsd = g; this._ethUsdAt = now; return g; }
  }
  // Chains whose native price is read from specific v3 pools (BSC: PancakeSwap v3
  // USDT/WBNB) — see ethUsdFromV3Pools. 'manual' mode: price from the config only.
  if (this.nativeUsdMode === 'v3pools') return this.ethUsdFromV3Pools(fallback, now);
  if (this.nativeUsdMode !== 'v4pool' && this.nativeUsdMode !== 'global') return this._ethUsd ?? fallback;
  try {
    const head = await this.rpc.blockNumber();
    const pools = await this.findEthUsdgPools(head);
    const noHook = pools.filter((p) => /^0x0+$/.test(p.hooks));
    // Every hookless pool is read (one batch each for slot0 and liquidity): a cap of 8
    // in scan order used to drop the low-fee pools that carry the most reliable price.
    const list = (noHook.length ? noHook : pools).slice(0, 24);
    if (!list.length) return fallback;
    const slots = await this.slot0V4Many(list.map((p) => p.poolId));
    // pick the pool with the largest liquidity
    const liqCalls = list.map((p) => ({
      to: this.ADDR.poolManager,
      data: IF_EXT.encodeFunctionData('extsload', [
        '0x' + (BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.poolId, POOLS_SLOT]))) + 3n).toString(16).padStart(64, '0'),
      ]),
    }));
    const liqs = await this.rpc.ethCallMany(liqCalls);
    // Candidates: pools with active liquidity > 0 and a sane price (tick not stuck at the
    // bound). currency0 = ETH(18), currency1 = USDG(6) -> price = USDG per ETH.
    const cands = [];
    list.forEach((p, i) => {
      const s = slots[i]; if (!s || s.sqrtPriceX96 === 0n) return;
      const L = liqs[i] && liqs[i] !== '0x' ? BigInt(liqs[i]) & ((1n << 128n) - 1n) : 0n;
      if (!priceUsable(s, L)) return;
      const price = m.priceFromSqrt(s.sqrtPriceX96, 18, 6);
      if (price > 100 && price < 100_000) cands.push({ p, s, L, price });
    });
    const pick = Chain.pickEthPrice(cands);
    if (!pick) return fallback;
    if (pick.outlier) this.log(`harga ETH: pool acuan $${pick.outlier.toFixed(0)} menyimpang dari pool lain — dipakai median $${pick.price.toFixed(0)}`);
    this._ethUsd = pick.price; this._ethUsdAt = now; this._ethPoolId = pick.poolId;
    return pick.price;
  } catch { return fallback; }
};

// Native price from the v3 pools set in the profile (nativeUsd.pools): slot0 +
// liquidity of each pool in one batch, expressed as USD per native according to which side
// is the stablecoin (usdg slot). Selection & the outlier fence are the same as the v4 path.
Chain.prototype.ethUsdFromV3Pools = async function ethUsdFromV3Pools(fallback, now = Date.now()) {
  const pools = this.nativeUsdPools;
  if (!pools.length) return this._ethUsd ?? fallback;
  try {
    const calls = pools.flatMap((a) => [
      { to: a, data: IF_POOL3.encodeFunctionData('slot0') }, { to: a, data: IF_POOL3.encodeFunctionData('liquidity') },
      { to: a, data: IF_POOL3.encodeFunctionData('token0') },
    ]);
    const res = await this.rpc.ethCallMany(calls);
    const usdDec = this.usdgDecimals, natDec = 18;
    const cands = [];
    pools.forEach((a, i) => {
      const w = res[i * 3], wl = res[i * 3 + 1], w0 = res[i * 3 + 2];
      if (!w || w === '0x' || !wl || wl === '0x' || !w0 || w0 === '0x') return;
      let s;
      try { const d = IF_POOL3.decodeFunctionResult('slot0', w); s = { sqrtPriceX96: BigInt(d[0]), tick: Number(d[1]) }; } catch { return; }
      const L = BigInt(wl);
      if (!priceUsable(s, L)) return;
      const t0 = ('0x' + w0.slice(-40)).toLowerCase();
      const usdIs0 = t0 === this.ADDR.usdg;
      // priceFromSqrt = token1 per token0. USD per native = token0 per token1 if token0 is the stablecoin.
      const p1per0 = m.priceFromSqrt(s.sqrtPriceX96, usdIs0 ? usdDec : natDec, usdIs0 ? natDec : usdDec);
      const price = usdIs0 ? 1 / p1per0 : p1per0;
      if (Number.isFinite(price) && price > 1 && price < 1_000_000) cands.push({ p: { poolId: a }, s, L, price });
    });
    const pick = Chain.pickEthPrice(cands);
    if (!pick) return this._ethUsd ?? fallback;
    if (pick.outlier) this.log(`harga ${this.nativeSymbol}: pool terdalam $${pick.outlier.toFixed(2)} menyimpang dari pool lain — dipakai median $${pick.price.toFixed(2)}`);
    this._ethUsd = pick.price; this._ethUsdAt = now;
    return pick.price;
  } catch { return this._ethUsd ?? fallback; }
};

// ETH price from the list of candidate pools.
//
// A pool's price is only pinned to the market within its own fee: arbitrage pays only once the
// price is more than `fee` away, so a 2.5%-fee pool can sit 2.5% off for hours. On 2026-10-01 the
// deepest hookless ETH/USDG pool (2.5% fee) read $2,751 while the market and the 0.0021%-fee pool
// read ~$2,690 — every ETH balance, ETH-quoted position and dollar limit was ~2% too high.
// So among the pools with real liquidity (at least MIN_DEPTH_SHARE of the deepest), the one with
// the LOWEST fee sets the price; depth breaks ties. Candidates without a known fee (BSC v3pools
// mode) all tie on fee, which keeps the old deepest-first rule there.
//
// The outlier fence stays: if the chosen pool is > 3% away from the median of the three
// deepest pools (just swept, or misread from a lagging node), that median is used instead.
// Returns { price, poolId, outlier } — outlier = the price of the chosen pool that was rejected.
const MIN_DEPTH_SHARE = 100n;   // 1/100 of the deepest pool's active liquidity
const feeOf = (c) => {
  const f = Number(c.p?.fee);
  return Number.isFinite(f) && f >= 0 && f < 1_000_000 ? f : null;   // 0x800000 = dynamic: unknown
};
Chain.pickEthPrice = function pickEthPrice(cands) {
  if (!cands.length) return null;
  const byDepth = [...cands].sort((a, b) => (a.L > b.L ? -1 : a.L < b.L ? 1 : 0));
  const maxL = byDepth[0].L;
  const deep = byDepth.filter((c) => c.L * MIN_DEPTH_SHARE >= maxL);
  const best = [...deep].sort((a, b) => {
    const fa = feeOf(a), fb = feeOf(b);
    if (fa !== fb) return fa == null ? 1 : fb == null ? -1 : fa - fb;
    return a.L > b.L ? -1 : a.L < b.L ? 1 : 0;
  })[0];
  const top = byDepth.slice(0, 3);
  if (top.length < 3) return { price: best.price, poolId: best.p.poolId, outlier: null };
  const median = [...top].sort((a, b) => a.price - b.price)[1];
  if (Math.abs(best.price - median.price) / median.price <= 0.03) return { price: best.price, poolId: best.p.poolId, outlier: null };
  return { price: median.price, poolId: median.p.poolId, outlier: best.price };
};

// ETH price at a past block, from the same ETH/USDG pools (needs an archive node).
// Used to value the proceeds of a sale to ETH at its time — using today's ETH price for
// yesterday's sale can be off by a few percent. Without an archive: the current price.
Chain.prototype.ethUsdAt = async function ethUsdAt(block, fallback = 2500) {
  const now = await this.ethUsd(fallback);
  if (!this._ethPoolId || !this.rpc.hasArchive()) return now;
  const key = `ethusd:${this.network}:${block}`;
  const cached = this.store.getState(key);
  if (cached) return Number(cached);
  try {
    const slot = ethers.keccak256(coder.encode(['bytes32', 'uint256'], [this._ethPoolId, POOLS_SLOT]));
    const w = await this.rpc.callAt(this.ADDR.poolManager, IF_EXT.encodeFunctionData('extsload', [slot]), block);
    const s = unpackSlot0(w);
    const price = m.priceFromSqrt(s.sqrtPriceX96, 18, 6);
    if (price > 100 && price < 100_000) { this.store.setState(key, String(price)); return price; }
  } catch { /* pakai harga sekarang */ }
  return now;
};

// ---- poolKey from poolId --------------------------------------------------
// A position whose NFT has been burned no longer returns a poolKey from the
// PositionManager — all that is left is the poolId from the ModifyLiquidity event. Without
// its token pair, that position cannot be valued at all (everything becomes zero).
// The Initialize event indexes poolId, so the backward lookup is cheap, and the result is
// stored so it is needed only once per pool.
Chain.prototype.poolKeyOfId = async function poolKeyOfId(poolId, hintBlock = null, hintTx = null) {
  const row = this.store.get('SELECT token0,token1,fee,tick_spacing,hooks FROM pools WHERE chain=? AND pool_ref=?', this.network, poolId);
  if (row && row.token0) {
    return { currency0: row.token0, currency1: row.token1, fee: row.fee, tickSpacing: row.tick_spacing, hooks: row.hooks };
  }

  // Fast path: the poolKey is usually written as it is inside the mint tx calldata
  // (MINT_POSITION passes its struct whole). Slide a 5-word window along the
  // calldata and match its hash against the poolId — purely local computation, no RPC.
  // The fee/tickSpacing combinations on this chain are too varied to guess, so
  // matching the hash is far more reliable than guessing the tier.
  if (hintTx) {
    const pk = await this.poolKeyFromCalldata(poolId, hintTx);
    if (pk) return pk;
  }

  const head = await this.rpc.blockNumber();
  const anchor = hintBlock || head;
  // A pool is always created BEFORE its position, so search backward from the hint block.
  const spans = [50_000, 500_000, 3_000_000, 12_000_000];
  for (const span of spans) {
    const lo = Math.max(0, anchor - span);
    let logs = [];
    try {
      logs = await this.rpc.getLogs({
        address: this.ADDR.poolManager, topics: [TOPIC.initializeV4, poolId],
        fromBlock: '0x' + lo.toString(16), toBlock: '0x' + Math.min(head, anchor + 10).toString(16),
      });
    } catch { continue; }
    if (!logs.length) continue;
    const l = logs[0];
    const b = ethers.getBytes(l.data);
    const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
    const pk = {
      currency0: ('0x' + l.topics[2].slice(-40)).toLowerCase(),
      currency1: ('0x' + l.topics[3].slice(-40)).toLowerCase(),
      fee: Number(w(0)),
      tickSpacing: Number(BigInt.asIntN(24, w(1))),
      hooks: '0x' + ethers.hexlify(b.slice(2 * 32 + 12, 3 * 32)).slice(2),
    };
    this.store.run(
      `INSERT INTO pools(chain,pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block,init_block,init_sqrt)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(chain,pool_ref) DO UPDATE SET
         token0=excluded.token0, token1=excluded.token1, fee=excluded.fee,
         tick_spacing=excluded.tick_spacing, hooks=excluded.hooks,
         first_block=excluded.first_block, init_block=excluded.init_block, init_sqrt=excluded.init_sqrt`,
      this.network, poolId, 'v4', pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks, parseInt(l.blockNumber, 16),
      parseInt(l.blockNumber, 16), w(3).toString());
    return pk;
  }
  return null;
};

// The birth price of a v4 pool: the block and sqrtPriceX96 from its Initialize event. As long as there
// has been no Swap, the pool price = this price — and a pool created then minted right away in
// one tx (the habit of wallets that launch their own token) has no state at the
// previous block nor a Swap to lean on, so this is the only source of its
// mint price. Searched backward from the hint block (a pool is always born before its event)
// and stored so it is needed only once per pool. null = not found (or the RPC failed).
Chain.prototype.poolInitOf = async function poolInitOf(poolId, hintBlock = null) {
  const row = this.store.get('SELECT init_block, init_sqrt FROM pools WHERE chain=? AND pool_ref=?', this.network, poolId);
  if (row && row.init_sqrt) return { block: row.init_block, sqrt: BigInt(row.init_sqrt) };
  const head = await this.rpc.blockNumber();
  const anchor = hintBlock || head;
  for (const span of [50_000, 500_000, 3_000_000, 12_000_000]) {
    const lo = Math.max(0, anchor - span);
    let logs = [];
    try {
      logs = await this.rpc.getLogs({
        address: this.ADDR.poolManager, topics: [TOPIC.initializeV4, poolId],
        fromBlock: '0x' + lo.toString(16), toBlock: '0x' + Math.min(head, anchor + 10).toString(16),
      });
    } catch { return null; }
    if (!logs.length) { if (lo === 0) return null; continue; }
    const l = logs[0];
    const b = ethers.getBytes(l.data);
    const init = { block: parseInt(l.blockNumber, 16), sqrt: BigInt(ethers.hexlify(b.slice(3 * 32, 4 * 32))) };
    this.store.run(
      `INSERT INTO pools(chain,pool_ref,venue,init_block,init_sqrt) VALUES(?,?,?,?,?)
       ON CONFLICT(chain,pool_ref) DO UPDATE SET init_block=excluded.init_block, init_sqrt=excluded.init_sqrt`,
      this.network, poolId, 'v4', init.block, init.sqrt.toString());
    return init;
  }
  return null;
};

Chain.prototype.poolKeyFromCalldata = async function poolKeyFromCalldata(poolId, txHash) {
  let tx;
  try { tx = await this.rpc.call('eth_getTransactionByHash', [txHash]); } catch { return null; }
  if (!tx || !tx.input || tx.input.length < 10 + 64 * 5) return null;
  const body = tx.input.slice(10);                 // drop the selector
  const words = body.length >> 6;                  // number of 32-byte words
  const wordAt = (i) => '0x' + body.slice(i * 64, i * 64 + 64);
  const addrOf = (w) => '0x' + w.slice(-40);
  for (let i = 0; i + 5 <= words; i++) {
    const c0 = wordAt(i), c1 = wordAt(i + 1), fe = wordAt(i + 2), ts = wordAt(i + 3), hk = wordAt(i + 4);
    // the first two words must look like addresses (the top 12 bytes zero)
    if (!/^0x0{24}/.test(c0) || !/^0x0{24}/.test(c1) || !/^0x0{24}/.test(hk)) continue;
    const fee = Number(BigInt(fe));
    if (!Number.isFinite(fee) || fee > 0xffffff) continue;
    const tick = Number(BigInt.asIntN(24, BigInt(ts)));
    if (!Number.isFinite(tick) || tick === 0 || Math.abs(tick) > 32767) continue;
    const pk = {
      currency0: addrOf(c0).toLowerCase(), currency1: addrOf(c1).toLowerCase(),
      fee, tickSpacing: tick, hooks: addrOf(hk).toLowerCase(),
    };
    if (computePoolId(pk) !== poolId) continue;
    this.store.run(
      `INSERT INTO pools(chain,pool_ref,venue,token0,token1,fee,tick_spacing,hooks) VALUES(?,?,?,?,?,?,?,?)
       ON CONFLICT(chain,pool_ref) DO UPDATE SET
         token0=excluded.token0, token1=excluded.token1, fee=excluded.fee,
         tick_spacing=excluded.tick_spacing, hooks=excluded.hooks`,
      this.network, poolId, 'v4', pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks);
    return pk;
  }
  return null;
};

// ---- pool age ------------------------------------------------------------
// The age only writes the birth block/time. The row used to be written INSERT OR REPLACE:
// columns not mentioned (token0/token1/fee/tick_spacing/hooks) also became NULL,
// so a pool whose metadata was already known turned into "?/?" on the pool page.
const AGE_UPSERT = `INSERT INTO pools(chain,pool_ref,venue,first_block,first_ts) VALUES(?,?,?,?,?)
  ON CONFLICT(chain,pool_ref) DO UPDATE SET first_block=excluded.first_block, first_ts=excluded.first_ts`;

// The Initialize event indexes poolId, so the per-pool search is cheap. If it is not
// found in the scan window, that pool is older than the window (and that is safe).
Chain.prototype.poolAgeMinutes = async function poolAgeMinutes(poolId, windowBlocks = 900_000) {
  const row = this.store.get('SELECT first_block, first_ts FROM pools WHERE chain=? AND pool_ref=?', this.network, poolId);
  if (row && row.first_ts) return (Date.now() - row.first_ts) / 60000;
  const head = await this.rpc.blockNumber();
  const from = Math.max(0, head - windowBlocks);
  let logs = [];
  try {
    logs = await this.rpc.getLogs({
      address: this.ADDR.poolManager, topics: [TOPIC.initializeV4, poolId],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16),
    });
  } catch { return Infinity; }
  if (!logs.length) {
    // older than the window: record as "very old" so it is not rescanned
    this.store.run(AGE_UPSERT, this.network, poolId, 'v4', from, Date.now() - windowBlocks * this.blockMs);
    return (windowBlocks * this.blockMs) / 60000;
  }
  const b = parseInt(logs[0].blockNumber, 16);
  const ts = await this.blockTs(b);
  this.store.run(AGE_UPSERT, this.network, poolId, 'v4', b, ts);
  return (Date.now() - ts) / 60000;
};

// Active liquidity of a v4 pool (slot +3), used to estimate the swap price impact.
Chain.prototype.poolLiquidityMany = async function poolLiquidityMany(poolIds) {
  if (!poolIds.length) return [];
  const words = await this.rpc.ethCallMany(poolIds.map((id) => {
    const slot = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, POOLS_SLOT]))) + 3n;
    return { to: this.ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', ['0x' + slot.toString(16).padStart(64, '0')]) };
  }));
  return words.map((w) => (w && w !== '0x' ? BigInt(w) & ((1n << 128n) - 1n) : 0n));
};

Chain.prototype.poolLiquidity = async function poolLiquidity(poolId) {
  const [L] = await this.poolLiquidityMany([poolId]);
  return L ?? 0n;
};

// ---- pair reference price ---------------------------------------------------
// A pool's price is not always fit for valuation. A pool whose active liquidity is zero
// (all LPs out of range, or one swap swept it empty) leaves sqrtPrice
// anywhere — it has gone as far as the maximum tick, 1e17× the fair price. Valuing fees/leftover
// tokens at that price produces a PnL of "$4e52". A fit price = active
// liquidity > 0 and the tick not stuck at a bound.
const TICK_EDGE = 887000;
const SQRT_EDGE_LO = m.getSqrtRatioAtTick(-TICK_EDGE), SQRT_EDGE_HI = m.getSqrtRatioAtTick(TICK_EDGE);
const sqrtSane = (s) => s != null && s > SQRT_EDGE_LO && s < SQRT_EDGE_HI;
function priceUsable(slot, liquidity) {
  return !!slot && liquidity > 0n && sqrtSane(slot.sqrtPriceX96);
}
// For a historical price (wallet research) there is no cheap reference pool to read; a price
// stuck at a bound is clamped to the edge of the position range — the last price the position
// really passed through. The token composition is the same (all on one side), only the
// value becomes sensible.
// Also clamped if the price is still "within the tick bounds" but >MARK_RATIO_MAX× outside the
// nearest edge — a pool left with 1 wei after a rug puts the price at 1e9× without touching the bound.
const MARK_RATIO_MAX = 1000n;
function sqrtClampedToRange(sqrt, sa, sb) {
  if (sqrt == null) return sqrt;
  const edge = sqrt < sa ? sa : sqrt > sb ? sb : null;
  if (edge == null) return sqrt;                       // inside the range: sane
  if (!sqrtSane(sqrt)) return edge;
  const hi = sqrt > edge ? sqrt : edge, lo = sqrt > edge ? edge : sqrt;
  return lo > 0n && hi * hi < lo * lo * MARK_RATIO_MAX ? sqrt : edge;   // price ratio = (√hi/√lo)²
}

// Reference price for a token pair: from another pool containing the same pair
// (pools table) whose price is fit, with the deepest liquidity. null if there is
// none — the caller decides the fallback. The result is held briefly: position syncs
// can be called back to back and the same pair need not be re-read.
Chain.prototype.markSqrtForPair = async function markSqrtForPair(token0, token1, skipRef) {
  const a = String(token0 || '').toLowerCase(), b = String(token1 || '').toLowerCase();
  // the excluded pool is also part of the key: same pair, position in a different pool
  const key = `${a}|${b}|${String(skipRef || '').toLowerCase()}`;
  const now = Date.now();
  this._markCache ??= new Map();
  const hit = this._markCache.get(key);
  if (hit && now - hit.at < 60_000) return hit.val;
  let val = null;
  try {
    const rows = this.store.all(`SELECT pool_ref, venue, token0, token1, pool_addr FROM pools
      WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?)) AND pool_ref<>?`, this.network, a, b, b, a, String(skipRef || '').toLowerCase());
    const v4 = rows.filter((r) => r.venue === 'v4');
    const v3 = rows.filter((r) => this.isV3Venue(r.venue) && r.pool_addr);
    const [slots4, liq4, res3] = await Promise.all([
      v4.length ? this.slot0V4Many(v4.map((r) => r.pool_ref)) : [],
      v4.length ? this.poolLiquidityMany(v4.map((r) => r.pool_ref)) : [],
      v3.length ? this.rpc.ethCallMany(v3.flatMap((r) => [
        { to: r.pool_addr, data: IF_POOL3.encodeFunctionData('slot0') },
        { to: r.pool_addr, data: IF_POOL3.encodeFunctionData('liquidity') },
      ])) : [],
    ]);
    let best = null;
    const consider = (row, slot, L) => {
      // the pool's token0/token1 can be inverted relative to the requested pair — the price must
      // be expressed in the caller's order.
      if (!priceUsable(slot, L)) return;
      if (best && L <= best.L) return;
      const flipped = row.token0 !== a;
      const sqrt = flipped ? (1n << 192n) / slot.sqrtPriceX96 : slot.sqrtPriceX96;
      best = { L, val: { sqrtPriceX96: sqrt, poolRef: row.pool_ref } };
    };
    v4.forEach((r, i) => consider(r, slots4[i], liq4[i] || 0n));
    v3.forEach((r, i) => {
      const w = res3[i * 2], wl = res3[i * 2 + 1];
      if (!w || w === '0x' || !wl || wl === '0x') return;
      try {
        const d = IF_POOL3.decodeFunctionResult('slot0', w);
        consider(r, { sqrtPriceX96: BigInt(d[0]), tick: Number(d[1]) }, BigInt(wl));
      } catch { /* pool unreadable: skip */ }
    });
    val = best ? best.val : null;
  } catch (e) {
    this.log(`harga acuan ${key}: ${e.message}`);
  }
  this._markCache.set(key, { at: now, val });
  return val;
};

module.exports.priceUsable = priceUsable;
module.exports.sqrtSane = sqrtSane;
module.exports.sqrtClampedToRange = sqrtClampedToRange;

// ---- ETH <-> USDG bridge pools -------------------------------------------
// Used to move cash between quote assets: if the target LPs in an ETH-quoted
// pool while our cash is USDG (or vice versa), this is the way.
// The one with the deepest liquidity is chosen so the price impact is smallest.
Chain.prototype.bestEthUsdgPool = async function bestEthUsdgPool() {
  const now = Date.now();
  if (this._bridge && now - this._bridgeAt < 300_000) return this._bridge;
  const head = await this.rpc.blockNumber();
  const pools = await this.findEthUsdgPools(head);
  const noHook = pools.filter((p) => /^0x0+$/.test(p.hooks));
  const list = (noHook.length ? noHook : pools).slice(0, 8);
  if (!list.length) return null;
  const slots = await this.slot0V4Many(list.map((p) => p.poolId));
  // One batch for all the liquidity — the previous version fired 8 times in sequence
  // and that is what caused timeouts when the indexer was busy.
  const liqWords = await this.rpc.ethCallMany(list.map((p) => ({
    to: this.ADDR.poolManager,
    data: IF_EXT.encodeFunctionData('extsload', [
      '0x' + (BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.poolId, POOLS_SLOT]))) + 3n)
        .toString(16).padStart(64, '0'),
    ]),
  })));
  // ALL candidates are returned, not just the deepest: on this chain the ETH/USDG pools
  // are almost always hooked and the hook can refuse a swap from the router, so the caller
  // simulates them one by one and falls down to the next candidate. A single pool
  // would kill this fallback entirely the moment the deepest pool happens to refuse.
  const cands = [];
  for (let i = 0; i < list.length; i++) {
    const s = slots[i];
    if (!s || s.sqrtPriceX96 === 0n) continue;
    const L = liqWords[i] && liqWords[i] !== '0x' ? BigInt(liqWords[i]) & ((1n << 128n) - 1n) : 0n;
    cands.push({
      poolId: list[i].poolId,
      poolKey: {
        currency0: this.ADDR.native, currency1: this.ADDR.usdg,
        fee: list[i].fee, tickSpacing: list[i].tickSpacing, hooks: list[i].hooks,
      },
      slot0: s, liquidity: L,
    });
  }
  // Deepest first: the smallest price impact.
  cands.sort((a, b) => (a.liquidity < b.liquidity ? 1 : a.liquidity > b.liquidity ? -1 : 0));
  const best = cands.length ? { ...cands[0], candidates: cands } : null;
  if (best) { this._bridge = best; this._bridgeAt = now; }
  return best;
};
