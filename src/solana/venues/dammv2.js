'use strict';
// Meteora DAMM v2 (cp-amm) adapter. A DAMM v2 pool has ONE price range for every position —
// usually the full range, sometimes a band set when the pool was created — so a position has
// no range of its own: it always covers [sqrtMinPrice, sqrtMaxPrice] of its pool. In the shared
// units that range becomes the position's tickLower/tickUpper; nativeRange ignores the
// requested range and returns the pool's.
//
// Two liquidity kinds (pool.collectFeeMode):
//   0 BothToken / 1 OnlyB : concentrated liquidity over the pool range; the SDK's L is the
//                           Uniswap L shifted left 64 bits (sqrt prices are Q64.64)
//   2 Compounding         : constant-product reserves; a position owns liquidity/poolLiquidity
//                           of tokenAAmount/tokenBAmount
// The amount math is the SDK's (getAmountA/BFromLiquidityDelta handle both kinds).
//
// Positions are NFTs (Token-2022): the owner is the NFT holder; position PDA = f(nft mint).
const { PublicKey, Keypair, Connection } = require('@solana/web3.js');
const { getMint } = require('@solana/spl-token');
const BN = require('bn.js');
const D = require('@meteora-ag/cp-amm-sdk');
const m = require('../../v3math');

const PROGRAM = D.CP_AMM_PROGRAM_ID.toBase58();
// Account decoder with the camelCase field names the SDK functions read (D.cpAmmCoder keeps
// the IDL's snake_case). The Connection is never used — decoding only.
const coder = new D.CpAmm(new Connection('http://127.0.0.1:1'))._program.coder.accounts;
const COMPOUNDING = 2;
const ROUND_DOWN = 1;
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));
const big = (x) => BigInt(x?.toString?.() ?? x ?? 0);
const bn = (x) => new BN(String(x));
// Q64.64 sqrt price -> Q64.96, and the equivalent Uniswap tick (rounded down).
const x96 = (s) => big(s) << 32n;
const tickOf = (sqrtQ64) => {
  const s = x96(sqrtQ64);
  const lo = m.getSqrtRatioAtTick(m.MIN_TICK), hi = m.getSqrtRatioAtTick(m.MAX_TICK);
  return m.getTickAtSqrtRatio(s < lo ? lo : s >= hi ? hi - 1n : s);
};
function isqrt(n) {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

class DammV2Venue {
  constructor({ rpc, log }) {
    this.key = 'dammv2'; this.program = PROGRAM; this.rpc = rpc; this.log = log || console.log;
    this.nativeIsBin = false;
    // Not followed by the copy watcher unless the rules list it in filters.venues: a DAMM v2
    // position has no range of its own, so there is no range move to mirror.
    this.copy = false;
  }

  // One whole read/build on one endpoint (the SDK binds the Connection it is created on).
  on(fn, opts) { return this.rpc.run((c) => fn(new D.CpAmm(c), c), opts); }

  // Raw decoded pool accounts (SDK PoolState), one getMultipleAccounts per 100.
  async rawPools(addrs) {
    const out = new Map();
    for (let i = 0; i < addrs.length; i += 100) {
      const part = addrs.slice(i, i + 100);
      const infos = await this.rpc.run((c) => c.getMultipleAccountsInfo(part.map((a) => new PublicKey(a))));
      part.forEach((a, k) => {
        const acc = infos[k];
        if (!acc || acc.owner.toBase58() !== PROGRAM) return;
        try { out.set(a, coder.decode('pool', acc.data)); } catch { /* another account type */ }
      });
    }
    return out;
  }

  // Fee in Uniswap units (1e-6). A fee scheduler starts high and decays to its floor; the floor
  // is the pool's lasting fee, the cap what it may charge right after launch.
  static fees(d) {
    let lo = null, hi = null;
    try {
      const h = D.getBaseFeeHandlerFromPodAlignedData(d.poolFees.baseFee.baseFeeInfo.data);
      lo = Number(h.getMinFeeNumerator().toString()); hi = Number(h.getMaxFeeNumerator().toString());
    } catch {
      // first 8 bytes = the cliff fee numerator in every base fee mode
      lo = hi = Number(Buffer.from(d.poolFees.baseFee.baseFeeInfo.data.slice(0, 8)).readBigUInt64LE());
    }
    return { fee: Math.round(lo / 1000), feeMax: Math.round(hi / 1000), dynamic: d.poolFees.dynamicFee?.initialized === 1 };
  }

  // Uniswap-equivalent L of a liquidity amount (for depth charts and "is the pool empty").
  static lv3(d, L) {
    if (d.collectFeeMode === COMPOUNDING) {
      const pl = big(d.liquidity);
      return pl > 0n ? (big(L) * isqrt(big(d.tokenAAmount) * big(d.tokenBAmount))) / pl : 0n;
    }
    return big(L) >> 64n;
  }

  poolState(addr, d, dec) {
    const a = b58(d.tokenAMint), b = b58(d.tokenBMint);
    const tick = tickOf(d.sqrtPrice);
    const { fee, feeMax, dynamic } = DammV2Venue.fees(d);
    return {
      venue: this.key, id: addr, token0: a, token1: b,
      dec0: dec.get(a) ?? null, dec1: dec.get(b) ?? null,
      sqrtX96: x96(d.sqrtPrice), tick, current: tick, spacing: 1, ticksPerUnit: 1,
      fee, feeMax, dynamicFee: dynamic, tickSpacing: 1,
      liquidity: DammV2Venue.lv3(d, d.liquidity),
      // The pool-wide range every position covers.
      rangeLower: tickOf(d.sqrtMinPrice), rangeUpper: tickOf(d.sqrtMaxPrice),
      sqrtMinX96: x96(d.sqrtMinPrice), sqrtMaxX96: x96(d.sqrtMaxPrice),
      compounding: d.collectFeeMode === COMPOUNDING, collectFeeMode: d.collectFeeMode,
      enabled: d.poolStatus === 0,
    };
  }

  async pools(addrs, decimalsOf) {
    const out = new Map();
    if (!addrs.length) return out;
    const raw = await this.rawPools(addrs);
    const mints = [...new Set([...raw.values()].flatMap((d) => [b58(d.tokenAMint), b58(d.tokenBMint)]))];
    const dec = decimalsOf ? await decimalsOf(mints) : new Map();
    for (const [a, d] of raw) out.set(a, this.poolState(a, d, dec));
    return out;
  }

  // Token amounts of `L` liquidity at the pool's current state (rounded down, as a withdrawal).
  static amountsOf(d, L) {
    if (big(L) === 0n) return { amount0: 0n, amount1: 0n };
    const args = [bn(L), ROUND_DOWN, d.collectFeeMode];
    return {
      amount0: big(D.getAmountAFromLiquidityDelta(d.sqrtPrice, d.sqrtMaxPrice, ...args, d.tokenAAmount, d.liquidity)),
      amount1: big(D.getAmountBFromLiquidityDelta(d.sqrtMinPrice, d.sqrtPrice, ...args, d.tokenBAmount, d.liquidity)),
    };
  }

  // SDK PositionState + its pool -> the shared position shape. liquidity = everything the
  // position holds (locked parts included, the bot never locks); fees are the unclaimed ones.
  norm(id, ps, d, poolAddr, owner = null) {
    const L = big(D.positionLiquidity(ps));
    const { amount0, amount1 } = d ? DammV2Venue.amountsOf(d, L) : { amount0: 0n, amount1: 0n };
    const f = d ? D.getUnClaimLpFee(d, ps) : null;
    const tl = d ? tickOf(d.sqrtMinPrice) : null, tu = d ? tickOf(d.sqrtMaxPrice) : null;
    return {
      venue: this.key, id, pool: poolAddr, owner,
      token0: d ? b58(d.tokenAMint) : null, token1: d ? b58(d.tokenBMint) : null,
      lower: tl, upper: tu, tickLower: tl, tickUpper: tu,
      liquidity: L.toString(), amount0, amount1,
      fee0: f ? big(f.feeTokenA) : big(ps.feeAPending), fee1: f ? big(f.feeTokenB) : big(ps.feeBPending),
      // Fee checkpoint: moves whenever the position's fees are settled (claim / add / remove).
      feeMark: `${Buffer.from(ps.feeAPerTokenCheckpoint).toString('hex')}:${Buffer.from(ps.feeBPerTokenCheckpoint).toString('hex')}`,
      // depthL: the Uniswap-equivalent L for the pool depth chart.
      ext: { nftMint: b58(ps.nftMint), depthL: d ? DammV2Venue.lv3(d, L).toString() : '0', locked: big(ps.unlockedLiquidity) < L },
    };
  }

  async listPositions(owner) {
    const list = await this.on((amm) => amm.getPositionsByUser(new PublicKey(owner)), { indexed: true });
    if (!list.length) return [];
    const raw = await this.rawPools([...new Set(list.map((x) => b58(x.positionState.pool)))]);
    return list.map((x) => {
      const pool = b58(x.positionState.pool);
      return this.norm(b58(x.position), x.positionState, raw.get(pool) || null, pool, owner);
    });
  }

  // Specific positions. null = the position account no longer exists (closed).
  async getPositions(items) {
    const out = new Map();
    if (!items.length) return out;
    const ids = items.map((x) => x.id);
    const states = new Map();
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const infos = await this.rpc.run((c) => c.getMultipleAccountsInfo(part.map((a) => new PublicKey(a))));
      part.forEach((id, k) => {
        const acc = infos[k];
        states.set(id, acc && acc.owner.toBase58() === PROGRAM ? coder.decode('position', acc.data) : null);
      });
    }
    const raw = await this.rawPools([...new Set([...states.values()].filter(Boolean).map((s) => b58(s.pool)))]);
    for (const id of ids) {
      const s = states.get(id);
      out.set(id, s ? this.norm(id, s, raw.get(b58(s.pool)) || null, b58(s.pool)) : null);
    }
    return out;
  }

  // ---- transactions ---------------------------------------------------------------
  // The SDK returns legacy Transactions; only their instructions are taken (the sender sets
  // its own compute budget).
  static groups(tx, signers = []) {
    return [{ instructions: tx.instructions, signers }];
  }

  // Mint + epoch for a Token-2022 side (transfer-fee aware amount math); null for SPL Token.
  static async tokenInfos(c, d) {
    const one = async (mint, flag) => {
      if (flag !== 1) return null;
      const [mi, ep] = await Promise.all([getMint(c, mint, 'confirmed', D.getTokenProgram(1)), c.getEpochInfo()]);
      return { mint: mi, currentEpoch: ep.epoch };
    };
    const [a, b] = await Promise.all([one(d.tokenAMint, d.tokenAFlag), one(d.tokenBMint, d.tokenBFlag)]);
    return { tokenAInfo: a || undefined, tokenBInfo: b || undefined };
  }

  // Liquidity for at most amount0/amount1, shrunk by the slippage so a price move within it
  // still needs no more than the amounts given (they are capped at what the wallet holds).
  static liquidityFor(amm, d, amount0, amount1, slippageBps, infos) {
    const keep = (x) => bn((BigInt(x) * BigInt(10_000 - Number(slippageBps))) / 10_000n);
    return amm.getLiquidityDelta({
      maxAmountTokenA: keep(amount0), maxAmountTokenB: keep(amount1),
      sqrtPrice: d.sqrtPrice, sqrtMinPrice: d.sqrtMinPrice, sqrtMaxPrice: d.sqrtMaxPrice,
      collectFeeMode: d.collectFeeMode, tokenAAmount: d.tokenAAmount, tokenBAmount: d.tokenBAmount, liquidity: d.liquidity,
      ...infos,
    });
  }

  // lower/upper are ignored: every position covers the pool's range.
  // create: a new customizable pool opened with this first position in ONE transaction
  // (DammV2Venue.buildCreate) — the pool has no price anyone could move before our deposit.
  async buildOpen({ pool, amount0, amount1, slippageBps, owner, create = null }) {
    if (create) return this.buildCreate({ ...create, amount0, amount1, owner });
    const me = new PublicKey(owner);
    return this.on(async (amm, c) => {
      const d = await amm.fetchPoolState(new PublicKey(pool));
      const L = DammV2Venue.liquidityFor(amm, d, amount0, amount1, slippageBps, await DammV2Venue.tokenInfos(c, d));
      if (L.isZero()) throw new Error('jumlah terlalu kecil untuk pool DAMM v2 ini');
      const nft = Keypair.generate();
      const tx = await amm.createPositionAndAddLiquidity({
        owner: me, pool: new PublicKey(pool), positionNft: nft.publicKey, liquidityDelta: L,
        maxAmountTokenA: bn(amount0), maxAmountTokenB: bn(amount1),
        tokenAAmountThreshold: bn(amount0), tokenBAmountThreshold: bn(amount1),
        tokenAMint: d.tokenAMint, tokenBMint: d.tokenBMint,
        tokenAProgram: D.getTokenProgram(d.tokenAFlag), tokenBProgram: D.getTokenProgram(d.tokenBFlag),
      });
      return {
        groups: DammV2Venue.groups(tx, [nft]), position: D.derivePositionAddress(nft.publicKey).toBase58(),
        native: { lower: tickOf(d.sqrtMinPrice), upper: tickOf(d.sqrtMaxPrice) },
      };
    });
  }

  async buildIncrease({ pool, position, amount0, amount1, slippageBps, owner }) {
    const me = new PublicKey(owner);
    return this.on(async (amm, c) => {
      const d = await amm.fetchPoolState(new PublicKey(pool));
      const ps = await amm.fetchPositionState(new PublicKey(position));
      const L = DammV2Venue.liquidityFor(amm, d, amount0, amount1, slippageBps, await DammV2Venue.tokenInfos(c, d));
      if (L.isZero()) throw new Error('jumlah terlalu kecil untuk pool DAMM v2 ini');
      const tx = await amm.addLiquidity({
        owner: me, position: new PublicKey(position), pool: new PublicKey(pool),
        positionNftAccount: D.derivePositionNftAccount(ps.nftMint), liquidityDelta: L,
        maxAmountTokenA: bn(amount0), maxAmountTokenB: bn(amount1),
        tokenAAmountThreshold: bn(amount0), tokenBAmountThreshold: bn(amount1),
        tokenAMint: d.tokenAMint, tokenBMint: d.tokenBMint, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
        tokenAProgram: D.getTokenProgram(d.tokenAFlag), tokenBProgram: D.getTokenProgram(d.tokenBFlag),
      });
      return { groups: DammV2Venue.groups(tx) };
    });
  }

  // Withdraw bps/10000 of the unlocked liquidity. close = claim fees, withdraw everything and
  // close the position (its rent returns to the wallet). Minimum outputs = the quote − slippage.
  async buildDecrease({ pool, position, bps, close, slippageBps, owner }) {
    const me = new PublicKey(owner);
    return this.on(async (amm, c) => {
      const d = await amm.fetchPoolState(new PublicKey(pool));
      const ps = await amm.fetchPositionState(new PublicKey(position));
      const nftAcct = D.derivePositionNftAccount(ps.nftMint);
      const unlocked = big(ps.unlockedLiquidity);
      const take = close ? unlocked : (unlocked * BigInt(bps)) / 10_000n;
      const min = (x) => bn((x * BigInt(10_000 - Number(slippageBps))) / 10_000n);
      const out = DammV2Venue.amountsOf(d, take);
      const currentPoint = await D.getCurrentPoint(c, d.activationType);
      if (close) {
        if (big(D.positionLiquidity(ps)) > unlocked) throw new Error('posisi DAMM v2 ini punya likuiditas terkunci — tidak bisa ditutup penuh');
        const tx = take === 0n
          ? await amm.closePosition({ owner: me, pool: new PublicKey(pool), position: new PublicKey(position), positionNftMint: ps.nftMint, positionNftAccount: nftAcct })
          : await amm.removeAllLiquidityAndClosePosition({
            owner: me, position: new PublicKey(position), positionNftAccount: nftAcct, poolState: d, positionState: ps,
            tokenAAmountThreshold: min(out.amount0), tokenBAmountThreshold: min(out.amount1), vestings: [], currentPoint,
          });
        return { groups: DammV2Venue.groups(tx) };
      }
      if (take === 0n) throw new Error('jumlah yang ditarik nol');
      const tx = await amm.removeLiquidity({
        owner: me, position: new PublicKey(position), pool: new PublicKey(pool), positionNftAccount: nftAcct,
        liquidityDelta: bn(take), tokenAAmountThreshold: min(out.amount0), tokenBAmountThreshold: min(out.amount1),
        tokenAMint: d.tokenAMint, tokenBMint: d.tokenBMint, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
        tokenAProgram: D.getTokenProgram(d.tokenAFlag), tokenBProgram: D.getTokenProgram(d.tokenBFlag),
        vestings: [], currentPoint,
      });
      return { groups: DammV2Venue.groups(tx) };
    });
  }

  async buildClaim({ pool, position, owner }) {
    const me = new PublicKey(owner);
    return this.on(async (amm) => {
      const d = await amm.fetchPoolState(new PublicKey(pool));
      const ps = await amm.fetchPositionState(new PublicKey(position));
      const tx = await amm.claimPositionFee({
        owner: me, position: new PublicKey(position), pool: new PublicKey(pool), positionNftAccount: D.derivePositionNftAccount(ps.nftMint),
        tokenAMint: d.tokenAMint, tokenBMint: d.tokenBMint, tokenAVault: d.tokenAVault, tokenBVault: d.tokenBVault,
        tokenAProgram: D.getTokenProgram(d.tokenAFlag), tokenBProgram: D.getTokenProgram(d.tokenBFlag),
      });
      return { groups: DammV2Venue.groups(tx) };
    });
  }

  // ---- create a pool ----------------------------------------------------------------
  // The customizable pool of a pair (one per pair: its address is derived from the two mints).
  static poolAddressFor(tokenA, tokenB) {
    return D.deriveCustomizablePoolAddress(new PublicKey(tokenA), new PublicKey(tokenB)).toBase58();
  }

  // Q64.64 sqrt price of a raw price (B per A).
  static sqrtQ64(priceRaw) {
    return BigInt(D.getSqrtPriceFromPrice(String(priceRaw), 0, 0).toString());
  }

  // The new pool's L for amount0/amount1 at the starting price over the full range.
  static createLiquidity(sqrtQ64, amount0, amount1) {
    const s = bn(sqrtQ64);
    const la = D.getLiquidityDeltaFromAmountA(bn(amount0), s, D.MAX_SQRT_PRICE, 0);
    const lb = D.getLiquidityDeltaFromAmountB(bn(amount1), D.MIN_SQRT_PRICE, s, 0);
    return la.lt(lb) ? la : lb;
  }

  // A customizable pool, full price range, static base fee (feeBps), fees collected in the
  // quote token (collectFeeMode 1) or both tokens (0), active immediately; the first position
  // is created by the same instruction.
  async buildCreate({ tokenA, tokenB, sqrtQ64, feeBps, collectFeeMode = 1, amount0, amount1, owner }) {
    const me = new PublicKey(owner);
    return this.on(async (amm, c) => {
      const pool = DammV2Venue.poolAddressFor(tokenA, tokenB);
      if (await c.getAccountInfo(new PublicKey(pool))) throw new Error('pool DAMM v2 untuk pasangan ini sudah ada — buka LP di pool itu lewat daftar pool');
      const [ia, ib] = await c.getMultipleAccountsInfo([new PublicKey(tokenA), new PublicKey(tokenB)]);
      if (!ia || !ib) throw new Error('mint token tidak terbaca');
      const L = DammV2Venue.createLiquidity(sqrtQ64, amount0, amount1);
      if (L.isZero()) throw new Error('jumlah terlalu kecil untuk membuat pool');
      const nft = Keypair.generate();
      const baseFee = D.getBaseFeeParams({
        baseFeeMode: D.BaseFeeMode.FeeTimeSchedulerLinear,
        feeTimeSchedulerParam: { startingFeeBps: feeBps, endingFeeBps: feeBps, numberOfPeriod: 0, totalDuration: 0 },
      });
      const { tx, position } = await amm.createCustomPool({
        payer: me, creator: me, positionNft: nft.publicKey,
        tokenAMint: new PublicKey(tokenA), tokenBMint: new PublicKey(tokenB),
        tokenAAmount: bn(amount0), tokenBAmount: bn(amount1),
        sqrtMinPrice: D.MIN_SQRT_PRICE, sqrtMaxPrice: D.MAX_SQRT_PRICE, initSqrtPrice: bn(sqrtQ64), liquidityDelta: L,
        poolFees: { baseFee, compoundingFeeBps: 0, padding: 0, dynamicFee: null },
        hasAlphaVault: false, activationType: 1, collectFeeMode, activationPoint: null,
        tokenAProgram: ia.owner, tokenBProgram: ib.owner, isLockLiquidity: false,
      });
      return {
        groups: DammV2Venue.groups(tx, [nft]), position: position.toBase58(), pool,
        native: { lower: tickOf(D.MIN_SQRT_PRICE), upper: tickOf(D.MAX_SQRT_PRICE) },
      };
    });
  }

  // No per-tick liquidity: one flat band over the pool range.
  async depth(pool, start, end) {
    const out = [];
    const L = BigInt(pool.liquidity ?? 0n);
    if (L <= 0n) return out;
    if (pool.rangeLower >= start && pool.rangeLower <= end) out.push({ tick: pool.rangeLower, net: L.toString() });
    if (pool.rangeUpper >= start && pool.rangeUpper <= end) out.push({ tick: pool.rangeUpper, net: (-L).toString() });
    return out;
  }

  // The pool's own range, whatever was asked.
  nativeRange(poolState) { return { lower: poolState.rangeLower, upper: poolState.rangeUpper }; }
  ticksOf(poolState, lower, upper) { return { tickLower: lower, tickUpper: upper }; }
}

module.exports = { DammV2Venue, PROGRAM, tickOf };
