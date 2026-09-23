'use strict';
// Uji bahwa metadata pool (pasangan token, fee, tickSpacing, hook) di tabel `pools`
// tidak hilang gara-gara penulisan lain ke baris yang sama.
//
// Kasus nyata (lp3, 2026-09-22): halaman #pool/0x7759…a1c7 menampilkan "?/?" dan
// harga 2.79e+15, padahal halaman Posisi tahu persis pasangan tokennya. Penyebabnya
// Chain.poolAgeMinutes menulis barisnya dengan INSERT OR REPLACE untuk kolom
// first_block/first_ts saja — SQLite mengganti seluruh baris, jadi token0/token1/fee/
// tick_spacing/hooks yang sudah terisi ikut jadi NULL. /api/pool membaca `pools`
// lebih dulu, dapat baris kosong itu, dan jatuh ke simbol '?' + desimal 18.
//
// Jalankan: node test/pool-meta.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { ADDR, TOPIC } = require('../src/chain');

const POOL = '0x' + '77'.repeat(32);
const MEME = '0xbb77b9086caec884e4ad89f7f7b47b45e7233cdc';
const HEAD = 1_000_000;
const BORN = HEAD - 1_000;
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexb = (b) => '0x' + b.toString(16);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Initialize: topics = [sig, poolId, currency0, currency1], data = fee, tickSpacing,
// hooks, sqrtPriceX96, tick.
const initLog = (block) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x0', transactionHash: '0x' + w(block),
  topics: [TOPIC.initializeV4, POOL, pad32(ADDR.usdg), pad32(MEME)],
  data: '0x' + w(80000) + w(800) + w(0) + w('0x1000000000000000000000000') + w(0),
});

function dunia({ logs = [] } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    blockNumber: async () => HEAD,
    call: async () => ({ number: hexb(HEAD), timestamp: hexb(Math.floor(Date.now() / 1000)) }),
    getLogs: async (f) => logs.filter((l) => {
      const b = parseInt(l.blockNumber, 16);
      if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
      return (f.topics || []).every((s, i) => s == null || s === l.topics[i]);
    }),
  };
  return { store, chain: new Chain(rpc, store, () => {}) };
}

const meta = (store) => store.get('SELECT token0,token1,fee,tick_spacing,hooks,init_sqrt FROM pools WHERE chain=? AND pool_ref=?', 'robinhood', POOL);
const punyaPasangan = (r, label) => {
  assert.ok(r, `${label}: baris pools hilang`);
  assert.equal(r.token0, ADDR.usdg, `${label}: token0 hilang`);
  assert.equal(r.token1, MEME, `${label}: token1 hilang`);
  assert.equal(r.fee, 80000, `${label}: fee hilang`);
  assert.equal(r.tick_spacing, 800, `${label}: tickSpacing hilang`);
};

(async () => {
  console.log('metadata pool tidak boleh terhapus penulisan lain');

  await t('umur pool dicatat -> pasangan token tetap ada', async () => {
    const { store, chain } = dunia({ logs: [initLog(BORN)] });
    const pk = await chain.poolKeyOfId(POOL);
    assert.equal(pk.currency1, MEME, 'poolKey tidak terbaca dari Initialize');
    punyaPasangan(meta(store), 'sebelum umur dibaca');

    const umur = await chain.poolAgeMinutes(POOL);
    assert.ok(umur >= 0 && Number.isFinite(umur), `umur pool tidak masuk akal: ${umur}`);
    punyaPasangan(meta(store), 'setelah umur dibaca');
    assert.ok(meta(store).init_sqrt, 'harga lahir ikut terhapus');
  });

  await t('pool lebih tua dari jendela pindai -> pasangan token tetap ada', async () => {
    // Initialize-nya ada (poolKey terbaca) tapi di luar jendela umur, jadi
    // poolAgeMinutes menempuh cabang "sangat tua" yang juga menulis barisnya.
    const { store, chain } = dunia({ logs: [initLog(BORN)] });
    await chain.poolKeyOfId(POOL);
    punyaPasangan(meta(store), 'sebelum umur dibaca');

    const umur = await chain.poolAgeMinutes(POOL, 100);
    assert.ok(umur > 0, `umur pool tua harus positif: ${umur}`);
    punyaPasangan(meta(store), 'setelah umur dibaca');
  });

  await t('umur yang sudah tercatat tidak ditulis ulang', async () => {
    const { store, chain } = dunia({ logs: [initLog(BORN)] });
    await chain.poolKeyOfId(POOL);
    await chain.poolAgeMinutes(POOL);
    const ts = store.get('SELECT first_ts FROM pools WHERE chain=? AND pool_ref=?', 'robinhood', POOL).first_ts;
    assert.ok(ts, 'first_ts tidak tercatat');
    await chain.poolAgeMinutes(POOL);
    punyaPasangan(meta(store), 'setelah umur dibaca dua kali');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
