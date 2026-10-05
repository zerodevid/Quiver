'use strict';
const { ensureChain } = require('./networks');
// Compute unclaimed fees for Uniswap v4 positions, straight from the PoolManager
// storage via extsload. The layout was verified on Robinhood Chain: L read from
// storage is identical to getPositionLiquidity(tokenId).
//
// Layout of Pool.State inside the _pools mapping (slot 6):
//   +0 slot0 | +1 feeGrowthGlobal0 | +2 feeGrowthGlobal1 | +3 liquidity
//   +4 ticks | +5 tickBitmap | +6 positions
const { ethers } = require('ethers');
const { ABI } = require('./chain');

const coder = ethers.AbiCoder.defaultAbiCoder();
const IF_EXT = new ethers.Interface(['function extsload(bytes32 slot) view returns (bytes32)']);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const Q128 = 1n << 128n;
const MOD = 1n << 256n;
const PIN_LAG = 3;
const sub = (a, b) => ((a - b) % MOD + MOD) % MOD;   // wrapping subtraction, like Solidity

const slotHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const poolBase = (poolId) => BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6n])));
const tickSlot = (base, tick) => BigInt(ethers.keccak256(coder.encode(['int24', 'uint256'], [tick, base + 4n])));
function positionSlot(base, owner, tickLower, tickUpper, salt) {
  const key = ethers.keccak256(ethers.solidityPacked(
    ['address', 'int24', 'int24', 'bytes32'], [owner, tickLower, tickUpper, salt]));
  return BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [key, base + 6n])));
}

/**
 * Unclaimed fees for a batch of v4 positions.
 * items: [{poolId, tickLower, tickUpper, tokenId}]
 * curTickByPool: Map poolId -> current tick
 * Returned in parallel: [{fee0, fee1, liquidity}]
 */
