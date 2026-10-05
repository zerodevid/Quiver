'use strict';
// Test the pool price at the event block (WalletResearch.priceAt) for a pool that has
// never been swapped.
//
// Real case (lp3, 2026-09-21): the target created a USDG/THOT pool and minted
// $1,000 in the same block, then closed it 1 minute later without a single Swap.
// The archive node had no pool state at the previous block, the Swap search
// was empty, so the mint was "priceless": the position was recorded with $0 capital and showed
// "profit +$1,000" — and never healed, because there was no Swap that
// could be found. The correct mint price is in that pool's Initialize event.
//
// Run: node test/birth-price.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { WalletResearch } = require('../src/wallet');
const { ADDR, TOPIC } = require('../src/chain');
const m = require('../src/v3math');

const POOL = '0x' + '54'.repeat(32);
const MEME = '0xe20359d3e4cb4540c3383452116c90f27cd92e34';
const HEAD = 1_000_000;
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const hexb = (b) => '0x' + b.toString(16);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const initLog = (block, sqrt) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x0', transactionHash: '0x' + w(block),
  topics: [TOPIC.initializeV4, POOL, pad32(ADDR.usdg), pad32(MEME)],
  data: '0x' + w(10000) + w(200) + w(0) + w(sqrt) + w(0),
});
const swapLog = (block, sqrt) => ({
  address: ADDR.poolManager, blockNumber: hexb(block), logIndex: '0x1', transactionHash: '0x' + w(block + 7),
  topics: [TOPIC.swapV4, POOL, pad32('0x' + '99'.repeat(20))],
  data: '0x' + w(0) + w(0) + w(sqrt) + w(0) + w(0) + w(0),
});

function world({ logs = [], archived = false } = {}) {
  const store = new Store(':memory:');
  const hit = { logs: 0 };
  const rpc = {
    blockNumber: async () => HEAD,
    hasArchive: () => archived,
    callAt: async () => '0x' + w(0),   // the pool did not exist at the previous block
    getLogs: async (f) => {
      hit.logs++;
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return logs.filter((l) => {
        if (String(f.address).toLowerCase() !== l.address.toLowerCase()) return false;
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        return (f.topics || []).every((s, i) => s == null || s === l.topics[i]);
      });
    },
  };
  const chain = new Chain(rpc, store, () => {});
  const research = new WalletResearch({ rpc, store, chain, log: () => {} });
  return { store, research, hit };
}

const S_BORN = m.getSqrtRatioAtTick(-200000);
const S_SWAP1 = m.getSqrtRatioAtTick(-199000);
const S_SWAP2 = m.getSqrtRatioAtTick(-198000);

(async () => {
  console.log('\nHarga pool di blok kejadian (pool tanpa Swap)');

  await t('REGRESSION: pool born in the mint block, never swapped -> Initialize price', async () => {
    const { research, store } = world({ logs: [initLog(500_000, S_BORN)] });
    const s = await research.priceAt(POOL, 500_000);
    assert.strictEqual(s, S_BORN, 'mint price = the pool\'s birth price');
    const row = store.get('SELECT init_block, init_sqrt FROM pools WHERE pool_ref=?', POOL);
    assert.strictEqual(row.init_block, 500_000, 'birth price stored in the pools table');
    assert.strictEqual(row.init_sqrt, S_BORN.toString());
  });

  await t('same as an archive node that does not have the pool state at the previous block yet', async () => {
    const { research } = world({ logs: [initLog(500_000, S_BORN)], archived: true });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_BORN);
  });

  await t('a Swap after the event does not override the birth price if there was no Swap before', async () => {
    const { research } = world({ logs: [initLog(499_900, S_BORN), swapLog(500_050, S_SWAP1)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_BORN, 'up to block 500,000 the pool is still at its birth price');
  });

  await t('the LAST Swap before the event is used, not the nearest one after it', async () => {
    const { research } = world({ logs: [initLog(400_000, S_BORN), swapLog(499_990, S_SWAP1), swapLog(500_001, S_SWAP2)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_SWAP1);
  });

  await t('without a prior Swap and the pool born outside the window -> a later Swap becomes the estimate', async () => {
    const { research } = world({ logs: [initLog(10, S_BORN), swapLog(500_300, S_SWAP2)] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), S_SWAP2);
  });

  await t('nothing at all -> null, not cached', async () => {
    const { research, hit } = world({ logs: [] });
    assert.strictEqual(await research.priceAt(POOL, 500_000), null);
    const n = hit.logs;
    assert.strictEqual(await research.priceAt(POOL, 500_000), null);
    assert.ok(hit.logs > n, 'a failure is re-read, not remembered');
  });

  await t('birth price is read once per pool (the second event uses the stored one)', async () => {
    const { research, hit, store } = world({ logs: [initLog(500_000, S_BORN)] });
    await research.priceAt(POOL, 500_000);
    store.run('DELETE FROM wprices');   // force a recompute, but the pools table stays
    research.priceCache.clear();
    const n = hit.logs;
    await research.priceAt(POOL, 500_100);
    // only the Swap search (1 window: the pool was born inside it), without another Initialize search
    assert.strictEqual(hit.logs - n, 1, `getLogs dipanggil ${hit.logs - n}x, seharusnya 1`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
