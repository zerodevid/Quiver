'use strict';
// Uji rekap hasil per target di GET /api/targets: berapa yang KITA dapat dari posisi
// yang disalin dari tiap wallet — terealisasi (tertutup) + berjalan (terbuka, live).
//
// Jalankan: node test/rekap.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const C = '0x' + 'cc'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

(async () => {
  console.log('rekap hasil per target');
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-rekap-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // posisi #3 terbuka dan tersinkron: nilai 110 + fee 4 dari modal 100 -> +14
  const engine = {
    cfg, store, ethUsd: 2000, positions: { live: [{ id: 3, valueUsd: 110, feeUsd: 4, pnlUsd: 14 }, { id: 4, empty: true, pnlUsd: -50 }], lastSync: Date.now() },
    watcher: { unsupported: new Map() }, exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const { api } = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });

  for (const [addr, label] of [[A, 'Alpha'], [B, 'Beta'], [C, null]]) {
    store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', addr, label, Date.now());
  }
  const pos = (id, target, status, cost, out, q = 'USDG') => store.run(
    `INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,target,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol)
     VALUES(?,'v4',?,?,?,?,?,?,1,?,?,?,?)`,
    id, String(id), '0x' + 'ab'.repeat(32), ADDR.usdg, MEME, status, target, status === 'closed' ? 2 : null, cost, out, q);
  pos(1, A, 'closed', 200, 230);            // +30
  pos(2, A, 'closed', 0.1, 0.09, 'ETH');    // −0,01 ETH × 2000 = −20
  pos(3, A, 'open', 100, null);             // live +14
  pos(4, A, 'open', 60, null);              // kosong: tidak dihitung
  pos(5, B, 'closed', 50, 40);              // −10
  pos(6, null, 'closed', 10, 99);           // manual: bukan milik target mana pun

  const { targets } = await api('GET', '/api/targets');
  const by = Object.fromEntries(targets.map((x) => [x.address, x.ours]));

  await t('Alpha: terealisasi +30 −20 (ETH dikonversi), berjalan +14, posisi kosong diabaikan', () => {
    near(by[A].realized, 10); near(by[A].upnl, 14);
    assert.equal(by[A].closed, 2); assert.equal(by[A].wins, 1); assert.equal(by[A].open, 1);
    near(by[A].value, 114);
  });
  await t('Beta: rugi tertutup −10, tanpa posisi terbuka', () => {
    near(by[B].realized, -10); near(by[B].upnl, 0); assert.equal(by[B].open, 0); assert.equal(by[B].wins, 0);
  });
  await t('target tanpa posisi -> ours null; posisi manual tidak masuk target mana pun', () => {
    assert.equal(by[C], null);
    near(targets.reduce((a, x) => a + (x.ours ? x.ours.realized : 0), 0), 0);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
