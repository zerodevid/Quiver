'use strict';
// Uji: pemindaian yang MENGGANTUNG sembuh sendiri.
// Kejadian nyata (lpcopy3, 2026-09-25): satu await di dalam tick tidak pernah selesai,
// `busy` tidak pernah dilepas, dan 1,5 detik sekali tick masuk lalu langsung keluar.
// 15 jam tanpa satu blok baru dipindai — tanpa galat, dan dasbor tetap menunjukkan
// "lag 0" karena `head` pun hanya diperbarui DI DALAM tick. Dua posisi target terlewat.
// Jalankan: node test/pindai-macet.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const tidur = (ms) => new Promise((r) => setTimeout(r, ms));

function engineWith({ stuckSeconds = 0.05 } = {}) {
  const store = new Store(':memory:');
  const eng = new Engine({
    rpc: { allCooling: () => false, call: async () => null, ethCallMany: async (c) => c.map(() => null) },
    store, chain: {}, log: () => {},
    cfg: { mode: { dry_run: false }, gas: {}, rules: {}, loop: { tick_stuck_seconds: stuckSeconds } },
  });
  eng.exec.address = () => '0xme';
  const kabar = [];
  eng.onNotify = (msg, detail) => kabar.push({ msg, detail });
  eng.kabar = kabar;
  eng.cursor = 0; eng.span = 1000;
  let head = 100;
  eng.rpc.safeHead = async () => ({ min: head, max: head, spread: 0 });
  const calls = [];
  let hang = false, lepas = null;
  eng.watcher.scan = (from, to) => {
    calls.push([from, to]);
    if (!hang) return Promise.resolve([]);
    hang = false;                      // cuma satu tick yang digantung
    return new Promise((res) => { lepas = () => res([]); });
  };
  return {
    eng, store, calls, kabar: eng.kabar,
    gantung: () => { hang = true; },
    lepas: () => lepas && lepas(),
    setHead: (n) => { head = n; },
  };
}

(async () => {
  console.log('Pemindaian macet:\n');

  await t('tick yang menggantung dilepas paksa setelah batas, pemindaian jalan lagi', async () => {
    const h = engineWith();
    h.gantung();
    h.eng.tick();                       // sengaja tidak di-await: tick ini tidak akan selesai
    await tidur(5);
    assert.strictEqual(h.eng.busy, true, 'tick pertama masih menggantung');

    await h.eng.tick();                 // masih di dalam batas kesabaran: jangan diapa-apakan
    assert.strictEqual(h.eng.busy, true, 'tick yang cuma lambat tidak boleh dipotong');
    assert.strictEqual(h.eng.lastError, null);

    await tidur(60);
    await h.eng.tick();                 // sudah lewat batas: lepas paksa
    assert.strictEqual(h.eng.busy, false, 'flag sibuk dilepas');
    assert.match(String(h.eng.lastError), /macet/);
    assert.match(String(h.eng.lastError), /pindai blok 1-100/, 'pesannya menyebut tahap yang menggantung');

    h.setHead(500);
    await h.eng.tick();                 // siklus baru benar-benar memindai
    assert.strictEqual(h.eng.cursor, 500);
    assert.deepStrictEqual(h.calls, [[1, 100], [1, 500]]);
  });

  await t('tick basi yang akhirnya selesai tidak memundurkan kursor', async () => {
    const h = engineWith();
    h.gantung();
    h.eng.tick();
    await tidur(60);
    await h.eng.tick();                 // lepas paksa
    h.setHead(500);
    await h.eng.tick();                 // kursor maju ke 500
    assert.strictEqual(h.eng.cursor, 500);

    h.lepas();                          // tick lama (rentang 1-100) baru selesai sekarang
    await tidur(10);
    assert.strictEqual(h.eng.cursor, 500, 'hasil tick basi dibuang, kursor tidak mundur');
    assert.strictEqual(h.eng.busy, false, 'tick basi tidak menyentuh flag milik tick baru');
    assert.strictEqual(Number(h.store.getState('cursor:robinhood', 0)), 500);
  });

  await t('umur pemindaian terakhir hanya dihitung dari tick yang BERHASIL', async () => {
    const h = engineWith();
    await h.eng.tick();
    const pertama = h.eng.lastScanAt;
    assert.ok(pertama > 0);
    h.gantung();
    h.eng.tick();
    await tidur(60);
    await h.eng.tick();
    assert.strictEqual(h.eng.lastScanAt, pertama, 'tick yang macet tidak boleh menyegarkan penanda ini');
    assert.ok(h.eng.tickStuckMs() === 0, 'tidak ada tick yang menggantung lagi setelah dilepas');
  });

  await t('macet dikabarkan (ntfy + Telegram), lalu ditutup kabar pulih', async () => {
    const h = engineWith();
    h.gantung();
    h.eng.tick();
    await tidur(60);
    await h.eng.tick();                 // lepas paksa
    assert.strictEqual(h.kabar.length, 1, 'satu kabar macet');
    assert.match(h.kabar[0].msg, /macet.*tahap "pindai blok 1-100"/);
    assert.strictEqual(h.kabar[0].detail.cursor, 0);
    // Baris lognya ikut naik ke level 'warn' — di dasbor ini masalah, bukan kabar biasa.
    assert.strictEqual(h.store.all('SELECT level,msg FROM logs ORDER BY id DESC LIMIT 1')[0].level, 'warn');

    h.setHead(500);
    await h.eng.tick();
    assert.strictEqual(h.kabar.length, 2, 'kabar pulih menyusul');
    assert.match(h.kabar[1].msg, /pulih/);
  });

  await t('macet beruntun tidak membanjiri chat, tapi tetap masuk log', async () => {
    const h = engineWith();
    for (let i = 0; i < 3; i++) {
      h.gantung();
      h.eng.tick();
      await tidur(60);
      await h.eng.tick();               // lepas paksa, tanpa pemindaian berhasil di antaranya
    }
    assert.strictEqual(h.kabar.length, 1, 'cuma yang pertama dikabarkan (jeda 15 menit)');
    const baris = h.store.all("SELECT msg FROM logs WHERE msg LIKE 'pemindaian macet%'");
    assert.strictEqual(baris.length, 3, 'ketiganya tetap tercatat');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
