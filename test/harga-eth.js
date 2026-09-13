'use strict';
// Uji: harga ETH dari pool ETH/USDG tidak tertipu satu pool yang disapu/tertinggal.
// Jalankan: node test/harga-eth.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Chain, POOLS_SLOT } = require('../src/pools');
const { Store } = require('../src/db');
const m = require('../src/v3math');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log(`  ok   ${name}`); } catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); } }
const cand = (price, L, id) => ({ p: { poolId: id }, s: {}, L, price });

(async () => {
  console.log('harga ETH:\n');

  await t('pool terdalam dipakai kalau sejalan dengan pool lain', () => {
    const r = Chain.pickEthPrice([cand(2500, 10n ** 20n, 'a'), cand(2510, 10n ** 19n, 'b'), cand(2490, 10n ** 18n, 'c')]);
    assert.strictEqual(r.price, 2500); assert.strictEqual(r.poolId, 'a'); assert.strictEqual(r.outlier, null);
  });

  await t('pool terdalam menyimpang > 3% (disapu / node tertinggal) → median tiga terdalam', () => {
    const r = Chain.pickEthPrice([cand(9000, 10n ** 20n, 'a'), cand(2510, 10n ** 19n, 'b'), cand(2490, 10n ** 18n, 'c'), cand(100, 1n, 'd')]);
    assert.strictEqual(r.price, 2510); assert.strictEqual(r.poolId, 'b'); assert.strictEqual(r.outlier, 9000);
  });

  await t('kurang dari tiga pool: terdalam apa adanya; tanpa kandidat: null', () => {
    assert.strictEqual(Chain.pickEthPrice([cand(3000, 5n, 'a'), cand(2000, 9n, 'b')]).price, 2000);
    assert.strictEqual(Chain.pickEthPrice([]), null);
  });

  await t('ethUsd: pool tanpa likuiditas aktif atau harga di batas tick tidak ikut; gagal baca → nilai terakhir', async () => {
    const store = new Store(':memory:');
    const pools = [{ poolId: '0x' + 'a1'.repeat(32), fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) }, { poolId: '0x' + 'b2'.repeat(32), fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) }];
    store.setState('eth_usdg_pools', JSON.stringify(pools));
    // harga 2500 USDG/ETH: sqrt = sqrt(2500e6/1e18) * 2^96
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
          if (BigInt(slot) === base) return i === 0 ? word(sqrtOf(2500), m.getTickAtSqrtRatio(sqrtOf(2500))) : word(m.getSqrtRatioAtTick(887200), 887200);   // pool b: harga di batas
          if (BigInt(slot) === base + 3n) return '0x' + (i === 0 ? '5' : '9').padStart(64, '0');   // pool b lebih "dalam" tapi tak layak
        }
        return null;
      }),
    };
    const chain = new Chain(rpc, store, () => {});
    const p1 = await chain.ethUsd(1);
    assert.ok(Math.abs(p1 - 2500) < 1, String(p1));
    chain._ethUsdAt = 0; mode = 'gagal';
    assert.strictEqual(await chain.ethUsd(p1), p1, 'gagal baca: pemanggil mengoper nilai terakhir sebagai cadangan');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
