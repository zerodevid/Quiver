'use strict';
// Sizing mode "equity": our size = the target's share of its equity × our equity,
// with a pct fallback when either equity is unknown.
//
// Run: node test/sizing-equity.js
const assert = require('node:assert');
const { planEntry, rulesFor } = require('../src/policy');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const chain = {
  quoteSideOf: (t0) => (t0 === USDG ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
  valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 * (1e12 / m.priceFromSqrt(sqrtPriceX96, 0, 0)) / 1e12, symbol: 'USDG', kind: 'usd' }),
};
const slot0 = { sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 };
const roomy = { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6, min_quote_usd: 1 };
const rules = (sizing) => rulesFor({ sizing: { mode: 'equity', ...roomy, ...sizing }, filters: { min_target_quote_usd: 1, allow_hooks: true } });
const act = { venue: 'v4', token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: String(10n ** 16n), valueQuote: 2000, tokenId: '7', target: '0xabc' };
const plan = (sizing, eq) => planEntry(act, { chain, rules: rules(sizing), slot0, dec0: 6, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0, ...eq });
const near = (a, b) => assert.ok(Math.abs(a - b) < 0.05, `expected ~${b}, got ${a}`);

// target $2k of $10k = 20% → 20% of our $3k = $600
let r = plan({}, { targetEquityUsd: 10_000, ourEquityUsd: 3000 });
assert.strictEqual(r.verdict, 'copy', r.reason);
near(r.plan.valueUsd, 600);
assert.match(r.reason, /^equity: target 20\.0% dari \$10\.0k → kita 20\.0% dari \$3\.0k → \$600/);

// share capped by equity_max_pct: 2k of 2.5k = 80% → 30%
r = plan({}, { targetEquityUsd: 2500, ourEquityUsd: 1000 });
near(r.plan.valueUsd, 300);
assert.match(r.reason, /dibatasi 30%/);

// multiplier halves the share
near(plan({ equity_mult: 0.5 }, { targetEquityUsd: 10_000, ourEquityUsd: 3000 }).plan.valueUsd, 300);

// a zero cap or multiplier is a clear skip, not a silent zero-size result
for (const z of [{ equity_max_pct: 0 }, { equity_mult: 0 }]) {
  r = plan(z, { targetEquityUsd: 10_000, ourEquityUsd: 3000 });
  assert.strictEqual(r.verdict, 'skip');
  assert.match(r.reason, /porsi equity nol/);
}

// manual target equity replaces the read: $2k of a manual $20k = 10% of our $3k = $300 (engine value ignored)
r = plan({ equity_target_usd: 20_000 }, { targetEquityUsd: 2500, ourEquityUsd: 3000 });
near(r.plan.valueUsd, 300);
assert.match(r.reason, /^equity: target 10\.0% dari \$20\.0k \(manual\) → kita 10\.0% dari \$3\.0k → /);
near(plan({ equity_target_usd: 20_000 }, { ourEquityUsd: 3000 }).plan.valueUsd, 300);   // no on-chain read needed

// floor: 2k of 100k = 2% × 0.5 = 1% of $3k = $30, raised to a 5% floor = $150
r = plan({ equity_mult: 0.5, equity_min_pct: 5 }, { targetEquityUsd: 100_000, ourEquityUsd: 3000 });
near(r.plan.valueUsd, 150);
assert.match(r.reason, /\(minimum 5%\)/);

// floor above the cap: the floor wins (cap 10%, floor 15% of $3k = $450)
near(plan({ equity_max_pct: 10, equity_min_pct: 15 }, { targetEquityUsd: 10_000, ourEquityUsd: 3000 }).plan.valueUsd, 450);

// our basis "cash": 20% of our $1k cash = $200 (not of the $3k total)
r = plan({ equity_our_basis: 'cash' }, { targetEquityUsd: 10_000, ourEquityUsd: 3000, ourCashUsd: 1000 });
near(r.plan.valueUsd, 200);
assert.match(r.reason, /dari \$1\.0k \(kas saja\)/);

// fallback "skip": unknown equity skips instead of using pct
r = plan({ equity_fallback: 'skip' }, { targetEquityUsd: null, ourEquityUsd: 3000 });
assert.strictEqual(r.verdict, 'skip');
assert.match(r.reason, /^equity target tidak terbaca — dilewati/);

// existing ceilings still apply after the equity size
r = plan({ max_quote_per_position_usd: 250 }, { targetEquityUsd: 10_000, ourEquityUsd: 3000 });
near(r.plan.valueUsd, 250);
assert.match(r.reason, / — dipotong oleh batas per posisi/);

