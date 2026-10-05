'use strict';
// Adapter Meteora DLMM. Rentang asli = bin id (inklusif); dinormalkan ke tick setara
// lewat units.js. "Likuiditas" posisi DLMM bukan satu angka L seperti v3 — yang dipakai
// di sini adalah jumlah `positionLiquidity` semua bin posisi: naik saat ditambah, turun
// proporsional saat ditarik, jadi cocok untuk menghitung porsi tarik sebagian (bps).
const { PublicKey, Keypair } = require('@solana/web3.js');
const BN = require('bn.js');
const DLMM = require('@meteora-ag/dlmm');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const u = require('../units');
const { dlmmShape } = require('../dlmm-shape');

const PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
// Satu posisi DLMM biasa menampung maksimal 70 bin; yang lebih lebar dibuat sebagai
// posisi "diperluas" (createExtendedEmptyPosition) lalu diisi bertahap.
const MAX_BINS_SIMPLE = Number(DLMM.DEFAULT_BIN_PER_POSITION?.toString?.() || 70);
const MAX_BINS = 1400;
const coder = new BorshAccountsCoder(DLMM.IDL);
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return undefined; };
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));

class MeteoraVenue {
  constructor({ rpc, log }) {
    this.key = 'meteora'; this.program = PROGRAM; this.rpc = rpc; this.log = log || console.log;
    this.inst = new Map();   // pool -> {dlmm, at}
    // Satuan rentang asli: 1 bin; tick setara per bin tergantung binStep pool.
    this.nativeIsBin = true;
  }

  // Instans SDK per (pool, endpoint): instans DLMM mengikat Connection tempat ia dibuat,
  // jadi satu build transaksi seluruhnya berjalan di endpoint yang sama — kalau endpoint
  // itu 429/403, rpc.run mengulang SELURUH build di endpoint berikutnya. Disegarkan kalau
  // berumur > 20 detik (bin aktif bergerak tiap swap) atau diminta segar.
  async dlmmOn(conn, pool, { fresh = false } = {}) {
    const key = `${pool}|${conn.rpcEndpoint}`;
    const hit = this.inst.get(key);
    if (hit && !fresh && Date.now() - hit.at < 20_000) return hit.dlmm;
    if (hit) { await hit.dlmm.refetchStates(); hit.at = Date.now(); return hit.dlmm; }
    const d = await DLMM.create(conn, new PublicKey(pool));
    this.inst.set(key, { dlmm: d, at: Date.now() });
    return d;
  }
  // Satu build/baca utuh di satu endpoint, dengan alih endpoint kalau gagal sementara.
  withPool(pool, fn, { fresh = true } = {}) {
    return this.rpc.run(async (c) => fn(await this.dlmmOn(c, pool, { fresh }), c));
  }

  // State banyak pool dalam satu getMultipleAccounts. decimals dari cache token
  // (`decimalsOf`), karena akun pair tidak memuatnya.
  async pools(addrs, decimalsOf) {
    const out = new Map();
    if (!addrs.length) return out;
    const infos = await this.rpc.run((c) => c.getMultipleAccountsInfo(addrs.map((a) => new PublicKey(a))));
    const mints = [];
    const raw = addrs.map((a, i) => {
      const acc = infos[i];
      if (!acc || acc.owner.toBase58() !== PROGRAM) return null;
      const d = coder.decode('LbPair', acc.data);
      const x = b58(pick(d, 'token_x_mint', 'tokenXMint')), y = b58(pick(d, 'token_y_mint', 'tokenYMint'));
      mints.push(x, y);
      return { a, d, x, y };
    });
    const dec = decimalsOf ? await decimalsOf([...new Set(mints)]) : new Map();
    for (const r of raw) {
      if (!r) continue;
      const active = Number(pick(r.d, 'active_id', 'activeId'));
      const binStep = Number(pick(r.d, 'bin_step', 'binStep'));
      const par = pick(r.d, 'parameters') || {};
      const baseFactor = Number(pick(par, 'base_factor', 'baseFactor') || 0);
      const powF = Number(pick(par, 'base_fee_power_factor', 'baseFeePowerFactor') || 0);
      out.set(r.a, {
        venue: this.key, id: r.a, token0: r.x, token1: r.y,
        dec0: dec.get(r.x) ?? null, dec1: dec.get(r.y) ?? null,
        sqrtX96: u.binSqrtX96(active, binStep),
        tick: u.binToTick(active, binStep),
        current: active, spacing: 1, binStep,
        ticksPerUnit: u.ticksPerBin(binStep),
        // fee dasar dalam satuan Uniswap (1e-6): baseFactor·binStep·10·10^pow / 1e9 × 1e6
        fee: Math.round((baseFactor * binStep * 10 * 10 ** powF) / 1000),
        tickSpacing: Math.max(1, Math.round(u.ticksPerBin(binStep))),
        liquidity: null,   // DLMM tidak punya L aktif tunggal; harga dianggap layak kalau pool terbaca
        enabled: Number(pick(r.d, 'status') ?? 0) === 0,
      });
    }
    return out;
  }

