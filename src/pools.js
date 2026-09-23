'use strict';
// Pembaca state pool + cache metadata token, untuk v4 (PoolManager.extsload) dan v3 (slot0).
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { build } = require('./networks');
const m = require('./v3math');

const coder = ethers.AbiCoder.defaultAbiCoder();
const IF_EXT = new ethers.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);
const IF_ERC20 = new ethers.Interface(ABI.erc20);
const IF_POOL3 = new ethers.Interface(ABI.poolV3);
const IF_FACT = new ethers.Interface(ABI.v3Factory);

// Slot mapping `_pools` di PoolManager v4 — diverifikasi di Robinhood Chain:
// keccak256(abi.encode(poolId, uint256(6))) berisi Slot0 terpaket.
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
    // Slot generik "stablecoin kuotasi" (usdg) dan "wrapped native" (weth): simbol dan
    // desimalnya beda per chain (USDG 6 desimal vs USDT BSC 18 desimal).
    this.usdgSymbol = this.QUOTES[this.ADDR.usdg]?.symbol || 'USDG';
    this.usdgDecimals = this.QUOTES[this.ADDR.usdg]?.decimals ?? 6;
    this.wethSymbol = this.QUOTES[this.ADDR.weth]?.symbol || 'WETH';
    this.tokenCache = new Map();
    this.poolCache = new Map();
    this.v3Factory = null;
    this.v3FactoryByNpm = new Map(); // npmV3 addr -> factory addr (venue lain, mis. pancakev3)
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
      // strict: galat RPC sementara (kuota) melempar, BUKAN jadi "decimals 18". Dulu
      // pembacaan yang gagal disimpan permanen ke tabel tokens — token 9 desimal (NUKE)
      // yang sempat terbaca 18 akan dinilai 10⁹× salah selamanya: ukuran posisi, batas
      // $ per posisi, dan PnL ikut ngawur. decimals() yang benar-benar revert (token
      // non-standar) tetap jatuh ke 18, tapi hasil yang tidak terbaca tidak disimpan.
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
        // Tanpa symbol DAN decimals: kemungkinan besar bukan jawaban sah (node tertinggal
        // belum mengenal kontraknya) — dipakai sekali, tidak disimpan, dibaca ulang nanti.
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

  // ---- state pool v4 ------------------------------------------------------
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

  // ---- state pool v3 ------------------------------------------------------
  async slot0V3(poolAddr) {
    const [w] = await this.rpc.ethCallMany([{ to: poolAddr, data: IF_POOL3.encodeFunctionData('slot0') }]);
    if (!w || w === '0x') return null;
    try {
      const d = IF_POOL3.decodeFunctionResult('slot0', w);
      return { sqrtPriceX96: d[0], tick: Number(d[1]), lpFee: 0 };
    } catch { return null; }
  }

  // npmAddr: alamat NonfungiblePositionManager venue yang dimaksud (default: venue
  // 'v3' utama). Dipakai untuk venue v3 kedua di chain yang punya lebih dari satu
  // deployment v3 (mis. BSC: Uniswap v3 dan PancakeSwap v3).
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

  // ---- penilaian ----------------------------------------------------------
  // Nilai posisi dalam aset kuotasi pool. Kalau tidak ada sisi kuotasi yang dikenal,
  // nilai ditaksir lewat sisi kuotasi saja (token spekulatif dihargai dari harga pool).
  // Simbol yang dikonversi lewat harga native chain (chain.ethUsd()) — native coin-nya
  // sendiri dan bentuk wrapped-nya. Nama field/metode ini dipertahankan "eth" karena
  // konsepnya sama persis di semua chain EVM (BNB/WBNB di BSC, dst).
  isEthLike(symbol) {
    return symbol === this.nativeSymbol || symbol === this.QUOTES[this.ADDR.weth]?.symbol;
  }

  // Venue v3 (posisi NFT lewat NonfungiblePositionManager): 'v3' di semua chain, plus
  // deployment v3 lain di chain yang punya lebih dari satu (BSC: 'pancakev3'). Semua
  // berjalan lewat jalur kode v3 yang sama, cuma alamat NPM/factory-nya berbeda.
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

  // Nilai total posisi (kedua sisi) dalam satuan aset kuotasi.
  valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
    const q = this.quoteSideOf(token0, token1);
    if (!q) return null;
    const price1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1); // token1 per token0
    const a0 = Number(amount0) / 10 ** dec0;
    const a1 = Number(amount1) / 10 ** dec1;
    const val = q.side === 0 ? a0 + a1 / price1per0 : a1 + a0 * price1per0;
    return { value: val, symbol: q.symbol, side: q.side, kind: q.kind };
  }

  // Perkiraan timestamp blok — blok RH chain ~0,101 detik, tapi kita tetap ambil
  // acuan asli sesekali supaya tidak melenceng jauh.
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

