'use strict';
// Simulation mode with a virtual balance (paper trading): a target entry opens a simulated
// position out of the virtual cash, a target exit closes it, fees follow the target, and the
// profit shows in cash and equity. The real Engine, Positions and PaperBook run; only the
// chain (pool price, token metadata) is faked.
//
// Run: node test/paper.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { ADDR } = require('../src/chain');
const { isSim } = require('../src/paper');
const m = require('../src/v3math');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const POOL = '0x' + 'ab'.repeat(32);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const USDG = ADDR.usdg;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAILED ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

// USDG (6 dec, token0, the quote asset) / MEME (18 dec, token1). Price moves by changing `pool.tick`.
function world({ balance = 1000, friction, sizing = {} } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'test', Date.now());
  const pool = { tick: 0 };
  const slot = () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(pool.tick), tick: pool.tick });
  const chain = {
    network: 'robinhood',
    valueInQuote: Chain.prototype.valueInQuote,
    tokens: async (a) => a.map((x) => ({ address: x, symbol: x === USDG ? 'USDG' : 'MEME', decimals: x === USDG ? 6 : 18 })),
    slot0V4: async () => slot(),
    slot0V4Many: async (ids) => ids.map(() => slot()),
    poolLiquidityMany: async (ids) => ids.map(() => 10n ** 18n),
    markSqrtForPair: async () => null,
    poolAgeMinutes: async () => 999,
  };
  const mode = { dry_run: true, sim_balance_usd: balance };
  if (friction != null) mode.sim_friction_pct = friction;
  const cfg = { mode, gas: {}, loop: {}, prices: { auto_eth_price: false }, rules: { sizing: { mode: 'fixed_quote', fixed_quote_usd: 200, ...sizing }, filters: { cooldown_seconds: 0 } } };
  const eng = new Engine({ rpc: { ethCallMany: async (c) => c.map(() => null), call: async () => null }, store, chain, cfg, log: () => {} });
  eng.notify = (msg, detail) => { eng.notes.push({ msg, detail }); };
  eng.notes = [];
  // Research stub: the "target's" fee state is whatever the test writes into wpositions.
  eng.paperResearch = () => ({ refreshOpen: async () => {} });
  // The target's liquidity AFTER its action (read from the chain): zero = it closed fully.
  eng.targetLiquidity = async () => ({ liquidity: eng.targetLiquidityLeft ?? 0n, atBlock: false });
  return { eng, store, pool, cfg };
}

