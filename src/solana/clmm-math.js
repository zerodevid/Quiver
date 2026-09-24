'use strict';
// Matematika fee bersama Orca Whirlpools dan Raydium CLMM — keduanya salinan rumus
// Uniswap v3 dalam titik tetap Q64 (bukan Q128): fee yang belum diklaim =
//   owed + (feeGrowthInside − checkpoint) × L >> 64
// dengan semua pengurangan pertumbuhan modulo 2^128 (boleh "berputar").
const U128 = (1n << 128n) - 1n;
const sub128 = (a, b) => (a - b) & U128;
const big = (x) => (x == null ? 0n : BigInt(x.toString()));

// global: pertumbuhan global pool; lowerOut/upperOut: feeGrowthOutside tick batas.
function feeGrowthInside({ tickCurrent, tickLower, tickUpper, global, lowerOut, upperOut }) {
  const below = tickCurrent >= tickLower ? lowerOut : sub128(global, lowerOut);
  const above = tickCurrent < tickUpper ? upperOut : sub128(global, upperOut);
  return sub128(sub128(global, below), above);
}

function unclaimed({ liquidity, inside, checkpoint, owed }) {
  return big(owed) + ((sub128(big(inside), big(checkpoint)) * big(liquidity)) >> 64n);
}

module.exports = { feeGrowthInside, unclaimed, sub128, big };
