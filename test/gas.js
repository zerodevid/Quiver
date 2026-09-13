'use strict';
// Uji harga & cadangan gas: maxFeePerGas tidak boleh di bawah base fee blok terbaru
// (gasPrice basi dari endpoint tertinggal), dan cadangan ETH ikut naik saat gas mahal.
// Jalankan: node test/gas.js
const assert = require('node:assert');
const { Executor } = require('../src/executor');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const GWEI = 1_000_000_000n;
function exec(gasPrice, baseFee, { fail: f = false } = {}) {
  const rpc = {
    batch: async (calls) => {
      if (f) throw new Error('semua endpoint RPC tumbang');
      return calls.map((c) => (c.method === 'eth_gasPrice'
        ? { result: '0x' + gasPrice.toString(16) }
        : { result: baseFee == null ? null : { baseFeePerGas: '0x' + baseFee.toString(16) } }));
    },
  };
  return new Executor({ rpc, store: null, chain: null, cfg: { gas: { price_multiplier: 1.5, priority_wei: 10_000_000, native_reserve_wei: 2_000_000_000_000_000, max_gas_limit: 4_000_000 } }, log: () => {} });
}

(async () => {
  console.log('gas:');

  await t('gasPrice wajar: maxFee = gasPrice × 1,5', async () => {
    const f = await exec(100_000_000n, 50_000_000n).gasFees();
    assert.strictEqual(f.maxFeePerGas, 150_000_000n);
  });

  await t('gasPrice basi jauh di bawah base fee: maxFee dinaikkan ke 2× base fee + prioritas', async () => {
    const f = await exec(100_000_000n, 1n * GWEI).gasFees();
    assert.strictEqual(f.maxFeePerGas, 2n * GWEI + 10_000_000n);
  });

  await t('blok tanpa baseFee: tetap gasPrice × 1,5', async () => {
    const f = await exec(100_000_000n, null).gasFees();
    assert.strictEqual(f.maxFeePerGas, 150_000_000n);
  });

  await t('gasPrice ngawur dari satu endpoint (500 gwei, base 0,08): maxFee diapit ke batas 10 gwei', async () => {
    const e = exec(500n * GWEI, 85_000_000n);
    const f = await e.gasFees();
    assert.strictEqual(f.maxFeePerGas, 10n * GWEI);
    assert.ok(await e.gasReserve() <= 4_000_000n * 10n * GWEI, 'cadangan dinamis ikut terbatas');
  });

  await t('base fee sungguhan di atas batas: melempar dengan petunjuk gas.max_fee_gwei; batas bisa dinaikkan', async () => {
    await assert.rejects(exec(30n * GWEI, 20n * GWEI).gasFees(), /gas.max_fee_gwei/);
    const e = exec(30n * GWEI, 20n * GWEI);
    e.cfg.gas.max_fee_gwei = 100;
    assert.strictEqual((await e.gasFees()).maxFeePerGas, 45n * GWEI);
  });

  await t('gas murah: cadangan = cadangan tetap 0,002 ETH', async () => {
    assert.strictEqual(await exec(100_000_000n, 50_000_000n).gasReserve(), 2_000_000_000_000_000n);
  });

  await t('gas mahal (4 gwei): cadangan = 4 jt gas × maxFee, bukan 0,002 ETH', async () => {
    const e = exec(4n * GWEI, 4n * GWEI);
    const r = await e.gasReserve();
    assert.strictEqual(r, 4_000_000n * (8n * GWEI + 10_000_000n));
    assert.strictEqual(e.gasReserveCached(), r, 'versi sinkron memakai harga terakhir');
  });

  await t('harga gas tidak terbaca: cadangan tetap, tidak melempar', async () => {
    assert.strictEqual(await exec(0n, 0n, { fail: true }).gasReserve(), 2_000_000_000_000_000n);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
