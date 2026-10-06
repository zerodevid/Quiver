'use strict';
// Raydium CLMM adapter. Like Orca: 1.0001 ticks, sqrtPriceX64, L means the same.
// Positions = NFTs (SPL or Token-2022); the "personal position" PDA is derived from the NFT mint.
// Enumeration & state are read directly with the SDK layouts (one getMultipleAccounts per
// group); the Raydium SDK is only used to build transaction instructions.
const { PublicKey } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');
const BN = require('bn.js');
const R = require('@raydium-io/raydium-sdk-v2');
const m = require('../../v3math');
const u = require('../units');
const { feeGrowthInside, unclaimed, big } = require('../clmm-math');

const PROGRAM = R.CLMM_PROGRAM_ID.toBase58();
const PROG_PK = R.CLMM_PROGRAM_ID;
const TICKS_PER_ARRAY = 60;
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));
const chunks = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

class RaydiumVenue {
  constructor({ rpc, log }) {
    this.key = 'raydium'; this.program = PROGRAM; this.rpc = rpc; this.log = log || console.log;
    this.nativeIsBin = false;
    this.feeRates = new Map();   // configId -> tradeFeeRate (never changes)
    this.sdk = new Map();        // owner -> Raydium instance (transaction builder)
  }

  async multi(addrs) {
    const out = [];
    for (const c of chunks(addrs, 100)) out.push(...await this.rpc.run((conn) => conn.getMultipleAccountsInfo(c.map((a) => new PublicKey(a)))));
    return out;
  }

  async feeRate(configIds) {
    const miss = configIds.filter((c) => !this.feeRates.has(c));
    if (miss.length) {
      const infos = await this.multi(miss);
      miss.forEach((c, i) => { if (infos[i]) this.feeRates.set(c, R.ClmmConfigLayout.decode(infos[i].data).tradeFeeRate); });
    }
    return (c) => this.feeRates.get(c) ?? null;
  }

  async pools(addrs) {
    const out = new Map();
    if (!addrs.length) return out;
    const infos = await this.multi(addrs);
    const dec = addrs.map((a, i) => (infos[i] && infos[i].owner.equals(PROG_PK) ? R.PoolInfoLayout.decode(infos[i].data) : null));
    const rate = await this.feeRate([...new Set(dec.filter(Boolean).map((d) => b58(d.configId)))]);
    addrs.forEach((a, i) => {
      const d = dec[i];
      if (!d) return;
      out.set(a, {
        venue: this.key, id: a, token0: b58(d.mintA), token1: b58(d.mintB),
        dec0: d.mintDecimalsA, dec1: d.mintDecimalsB,
        sqrtX96: u.x64ToX96(d.sqrtPriceX64), tick: d.tickCurrent,
        current: d.tickCurrent, spacing: d.tickSpacing, ticksPerUnit: 1,
        fee: rate(b58(d.configId)), tickSpacing: d.tickSpacing,
        liquidity: big(d.liquidity),
        feeGrowthGlobalA: big(d.feeGrowthGlobalX64A), feeGrowthGlobalB: big(d.feeGrowthGlobalX64B),
        // status bit 1 = opening/closing positions disabled
        enabled: (Number(d.status) & 0b1) === 0,
      });
    });
    return out;
  }

  norm(id, p, pool, fees = null) {
    const L = big(p.liquidity);
    let amount0 = 0n, amount1 = 0n;
    if (pool && L > 0n) {
      const r = m.amountsForLiquidity(pool.sqrtX96, m.getSqrtRatioAtTick(p.tickLower), m.getSqrtRatioAtTick(p.tickUpper), L);
      amount0 = r.amount0; amount1 = r.amount1;
    }
    return {
      venue: this.key, id, pool: b58(p.poolId),
      token0: pool?.token0 ?? null, token1: pool?.token1 ?? null,
      lower: p.tickLower, upper: p.tickUpper, tickLower: p.tickLower, tickUpper: p.tickUpper,
      liquidity: L.toString(), amount0, amount1,
      fee0: fees ? fees.fee0 : big(p.tokenFeesOwedA), fee1: fees ? fees.fee1 : big(p.tokenFeesOwedB),
      // Fee growth checkpoint (see OrcaVenue.norm): moves on claim with the liquidity unchanged.
      feeMark: `${big(p.feeGrowthInsideLastX64A)}:${big(p.feeGrowthInsideLastX64B)}`,
      ext: { nftMint: b58(p.nftMint) },
    };
  }

