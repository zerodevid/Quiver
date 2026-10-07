import { test } from 'node:test';
import assert from 'node:assert/strict';
import { breakEven } from './breakeven.js';
const tick = p => Math.log(p) / Math.log(1.0001);
const p = { inRange: false, quoteSide: 1, dec0: 0, dec1: 0, tick_lower: tick(1), tick_upper: tick(4), liquidity: '100', cost_quote: 75, fee0: '0', fee1: '0' };
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
test('BEP follows LP rebalancing inside range', () => near(breakEven(p).price, (2 - Math.sqrt(0.5)) ** 2));
test('BEP below range and with realized proceeds', () => near(breakEven({ ...p, cost_quote: 50, claimed_quote: 10, out_quote: 15 }).price, 0.5));
test('unreachable above quote-only cap', () => assert.match(breakEven({ ...p, cost_quote: 110 }).reason, /tidak tercapai/));
test('existing base fees allow BEP above range', () => near(breakEven({ ...p, cost_quote: 150, fee0: '10' }).price, 5));
test('inverse quote and mixed decimals preserve BEP', () => near(breakEven({ ...p, quoteSide: 0, dec0: 6, dec1: 18, liquidity: '100000000000000', tick_lower: tick(1e12 / 4), tick_upper: tick(1e12) }).price, breakEven(p).price));
test('hide inactive and reject stale data', () => { assert.equal(breakEven({ ...p, inRange: true }), null); assert.equal(breakEven({ ...p, status: 'closed' }), null); assert.ok(breakEven({ ...p, valueStale: true }).reason); });

test('depth panel can request BEP for an in-range open position', () => near(breakEven({ ...p, inRange: true, status: 'open' }, { all: true }).price, breakEven(p).price));

test('Meteora DLMM: liquidity is bin shares — L comes from the contents at the current price', () => {
  // a v3 range L=100 over [1, 4] holds x = 100(1/√2 − 1/2), y = 100(√2 − 1) at price 2
  const dlmm = { ...p, venue: 'meteora', liquidity: '987654321987654321', curTick: tick(2),
    amount0: String(100 * (1 / Math.SQRT2 - 0.5)), amount1: String(100 * (Math.SQRT2 - 1)) };
  near(breakEven(dlmm).price, breakEven(p).price);
  assert.ok(breakEven({ ...dlmm, amount0: undefined, amount1: undefined }).reason, 'no contents = unavailable');
});
