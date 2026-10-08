'use strict';
// Per-network profile: the only place that differs between chains (contract addresses,
// chain id, quote assets). Protocol-level constants (event topics, ABI, UniversalRouter
// opcodes) stay in chain.js — exactly the same on every standard Uniswap
// v3/v4 deployment and verbatim forks such as PancakeSwap v3.
//
// The ADDR slot names (poolManager/posmV4/npmV3/universalRouter/dexRouter/permit2/
// weth/usdg/native) are kept the same on all networks even though the assets differ —
// e.g. on BSC `weth` = the WBNB address and `usdg` = the USDT address — so existing code
// (`chain.ADDR.weth`, etc.) does not need to know the asset name per chain.
//
// `venues`: the list of v3 deployments scanned on this chain. Robinhood Chain has
// only one (that chain's built-in Uniswap v3 fork). BSC has two: official Uniswap v3
// AND PancakeSwap v3 (a v3 fork with identical ABI/events) — both are scanned
// as separate venues but through the same v3 code path.

const NATIVE = '0x0000000000000000000000000000000000000000';

const ROBINHOOD = {
  key: 'robinhood',
  label: 'Robinhood Chain',
  chainId: 4663,
  nativeSymbol: 'ETH',
  kyberPath: 'robinhood',
  blockMs: 101,   // ~0.1 second per block
  addr: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    posmV4: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    npmV3: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
    dexRouter: '0x6e2a35a7ad683cf634d91492d73bb7ff774c6919',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG, 6 decimals
    weth: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH9
    native: NATIVE,
  },
  quoteMeta: {
    usdg: { symbol: 'USDG', decimals: 6, kind: 'usd' },
    weth: { symbol: 'WETH', decimals: 18, kind: 'eth' },
    native: { symbol: 'ETH', decimals: 18, kind: 'eth' },
  },
  venues: [
    { key: 'v3', npmV3Slot: 'npmV3', factory: null },
  ],
  nativeUsd: { mode: 'global' }, // global spot price (Coinbase/Binance/CoinGecko median); falls back to the native/usdg v4 pools (pools.js Chain#ethUsd)
  verified: true, // addresses verified directly from the chain + Blockscout (see git log)
  explorerApiV2: 'https://robinhoodchain.blockscout.com/api/v2',
  explorerTokenUrl: (a) => `https://robinhoodchain.blockscout.com/token/${a}?tab=holders`,
  alchemyHost: 'robinhood-mainnet.g.alchemy.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood',   // chain slug on DexScreener
  geckoterminal: 'robinhood', // network slug on GeckoTerminal
  gmgn: 'robinhood',          // chain slug on GMGN (gmgn.ai/<slug>/token/<address>) & fomo
  uniswap: 'robinhood',       // chain slug on app.uniswap.org (?chain=<slug>)
};

