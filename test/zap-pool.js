'use strict';
// Test the pool picker for direct swaps (src/swappool.js) — the auto-swap FALLBACK path,
// used when Kyber has no route.
//
// What is guarded here: the bot swaps in the most favourable pool for that pair
// (not just the pool of its position), a thin pool is rejected by the price impact limit, and
// a pool that refuses swaps is detected from the simulation — not from a reverted transaction.
//
// Run: node test/zap-pool.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { pickSwapPool } = require('../src/swappool');
const m = require('../src/v3math');

const USDG = '0x' + '11'.repeat(20);
const MEME = '0x' + '22'.repeat(20);
const ME = '0x' + '33'.repeat(20);
const ref = (n) => '0x' + String(n).repeat(64).slice(0, 64);
const SQRT = m.getSqrtRatioAtTick(0);          // price 1:1 in raw units
const LARGE = 10n ** 21n;                      // pool liquidity in
const THIN = 10n ** 15n;
const PAY = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// Test world: several v4 pools for the USDG/MEME pair, each with its own fee and
// liquidity. `reject` = the list of pools (by fee) that revert when the swap is
// simulated. `shape` = the v4 swap params shape that this fake router accepts —
// the other shape reverts WITHOUT data, exactly like the real router. `blind` = an RPC
// that does not answer (quota error), not a revert.
function world(pools, { reject = [], shape = 'limit', blind = false } = {}) {
  const store = new Store(':memory:');
  for (const p of pools) {
    store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,pool_addr,first_block)
      VALUES(?,?,?,?,?,?,?,?,?)`, p.ref, 'v4', USDG, MEME, p.fee, 60, p.hooks || '0x' + '0'.repeat(40), null, 1);
  }
  const byRef = new Map(pools.map((p) => [p.ref, p]));
  const built = [];
  const simulatedOk = [];
  const chain = {
    slot0V4Many: async (ids) => ids.map((id) => ({ sqrtPriceX96: byRef.get(id).sqrt ?? SQRT, tick: 0, lpFee: byRef.get(id).lpFee ?? 0 })),
    poolLiquidityMany: async (ids) => ids.map((id) => byRef.get(id).L),
  };
  let remembered = null;
  const exec = {
    address: () => ME,
    // A pool is recognised by its fee, the params shape by the last two digits of the calldata.
    buildSwapV4: (pk, zeroForOne, amountIn, minOut, deadline, layout) => {
      built.push({ pk, zeroForOne, amountIn, minOut, deadline, layout });
      return { to: '0x' + 'ab'.repeat(20), data: `0x${String(pk.fee).padStart(8, '0')}${layout === 'limit' ? '01' : '00'}`, value: '0' };
    },
    buildSwapV3: () => { throw new Error('tidak dipakai di uji ini'); },
    v4SwapLayouts: () => (remembered ? [remembered] : ['limit', 'plain']),
    rememberV4Layout: (l) => { if (l) remembered = l; },
    get layout() { return remembered; },
  };
  const rpc = {
    batch: async (calls) => calls.map((c) => {
      const [tx] = c.params;
      const fee = Number(tx.data.slice(2, 10));
      const layout = tx.data.slice(10) === '01' ? 'limit' : 'plain';
      simulatedOk.push({ fee, layout, from: tx.from });
      if (blind) return { error: { code: 429, message: 'Too Many Requests' }, transient: true };
      // A wrong params shape reverts without data — indistinguishable from a pool
      // that really refuses, except by trying the other shape.
      if (layout !== shape || reject.includes(fee)) return { error: { code: 3, message: 'execution reverted' } };
      return { result: '0x01' };
    }),
  };
  return { store, chain, exec, rpc, built, simulatedOk };
}

const call = (d, opts = {}) => pickSwapPool(d, {
  tokenIn: USDG, tokenOut: MEME, amountIn: PAY, minOut: 1n,
  maxImpactBps: 500, deadlineSec: 1234, ...opts,
});

(async () => {
  console.log('pemilih pool zap');

  await t('picks the lowest-fee pool when liquidity is the same', async () => {
    const d = world([
      { ref: ref(1), fee: 10000, L: LARGE },   // the position's pool: 1%
      { ref: ref(2), fee: 500, L: LARGE },     // 0.05% — the cheapest
      { ref: ref(3), fee: 3000, L: LARGE },
    ]);
    const info = {};
    const pick = await call(d, { info });
    assert.ok(pick, 'there must be a chosen pool');
    assert.equal(pick.pool.pool_ref, ref(2));
    assert.equal(pick.feePpm, 500);
    assert.equal(info.scored, 3);
  });

  await t('a deep pool beats a low-fee but thin pool', async () => {
    const d = world([
      { ref: ref(1), fee: 3000, L: LARGE },
      { ref: ref(2), fee: 500, L: PAY * 2n },   // small fee, but shallow
    ]);
    const pick = await call(d, { maxImpactBps: 0 });   // impact limit switched off
    assert.equal(pick.pool.pool_ref, ref(1));
  });

  await t('a thin pool is rejected by the price impact limit, not used', async () => {
    const d = world([{ ref: ref(1), fee: 500, L: THIN }]);
    const info = {};
    const pick = await call(d, { info });
    assert.equal(pick, null);
    assert.equal(info.tooDeep, 1);
    assert.match(info.reason, /dampak harga \d+ bps/);
  });

  await t('a pool that refuses swaps is filtered out by simulation; the next choice is used', async () => {
    const d = world([
      { ref: ref(1), fee: 500, L: LARGE },     // best on paper, but reverts
      { ref: ref(2), fee: 3000, L: LARGE },
    ], { reject: [500] });
    const pick = await call(d);
    assert.equal(pick.pool.pool_ref, ref(2));
    assert.equal(pick.rank, 1, 'used as the second choice');
    assert.equal(d.simulatedOk[0].from, ME, 'the simulation must be as the bot wallet — allowance & balance are read too');
  });

  await t('all pools refuse: null with a reason, not a reverting transaction', async () => {
    const d = world([
      { ref: ref(1), fee: 500, L: LARGE },
      { ref: ref(2), fee: 3000, L: LARGE },
    ], { reject: [500, 3000] });
    const info = {};
    const pick = await call(d, { info });
    assert.equal(pick, null);
    assert.match(info.reason, /menolak swap saat disimulasikan/);
  });

  await t('a pair without any pool at all', async () => {
    const d = world([]);
    const info = {};
    const pick = await call(d, { info });
    assert.equal(pick, null);
    assert.match(info.reason, /tidak ada pool/);
  });

  await t('the position\'s pool is also evaluated even though it is not yet recorded in the pools table', async () => {
    const d = world([{ ref: ref(1), fee: 10000, L: LARGE }]);
    // Pool #9 is only known to the caller (just created by the target, not in the DB yet).
    d.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: SQRT, tick: 0, lpFee: 0 }));
    d.chain.poolLiquidityMany = async (ids) => ids.map(() => LARGE);
    const pick = await call(d, {
      extra: [{ pool_ref: ref(9), venue: 'v4', token0: USDG, token1: MEME, fee: 100, tick_spacing: 1, hooks: null }],
    });
    assert.equal(pick.pool.pool_ref, ref(9), 'the 0.01% fee must beat 1%');
  });

  await t('the built poolKey uses the chosen pool\'s data', async () => {
    const d = world([{ ref: ref(1), fee: 3000, L: LARGE }]);
    await call(d);
    const b = d.built[0];
    assert.equal(b.pk.currency0, USDG);
    assert.equal(b.pk.currency1, MEME);
    assert.equal(b.pk.fee, 3000);
    assert.equal(b.pk.tickSpacing, 60);
    assert.equal(b.zeroForOne, true, 'paying with token0 = zeroForOne');
    assert.equal(b.amountIn, PAY);
    assert.equal(b.minOut, 1n, 'amountOutMinimum sungguhan ikut disimulasikan');
    assert.equal(b.deadline, 1234);
  });

  await t('the swap params shape the router accepts is found via simulation', async () => {
    // The router on Robinhood Chain uses the OLD shape (with sqrtPriceLimitX96); the new one
    // reverts without a message. Only one shape used to be sent, so this fallback
    // always ended in "all pools refuse the swap" — the zap was cancelled although the pool was healthy.
    const d = world([{ ref: ref(1), fee: 3000, L: LARGE }], { shape: 'limit' });
    const pick = await call(d);
    assert.ok(pick, 'the correct shape must be found');
    assert.equal(pick.pool.pool_ref, ref(1));
    assert.equal(d.exec.layout, 'limit', 'the shape that passed is remembered');
  });

  await t('a router with the new shape is also served', async () => {
    const d = world([{ ref: ref(1), fee: 3000, L: LARGE }], { shape: 'plain' });
    const pick = await call(d);
    assert.ok(pick, 'the new shape must be tried too');
    assert.equal(d.exec.layout, 'plain');
  });

  await t('a shape already proven is not tried twice again', async () => {
    const d = world([{ ref: ref(1), fee: 3000, L: LARGE }], { shape: 'plain' });
    await call(d);
    const round1 = d.simulatedOk.length;
    d.simulatedOk.length = 0;
    await call(d);
    assert.equal(round1, 2, 'the first round tries both shapes');
    assert.equal(d.simulatedOk.length, 1, 'the second round needs a single call');
  });

  await t('an RPC that does not answer is not "the pool refuses"', async () => {
    const d = world([{ ref: ref(1), fee: 3000, L: LARGE }], { blind: true });
    const info = {};
    const pick = await call(d, { info });
    assert.equal(pick, null);
    assert.match(info.reason, /tidak terjawab RPC/);
    assert.doesNotMatch(info.reason, /menolak swap/);
  });

  await t('dynamic fee is read from slot0, not from the fee column', async () => {
    // 0x800000 = dynamic fee marker; the fee field is not a magnitude.
    const d = world([
      { ref: ref(1), fee: 0x800000, L: LARGE, lpFee: 100 },   // actually 0.01%
      { ref: ref(2), fee: 3000, L: LARGE },
    ]);
    const pick = await call(d);
    assert.equal(pick.pool.pool_ref, ref(1));
    assert.equal(pick.feePpm, 100);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
