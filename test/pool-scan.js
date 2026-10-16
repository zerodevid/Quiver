'use strict';
// Manual.scanPools: the token pool scan is cheap enough to wait on.
// - getLogs spans 10M blocks per call (what the official Robinhood RPC allows) instead of 400k,
// - a range the endpoint refuses is split to 400k only there,
// - a rescan reads only the blocks after the previous one and keeps the pools found before.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Manual } = require('../src/manual');
const { ADDR, TOPIC } = require('../src/chain');

const coder = ethers.AbiCoder.defaultAbiCoder();
const TOKEN = '0x' + '22'.repeat(20);
const POOL_ID = '0x' + '33'.repeat(32);
const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');

function fixture({ head = 88_500_000, maxSpan = 10_000_000, poolBlock = 50_000_000, refuse = () => false } = {}) {
  const store = new Store(':memory:');
  const calls = [];
  const state = { head };
  const initLog = {
    topics: [TOPIC.initializeV4, POOL_ID, pad(TOKEN), pad(ADDR.usdg)],
    data: coder.encode(['uint24', 'int24', 'address', 'uint160', 'int24'], [3000, 60, ADDR.native, 1n << 96n, 0]),
    blockNumber: '0x' + poolBlock.toString(16),
  };
  const rpc = {
    blockNumber: async () => state.head,
    maxLogSpan: () => 0,
    getLogs: async (f) => {
      const lo = parseInt(f.fromBlock, 16), hi = parseInt(f.toBlock, 16);
      calls.push([lo, hi]);
      if (hi - lo + 1 > maxSpan) throw new Error(`eth_getLogs: query spans ${hi - lo + 1} blocks, but only ${maxSpan} are allowed for this request; narrow the block range`);
      if (refuse(lo, hi)) throw new Error('eth_getLogs: upstream error');
      const hit = f.topics[0] === TOPIC.initializeV4 && f.topics[2] === pad(TOKEN) && poolBlock >= lo && poolBlock <= hi;
      return hit ? [initLog] : [];
    },
    ethCallMany: async () => ['0x'],
  };
  const chain = {
    network: 'robinhood', ADDR, venues: [],
    factoryV3: async () => { throw new Error('no v3'); },
    tokens: async (list) => list.map((address) => ({ address, symbol: address === ADDR.usdg ? 'USDG' : 'TKN', decimals: 6 })),
    isV3Venue: (v) => v !== 'v4',
    poolLiquidity: async () => 5n,
    quoteSideOf: () => ({ side: 1, kind: 'usd', symbol: 'USDG' }),
  };
  const man = new Manual({ engine: {}, store, chain, rpc });
  return { man, calls, state, store };
}

test('the whole history takes ~9 calls per query at 10M blocks, not ~220 at 400k', async () => {
  const f = fixture();
  const pools = await f.man.scanPools(TOKEN);
  assert.equal(pools.length, 1);
  assert.equal(pools[0].poolRef, POOL_ID);
  // 2 v4 queries (token as currency0 / currency1) × 9 chunks of 10M blocks.
  assert.equal(f.calls.length, 18);
  assert.ok(f.calls.every(([lo, hi]) => hi - lo + 1 <= 10_000_000));
});

test('a stricter endpoint gets 400k chunks only where a 10M range is refused', async () => {
  const f = fixture({ maxSpan: 400_000, head: 20_000_000, poolBlock: 5_000_000 });
  const pools = await f.man.scanPools(TOKEN);
  assert.equal(pools.length, 1);
  const wide = f.calls.filter(([lo, hi]) => hi - lo + 1 > 400_000).length;
  assert.equal(wide, 4);   // 2 queries × 2 refused 10M chunks
});

test('a rescan reads only the new blocks and keeps the pools found before', async () => {
  const f = fixture();
  await f.man.scanPools(TOKEN);
  f.calls.length = 0;
  f.state.head += 1000;
  const pools = await f.man.scanPools(TOKEN);
  assert.equal(pools.length, 1, 'the pool from the first scan is still listed');
  assert.equal(f.calls.length, 2, 'one call per query for the new blocks');
  assert.ok(f.calls.every(([lo]) => lo === 88_500_001));
});

test('a range that failed is read again by the next scan', async () => {
  let broken = true;
  const f = fixture({ refuse: (lo, hi) => broken && lo <= 50_000_000 && hi >= 50_000_000 });
  assert.equal((await f.man.scanPools(TOKEN)).length, 0);
  broken = false;
  f.calls.length = 0;
  const pools = await f.man.scanPools(TOKEN);
  assert.equal(pools.length, 1, 'the pool hidden by the failed range is found on the rescan');
  assert.ok(f.calls.length >= 18, 'a failed scan does not advance the saved block');
});

// Manual.dexPools: the DexScreener fast path resolves listed pools on chain in one batch.
test('dexPools keeps a listed v4 pool whose poolKey hashes to its id and drops foreign ones', async () => {
  const { computePoolId } = require('../src/pools');
  const key = { currency0: ADDR.usdg, currency1: TOKEN, fee: 3000, tickSpacing: 60, hooks: ADDR.native };
  const id = computePoolId(key).toLowerCase();
  const encodedKey = coder.encode(['address', 'address', 'uint24', 'int24', 'address'], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]);
  const f = fixture();
  const sent = [];
  f.man.rpc.ethCallMany = async (items) => { sent.push(...items); return items.map((i) => (i.data.startsWith('0x86b6be7d') && i.data.slice(10, 60) === id.slice(2, 52) ? encodedKey : '0x' + '0'.repeat(320))); };
  const pairs = [
    { pool: id, base: { address: TOKEN }, quote: { address: ADDR.usdg }, liquidityUsd: 1000 },
    // Listed under a v4 id, but no PositionManager key: never resolved.
    { pool: '0x' + '44'.repeat(32), base: { address: TOKEN }, quote: { address: ADDR.usdg }, liquidityUsd: 5000 },
    // A v3-shaped address from a factory this chain does not trade (Ramses): dropped.
    { pool: '0x' + '55'.repeat(20), base: { address: TOKEN }, quote: { address: ADDR.usdg }, liquidityUsd: 9000 },
  ];
  const pools = await f.man.dexPools(TOKEN, pairs);
  assert.deepEqual(pools.map((p) => p.poolRef), [id]);
  assert.equal(pools[0].fee, 3000);
  assert.equal(pools[0].tickSpacing, 60);
  assert.equal(f.calls.length, 0, 'no getLogs sweep');
  assert.equal(sent.filter((i) => i.to === ADDR.posmV4).length, 2);
});
