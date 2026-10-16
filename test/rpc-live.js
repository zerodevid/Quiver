'use strict';
// Test: the shared cache for live RPC reads (src/rpclive.js).
//
// Guarded here: identical reads from several tenants collapse into one network call
// (single-flight + a short TTL), and everything that must stay fresh never enters —
// nonces, balances, allowances, simulations, eth_call without `share`.
// Run: node test/rpc-live.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pool(answer, { live = {}, delay = 20, fail = false } = {}) {
  const p = new RpcPool([{ url: 'https://a.example' }], () => {}, {
    dns_over_https: false,
    cache: { store: new Store(':memory:'), chain: 'robinhood', live },
  });
  p.calls = {};
  p.post = async (url, body) => {
    const j = JSON.parse(body);
    await sleep(delay);
    if (fail) throw new Error('boom');
    const one = (c) => {
      p.calls[c.method] = (p.calls[c.method] || 0) + 1;
      return { jsonrpc: '2.0', id: c.id, result: answer(c.method, c.params, p.calls[c.method]) };
    };
    return Array.isArray(j) ? j.map(one) : one(j);
  };
  return p;
}

const POOL = '0x00000000000000000000000000000000000000aa';
const word = (n) => '0x' + n.toString(16).padStart(64, '0');

(async () => {
  console.log('rpc-live:');

  await t('simultaneous blockNumber reads from many tenants make one network call', async () => {
    const p = pool(() => '0x64');
    const out = await Promise.all(Array.from({ length: 20 }, () => p.blockNumber()));
    assert.ok(out.every((n) => n === 100));
    assert.strictEqual(p.calls.eth_blockNumber, 1);
    assert.strictEqual(p.cacheStats().live.joined, 19);
  });

  await t('a read within the TTL is answered without the network, then expires', async () => {
    const p = pool((m, _, n) => '0x' + (100 + n).toString(16), { live: { ttl_ms: { eth_blockNumber: 60 } } });
    assert.strictEqual(await p.blockNumber(), 101);
    assert.strictEqual(await p.blockNumber(), 101);
    assert.strictEqual(p.calls.eth_blockNumber, 1);
    await sleep(90);
    assert.strictEqual(await p.blockNumber(), 102);
    assert.strictEqual(p.calls.eth_blockNumber, 2);
  });

  await t('eth_call is shared only when the caller opts in', async () => {
    const p = pool((m, _, n) => word(n));
    const item = { to: POOL, data: '0x3850c7bd' };
    await Promise.all([p.ethCallMany([item]), p.ethCallMany([item]), p.ethCallMany([item])]);
    assert.strictEqual(p.calls.eth_call, 3, 'no share flag: every caller really asks');
    p.calls.eth_call = 0;
    const r = await Promise.all([1, 2, 3].map(() => p.ethCallMany([item], 'latest', { share: true })));
    assert.strictEqual(p.calls.eth_call, 1);
    assert.deepStrictEqual(r[0], r[2]);
  });

  await t('a shared eth_call with `from` (simulation) or at a past block is never shared', async () => {
    const p = pool((m, _, n) => word(n));
    const sim = { to: POOL, data: '0x01', from: '0x00000000000000000000000000000000000000bb' };
    await p.ethCallMany([sim], 'latest', { share: true });
    await p.ethCallMany([sim], 'latest', { share: true });
    assert.strictEqual(p.calls.eth_call, 2);
    p.calls.eth_call = 0;
    await p.ethCallMany([{ to: POOL, data: '0x02' }], '0x10', { share: true });
    await p.ethCallMany([{ to: POOL, data: '0x02' }], '0x10', { share: true });
    assert.strictEqual(p.calls.eth_call, 2, 'past blocks belong to the final-answer cache, not this one');
  });

  await t('nonce, balance and `pending` reads are never shared', async () => {
    const p = pool(() => '0x1');
    for (let i = 0; i < 3; i++) {
      await p.call('eth_getTransactionCount', ['0xabc', 'pending']);
      await p.call('eth_getBalance', ['0xabc', 'latest']);
    }
    assert.strictEqual(p.calls.eth_getTransactionCount, 3);
    assert.strictEqual(p.calls.eth_getBalance, 3);
  });

  await t('only the `latest` block is shared for eth_getBlockByNumber', async () => {
    const p = pool(() => ({ number: '0x64', hash: '0x1' }));
    await p.call('eth_getBlockByNumber', ['latest', false]);
    await p.call('eth_getBlockByNumber', ['latest', false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 1);
    await p.call('eth_getBlockByNumber', ['pending', false]);
    await p.call('eth_getBlockByNumber', ['pending', false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 3);
  });

  await t('callers get their own copy: mutating one answer does not change the next', async () => {
    const p = pool(() => ({ number: '0x64', hash: '0x1' }));
    const a = await p.call('eth_getBlockByNumber', ['latest', false]);
    a.number = 'mutated';
    const b = await p.call('eth_getBlockByNumber', ['latest', false]);
    assert.strictEqual(b.number, '0x64');
  });

  await t('a failing leader fails its followers too, and the next call retries', async () => {
    const p = pool(() => '0x64', { fail: true });
    const r = await Promise.allSettled([p.blockNumber(), p.blockNumber(), p.blockNumber()]);
    assert.ok(r.every((x) => x.status === 'rejected'));
    assert.strictEqual(p.live.flying.size, 0, 'nothing is left in flight');
    p.post = async (u, body) => ({ jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x65' });
    assert.strictEqual(await p.blockNumber(), 101);
  });

  await t('two batches that lead what the other follows do not deadlock', async () => {
    const p = pool((m, params) => word(parseInt(params[0].data, 16)));
    const a = { to: POOL, data: '0x01' }, b = { to: POOL, data: '0x02' };
    const [x, y] = await Promise.all([
      p.ethCallMany([a, b], 'latest', { share: true }),
      p.ethCallMany([b, a], 'latest', { share: true }),
    ]);
    assert.deepStrictEqual(x, [word(1), word(2)]);
    assert.deepStrictEqual(y, [word(2), word(1)]);
  });

  await t('a pool without cache options (an endpoint test pool) shares nothing', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false });
    let n = 0;
    p.post = async (u, body) => { n++; return { jsonrpc: '2.0', id: JSON.parse(body).id, result: '0x64' }; };
    await p.blockNumber(); await p.blockNumber();
    assert.strictEqual(n, 2);
    assert.strictEqual(p.cacheStats(), null);
  });

  await t('live.enabled=false switches it off', async () => {
    const p = pool(() => '0x64', { live: { enabled: false } });
    await p.blockNumber(); await p.blockNumber();
    assert.strictEqual(p.calls.eth_blockNumber, 2);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