// either equity unknown → same size as plain pct, and the reason says so
const pct = planEntry(act, { chain, rules: rulesFor({ sizing: { mode: 'pct', pct: 25, ...roomy }, filters: { min_target_quote_usd: 1, allow_hooks: true } }), slot0, dec0: 6, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0 });
for (const [eq, who] of [[{ targetEquityUsd: null, ourEquityUsd: 3000 }, 'target'], [{ targetEquityUsd: 10_000, ourEquityUsd: null }, 'kita'], [{}, 'target']]) {
  r = plan({ pct: 25 }, eq);
  assert.strictEqual(r.plan.liquidity, pct.plan.liquidity);
  assert.match(r.reason, new RegExp(`^equity ${who} tidak terbaca → pct 25% → \\$`));
}

// engine: target equity = quote cash + open LP (wpositions) + this position if the scan missed it
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const store = new Store(':memory:');
const T = '0x00000000000000000000000000000000000000aa';
const fake = {
  store, network: 'robinhood', ethUsd: 2500, log: () => {},
  chain: { ADDR, usdgDecimals: 6, quoteSideOf: chain.quoteSideOf },
  research: { refreshOpen: async () => {} },
  holdings: { balances: async () => new Map([[ADDR.native, 10n ** 18n], [ADDR.weth, 0n], [ADDR.usdg, 1000n * 10n ** 6n]]) },
};
const asked = [];
fake.onResearchNeeded = (addr, mode) => asked.push([addr, mode]);
const targetEquity = (a) => Engine.prototype.targetEquity.call(fake, a);
(async () => {
  assert.strictEqual(await targetEquity({ ...act, target: T }), null, 'never researched → unknown');
  assert.deepStrictEqual(asked.splice(0), [[T, 'full']], 'a first research is requested, not awaited');
  store.run("INSERT INTO wallets(chain,address,first_block,scanned_to,last_scan_ts) VALUES('robinhood',?,0,100,0)", T);
  store.run(`INSERT INTO wpositions(chain,wallet,venue,token_id,live_value_q,live_fee_q,status) VALUES('robinhood',?,'v4','1',4000,100,'open')`, T);
  store.run(`INSERT INTO wpositions(chain,wallet,venue,token_id,live_value_q,live_fee_q,status) VALUES('robinhood',?,'v4','2',9999,0,'closed')`, T);
  // cash 2500 + 1000, LP 4100, this position (2000) not scanned yet
  near(await targetEquity({ ...act, target: T.toUpperCase().replace('0X', '0x'), block: 150 }), 9600);
  assert.deepStrictEqual(asked.splice(0), [[T, 'refresh']], 'a stale scan (last_scan_ts = 0) asks for a refresh');
  // the scan reached the block and knows the position -> not added twice
  near(await targetEquity({ ...act, target: T, tokenId: '1', block: 90 }), 7600);
  // an ADD to a known position after the last scan: the stored liquidity lacks it -> added once
  near(await targetEquity({ ...act, target: T, tokenId: '1', block: 150 }), 9600);
  // a manual target equity must not touch the chain at all
  const boom = { ...fake, targetEquity: async () => { throw new Error('should not be read'); }, cash: { usd: 1000 } };
  const si = await Engine.prototype.sizingEquity.call(boom, { ...act, target: T }, { exposureUsd: 500, feeUsd: 10 }, null, { sizing: { equity_target_usd: 5000 } });
  assert.strictEqual(si.targetEquityUsd, null);
  near(si.ourEquityUsd, 1510);
  near(si.ourCashUsd, 1000);
})().then(() => import('../src/message-copy.mjs')).then(({ formatNote }) => {
  // reason copy renders in English
  assert.strictEqual(formatNote('equity: target 80.0% dari $2.5k (dibatasi 30%) → kita 30.0% dari $1.0k → $300.00', 'en'),
    'The target put 80.0% of its $2.5k equity (capped at 30%) → we put 30.0% of our $1.0k → $300.00');
  assert.strictEqual(formatNote('equity target tidak terbaca → pct 25% → $12.00', 'en'),
    'Target equity unavailable → 25% of the target’s position → $12.00');
  assert.strictEqual(formatNote('equity: target 10.0% dari $20.0k (manual) (dibatasi 30%) → kita 5.0% dari $1.0k (kas saja) (minimum 5%) → $50.00', 'en'),
    'The target put 10.0% of its $20.0k equity (manual) (capped at 30%) → we put 5.0% of our $1.0k (cash only) (raised to the 5% minimum) → $50.00');
  assert.strictEqual(formatNote('equity kita tidak terbaca — dilewati', 'en'), 'Skipped: our equity could not be read');
  console.log('ok sizing-equity');
});
