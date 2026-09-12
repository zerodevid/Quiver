'use strict';
// Uji failover getLogs: galat JSON-RPC (balasan 200 berisi error) dari satu endpoint
// tidak boleh menggagalkan pemindaian selama endpoint lain masih sanggup — dan
// endpoint yang menolak diistirahatkan KHUSUS getLogs, eth_call-nya tetap dipakai.
// Jalankan: node test/rpc-getlogs-alih.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// jawaban per host: fungsi (method) -> {result} | {error} | lempar (transport)
function pool(answers, logs = []) {
  const p = new RpcPool([
    { url: 'https://a.example', no_logs: true },
    { url: 'https://b.example' },
    { url: 'https://c.example' },
    { url: 'https://d.example' },
  ], (m) => logs.push(m), { dns_over_https: false, logs_gap_ms: 0 });
  p.resolve = async () => [];
  p.post = async (url, body) => {
    const host = new URL(url).hostname[0];
    const req = JSON.parse(body);
    const one = (r) => { const a = answers[host](r.method); if (a instanceof Error) throw a; return { jsonrpc: '2.0', id: r.id, ...a }; };
    return Array.isArray(req) ? req.map(one) : one(req);
  };
  return p;
}
const filter = { fromBlock: '0x100', toBlock: '0x3e8', topics: [] };

