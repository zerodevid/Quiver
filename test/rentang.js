'use strict';
// Rentang LP manual "turun X% / naik Y%" -> tick, di kedua arah kuotasi.
// Jalankan: node test/rentang.js
const assert = require('node:assert');
const { ticksFromPct } = require('../src/manual');
const { tickPrice } = { tickPrice: (t, q) => (q === 1 ? 1.0001 ** t : 1 / 1.0001 ** t) };   // harga yang dilihat, desimal diabaikan (menghilang di rasio)

const tests = [];
const test = (n, f) => tests.push([n, f]);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

for (const q of [0, 1]) {
  test(`−10% / +30% jatuh di harga yang benar (kuotasi token${q})`, () => {
    const cur = -276000;
    const r = ticksFromPct({ curTick: cur, quoteSide: q, lowerPct: 10, upperPct: 30 });
    assert.ok(r.tickLower < r.tickUpper);
    const p0 = tickPrice(cur, q);
    const ps = [tickPrice(r.tickLower, q), tickPrice(r.tickUpper, q)].sort((a, b) => a - b);
    near(ps[0] / p0, 0.9, 0.001, 'batas bawah');
    near(ps[1] / p0, 1.3, 0.001, 'batas atas');
  });
}

test('±25% simetris dalam harga, bukan dalam tick', () => {
  const r = ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 25, upperPct: 25 });
  near(1.0001 ** r.tickLower, 0.75, 0.001, 'bawah');
  near(1.0001 ** r.tickUpper, 1.25, 0.001, 'atas');
});

test('batas bawah 0% = rentang mulai tepat di harga kini', () => {
  const r = ticksFromPct({ curTick: 1000, quoteSide: 1, lowerPct: 0, upperPct: 20 });
  assert.strictEqual(r.tickLower, 1000);
});

test('isian tidak masuk akal ditolak dengan pesan', () => {
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 100, upperPct: 10 }).error, 'turun 100% = harga nol');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: -5, upperPct: 10 }).error);
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 0, upperPct: 0 }).error, 'kosong');
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 'abc', upperPct: 10 }).error);
  assert.ok(ticksFromPct({ curTick: 0, quoteSide: 1, lowerPct: 10, upperPct: 1e9 }).error);
});

let ok = 0, bad = 0;
for (const [n, f] of tests) {
  try { f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.message); }
}
console.log(`\n${ok} lulus, ${bad} gagal`);
process.exit(bad ? 1 : 0);
