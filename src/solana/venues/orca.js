'use strict';
// Adapter Orca Whirlpools. Tick Orca = tick Uniswap (1.0001), sqrtPrice Q64.64, L sama
// artinya — jadi normalisasinya cuma menggeser sqrt ke Q96, dan jumlah token posisi
// dihitung dengan rumus v3 yang sama (v3math.amountsForLiquidity).
//
// Posisi Orca = NFT: pemilik posisi = pemegang NFT-nya. Enumerasi wallet lewat SDK
// (getAllPositionAccountsByOwner: akun token SPL + Token-2022 milik wallet → PDA posisi).
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');
const {
  WhirlpoolContext, buildWhirlpoolClient, PDAUtil, TickArrayUtil,
  ParsableWhirlpool, ParsableTickArray, ParsablePosition,
  TokenExtensionUtil, decreaseLiquidityQuoteByLiquidityWithParams, IGNORE_CACHE, ORCA_WHIRLPOOL_PROGRAM_ID,
} = require('@orca-so/whirlpools-sdk');
const { Percentage } = require('@orca-so/common-sdk');
const m = require('../../v3math');
const u = require('../units');
const { feeGrowthInside, unclaimed, big } = require('../clmm-math');

const PROGRAM = ORCA_WHIRLPOOL_PROGRAM_ID.toBase58();
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));

// Dompet anchor tiruan: SDK hanya butuh publicKey untuk menyusun instruksi. Tanda
// tangan dilakukan pengirim (src/solana/executor.js), jadi sign* di sini tidak boleh
// pernah terpanggil.
const viewWallet = (pk) => ({
  publicKey: new PublicKey(pk),
  signTransaction: () => { throw new Error('orca: tanda tangan lewat executor'); },
  signAllTransactions: () => { throw new Error('orca: tanda tangan lewat executor'); },
});

class OrcaVenue {
  constructor({ rpc, log }) {
    this.key = 'orca'; this.program = PROGRAM; this.rpc = rpc; this.log = log || console.log;
    this.nativeIsBin = false;
  }

  // Konteks SDK terikat satu Connection. `on` menjalankan satu baca/build utuh di satu
  // endpoint; galat sementara (429/403/timeout) mengulang SELURUHNYA di endpoint lain.
  ctx(owner, conn) {
    return WhirlpoolContext.from(conn, viewWallet(owner || PublicKey.default.toBase58()));
  }
  on(owner, fn, opts) { return this.rpc.run((c) => fn(this.ctx(owner, c)), opts); }

  // Akun dibaca sendiri lewat rpc.run (≤100 per getMultipleAccounts, berurutan, dengan
  // alih endpoint), SDK Orca hanya dipakai untuk parse. Fetcher SDK memakai
  // `new Promise(async …)`: kalau RPC menolak, galatnya jadi promise tak tertangani dan
  // panggilannya menggantung sampai timeout 10 detik.
  async fetchMany(method, keys) {
    const P = { getPools: ParsableWhirlpool, getTickArrays: ParsableTickArray, getPositions: ParsablePosition }[method];
    const out = [];
    for (let i = 0; i < keys.length; i += 100) {
      const part = keys.slice(i, i + 100).map((k) => new PublicKey(k));
      const infos = await this.rpc.run((c) => c.getMultipleAccountsInfo(part));
      part.forEach((pk, k) => out.push([pk.toBase58(), infos[k] ? P.parse(pk, infos[k]) : null]));
    }
    return method === 'getTickArrays' ? out.map(([, v]) => v) : new Map(out);
  }

  poolState(addr, d, dec) {
    const a = b58(d.tokenMintA), b = b58(d.tokenMintB);
    return {
      venue: this.key, id: addr, token0: a, token1: b,
      dec0: dec.get(a) ?? null, dec1: dec.get(b) ?? null,
      sqrtX96: u.x64ToX96(d.sqrtPrice), tick: d.tickCurrentIndex,
      current: d.tickCurrentIndex, spacing: d.tickSpacing, ticksPerUnit: 1,
      fee: d.feeRate,                      // seperseratus bip = 1e-6, sama dengan fee v3
      tickSpacing: d.tickSpacing,
      liquidity: big(d.liquidity),
      feeGrowthGlobalA: big(d.feeGrowthGlobalA), feeGrowthGlobalB: big(d.feeGrowthGlobalB),
      enabled: true,
    };
  }

