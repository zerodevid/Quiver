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

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
