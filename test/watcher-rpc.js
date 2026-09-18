'use strict';
// Uji: pemindai aksi target tidak boleh menyamakan "RPC tidak terbaca" dengan jawaban
// sah. Kalau sampai begitu, aksi target hilang (kursor tetap maju) atau — lebih gawat —
// titipan NFT ke router terbaca sebagai "target melepas posisi".
// Jalankan: node test/watcher-rpc.js
const assert = require('node:assert');
const { Watcher } = require('../src/watcher');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const ROUTER = '0x' + 'ab'.repeat(20);
const { ADDR } = require('../src/chain');
const w = (rpc) => new Watcher({ rpc, store: null, chain: null, log: () => {}, cfg: {} });

(async () => {
  console.log('watcher-rpc:');

  await t('eth_getCode kena kuota: melempar dan TIDAK menyimpan "bukan kontrak"', async () => {
    let answer = { error: { code: 429, message: 'Too Many Requests' } };
    const x = w({ batch: async (c) => c.map(() => answer) });
    await assert.rejects(x.contractCheck([ROUTER]), /tidak terbaca/);
    assert.strictEqual(x.isContract.has(ROUTER), false, 'tidak di-cache');
    answer = { result: '0x6080' };
    await x.contractCheck([ROUTER]);
    assert.strictEqual(x.isContract.get(ROUTER), true, 'dibaca ulang dengan benar');
  });

  await t('eth_getCode tanpa balasan (null): melempar', async () => {
    const x = w({ batch: async (c) => c.map(() => null) });
    await assert.rejects(x.contractCheck([ROUTER]));
  });

  await t('EOA (0x) tetap tercatat bukan kontrak', async () => {
    const x = w({ batch: async (c) => c.map(() => ({ result: '0x' })) });
    await x.contractCheck([ROUTER]);
    assert.strictEqual(x.isContract.get(ROUTER), false);
  });

  await t('ownerOf dibaca strict: galat RPC dilempar, bukan pemilik kosong', async () => {
    let opts = null;
    const x = w({ ethCallMany: async (c, b, o) => { opts = o; throw new Error('eth_call tidak terbaca dari RPC: rate limit'); } });
    await assert.rejects(x.resolveOwners('v4', ['123']), /tidak terbaca/);
    assert.ok(opts?.strict);
    assert.strictEqual(x.knownOwner('v4', '123'), null);
  });

  // Peringatan "router LP bukan NFT": hanya untuk tx target yang benar-benar ke router LP.
  const TARGET = '0x' + 'e7'.repeat(20);
  const HOOK_VAULT = '0x' + '6f'.repeat(20);
  const warnHarness = (to) => {
    const logs = [];
    const x = w({ batch: async (c) => c.map((q) => ({ result: { hash: q.params[0], from: TARGET, to } })) });
    x.store = { log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }) };
    x.unsupportedSender.set('0xtx1', [HOOK_VAULT]);
    return { x, logs };
  };

  await t('swap lewat agregator yang menyentuh pool berhook: TIDAK diperingatkan', async () => {
    const { x, logs } = warnHarness(ADDR.dexRouter);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 0);
  });

  await t('tx ke router LP asing: diperingatkan sekali per (target, router), pesan memuat tx + sender', async () => {
    const { x, logs } = warnHarness(ROUTER);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 1, 'sekali saja');
    assert.match(logs[0].msg, /0xtx1/);
    assert.match(logs[0].msg, new RegExp(HOOK_VAULT));
    assert.deepStrictEqual(logs[0].meta, { target: TARGET, tx: '0xtx1', to: ROUTER, senders: [HOOK_VAULT] });
    // router lain untuk target yang sama tetap berbunyi
    const other = '0x' + 'cd'.repeat(20);
    x.rpc = { batch: async (c) => c.map((q) => ({ result: { hash: q.params[0], from: TARGET, to: other } })) };
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 2);
  });

  await t('tx bukan dari target: diam', async () => {
    const { x, logs } = warnHarness(ROUTER);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set(['0x' + '11'.repeat(20)]));
    assert.strictEqual(logs.length, 0);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
