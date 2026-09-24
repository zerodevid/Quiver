'use strict';
// Satuan bersama: semua posisi Solana dinyatakan dalam satuan Uniswap — tick basis
// 1.0001 dan sqrtPriceX96 atas jumlah mentah (token1 per token0) — supaya kolom
// tick_lower/tick_upper/entry_sqrt, rumus harga dasbor (1.0001^tick), pemicu keluar
// (distanceFromRangePct), dan penilaian (valueInQuote) berlaku tanpa cabang per chain.
//
//   Orca Whirlpools : tick 1.0001, sqrtPrice Q64.64       -> tick apa adanya, sqrt << 32
//   Raydium CLMM    : tick 1.0001, sqrtPriceX64 Q64.64    -> sama dengan Orca
//   Meteora DLMM    : harga bin = (1 + binStep/10⁴)^binId -> tick setara (lihat binToTick)
//
// token0 = token X / A pool, token1 = token Y / B — ketiga program menyatakan harga
// sebagai Y per X (mentah), sama dengan konvensi token1 per token0 Uniswap.
const Decimal = require('decimal.js');

const LN_TICK = Math.log(1.0001);
const Q32 = 1n << 32n;
const Q96 = 1n << 96n;

// sqrt Q64.64 (Orca, Raydium) -> Q64.96
const x64ToX96 = (s) => BigInt(s.toString()) * Q32;

// Berapa tick 1.0001 per satu bin. binStep 1 = tepat 1; binStep 100 ≈ 99,5.
const ticksPerBin = (binStep) => Math.log(1 + Number(binStep) / 10_000) / LN_TICK;

// Tick setara sebuah bin. floor, supaya urutan terjaga dan cek rentang cocok:
// bin aktif a ada di [lower, upper] ⇔ binToTick(a) ada di [binToTick(lower),
// binToTick(upper + 1)) — lebar satu bin ≥ 1 tick, jadi tidak ada dua bin yang jatuh
// ke tick yang sama.
const binToTick = (binId, binStep) => Math.floor(Number(binId) * ticksPerBin(binStep));

// Rentang bin inklusif [lower, upper] -> rentang tick setengah-terbuka [lo, hi).
const binRangeToTicks = (lower, upper, binStep) => ({
  tickLower: binToTick(lower, binStep),
  tickUpper: binToTick(Number(upper) + 1, binStep),
});

// Kebalikannya, untuk merencanakan rentang kita sendiri: bin yang MEMUAT tick itu, yaitu
// b dengan binToTick(b) ≤ tick < binToTick(b + 1). Tebakan pertama dari pembagian bisa
// meleset satu karena binToTick memakai floor — dikoreksi ke dua arah.
function tickToBin(tick, binStep) {
  const t = Number(tick);
  let b = Math.floor(t / ticksPerBin(binStep));
  while (binToTick(b + 1, binStep) <= t) b++;
  while (binToTick(b, binStep) > t) b--;
  return b;
}

// sqrtPriceX96 dari harga mentah (Y per X). Lewat Decimal: 2^96 × √p melampaui presisi
// double jauh sebelum harga memecoin yang wajar.
function sqrtX96FromPrice(pRaw) {
  const d = new Decimal(pRaw.toString());
  if (!(d.gt(0))) return 0n;
  return BigInt(d.sqrt().mul(new Decimal(2).pow(96)).toFixed(0));
}
// Harga mentah bin DLMM: (1 + binStep/10⁴)^binId.
const binPriceRaw = (binId, binStep) => new Decimal(1).add(new Decimal(binStep).div(10_000)).pow(binId);
const binSqrtX96 = (binId, binStep) => sqrtX96FromPrice(binPriceRaw(binId, binStep));

// Harga (token1 per token0, sudah disesuaikan desimal) dari sqrtPriceX96.
function priceFromSqrtX96(sqrt, dec0, dec1) {
  const r = Number(BigInt(sqrt)) / Number(Q96);
  return r * r * 10 ** (Number(dec0) - Number(dec1));
}

module.exports = { x64ToX96, ticksPerBin, binToTick, binRangeToTicks, tickToBin, sqrtX96FromPrice, binPriceRaw, binSqrtX96, priceFromSqrtX96, Q96 };