// ---- harga ETH dalam USDG -------------------------------------------------
// Diturunkan sendiri dari pool ETH-native/USDG di chain ini (tidak perlu sumber luar).
// Pool-nya ditemukan lewat event Initialize yang mengindeks currency0 & currency1.
const { TOPIC } = require('./chain');

Chain.prototype.findEthUsdgPools = async function findEthUsdgPools(headBlock, blocks = 4_000_000) {
  const stateKey = `eth_usdg_pools:${this.network}`;
  const cached = this.store.getState(stateKey);
  if (cached) { try { return JSON.parse(cached); } catch { /* lanjut pindai */ } }
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
    } catch { /* rentang terlalu besar: lewati potongan ini */ }
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
  if (found.length) this.store.setState(stateKey, JSON.stringify(found));
  return found;
};

Chain.prototype.ethUsd = async function ethUsd(fallback = 2500) {
  const now = Date.now();
  if (this._ethUsd && now - this._ethUsdAt < 60_000) return this._ethUsd;
  // Chain yang harga native-nya dibaca dari pool v3 tertentu (BSC: PancakeSwap v3
  // USDT/WBNB) — lihat ethUsdFromV3Pools. Mode 'manual': harga dari config saja.
  if (this.nativeUsdMode === 'v3pools') return this.ethUsdFromV3Pools(fallback, now);
  if (this.nativeUsdMode !== 'v4pool') return this._ethUsd ?? fallback;
  try {
    const head = await this.rpc.blockNumber();
    const pools = await this.findEthUsdgPools(head);
    const noHook = pools.filter((p) => /^0x0+$/.test(p.hooks));
    const list = (noHook.length ? noHook : pools).slice(0, 8);
    if (!list.length) return fallback;
    const slots = await this.slot0V4Many(list.map((p) => p.poolId));
    // pilih pool dengan likuiditas terbesar
    const liqCalls = list.map((p) => ({
      to: this.ADDR.poolManager,
      data: IF_EXT.encodeFunctionData('extsload', [
        '0x' + (BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.poolId, POOLS_SLOT]))) + 3n).toString(16).padStart(64, '0'),
      ]),
    }));
    const liqs = await this.rpc.ethCallMany(liqCalls);
    // Kandidat: pool berlikuiditas aktif > 0 dan harga wajar (tick tidak menempel di
    // batas). currency0 = ETH(18), currency1 = USDG(6) -> harga = USDG per ETH.
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
    if (pick.outlier) this.log(`harga ETH: pool terdalam $${pick.outlier.toFixed(0)} menyimpang dari pool lain — dipakai median $${pick.price.toFixed(0)}`);
    this._ethUsd = pick.price; this._ethUsdAt = now; this._ethPoolId = pick.poolId;
    return pick.price;
  } catch { return fallback; }
};

// Harga native dari pool v3 yang ditetapkan di profil (nativeUsd.pools): slot0 +
// liquidity tiap pool dalam satu batch, dinyatakan sebagai USD per native menurut sisi
// mana yang stablecoin (slot usdg). Pemilihan & pagar outlier sama dengan jalur v4.
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
      // priceFromSqrt = token1 per token0. USD per native = token0 per token1 kalau token0 stablecoin.
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

// Harga ETH dari daftar pool kandidat: pool terdalam, KECUALI harganya menyimpang > 3%
// dari median tiga pool terdalam — satu pool yang baru saja disapu (atau salah baca dari
// node tertinggal) tidak boleh menggeser semua batas dolar, ukuran posisi, dan PnL.
// Balikan { price, poolId, outlier } — outlier = harga pool terdalam yang ditolak.
Chain.pickEthPrice = function pickEthPrice(cands) {
  if (!cands.length) return null;
  const top = [...cands].sort((a, b) => (a.L > b.L ? -1 : a.L < b.L ? 1 : 0)).slice(0, 3);
  const best = top[0];
  if (top.length < 3) return { price: best.price, poolId: best.p.poolId, outlier: null };
  const median = [...top].sort((a, b) => a.price - b.price)[1];
  if (Math.abs(best.price - median.price) / median.price <= 0.03) return { price: best.price, poolId: best.p.poolId, outlier: null };
  return { price: median.price, poolId: median.p.poolId, outlier: best.price };
};

// Harga ETH pada blok lampau, dari pool ETH/USDG yang sama (butuh node arsip).
// Dipakai menilai hasil jual ke ETH pada waktunya — memakai harga ETH sekarang untuk
// penjualan kemarin bisa meleset beberapa persen. Tanpa arsip: harga sekarang.
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