(async () => {
  console.log('rpc-getlogs-alih:');

  await t('"historical state is not available" dari b → dialihkan ke c, hasil tetap didapat', async () => {
    const hit = [];
    const p = pool({
      b: (m) => { if (m === 'eth_getLogs') hit.push('b'); return { error: { code: -32000, message: 'historical state is not available' } }; },
      c: (m) => { if (m === 'eth_getLogs') hit.push('c'); return { result: [{ blockNumber: '0x101' }] }; },
      d: (m) => { if (m === 'eth_getLogs') hit.push('d'); return { result: [] }; },
    });
    const out = await p.getLogs(filter);
    assert.strictEqual(out.length, 1);
    assert.deepStrictEqual(hit, ['b', 'c']);
    assert.ok(p.eps[1].logsCooldownUntil > Date.now(), 'b istirahat getLogs');
    assert.strictEqual(p.eps[1].cooldownUntil, 0, 'b TIDAK istirahat untuk eth_call');
  });

  await t('selama istirahat getLogs, b masih melayani eth_call dan getLogs langsung ke c', async () => {
    const hit = [];
    const p = pool({
      b: (m) => { hit.push('b:' + m); return m === 'eth_getLogs' ? { error: { message: 'the network is busy, please try again in a moment' } } : { result: '0x1' }; },
      c: (m) => { hit.push('c:' + m); return m === 'eth_getLogs' ? { result: [] } : { result: { number: '0x3e8' } }; },
      d: () => ({ result: [] }),
    });
    await p.getLogs(filter);
    hit.length = 0;
    await p.getLogs(filter);
    assert.deepStrictEqual(hit, ['c:eth_getLogs', 'c:eth_getBlockByNumber'], 'b dilewati untuk getLogs');
    // eth_call tetap ke a (prioritas teratas, no_logs tidak masalah)
    hit.length = 0;
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }]);
    assert.deepStrictEqual(r, ['0x1']);
  });

  await t('galat kapasitas, "time budget", "invalid block range": semua dialihkan', async () => {
    for (const msg of ['block 61034367 alone returns more logs than the upstream will serve', 'backend exceeded 4500ms time budget; narrow your request or retry', 'invalid block range params']) {
      const p = pool({
        b: () => ({ error: { message: msg } }),
        c: () => ({ result: [{ blockNumber: '0x1' }] }),
        d: () => ({ result: [] }),
      });
      const out = await p.getLogs(filter);
      assert.strictEqual(out.length, 1, msg);
    }
  });

  await t('semua endpoint getLogs menolak: galat terakhir dilempar, menyebut host-nya', async () => {
    const p = pool({
      b: () => ({ error: { message: 'historical state is not available' } }),
      c: () => ({ error: { message: 'the network is busy' } }),
      d: () => ({ error: { message: 'invalid block range params' } }),
    });
    await assert.rejects(p.getLogs(filter), /invalid block range params \[d\.example\]/);
    assert.ok(p.eps.slice(1).every((e) => e.logsCooldownUntil > Date.now()));
  });

  await t('result null (bukan daftar) dianggap gagal dan dialihkan, bukan "tidak ada log"', async () => {
    const p = pool({
      b: () => ({ result: null }),
      c: () => ({ result: [{ blockNumber: '0x1' }] }),
      d: () => ({ result: [] }),
    });
    const out = await p.getLogs(filter);
    assert.strictEqual(out.length, 1);
  });

  await t('endpoint no_logs tidak pernah dicoba untuk getLogs walau semua yang lain istirahat', async () => {
    const hit = [];
    const p = pool({
      a: () => { hit.push('a'); return { result: [] }; },
      b: () => ({ error: { message: 'historical state is not available' } }),
      c: () => ({ error: { message: 'historical state is not available' } }),
      d: () => ({ error: { message: 'historical state is not available' } }),
    });
    await assert.rejects(p.getLogs(filter));
    await assert.rejects(p.getLogs(filter));
    assert.deepStrictEqual(hit, []);
  });

  await t('node tertinggal: getLogs [] tapi blok ujung belum ada → TIDAK diterima, dialihkan ke node yang punya bloknya', async () => {
    const p = pool({
      b: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),          // tertinggal
      c: (m) => (m === 'eth_getLogs' ? { result: [{ blockNumber: '0x3e0' }] } : { result: { number: '0x3e8' } }),
      d: () => ({ result: [] }),
    });
    const out = await p.getLogs(filter);
    assert.strictEqual(out.length, 1, 'log dari c, bukan daftar kosong dari b');
    assert.ok(p.eps[1].logsCooldownUntil > Date.now());
  });

  await t('semua node tertinggal: dilempar (kursor tidak maju), bukan daftar kosong', async () => {
    const p = pool({
      b: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
      c: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
      d: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
    });
    await assert.rejects(p.getLogs(filter), /belum sampai blok 1000/);
  });

  await t('eth_call: galat kuota per-item di balasan 200 dicoba ulang di endpoint lain, bukan jadi null', async () => {
    const p = pool({
      a: () => ({ error: { code: 429, message: 'Your app has exceeded its compute units per second capacity' } }),
      b: () => ({ result: '0x' + '0'.repeat(63) + '7' }),
      c: () => ({ result: '0x1' }), d: () => ({ result: '0x1' }),
    });
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }, { to: '0x2', data: '0x' }]);
    assert.deepStrictEqual(r, ['0x' + '0'.repeat(63) + '7', '0x' + '0'.repeat(63) + '7']);
  });

  await t('eth_call revert tetap null (jawaban sah), tidak diulang; strict tidak melempar untuk revert', async () => {
    let n = 0;
    const p = pool({
      a: () => { n++; return { error: { code: 3, message: 'execution reverted: ERC721: invalid token ID' } }; },
      b: () => ({ result: '0x1' }), c: () => ({ result: '0x1' }), d: () => ({ result: '0x1' }),
    });
    assert.deepStrictEqual(await p.ethCallMany([{ to: '0x1', data: '0x' }], 'latest', { strict: true }), [null]);
    assert.strictEqual(n, 1);
  });

  await t('eth_call strict: semua endpoint kena kuota → melempar, bukan null', async () => {
    const q = { error: { code: -32005, message: 'rate limit exceeded' } };
    const p = pool({ a: () => q, b: () => q, c: () => q, d: () => q });
    await assert.rejects(p.ethCallMany([{ to: '0x1', data: '0x' }], 'latest', { strict: true }), /tidak terbaca/);
    assert.deepStrictEqual(await pool({ a: () => q, b: () => q, c: () => q, d: () => q }).ethCallMany([{ to: '0x1', data: '0x' }]), [null]);
  });

  await t('item hilang dari balasan batch: dicoba ulang, bukan result null', async () => {
    const p = pool({ a: () => ({ result: '0xa' }), b: () => ({ result: '0xb' }), c: () => ({ result: '0xc' }), d: () => ({ result: '0xd' }) });
    const post = p.post;
    let first = true;
    p.post = async (url, body) => { const r = await post(url, body); if (first && Array.isArray(r)) { first = false; return r.slice(0, 1); } return r; };
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }, { to: '0x2', data: '0x' }]);
    assert.strictEqual(r[0], '0xa');
    assert.strictEqual(r[1], '0xb');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
