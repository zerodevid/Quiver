'use strict';
// Manual LP range "down X% / up Y%" -> ticks, in both quote directions.
// Run: node test/range.js
const assert = require('node:assert');
const { ticksFromPct } = require('../src/manual');
const { tickPrice } = { tickPrice: (t, q) => (q === 1 ? 1.0001 ** t : 1 / 1.0001 ** t) };   // the price as seen, decimals ignored (they cancel out in the ratio)

const tests = [];
const test = (n, f) => tests.push([n, f]);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

for (const q of [0, 1]) {
  test(`−10% / +30% fall at the right price (token quote${q})`, () => {
    const cur = -276000;
    const r = ticksFromPct({ curTick: cur, quoteSide: q, lowerPct: 10, upperPct: 30 });
    assert.ok(r.tickLower < r.tickUpper);
    const p0 = tickPrice(cur, q);
    const ps = [tickPrice(r.tickLower, q), tickPrice(r.tickUpper, q)].sort((a, b) => a - b);
    near(ps[0] / p0, 0.9, 0.001, 'batas bawah');
    near(ps[1] / p0, 1.3, 0.001, 'batas atas');
  });
}

test('±25% symmetric in price, not in ticks', () => {
  const r = ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 25, upperPct: 25 });
  near(1.0001 ** r.tickLower, 0.75, 0.001, 'bawah');
  near(1.0001 ** r.tickUpper, 1.25, 0.001, 'atas');
});

test('lower bound 0% = the range starts exactly at the current price', () => {
  const r = ticksFromPct({ curTick: 1000, quoteSide: 1, lowerPct: 0, upperPct: 20 });
  assert.strictEqual(r.tickLower, 1000);
});

for (const q of [0, 1]) {
  test(`range shifted away from the price: −30% … −10% and +10% … +30% (token quote${q})`, () => {
    const cur = -276000, p0 = tickPrice(cur, q);
    for (const [lowerPct, upperPct, lower, upper] of [[30, -10, 0.7, 0.9], [-10, 30, 1.1, 1.3]]) {
      const r = ticksFromPct({ curTick: cur, quoteSide: q, lowerPct, upperPct });
      assert.ok(!r.error, r.error);
      const ps = [tickPrice(r.tickLower, q), tickPrice(r.tickUpper, q)].sort((a, b) => a - b);
      near(ps[0] / p0, lower, 0.001, `batas bawah ${lowerPct}`);
      near(ps[1] / p0, upper, 0.001, `batas atas ${upperPct}`);
    }
  });
}

test('nonsensical input rejected with a message', () => {
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 100, upperPct: 10 }).error, 'down 100% = price zero');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: -10, upperPct: 5 }).error, 'lower +10% above the upper bound +5%');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 10, upperPct: -10 }).error, 'both bounds at the same price');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 150, upperPct: -100 }).error, 'upper bound −100% = price zero');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 0, upperPct: 0 }).error, 'empty');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 'abc', upperPct: 10 }).error);
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 10, upperPct: 1e9 }).error);
});

let ok = 0, bad = 0;
for (const [n, f] of tests) {
  try { f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.message); }
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
