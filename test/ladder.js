'use strict';
// Layered entry: budget split and layer boundaries (ladderLayers and shapeLayers in src/manual.js).
// Run: node test/ladder.js
const assert = require('node:assert');
const { ladderLayers, shapeLayers, bandTicks, Manual } = require('../src/manual');

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

// Ratio edges of a shape band: [lower, upper] relative to the current price.
const edgesOf = (l) => [1 - l.lowerPct / 100, 1 + l.upperPct / 100];

test('shape bands tile the range with the price as an edge and add up to the cent', () => {
  for (const shape of ['spot', 'curve', 'bidask']) {
    const { layers, error } = shapeLayers({ usd: 100, lowerPct: 25, upperPct: 40, layers: 6, shape });
    assert.ok(!error, error);
    assert.strictEqual(Math.round(layers.reduce((a, l) => a + l.usd, 0) * 100), 10000, shape);
    const e = layers.map(edgesOf).sort((a, b) => a[0] - b[0]);
    near(e[0][0], 0.75, 1e-9, 'lowest edge');
    near(e[e.length - 1][1], 1.4, 1e-9, 'highest edge');
    for (let i = 1; i < e.length; i++) near(e[i - 1][1], e[i][0], 1e-9, 'adjacent bands touch');
    // no band straddles the price: each is one-sided
    for (const [lo, hi] of e) assert.ok(hi <= 1 + 1e-12 || lo >= 1 - 1e-12, `band ${lo}-${hi} straddles the price`);
  }
});

test('curve is heaviest next to the price, bid-ask at the edges, spot flat', () => {
  const usd = (shape) => shapeLayers({ usd: 60, lowerPct: 20, upperPct: 25, layers: 6, shape }).layers.map((l) => l.usd);
  assert.deepStrictEqual(usd('spot'), [10, 10, 10, 10, 10, 10]);
  const c = usd('curve'), b = usd('bidask');
  assert.ok(c[0] > c[c.length - 1] && c[1] > c[c.length - 1], `curve ${c}`);
  assert.ok(b[0] < b[b.length - 1] && b[1] < b[b.length - 1], `bidask ${b}`);
});

test('a range on one side of the price is shaped from the price outward', () => {
  const { layers } = shapeLayers({ usd: 30, lowerPct: 60, upperPct: -10, layers: 3, shape: 'curve' });
  assert.deepStrictEqual(layers.map((l) => l.usd), [15, 10, 5]);
  near(layers[0].upperPct, -10, 1e-9, 'nearest band starts at the upper bound');
  near(layers[2].lowerPct, 60, 1e-9, 'deepest band ends at the lower bound');
  assert.ok(shapeLayers({ usd: 30, lowerPct: -5, upperPct: 40, layers: 3, shape: 'bidask' }).layers.every((l) => l.lowerPct <= 0), 'above the price');
});

test('bad shape input is rejected', () => {
  assert.ok(shapeLayers({ usd: 100, lowerPct: 20, upperPct: 20, layers: 1, shape: 'curve' }).error, 'one band');
  assert.ok(shapeLayers({ usd: 100, lowerPct: 20, upperPct: 20, layers: 4, shape: 'nope' }).error, 'unknown shape');
  assert.ok(shapeLayers({ usd: 100, lowerPct: -30, upperPct: 20, layers: 4, shape: 'curve' }).error, 'inverted');
  assert.ok(shapeLayers({ usd: 100, lowerPct: 100, upperPct: 20, layers: 4, shape: 'curve' }).error, 'price zero');
});

test('shape bands share their tick edges: no gap, no overlap', () => {
  const { layers } = shapeLayers({ usd: 60, lowerPct: 20, upperPct: 25, layers: 6, shape: 'curve' });
  for (const quoteSide of [0, 1]) {
    const r = bandTicks(layers, 135247, quoteSide, 60);
    assert.ok(!r.error, r.error);
    const t = r.layers.map((l) => [l.tickLower, l.tickUpper]).sort((a, b) => a[0] - b[0]);
    for (const [a, b] of t) assert.ok(a % 60 === 0 && b % 60 === 0 && b > a, `aligned ${a}-${b}`);
    for (let i = 1; i < t.length; i++) assert.strictEqual(t[i - 1][1], t[i][0], 'neighbours share an edge');
    // exactly one band holds the current tick
    assert.strictEqual(t.filter(([a, b]) => a <= 135247 && 135247 < b).length, 1);
  }
});

test('bands too narrow for the tick spacing are refused', () => {
  const { layers } = shapeLayers({ usd: 60, lowerPct: 0.5, upperPct: 0.5, layers: 10, shape: 'curve' });
  assert.match(bandTicks(layers, 135247, 1, 60).error, /terlalu sempit/);
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
  m.poolByRef = async () => ({ venue: 'v4', quoteSide: 1, tickSpacing: 60, poolRef: '0xpool' });
  m.chain = { isV3Venue: () => false, slot0V4: async () => ({ tick: 1000 }) };
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

test('planLadder with a shape plans each band through planLp', async () => {
  const m = fakeManual();
  const r = await m.planLadder({ poolRef: '0xpool', usd: 100, layers: 4, shape: 'curve', lowerPct: 20, upperPct: 20 });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.shape, 'curve');
  assert.strictEqual(m.calls.length, 4);
  assert.ok(m.calls.every((c) => c.tickLower != null && c.lowerPct == null), 'bands are planned on pinned ticks');
  assert.ok(m.calls.some((c) => c.tickUpper <= 960) && m.calls.some((c) => c.tickLower >= 960), 'bands on both sides');
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
