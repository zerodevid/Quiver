'use strict';
// Meteora DLMM adapter. The native range = bin ids (inclusive); normalised to equivalent ticks
// through units.js. A DLMM position's "liquidity" is not one L number like v3 — what is used
// here is the sum of `positionLiquidity` over the position's bins: it rises on add and falls
// proportionally on withdrawal, so it fits computing partial withdrawal shares (bps).
const { PublicKey, Keypair } = require('@solana/web3.js');
const BN = require('bn.js');
const DLMM = require('@meteora-ag/dlmm');
const { BorshAccountsCoder } = require('@coral-xyz/anchor');
const u = require('../units');
const { dlmmShape, binWeights, weightDistribution } = require('../dlmm-shape');

const PROGRAM = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
// A plain DLMM position holds at most 70 bins; a wider one is created as an "extended"
// position (createExtendedEmptyPosition) then filled in steps.
const MAX_BINS_SIMPLE = Number(DLMM.DEFAULT_BIN_PER_POSITION?.toString?.() || 70);
const MAX_BINS = 1400;
// Per-bin weights are captured (and copied) up to this width; wider shapes use a preset.
const WEIGHT_MAX_BINS = 200;
const coder = new BorshAccountsCoder(DLMM.IDL);
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return undefined; };
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));

class MeteoraVenue {
  constructor({ rpc, log }) {
    this.key = 'meteora'; this.program = PROGRAM; this.rpc = rpc; this.log = log || console.log;
    this.inst = new Map();   // pool -> {dlmm, at}
    // Native range unit: 1 bin; equivalent ticks per bin depend on the pool's binStep.
    this.nativeIsBin = true;
  }

  // SDK instance per (pool, endpoint): a DLMM instance binds the Connection it was created on,
  // so a whole transaction build runs on the same endpoint — when that endpoint 429s/403s,
  // rpc.run retries the WHOLE build on the next endpoint. Refreshed when older than
  // 20 seconds (the active bin moves with every swap) or when asked for fresh.
  async dlmmOn(conn, pool, { fresh = false } = {}) {
    const key = `${pool}|${conn.rpcEndpoint}`;
    const hit = this.inst.get(key);
    if (hit && !fresh && Date.now() - hit.at < 20_000) return hit.dlmm;
    if (hit) { await hit.dlmm.refetchStates(); hit.at = Date.now(); return hit.dlmm; }
    const d = await DLMM.create(conn, new PublicKey(pool));
    this.inst.set(key, { dlmm: d, at: Date.now() });
    return d;
  }
  // One whole build/read on one endpoint, failing over to another on transient errors.
  withPool(pool, fn, { fresh = true } = {}) {
    return this.rpc.run(async (c) => fn(await this.dlmmOn(c, pool, { fresh }), c));
  }

