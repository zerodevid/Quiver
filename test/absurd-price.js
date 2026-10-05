'use strict';
// Test: an absurd pool price (passes priceUsable but is 1e9× the entry price) must not
// value a position/fee/leftover as "billions of dollars" on the dashboard.
//
// Run: node test/absurd-price.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
// pool token0 USDG(6) / token1 MEME(18); price = MEME per USDG
const sqrtOf = (memePerUsdg) => mm.getSqrtRatioAtTick(mm.priceToTick(memePerUsdg, 6, 18));

function world(st) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 })),
    slot0V4: async () => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 }),
    poolLiquidityMany: async (ids) => ids.map(() => 1n),
    poolLiquidity: async () => 1n,
    markSqrtForPair: async () => (st.refPrice == null ? null : { sqrtPriceX96: sqrtOf(st.refPrice), poolRef: '0xref' }),
    quoteSideOf: (t0) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote({ sqrtPriceX96, amount0, amount1 }) {
      const p = mm.priceFromSqrt(sqrtPriceX96, 6, 18);
      return { value: Number(amount0) / 1e6 + Number(amount1) / 1e18 / p, kind: 'usd' };
    },
  };
  const rpc = {
    ethCallMany: async (calls) => calls.map((c) => {
      if (c.to === ADDR.posmV4) return hex(st.liq);
      if (c.to === ADDR.poolManager) return hex(st.feeSlot ?? 0n);
      return hex(0n);
    }),
  };
  const logs = [];
  const positions = new Positions({ rpc, store, chain, log: (m) => logs.push(m) });
  store.setState('wallet_address', '0x' + '11'.repeat(20));
  // entered at a price of 1000 MEME/USDG, the whole $100 of capital on the MEME side (a single-sided position)
  // narrow range: 1000 → 1200 MEME/USDG (tick up = MEME per USDG up = MEME down)
  const tl = mm.priceToTick(1000, 6, 18) + 1, tu = mm.priceToTick(1200, 6, 18);
  const L = mm.liquidityForAmounts(sqrtOf(1000), mm.getSqrtRatioAtTick(tl), mm.getSqrtRatioAtTick(tu), 100_000_000n, 0n);
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,cost0,quote_symbol,liquidity,fees_quote,entry_sqrt,left_token,left_amount,left_quote)
    VALUES('v4',?,'77',?,?,?,?,?,?,100,'100000000','USDG',?,1.5,?,?,?,?)`,
  POOL, ADDR.usdg, MEME, tl, tu, st.status || 'open', Date.now(), L.toString(), sqrtOf(1000).toString(),
  st.left ? MEME : null, st.left ? (100_000n * 10n ** 18n).toString() : '0', st.left ? 100 : 0);
  st.liq = L;
  return { store, positions, st, logs, id: Number(r.lastInsertRowid) };
}

(async () => {
  console.log('absurd-price:');

  await t('sane pool price (inside the range): valued at the pool price', async () => {
    const d = world({ price: 1100 });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.markRef, null);
    assert.ok(p.valueUsd > 90 && p.valueUsd < 110, `value ${p.valueUsd}`);
  });

  await t('MEME 1e9× more expensive (thin pool): fee in MEME is valued at the range edge, not billions', async () => {
    // fee collected 1 MEME (= $0.001 at the entry price); the pool says MEME = $1,000,000
    const d = world({ price: 1e-6, feeSlot: 0n });
    d.positions.rpc.ethCallMany = async (calls) => calls.map((c, i) => {
      if (c.to === ADDR.posmV4) return hex(d.st.liq);
      if (c.to === ADDR.poolManager) return hex([0n, 0n, 0n, 0n, 0n, 0n, d.st.liq, 0n, 0n][i - 1] ?? 0n);
      return hex(0n);
    });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.markRef, 'edge');
    assert.ok(p.feeUsd < 1, `fee ${p.feeUsd}`);
    assert.ok(p.valueUsd < 150, `value ${p.valueUsd}`);
    assert.ok(d.logs.some((m) => /tepi rentang/.test(m)), 'dilaporkan');
    await d.positions.sync(2500);
    assert.strictEqual(d.logs.filter((m) => /tepi rentang/.test(m)).length, 1, 'dilaporkan sekali saja');
  });

  await t('absurd pool price but a sane reference pool: use the reference pool', async () => {
    const d = world({ price: 1e-6, refPrice: 1100 });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.markRef, '0xref');
  });

  await t('leftover 100,000 MEME while the pool is absurd: valued at the entry price ($100), not $1e11', async () => {
    const d = world({ price: 1e-6, left: true, status: 'closed' });
    const v = await d.positions.refreshLeftovers(2500, null);
    assert.ok(v.usd > 50 && v.usd < 200, `leftover $${v.usd}`);
  });

  await t('rug 1e6× (price collapsed): valued at the range edge — not negative/NaN', async () => {
    const d = world({ price: 1e9 });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.markRef, 'edge');
    assert.ok(Number.isFinite(p.valueUsd) && p.valueUsd >= 0);
  });

  // lp3 2026-09-19: a WIN/USDG ladder position placed below the market (entered at 2.2e-4,
  // range 3.5e-5..5.6e-5), WIN rugged 1e10×. The whole $110 USDG became 3.1m WIN which
  // valued at the entry price = $675 → the chart jumped a fake +$1,187. The lower range edge
  // (the last price that changes the composition) is the highest sensible value.
  await t('ladder position below the market, rugged token: valued at the lower edge (≈ capital), not the entry price (6× capital)', async () => {
    // price here = MEME per USDG; a ladder "below the market" = MEME cheaper = a bigger number
    const d = world({ price: 1000 });
    const tl = mm.priceToTick(4000, 6, 18), tu = mm.priceToTick(6000, 6, 18);
    // the whole $110 USDG (token0), waiting for the price to drop into the range
    const L = mm.liquidityForAmounts(sqrtOf(1000), mm.getSqrtRatioAtTick(tl), mm.getSqrtRatioAtTick(tu), 110_000_000n, 0n);
    d.store.run('UPDATE positions SET tick_lower=?, tick_upper=?, liquidity=?, cost_quote=110, cost0=? WHERE id=?', tl, tu, L.toString(), '110000000', d.id);
    d.st.liq = L;
    // rug: MEME drops 1e10× → tick far above the range, position 100% MEME, dead pool (active liquidity 0)
    d.st.price = 1000 * 1e10;
    d.positions.chain.poolLiquidityMany = async (ids) => ids.map(() => 0n);
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.markRef, 'edge');
    // at the lower edge: value ≈ capital (slightly below because of IL), not 110 × 6000/1000 ≈ $660 at the entry price
    assert.ok(p.valueUsd > 60 && p.valueUsd <= 111, `value ${p.valueUsd}`);
    assert.ok(p.pnlUsd <= 2, `pnl ${p.pnlUsd}`);
  });

  await t('fee 1e30 from a broken computation: use the last fee (1.5)', async () => {
    const d = world({ price: 1000, feeSlot: 10n ** 45n });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.feeUsd, 1.5);
    assert.strictEqual(d.store.get('SELECT fees_quote FROM positions WHERE id=?', d.id).fees_quote, 1.5);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