// ---- poolKey dari poolId --------------------------------------------------
// Posisi yang NFT-nya sudah dibakar tidak lagi mengembalikan poolKey dari
// PositionManager — yang tersisa cuma poolId dari event ModifyLiquidity. Tanpa
// pasangan tokennya, posisi itu tidak bisa dinilai sama sekali (semua jadi nol).
// Event Initialize mengindeks poolId, jadi pencarian mundurnya murah, dan hasilnya
// disimpan supaya cukup sekali per pool.
Chain.prototype.poolKeyOfId = async function poolKeyOfId(poolId, hintBlock = null, hintTx = null) {
  const row = this.store.get('SELECT token0,token1,fee,tick_spacing,hooks FROM pools WHERE chain=? AND pool_ref=?', this.network, poolId);
  if (row && row.token0) {
    return { currency0: row.token0, currency1: row.token1, fee: row.fee, tickSpacing: row.tick_spacing, hooks: row.hooks };
  }

  // Jalur cepat: poolKey biasanya tertulis apa adanya di dalam calldata tx mint
  // (MINT_POSITION mengoper struct-nya utuh). Geser jendela 5 word di sepanjang
  // calldata dan cocokkan hash-nya dengan poolId — murni hitungan lokal, tanpa RPC.
  // Kombinasi fee/tickSpacing di chain ini terlalu beragam untuk ditebak, jadi
  // mencocokkan hash jauh lebih andal daripada menerka tier.
  if (hintTx) {
    const pk = await this.poolKeyFromCalldata(poolId, hintTx);
    if (pk) return pk;
  }

  const head = await this.rpc.blockNumber();
  const anchor = hintBlock || head;
  // Pool selalu dibuat SEBELUM posisinya, jadi cari mundur dari blok petunjuk.
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

// Harga lahir pool v4: blok dan sqrtPriceX96 dari event Initialize-nya. Selama belum
// ada Swap, harga pool = harga ini — dan pool yang dibuat lalu langsung di-mint dalam
// satu tx (kebiasaan wallet yang meluncurkan tokennya sendiri) belum punya state di
// blok sebelumnya maupun Swap untuk ditumpangi, jadi inilah satu-satunya sumber harga
// mint-nya. Dicari mundur dari blok petunjuk (pool selalu lahir sebelum kejadiannya)
// dan disimpan supaya cukup sekali per pool. null = tidak ketemu (atau RPC gagal).
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
  const body = tx.input.slice(10);                 // buang selector
  const words = body.length >> 6;                  // jumlah word 32-byte
  const wordAt = (i) => '0x' + body.slice(i * 64, i * 64 + 64);
  const addrOf = (w) => '0x' + w.slice(-40);
  for (let i = 0; i + 5 <= words; i++) {
    const c0 = wordAt(i), c1 = wordAt(i + 1), fe = wordAt(i + 2), ts = wordAt(i + 3), hk = wordAt(i + 4);
    // dua word pertama harus berbentuk alamat (12 byte teratas nol)
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

// ---- umur pool ------------------------------------------------------------
// Umur hanya menulis blok/waktu lahir. Dulu barisnya ditulis INSERT OR REPLACE:
// kolom yang tidak disebut (token0/token1/fee/tick_spacing/hooks) ikut jadi NULL,
// jadi pool yang metadatanya sudah dikenal berubah jadi "?/?" di halaman pool.
const AGE_UPSERT = `INSERT INTO pools(chain,pool_ref,venue,first_block,first_ts) VALUES(?,?,?,?,?)
  ON CONFLICT(chain,pool_ref) DO UPDATE SET first_block=excluded.first_block, first_ts=excluded.first_ts`;

// Event Initialize mengindeks poolId, jadi pencarian per-pool murah. Kalau tidak
// ketemu di jendela pindai, pool itu lebih tua dari jendela (dan itu aman).
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
    // lebih tua dari jendela: catat sebagai "sangat tua" supaya tidak dipindai ulang
    this.store.run(AGE_UPSERT, this.network, poolId, 'v4', from, Date.now() - windowBlocks * this.blockMs);
    return (windowBlocks * this.blockMs) / 60000;
  }
  const b = parseInt(logs[0].blockNumber, 16);
  const ts = await this.blockTs(b);
  this.store.run(AGE_UPSERT, this.network, poolId, 'v4', b, ts);
  return (Date.now() - ts) / 60000;
};

// Likuiditas aktif pool v4 (slot +3), dipakai untuk menaksir dampak harga swap.
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