const BSC = {
  key: 'bsc',
  label: 'BNB Smart Chain',
  chainId: 56,
  nativeSymbol: 'BNB',
  kyberPath: 'bsc',
  blockMs: 750,   // ~0.75 second per block (Maxwell hardfork 2025)
  addr: {
    // Uniswap v4 on BSC
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    posmV4: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
    universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
    // Uniswap v3 on BSC (main venue 'v3')
    npmV3: '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',
    // KyberSwap MetaAggregationRouterV2 — same address on every supported chain
    dexRouter: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    // Generic slots "main quote stablecoin" / "wrapped native" — used as
    // they are by existing code (chain.ADDR.usdg / chain.ADDR.weth).
    usdg: '0x55d398326f99059ff775485246999027b3197955', // USDT (BEP-20), 18 decimals
    weth: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    native: NATIVE,
    // Second venue: PancakeSwap v3 (a v3 fork, factory & NPM differ from Uniswap)
    pancakeNpmV3: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
    pancakeFactoryV3: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
    uniswapFactoryV3: '0xdb1d10011ad0ff90774d0c6bb92e5c5c8b4461f7',
  },
  quoteMeta: {
    usdg: { symbol: 'USDT', decimals: 18, kind: 'usd' },
    weth: { symbol: 'WBNB', decimals: 18, kind: 'eth' },
    native: { symbol: 'BNB', decimals: 18, kind: 'eth' },
  },
  venues: [
    { key: 'v3', npmV3Slot: 'npmV3', factory: 'uniswapFactoryV3' },
    { key: 'pancakev3', npmV3Slot: 'pancakeNpmV3', factory: 'pancakeFactoryV3' },
  ],
  // BNB price from the deepest PancakeSwap v3 USDT/WBNB pool (0.01% and 0.05%), read
  // via slot0 + liquidity — verified 2026-09-19: token0 USDT, token1 WBNB,
  // both agree ±0.01%. The deepest is used, unless it deviates from the others.
  nativeUsd: { mode: 'v3pools', pools: ['0x172fcd41e0913e95784454622d1c3724f546f849', '0x36696169c63e42cd08ce11f5deebbcebae652050'] },
  // BSC: baseFeePerGas is always 0, so the tip of a type-2 tx = the effective gas price (executor.js gasFees).
  legacyGasPricing: true,
  // Addresses from the official Uniswap/PancakeSwap/KyberSwap documentation, VERIFIED
  // on-chain 2026-09-18 via `node src/verify-chain.js bsc` (chain id, bytecode of each
  // contract, NPM.factory() == factory, posmV4.poolManager() == PoolManager, USDT/WBNB
  // symbol & decimals — 23 checks passed). Repeat if any address is changed.
  verified: true,
  // No BSC Blockscout instance has been paired with this project yet — the "holders" feature
  // (token holder distribution via Blockscout) is not yet supported on BSC, it is just skipped.
  explorerApiV2: null,
  explorerTokenUrl: null,
  alchemyHost: 'bnb-mainnet.g.alchemy.com',
  explorer: 'https://bscscan.com',
  dexscreener: 'bsc',
  geckoterminal: 'bsc',
  gmgn: 'bsc',
  uniswap: 'bnb',
};

// ---- Uniswap-only chains (v4 + the canonical Uniswap v3 deployment) --------------------
// Added 2026-10-08. Every address below was cross-checked on-chain (`node src/verify-chain.js
// <chain>`): chain id, bytecode, NPM.factory() == factory, posmV4.poolManager() == PoolManager,
// USDC/wrapped-native symbol & decimals. `usdg` = native USDC (6 decimals), `weth` = the wrapped
// native token. Native price comes from the deepest USDC/wrapped-native Uniswap v3 pools.
const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
const KYBER_ROUTER = '0x6131b5fae19ea4f9d964eac0408e4408b66337b5'; // same address on every Kyber chain
const lc = (a) => a.toLowerCase();

function uniswapChain(o) {
  return {
    key: o.key,
    label: o.label,
    chainId: o.chainId,
    nativeSymbol: o.nativeSymbol,
    kyberPath: o.kyberPath || o.key,
    blockMs: o.blockMs,
    addr: {
      poolManager: lc(o.poolManager), posmV4: lc(o.posmV4), universalRouter: lc(o.universalRouter),
      npmV3: lc(o.npmV3), dexRouter: KYBER_ROUTER, permit2: PERMIT2,
      usdg: lc(o.usdc), weth: lc(o.wrapped), native: NATIVE,
      uniswapFactoryV3: lc(o.factoryV3),
    },
    quoteMeta: {
      usdg: { symbol: 'USDC', decimals: 6, kind: 'usd' },
      weth: { symbol: o.wrappedSymbol, decimals: 18, kind: 'eth' },
      native: { symbol: o.nativeSymbol, decimals: 18, kind: 'eth' },
    },
    venues: [{ key: 'v3', npmV3Slot: 'npmV3', factory: 'uniswapFactoryV3' }],
    nativeUsd: { mode: 'v3pools', pools: o.nativeUsdPools.map(lc) },
    verified: true,
    explorerApiV2: null,
    explorerTokenUrl: null,
    alchemyHost: o.alchemyHost || null,
    explorer: o.explorer,
    dexscreener: o.dexscreener || o.key,
    geckoterminal: o.geckoterminal || o.key,
    gmgn: o.gmgn || o.key,
    uniswap: o.uniswap || o.key,
  };
}

