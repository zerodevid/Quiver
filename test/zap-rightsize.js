'use strict';
// Test: a zap payment accounts for the price move the zap itself causes in a thin, narrow-range pool.
// Real case (DTF, 15 Oct 2026): a $92 LP in a 200-tick range; the spot-sized payment ($77) bought
// 114k DTF, but after the zap moved the pool the mint needed only 72k - $27 of DTF was left over.
// Run: node test/zap-rightsize.js
const assert = require('node:assert');
const m = require('../src/v3math');
const { Engine } = require('../src/engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

const sa = m.getSqrtRatioAtTick(-349800), sb = m.getSqrtRatioAtTick(-349600);
const sqrtP = m.getSqrtRatioAtTick(-349770);
const desiredL = 363684242230775293n;
const poolL = 2n * 10n ** 17n;
const need0Now = m.amountsForLiquidity(sqrtP, sa, sb, desiredL).amount0;
const priceRaw = (Number(sqrtP) / Number(m.Q96)) ** 2;     // USDG raw per DTF raw
const payNaive = BigInt(Math.ceil(Number(need0Now) * priceRaw * 1.015));
const rate = 0.99 / priceRaw;                               // DTF raw bought per USDG raw (1% fee)

function eng({ quote = { amountOut: BigInt(Math.floor(Number(payNaive) * rate)) }, liq = poolL } = {}) {
  const e = Object.create(Engine.prototype);
  e.swapRouter = { quote: async () => quote };
  e.positions = { poolLiquidityOf: async () => liq };
  e.log = () => {};
  return e;
}
const args = { plan: { venue: 'v4', poolRef: '0x1' }, sqrtP, sa, sb, desiredL, idx: 0, have: 0n };
// Tokens left over once `pay` has been spent, using the same constant-liquidity model.
const leftover = (pay) => {
  const after = m.sqrtAfterSwap(sqrtP, poolL, pay, false);
  const bought = BigInt(Math.floor(Number(pay) * rate));
  const need = m.amountsForLiquidity(after, sa, sb, desiredL).amount0;
  return bought > need ? bought - need : 0n;
};

(async () => {
  await t('the naive payment overshoots in this pool (the bug)', async () => {
    assert.ok(Number(leftover(payNaive)) > 0.15 * Number(need0Now), `leftover ${leftover(payNaive)} of ${need0Now}`);
  });
  await t('the right-sized payment is smaller and leaves almost nothing', async () => {
    const pay = await eng().rightSizeZap('a', 'b', payNaive, args);
    assert.ok(pay < payNaive, 'payment not reduced');
    assert.ok(Number(leftover(pay)) < 0.03 * Number(need0Now), `leftover ${leftover(pay)} of ${need0Now}`);
  });
  await t('the right-sized payment still buys at least ~95% of the need', async () => {
    const pay = await eng().rightSizeZap('a', 'b', payNaive, args);
    const after = m.sqrtAfterSwap(sqrtP, poolL, pay, false);
    const need = m.amountsForLiquidity(after, sa, sb, desiredL).amount0;
    assert.ok(Number(pay) * rate >= 0.95 * Number(need), 'bought too little');
  });
  await t('a deep pool (tiny own impact) keeps the payment', async () => {
    assert.strictEqual(await eng({ liq: 10n ** 24n }).rightSizeZap('a', 'b', payNaive, args), payNaive);
  });
  await t('an empty first quote is retried once before giving up', async () => {
    const e = eng();
    let calls = 0;
    const good = { amountOut: BigInt(Math.floor(Number(payNaive) * rate)) };
    e.swapRouter = { quote: async () => (calls++ === 0 ? null : good) };
    const pay = await e.rightSizeZap('a', 'b', payNaive, args);
    assert.ok(pay < payNaive, 'payment not reduced after the retry');
  });
  await t('missing quote or unreadable liquidity keeps the payment', async () => {
    assert.strictEqual(await eng({ quote: null }).rightSizeZap('a', 'b', payNaive, args), payNaive);
    assert.strictEqual(await eng({ liq: 0n }).rightSizeZap('a', 'b', payNaive, args), payNaive);
  });
  console.log(`\n${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
