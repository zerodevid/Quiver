'use strict';
// getLogs failover test: a JSON-RPC error (a 200 reply containing an error) from one endpoint
// must not fail the scan as long as another endpoint can still do it — and
// an endpoint that refuses is rested ONLY for getLogs, its eth_call keeps being used.
// Run: node test/rpc-getlogs-failover.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// answer per host: function (method) -> {result} | {error} | throw (transport)
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

  await t('"historical state is not available" from b → diverted to c, the result is still obtained', async () => {
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
    assert.strictEqual(p.eps[1].cooldownUntil, 0, 'b does NOT rest for eth_call');
  });

  await t('during the getLogs rest, b still serves eth_call and getLogs goes straight to c', async () => {
    const hit = [];
    const p = pool({
      b: (m) => { hit.push('b:' + m); return m === 'eth_getLogs' ? { error: { message: 'the network is busy, please try again in a moment' } } : { result: '0x1' }; },
      c: (m) => { hit.push('c:' + m); return m === 'eth_getLogs' ? { result: [] } : { result: { number: '0x3e8' } }; },
      d: () => ({ result: [] }),
    });
    await p.getLogs(filter);
    hit.length = 0;
    await p.getLogs(filter);
    assert.deepStrictEqual(hit, ['c:eth_getLogs', 'c:eth_getBlockByNumber'], 'b is skipped for getLogs');
    // eth_call still goes to a (top priority, no_logs does not matter)
    hit.length = 0;
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }]);
    assert.deepStrictEqual(r, ['0x1']);
  });

  await t('capacity error, "time budget", "invalid block range": all diverted', async () => {
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

  await t('all getLogs endpoints refuse: the last error is thrown, naming its host', async () => {
    const p = pool({
      b: () => ({ error: { message: 'historical state is not available' } }),
      c: () => ({ error: { message: 'the network is busy' } }),
      d: () => ({ error: { message: 'invalid block range params' } }),
    });
    await assert.rejects(p.getLogs(filter), /invalid block range params \[d\.example\]/);
    assert.ok(p.eps.slice(1).every((e) => e.logsCooldownUntil > Date.now()));
  });

  await t('result null (not a list) is treated as a failure and diverted, not "no logs"', async () => {
    const p = pool({
      b: () => ({ result: null }),
      c: () => ({ result: [{ blockNumber: '0x1' }] }),
      d: () => ({ result: [] }),
    });
    const out = await p.getLogs(filter);
    assert.strictEqual(out.length, 1);
  });

  await t('a no_logs endpoint is never tried for getLogs even if all the others are resting', async () => {
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

  await t('lagging node: getLogs [] but the end block does not exist yet → NOT accepted, diverted to a node that has the block', async () => {
    const p = pool({
      b: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),          // lagging behind
      c: (m) => (m === 'eth_getLogs' ? { result: [{ blockNumber: '0x3e0' }] } : { result: { number: '0x3e8' } }),
      d: () => ({ result: [] }),
    });
    const out = await p.getLogs(filter);
    assert.strictEqual(out.length, 1, 'logs from c, not the empty list from b');
    assert.ok(p.eps[1].logsCooldownUntil > Date.now());
  });

  await t('all nodes lagging: thrown (the cursor does not advance), not an empty list', async () => {
    const p = pool({
      b: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
      c: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
      d: (m) => (m === 'eth_getLogs' ? { result: [] } : { result: null }),
    });
    await assert.rejects(p.getLogs(filter), /belum sampai blok 1000/);
  });

  await t('eth_call: a per-item quota error in a 200 reply is retried on another endpoint, not turned into null', async () => {
    const p = pool({
      a: () => ({ error: { code: 429, message: 'Your app has exceeded its compute units per second capacity' } }),
      b: () => ({ result: '0x' + '0'.repeat(63) + '7' }),
      c: () => ({ result: '0x1' }), d: () => ({ result: '0x1' }),
    });
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }, { to: '0x2', data: '0x' }]);
    assert.deepStrictEqual(r, ['0x' + '0'.repeat(63) + '7', '0x' + '0'.repeat(63) + '7']);
  });

  await t('an eth_call revert stays null (a legitimate answer), not repeated; strict does not throw for a revert', async () => {
    let n = 0;
    const p = pool({
      a: () => { n++; return { error: { code: 3, message: 'execution reverted: ERC721: invalid token ID' } }; },
      b: () => ({ result: '0x1' }), c: () => ({ result: '0x1' }), d: () => ({ result: '0x1' }),
    });
    assert.deepStrictEqual(await p.ethCallMany([{ to: '0x1', data: '0x' }], 'latest', { strict: true }), [null]);
    assert.strictEqual(n, 1);
  });

  await t('strict eth_call: every endpoint hits quota → throws, not null', async () => {
    const q = { error: { code: -32005, message: 'rate limit exceeded' } };
    const p = pool({ a: () => q, b: () => q, c: () => q, d: () => q });
    await assert.rejects(p.ethCallMany([{ to: '0x1', data: '0x' }], 'latest', { strict: true }), /tidak terbaca/);
    assert.deepStrictEqual(await pool({ a: () => q, b: () => q, c: () => q, d: () => q }).ethCallMany([{ to: '0x1', data: '0x' }]), [null]);
  });

  await t('an item missing from the batch reply: retried, not a null result', async () => {
    const p = pool({ a: () => ({ result: '0xa' }), b: () => ({ result: '0xb' }), c: () => ({ result: '0xc' }), d: () => ({ result: '0xd' }) });
    const post = p.post;
    let first = true;
    p.post = async (url, body) => { const r = await post(url, body); if (first && Array.isArray(r)) { first = false; return r.slice(0, 1); } return r; };
    const r = await p.ethCallMany([{ to: '0x1', data: '0x' }, { to: '0x2', data: '0x' }]);
    assert.strictEqual(r[0], '0xa');
    assert.strictEqual(r[1], '0xb');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