  // LbPosition SDK -> bentuk posisi bersama.
  // activeId: active bin of the pair, used to read the liquidity shape (ext.strategy).
  norm(pool, binStep, p, activeId = null) {
    const d = p.positionData;
    let L = 0n;
    for (const b of d.positionBinData || []) L += BigInt(b.positionLiquidity || '0');
    const { tickLower, tickUpper } = u.binRangeToTicks(d.lowerBinId, d.upperBinId, binStep);
    return {
      venue: this.key, id: b58(p.publicKey), pool, owner: b58(d.owner),
      lower: d.lowerBinId, upper: d.upperBinId, tickLower, tickUpper,
      liquidity: L.toString(),
      amount0: BigInt(d.totalXAmount || '0'), amount1: BigInt(d.totalYAmount || '0'),
      fee0: BigInt(d.feeX?.toString() || '0'), fee1: BigInt(d.feeY?.toString() || '0'),
      ext: { binStep, lowerBin: d.lowerBinId, upperBin: d.upperBinId, strategy: MeteoraVenue.shapeOf(d, activeId, binStep)?.strategy ?? null },
    };
  }

  static shapeOf(positionData, activeId, binStep) {
    if (activeId == null) return null;
    const bins = (positionData.positionBinData || []).map((b) => ({ binId: b.binId, x: b.positionXAmount, y: b.positionYAmount }));
    return dlmmShape(bins, Number(activeId), binStep);
  }

  // Semua posisi DLMM milik sebuah wallet (satu getProgramAccounts + pair + bin array).
  async listPositions(owner) {
    const m = await this.rpc.run((c) => DLMM.getAllLbPairPositionsByUser(c, new PublicKey(owner)), { needsGpa: true });
    const out = [];
    for (const [pool, info] of m) {
      const binStep = Number(info.lbPair.binStep);
      for (const p of info.lbPairPositionsData) {
        const n = this.norm(pool, binStep, p, info.lbPair.activeId);
        n.token0 = b58(info.lbPair.tokenXMint); n.token1 = b58(info.lbPair.tokenYMint);
        out.push(n);
      }
    }
    return out;
  }

  // Posisi tertentu (milik kita). null = akun posisi sudah tidak ada (ditutup).
  // Galat baca dilempar — pemanggil TIDAK boleh menyamakannya dengan "kosong".
  async getPositions(items) {
    const out = new Map();
    const byPool = new Map();
    for (const it of items) (byPool.get(it.pool) || byPool.set(it.pool, []).get(it.pool)).push(it.id);
    for (const [pool, ids] of byPool) {
      const got = await this.withPool(pool, async (d, c) => {
        const infos = await c.getMultipleAccountsInfo(ids.map((x) => new PublicKey(x)));
        const res = [];
        for (let i = 0; i < ids.length; i++) res.push(infos[i] ? await d.getPosition(new PublicKey(ids[i])) : null);
        return { d, res };
      }, { fresh: false });
      const binStep = Number(got.d.lbPair.binStep);
      ids.forEach((id, i) => {
        const p = got.res[i];
        if (!p) { out.set(id, null); return; }
        const n = this.norm(pool, binStep, p, got.d.lbPair.activeId);
        n.token0 = b58(got.d.lbPair.tokenXMint); n.token1 = b58(got.d.lbPair.tokenYMint);
        out.set(id, n);
      });
    }
    return out;
  }

  // ---- transaksi ------------------------------------------------------------
  // SDK mengembalikan Transaction lama; yang diambil hanya instruksinya (instruksi
  // ComputeBudget dibuang — pengirim memasang harga & batasnya sendiri).
  static groups(txs, signers = []) {
    return (Array.isArray(txs) ? txs : [txs]).filter(Boolean).map((t, i) => ({
      instructions: t.instructions, signers: i === 0 ? signers : [],
    }));
  }

  static strategyType(s) {
    return { spot: DLMM.StrategyType.Spot, curve: DLMM.StrategyType.Curve, bidask: DLMM.StrategyType.BidAsk }[s] ?? DLMM.StrategyType.Spot;
  }

