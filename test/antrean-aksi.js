'use strict';
// Uji: pemindaian & sinyal keluar tidak terhalang entry yang lambat.
// Dulu tick menunggu setiap aksi selesai — satu entry (zap, approval, receipt 90 dtk)
// menahan pemindaian beberapa menit, dan tarikan target di blok berikutnya terlambat.
// Jalankan: node test/antrean-aksi.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const act = (kind, tokenId, block) => ({ ts: Date.now(), block, txHash: '0x' + block.toString(16).padStart(64, '0'), logIndex: 1, target: TARGET, venue: 'v4', kind, tokenId, liquidity: kind === 'increase' ? '10' : '-10' });

function engineWith() {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const eng = new Engine({ rpc: { allCooling: () => false, call: async () => null, ethCallMany: async (c) => c.map(() => null) }, store, chain: {}, cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xme';
  eng.notify = () => {};
  eng.cursor = 0; eng.span = 100;
  let head = 100;
  eng.rpc.safeHead = async () => ({ min: head, max: head, spread: 0 });
  const seen = [];
  const gates = [];
  eng.handleEntry = (a) => new Promise((res) => { seen.push(`entry:${a.tokenId}`); gates.push(() => { eng.decide(a.id, 'copy', 'uji'); res(); }); });
  eng.handleExit = async (a) => { seen.push(`exit:${a.tokenId}`); eng.decide(a.id, 'copy', 'uji keluar'); };
  let batch = [];
  eng.watcher.scan = async () => { const b = batch; batch = []; return b; };
  return { eng, store, seen, gates, next: (acts) => { batch = acts; head += 100; } };
}

(async () => {
  console.log('Antrean aksi:\n');

  await t('entry menggantung: tick berikutnya tetap memindai, dan sinyal keluar diproses tanpa menunggu entry', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 50)]);
    await h.eng.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(h.seen, ['entry:1']);
    assert.strictEqual(h.eng.busy, false, 'pemindaian tidak lagi sibuk walau entry masih jalan');
    h.next([act('decrease', '7', 150)]);
    await h.eng.tick();
    await h.eng.pumps.exit;
    assert.deepStrictEqual(h.seen, ['entry:1', 'exit:7']);
    assert.ok(h.eng.cursor >= 200, 'kursor maju dua kali');
    assert.strictEqual(h.eng.idle(), false, 'entry yang menggantung menahan drain');
    h.gates.shift()();
    await h.eng.settled();
    assert.strictEqual(h.eng.idle(), true);
  });

  await t('dalam satu rentang: keluar ditangani lebih dulu, entry berurutan satu per satu', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 10), act('increase', '2', 11), act('decrease', '3', 12)]);
    await h.eng.tick();
    await h.eng.pumps.exit;
    assert.deepStrictEqual([...h.seen].sort(), ['entry:1', 'exit:3'], 'keluar tidak menunggu entry:1; entry:2 belum dimulai');
    h.gates.shift()();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(h.seen.slice(2), ['entry:2']);
    h.gates.shift()();
    await h.eng.settled();
  });

  await t('berhenti (deploy): antrean tidak dimulai, aksi tersimpan tanpa keputusan untuk backfill', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 10), act('increase', '2', 11)]);
    await h.eng.tick();
    h.eng.stopping = true;
    h.gates.shift()();
    await h.eng.settled();
    assert.deepStrictEqual(h.seen, ['entry:1']);
    assert.strictEqual(h.store.get('SELECT COUNT(*) n FROM actions a LEFT JOIN decisions d ON d.action_id=a.id WHERE d.id IS NULL').n, 1);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
