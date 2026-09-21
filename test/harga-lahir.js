'use strict';
// Uji harga pool di blok kejadian (WalletResearch.priceAt) untuk pool yang belum
// pernah di-swap.
//
// Kasus nyata (lp3, 2026-09-21): target membuat pool USDG/THOT dan langsung mint
// $1.000 di blok yang sama, lalu menutupnya 1 menit kemudian tanpa ada Swap satu
// pun. Node arsip belum punya state pool di blok sebelumnya, pencarian Swap
// kosong, jadi mint-nya "tanpa harga": posisi tercatat bermodal $0 dan tampil
// "untung +$1.000" — dan tidak pernah sembuh, karena memang tidak ada Swap yang
// bisa ditemukan. Harga mint yang benar ada di event Initialize pool itu.
//
// Jalankan: node test/harga-lahir.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { WalletResearch } = require('../src/wallet');
const { ADDR, TOPIC } = require('../src/chain');
const m = require('../src/v3math');

const POOL = '0x' + '54'.repeat(32);
const MEME = '0xe20359d3e4cb4540c3383452116c90f27cd92e34';
const HEAD = 1_000_000;
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexb = (b) => '0x' + b.toString(16);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

const initLog = (block, sqrt) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x0', transactionHash: '0x' + w(block),
  topics: [TOPIC.initializeV4, POOL, pad32(ADDR.usdg), pad32(MEME)],
  data: '0x' + w(10000) + w(200) + w(0) + w(sqrt) + w(0),
});
const swapLog = (block, sqrt) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x1', transactionHash: '0x' + w(block + 7),
  topics: [TOPIC.swapV4, POOL, pad32('0x' + '99'.repeat(20))],
  data: '0x' + w(0) + w(0) + w(sqrt) + w(0) + w(0) + w(0),
});

function dunia({ logs = [], arsip = false } = {}) {
  const store = new Store(':memory:');
  const hit = { logs: 0 };
  const rpc = {
    blockNumber: async () => HEAD,
    hasArchive: () => arsip,
    callAt: async () => '0x' + w(0),   // pool belum ada di blok sebelumnya
    getLogs: async (f) => {
      hit.logs++;
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return logs.filter((l) => {
        if (String(f.address).toLowerCase() !== l.address.toLowerCase()) return false;
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        return (f.topics || []).every((s, i) => s == null || s === l.topics[i]);
      });
    },
  };
  const chain = new Chain(rpc, store, () => {});
  const research = new WalletResearch({ rpc, store, chain, log: () => {} });
  return { store, research, hit };
}

const S_LAHIR = m.getSqrtRatioAtTick(-200000);
const S_SWAP1 = m.getSqrtRatioAtTick(-199000);
const S_SWAP2 = m.getSqrtRatioAtTick(-198000);

(async () => {
  console.log('\nHarga pool di blok kejadian (pool tanpa Swap)');

  await t('REGRESI: pool lahir di blok mint, belum pernah di-swap -> harga Initialize', async () => {
    const { research, store } = dunia({ logs: [initLog(500_000, S_LAHIR)] });
    const s = await research.priceAt(POOL, 500_000);
    assert.strictEqual(s, S_LAHIR, 'harga mint = harga lahir pool');
    const row = store.get('SELECT init_block, init_sqrt FROM pools WHERE pool_ref=?', POOL);
    assert.strictEqual(row.init_block, 500_000, 'harga lahir disimpan di tabel pools');
    assert.strictEqual(row.init_sqrt, S_LAHIR.toString());
  });

  await t('sama dengan node arsip yang belum punya state pool di blok sebelumnya', async () => {
    const { research } = dunia({ logs: [initLog(500_000, S_LAHIR)], arsip: true });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_LAHIR);
  });

  await t('Swap sesudah kejadian tidak mengalahkan harga lahir kalau belum ada Swap sebelumnya', async () => {
    const { research } = dunia({ logs: [initLog(499_900, S_LAHIR), swapLog(500_050, S_SWAP1)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_LAHIR, 'sampai blok 500.000 pool masih di harga lahirnya');
  });

  await t('Swap TERAKHIR sebelum kejadian yang dipakai, bukan yang terdekat sesudahnya', async () => {
    const { research } = dunia({ logs: [initLog(400_000, S_LAHIR), swapLog(499_990, S_SWAP1), swapLog(500_001, S_SWAP2)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_SWAP1);
  });

  await t('tanpa Swap sebelumnya dan pool lahir di luar jendela -> Swap sesudahnya jadi taksiran', async () => {
    const { research } = dunia({ logs: [initLog(10, S_LAHIR), swapLog(500_300, S_SWAP2)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_SWAP2);
  });

  await t('tidak ada apa-apa sama sekali -> null, tidak di-cache', async () => {
    const { research, hit } = dunia({ logs: [] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), null);
    const n = hit.logs;
    assert.strictEqual(await research.priceAt(POOL, 500_000), null);
    assert.ok(hit.logs > n, 'kegagalan dibaca ulang, bukan diingat');
  });

  await t('harga lahir dibaca sekali per pool (kejadian kedua memakai simpanan)', async () => {
    const { research, hit, store } = dunia({ logs: [initLog(500_000, S_LAHIR)] });
    await research.priceAt(POOL, 500_000);
    store.run('DELETE FROM wprices');   // paksa hitung ulang, tapi tabel pools tetap
    research.priceCache.clear();
    const n = hit.logs;
    await research.priceAt(POOL, 500_100);
    // hanya pencarian Swap (1 jendela: pool lahir di dalamnya), tanpa pencarian Initialize lagi
    assert.strictEqual(hit.logs - n, 1, `getLogs dipanggil ${hit.logs - n}x, seharusnya 1`);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