  async pools(addrs, decimalsOf) {
    const out = new Map();
    if (!addrs.length) return out;
    const got = await this.fetchMany('getPools', addrs);
    const mints = [];
    for (const d of got.values()) if (d) mints.push(b58(d.tokenMintA), b58(d.tokenMintB));
    const dec = decimalsOf ? await decimalsOf([...new Set(mints)]) : new Map();
    for (const a of addrs) {
      const d = got.get(a);
      if (d) out.set(a, this.poolState(a, d, dec));
    }
    return out;
  }

  // PositionData SDK + state pool -> bentuk posisi bersama.
  norm(id, p, pool, fees = null) {
    const L = big(p.liquidity);
    let amount0 = 0n, amount1 = 0n;
    if (pool && L > 0n) {
      const r = m.amountsForLiquidity(pool.sqrtX96, m.getSqrtRatioAtTick(p.tickLowerIndex), m.getSqrtRatioAtTick(p.tickUpperIndex), L);
      amount0 = r.amount0; amount1 = r.amount1;
    }
    return {
      venue: this.key, id, pool: b58(p.whirlpool),
      token0: pool?.token0 ?? null, token1: pool?.token1 ?? null,
      lower: p.tickLowerIndex, upper: p.tickUpperIndex, tickLower: p.tickLowerIndex, tickUpper: p.tickUpperIndex,
      liquidity: L.toString(), amount0, amount1,
      fee0: fees ? fees.fee0 : big(p.feeOwedA), fee1: fees ? fees.fee1 : big(p.feeOwedB),
      // Fee growth checkpoint: moves whenever the position's fees are settled (claim,
      // add/remove). With the liquidity unchanged that means the owner claimed.
      feeMark: `${big(p.feeGrowthCheckpointA ?? p.fee_growth_checkpoint_a)}:${big(p.feeGrowthCheckpointB ?? p.fee_growth_checkpoint_b)}`,
      ext: { positionMint: b58(p.positionMint) },
    };
  }

