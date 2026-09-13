'use strict';
// Uji: aturan yang salah ditolak di API dan dirapikan saat dipakai.
// Kasus: slippage 150.5 dari kolom angka → BigInt(150.5) melempar di setiap entry;
// slippage ≥ 10000 → minOut negatif; LIVE bisa dinyalakan lewat /api/mode tanpa konfirmasi.
// Jalankan: node test/aturan-validasi.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { validateRules, rulesFor, DEFAULTS } = require('../src/policy');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function serve({ wallet = '0xe9c209fd02a1562761c99700fc3d126e64b981ee' } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-rules-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0 }, watcher: { unsupported: new Map() },
    exec: { address: () => wallet, balances: async () => new Map() }, leftovers: () => [],
    dryRun: () => cfg.mode.dry_run !== false, paused: () => store.getState('paused', '0') === '1',
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    cfg, store, post: async (p, body) => (await fetch(`http://127.0.0.1:${server.address().port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(),
    close: () => new Promise((r) => server.close(r)),
  })));
}

(async () => {
  console.log('validasi aturan');

  await t('slippage desimal / di atas batas / bukan angka ditolak dengan pesan jelas', async () => {
    assert.match(validateRules({ swap: { max_slippage_bps: 150.5 } }).error, /max_slippage_bps harus bilangan bulat/);
    assert.match(validateRules({ swap: { max_slippage_bps: 10000 } }).error, /max_slippage_bps harus di antara 0 dan 5000/);
    assert.match(validateRules({ exit: { sell_max_loss_bps: 'banyak' } }).error, /harus angka/);
    assert.match(validateRules({ sizing: { mode: 'semua' } }).error, /sizing.mode/);
    assert.match(validateRules({ filters: { venues: ['v2'] } }).error, /venues/);
    assert.match(validateRules({ exit: { follow_target: 'mungkin' } }).error, /ya\/tidak/);
  });

  await t('angka dalam teks diterima dan dirapikan; stop loss negatif = besaran; kunci asing dibiarkan', async () => {
    const r = validateRules({ swap: { max_slippage_bps: '200' }, exit: { stop_loss_pct: -10 }, catatan: 'x' });
    assert.strictEqual(r.rules.swap.max_slippage_bps, 200);
    assert.strictEqual(r.rules.exit.stop_loss_pct, 10);
    assert.strictEqual(r.rules.catatan, 'x');
    assert.deepStrictEqual(validateRules(null), { rules: null });
  });

  await t('aturan rusak yang sudah tersimpan dirapikan saat dipakai — tidak menjatuhkan BigInt', async () => {
    const r = rulesFor({ swap: { max_slippage_bps: 150.5, max_price_impact_bps: 99999 }, exit: { sell_max_loss_bps: 'x', stop_loss_pct: -5 } },
      JSON.stringify({ sizing: { max_quote_per_position_usd: 'NaN' } }));
    assert.strictEqual(r.swap.max_slippage_bps, 151);
    assert.doesNotThrow(() => BigInt(r.swap.max_slippage_bps));
    assert.strictEqual(r.swap.max_price_impact_bps, 10000);
    assert.strictEqual(r.exit.sell_max_loss_bps, DEFAULTS.exit.sell_max_loss_bps);
    assert.strictEqual(r.exit.stop_loss_pct, 5);
    assert.strictEqual(r.sizing.max_quote_per_position_usd, DEFAULTS.sizing.max_quote_per_position_usd);
    assert.deepStrictEqual(rulesFor({}), rulesFor({}), 'bawaan lolos apa adanya');
    assert.strictEqual(validateRules(rulesFor({})).error, undefined, 'bawaan sendiri lolos validasi');
  });

  await t('API aturan global & per target menolak nilai salah dan tidak menyimpannya', async () => {
    const s = await serve();
    try {
      const r1 = await s.post('/api/rules', { rules: { swap: { max_slippage_bps: 150.5 } } });
      assert.match(r1.error, /bilangan bulat/);
      assert.deepStrictEqual(s.cfg.rules, {});
      const ok = await s.post('/api/rules', { rules: { swap: { max_slippage_bps: '120' } } });
      assert.strictEqual(ok.ok, true);
      assert.strictEqual(s.cfg.rules.swap.max_slippage_bps, 120);
      s.store.run("INSERT INTO targets(address,enabled,added_ts) VALUES('0x3c926ee5e990b3999f1f656a9b18ff678ce82976',1,0)");
      const r2 = await s.post('/api/targets/rules', { address: '0x3c926ee5e990b3999f1f656a9b18ff678ce82976', rules: { swap: { max_slippage_bps: -1 } } });
      assert.match(r2.error, /di antara/);
      assert.strictEqual(s.store.get('SELECT rules FROM targets').rules, null);
      const r3 = await s.post('/api/targets', { address: '0x' + '11'.repeat(20), rules: { exit: { sell_max_loss_bps: 1.5 } } });
      assert.match(r3.error, /bilangan bulat/);
    } finally { await s.close(); }
  });

  await t('/api/mode: LIVE butuh wallet dan konfirmasi "LIVE"; kembali ke simulasi & jeda tetap bebas', async () => {
    const s = await serve();
    try {
      assert.match((await s.post('/api/mode', { dry_run: false })).error, /Ketik LIVE/);
      assert.strictEqual(s.cfg.mode.dry_run, true);
      assert.strictEqual((await s.post('/api/mode', { dry_run: false, confirm: 'LIVE' })).mode.dry_run, false);
      assert.strictEqual((await s.post('/api/mode', { dry_run: true })).mode.dry_run, true);
      assert.strictEqual((await s.post('/api/mode', { paused: true })).mode.paused, true);
    } finally { await s.close(); }
    const n = await serve({ wallet: null });
    try { assert.match((await n.post('/api/mode', { dry_run: false, confirm: 'LIVE' })).error, /wallet/); }
    finally { await n.close(); }
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