// ---- harga acuan pasangan ---------------------------------------------------
// Harga pool tidak selalu layak dipakai menilai. Pool yang likuiditas aktifnya nol
// (semua LP di luar rentang, atau satu swap menyapu habis) menyisakan sqrtPrice di
// mana saja — pernah sampai tick maksimum, 1e17× harga wajar. Menilai fee/sisa
// token dengan harga itu menghasilkan PnL "$4e52". Harga yang layak = likuiditas
// aktif > 0 dan tick tidak menempel di batas.
const TICK_EDGE = 887000;
const SQRT_EDGE_LO = m.getSqrtRatioAtTick(-TICK_EDGE), SQRT_EDGE_HI = m.getSqrtRatioAtTick(TICK_EDGE);
const sqrtSane = (s) => s != null && s > SQRT_EDGE_LO && s < SQRT_EDGE_HI;
function priceUsable(slot, liquidity) {
  return !!slot && liquidity > 0n && sqrtSane(slot.sqrtPriceX96);
}
// Untuk harga historis (riset wallet) tidak ada pool acuan yang murah dibaca; harga
// yang menempel di batas diapit ke tepi rentang posisi — harga terakhir yang benar-
// benar dilalui posisi itu. Komposisi tokennya sama (semua di satu sisi), hanya
// nilainya yang jadi masuk akal.
// Diapit juga kalau harganya masih "di dalam batas tick" tapi >MARK_RATIO_MAX× di luar
// tepi terdekat — pool sisa 1 wei sesudah rug menaruh harga 1e9× tanpa menyentuh batas.
const MARK_RATIO_MAX = 1000n;
function sqrtClampedToRange(sqrt, sa, sb) {
  if (sqrt == null) return sqrt;
  const edge = sqrt < sa ? sa : sqrt > sb ? sb : null;
  if (edge == null) return sqrt;                       // di dalam rentang: wajar
  if (!sqrtSane(sqrt)) return edge;
  const hi = sqrt > edge ? sqrt : edge, lo = sqrt > edge ? edge : sqrt;
  return lo > 0n && hi * hi < lo * lo * MARK_RATIO_MAX ? sqrt : edge;   // rasio harga = (√hi/√lo)²
}

// Harga acuan untuk pasangan token: dari pool lain yang memuat pasangan yang sama
// (tabel pools) dan harganya layak, yang likuiditasnya terdalam. null kalau tidak
// ada — pemanggil memutuskan cadangannya. Hasil ditahan sebentar: sinkron posisi
// bisa dipanggil beruntun dan pasangan yang sama tidak perlu dibaca ulang.
Chain.prototype.markSqrtForPair = async function markSqrtForPair(token0, token1, skipRef) {
  const a = String(token0 || '').toLowerCase(), b = String(token1 || '').toLowerCase();
  // pool yang dikecualikan ikut jadi kunci: pasangan sama, posisi di pool berbeda
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
      // token0/token1 pool bisa terbalik terhadap pasangan yang diminta — harga harus
      // dinyatakan dalam urutan pemanggil.
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
      } catch { /* pool tidak terbaca: lewati */ }
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

// ---- pool jembatan ETH <-> USDG -------------------------------------------
// Dipakai untuk memindahkan kas antar aset kuotasi: kalau target nge-LP di pool
// berkuotasi ETH sedangkan kas kita USDG (atau sebaliknya), inilah jalannya.
// Dipilih yang likuiditasnya terdalam supaya dampak harganya paling kecil.
Chain.prototype.bestEthUsdgPool = async function bestEthUsdgPool() {
  const now = Date.now();
  if (this._bridge && now - this._bridgeAt < 300_000) return this._bridge;
  const head = await this.rpc.blockNumber();
  const pools = await this.findEthUsdgPools(head);
  const noHook = pools.filter((p) => /^0x0+$/.test(p.hooks));
  const list = (noHook.length ? noHook : pools).slice(0, 8);
  if (!list.length) return null;
  const slots = await this.slot0V4Many(list.map((p) => p.poolId));
  // Satu batch untuk semua likuiditas — versi sebelumnya menembak 8 kali berurutan
  // dan itu yang bikin timeout saat indexer sedang sibuk.
  const liqWords = await this.rpc.ethCallMany(list.map((p) => ({
    to: this.ADDR.poolManager,
    data: IF_EXT.encodeFunctionData('extsload', [
      '0x' + (BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.poolId, POOLS_SLOT]))) + 3n)
        .toString(16).padStart(64, '0'),
    ]),
  })));
  let best = null;
  for (let i = 0; i < list.length; i++) {
    const s = slots[i];
    if (!s || s.sqrtPriceX96 === 0n) continue;
    const L = liqWords[i] && liqWords[i] !== '0x' ? BigInt(liqWords[i]) & ((1n << 128n) - 1n) : 0n;
    if (!best || L > best.liquidity) {
      best = {
        poolId: list[i].poolId,
        poolKey: {
          currency0: this.ADDR.native, currency1: this.ADDR.usdg,
          fee: list[i].fee, tickSpacing: list[i].tickSpacing, hooks: list[i].hooks,
        },
        slot0: s, liquidity: L,
      };
    }
  }
  if (best) { this._bridge = best; this._bridgeAt = now; }
  return best;
};
