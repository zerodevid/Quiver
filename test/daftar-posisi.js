'use strict';
// Uji GET /api/positions — daftar posisi terbuka untuk halaman Posisi dan panel
// "Posisi aktif" di Ringkasan.
//
// Daftarnya HARUS dari basis data, bukan dari cache sinkron (`engine.positions.live`)
// yang cuma disegarkan tiap 30 detik. Dulu dari cache, sehingga: sesudah restart
// tabelnya kosong sampai sinkron pertama selesai, posisi yang baru dimint baru muncul
// setengah menit kemudian, dan posisi yang baru ditutup masih tampil.
//
// Jalankan: node test/daftar-posisi.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia({ live = [], lastSync = T0, resync } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-daftar-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // `positions` di sini meniru Positions: `live`/`lastSync` adalah hasil sinkron
  // terakhir, dan `resync` yang membaca chain lagi lalu memperbaruinya.
  const pos = { live, lastSync, resync: null };
  pos.resync = resync ? () => resync(pos) : async () => { pos.lastSync = Date.now(); };
  const engine = {
    cfg, store, ethUsd: 2500, positions: pos, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api, pos };
}

// Satu posisi terbuka di DB; belum tentu sudah ikut sinkron.
function buka(store, id, { cost = 200, opened = T0 } = {}) {
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,
      status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open)
    VALUES(?,'v4',?,?,?,?,3000,-60,60,'1000','open',?,'0','0',?,'USDG',?)`,
  id, String(2_000_000 + id), POOL, ADDR.usdg, MEME, opened, cost, '0xmint' + id);
}

function tutup(store, id, { out = 250 } = {}) {
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,opened_ts,closed_ts,
      cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close)
    VALUES(?,'v4',?,?,?,?,3000,'closed',?,?,'0','0',200,?,'USDG',?,?)`,
  id, String(2_000_000 + id), POOL, ADDR.usdg, MEME, T0, T0 + 60_000, out, '0xmint' + id, '0xburn' + id);
}

// Bentuk baris hasil sinkron, seperlunya untuk uji ini.
const hasilSinkron = (id, extra = {}) => ({
  id, venue: 'v4', token_id: String(2_000_000 + id), pool_ref: POOL, token0: ADDR.usdg, token1: MEME,
  symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, tick_lower: -60, tick_upper: 60, curTick: 0,
  inRange: true, valueUsd: 210, feeUsd: 4, costUsd: 200, pnlUsd: 14, pnlPct: 7, empty: false, ...extra,
});

