'use strict';
const { ensureChain } = require('./networks');
// Hitung fee yang belum diklaim untuk posisi Uniswap v4, langsung dari storage
// PoolManager lewat extsload. Layout diverifikasi di Robinhood Chain: L hasil baca
// storage identik dengan getPositionLiquidity(tokenId).
//
// Tata letak Pool.State di dalam mapping _pools (slot 6):
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
const sub = (a, b) => ((a - b) % MOD + MOD) % MOD;   // pengurangan yang membungkus, seperti Solidity

const slotHex = (n) => '0x' + n.toString(16).padStart(64, '0');
const poolBase = (poolId) => BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [poolId, 6n])));
const tickSlot = (base, tick) => BigInt(ethers.keccak256(coder.encode(['int24', 'uint256'], [tick, base + 4n])));
function positionSlot(base, owner, tickLower, tickUpper, salt) {
  const key = ethers.keccak256(ethers.solidityPacked(
    ['address', 'int24', 'int24', 'bytes32'], [owner, tickLower, tickUpper, salt]));
  return BigInt(ethers.keccak256(coder.encode(['bytes32', 'uint256'], [key, base + 6n])));
}

/**
 * Fee belum diklaim untuk sekumpulan posisi v4.
 * items: [{poolId, tickLower, tickUpper, tokenId}]
 * curTickByPool: Map poolId -> tick sekarang
 * Balikan sejajar: [{fee0, fee1, liquidity}]
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
      tl + 1n, tl + 2n,              // fgOutside di tickLower
      tu + 1n, tu + 2n,              // fgOutside di tickUpper
      ps, ps + 1n, ps + 2n,          // L, fgInside0Last, fgInside1Last
      base,                          // slot0 → tick, dibaca di blok yang sama
    ];
    idx.push([calls.length, slots.length]);
    for (const s of slots) calls.push({ to: ADDR.poolManager, data: IF_EXT.encodeFunctionData('extsload', [slotHex(s)]) });
  }
  // Semua slot dibaca di SATU blok. Dengan 'latest', potongan batch / ulangan bisa
  // mendarat di endpoint lain pada blok berbeda: L sesudah mint tapi fgInsideLast atau
  // fgOutside dari sebelum mint (nol) → fee = L × seluruh riwayat fee pool. Pernah
  // masuk ekuitas lp3 sebagai +$591 sesaat (2026-09-22). Mundur beberapa blok supaya
  // endpoint yang sedikit tertinggal masih punya state-nya (publicnode menolak >~50).
  const head = typeof rpc.blockNumber === 'function' ? await rpc.blockNumber().catch(() => null) : null;
  const block = Number.isFinite(head) && head > PIN_LAG ? '0x' + (head - PIN_LAG).toString(16) : 'latest';
  const res = await rpc.ethCallMany(calls, block);
  const out = [];
  items.forEach((it, i) => {
    const [off, n] = idx[i];
    // Satu slot saja gagal terbaca → fee-nya tidak bisa dihitung. Kalau dipaksa nol,
    // sub() membungkus mod 2^256 dan hasilnya fee 10^47 (pernah masuk ke ekuitas).
    // `unknown` supaya pemanggil memakai angka terakhir yang diketahui, bukan nol.
    if (res.slice(off, off + n).some((x) => !x || x === '0x')) { out.push({ fee0: 0n, fee1: 0n, liquidity: 0n, unknown: true }); return; }
    const v = (k) => BigInt(res[off + k]);
    const fg0 = v(0), fg1 = v(1);
    const lo0 = v(2), lo1 = v(3), hi0 = v(4), hi1 = v(5);
    const L = v(6) & ((1n << 128n) - 1n);
    const last0 = v(7), last1 = v(8);
    // Tick dari slot0 di blok yang sama; tick dari panggilan lain (blok lain) yang
    // melompati batas rentang membuat below/above salah sisi.
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

/** v3: tokensOwed hanya diperbarui saat "poke", jadi kita simulasikan collect lewat eth_call. */
// npmAddr: NPM venue yang dimaksud (default venue 'v3' utama; BSC juga punya 'pancakev3').
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
 * Fee yang terkumpul pada sebuah posisi v4 TEPAT sebelum blok `block`, dibaca dari
 * storage PoolManager lewat node arsip (state di block-1).
 *
 * Inilah jumlah yang dibayarkan ke pemilik saat modifyLiquidity di blok itu — di v4,
 * setiap modifyLiquidity (tambah, kurangi, atau delta nol) menyelesaikan fee yang
 * terutang. Diverifikasi: hasilnya identik sampai digit terakhir dengan
 * "token keluar dikurangi pokok" pada transaksi yang tidak ter-netting.
 *
 * Kenapa perlu: rebalance otomatis menutup posisi lama dan membuka yang baru dalam
 * satu unlock. Flash accounting me-netting dananya, jadi TIDAK ADA Transfer ERC20 —
 * metode berbasis Transfer melihat nol dan fee-nya hilang.
 *
 * Balikan: { fee0, fee1, sqrtPriceX96, tick, liquidity } atau null.
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
