'use strict';
// Fee math shared by Orca Whirlpools and Raydium CLMM — both copy the Uniswap v3 formula
// in Q64 fixed point (not Q128): unclaimed fees =
//   owed + (feeGrowthInside − checkpoint) × L >> 64
// with every growth subtraction modulo 2^128 (it may wrap around).
const U128 = (1n << 128n) - 1n;
const sub128 = (a, b) => (a - b) & U128;
const big = (x) => (x == null ? 0n : BigInt(x.toString()));

// global: the pool's global growth; lowerOut/upperOut: feeGrowthOutside of the boundary ticks.
function feeGrowthInside({ tickCurrent, tickLower, tickUpper, global, lowerOut, upperOut }) {
  const below = tickCurrent >= tickLower ? lowerOut : sub128(global, lowerOut);
  const above = tickCurrent < tickUpper ? upperOut : sub128(global, upperOut);
  return sub128(sub128(global, below), above);
}

function unclaimed({ liquidity, inside, checkpoint, owed }) {
  return big(owed) + ((sub128(big(inside), big(checkpoint)) * big(liquidity)) >> 64n);
}

module.exports = { feeGrowthInside, unclaimed, sub128, big };
