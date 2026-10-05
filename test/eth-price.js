'use strict';
// Test: the ETH price from the ETH/USDG pools is not fooled by one swept/lagging pool.
// Run: node test/eth-price.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Chain, POOLS_SLOT } = require('../src/pools');
const { Store } = require('../src/db');
const m = require('../src/v3math');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); } }
const cand = (price, L, id) => ({ p: { poolId: id }, s: {}, L, price });

(async () => {
  console.log('ETH price:\n');

  await t('the deepest pool is used if it agrees with the other pools', () => {
    const r = Chain.pickEthPrice([cand(2500, 10n ** 20n, 'a'), cand(2510, 10n ** 19n, 'b'), cand(2490, 10n ** 18n, 'c')]);
    assert.strictEqual(r.price, 2500); assert.strictEqual(r.poolId, 'a'); assert.strictEqual(r.outlier, null);
  });

  await t('pool terdalam menyimpang > 3% (disapu / node tertinggal) → median tiga terdalam', () => {
    const r = Chain.pickEthPrice([cand(9000, 10n ** 20n, 'a'), cand(2510, 10n ** 19n, 'b'), cand(2490, 10n ** 18n, 'c'), cand(100, 1n, 'd')]);
    assert.strictEqual(r.price, 2510); assert.strictEqual(r.poolId, 'b'); assert.strictEqual(r.outlier, 9000);
  });

  await t('fewer than three pools: the deepest as it is; without candidates: null', () => {
    assert.strictEqual(Chain.pickEthPrice([cand(3000, 5n, 'a'), cand(2000, 9n, 'b')]).price, 2000);
    assert.strictEqual(Chain.pickEthPrice([]), null);
  });

  const fcand = (price, L, id, fee) => ({ p: { poolId: id, fee }, s: {}, L, price });

  await t('the lowest-fee pool with real liquidity sets the price — a deeper 2.5%-fee pool can sit 2.5% off (2026-10-01)', () => {
    // live values from Robinhood: 2.5% fee $2750.85 deepest, 25% fee, 0.0021% fee at ~4% of the depth
    const r = Chain.pickEthPrice([
      fcand(2750.85, 878_603_456_670n, 'deep25bps', 25_000), fcand(2690.84, 518_732_829_038n, 'fee25pct', 250_000),
      fcand(2685.54, 34_187_957_250n, 'tight', 21), fcand(2666.15, 930_109_258n, 'dust', 9111),
    ]);
    assert.strictEqual(r.poolId, 'tight');
    assert.strictEqual(r.price, 2685.54);
    assert.strictEqual(r.outlier, null);
  });

  await t('a low-fee pool below 1% of the deepest liquidity is ignored (too thin to trust)', () => {
    const r = Chain.pickEthPrice([fcand(2500, 10n ** 20n, 'deep', 3000), fcand(2400, 10n ** 17n, 'thin', 100), fcand(2505, 10n ** 19n, 'mid', 3000)]);
    assert.strictEqual(r.poolId, 'deep');
  });

  await t('the chosen low-fee pool is still fenced: > 3% from the median of the three deepest → median', () => {
    const r = Chain.pickEthPrice([fcand(2500, 10n ** 20n, 'a', 3000), fcand(2510, 10n ** 19n, 'b', 3000), fcand(2490, 10n ** 19n, 'c', 3000), fcand(3000, 10n ** 18n, 'tight', 1)]);
    assert.strictEqual(r.price, 2500); assert.strictEqual(r.outlier, 3000);
  });

  await t('candidates without a fee (BSC v3pools mode) keep the deepest-first rule', () => {
    const r = Chain.pickEthPrice([cand(600, 10n ** 20n, 'a'), cand(601, 10n ** 19n, 'b'), cand(599, 10n ** 18n, 'c')]);
    assert.strictEqual(r.poolId, 'a');
  });

  await t('ethUsd: a pool without active liquidity or with its price at the tick bound is not included; failed read → last value', async () => {
    const store = new Store(':memory:');
    const pools = [{ poolId: '0x' + 'a1'.repeat(32), fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) }, { poolId: '0x' + 'b2'.repeat(32), fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) }];
    store.setState('eth_usdg_pools:robinhood', JSON.stringify(pools));
    // price 2500 USDG/ETH: sqrt = sqrt(2500e6/1e18) * 2^96
    const sqrtOf = (price) => BigInt(Math.floor(Math.sqrt(price * 1e6 / 1e18) * 2 ** 96));
    const word = (sqrt, tick) => '0x' + ((BigInt.asUintN(24, BigInt(tick)) << 160n) | sqrt).toString(16).padStart(64, '0');
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const slotOf = (id) => ethers.keccak256(coder.encode(['bytes32', 'uint256'], [id, POOLS_SLOT]));
    let mode = 'ok';
    const rpc = {
      blockNumber: async () => 1000,
      ethCallMany: async (calls) => calls.map((c) => {
        if (mode === 'gagal') return null;
        const slot = '0x' + c.data.slice(-64);
        for (const [i, p] of pools.entries()) {
          const base = BigInt(slotOf(p.poolId));
          if (BigInt(slot) === base) return i === 0 ? word(sqrtOf(2500), m.getTickAtSqrtRatio(sqrtOf(2500))) : word(m.getSqrtRatioAtTick(887200), 887200);   // pool b: price at the bound
          if (BigInt(slot) === base + 3n) return '0x' + (i === 0 ? '5' : '9').padStart(64, '0');   // pool b is "deeper" but not usable
        }
        return null;
      }),
    };
    const chain = new Chain(rpc, store, () => {});
    chain.nativeUsdMode = 'v4pool';   // this case exercises the on-chain read
    const p1 = await chain.ethUsd(1);
    assert.ok(Math.abs(p1 - 2500) < 1, String(p1));
    chain._ethUsdAt = 0; mode = 'gagal';
    assert.strictEqual(await chain.ethUsd(p1), p1, 'failed read: the caller passes the last value as a fallback');
  });

  const resp = (j, ok = true) => ({ ok, json: async () => j });
  const fetchOf = (map) => async (url) => { const k = Object.keys(map).find((h) => url.includes(h)); if (!k || map[k] === 'down') throw new Error('down'); return resp(map[k]); };

  await t('global price: the median of the sources that answer; garbage and dead sources are skipped', async () => {
    const all = { coinbase: { data: { amount: '2699.7' } }, binance: { price: '2700.00' }, coingecko: { ethereum: { usd: 2697 } } };
    assert.strictEqual(await Chain.globalEthPrice(fetchOf(all)), 2699.7);
    assert.strictEqual(await Chain.globalEthPrice(fetchOf({ ...all, binance: 'down' })), (2699.7 + 2697) / 2);
    assert.strictEqual(await Chain.globalEthPrice(fetchOf({ ...all, coinbase: { data: { amount: '0' } }, binance: 'down' })), 2697);
    assert.strictEqual(await Chain.globalEthPrice(fetchOf({ coinbase: 'down', binance: 'down', coingecko: 'down' })), null);
  });

  await t('global mode: the global price wins over the pools; with no answer it falls back to the on-chain read', async () => {
    const store = new Store(':memory:');
    const chain = new Chain({ blockNumber: async () => { throw new Error('rpc down'); } }, store, () => {});
    assert.strictEqual(chain.nativeUsdMode, 'global');
    const real = Chain.globalEthPrice;
    try {
      Chain.globalEthPrice = async () => 2699.5;
      assert.strictEqual(await chain.ethUsd(1), 2699.5);
      chain._ethUsd = 0; Chain.globalEthPrice = async () => null;
      assert.strictEqual(await chain.ethUsd(1234), 1234, 'no global answer and no pools: the caller fallback');
    } finally { Chain.globalEthPrice = real; }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
