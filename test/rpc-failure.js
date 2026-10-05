'use strict';
// Test: a FAILED eth_call must not be read as zero.
//
// Real case: an RPC endpoint broke briefly (12 Sep 16:56). getPositionLiquidity #45
// failed -> read as 0 -> "liquidity is already zero on chain" -> closed in the DB with a result of
// $0, while on chain the full $110 was still there. In the same sync the fee slot failed -> 0 ->
// sub() wrapped mod 2^256 -> a fee of 5.7e47 went into equity.
//
// Run: node test/rpc-failure.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');
const { unclaimedV4 } = require('../src/fees');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const E18 = 10n ** 18n;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const sqrt = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));

// st.liq: getPositionLiquidity's answer (null = RPC error); st.feeOk: was the fee slot read?
function world(st) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrt, tick: 0 })),
    poolLiquidityMany: async (ids) => ids.map(() => 1n),
    markSqrtForPair: async () => null,
    quoteSideOf: (t0) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 / 1000, kind: 'usd' }),
  };
  const rpc = {
    ethCallMany: async (calls) => calls.map((c) => {
      if (c.to === ADDR.posmV4) return st.liq == null ? null : hex(st.liq);
      if (c.to === ADDR.poolManager) return st.feeOk ? hex(0n) : null;
      return hex(0n);
    }),
  };
  const positions = new Positions({ rpc, store, chain, log: () => {} });
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,quote_symbol,liquidity,fees_quote)
    VALUES('v4',?,'77',?,?,-100,100,'open',?,110,'USDG','5000000',1.5)`, POOL, ADDR.usdg, MEME, st.openedTs ?? Date.now() - 3600_000);
  return { store, positions, id: Number(r.lastInsertRowid), st };
}

(async () => {
  console.log('rpc-failure:');

  await t('liquidity failed to read: use the stored figure, NOT taken as empty', async () => {
    const d = world({ liq: null, feeOk: true });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.empty, false);
    assert.strictEqual(p.liqStale, true);
    assert.strictEqual(p.liquidity, '5000000');
    assert.strictEqual(d.positions.exitTriggers({ exit: {} }).length, 0, 'must not trigger an exit');
    assert.strictEqual(d.store.get('SELECT status, liquidity FROM positions WHERE id=?', d.id).liquidity, '5000000');
  });

  await t('liquidity really zero from the chain: empty', async () => {
    const d = world({ liq: 0n, feeOk: true });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.empty, true);
    assert.strictEqual(await d.positions.confirmEmpty(p), true);
  });

  await t('a NEW position read as zero by a lagging node: not confirmed empty without the mint receipt on the same node', async () => {
    const d = world({ liq: 0n, feeOk: true, openedTs: Date.now() - 60_000 });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.empty, true);
    // without tx_open (cannot be proven): not confirmed
    assert.strictEqual(await d.positions.confirmEmpty(p), false);
    const withTx = { ...p, tx_open: '0xm1' };
    // the node does not have the mint receipt yet → its zero answer is not trusted
    d.positions.rpc.batch = async (calls) => calls.map((c) => (c.method === 'eth_call' ? { result: hex(0n) } : { result: null }));
    assert.strictEqual(await d.positions.confirmEmpty(withTx), false);
    // the same node shows the mint receipt AND zero liquidity → truly empty
    d.positions.rpc.batch = async (calls) => calls.map((c) => (c.method === 'eth_call' ? { result: hex(0n) } : { result: { status: '0x1' } }));
    assert.strictEqual(await d.positions.confirmEmpty(withTx), true);
    d.positions.rpc.batch = async (calls) => calls.map((c) => (c.method === 'eth_call' ? { result: hex(5n) } : { result: { status: '0x1' } }));
    assert.strictEqual(await d.positions.confirmEmpty(withTx), false);
  });

  await t('a NEW position read as zero: value NOT $0, stored liquidity not overwritten with zero', async () => {
    const d = world({ liq: 0n, feeOk: true, openedTs: Date.now() - 60_000 });
    const [p] = await d.positions.sync(2500);
    // `empty` still follows the chain (confirmEmpty decides), only the value is non-zero
    assert.strictEqual(p.empty, true);
    assert.ok(p.valueUsd > 0, String(p.valueUsd));
    assert.strictEqual(d.store.get('SELECT liquidity FROM positions WHERE id=?', d.id).liquidity, '5000000');
    // next sync to a healthy node: normal figures return
    d.st.liq = 5000000n;
    const [p2] = await d.positions.sync(2500);
    assert.strictEqual(p2.empty, false);
    assert.strictEqual(p2.valueUsd, p.valueUsd);
    // an old position (> 15 minutes) that reads zero: its value really is zero
    d.store.run('UPDATE positions SET opened_ts=? WHERE id=?', Date.now() - 3600_000, d.id);
    d.st.liq = 0n;
    const [p3] = await d.positions.sync(2500);
    assert.strictEqual(p3.valueUsd, 0);
  });

  await t('pool price unreadable: value does NOT become $0 and the stop loss does not trigger', async () => {
    const d = world({ liq: 5000000n, feeOk: true });
    const [p1] = await d.positions.sync(2500);
    assert.strictEqual(p1.valueStale, false);
    const good = p1.valueUsd;
    const SL = { exit: { stop_loss_pct: 5, take_profit_pct: 0, max_age_hours: 0, out_of_range_minutes: 0 } };
    // (fixture: small position vs $110 capital → PnL reads genuinely negative → a legitimate stop loss)
    assert.strictEqual(d.positions.exitTriggers(SL).length, 1);
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => null);
    const [p2] = await d.positions.sync(2500);
    assert.strictEqual(p2.valueStale, true);
    assert.strictEqual(p2.valueUsd, good, 'the last value is used');
    assert.strictEqual(p2.pnlPct, p1.pnlPct, 'PnL does not change because the price is unreadable');
    assert.strictEqual(d.positions.exitTriggers(SL).length, 0, 'a stale figure does not trigger an exit');
    // without history (first sync failed to read the price): value = capital − withdrawn, not 0
    d.positions.live = [];
    const [p3] = await d.positions.sync(2500);
    assert.ok(Math.abs(p3.valueUsd - 110) < 1e-9, String(p3.valueUsd));
  });

  await t('confirmEmpty: failing to read = not confirmed', async () => {
    const d = world({ liq: 0n, feeOk: true });
    const [p] = await d.positions.sync(2500);
    d.st.liq = null;
    assert.strictEqual(await d.positions.confirmEmpty(p), false);
    d.st.liq = 5000000n;
    assert.strictEqual(await d.positions.confirmEmpty(p), false);
  });

  await t('fee slot failed to read: unclaimedV4 -> unknown, not 10^47', async () => {
    const rpc = { ethCallMany: async (calls) => calls.map((_, i) => (i === 3 ? null : hex(7n))) };
    const [f] = await unclaimedV4(rpc, [{ poolId: POOL, tickLower: -100, tickUpper: 100, tokenId: '77' }], new Map([[POOL, 0]]));
    assert.strictEqual(f.unknown, true);
    assert.strictEqual(f.fee0, 0n); assert.strictEqual(f.fee1, 0n);
  });

  await t('fee failed to read during sync: the last fees_quote is kept', async () => {
    const d = world({ liq: 5000000n, feeOk: false });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.feeUsd, 1.5);
    assert.ok(p.feeUsd < 1e6, `fee sampah: ${p.feeUsd}`);
    assert.strictEqual(d.store.get('SELECT fees_quote FROM positions WHERE id=?', d.id).fees_quote, 1.5);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
