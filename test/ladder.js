'use strict';
// Layered entry: budget split and layer boundaries (ladderLayers in src/manual.js).
// Run: node test/ladder.js
const assert = require('node:assert');
const { ladderLayers, Manual } = require('../src/manual');

const tests = [];
const test = (n, f) => tests.push([n, f]);
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} vs ${b}`);

test('layers tile the span and the budget adds up to the cent', () => {
  for (const method of ['equal', 'linear', 'grow15', 'double']) {
    const { layers, error } = ladderLayers({ usd: 100, topPct: 5, bottomPct: 80, layers: 6, method });
    assert.ok(!error, error);
    assert.strictEqual(layers.length, 6);
    assert.strictEqual(Math.round(layers.reduce((a, l) => a + l.usd, 0) * 100), 10000, method);
    near(layers[0].upperPct, -5, 1e-9, 'nearest layer starts at the top bound');
    near(layers[5].lowerPct, 80, 1e-9, 'deepest layer ends at the bottom bound');
    for (let i = 1; i < 6; i++) {
      // the lower edge of one layer is the upper edge of the next
      near(1 - layers[i - 1].lowerPct / 100, 1 + layers[i].upperPct / 100, 1e-9, 'adjacent layers touch');
    }
  }
});

test('deeper layers get more budget except for the equal method', () => {
  const usd = (u, method) => ladderLayers({ usd: u, bottomPct: 60, layers: 3, method }).layers.map((l) => l.usd);
  assert.deepStrictEqual(usd(90, 'equal'), [30, 30, 30]);
  assert.deepStrictEqual(usd(60, 'linear'), [10, 20, 30]);
  assert.deepStrictEqual(usd(70, 'double'), [10, 20, 40]);
});

test('layers have equal width in price ratio', () => {
  const { layers } = ladderLayers({ usd: 100, topPct: 0, bottomPct: 75, layers: 4, method: 'equal' });
  const ratios = layers.map((l) => (1 - l.lowerPct / 100) / (1 + l.upperPct / 100));
  for (const r of ratios) near(r, ratios[0], 1e-9, 'ratio');
});

test('rounding remainder goes to the deepest layer', () => {
  const { layers } = ladderLayers({ usd: 10, bottomPct: 50, layers: 3, method: 'equal' });
  assert.deepStrictEqual(layers.map((l) => l.usd), [3.33, 3.33, 3.34]);
});

test('bad input is rejected', () => {
  assert.ok(ladderLayers({ usd: 100, bottomPct: 50, layers: 1 }).error, 'one layer is not a ladder');
  assert.ok(ladderLayers({ usd: 100, bottomPct: 50, layers: 11 }).error, 'too many layers');
  assert.ok(ladderLayers({ usd: 100, topPct: 30, bottomPct: 20, layers: 3 }).error, 'bottom above top');
  assert.ok(ladderLayers({ usd: 100, bottomPct: 100, layers: 3 }).error, 'down 100% is price zero');
  assert.ok(ladderLayers({ usd: 100, topPct: -5, bottomPct: 50, layers: 3 }).error, 'top above the price');
  assert.ok(ladderLayers({ usd: 0, bottomPct: 50, layers: 3 }).error, 'no budget');
  assert.ok(ladderLayers({ usd: 100, bottomPct: 50, layers: 3, method: 'nope' }).error, 'unknown method');
});

// planLadder / openLadder with planLp and openLp stubbed: only the orchestration is under test.
function fakeManual({ openCount = 0, exposure = 0, maxOpen = 10, maxTotal = 1000, cash = 500, failAt = null } = {}) {
  const m = Object.create(Manual.prototype);
  m.engine = {
    ethUsd: 3000,
    rulesFrom: () => ({ filters: { max_open_positions: maxOpen }, sizing: { max_total_exposure_usd: maxTotal } }),
    positions: { summary: () => ({ openCount, exposureUsd: exposure }) },
  };
  m.calls = [];
  m.planLp = async (a) => {
    m.calls.push(a);
    return { plan: { n: m.calls.length }, warnings: ['one side'], preview: { valueUsd: a.usd, tickLower: -2, tickUpper: -1, lowerPct: a.lowerPct, upperPct: a.upperPct,
      pair: 'X/USDG', venue: 'v4', feePct: 1, symbol0: 'X', symbol1: 'USDG', dec0: 18, dec1: 6, quoteSide: 1, curTick: 0, walletCashUsd: cash } };
  };
  m.openLp = async (plan) => {
    if (plan.n === failAt) throw new Error('boom');
    return { txHash: `0x${plan.n}`, positionId: plan.n, note: `layer ${plan.n}` };
  };
  return m;
}
const args = { poolRef: '0xpool', usd: 100, topPct: 0, bottomPct: 60, layers: 4, method: 'linear' };

test('planLadder returns every layer with the combined total', async () => {
  const r = await fakeManual().planLadder(args);
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.layers.length, 4);
  near(r.preview.totalUsd, 100, 1e-9, 'total');
  assert.strictEqual(r.warnings.filter((w) => w === 'one side').length, 1, 'warnings are de-duplicated');
});

test('planLadder checks the whole ladder against the limits', async () => {
  assert.match((await fakeManual({ openCount: 8, maxOpen: 10 }).planLadder(args)).error, /layer butuh/);
  assert.match((await fakeManual({ exposure: 950, maxTotal: 1000 }).planLadder(args)).error, /eksposur/);
  assert.match((await fakeManual({ cash: 60 }).planLadder(args)).error, /kas cuma/);
});

test('openLadder opens nearest first and stops at the first failure', async () => {
  const seen = [];
  const m = fakeManual({ failAt: 3 });
  const r = await m.openLadder(args, (p) => seen.push(p.done));
  assert.match(r.error, /layer 3\/4/);
  assert.deepStrictEqual(r.opened.map((o) => o.n), [1, 2]);
  assert.deepStrictEqual(seen, [1, 2]);
  assert.strictEqual(m.calls.length, 3, 'no plan is made after the failure');
  const ok = await fakeManual().openLadder(args);
  assert.ok(ok.ok);
  assert.strictEqual(ok.opened.length, 4);
});

(async () => {
let ok = 0, bad = 0;
for (const [n, f] of tests) {
  try { await f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.message); }
}
console.log(`\n${ok} passed, ${bad} failed`);
process.exit(bad ? 1 : 0);
})();
