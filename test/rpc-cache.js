'use strict';
// Test: the cache of RPC answers that are already final (src/rpccache.js).
//
// What is guarded here: what may be stored (only what is tied to a past block that is
// deep enough), what may NOT (live data, pending receipts, blocks near the
// head, log lists from a lagging node), and that the stored entries survive after the
// process comes back up.
// Run: node test/rpc-cache.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const hex = (n) => '0x' + n.toString(16);
const HEAD = 1_000_000;

// A pool with one fake endpoint. `answer(method, params)` -> result; each call
// that really goes out to the "network" is counted per method.
function pool(answer, { store = new Store(':memory:'), cache = {}, head = HEAD } = {}) {
  const p = new RpcPool([{ url: 'https://a.example', archive: true }], () => {}, {
    dns_over_https: false,
    cache: { store, chain: 'robinhood', confirmations: 64, ...cache },
  });
  p.calls = {};
  p.post = async (url, body) => {
    const j = JSON.parse(body);
    const one = (c) => {
      p.calls[c.method] = (p.calls[c.method] || 0) + 1;
      return { jsonrpc: '2.0', id: c.id, result: answer(c.method, c.params) };
    };
    return Array.isArray(j) ? j.map(one) : one(j);
  };
  p.head = head;
  return p;
}

const receipt = (block) => ({ blockNumber: hex(block), status: '0x1', logs: [] });

