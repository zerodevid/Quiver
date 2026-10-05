'use strict';
// Test the bot's leftover memecoin from a position: from "valued at the close price" to "actual sale
// proceeds", and its valuation in equity while unsold.
//
// Real case: position #9 (copy DRIPPYPIGEON $200) closed -> 58.66 USDG + 688k DRIPPY.
// The DB recorded out_quote $148 (DRIPPY at the close price) -> "loss $52". Two minutes later
// the DRIPPY was sold manually for ETH worth $156.89 -> actually a $15 PROFIT. And during those
// two minutes the total chart plunged $150 because the DRIPPY was not counted at all.
//
// Run: node test/leftover.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const W = '0x' + '11'.repeat(20);
const ETH = 2500;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);
const E18 = 10n ** 18n;
// pool token0 USDG(6) / token1 MEME(18): 1 MEME = 0.001 USDG
const sqrtOf = (memePerUsdg) => mm.getSqrtRatioAtTick(mm.priceToTick(memePerUsdg, 6, 18));

function world({ price = 1000, balance = null, poolLiq = 1n, refPrice = null } = {}) {
  const store = new Store(':memory:');
  const st = { price, balance, poolLiq, refPrice };
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4: async () => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 }),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 })),
    // the pool's active liquidity & a reference price from another pool — used when the position's pool
    // is already empty and its price is unfit for valuation
    poolLiquidity: async () => st.poolLiq,
    poolLiquidityMany: async (ids) => ids.map(() => st.poolLiq),
    markSqrtForPair: async () => (st.refPrice == null ? null : { sqrtPriceX96: sqrtOf(st.refPrice), poolRef: '0xref' }),
    quoteSideOf: (t0, t1) => {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' }, [ADDR.weth]: { symbol: 'WETH', decimals: 18, kind: 'eth' } };
      if (q[t0]) return { side: 0, ...q[t0] };
      if (q[t1]) return { side: 1, ...q[t1] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      const p = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p : a1 + a0 * p, kind: q.kind };
    },
  };
  const rpc = { ethCallMany: async (calls) => calls.map(() => (st.balance == null ? '0x' : '0x' + st.balance.toString(16).padStart(64, '0'))) };
  const positions = new Positions({ rpc, store, chain, log: () => {} });
  return { store, positions, st };
}