  // lower/upper: bin id (inklusif). amount0/1: jumlah mentah token X/Y.
  async buildOpen({ pool, lower, upper, amount0, amount1, slippageBps, owner, strategy = 'spot' }) {
    const width = upper - lower + 1;
    if (width > MAX_BINS) throw new Error(`rentang ${width} bin melebihi batas posisi DLMM (${MAX_BINS} bin)`);
    const pos = Keypair.generate();
    const user = new PublicKey(owner);
    const st = MeteoraVenue.strategyType(strategy);
    const params = {
      positionPubKey: pos.publicKey, user,
      totalXAmount: new BN(amount0.toString()), totalYAmount: new BN(amount1.toString()),
      strategy: { minBinId: lower, maxBinId: upper, strategyType: st },
      slippage: Number(slippageBps) / 100,   // SDK: persen
    };
    const groups = await this.withPool(pool, async (d) => {
      if (width <= MAX_BINS_SIMPLE) return MeteoraVenue.groups(await d.initializePositionAndAddLiquidityByStrategy(params), [pos]);
      const create = await d.createExtendedEmptyPosition(lower, upper, pos.publicKey, user);
      const adds = await d.addLiquidityByStrategyChunkable(params);
      return [...MeteoraVenue.groups(create, [pos]), ...MeteoraVenue.groups(adds)];
    });
    return { groups, position: pos.publicKey.toBase58(), native: { lower, upper } };
  }

  // Tambah ke posisi yang sudah ada, di rentang posisi itu sendiri.
  // strategy null: keep the position's own shape (read from its bins; spot if unclear).
  async buildIncrease({ pool, position, amount0, amount1, slippageBps, owner, strategy = null }) {
    const groups = await this.withPool(pool, async (d) => {
      const p = await d.getPosition(new PublicKey(position));
      const use = strategy || MeteoraVenue.shapeOf(p.positionData, d.lbPair.activeId, Number(d.lbPair.binStep))?.strategy || 'spot';
      return MeteoraVenue.groups(await d.addLiquidityByStrategy({
        positionPubKey: new PublicKey(position), user: new PublicKey(owner),
        totalXAmount: new BN(amount0.toString()), totalYAmount: new BN(amount1.toString()),
        strategy: { minBinId: p.positionData.lowerBinId, maxBinId: p.positionData.upperBinId, strategyType: MeteoraVenue.strategyType(use) },
        slippage: Number(slippageBps) / 100,
      }));
    });
    return { groups };
  }

  // Tarik bps/10000 dari seluruh rentang posisi; close = sekalian klaim fee & tutup akun
  // (sewa akun posisi ~0,057 SOL kembali ke wallet).
  async buildDecrease({ pool, position, bps, close, owner }) {
    const groups = await this.withPool(pool, async (d) => {
      const p = await d.getPosition(new PublicKey(position));
      const { lowerBinId, upperBinId } = p.positionData;
      const empty = BigInt(p.positionData.totalXAmount || '0') === 0n && BigInt(p.positionData.totalYAmount || '0') === 0n;
      if (empty && close) return MeteoraVenue.groups(await d.closePositionIfEmpty({ owner: new PublicKey(owner), position: p }));
      return MeteoraVenue.groups(await d.removeLiquidity({
        user: new PublicKey(owner), position: new PublicKey(position),
        fromBinId: lowerBinId, toBinId: upperBinId, bps: new BN(String(close ? 10_000 : bps)),
        shouldClaimAndClose: !!close,
      }));
    });
    return { groups };
  }

  async buildClaim({ pool, position, owner }) {
    const groups = await this.withPool(pool, async (d) => {
      const p = await d.getPosition(new PublicKey(position));
      return MeteoraVenue.groups(await d.claimSwapFee({ owner: new PublicKey(owner), position: p }));
    });
    return { groups };
  }

  // Isi bin di sekitar bin aktif (mentah X & Y per bin) untuk kurva kedalaman pool
  // (solana/pool-depth.js mengubahnya ke L setara per rentang tick bin).
  async depth(pool, left, right) {
    const r = await this.withPool(pool.id, (d) => d.getBinsAroundActiveBin(left, right));
    return r.bins.map((b) => ({ bin: Number(b.binId), x: BigInt(b.xAmount.toString()), y: BigInt(b.yAmount.toString()) }));
  }

  // Rentang asli dari rentang tick setara (untuk rencana dengan mode selain 'exact').
  nativeRange(poolState, tickLower, tickUpper) {
    const lower = u.tickToBin(tickLower, poolState.binStep);
    const upper = Math.max(lower, u.tickToBin(tickUpper, poolState.binStep) - 1);
    return { lower, upper };
  }
  ticksOf(poolState, lower, upper) { return u.binRangeToTicks(lower, upper, poolState.binStep); }
}

module.exports = { MeteoraVenue, PROGRAM };