  // NFTs (amount 1, 0 decimals) held by the wallet in both token programs -> position PDAs.
  async listPositions(owner) {
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
    const pdas = mints.map((mint) => R.getPdaPersonalPositionAddress(PROG_PK, new PublicKey(mint)).publicKey.toBase58());
    const infos = await this.multi(pdas);
    const found = [];
    pdas.forEach((id, i) => { if (infos[i] && infos[i].owner.equals(PROG_PK)) found.push({ id, p: R.PersonalPositionLayout.decode(infos[i].data) }); });
    const pools = await this.pools([...new Set(found.map((x) => b58(x.p.poolId)))]);
    return found.map(({ id, p }) => ({ ...this.norm(id, p, pools.get(b58(p.poolId))), owner }));
  }

  // Initialised ticks (liquidityNet) in [start, end] for the pool depth curve
  // (solana/pool-depth.js). One tick array = 60 ticks × spacing.
  async depth(pool, start, end) {
    const span = TICKS_PER_ARRAY * pool.spacing;
    const addrs = [];
    for (let s = Math.floor(start / span) * span; s <= end; s += span) addrs.push(R.getPdaTickArrayAddress(PROG_PK, new PublicKey(pool.id), s).publicKey.toBase58());
    const infos = await this.multi(addrs);
    const ticks = [];
    for (const inf of infos) {
      if (!inf || !inf.owner.equals(PROG_PK)) continue;
      const a = R.TickArrayLayout.decode(inf.data);
      a.ticks.forEach((t, i) => {
        const tick = a.startTickIndex + i * pool.spacing;
        if (tick >= start && tick <= end && String(t.liquidityNet) !== '0') ticks.push({ tick, net: String(t.liquidityNet) });
      });
    }
    return ticks;
  }

  async feesFor(rows) {
    const arrAddr = (pool, tick) => {
      const span = TICKS_PER_ARRAY * pool.spacing;
      const start = Math.floor(tick / span) * span;
      return { start, addr: R.getPdaTickArrayAddress(PROG_PK, new PublicKey(pool.id), start).publicKey.toBase58() };
    };
    const need = [];
    for (const { p, pool } of rows) need.push(arrAddr(pool, p.tickLower), arrAddr(pool, p.tickUpper));
    const uniq = [...new Set(need.map((x) => x.addr))];
    const infos = uniq.length ? await this.multi(uniq) : [];
    const byAddr = new Map(uniq.map((a, i) => [a, infos[i] ? R.TickArrayLayout.decode(infos[i].data) : null]));
    return rows.map(({ p, pool }, i) => {
      try {
        const tickOf = (ref, t) => {
          const arr = byAddr.get(ref.addr);
          return arr ? arr.ticks[(t - ref.start) / pool.spacing] : null;
        };
        const lo = tickOf(need[i * 2], p.tickLower), hi = tickOf(need[i * 2 + 1], p.tickUpper);
        if (!lo || !hi) return null;
        const args = { tickCurrent: pool.tick, tickLower: p.tickLower, tickUpper: p.tickUpper };
        const inA = feeGrowthInside({ ...args, global: pool.feeGrowthGlobalA, lowerOut: big(lo.feeGrowthOutsideX64A), upperOut: big(hi.feeGrowthOutsideX64A) });
        const inB = feeGrowthInside({ ...args, global: pool.feeGrowthGlobalB, lowerOut: big(lo.feeGrowthOutsideX64B), upperOut: big(hi.feeGrowthOutsideX64B) });
        return {
          fee0: unclaimed({ liquidity: p.liquidity, inside: inA, checkpoint: p.feeGrowthInsideLastX64A, owed: p.tokenFeesOwedA }),
          fee1: unclaimed({ liquidity: p.liquidity, inside: inB, checkpoint: p.feeGrowthInsideLastX64B, owed: p.tokenFeesOwedB }),
        };
      } catch { return null; }
    });
  }