let nextAct = 1;
function act(store, pool, over = {}) {
  const id = Number(store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind) VALUES(?,?,?,?,?,?,?)`,
    Date.now(), 1000, '0x' + nextAct++, 1, TARGET, 'v4', over.kind || 'increase').lastInsertRowid);
  return {
    id, ts: Date.now(), block: 1000, txHash: '0x' + id, logIndex: 1, target: TARGET, venue: 'v4', kind: 'increase',
    tokenId: '42', poolRef: POOL, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
    token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native, tickLower: -6000, tickUpper: 6000,
    liquidity: '1000000000000', amount0: '0', amount1: '0', valueQuote: 5000, quoteSymbol: 'USDG',
    slot0: { sqrtPriceX96: m.getSqrtRatioAtTick(pool.tick), tick: pool.tick }, ...over,
  };
}
const decision = (store, id) => store.get('SELECT verdict, reason, position_id FROM decisions WHERE action_id=? ORDER BY id DESC LIMIT 1', id);
const simRow = (store) => store.get("SELECT * FROM positions WHERE token_id LIKE 'sim:%' ORDER BY id DESC LIMIT 1");

async function open(w, over) {
  const a = act(w.store, w.pool, over);
  await w.eng.handle(a);
  return { a, d: decision(w.store, a.id) };
}
// What the target position "earns": the fee row the research would have written.
function targetFees(store, feeUsd, valueUsd = 5000, status = 'open') {
  store.run('DELETE FROM wpositions');
  store.run(`INSERT INTO wpositions(chain,wallet,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,live_value_q,live_fee_q,status,quote_symbol)
    VALUES('robinhood',?,'v4','42',?,?,?,-6000,6000,'1000000000000',?,?,?,'USDG')`, TARGET, POOL, USDG, MEME, valueUsd, feeUsd, status);
}

(async () => {
  console.log('Simulation mode with a virtual balance:\n');

  await t('a target entry opens a simulated position from the virtual cash (nothing is sent)', async () => {
    const w = world();
    assert.ok(w.eng.paper.on());
    const { d } = await open(w);
    assert.strictEqual(d.verdict, 'copy');
    assert.match(d.reason, /\[simulasi\]/);
    const r = simRow(w.store);
    assert.ok(isSim(r));
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.target, TARGET);
    assert.strictEqual(r.mirror_of, '42');
    near(r.cost_quote, 200 * 1.003, 0.5, 'cost = $200 plus friction');
    near(w.eng.paper.cashUsd(), 1000 - r.cost_quote, 1e-6, 'cash');
    assert.strictEqual(w.eng.notes.at(-1).detail.simulated, true);
  });

  await t('the position sync values it at the pool price from the books (no chain read)', async () => {
    const w = world();
    await open(w);
    const live = await w.eng.positions.sync(w.eng.ethUsd);
    assert.strictEqual(live.length, 1);
    near(live[0].valueUsd, 200, 1, 'value at the entry price');
    assert.strictEqual(live[0].empty, false);
    const sum = w.eng.positions.summary(w.eng.ethUsd);
    assert.strictEqual(sum.openCount, 1);
    near(sum.exposureUsd, 200, 1, 'exposure');
  });

  await t('a target exit closes the simulated position and returns cash at the same price minus friction', async () => {
    const w = world({ friction: 0.3 });
    await open(w);
    await w.eng.positions.sync(w.eng.ethUsd);
    const ex = act(w.store, w.pool, { kind: 'decrease', liquidity: '-1000000000000', liquidityBefore: 1000000000000n });
    await w.eng.handle(ex);
    const d = decision(w.store, ex.id);
    assert.strictEqual(d.verdict, 'copy', d.reason);
    const r = w.store.get("SELECT * FROM positions WHERE token_id LIKE 'sim:%'");
    assert.strictEqual(r.status, 'closed');
    near(r.out_quote, 200 * 0.997, 0.5, 'proceeds');
    near(w.eng.paper.cashUsd(), 1000 - 200 * 0.006, 0.5, 'cash after a round trip = balance − 2 × friction');
  });

  await t('profit: the memecoin gains value while we hold it → closing returns more than was put in', async () => {
    const w = world({ friction: 0 });
    await open(w);
    w.pool.tick = -3000;                      // MEME gets pricier against USDG; still inside the range
    const live = (await w.eng.positions.sync(w.eng.ethUsd))[0];
    assert.ok(live.valueUsd > 200 + 1, `value ${live.valueUsd} follows the price up`);
    assert.ok(live.pnlUsd > 1);
    const ex = act(w.store, w.pool, { kind: 'decrease', liquidity: '-1000000000000', liquidityBefore: 1000000000000n });
    await w.eng.handle(ex);
    const r = w.store.get("SELECT * FROM positions WHERE token_id LIKE 'sim:%'");
    assert.strictEqual(r.status, 'closed');
    assert.ok(r.out_quote > r.cost_quote);
    assert.ok(w.eng.paper.cashUsd() > 1000, 'cash above the starting balance');
    near(w.eng.paper.cashUsd(), 1000 - r.cost_quote + r.out_quote, 0.01, 'cash = balance − cost + proceeds');
    near(w.eng.paper.status().pnlUsd, r.out_quote - r.cost_quote, 0.01, 'status pnl');
  });

  await t('price moves against us → closing returns less (the simulation shows losses too)', async () => {
    const w = world({ friction: 0 });
    await open(w);
    w.pool.tick = 3000;
    await w.eng.positions.sync(w.eng.ethUsd);
    const ex = act(w.store, w.pool, { kind: 'decrease', liquidity: '-1000000000000', liquidityBefore: 1000000000000n });
    await w.eng.handle(ex);
    const r = w.store.get("SELECT * FROM positions WHERE token_id LIKE 'sim:%'");
    assert.ok(r.out_quote < r.cost_quote);
    assert.ok(w.eng.paper.status().pnlUsd < 0);
  });

  await t('fees follow the target: our share of its fee growth, only while we are in range', async () => {
    const w = world({ friction: 0 });
    await open(w);
    const row = () => simRow(w.store);
    targetFees(w.store, 10);                  // baseline: target already has $10 pending
    await w.eng.paper.accrue();
    assert.strictEqual(JSON.parse(row().ext).sim.fq, 0);
    targetFees(w.store, 60);                  // the target earns $50 more on a $5000 position; we hold $200 = 4%
    await w.eng.paper.accrue();
    near(JSON.parse(row().ext).sim.fq, 2, 0.05, 'fee = 50 × 200/5000');
    // Pending falls to 5 (a claim, or just the token price dropping): nothing is added, the baseline follows.
    targetFees(w.store, 5);
    await w.eng.paper.accrue();
    near(JSON.parse(row().ext).sim.fq, 2, 0.05, 'a fall adds nothing');
    // It oscillates back up to 60: only the growth from 5 counts once, not 60 again.
    targetFees(w.store, 25);
    await w.eng.paper.accrue();
    near(JSON.parse(row().ext).sim.fq, 2.8, 0.05, 'growth after the fall: 20 × 4%');
    targetFees(w.store, 5);
    await w.eng.paper.accrue();
    targetFees(w.store, 25);
    await w.eng.paper.accrue();
    near(JSON.parse(row().ext).sim.fq, 3.6, 0.05, 'jitter does not re-add the whole pending fee');
    // Out of range: no fee even though the target earns.
    w.pool.tick = 9000;
    targetFees(w.store, 105);
    await w.eng.paper.accrue();
    near(JSON.parse(row().ext).sim.fq, 3.6, 0.05, 'out of range accrues nothing');
  });

  await t('fees show in the position sync, and come back at close', async () => {
    const w = world({ friction: 0 });
    await open(w);
    targetFees(w.store, 0);
    await w.eng.paper.accrue();
    targetFees(w.store, 500);                 // $500 on a $5000 target position → our 4% = $20
    await w.eng.paper.accrue();
    const live = (await w.eng.positions.sync(w.eng.ethUsd))[0];
    near(live.feeUsd, 20, 0.5, 'fee in the sync');
    near(live.pnlUsd, 20, 0.5, 'pnl = fee');
    const ex = act(w.store, w.pool, { kind: 'decrease', liquidity: '-1000000000000', liquidityBefore: 1000000000000n });
    await w.eng.handle(ex);
    near(w.eng.paper.cashUsd(), 1020, 0.5, 'cash = balance + fee');
    const st = w.eng.paper.status();
    near(st.pnlUsd, 20, 0.5, 'status pnl');
    assert.strictEqual(st.closedCount, 1);
    assert.strictEqual(st.wins, 1);
  });

  await t('a partial target withdrawal withdraws the same share, and the rest stays open', async () => {
    const w = world({ friction: 0 });
    await open(w);
    w.eng.targetLiquidityLeft = 600000000000n;
    const before = BigInt(simRow(w.store).liquidity);
    const ex = act(w.store, w.pool, { kind: 'decrease', liquidity: '-400000000000', liquidityBefore: 1000000000000n });
    await w.eng.handle(ex);
    assert.strictEqual(decision(w.store, ex.id).verdict, 'copy');
    const r = simRow(w.store);
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(BigInt(r.liquidity), before - (before * 400n) / 1000n);
    near(r.out_quote, 80, 0.5, 'withdrawn 40% of $200');
    near(w.eng.paper.cashUsd(), 1000 - 200 + r.out_quote, 0.01, 'cash');
  });

  await t('the virtual cash limits the size: a $200 entry becomes what is left', async () => {
    const w = world({ balance: 120, friction: 0 });
    const { d } = await open(w);
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.match(d.reason, /kas tersedia/);
    assert.ok(simRow(w.store).cost_quote <= 120.01);
    assert.ok(w.eng.paper.cashUsd() >= 0);
  });

  await t('an addition by the target adds to the existing simulated mirror, not a second position', async () => {
    const w = world({ friction: 0, sizing: { max_quote_per_position_usd: 1000 } });
    await open(w);
    await open(w);
    const rows = w.store.all("SELECT * FROM positions WHERE token_id LIKE 'sim:%'");
    assert.strictEqual(rows.length, 1);
    near(rows[0].cost_quote, 400, 1, 'capital added, not overwritten');
  });

  await t('equity snapshot uses the virtual cash: total = cash + positions, PnL from the books', async () => {
    const w = world({ friction: 0 });
    await open(w);
    await w.eng.positions.sync(w.eng.ethUsd);
    await w.eng.snapshotEquity();
    const e = w.store.get('SELECT * FROM equity ORDER BY ts DESC LIMIT 1');
    near(e.wallet_quote, 800, 0.5, 'cash');
    near(e.total_quote, 1000, 1, 'total');
    near(e.pnl_quote, 0, 1, 'pnl');
  });

  await t('the dashboard cash is the virtual one (freshCash), also without a wallet', async () => {
    const w = world();
    await open(w);
    const c = await w.eng.freshCash();
    near(c.usd, w.eng.paper.cashUsd(), 1e-9, 'freshCash');
  });

  await t('without a balance the old simulation stays: decision "dry", nothing booked', async () => {
    const w = world({ balance: 0 });
    assert.ok(!w.eng.paper.on());
    const { d } = await open(w);
    assert.strictEqual(d.verdict, 'dry');
    assert.strictEqual(w.store.all('SELECT * FROM positions').length, 0);
  });

  await t('LIVE mode never books simulated positions', async () => {
    const w = world();
    w.cfg.mode.dry_run = false;
    assert.ok(!w.eng.paper.on());
  });

  await t('leaving simulation retires its positions: they vanish from open/closed, cash is the full balance again', async () => {
    const w = world();
    await open(w);
    assert.strictEqual(w.eng.positions.open().length, 1);
    const n = w.eng.paper.retire();
    assert.strictEqual(n, 1);
    assert.strictEqual(w.eng.positions.open().length, 0);
    near(w.eng.paper.cashUsd(), 1000, 1e-9, 'cash');
    assert.strictEqual(w.store.get("SELECT status FROM positions WHERE token_id LIKE 'sim:%'").status, 'sim');
  });

  await t('reset starts over and only removes the equity points of this simulation', async () => {
    const w = world({ friction: 0 });
    w.store.run('INSERT INTO equity(chain,ts,total_quote) VALUES(?,?,?)', 'robinhood', Date.now() - 86400_000, 777);   // real history
    w.eng.paper.ensureSince();
    await open(w);
    await w.eng.positions.sync(w.eng.ethUsd);
    await w.eng.snapshotEquity();
    assert.strictEqual(w.store.all('SELECT * FROM equity').length, 2);
    w.eng.paper.reset();
    const left = w.store.all('SELECT total_quote FROM equity');
    assert.deepStrictEqual(left.map((x) => x.total_quote), [777]);
    near(w.eng.paper.cashUsd(), 1000, 1e-9, 'cash back to the balance');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