  async listPositions(owner, decimalsOf) {
    // NFT posisi (jumlah 1, desimal 0) di kedua program token → PDA posisi (sama dengan
    // getAllPositionAccountsByOwner SDK tanpa bundle, tapi lewat rpc.run).
    const own = new PublicKey(owner);
    const mints = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      const r = await this.rpc.run((c) => c.getParsedTokenAccountsByOwner(own, { programId }), { indexed: true });
      for (const { account } of r.value) {
        const info = account.data?.parsed?.info;
        if (info?.tokenAmount?.decimals === 0 && info.tokenAmount.amount === '1') mints.push(info.mint);
      }
    }
    if (!mints.length) return [];
    const pdas = mints.map((mint) => PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(mint)).publicKey.toBase58());
    const got = await this.fetchMany('getPositions', pdas);
    const all = [...got].filter(([, p]) => p);
    const pools = await this.pools([...new Set(all.map(([, p]) => b58(p.whirlpool)))], decimalsOf);
    return all.map(([id, p]) => ({ ...this.norm(String(id), p, pools.get(b58(p.whirlpool))), owner }));
  }

  // Tick terinisialisasi (liquidityNet) di [start, end] untuk kurva kedalaman pool
  // (solana/pool-depth.js). Satu tick array = 88 tick × spacing.
  async depth(pool, start, end) {
    const span = 88 * pool.spacing;
    const starts = [];
    for (let s = Math.floor(start / span) * span; s <= end; s += span) starts.push(s);
    const addrs = starts.map((s) => PDAUtil.getTickArray(ORCA_WHIRLPOOL_PROGRAM_ID, new PublicKey(pool.id), s).publicKey.toBase58());
    const arrs = await this.fetchMany('getTickArrays', addrs);
    const ticks = [];
    for (const a of arrs) {
      if (!a) continue;
      a.ticks.forEach((t, i) => {
        const tick = a.startTickIndex + i * pool.spacing;
        if (t.initialized && tick >= start && tick <= end && String(t.liquidityNet) !== '0') ticks.push({ tick, net: String(t.liquidityNet) });
      });
    }
    return ticks;
  }

  // Fee belum diklaim yang sebenarnya (feeOwed hanya diperbarui saat posisi disentuh):
  // pertumbuhan fee di dalam rentang dari tick array kedua batas.
  async feesFor(rows) {
    const addrs = [];
    for (const { p, pool } of rows) {
      for (const t of [p.tickLowerIndex, p.tickUpperIndex]) {
        addrs.push(PDAUtil.getTickArrayFromTickIndex(t, pool.spacing, new PublicKey(pool.id), ORCA_WHIRLPOOL_PROGRAM_ID).publicKey.toBase58());
      }
    }
    const arrs = addrs.length ? await this.fetchMany('getTickArrays', [...new Set(addrs)]) : [];
    const byAddr = new Map([...new Set(addrs)].map((a, i) => [a, arrs[i]]));
    return rows.map(({ p, pool }, i) => {
      try {
        const la = byAddr.get(addrs[i * 2]), ua = byAddr.get(addrs[i * 2 + 1]);
        if (!la || !ua) return null;
        const lo = TickArrayUtil.getTickFromArray(la, p.tickLowerIndex, pool.spacing);
        const hi = TickArrayUtil.getTickFromArray(ua, p.tickUpperIndex, pool.spacing);
        const args = { tickCurrent: pool.tick, tickLower: p.tickLowerIndex, tickUpper: p.tickUpperIndex };
        const inA = feeGrowthInside({ ...args, global: pool.feeGrowthGlobalA, lowerOut: big(lo.feeGrowthOutsideA), upperOut: big(hi.feeGrowthOutsideA) });
        const inB = feeGrowthInside({ ...args, global: pool.feeGrowthGlobalB, lowerOut: big(lo.feeGrowthOutsideB), upperOut: big(hi.feeGrowthOutsideB) });
        return {
          fee0: unclaimed({ liquidity: p.liquidity, inside: inA, checkpoint: p.feeGrowthCheckpointA, owed: p.feeOwedA }),
          fee1: unclaimed({ liquidity: p.liquidity, inside: inB, checkpoint: p.feeGrowthCheckpointB, owed: p.feeOwedB }),
        };
      } catch { return null; }
    });
  }

  async getPositions(items, decimalsOf) {
    const out = new Map();
    if (!items.length) return out;
    const ids = items.map((x) => x.id);
    const got = await this.fetchMany('getPositions', ids);
    const pools = await this.pools([...new Set([...got.values()].filter(Boolean).map((p) => b58(p.whirlpool)))], decimalsOf);
    const rows = [];
    for (const id of ids) {
      const p = got.get(id);
      if (!p) { out.set(id, null); continue; }
      rows.push({ id, p, pool: pools.get(b58(p.whirlpool)) });
    }
    const fees = await this.feesFor(rows.filter((r) => r.pool)).catch(() => []);
    let k = 0;
    for (const r of rows) out.set(r.id, this.norm(r.id, r.p, r.pool, r.pool ? fees[k++] : null));
    return out;
  }

  // TransactionBuilder Orca -> satu grup instruksi (+ penanda tangan tambahan).
  static group(tb) {
    if (!tb) return null;
    const ix = tb.compressIx(true);
    return { instructions: [...ix.instructions, ...ix.cleanupInstructions], signers: ix.signers };
  }

  async buildOpen({ pool, lower, upper, amount0, amount1, slippageBps, owner }) {
    const me = new PublicKey(owner);
    return this.on(owner, async (ctx) => {
      const w = await buildWhirlpoolClient(ctx).getPool(pool, IGNORE_CACHE);
      const d = w.getData();
      // Pembulatan sendiri (bukan TickUtil.getInitializableTickIndex yang memotong ke arah
      // nol — tick negatif jadi membulat ke atas): bawah ke bawah, atas ke atas.
      const lo = m.alignTick(lower, d.tickSpacing, 'down');
      const hi = m.alignTick(upper, d.tickSpacing, 'up');
      if (hi <= lo) throw new Error(`rentang tick tidak sah ${lo}..${hi}`);
      // Pita harga: posisi hanya dibuat kalau harga saat eksekusi masih dalam ±slippage
      // dari harga saat rencana. Harga ~ sqrt², jadi pita sqrt = √(1 ± s).
      const band = OrcaVenue.sqrtBand(d.sqrtPrice, slippageBps);
      const groups = [];
      // Tick array batas yang belum ada dibuat dulu (transaksi tersendiri).
      const init = await w.initTickArrayForTicks([lo, hi], me, IGNORE_CACHE);
      if (init) groups.push(OrcaVenue.group(init));
      const { positionMint, tx } = await w.openPosition(lo, hi, {
        tokenMaxA: new BN(amount0.toString()), tokenMaxB: new BN(amount1.toString()), ...band,
      }, me, me);
      groups.push(OrcaVenue.group(tx));
      const position = PDAUtil.getPosition(ORCA_WHIRLPOOL_PROGRAM_ID, positionMint).publicKey.toBase58();
      return { groups, position, native: { lower: lo, upper: hi } };
    });
  }

  // Pita harga ±slippage di sekitar sqrt sekarang (lihat buildOpen).
  static sqrtBand(sqrtPrice, slippageBps) {
    const s = Number(slippageBps) / 10_000;
    const sq = BigInt(sqrtPrice.toString());
    return {
      minSqrtPrice: new BN(((sq * BigInt(Math.floor(Math.sqrt(Math.max(0, 1 - s)) * 1e9))) / 1_000_000_000n).toString()),
      maxSqrtPrice: new BN(((sq * BigInt(Math.ceil(Math.sqrt(1 + s) * 1e9))) / 1_000_000_000n).toString()),
    };
  }

  async buildIncrease({ pool, position, amount0, amount1, slippageBps, owner }) {
    const me = new PublicKey(owner);
    return this.on(owner, async (ctx) => {
      const client = buildWhirlpoolClient(ctx);
      const w = await client.getPool(pool, IGNORE_CACHE);
      const pos = await client.getPosition(position, IGNORE_CACHE);
      const tb = await pos.increaseLiquidity({
        tokenMaxA: new BN(amount0.toString()), tokenMaxB: new BN(amount1.toString()),
        ...OrcaVenue.sqrtBand(w.getData().sqrtPrice, slippageBps),
      }, true, me, me, me);
      return { groups: [OrcaVenue.group(tb)] };
    });
  }

  async buildDecrease({ pool, position, liquidity, close, slippageBps, owner }) {
    const me = new PublicKey(owner);
    const slip = Percentage.fromFraction(Number(slippageBps), 10_000);
    return this.on(owner, async (ctx) => {
      const client = buildWhirlpoolClient(ctx);
      const w = await client.getPool(pool, IGNORE_CACHE);
      if (close) {
        // closePosition = kumpulkan fee & reward + tarik semua + tutup akun (sewa kembali)
        const tbs = await w.closePosition(new PublicKey(position), slip, me, me, me);
        return { groups: tbs.map(OrcaVenue.group).filter(Boolean) };
      }
      const pos = await client.getPosition(position, IGNORE_CACHE);
      const pd = pos.getData(), wd = w.getData();
      const tokenExtensionCtx = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, wd, IGNORE_CACHE);
      const q = decreaseLiquidityQuoteByLiquidityWithParams({
        liquidity: new BN(String(liquidity)), slippageTolerance: slip,
        sqrtPrice: wd.sqrtPrice, tickCurrentIndex: wd.tickCurrentIndex,
        tickLowerIndex: pd.tickLowerIndex, tickUpperIndex: pd.tickUpperIndex, tokenExtensionCtx,
      });
      const tb = await pos.decreaseLiquidity(q, true, me, me, me);
      return { groups: [OrcaVenue.group(tb)] };
    });
  }

  async buildClaim({ position, owner }) {
    const me = new PublicKey(owner);
    return this.on(owner, async (ctx) => {
      const pos = await buildWhirlpoolClient(ctx).getPosition(position, IGNORE_CACHE);
      const tb = await pos.collectFees(true, undefined, me, me, me, IGNORE_CACHE);
      return { groups: [OrcaVenue.group(tb)] };
    });
  }

  nativeRange(poolState, tickLower, tickUpper) {
    const lo = m.alignTick(Math.floor(tickLower), poolState.spacing, 'down');
    const hi = m.alignTick(Math.ceil(tickUpper), poolState.spacing, 'up');
    return { lower: lo, upper: hi > lo ? hi : lo + poolState.spacing };
  }
  ticksOf(poolState, lower, upper) { return { tickLower: lower, tickUpper: upper }; }
}

module.exports = { OrcaVenue, PROGRAM };
