'use strict';
// Profil per jaringan: satu-satunya tempat yang beda antar chain (alamat kontrak,
// chain id, aset kuotasi). Konstanta level-protokol (topic event, ABI, opcode
// UniversalRouter) tetap di chain.js — sama persis di semua deployment Uniswap
// v3/v4 standar dan fork verbatim seperti PancakeSwap v3.
//
// Nama slot ADDR (poolManager/posmV4/npmV3/universalRouter/dexRouter/permit2/
// weth/usdg/native) dipertahankan sama di semua network meski asetnya beda —
// mis. di BSC `weth` = alamat WBNB dan `usdg` = alamat USDT — supaya kode yang
// sudah ada (`chain.ADDR.weth`, dst.) tidak perlu tahu nama aset per chain.
//
// `venues`: daftar deployment v3 yang dipindai di chain ini. Robinhood Chain
// cuma satu (Uniswap v3 fork bawaan chain itu). BSC punya dua: Uniswap v3 resmi
// DAN PancakeSwap v3 (fork v3 dengan ABI/event identik) — keduanya dipindai
// sebagai venue terpisah tapi lewat jalur kode v3 yang sama.

const NATIVE = '0x0000000000000000000000000000000000000000';

const ROBINHOOD = {
  key: 'robinhood',
  label: 'Robinhood Chain',
  chainId: 4663,
  nativeSymbol: 'ETH',
  kyberPath: 'robinhood',
  blockMs: 101,   // ~0,1 detik per blok
  addr: {
    poolManager: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
    posmV4: '0x58daec3116aae6d93017baaea7749052e8a04fa7',
    npmV3: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    universalRouter: '0x8876789976decbfcbbbe364623c63652db8c0904',
    dexRouter: '0x6e2a35a7ad683cf634d91492d73bb7ff774c6919',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG, 6 desimal
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
  nativeUsd: { mode: 'v4pool' }, // cari pool native/usdg v4 terdalam (pools.js Chain#ethUsd)
  verified: true, // alamat diverifikasi langsung dari chain + Blockscout (lihat git log)
  explorerApiV2: 'https://robinhoodchain.blockscout.com/api/v2',
  explorerTokenUrl: (a) => `https://robinhoodchain.blockscout.com/token/${a}?tab=holders`,
  alchemyHost: 'robinhood-mainnet.g.alchemy.com',
  explorer: 'https://robinhoodchain.blockscout.com',
  dexscreener: 'robinhood',   // slug chain di DexScreener
  geckoterminal: 'robinhood', // slug network di GeckoTerminal
  gmgn: 'robinhood',          // slug chain di GMGN (gmgn.ai/<slug>/token/<alamat>) & fomo
  uniswap: 'robinhood',       // slug chain di app.uniswap.org (?chain=<slug>)
};

const BSC = {
  key: 'bsc',
  label: 'BNB Smart Chain',
  chainId: 56,
  nativeSymbol: 'BNB',
  kyberPath: 'bsc',
  blockMs: 750,   // ~0,75 detik per blok (Maxwell hardfork 2025)
  addr: {
    // Uniswap v4 di BSC
    poolManager: '0x28e2ea090877bf75740558f6bfb36a5ffee9e9df',
    posmV4: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b',
    universalRouter: '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
    // Uniswap v3 di BSC (venue utama 'v3')
    npmV3: '0x7b8a01b39d58278b5de7e48c8449c9f4f5170613',
    // KyberSwap MetaAggregationRouterV2 — alamat sama di semua chain yang didukung
    dexRouter: '0x6131b5fae19ea4f9d964eac0408e4408b66337b5',
    permit2: '0x000000000022d473030f116ddee9f6b43ac78ba3',
    // Slot generik "stablecoin kuotasi utama" / "wrapped native" — dipakai apa
    // adanya oleh kode yang sudah ada (chain.ADDR.usdg / chain.ADDR.weth).
    usdg: '0x55d398326f99059ff775485246999027b3197955', // USDT (BEP-20), 18 desimal
    weth: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', // WBNB
    native: NATIVE,
    // Venue kedua: PancakeSwap v3 (fork v3, factory & NPM berbeda dari Uniswap)
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
  // Harga BNB dari pool PancakeSwap v3 USDT/WBNB terdalam (0,01% dan 0,05%), dibaca
  // lewat slot0 + liquidity — diverifikasi 2026-09-19: token0 USDT, token1 WBNB,
  // keduanya sepakat ±0,01%. Yang terdalam dipakai, kecuali menyimpang dari yang lain.
  nativeUsd: { mode: 'v3pools', pools: ['0x172fcd41e0913e95784454622d1c3724f546f849', '0x36696169c63e42cd08ce11f5deebbcebae652050'] },
  // BSC: baseFeePerGas selalu 0, jadi tip tx tipe-2 = harga gas efektif (executor.js gasFees).
  legacyGasPricing: true,
  // Alamat dari dokumentasi resmi Uniswap/PancakeSwap/KyberSwap, DIVERIFIKASI
  // on-chain 2026-09-18 lewat `node src/verify-chain.js bsc` (chain id, bytecode tiap
  // kontrak, NPM.factory() == factory, posmV4.poolManager() == PoolManager, simbol &
  // desimal USDT/WBNB — 23 pemeriksaan lolos). Ulangi kalau ada alamat yang diubah.
  verified: true,
  // Belum ada instance Blockscout BSC yang dipasangkan proyek ini — fitur "holders"
  // (distribusi pemegang token lewat Blockscout) belum didukung di BSC, cuma dilewati.
  explorerApiV2: null,
  explorerTokenUrl: null,
  alchemyHost: 'bnb-mainnet.g.alchemy.com',
  explorer: 'https://bscscan.com',
  dexscreener: 'bsc',
  geckoterminal: 'bsc',
  gmgn: 'bsc',
  uniswap: 'bnb',
};

const NETWORKS = { robinhood: ROBINHOOD, bsc: BSC };

function profile(key) {
  const p = NETWORKS[key];
  if (!p) throw new Error(`jaringan tidak dikenal: ${key}`);
  return p;
}

// Bangun ADDR/QUOTES/venues dari profil — dipakai oleh pools.js Chain.
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
    npmV3: ADDR[v.npmV3Slot],
    factory: v.factory ? ADDR[v.factory] : null,
  }));
  return {
    network: key, label: p.label, ADDR, QUOTES, CHAIN_ID: p.chainId, venues,
    nativeSymbol: p.nativeSymbol, kyberPath: p.kyberPath, nativeUsd: p.nativeUsd || { mode: 'v4pool' }, verified: p.verified,
    explorerApiV2: p.explorerApiV2, explorerTokenUrl: p.explorerTokenUrl, alchemyHost: p.alchemyHost,
    legacyGasPricing: !!p.legacyGasPricing, blockMs: p.blockMs || 101,
    dexscreener: p.dexscreener, geckoterminal: p.geckoterminal, gmgn: p.gmgn, uniswap: p.uniswap, explorer: p.explorer,
  };
}

// Lengkapi objek chain yang bukan instance pools.js Chain (mock di uji, objek lama)
// dengan profil Robinhood: ADDR/QUOTES/venues dan pembantu isEthLike/isV3Venue/npmFor.
// Instance Chain sungguhan dikembalikan apa adanya. Kalau yang diberikan justru RpcPool
// (tanda tangan lama unclaimedV4(rpc, …)), dibungkus jadi chain dengan rpc itu.
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
  // Sisi aset kuotasi sebuah pasangan — fungsi murni atas QUOTES, sama persis dengan
  // Pools.quoteSideOf. Dipakai jalur fee/sisa untuk memisahkan "uang" dari memecoin.
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

module.exports = { NETWORKS, profile, build, ensureChain };
