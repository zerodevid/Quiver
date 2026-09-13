'use strict';
// Uji: jatah panggilan bersamaan (max_inflight) tidak bocor saat endpoint gagal.
// Dulu slot dilepas dua kali ketika semua endpoint istirahat (catch + finally) —
// `inflight` jadi negatif dan pembatasnya mati tepat saat endpoint sedang marah.
// Jalankan: node test/rpc-slot.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

(async () => {
  await t('satu endpoint gagal transport berulang: inflight kembali 0, bukan negatif', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { max_inflight: 3, dns_over_https: false });
    p.post = async () => { throw new Error('connect ECONNREFUSED'); };
    for (let i = 0; i < 5; i++) {
      await assert.rejects(p.batch([{ method: 'eth_blockNumber' }]), /tumbang/);
      p.eps[0].cooldownUntil = 0;
    }
    assert.strictEqual(p.inflight, 0);
    assert.strictEqual(p.eps[0].inflight, 0);
  });

  await t('dua endpoint: yang pertama gagal, yang kedua menjawab — slot tetap seimbang', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }, { url: 'https://b.example' }], () => {}, { max_inflight: 2, dns_over_https: false });
    p.post = async (url, body) => {
      if (url.includes('a.example')) throw new Error('HTTP 429: too many requests');
      const j = JSON.parse(body);
      return { jsonrpc: '2.0', id: j.id, result: '0x10' };
    };
    const [r] = await p.batch([{ method: 'eth_blockNumber' }]);
    assert.strictEqual(r.result, '0x10');
    assert.strictEqual(p.inflight, 0);
    assert.deepStrictEqual(p.eps.map((e) => e.inflight), [0, 0]);
  });

  await t('pembatas masih bekerja setelah kegagalan: panggilan ke-(max+1) menunggu', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { max_inflight: 2, dns_over_https: false });
    p.post = async () => { throw new Error('connect ECONNREFUSED'); };
    for (let i = 0; i < 3; i++) { await p.batch([{ method: 'eth_chainId' }]).catch(() => {}); p.eps[0].cooldownUntil = 0; }
    let open = 0, peak = 0;
    const release = [];
    p.post = (url, body) => new Promise((res) => {
      open++; peak = Math.max(peak, open);
      release.push(() => { open--; res({ jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x1' }); });
    });
    const calls = [1, 2, 3, 4].map(() => p.batch([{ method: 'eth_chainId' }]));
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(peak, 2, `maksimal 2 bersamaan, terlihat ${peak}`);
    while (release.length || open) { const f = release.shift(); if (f) f(); await new Promise((r) => setTimeout(r, 5)); }
    await Promise.all(calls);
    assert.strictEqual(p.inflight, 0);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
