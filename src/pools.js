'use strict';
// Pembaca state pool + cache metadata token, untuk v4 (PoolManager.extsload) dan v3 (slot0).
const { ethers } = require('ethers');
const { ADDR, ABI, QUOTES } = require('./chain');
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
  constructor(rpc, store, log = console.log) {
    this.rpc = rpc; this.store = store; this.log = log;
    this.tokenCache = new Map();
    this.poolCache = new Map();
    this.v3Factory = null;
    this.blockTimeCache = { block: 0, ts: 0 };
  }

  // ---- token -------------------------------------------------------------
  async tokens(addrs) {
    const want = [...new Set(addrs.map((a) => (a || '').toLowerCase()))].filter(Boolean);
    const miss = [];
    for (const a of want) {
      if (this.tokenCache.has(a)) continue;
      if (a === ADDR.native) { this.tokenCache.set(a, { address: a, symbol: 'ETH', name: 'Ether', decimals: 18 }); continue; }
      const row = this.store.get('SELECT * FROM tokens WHERE address=?', a);
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
      const res = await this.rpc.ethCallMany(calls);
      miss.forEach((a, i) => {
        const dec = (h) => { try { return IF_ERC20.decodeFunctionResult('decimals', h)[0]; } catch { return 18; } };
        const str = (h, fn) => { try { return IF_ERC20.decodeFunctionResult(fn, h)[0]; } catch { return '?'; } };
        const t = {
          address: a,
          symbol: res[i * 3] ? String(str(res[i * 3], 'symbol')).slice(0, 24) : '?',
          decimals: res[i * 3 + 1] ? Number(dec(res[i * 3 + 1])) : 18,
          name: res[i * 3 + 2] ? String(str(res[i * 3 + 2], 'name')).slice(0, 64) : '',
        };
        this.tokenCache.set(a, t);
        this.store.run('INSERT OR REPLACE INTO tokens(address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?)',
          t.address, t.symbol, t.name, t.decimals, Date.now());
      });
    }
    return want.map((a) => this.tokenCache.get(a));
  }
  async token(a) { return (await this.tokens([a]))[0]; }

  // ---- state pool v4 ------------------------------------------------------
  async slot0V4(poolId) {
    const slot = ethers.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, POOLS_SLOT]));
    const [w] = await this.rpc.ethCallMany([{ to: ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', [slot]) }]);
    if (!w || /^0x0*$/.test(w)) return null;
    const s = unpackSlot0(w);
    return s.sqrtPriceX96 > 0n ? s : null;
  }
  async slot0V4Many(poolIds) {
    const calls = poolIds.map((id) => ({
      to: ADDR.poolManager,
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

  async factoryV3() {
    if (this.v3Factory) return this.v3Factory;
    const cached = this.store.getState('v3_factory');
    if (cached) { this.v3Factory = cached; return cached; }
    const IF = new ethers.Interface(ABI.npmV3);
    const [w] = await this.rpc.ethCallMany([{ to: ADDR.npmV3, data: IF.encodeFunctionData('factory') }]);
    this.v3Factory = ethers.getAddress('0x' + w.slice(-40)).toLowerCase();
    this.store.setState('v3_factory', this.v3Factory);
    return this.v3Factory;
  }

  async poolV3Addr(token0, token1, fee) {
    const key = `${token0}|${token1}|${fee}`.toLowerCase();
    if (this.poolCache.has(key)) return this.poolCache.get(key);
    const f = await this.factoryV3();
    const [w] = await this.rpc.ethCallMany([{ to: f, data: IF_FACT.encodeFunctionData('getPool', [token0, token1, fee]) }]);
    const addr = w && w !== '0x' ? ethers.getAddress('0x' + w.slice(-40)).toLowerCase() : null;
    this.poolCache.set(key, addr);
    return addr;
  }

  // ---- penilaian ----------------------------------------------------------
  // Nilai posisi dalam aset kuotasi pool. Kalau tidak ada sisi kuotasi yang dikenal,
  // nilai ditaksir lewat sisi kuotasi saja (token spekulatif dihargai dari harga pool).
  quoteSideOf(token0, token1) {
    const q0 = QUOTES[(token0 || '').toLowerCase()];
    const q1 = QUOTES[(token1 || '').toLowerCase()];
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
    return Math.round(c.ts + (block - c.block) * 101);
  }
}

module.exports = { Chain, computePoolId, unpackSlot0, POOLS_SLOT };

// ---- harga ETH dalam USDG -------------------------------------------------
// Diturunkan sendiri dari pool ETH-native/USDG di chain ini (tidak perlu sumber luar).
// Pool-nya ditemukan lewat event Initialize yang mengindeks currency0 & currency1.
const { TOPIC } = require('./chain');

Chain.prototype.findEthUsdgPools = async function findEthUsdgPools(headBlock, blocks = 4_000_000) {
  const cached = this.store.getState('eth_usdg_pools');
  if (cached) { try { return JSON.parse(cached); } catch { /* lanjut pindai */ } }
  const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const found = [];
  const chunk = 400_000;
  for (let hi = headBlock; hi > headBlock - blocks && found.length < 12;) {
    const lo = Math.max(0, hi - chunk);
    let logs = [];
    try {
      logs = await this.rpc.getLogs({
        address: ADDR.poolManager,
        topics: [TOPIC.initializeV4, null, pad(ADDR.native), pad(ADDR.usdg)],
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
  if (found.length) this.store.setState('eth_usdg_pools', JSON.stringify(found));
  return found;
};

Chain.prototype.ethUsd = async function ethUsd(fallback = 2500) {
  const now = Date.now();
  if (this._ethUsd && now - this._ethUsdAt < 60_000) return this._ethUsd;
  try {
    const head = await this.rpc.blockNumber();
    const pools = await this.findEthUsdgPools(head);
    const noHook = pools.filter((p) => /^0x0+$/.test(p.hooks));
    const list = (noHook.length ? noHook : pools).slice(0, 8);
    if (!list.length) return fallback;
    const slots = await this.slot0V4Many(list.map((p) => p.poolId));
    // pilih pool dengan likuiditas terbesar
    const liqCalls = list.map((p) => ({
      to: ADDR.poolManager,
      data: IF_EXT.encodeFunctionData('extsload', [
        '0x' + (BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [p.poolId, POOLS_SLOT]))) + 3n).toString(16).padStart(64, '0'),
      ]),
    }));
    const liqs = await this.rpc.ethCallMany(liqCalls);
    let best = null;
    list.forEach((p, i) => {
      const s = slots[i]; if (!s || s.sqrtPriceX96 === 0n) return;
      const L = liqs[i] && liqs[i] !== '0x' ? BigInt(liqs[i]) : 0n;
      if (!best || L > best.L) best = { p, s, L };
    });
    if (!best) return fallback;
    // currency0 = ETH(18), currency1 = USDG(6) -> harga = USDG per ETH
    const price = m.priceFromSqrt(best.s.sqrtPriceX96, 18, 6);
    if (price > 100 && price < 100_000) { this._ethUsd = price; this._ethUsdAt = now; this._ethPoolId = best.p.poolId; return price; }
    return fallback;
  } catch { return fallback; }
};

// Harga ETH pada blok lampau, dari pool ETH/USDG yang sama (butuh node arsip).
// Dipakai menilai hasil jual ke ETH pada waktunya — memakai harga ETH sekarang untuk
// penjualan kemarin bisa meleset beberapa persen. Tanpa arsip: harga sekarang.
Chain.prototype.ethUsdAt = async function ethUsdAt(block, fallback = 2500) {
  const now = await this.ethUsd(fallback);
  if (!this._ethPoolId || !this.rpc.hasArchive()) return now;
  const key = `ethusd:${block}`;
  const cached = this.store.getState(key);
  if (cached) return Number(cached);
  try {
    const slot = ethers.keccak256(coder.encode(['bytes32', 'uint256'], [this._ethPoolId, POOLS_SLOT]));
    const w = await this.rpc.callAt(ADDR.poolManager, IF_EXT.encodeFunctionData('extsload', [slot]), block);
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
  const row = this.store.get('SELECT token0,token1,fee,tick_spacing,hooks FROM pools WHERE pool_ref=?', poolId);
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
        address: ADDR.poolManager, topics: [TOPIC.initializeV4, poolId],
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
      'INSERT OR REPLACE INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block) VALUES(?,?,?,?,?,?,?,?)',
      poolId, 'v4', pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks, parseInt(l.blockNumber, 16));
    return pk;
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
      'INSERT OR REPLACE INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks) VALUES(?,?,?,?,?,?,?)',
      poolId, 'v4', pk.currency0, pk.currency1, pk.fee, pk.tickSpacing, pk.hooks);
    return pk;
  }
  return null;
};

// ---- umur pool ------------------------------------------------------------
// Event Initialize mengindeks poolId, jadi pencarian per-pool murah. Kalau tidak
// ketemu di jendela pindai, pool itu lebih tua dari jendela (dan itu aman).
Chain.prototype.poolAgeMinutes = async function poolAgeMinutes(poolId, windowBlocks = 900_000) {
  const row = this.store.get('SELECT first_block, first_ts FROM pools WHERE pool_ref=?', poolId);
  if (row && row.first_ts) return (Date.now() - row.first_ts) / 60000;
  const head = await this.rpc.blockNumber();
  const from = Math.max(0, head - windowBlocks);
  let logs = [];
  try {
    logs = await this.rpc.getLogs({
      address: ADDR.poolManager, topics: [TOPIC.initializeV4, poolId],
      fromBlock: '0x' + from.toString(16), toBlock: '0x' + head.toString(16),
    });
  } catch { return Infinity; }
  if (!logs.length) {
    // lebih tua dari jendela: catat sebagai "sangat tua" supaya tidak dipindai ulang
    this.store.run('INSERT OR REPLACE INTO pools(pool_ref,venue,first_block,first_ts) VALUES(?,?,?,?)',
      poolId, 'v4', from, Date.now() - windowBlocks * 101);
    return (windowBlocks * 101) / 60000;
  }
  const b = parseInt(logs[0].blockNumber, 16);
  const ts = await this.blockTs(b);
  this.store.run('INSERT OR REPLACE INTO pools(pool_ref,venue,first_block,first_ts) VALUES(?,?,?,?)', poolId, 'v4', b, ts);
  return (Date.now() - ts) / 60000;
};

// Likuiditas aktif pool v4 (slot +3), dipakai untuk menaksir dampak harga swap.
Chain.prototype.poolLiquidityMany = async function poolLiquidityMany(poolIds) {
  if (!poolIds.length) return [];
  const words = await this.rpc.ethCallMany(poolIds.map((id) => {
    const slot = BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, POOLS_SLOT]))) + 3n;
    return { to: ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', ['0x' + slot.toString(16).padStart(64, '0')]) };
  }));
  return words.map((w) => (w && w !== '0x' ? BigInt(w) & ((1n << 128n) - 1n) : 0n));
};

Chain.prototype.poolLiquidity = async function poolLiquidity(poolId) {
  const [L] = await this.poolLiquidityMany([poolId]);
  return L ?? 0n;
};

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
    to: ADDR.poolManager,
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
          currency0: ADDR.native, currency1: ADDR.usdg,
          fee: list[i].fee, tickSpacing: list[i].tickSpacing, hooks: list[i].hooks,
        },
        slot0: s, liquidity: L,
      };
    }
  }
  if (best) { this._bridge = best; this._bridgeAt = now; }
  return best;
};