const ETHEREUM = uniswapChain({
  key: 'ethereum', label: 'Ethereum', chainId: 1, nativeSymbol: 'ETH', blockMs: 12000,
  poolManager: '0x000000000004444c5dc75cB358380D2e3dE08A90', posmV4: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e',
  universalRouter: '0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85',
  npmV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factoryV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  usdc: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', wrapped: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', wrappedSymbol: 'WETH',
  nativeUsdPools: ['0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640', '0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8'],
  alchemyHost: 'eth-mainnet.g.alchemy.com', explorer: 'https://etherscan.io', geckoterminal: 'eth', gmgn: 'eth',
});
const BASE = uniswapChain({
  key: 'base', label: 'Base', chainId: 8453, nativeSymbol: 'ETH', blockMs: 2000,
  poolManager: '0x498581ff718922c3f8e6a244956af099b2652b2b', posmV4: '0x7c5f5a4bbd8fd63184577525326123b519429bdc',
  universalRouter: '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40',
  npmV3: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', factoryV3: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', wrapped: '0x4200000000000000000000000000000000000006', wrappedSymbol: 'WETH',
  nativeUsdPools: ['0xd0b53d9277642d899df5c87a3966a349a798f224', '0x6c561b446416e1a00e8e93e221854d6ea4171372'],
  alchemyHost: 'base-mainnet.g.alchemy.com', explorer: 'https://basescan.org',
});
const ARBITRUM = uniswapChain({
  key: 'arbitrum', label: 'Arbitrum One', chainId: 42161, nativeSymbol: 'ETH', blockMs: 250,
  poolManager: '0x360e68faccca8ca495c1b759fd9eee466db9fb32', posmV4: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869',
  universalRouter: '0x2d01411773c8C24805306E89A41F7855C3c4Fe65',
  npmV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factoryV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', wrapped: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', wrappedSymbol: 'WETH',
  nativeUsdPools: ['0xc6962004f452be9203591991d15f6b388e09e8d0', '0xc473e2aee3441bf9240be85eb122abb059a3b57c'],
  alchemyHost: 'arb-mainnet.g.alchemy.com', explorer: 'https://arbiscan.io', geckoterminal: 'arbitrum', gmgn: 'arbitrum',
});
const OPTIMISM = uniswapChain({
  key: 'optimism', label: 'Optimism', chainId: 10, nativeSymbol: 'ETH', blockMs: 2000,
  poolManager: '0x9a13f98cb987694c9f086b1f5eb990eea8264ec3', posmV4: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017',
  universalRouter: '0xC09255D86DB563cBc11C2fCf4a0C512e160111B4',
  npmV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factoryV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  usdc: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', wrapped: '0x4200000000000000000000000000000000000006', wrappedSymbol: 'WETH',
  nativeUsdPools: ['0x1fb3cf6e48f1e7b10213e7b6d87d4c073c7fdb7b', '0xc1738d90e2e26c35784a0d3e3d8a9f795074bca4'],
  alchemyHost: 'opt-mainnet.g.alchemy.com', explorer: 'https://optimistic.etherscan.io',
});
const POLYGON = uniswapChain({
  key: 'polygon', label: 'Polygon', chainId: 137, nativeSymbol: 'POL', blockMs: 2000,
  poolManager: '0x67366782805870060151383f4bbff9dab53e5cd6', posmV4: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9',
  universalRouter: '0xDc264714F68d84CF29BC605589405E78bDBE7C9f',
  npmV3: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88', factoryV3: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
  usdc: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', wrapped: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270', wrappedSymbol: 'WPOL',
  nativeUsdPools: ['0xb6e57ed85c4c9dbfef2a68711e9d6f36c56e0fcb', '0x2db87c4831b2fec2e35591221455834193b50d1b'],
  alchemyHost: 'polygon-mainnet.g.alchemy.com', explorer: 'https://polygonscan.com',
  geckoterminal: 'polygon_pos', gmgn: 'polygon',
});
const AVALANCHE = uniswapChain({
  key: 'avalanche', label: 'Avalanche C-Chain', chainId: 43114, nativeSymbol: 'AVAX', blockMs: 2000,
  poolManager: '0x06380c0e0912312b5150364b9dc4542ba0dbbc85', posmV4: '0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd',
  universalRouter: '0x94b75331ae8d42c1b61065089b7d48fe14aa73b7',
  npmV3: '0x655C406EBFa14EE2006250925e54ec43AD184f8B', factoryV3: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD',
  usdc: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', wrapped: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7', wrappedSymbol: 'WAVAX',
  nativeUsdPools: ['0xfae3f424a0a47706811521e3ee268f00cfb5c45e', '0x0e663593657b064e1bae76d28625df5d0ebd4421'],
  alchemyHost: 'avax-mainnet.g.alchemy.com', explorer: 'https://snowtrace.io', geckoterminal: 'avax', gmgn: 'avalanche',
});