// $200 position -> exits 60 USDG + 700,000 MEME (close price 0.0002 USDG -> $140); total out 200
function closing(d, id = null, { meme = 700_000n * E18, memeQuote = 140, usdg = 60 } = {}) {
  const r = d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,cost_quote,quote_symbol)
    VALUES('v4',?,?,?,'open',?,200,'USDG')`, POOL, ADDR.usdg, MEME, Date.now());
  const pid = id ?? Number(r.lastInsertRowid);
  d.positions.markClosed(pid, { out0: usdg * 1e6, out1: meme, outQuote: usdg + memeQuote, txHash: '0x1', exitSqrt: null,
    left: { token: MEME, amount: meme, quote: memeQuote } });
  return pid;
}
const row = (d, id) => d.store.get('SELECT * FROM positions WHERE id=?', id);

(async () => {
  await t('close snapshot is fixed, the swap stores the position allocation and the actual result', () => {
    const d = world();
    d.store.run("INSERT INTO txs(hash,detail) VALUES('0x1','{}'),('0xsale','{}')");
    const id = closing(d);
    d.positions.recordLeftoverSale({ txHash: '0xsale', token: MEME, amount: 700_000n * E18, quoteToken: ADDR.usdg,
      amountOut: 156_890_000n, usdOut: 150, ethUsd: ETH });
    const close = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0x1'").detail).closeProceeds;
    const sales = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0xsale'").detail).positionSales;
    assert.equal(close.quote, 200); assert.equal(sales[0].position, id);
    near(sales[0].gotQuote, 156.89, 'hasil aktual'); assert.equal(sales[0].closeQuote, 140);
  });

  await t('close: leftover memecoin recorded, out_quote contains the close price estimate', async () => {
    const d = world();
    const id = closing(d);
    const r = row(d, id);
    assert.strictEqual(r.left_token, MEME);
    assert.strictEqual(r.left_amount, (700_000n * E18).toString());
    assert.strictEqual(r.left_quote, 140);
    assert.strictEqual(r.out_quote, 200);
  });

  await t('leftover sold automatically to USDG: out_quote = USDG + actual sale proceeds', async () => {
    const d = world();
    const id = closing(d);
    // Kyber sells 700,000 MEME and the wallet receives 156.89 USDG
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 700_000n * E18, quoteToken: ADDR.usdg, amountOut: 156_890_000n, usdOut: 150, ethUsd: ETH });
    const r = row(d, id);
    near(r.out_quote, 60 + 156.89, 'out_quote');
    assert.strictEqual(r.left_amount, '0');
    near(r.left_quote, 0, 'left_quote');
    near(r.out_quote - r.cost_quote, 16.89, 'pnl');
  });

  await t('leftover sold to native ETH: proceeds valued via the ETH price', async () => {
    const d = world();
    const id = closing(d);
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 700_000n * E18, quoteToken: ADDR.native, amountOut: 6n * 10n ** 16n, usdOut: null, ethUsd: ETH });
    near(row(d, id).out_quote, 60 + 0.06 * ETH, 'out_quote');
  });

  await t('a manual swap without knowing its position: FIFO to the oldest position first', async () => {
    const d = world();
    const a = closing(d), b = closing(d);
    d.store.run('UPDATE positions SET closed_ts=closed_ts-1000 WHERE id=?', a);
    // sell 1,000,000 of 1,400,000: 700,000 belongs to #a, 300,000 to #b, receives 200 USDG
    d.positions.recordLeftoverSale({ token: MEME, amount: 1_000_000n * E18, quoteToken: ADDR.usdg, amountOut: 200_000_000n, ethUsd: ETH });
    const ra = row(d, a), rb = row(d, b);
    assert.strictEqual(ra.left_amount, '0');
    near(ra.out_quote, 60 + 140, 'a: 700/1000 × 200 = 140');
    assert.strictEqual(rb.left_amount, (400_000n * E18).toString());
    near(rb.out_quote, 200 - 60 + 60, 'b: 140 - 60 taksiran + 60 hasil');
    near(rb.left_quote, 80, 'b: sisa taksiran 4/7 × 140');
  });

  await t('a sale bigger than the recorded leftover: only the leftover part is allocated', async () => {
    const d = world();
    const id = closing(d);
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 900_000n * E18, quoteToken: ADDR.usdg, amountOut: 90_000_000n, ethUsd: ETH });
    // 700/900 × 90 = 70 replaces the 140 estimate
    near(row(d, id).out_quote, 60 + 70, 'out_quote');
  });

  await t('not yet sold: equity values the leftover at the current pool price, the difference becomes uPnL', async () => {
    const d = world({ price: 2000 });   // 1 MEME = 0.0005 USDG -> 700,000 MEME = $350
    closing(d);
    await d.positions.refreshLeftovers(ETH, W);
    const s = d.positions.summary(ETH);
    near(s.leftoverUsd, 350, 'leftoverUsd');
    near(s.leftoverCloseUsd, 140, 'closeUsd');
    near(s.unrealizedUsd, 210, 'uPnL = 350 - 140');
    near(s.realizedUsd, 0, 'realized dari out_quote 200 - 200');
  });

  await t('pool price unreadable: the close value is used, not zero', async () => {
    const d = world();
    closing(d);
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => null);
    await d.positions.refreshLeftovers(ETH, W);
    near(d.positions.summary(ETH).leftoverUsd, 140, 'leftoverUsd');
  });

  // Real case: the Maple/USDG 3.9% pool was swept empty (liquidity 0, tick 887271 =
  // the maximum). Pool price = 1e17× the fair price; 154 Maple of fee valued at "$4e52".
  await t('empty pool, price at the maximum tick: the leftover is valued via a reference pool, not the pool price', async () => {
    const d = world({ price: 1e-30, poolLiq: 0n, refPrice: 2000 });   // the pool itself: 1 MEME = 1e30 USDG
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(1e-30), tick: 887271 }));
    closing(d);
    await d.positions.refreshLeftovers(ETH, W);
    near(d.positions.summary(ETH).leftoverUsd, 350, 'acuan 0,0005 USDG × 700.000');
  });

  await t('empty pool without a reference pool: the position\'s entry price is used; even without that it does not blow up', async () => {
    const d = world({ price: 1e-30, poolLiq: 0n });
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(1e-30), tick: 887271 }));
    const id = closing(d);
    d.store.run('UPDATE positions SET entry_sqrt=? WHERE id=?', sqrtOf(1000).toString(), id);
    await d.positions.refreshLeftovers(ETH, W);
    near(d.positions.summary(ETH).leftoverUsd, 700, 'harga masuk 0,001 × 700.000');
  });

  await t('empty pool without an entry price or reference pool: the price is clamped to the position\'s range edge', async () => {
    const d = world({ price: 1e-30, poolLiq: 0n });
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(1e-30), tick: 887271 }));
    const id = closing(d);
    // range 1000 … ~2700 MEME/USDG; the pool price (1e-30) is below it → lower edge = 1000
    const lo = mm.priceToTick(1000, 6, 18);
    d.store.run('UPDATE positions SET tick_lower=?, tick_upper=? WHERE id=?', lo, lo + 10000, id);
    await d.positions.refreshLeftovers(ETH, W);
    near(d.positions.summary(ETH).leftoverUsd, 700, 'tepi bawah 0,001 × 700.000');
  });

  await t('empty pool, exit price at the tick bound: the exit price is clamped to the edge, not used raw', async () => {
    const d = world({ price: 1e-30, poolLiq: 0n });
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(1e-30), tick: 887271 }));
    const id = closing(d);
    const lo = mm.priceToTick(1000, 6, 18);
    d.store.run('UPDATE positions SET tick_lower=?, tick_upper=?, exit_sqrt=? WHERE id=?', lo, lo + 10000, sqrtOf(1e-30).toString(), id);
    await d.positions.refreshLeftovers(ETH, W);
    near(d.positions.summary(ETH).leftoverUsd, 700, 'tepi bawah 0,001 × 700.000');
  });

  await t('token vanished from the wallet (sold outside the bot): considered sold at the current price', async () => {
    const d = world({ price: 1000, balance: 200_000n * E18 });   // 200,000 of 700,000 remain
    const id = closing(d);
    await d.positions.refreshLeftovers(ETH, W);
    const r = row(d, id);
    assert.strictEqual(r.left_amount, (200_000n * E18).toString());
    // 500,000 MEME @ 0.001 = $500 replaces the 5/7 × 140 = 100 estimate
    near(r.out_quote, 200 - 100 + 500, 'out_quote');
    near(d.positions.summary(ETH).leftoverUsd, 200, 'sisa 200.000 @ 0,001');
  });

  await t('without leftover: the summary does not change', async () => {
    const d = world();
    await d.positions.refreshLeftovers(ETH, W);
    const s = d.positions.summary(ETH);
    assert.strictEqual(s.leftoverUsd, 0);
    assert.strictEqual(s.unrealizedUsd, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