(async () => {
  console.log('rpc-cache:');

  await t('receipt at a past block: the second call does not touch the network', async () => {
    const p = pool((m) => (m === 'eth_getTransactionReceipt' ? receipt(HEAD - 5000) : null));
    const a = await p.call('eth_getTransactionReceipt', ['0xAA']);
    const b = await p.call('eth_getTransactionReceipt', ['0xaa']);   // same upper/lower case
    assert.deepStrictEqual(a, b);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 1);
    assert.strictEqual(p.cacheStats().rows, 1);
  });

  await t('a receipt that is still pending is not stored', async () => {
    const p = pool(() => null);
    assert.strictEqual(await p.call('eth_getTransactionReceipt', ['0xbb']), null);
    assert.strictEqual(await p.call('eth_getTransactionReceipt', ['0xbb']), null);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('a transaction already booked is stored, one still in the mempool is not', async () => {
    let block = null;
    const p = pool(() => ({ hash: '0xcc', blockNumber: block == null ? null : hex(block) }));
    await p.call('eth_getTransactionByHash', ['0xcc']);
    await p.call('eth_getTransactionByHash', ['0xcc']);
    assert.strictEqual(p.calls.eth_getTransactionByHash, 2, 'mempool: always ask again');
    block = HEAD - 1000;
    await p.call('eth_getTransactionByHash', ['0xcc']);
    const r = await p.call('eth_getTransactionByHash', ['0xcc']);
    assert.strictEqual(r.blockNumber, hex(block));
    assert.strictEqual(p.calls.eth_getTransactionByHash, 3);
  });

  await t('a block not deep enough is not stored, a deep one is', async () => {
    const p = pool((m, prm) => ({ number: prm[0], timestamp: '0x64' }));
    const near = hex(HEAD - 10);     // < confirmations (64) from the head
    await p.call('eth_getBlockByNumber', [near, false]);
    await p.call('eth_getBlockByNumber', [near, false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 2);
    const inside = hex(HEAD - 5000);
    await p.call('eth_getBlockByNumber', [inside, false]);
    await p.call('eth_getBlockByNumber', [inside, false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 3);
  });

  await t('chain height not yet known: nothing is stored', async () => {
    const p = pool(() => receipt(1000), { head: 0 });
    await p.call('eth_getTransactionReceipt', ['0xdd']);
    await p.call('eth_getTransactionReceipt', ['0xdd']);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('live data is never stored (blockNumber, current balance, eth_call at latest)', async () => {
    const p = pool((m) => (m === 'eth_blockNumber' ? hex(HEAD) : '0x1'));
    for (let i = 0; i < 2; i++) {
      await p.call('eth_blockNumber');
      await p.call('eth_getBalance', ['0xab', 'latest']);
      await p.ethCall('0xab', '0xdata');
      await p.call('eth_gasPrice');
    }
    assert.strictEqual(p.calls.eth_blockNumber, 2);
    assert.strictEqual(p.calls.eth_getBalance, 2);
    assert.strictEqual(p.calls.eth_call, 2);
    assert.strictEqual(p.calls.eth_gasPrice, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('eth_call & balance at a past block are stored (saves the archive node quota)', async () => {
    const p = pool(() => '0x2a');
    const blk = HEAD - 200_000;
    await p.callAt('0xab', '0xdata', blk);
    await p.callAt('0xab', '0xdata', blk);
    await p.call('eth_getBalance', ['0xab', hex(blk)]);
    await p.call('eth_getBalance', ['0xab', hex(blk)]);
    assert.strictEqual(p.calls.eth_call, 1);
    assert.strictEqual(p.calls.eth_getBalance, 1);
  });

  await t('getLogs over a past range: the second time is answered from the store', async () => {
    const logs = [{ address: '0xab', data: '0x1', blockNumber: hex(HEAD - 9000) }];
    const p = pool((m, prm) => (m === 'eth_getLogs' ? logs : { number: prm[0] }));
    const filter = { fromBlock: hex(HEAD - 10_000), toBlock: hex(HEAD - 9000), topics: [] };
    assert.deepStrictEqual(await p.getLogs(filter), logs);
    // A different filter column order: the key stays the same.
    assert.deepStrictEqual(await p.getLogs({ topics: [], toBlock: filter.toBlock, fromBlock: filter.fromBlock }), logs);
    assert.strictEqual(p.calls.eth_getLogs, 1);
  });

  await t('getLogs up to the chain head is not stored', async () => {
    const p = pool((m, prm) => (m === 'eth_getLogs' ? [] : { number: prm[0] }));
    const filter = { fromBlock: hex(HEAD - 100), toBlock: hex(HEAD - 20), topics: [] };
    await p.getLogs(filter);
    await p.getLogs(filter);
    assert.strictEqual(p.calls.eth_getLogs, 2);
  });

  await t('lagging node: its empty log list is not immortalised', async () => {
    // The range's end block does not exist on that endpoint -> getLogs fails, and that end
    // block itself must not be answered from the cache (it is the endpoint that is being tested).
    const p = pool((m) => (m === 'eth_getLogs' ? [] : null));
    const filter = { fromBlock: hex(HEAD - 10_000), toBlock: hex(HEAD - 9000), topics: [] };
    await assert.rejects(p.getLogs(filter), /tertinggal/);
    assert.strictEqual(p.cacheStats().rows, 0);
    // The endpoint recovers: the same range is read again, now with content.
    const logs = [{ data: '0x1' }];
    p.post = async (url, body) => {
      const j = JSON.parse(body);
      const one = (c) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_getLogs' ? logs : { number: c.params[0] } });
      return Array.isArray(j) ? j.map(one) : one(j);
    };
    p.eps[0].logsCooldownUntil = 0;
    assert.deepStrictEqual(await p.getLogs(filter), logs);
  });

  await t('an error is not stored as an answer', async () => {
    const store = new Store(':memory:');
    const p = pool(() => null);
    p.post = async (url, body) => {
      const j = JSON.parse(body);
      return { jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } };
    };
    await assert.rejects(p.call('eth_call', [{ to: '0xab', data: '0x' }, hex(HEAD - 5000)]), /reverted/);
    assert.strictEqual(p.cacheStats().rows, 0);
    assert.ok(store);
  });

  await t('the store survives after the process is alive again', async () => {
    const store = new Store(':memory:');
    const a = pool(() => receipt(HEAD - 5000), { store });
    await a.call('eth_getTransactionReceipt', ['0xee']);
    assert.strictEqual(a.calls.eth_getTransactionReceipt, 1);
    // A new pool (restart), same database: no more network calls.
    const b = pool(() => { throw new Error('tidak boleh menyentuh jaringan'); }, { store });
    const r = await b.call('eth_getTransactionReceipt', ['0xee']);
    assert.strictEqual(r.blockNumber, hex(HEAD - 5000));
    assert.strictEqual(b.calls.eth_getTransactionReceipt, undefined);
  });

  await t('another chain in the same database is not read', async () => {
    const store = new Store(':memory:');
    const a = pool(() => receipt(HEAD - 5000), { store });
    await a.call('eth_getTransactionReceipt', ['0xff']);
    const b = pool(() => receipt(HEAD - 5000), { store, cache: { chain: 'bsc' } });
    await b.call('eth_getTransactionReceipt', ['0xff']);
    assert.strictEqual(b.calls.eth_getTransactionReceipt, 1, 'bsc must ask for itself');
    assert.strictEqual(b.cacheStats().rows, 1);
  });

  await t('expired entries & over-limit ones are dropped at cleanup', async () => {
    const store = new Store(':memory:');
    const p = pool(() => receipt(HEAD - 5000), { store, cache: { ttl_days: 1 } });
    await p.call('eth_getTransactionReceipt', ['0x01']);
    store.run('UPDATE rpc_cache SET ts = ?', Date.now() - 3 * 86400_000);
    p.cache.sweep();
    assert.strictEqual(p.cacheStats().rows, 0);

    const q = pool(() => receipt(HEAD - 5000), { store, cache: { max_rows: 2 } });
    for (let i = 0; i < 5; i++) {
      // the row ts is written from wall-clock time; moved back so the "oldest" order is clear.
      await q.call('eth_getTransactionReceipt', [`0x1${i}`]);
      store.run('UPDATE rpc_cache SET ts=? WHERE k LIKE ?', Date.now() - (5 - i) * 60_000, `%0x1${i}%`);
    }
    q.cache.sweep();
    assert.strictEqual(q.cacheStats().rows, 2);
  });

  await t('a giant answer is skipped, does not bloat the database', async () => {
    const p = pool(() => ({ blockNumber: hex(HEAD - 5000), data: 'x'.repeat(200 * 1024) }), { cache: { max_entry_kb: 64 } });
    await p.call('eth_getTransactionReceipt', ['0x02']);
    await p.call('eth_getTransactionReceipt', ['0x02']);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
    assert.strictEqual(p.cacheStats().tooBig, 2);
  });

  await t('a block that is still fresh is not asked of the database at all', async () => {
    // The engine reads fees at block head-3 every tick: a lookup like that must not
    // add load to the database, and must not be counted as a "miss".
    const p = pool((m, prm) => ({ number: prm[0] }));
    let read = 0;
    const original = p.cache.store.get.bind(p.cache.store);
    p.cache.store.get = (...a) => { if (String(a[0]).includes('rpc_cache')) read++; return original(...a); };
    for (let i = 0; i < 5; i++) await p.call('eth_getBlockByNumber', [hex(HEAD - 3), false]);
    assert.strictEqual(read, 0, `the database was asked ${read} times for a block that is not yet final`);
    assert.strictEqual(p.cacheStats().misses, 0);
    assert.strictEqual(p.cacheStats().hitPct, 0);
    // A deep block still counts: once it misses, the rest hit.
    for (let i = 0; i < 3; i++) await p.call('eth_getBlockByNumber', [hex(HEAD - 5000), false]);
    const st = p.cacheStats();
    assert.strictEqual(st.misses, 1);
    assert.strictEqual(st.hits, 2);
    assert.strictEqual(st.hitPct, 67);
  });

  await t('an answer from the cache does not share an object: the caller may mutate it', async () => {
    const p = pool(() => receipt(HEAD - 5000));
    const a = await p.call('eth_getTransactionReceipt', ['0x04']);
    a.status = '0x0';                                  // the caller normalises the answer
    const b = await p.call('eth_getTransactionReceipt', ['0x04']);
    assert.strictEqual(b.status, '0x1', 'the cache contents also changed');
  });

  await t('the memory layer is bounded by bytes, not only entry count', async () => {
    const large = { blockNumber: hex(HEAD - 5000), data: 'x'.repeat(200 * 1024) };
    const p = pool(() => large, { cache: { mem_mb: 1, max_entry_kb: 512 } });
    for (let i = 0; i < 12; i++) await p.call('eth_getTransactionReceipt', [`0x2${i}`]);
    const st = p.cacheStats();
    assert.strictEqual(st.rows, 12, 'everything still goes into the database');
    assert.ok(st.memBytes <= 1024 * 1024, `memori dibatasi 1 MB, terpakai ${st.memBytes}`);
    assert.ok(st.mem < 12, 'the oldest entry is dropped from memory');
  });

  await t('without a store: the pool still runs without a cache (endpoint test in Settings)', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false });
    p.post = async (url, body) => ({ jsonrpc: '2.0', id: JSON.parse(body).id, result: receipt(1) });
    assert.strictEqual(p.cacheStats(), null);
    assert.ok(await p.call('eth_getTransactionReceipt', ['0x03']));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