async function unclaimedV4(chain, items, curTickByPool, rpc = null) {
  if (!items.length) return [];
  chain = ensureChain(chain);
  const { ADDR } = chain;
  rpc = rpc || chain.rpc;
  const calls = [];
  const idx = [];
  for (const it of items) {
    const base = poolBase(it.poolId);
    const salt = slotHex(BigInt(it.tokenId));
    const ps = positionSlot(base, ADDR.posmV4, it.tickLower, it.tickUpper, salt);
    const tl = tickSlot(base, it.tickLower), tu = tickSlot(base, it.tickUpper);
    const slots = [
      base + 1n, base + 2n,          // fgGlobal0, fgGlobal1
      tl + 1n, tl + 2n,              // fgOutside at tickLower
      tu + 1n, tu + 2n,              // fgOutside at tickUpper
      ps, ps + 1n, ps + 2n,          // L, fgInside0Last, fgInside1Last
      base,                          // slot0 → tick, read at the same block
    ];
    idx.push([calls.length, slots.length]);
    for (const s of slots) calls.push({ to: ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', [slotHex(s)]) });
  }
  // All slots are read at ONE block. With 'latest', batch chunks / retries can
  // land on another endpoint at a different block: L after the mint but fgInsideLast or
  // fgOutside from before the mint (zero) → fee = L × the pool's entire fee history. Once
  // it went into lp3's equity as a momentary +$591 (2026-09-22). Step back a few blocks so
  // a slightly lagging endpoint still has the state (publicnode refuses >~50).
  const head = typeof rpc.blockNumber === 'function' ? await rpc.blockNumber().catch(() => null) : null;
  const block = Number.isFinite(head) && head > PIN_LAG ? '0x' + (head - PIN_LAG).toString(16) : 'latest';
  const res = await rpc.ethCallMany(calls, block);
  const out = [];
  items.forEach((it, i) => {
    const [off, n] = idx[i];
    // A single slot failing to read → the fee cannot be computed. If forced to zero,
    // sub() wraps mod 2^256 and the result is a fee of 10^47 (this once went into equity).
    // `unknown` so the caller uses the last known figure, not zero.
    if (res.slice(off, off + n).some((x) => !x || x === '0x')) { out.push({ fee0: 0n, fee1: 0n, liquidity: 0n, unknown: true }); return; }
    const v = (k) => BigInt(res[off + k]);
    const fg0 = v(0), fg1 = v(1);
    const lo0 = v(2), lo1 = v(3), hi0 = v(4), hi1 = v(5);
    const L = v(6) & ((1n << 128n) - 1n);
    const last0 = v(7), last1 = v(8);
    // The tick from slot0 at the same block; a tick from another call (another block) that
    // jumped across the range boundary makes below/above land on the wrong side.
    const s0 = v(9);
    let cur = s0 ? Number((s0 >> 160n) & 0xffffffn) : curTickByPool?.get(it.poolId);
    if (s0 && cur >= 0x800000) cur -= 0x1000000;
    if (cur == null || L === 0n) { out.push({ fee0: 0n, fee1: 0n, liquidity: L }); return; }
    const below0 = cur >= it.tickLower ? lo0 : sub(fg0, lo0);
    const below1 = cur >= it.tickLower ? lo1 : sub(fg1, lo1);
    const above0 = cur < it.tickUpper ? hi0 : sub(fg0, hi0);
    const above1 = cur < it.tickUpper ? hi1 : sub(fg1, hi1);
    const inside0 = sub(sub(fg0, below0), above0);
    const inside1 = sub(sub(fg1, below1), above1);
    out.push({
      fee0: (L * sub(inside0, last0)) / Q128,
      fee1: (L * sub(inside1, last1)) / Q128,
      liquidity: L,
    });
  });
  return out;
}

/** v3: tokensOwed is only updated on a "poke", so we simulate collect via eth_call. */
// npmAddr: the NPM of the venue in question (default the main 'v3' venue; BSC also has 'pancakev3').
async function unclaimedV3(chain, tokenIds, owner, npmAddr = null, rpc = null) {
  if (!tokenIds.length) return [];
  chain = ensureChain(chain);
  npmAddr = npmAddr || chain.ADDR.npmV3;
  rpc = rpc || chain.rpc;
  const MAXU128 = (1n << 128n) - 1n;
  const calls = tokenIds.map((id) => ({
    to: npmAddr,
    data: IF_NPM.encodeFunctionData('collect', [[id, owner, MAXU128, MAXU128]]),
  }));
  const res = await rpc.batch(calls.map((c) => ({ method: 'eth_call', params: [{ from: owner, to: c.to, data: c.data }, 'latest'] })));
  return res.map((r) => {
    if (!r || r.error || !r.result || r.result === '0x') return { fee0: 0n, fee1: 0n };
    try {
      const d = IF_NPM.decodeFunctionResult('collect', r.result);
      return { fee0: BigInt(d[0]), fee1: BigInt(d[1]) };
    } catch { return { fee0: 0n, fee1: 0n }; }
  });
}

module.exports = { unclaimedV4, unclaimedV3, poolBase, positionSlot, tickSlot };

/**
 * Fees accumulated on a v4 position EXACTLY before block `block`, read from the
 * PoolManager storage via an archive node (state at block-1).
 *
 * This is the amount paid to the owner on modifyLiquidity in that block — in v4,
 * every modifyLiquidity (add, decrease, or zero delta) settles the fees
 * owed. Verified: the result is identical down to the last digit with
 * "tokens out minus principal" on a transaction that is not netted.
 *
 * Why it is needed: an automatic rebalance closes the old position and opens a new one in
 * a single unlock. Flash accounting nets the funds, so there is NO ERC20 Transfer —
 * Transfer-based methods see zero and the fee is lost.
 *
 * Returns: { fee0, fee1, sqrtPriceX96, tick, liquidity } or null.
 */
async function feesAtBlock(chain, { poolId, tickLower, tickUpper, tokenId, block }, rpc = null) {
  chain = ensureChain(chain);
  const { ADDR } = chain;
  rpc = rpc || chain.rpc;
  const base = poolBase(poolId);
  const ps = positionSlot(base, ADDR.posmV4, tickLower, tickUpper, slotHex(BigInt(tokenId)));
  const tl = tickSlot(base, tickLower), tu = tickSlot(base, tickUpper);
  const slots = [base, base + 1n, base + 2n, tl + 1n, tl + 2n, tu + 1n, tu + 2n, ps, ps + 1n, ps + 2n];
  const tag = '0x' + (block - 1).toString(16);
  const res = await rpc.batch(slots.map((sl) => ({
    method: 'eth_call',
    params: [{ to: ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', [slotHex(sl)]) }, tag],
  })), { archive: true });
  if (res.some((r) => !r || r.error || !r.result)) return null;
  const v = res.map((r) => BigInt(r.result));
  const [s0, g0, g1, lo0, lo1, hi0, hi1, Lw, last0, last1] = v;
  const sqrtPriceX96 = s0 & ((1n << 160n) - 1n);
  const tick = Number(BigInt.asIntN(24, (s0 >> 160n) & 0xffffffn));
  const L = Lw & ((1n << 128n) - 1n);
  if (sqrtPriceX96 === 0n) return null;
  const below0 = tick >= tickLower ? lo0 : sub(g0, lo0);
  const below1 = tick >= tickLower ? lo1 : sub(g1, lo1);
  const above0 = tick < tickUpper ? hi0 : sub(g0, hi0);
  const above1 = tick < tickUpper ? hi1 : sub(g1, hi1);
  const in0 = sub(sub(g0, below0), above0);
  const in1 = sub(sub(g1, below1), above1);
  return {
    fee0: L === 0n ? 0n : (L * sub(in0, last0)) / Q128,
    fee1: L === 0n ? 0n : (L * sub(in1, last1)) / Q128,
    sqrtPriceX96, tick, liquidity: L,
  };
}

module.exports.feesAtBlock = feesAtBlock;
