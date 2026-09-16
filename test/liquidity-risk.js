'use strict';
const assert = require('node:assert/strict');
(async () => {
  const { makeCurve, buyToPrice, sellBase, removeLiquidity, exitScenarios, positionAmounts } = await import('../web/src/liquidityRisk.mjs');
  const near = (a, b, rel = 1e-8) => assert.ok(Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * rel), `${a} != ${b}`);
  const data = (q = 1) => ({ quoteSide: q, dec0: 0, dec1: 0, quoteUsd: 1, sqrt: String(2n ** 96n), liquidity: '1000', tick: 0, start: -14000, end: 14000, buyFee: 0, sellFee: 0, ticks: [], positions: [] });
  for (const q of [0, 1]) {
    const c = makeCurve(data(q));
    near(buyToPrice(c, 1.21).quote, 100);
    const sold = sellBase(c, 100);
    near(sold.quote, 1000 - 1000 / 1.1);
    near(sold.price, 1 / 1.1 ** 2);
    assert.equal(buyToPrice(c, 100).error, 'depth_limit');
    assert.equal(sellBase(c, 1e12).error, 'depth_limit');
  }
  const d = data();
  d.buyFee = d.sellFee = 0.01;
  near(buyToPrice(makeCurve(d), 1.21).quote, 100 / 0.99);
  near(sellBase(makeCurve(d), 100).quote, 1000 - 1000 / 1.099);
  const ticks = [{ tick: -600, net: '700' }, { tick: 600, net: '-700' }];
  const positions = [{ id: 1, kind: 'own', owner: 'bot', liquidity: '100', lower: -600, upper: 600 }, { id: 2, kind: 'target', owner: 'target', liquidity: '600', lower: -600, upper: 600 }];
  const snapshot = { ...data(), ticks, positions };
  const c = makeCurve(snapshot);
  near(removeLiquidity(c, positions).L, 300);
  const noTarget = exitScenarios(snapshot, { ownId: 1, salePct: 0 });
  near(noTarget.sellFirst.receivedUsd, noTarget.lpFirst.receivedUsd);
  assert.ok(noTarget.current.receivedUsd > noTarget.lpFirst.receivedUsd);
  const risk = exitScenarios(snapshot, { ownId: 1, salePct: 100 });
  assert.ok(risk.sellFirst.receivedUsd < risk.lpFirst.receivedUsd);
  assert.ok(risk.targetSale.price < 1);
  near(risk.targetSharePct, 60);
  const amounts = positionAmounts(c, positions[0]);
  near(amounts.base, amounts.quote);
  const inverse = exitScenarios({ ...snapshot, quoteSide: 0 }, { ownId: 1, salePct: 100 });
  near(inverse.sellFirst.receivedUsd, risk.sellFirst.receivedUsd);
  const allGone = removeLiquidity(makeCurve({ ...snapshot, liquidity: '700' }), positions);
  assert.equal(sellBase(allGone, 1).error, 'liquidity_gap');
  assert.equal(makeCurve({ ...snapshot, hook: true }), null);
  assert.equal(exitScenarios({ ...snapshot, missingPositions: true }, { ownId: 1 }).sellFirst.error, 'target_unknown');
  assert.equal(exitScenarios(snapshot, { ownId: 999 }).current.error, 'unavailable');
  // Tick crossing: first 1000 liquidity until tick 600, then 500 liquidity.
  const step = makeCurve({ ...data(), ticks: [{ tick: 600, net: '-500' }] });
  const s = Math.sqrt(1.0001 ** 600), target = 1.0001 ** 1200;
  near(buyToPrice(step, target).quote, 1000 * (s - 1) + 500 * (Math.sqrt(target) - s));
  // Exhausted depth must not masquerade as the cost of a fully filled trade.
  assert.ok(sellBase(makeCurve({ ...data(), liquidity: '0' }), 10).error);
  console.log('Liquidity depth, tick crossing, fees, inverse pairs and target-sale scenarios passed');
})().catch((e) => { console.error(e); process.exitCode = 1; });