  async getPositions(items) {
    const out = new Map();
    if (!items.length) return out;
    const ids = items.map((x) => x.id);
    const infos = await this.multi(ids);
    const rows = [];
    ids.forEach((id, i) => {
      if (!infos[i] || !infos[i].owner.equals(PROG_PK)) { out.set(id, null); return; }
      rows.push({ id, p: R.PersonalPositionLayout.decode(infos[i].data) });
    });
    const pools = await this.pools([...new Set(rows.map((r) => b58(r.p.poolId)))]);
    for (const r of rows) r.pool = pools.get(b58(r.p.poolId));
    const withPool = rows.filter((r) => r.pool);
    const fees = await this.feesFor(withPool).catch(() => []);
    const feeBy = new Map(withPool.map((r, i) => [r.id, fees[i]]));
    for (const r of rows) out.set(r.id, this.norm(r.id, r.p, r.pool, feeBy.get(r.id) || null));
    return out;
  }

  // ---- transactions ---------------------------------------------------------
  // SDK instance per (wallet, endpoint): it binds the Connection it was created on, so one
  // build runs whole on one endpoint and rpc.run can retry it on another.
  async raydiumOn(owner, conn) {
    const key = `${owner}|${conn.rpcEndpoint}`;
    let r = this.sdk.get(key);
    if (!r) {
      r = await R.Raydium.load({
        connection: conn, owner: new PublicKey(owner), cluster: 'mainnet',
        disableLoadToken: true, disableFeatureCheck: true, blockhashCommitment: 'confirmed',
      });
      // No websocket subscription to account changes (one socket per instance, unused).
      r.account.notSubscribeAccountChange = true;
      this.sdk.set(key, r);
    }
    // The wallet's token accounts change with every transaction; the SDK uses them to pick the ATA.
    r.account.resetTokenAccounts();
    return r;
  }
  on(owner, fn) { return this.rpc.run(async (c) => fn(await this.raydiumOn(owner, c))); }

  // SDK MakeTxData result -> one instruction group (+ the lookup tables the pool asks for).
  static group(res) {
    const d = res.builder.AllTxData;
    return {
      instructions: [...d.instructions, ...d.endInstructions],
      signers: d.signers,
      lookupTables: d.lookupTableAddress || [],
    };
  }

  async buildOpen({ pool, lower, upper, amount0, amount1, slippageBps, owner }) {
    const st = (await this.pools([pool])).get(pool);
    if (!st) throw new Error(`pool Raydium ${pool} tidak terbaca`);
    const sp = st.spacing;
    const lo = m.alignTick(lower, sp, 'down'), hi = m.alignTick(upper, sp, 'up');
    if (hi <= lo) throw new Error(`rentang tick tidak sah ${lo}..${hi}`);
    const a0 = BigInt(amount0), a1 = BigInt(amount1);
    const base = await this.baseSide(pool, lo, hi, a0, a1);
    const pad = (x) => (x * BigInt(10_000 + Number(slippageBps))) / 10_000n;
    const res = await this.on(owner, async (ray) => {
      const { poolInfo, poolKeys } = await ray.clmm.getPoolInfoFromRpc(pool);
      return ray.clmm.openPositionFromBase({
        poolInfo, poolKeys, tickLower: lo, tickUpper: hi, base,
        ownerInfo: { useSOLBalance: true },
        baseAmount: new BN((base === 'MintA' ? a0 : a1).toString()),
        otherAmountMax: new BN(pad(base === 'MintA' ? a1 : a0).toString()),
        nft2022: true, withMetadata: 'no-create', txVersion: R.TxVersion.V0,
      });
    });
    return {
      groups: [RaydiumVenue.group(res)],
      position: b58(res.extInfo.personalPosition || R.getPdaPersonalPositionAddress(PROG_PK, res.extInfo.nftMint).publicKey),
      native: { lower: lo, upper: hi },
    };
  }

