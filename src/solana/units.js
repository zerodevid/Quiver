'use strict';
// Shared units: every Solana position is expressed in Uniswap units — base-1.0001 ticks and
// sqrtPriceX96 over raw amounts (token1 per token0) — so the tick_lower/tick_upper/entry_sqrt
// columns, the dashboard price formula (1.0001^tick), the exit triggers
// (distanceFromRangePct) and valuation (valueInQuote) apply without a per-chain branch.
//
//   Orca Whirlpools : tick 1.0001, sqrtPrice Q64.64        -> tick as is, sqrt << 32
//   Raydium CLMM    : tick 1.0001, sqrtPriceX64 Q64.64     -> same as Orca
//   Meteora DLMM    : bin price = (1 + binStep/10⁴)^binId  -> equivalent tick (see binToTick)
//
// token0 = the pool's token X / A, token1 = token Y / B — all three programs express the price
// as Y per X (raw), the same as Uniswap's token1-per-token0 convention.
const Decimal = require('decimal.js');

const LN_TICK = Math.log(1.0001);
const Q32 = 1n << 32n;
const Q96 = 1n << 96n;

// sqrt Q64.64 (Orca, Raydium) -> Q64.96
const x64ToX96 = (s) => BigInt(s.toString()) * Q32;

// How many 1.0001 ticks per bin. binStep 1 = exactly 1; binStep 100 ≈ 99.5.
const ticksPerBin = (binStep) => Math.log(1 + Number(binStep) / 10_000) / LN_TICK;

// The equivalent tick of a bin. floor, so the order holds and the range check matches:
// active bin a is in [lower, upper] ⇔ binToTick(a) is in [binToTick(lower),
// binToTick(upper + 1)) — one bin is ≥ 1 tick wide, so no two bins land on the same tick.
const binToTick = (binId, binStep) => Math.floor(Number(binId) * ticksPerBin(binStep));

// Inclusive bin range [lower, upper] -> half-open tick range [lo, hi).
const binRangeToTicks = (lower, upper, binStep) => ({
  tickLower: binToTick(lower, binStep),
  tickUpper: binToTick(Number(upper) + 1, binStep),
});

// The reverse, for planning our own range: the bin that CONTAINS the tick, i.e.
// b with binToTick(b) ≤ tick < binToTick(b + 1). The first guess from the division can be
// off by one because binToTick floors — corrected in both directions.
function tickToBin(tick, binStep) {
  const t = Number(tick);
  let b = Math.floor(t / ticksPerBin(binStep));
  while (binToTick(b + 1, binStep) <= t) b++;
  while (binToTick(b, binStep) > t) b--;
  return b;
}

// sqrtPriceX96 from a raw price (Y per X). Through Decimal: 2^96 × √p exceeds double
// precision long before any reasonable memecoin price.
function sqrtX96FromPrice(pRaw) {
  const d = new Decimal(pRaw.toString());
  if (!(d.gt(0))) return 0n;
  return BigInt(d.sqrt().mul(new Decimal(2).pow(96)).toFixed(0));
}
// Raw price of a DLMM bin: (1 + binStep/10⁴)^binId.
const binPriceRaw = (binId, binStep) => new Decimal(1).add(new Decimal(binStep).div(10_000)).pow(binId);
const binSqrtX96 = (binId, binStep) => sqrtX96FromPrice(binPriceRaw(binId, binStep));

// Price (token1 per token0, decimal-adjusted) from sqrtPriceX96.
function priceFromSqrtX96(sqrt, dec0, dec1) {
  const r = Number(BigInt(sqrt)) / Number(Q96);
  return r * r * 10 ** (Number(dec0) - Number(dec1));
}

module.exports = { x64ToX96, ticksPerBin, binToTick, binRangeToTicks, tickToBin, sqrtX96FromPrice, binPriceRaw, binSqrtX96, priceFromSqrtX96, Q96 };