(async () => {
  console.log('daftar posisi');

  await t('posisi baru dimint langsung tampil, ditandai belum tersinkron', async () => {
    const { store, api } = dunia();            // cache sinkron kosong
    buka(store, 7, { cost: 150 });
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 1, 'posisi di DB harus ikut terdaftar');
    const p = r.positions[0];
    assert.equal(p.id, 7);
    assert.equal(p.syncing, true, 'harus bertanda syncing supaya UI tidak menyajikan angka taksiran sebagai kabar pasti');
    assert.equal(p.symbol0, 'USDG');
    assert.equal(p.symbol1, 'MEME');
    assert.equal(p.costUsd, 150);
    assert.equal(p.valueUsd, 150, 'sebelum sinkron, nilai = modal');
    assert.equal(p.feeUsd, 0);
    assert.equal(p.ilUsd, null);
  });

  await t('sesudah restart, daftar tidak kosong walau sinkron pertama belum jalan', async () => {
    const { store, api } = dunia({ lastSync: 0 });
    buka(store, 1); buka(store, 2);
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 2);
    assert.equal(r.syncedAt, 0, 'syncedAt 0 = sinkron pertama belum selesai; UI memakainya untuk indikator');
    assert.ok(r.positions.every((p) => p.syncing));
  });

  await t('posisi yang sudah tersinkron memakai angka dari chain, tanpa tanda syncing', async () => {
    const { store, api } = dunia({ live: [hasilSinkron(3)] });
    buka(store, 3);
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 1);
    const p = r.positions[0];
    assert.ok(!p.syncing);
    assert.equal(p.valueUsd, 210);
    assert.equal(p.feeUsd, 4);
    assert.equal(p.inRange, true);
    assert.equal(r.syncedAt, T0);
  });

  await t('posisi yang baru ditutup langsung hilang, tidak menunggu sinkron berikutnya', async () => {
    // Cache sinkron masih memuat #4 (basi): DB sudah bilang tertutup.
    const { store, api } = dunia({ live: [hasilSinkron(4)] });
    tutup(store, 4, { out: 250 });
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 0, 'posisi tertutup tidak boleh ikut daftar terbuka');
    assert.equal(r.closed.length, 1);
    assert.equal(r.closed[0].symbol0, 'USDG', 'posisi tertutup tetap dihias simbolnya');
    assert.equal(r.closed[0].symbol1, 'MEME');
  });

  await t('campur: satu tersinkron, satu baru, satu baru ditutup', async () => {
    const { store, api } = dunia({ live: [hasilSinkron(5), hasilSinkron(6)] });
    buka(store, 5); buka(store, 6);
    // #6 ditutup sesudah sinkron terakhir: DB sudah 'closed', cache masih memuatnya.
    store.run("UPDATE positions SET status='closed', closed_ts=?, out_quote=250 WHERE id=6", T0 + 120_000);
    buka(store, 8, { opened: T0 + 60_000 });           // #8 dimint sesudah sinkron terakhir
    const r = await api('GET', '/api/positions', {}, {});
    assert.deepEqual(r.positions.map((p) => p.id), [5, 8]);
    assert.equal(r.positions.find((p) => p.id === 5).syncing, undefined);
    assert.equal(r.positions.find((p) => p.id === 8).syncing, true);
  });

  await t('detail posisi yang belum tersinkron juga ditandai', async () => {
    const { store, api } = dunia();
    buka(store, 9);
    const r = await api('GET', '/api/position', {}, { id: '9' });
    assert.equal(r.position.id, 9);
    assert.equal(r.position.syncing, true);
  });

  await t('detail posisi tertutup tidak ditandai menyinkron', async () => {
    const { store, api } = dunia();
    tutup(store, 11);
    const r = await api('GET', '/api/position', {}, { id: '11' });
    assert.equal(r.position.syncing, false);
  });

  // ---- tombol "Perbarui" di kepala tabel --------------------------------------
  // Tanpa ini, tombolnya cuma mengambil ulang hasil sinkron yang SAMA — yang umurnya
  // bisa 30 detik — dan mengembalikan angka yang persis sama. Tombol yang berkedip
  // lalu tidak mengubah apa pun lebih buruk daripada tidak ada tombol: pemakainya
  // menyangka angka di layar baru saja dipastikan, padahal tidak.
  await t('Perbarui membaca chain lagi, bukan mengulang hasil sinkron lama', async () => {
    let dibaca = 0;
    const { api, pos } = dunia({
      lastSync: T0,
      resync: async (p) => { dibaca++; p.live = [hasilSinkron(12, { valueUsd: 999 })]; p.lastSync = T0 + 60_000; },
    });
    const r = await api('POST', '/api/positions/sync', {}, {});
    assert.equal(dibaca, 1, 'harus benar-benar menyuruh sinkron, bukan cuma membalas');
    assert.equal(r.ok, true);
    assert.equal(r.syncedAt, T0 + 60_000, 'waktu sinkron yang dibalas harus yang baru');
    assert.equal(pos.live[0].valueUsd, 999);
  });

  await t('sinkron gagal: galatnya dikabarkan, tabel tetap punya angka lama', async () => {
    const { store, api } = dunia({
      live: [hasilSinkron(13)], lastSync: T0,
      resync: async () => { throw new Error('RPC 429'); },
    });
    buka(store, 13);
    const r = await api('POST', '/api/positions/sync', {}, {});
    assert.equal(r.error, 'RPC 429');
    assert.equal(r.syncedAt, T0, 'waktu sinkron tidak boleh maju kalau chain tidak terbaca');
    const daftar = await api('GET', '/api/positions', {}, {});
    assert.equal(daftar.positions[0].valueUsd, 210, 'angka terakhir yang diketahui tetap disajikan');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