  // Base = the side that BINDS the liquidity (the smaller L of the two): with that base the
  // other side's requirement is surely ≤ what we hold. Picking the wrong side = the program
  // demands more of the other side than otherAmountMax and the transaction fails.
  async baseSide(pool, lo, hi, a0, a1) {
    if (a0 === 0n) return 'MintB';
    if (a1 === 0n) return 'MintA';
    const st = (await this.pools([pool])).get(pool);
    const sa = m.getSqrtRatioAtTick(lo), sb = m.getSqrtRatioAtTick(hi);
    const sp0 = st ? (st.sqrtX96 < sa ? sa : st.sqrtX96 > sb ? sb : st.sqrtX96) : sa;
    const L0 = sp0 < sb ? m.liquidityForAmount0(sp0, sb, a0) : 0n;
    const L1 = sp0 > sa ? m.liquidityForAmount1(sa, sp0, a1) : 0n;
    return L0 > 0n && (L1 === 0n || L0 <= L1) ? 'MintA' : 'MintB';
  }

  async buildIncrease({ pool, position, amount0, amount1, slippageBps, owner }) {
    const pos = await this.ownerPosition(position);
    const a0 = BigInt(amount0), a1 = BigInt(amount1);
    const base = await this.baseSide(pool, pos.tickLower, pos.tickUpper, a0, a1);
    const pad = (x) => (x * BigInt(10_000 + Number(slippageBps))) / 10_000n;
    const res = await this.on(owner, async (ray) => {
      const { poolInfo, poolKeys } = await ray.clmm.getPoolInfoFromRpc(pool);
      return ray.clmm.increasePositionFromBase({
        poolInfo, poolKeys, ownerPosition: pos, ownerInfo: { useSOLBalance: true }, base,
        baseAmount: new BN((base === 'MintA' ? a0 : a1).toString()),
        otherAmountMax: new BN(pad(base === 'MintA' ? a1 : a0).toString()),
        txVersion: R.TxVersion.V0,
      });
    });
    return { groups: [RaydiumVenue.group(res)] };
  }

  async ownerPosition(position) {
    const [info] = await this.multi([position]);
    if (!info) throw new Error(`posisi Raydium ${position} tidak ada`);
    return R.PersonalPositionLayout.decode(info.data);
  }

  // Withdraw a given L (0 = only claim fees); close = withdraw everything + burn the position NFT.
  async buildDecrease({ pool, position, liquidity, close, slippageBps, owner }) {
    const pos = await this.ownerPosition(position);
    const L = close ? big(pos.liquidity) : BigInt(String(liquidity));
    // Lower bound on amounts: the withdrawal value at the current price minus slippage.
    let min0 = 0n, min1 = 0n;
    if (L > 0n) {
      const st = (await this.pools([pool])).get(pool);
      if (st) {
        const r = m.amountsForLiquidity(st.sqrtX96, m.getSqrtRatioAtTick(pos.tickLower), m.getSqrtRatioAtTick(pos.tickUpper), L);
        const cut = (x) => (x * BigInt(10_000 - Number(slippageBps))) / 10_000n;
        min0 = cut(r.amount0); min1 = cut(r.amount1);
      }
    }
    const res = await this.on(owner, async (ray) => {
      const { poolInfo, poolKeys } = await ray.clmm.getPoolInfoFromRpc(pool);
      return ray.clmm.decreaseLiquidity({
        poolInfo, poolKeys, ownerPosition: pos,
        ownerInfo: { useSOLBalance: true, closePosition: !!close },
        liquidity: new BN(L.toString()), amountMinA: new BN(min0.toString()), amountMinB: new BN(min1.toString()),
        txVersion: R.TxVersion.V0,
      });
    });
    return { groups: [RaydiumVenue.group(res)] };
  }

  async buildClaim({ pool, position, owner }) {
    return this.buildDecrease({ pool, position, liquidity: 0n, close: false, slippageBps: 0, owner });
  }

  nativeRange(poolState, tickLower, tickUpper) {
    const lo = m.alignTick(Math.floor(tickLower), poolState.spacing, 'down');
    const hi = m.alignTick(Math.ceil(tickUpper), poolState.spacing, 'up');
    return { lower: lo, upper: hi > lo ? hi : lo + poolState.spacing };
  }
  ticksOf(poolState, lower, upper) { return { tickLower: lower, tickUpper: upper }; }
}

module.exports = { RaydiumVenue, PROGRAM };
