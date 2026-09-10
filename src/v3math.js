'use strict';
// Matematika konsentrasi likuiditas Uniswap v3/v4 dengan BigInt penuh (tanpa float).
// Rumus identik untuk v3 dan v4 — yang berbeda cuma cara menyimpan posisinya.

const Q96 = 2n ** 96n;
const Q128 = 2n ** 128n;
const MaxUint256 = 2n ** 256n - 1n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;
const MIN_SQRT_RATIO = 4295128739n;
const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const MUL = [
  [0x1, 0xfffcb933bd6fad37aa2d162d1a594001n], [0x2, 0xfff97272373d413259a46990580e213an],
  [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n],
  [0x40, 0xff2ea16466c96a3843ec78b326b52861n], [0x80, 0xfe5dee046a99a2a811c461f1969c3053n],
  [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n],
  [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n], [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n],
  [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n],
  [0x40000, 0x2216e584f5fa1ea926041bedfe98n], [0x80000, 0x48a170391f7dc42444e8fa2n],
];

function getSqrtRatioAtTick(tick) {
  tick = Number(tick);
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick di luar batas: ${tick}`);
  const abs = tick < 0 ? -tick : tick;
  let ratio = (abs & 0x1) !== 0 ? MUL[0][1] : 0x100000000000000000000000000000000n;
  for (let i = 1; i < MUL.length; i++) {
    if ((abs & MUL[i][0]) !== 0) ratio = (ratio * MUL[i][1]) >> 128n;
  }
  if (tick > 0) ratio = MaxUint256 / ratio;
  // Q128.128 -> Q64.96, dibulatkan ke atas
  return ratio % (2n ** 32n) > 0n ? ratio / (2n ** 32n) + 1n : ratio / (2n ** 32n);
}

// Cari tick terbesar yang sqrtRatio-nya <= sqrtX96 (pencarian biner: cukup ~21 iterasi)
function getTickAtSqrtRatio(sqrtX96) {
  if (sqrtX96 < MIN_SQRT_RATIO || sqrtX96 >= MAX_SQRT_RATIO) throw new Error('sqrtPrice di luar batas');
  let lo = MIN_TICK, hi = MAX_TICK;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (getSqrtRatioAtTick(mid) <= sqrtX96) lo = mid; else hi = mid - 1;
  }
  return lo;
}

const mulDiv = (a, b, d) => (a * b) / d;

// jumlah token0 yang diwakili L pada rentang [sqrtA, sqrtB]
function amount0ForLiquidity(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtA <= 0n) return 0n;
  return mulDiv(L << 96n, sqrtB - sqrtA, sqrtB) / sqrtA;
}
function amount1ForLiquidity(sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  return mulDiv(L, sqrtB - sqrtA, Q96);
}

// Jumlah kedua token untuk posisi L pada [tickLower,tickUpper] saat harga sqrtP
function amountsForLiquidity(sqrtP, sqrtA, sqrtB, L) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return { amount0: amount0ForLiquidity(sqrtA, sqrtB, L), amount1: 0n };
  if (sqrtP < sqrtB) {
    return { amount0: amount0ForLiquidity(sqrtP, sqrtB, L), amount1: amount1ForLiquidity(sqrtA, sqrtP, L) };
  }
  return { amount0: 0n, amount1: amount1ForLiquidity(sqrtA, sqrtB, L) };
}

function liquidityForAmount0(sqrtA, sqrtB, amount0) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtB === sqrtA) return 0n;
  return mulDiv(mulDiv(amount0, sqrtA, Q96), sqrtB, sqrtB - sqrtA);
}
function liquidityForAmount1(sqrtA, sqrtB, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtB === sqrtA) return 0n;
  return mulDiv(amount1, Q96, sqrtB - sqrtA);
}
function liquidityForAmounts(sqrtP, sqrtA, sqrtB, amount0, amount1) {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  if (sqrtP <= sqrtA) return liquidityForAmount0(sqrtA, sqrtB, amount0);
  if (sqrtP < sqrtB) {
    const l0 = liquidityForAmount0(sqrtP, sqrtB, amount0);
    const l1 = liquidityForAmount1(sqrtA, sqrtP, amount1);
    return l0 < l1 ? l0 : l1;
  }
  return liquidityForAmount1(sqrtA, sqrtB, amount1);
}

// harga token1 per token0 (sudah disesuaikan desimal), sebagai Number untuk tampilan
function priceFromSqrt(sqrtX96, dec0, dec1) {
  const num = Number(sqrtX96) / Number(Q96);
  return num * num * 10 ** (Number(dec0) - Number(dec1));
}
function tickToPrice(tick, dec0, dec1) {
  return priceFromSqrt(getSqrtRatioAtTick(tick), dec0, dec1);
}
// tick terdekat untuk sebuah harga (token1 per token0, sudah disesuaikan desimal)
function priceToTick(price, dec0, dec1) {
  const raw = price * 10 ** (Number(dec1) - Number(dec0));
  if (!(raw > 0) || !Number.isFinite(raw)) throw new Error('harga tidak valid');
  const t = Math.log(raw) / Math.log(1.0001);
  return Math.max(MIN_TICK, Math.min(MAX_TICK, Math.round(t)));
}

// Bulatkan tick ke kelipatan tickSpacing. mode: 'down' | 'up' | 'nearest'
function alignTick(tick, spacing, mode = 'nearest') {
  const s = Number(spacing);
  if (!s) return Number(tick);
  const t = Number(tick);
  const down = Math.floor(t / s) * s;
  const up = down + (t % s === 0 ? 0 : s);
  let v = mode === 'down' ? down : mode === 'up' ? up : (t - down <= up - t ? down : up);
  return Math.max(Math.ceil(MIN_TICK / s) * s, Math.min(Math.floor(MAX_TICK / s) * s, v));
}

// Posisi berada di sisi mana relatif harga sekarang
function sideOfRange(tick, tickLower, tickUpper) {
  if (tick < tickLower) return 'token0_only';   // harga di bawah rentang -> butuh token0 saja
  if (tick >= tickUpper) return 'token1_only';  // harga di atas rentang -> butuh token1 saja
  return 'both';
}

// Taksiran harga setelah swap di satu rentang likuiditas (L dianggap tetap).
// Dipakai untuk menolak zap yang dampaknya terlalu besar.
function sqrtAfterSwap(sqrtP, L, amountIn, zeroForOne) {
  if (L === 0n) return null;
  if (zeroForOne) {
    // jual token0: harga turun. sqrtP' = L*sqrtP / (L + amountIn*sqrtP/Q96)
    const denom = L + (amountIn * sqrtP) / Q96;
    return denom === 0n ? null : (L * sqrtP) / denom;
  }
  // jual token1: harga naik. sqrtP' = sqrtP + amountIn*Q96/L
  return sqrtP + (amountIn * Q96) / L;
}
function priceImpactBps(sqrtP, L, amountIn, zeroForOne) {
  const after = sqrtAfterSwap(sqrtP, L, amountIn, zeroForOne);
  if (after == null || sqrtP === 0n) return null;
  const p0 = Number(sqrtP), p1 = Number(after);
  const ratio = (p1 * p1) / (p0 * p0);
  return Math.abs(1 - ratio) * 10000;
}

module.exports = {
  sqrtAfterSwap, priceImpactBps,
  Q96, Q128, MIN_TICK, MAX_TICK, MIN_SQRT_RATIO, MAX_SQRT_RATIO,
  getSqrtRatioAtTick, getTickAtSqrtRatio,
  amount0ForLiquidity, amount1ForLiquidity, amountsForLiquidity,
  liquidityForAmount0, liquidityForAmount1, liquidityForAmounts,
  priceFromSqrt, tickToPrice, priceToTick, alignTick, sideOfRange,
};
