'use strict';
// Test that pool metadata (token pair, fee, tickSpacing, hook) in the `pools` table
// is not lost because of another write to the same row.
//
// Real case (lp3, 2026-09-22): the #pool/0x7759…a1c7 page showed "?/?" and a
// price of 2.79e+15, even though the Positions page knew the token pair exactly. The cause was
// Chain.poolAgeMinutes writing its row with INSERT OR REPLACE for the
// first_block/first_ts columns only — SQLite replaces the entire row, so the already filled
// token0/token1/fee/tick_spacing/hooks became NULL too. /api/pool read `pools`
// first, got that empty row, and fell back to the '?' symbol + 18 decimals.
//
// Run: node test/pool-meta.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { ADDR, TOPIC } = require('../src/chain');

const POOL = '0x' + '77'.repeat(32);
const MEME = '0xbb77b9086caec884e4ad89f7f7b47b45e7233cdc';
const HEAD = 1_000_000;
const BORN = HEAD - 1_000;
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexb = (b) => '0x' + b.toString(16);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// Initialize: topics = [sig, poolId, currency0, currency1], data = fee, tickSpacing,
// hooks, sqrtPriceX96, tick.
const initLog = (block) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x0', transactionHash: '0x' + w(block),
  topics: [TOPIC.initializeV4, POOL, pad32(ADDR.usdg), pad32(MEME)],
  data: '0x' + w(80000) + w(800) + w(0) + w('0x1000000000000000000000000') + w(0),
});

function world({ logs = [] } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    blockNumber: async () => HEAD,
    call: async () => ({ number: hexb(HEAD), timestamp: hexb(Math.floor(Date.now() / 1000)) }),
    getLogs: async (f) => logs.filter((l) => {
      const b = parseInt(l.blockNumber, 16);
      if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
      return (f.topics || []).every((s, i) => s == null || s === l.topics[i]);
    }),
  };
  return { store, chain: new Chain(rpc, store, () => {}) };
}

const meta = (store) => store.get('SELECT token0,token1,fee,tick_spacing,hooks,init_sqrt FROM pools WHERE chain=? AND pool_ref=?', 'robinhood', POOL);
const hasPair = (r, label) => {
  assert.ok(r, `${label}: pools row is gone`);
  assert.equal(r.token0, ADDR.usdg, `${label}: token0 hilang`);
  assert.equal(r.token1, MEME, `${label}: token1 hilang`);
  assert.equal(r.fee, 80000, `${label}: fee hilang`);
  assert.equal(r.tick_spacing, 800, `${label}: tickSpacing hilang`);
};

(async () => {
  console.log('pool metadata must not be erased by another write');

  await t('pool age recorded -> the token pair is still there', async () => {
    const { store, chain } = world({ logs: [initLog(BORN)] });
    const pk = await chain.poolKeyOfId(POOL);
    assert.equal(pk.currency1, MEME, 'poolKey unreadable from Initialize');
    hasPair(meta(store), 'sebelum umur dibaca');

    const age = await chain.poolAgeMinutes(POOL);
    assert.ok(age >= 0 && Number.isFinite(age), `pool age makes no sense: ${age}`);
    hasPair(meta(store), 'setelah umur dibaca');
    assert.ok(meta(store).init_sqrt, 'birth price also got erased');
  });

  await t('pool older than the scan window -> the token pair is still there', async () => {
    // Its Initialize exists (poolKey is readable) but outside the age window, so
    // poolAgeMinutes takes the "very old" branch, which also writes the row.
    const { store, chain } = world({ logs: [initLog(BORN)] });
    await chain.poolKeyOfId(POOL);
    hasPair(meta(store), 'sebelum umur dibaca');

    const age = await chain.poolAgeMinutes(POOL, 100);
    assert.ok(age > 0, `an old pool's age must be positive: ${age}`);
    hasPair(meta(store), 'setelah umur dibaca');
  });

  await t('an age that is already recorded is not rewritten', async () => {
    const { store, chain } = world({ logs: [initLog(BORN)] });
    await chain.poolKeyOfId(POOL);
    await chain.poolAgeMinutes(POOL);
    const ts = store.get('SELECT first_ts FROM pools WHERE chain=? AND pool_ref=?', 'robinhood', POOL).first_ts;
    assert.ok(ts, 'first_ts not recorded');
    await chain.poolAgeMinutes(POOL);
    hasPair(meta(store), 'setelah umur dibaca dua kali');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
