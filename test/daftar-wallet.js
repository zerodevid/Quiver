'use strict';
// Uji GET /api/wallets — daftar "pernah dipindai" di halaman riset Wallet.
//
// Wallet yang juga tersimpan sebagai target harus tampil dengan nama targetnya,
// bukan alamat telanjang, dan ditandai isTarget supaya UI bisa memberi lencana.
// Label yang diketik langsung di wallet tetap menang atas label target.
//
// Jalankan: node test/daftar-wallet.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const A = '0x' + '11'.repeat(20);   // target berlabel, wallet tanpa label
const B = '0x' + '22'.repeat(20);   // target tanpa label, wallet tanpa label
const C = '0x' + '33'.repeat(20);   // bukan target
const D = '0x' + '44'.repeat(20);   // target berlabel, wallet punya label sendiri
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-daftar-wallet-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return { store, api: server.api };
}

(async () => {
  console.log('daftar wallet pernah dipindai');
  const { store, api } = dunia();
  const now = Date.now();
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', A, 'Paus A', now);
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', B, null, now);
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', D, 'Nama target D', now);
  const wallet = (a, label, i) => store.run(
    'INSERT INTO wallets(address,label,last_scan_ts,positions_n,stats) VALUES(?,?,?,?,?)',
    a, label, now - i * 1000, 5, JSON.stringify({ totalProfitUsd: 10 * i }));
  wallet(A, null, 1); wallet(B, null, 2); wallet(C, null, 3); wallet(D, 'Label wallet D', 4);

  const r = await api('GET', '/api/wallets', {}, {});
  const by = new Map(r.wallets.map((w) => [w.address, w]));

  await t('wallet tanpa label meminjam nama target', () => {
    assert.equal(by.get(A).label, 'Paus A');
    assert.equal(by.get(A).isTarget, true);
  });
  await t('target tanpa label: tetap isTarget, label null', () => {
    assert.equal(by.get(B).label, null);
    assert.equal(by.get(B).isTarget, true);
  });
  await t('bukan target: label null, isTarget false', () => {
    assert.equal(by.get(C).label, null);
    assert.equal(by.get(C).isTarget, false);
  });
  await t('label wallet sendiri menang atas label target', () => {
    assert.equal(by.get(D).label, 'Label wallet D');
    assert.equal(by.get(D).isTarget, true);
  });
  await t('stats tetap terurai dari JSON', () => {
    assert.equal(by.get(C).stats.totalProfitUsd, 30);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