// Solana: not EVM at all — its own engine (src/solana/), not pools.js/
// watcher.js/executor.js. The profile still uses the same slot names (usdg = USDC,
// weth = wSOL) so the dashboard, policy and PnL bookkeeping reading `chain.ADDR.usdg`
// / `chain.QUOTES` need not know the difference. Solana addresses = base58 and CASE-SENSITIVE —
// never lower-cased (see normAddr).
//
// `venues`: three concentrated-liquidity LP programs. Positions on all three are normalised to
// Uniswap units (1.0001 ticks, sqrtPriceX96) in their adapters (src/solana/venues/),
// so the tick_lower/tick_upper/entry_sqrt columns and the dashboard price formula apply as
// is. Orca & Raydium really use 1.0001 ticks + Q64.64 sqrt; Meteora DLMM bins are
// converted (see src/solana/units.js).
const WSOL = 'So11111111111111111111111111111111111111112';
const SOLANA = {
  key: 'solana',
  kind: 'solana',
  label: 'Solana',
  chainId: null,
  nativeSymbol: 'SOL',
  kyberPath: null,
  blockMs: 400,   // ~0,4 detik per slot
  addr: {
    usdg: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC, 6 desimal
    usdt: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT, 6 desimal
    weth: WSOL,   // wSOL — the mint pools use for SOL
    native: WSOL, // native SOL has no mint; the lamport balance is valued the same as wSOL
  },
  quoteMeta: {
    usdg: { symbol: 'USDC', decimals: 6, kind: 'usd' },
    usdt: { symbol: 'USDT', decimals: 6, kind: 'usd' },
    weth: { symbol: 'SOL', decimals: 9, kind: 'eth' },
  },
  venues: [
    { key: 'meteora', program: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', label: 'Meteora DLMM' },
    { key: 'orca', program: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', label: 'Orca Whirlpools' },
    { key: 'raydium', program: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', label: 'Raydium CLMM' },
  ],
  nativeUsd: { mode: 'jupiter' },
  // Program IDs from the official SDKs (@meteora-ag/dlmm, @orca-so/whirlpools-sdk,
  // @raydium-io/raydium-sdk-v2) and the USDC/USDT/wSOL mints from the official token registry;
  // checked against mainnet with `node src/solana/verify.js`.
  verified: true,
  explorerApiV2: null,
  explorerTokenUrl: (a) => `https://solscan.io/token/${a}#holders`,
  alchemyHost: 'solana-mainnet.g.alchemy.com',
  explorer: 'https://solscan.io',
  dexscreener: 'solana',
  geckoterminal: 'solana',
  gmgn: 'sol',
  uniswap: null,
};

const NETWORKS = { robinhood: ROBINHOOD, bsc: BSC, ethereum: ETHEREUM, base: BASE, arbitrum: ARBITRUM, optimism: OPTIMISM, polygon: POLYGON, avalanche: AVALANCHE, solana: SOLANA };

const isSolana = (key) => NETWORKS[key]?.kind === 'solana';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// An address in its chain's canonical form: EVM lower-cased (as throughout the old
// code), Solana left as is (base58 is case-sensitive). null when invalid.
function normAddr(key, a) {
  const s = String(a ?? '').trim();
  if (isSolana(key)) return BASE58.test(s) ? s : null;
  const l = s.toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(l) ? l : null;
}
// An address error message that fits the chain.
const addrHint = (key) => (isSolana(key) ? 'alamat Solana (base58, 32–44 karakter)' : 'alamat harus 0x diikuti 40 karakter hex');

function profile(key) {
  const p = NETWORKS[key];
  if (!p) throw new Error(`jaringan tidak dikenal: ${key}`);
  return p;
}

// Build ADDR/QUOTES/venues from a profile — used by pools.js Chain.
function build(key) {
  const p = profile(key);
  const ADDR = { ...p.addr };
  const QUOTES = {};
  for (const [slot, meta] of Object.entries(p.quoteMeta)) {
    const addr = ADDR[slot];
    if (addr) QUOTES[addr] = meta;
  }
  const venues = p.venues.map((v) => ({
    key: v.key,
    npmV3: v.npmV3Slot ? ADDR[v.npmV3Slot] : null,
    factory: v.factory ? ADDR[v.factory] : null,
    ...(v.program ? { program: v.program, label: v.label } : {}),
  }));
  return {
    kind: p.kind || 'evm',
    network: key, label: p.label, ADDR, QUOTES, CHAIN_ID: p.chainId, venues,
    nativeSymbol: p.nativeSymbol, kyberPath: p.kyberPath, nativeUsd: p.nativeUsd || { mode: 'v4pool' }, verified: p.verified,
    explorerApiV2: p.explorerApiV2, explorerTokenUrl: p.explorerTokenUrl, alchemyHost: p.alchemyHost,
    legacyGasPricing: !!p.legacyGasPricing, blockMs: p.blockMs || 101,
    dexscreener: p.dexscreener, geckoterminal: p.geckoterminal, gmgn: p.gmgn, uniswap: p.uniswap, explorer: p.explorer,
  };
}

// Complete a chain object that is not a pools.js Chain instance (a mock in tests, an old object)
// with the Robinhood profile: ADDR/QUOTES/venues and the helpers isEthLike/isV3Venue/npmFor.
// A real Chain instance is returned as it is. If what is passed is actually an RpcPool
// (the old signature unclaimedV4(rpc, …)), it is wrapped into a chain with that rpc.
function ensureChain(x) {
  if (x && x.ADDR && typeof x.isV3Venue === 'function') return x;
  const isRpc = x && typeof x.ethCallMany === 'function' && !x.ADDR;
  const target = isRpc || !x ? { rpc: isRpc ? x : null } : x;
  const p = build('robinhood');
  for (const k of ['network', 'label', 'ADDR', 'QUOTES', 'CHAIN_ID', 'venues', 'nativeSymbol', 'kyberPath', 'verified',
    'explorerApiV2', 'explorerTokenUrl', 'alchemyHost', 'legacyGasPricing', 'blockMs', 'dexscreener', 'geckoterminal', 'explorer']) {
    if (target[k] === undefined) target[k] = p[k];
  }
  if (target.usdgSymbol === undefined) target.usdgSymbol = target.QUOTES[target.ADDR.usdg]?.symbol || 'USDG';
  if (target.usdgDecimals === undefined) target.usdgDecimals = target.QUOTES[target.ADDR.usdg]?.decimals ?? 6;
  if (target.wethSymbol === undefined) target.wethSymbol = target.QUOTES[target.ADDR.weth]?.symbol || 'WETH';
  if (typeof target.isEthLike !== 'function') target.isEthLike = (sym) => sym === target.nativeSymbol || sym === target.wethSymbol;
  if (typeof target.isV3Venue !== 'function') target.isV3Venue = (v) => target.venues.some((x) => x.key === v);
  // The quote-asset side of a pair — a pure function over QUOTES, exactly the same as
  // Pools.quoteSideOf. Used by the fee/leftover path to separate "money" from memecoin.
  if (typeof target.quoteSideOf !== 'function') {
    target.quoteSideOf = (t0, t1) => {
      const q0 = target.QUOTES[(t0 || '').toLowerCase()], q1 = target.QUOTES[(t1 || '').toLowerCase()];
      if (q0) return { side: 0, ...q0 };
      if (q1) return { side: 1, ...q1 };
      return null;
    };
  }
  if (typeof target.venueOf !== 'function') target.venueOf = (v) => target.venues.find((x) => x.key === v) || null;
  if (typeof target.npmFor !== 'function') target.npmFor = (v) => target.venueOf(v)?.npmV3 || target.ADDR.npmV3;
  return target;
}

module.exports = { NETWORKS, profile, build, ensureChain, isSolana, normAddr, addrHint, WSOL };