  // State of many pools in one getMultipleAccounts. Decimals from the token cache
  // (`decimalsOf`), because the pair account does not hold them.
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
        // base fee in Uniswap units (1e-6): baseFactor·binStep·10·10^pow / 1e9 × 1e6
        fee: Math.round((baseFactor * binStep * 10 * 10 ** powF) / 1000),
        tickSpacing: Math.max(1, Math.round(u.ticksPerBin(binStep))),
        liquidity: null,   // DLMM has no single active L; the price is considered sound when the pool reads
        enabled: Number(pick(r.d, 'status') ?? 0) === 0,
      });
    }
    return out;
  }

  // SDK LbPosition -> the shared position shape.
  // activeId: active bin of the pair, used to read the liquidity shape (ext.strategy).
  norm(pool, binStep, p, activeId = null) {
    const d = p.positionData;
    let L = 0n, liqLo = null, liqHi = null;
    for (const b of d.positionBinData || []) {
      const l = BigInt(b.positionLiquidity || '0');
      L += l;
      if (l > 0n) { liqLo = liqLo == null ? b.binId : Math.min(liqLo, b.binId); liqHi = liqHi == null ? b.binId : Math.max(liqHi, b.binId); }
    }
    const { tickLower, tickUpper } = u.binRangeToTicks(d.lowerBinId, d.upperBinId, binStep);
    return {
      venue: this.key, id: b58(p.publicKey), pool, owner: b58(d.owner),
      lower: d.lowerBinId, upper: d.upperBinId, tickLower, tickUpper,
      liquidity: L.toString(),
      amount0: BigInt(d.totalXAmount || '0'), amount1: BigInt(d.totalYAmount || '0'),
      fee0: BigInt(d.feeX?.toString() || '0'), fee1: BigInt(d.feeY?.toString() || '0'),
      // liqLo/liqHi: the bins that actually hold liquidity — a resize (increase/decrease_position_length)
      // changes lower/upper but not these, a rebalance moves them.
      ext: { binStep, lowerBin: d.lowerBinId, upperBin: d.upperBinId, liqLo, liqHi, strategy: MeteoraVenue.shapeOf(d, activeId, binStep)?.strategy ?? null,
        // exact per-bin shape, for a mirror that copies it bin for bin (by-weight deposit)
        weights: d.upperBinId - d.lowerBinId + 1 <= WEIGHT_MAX_BINS ? binWeights(MeteoraVenue.binsOf(d), d.lowerBinId, d.upperBinId, binStep) : null },
    };
  }

  static binsOf(positionData) {
    return (positionData.positionBinData || []).map((b) => ({ binId: b.binId, x: b.positionXAmount, y: b.positionYAmount }));
  }

  static shapeOf(positionData, activeId, binStep) {
    if (activeId == null) return null;
    return dlmmShape(MeteoraVenue.binsOf(positionData), Number(activeId), binStep);
  }

  // All DLMM positions of a wallet (one getProgramAccounts + pair + bin arrays).
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

  // Specific positions (ours). null = the position account no longer exists (closed).
  // A read error is thrown — the caller must NOT treat it as "empty".
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

  // ---- transactions ---------------------------------------------------------
  // The SDK returns legacy Transactions; only their instructions are taken (ComputeBudget
  // instructions dropped — the sender sets its own price & limit).
  static groups(txs, signers = []) {
    return (Array.isArray(txs) ? txs : [txs]).filter(Boolean).map((t, i) => ({
      instructions: t.instructions, signers: i === 0 ? signers : [],
    }));
  }

  static strategyType(s) {
    return { spot: DLMM.StrategyType.Spot, curve: DLMM.StrategyType.Curve, bidask: DLMM.StrategyType.BidAsk }[s] ?? DLMM.StrategyType.Spot;
  }

  // lower/upper: bin ids (inclusive). amount0/1: raw amounts of token X/Y.
  // weights (one per bin, lower..upper): deposit by weight — the target's exact shape — instead
  // of a spot/curve/bid-ask preset (up to WEIGHT_MAX_BINS).
  async buildOpen({ pool, lower, upper, amount0, amount1, slippageBps, owner, strategy = 'spot', weights = null }) {
    const width = upper - lower + 1;
    if (width > MAX_BINS) throw new Error(`rentang ${width} bin melebihi batas posisi DLMM (${MAX_BINS} bin)`);
    const pos = Keypair.generate();
    const user = new PublicKey(owner);
    const st = MeteoraVenue.strategyType(strategy);
    const params = {
      positionPubKey: pos.publicKey, user,
      totalXAmount: new BN(amount0.toString()), totalYAmount: new BN(amount1.toString()),
      strategy: { minBinId: lower, maxBinId: upper, strategyType: st },
      slippage: Number(slippageBps) / 100,   // SDK: percent
    };
    const groups = await this.withPool(pool, async (d) => {
      if (weights && weights.length === width && width <= WEIGHT_MAX_BINS) {
        const dist = weightDistribution(weights, lower, Number(d.lbPair.activeId), Number(d.lbPair.binStep))
          .map((b) => ({ binId: b.binId, xAmountBpsOfTotal: new BN(b.x), yAmountBpsOfTotal: new BN(b.y) }));
        const wp = { positionPubKey: pos.publicKey, user, totalXAmount: params.totalXAmount, totalYAmount: params.totalYAmount, xYAmountDistribution: dist, slippage: params.slippage };
        if (width <= MAX_BINS_SIMPLE) return MeteoraVenue.groups(await d.initializePositionAndAddLiquidityByWeight(wp), [pos]);
        // Wider: an extended position, then the by-weight add in chunks. The SDK reads the
        // position account only to check the bin range — it does not exist yet (it is created by
        // the first group), so that read is answered with the range being created.
        const create = await d.createExtendedEmptyPosition(lower, upper, pos.publicKey, user);
        const acc = d.program.account.positionV2, fetch0 = acc.fetch;
        acc.fetch = async (k, ...rest) => (k.equals(pos.publicKey) ? { lowerBinId: lower, upperBinId: upper } : fetch0.call(acc, k, ...rest));
        let adds;
        try { adds = await d.addLiquidityByWeight2(wp); } finally { acc.fetch = fetch0; }
        return [...MeteoraVenue.groups(create, [pos]), ...MeteoraVenue.groups(adds)];
      }
      if (width <= MAX_BINS_SIMPLE) return MeteoraVenue.groups(await d.initializePositionAndAddLiquidityByStrategy(params), [pos]);
      const create = await d.createExtendedEmptyPosition(lower, upper, pos.publicKey, user);
      const adds = await d.addLiquidityByStrategyChunkable(params);
      return [...MeteoraVenue.groups(create, [pos]), ...MeteoraVenue.groups(adds)];
    });
    return { groups, position: pos.publicKey.toBase58(), native: { lower, upper } };
  }

  // Add to an existing position, over that position's own range.
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

  // Withdraw bps/10000 from the position's whole range; close = also claim fees & close the
  // account (the ~0.057 SOL position rent returns to the wallet).
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

  // Bin contents around the active bin (raw X & Y per bin) for the pool depth curve
  // (solana/pool-depth.js turns them into equivalent L per bin tick range).
  async depth(pool, left, right) {
    const r = await this.withPool(pool.id, (d) => d.getBinsAroundActiveBin(left, right));
    return r.bins.map((b) => ({ bin: Number(b.binId), x: BigInt(b.xAmount.toString()), y: BigInt(b.yAmount.toString()) }));
  }

  // Native range from an equivalent tick range (for plans with a mode other than 'exact').
  nativeRange(poolState, tickLower, tickUpper) {
    const lower = u.tickToBin(tickLower, poolState.binStep);
    const upper = Math.max(lower, u.tickToBin(tickUpper, poolState.binStep) - 1);
    return { lower, upper };
  }
  ticksOf(poolState, lower, upper) { return u.binRangeToTicks(lower, upper, poolState.binStep); }
}

module.exports = { MeteoraVenue, PROGRAM };
