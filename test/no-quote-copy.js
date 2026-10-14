'use strict';
// Pools with no quote asset (memecoin / memecoin) are copied only when filters.allow_no_quote
// is on, sized and booked in USD through the DexScreener anchor (usd-anchor.js).
//
// Run: node test/no-quote-copy.js
const assert = require('node:assert');
const { planEntry, rulesFor } = require('../src/policy');
const { Chain } = require('../src/pools');
const { setAnchor } = require('../src/usd-anchor');
const m = require('../src/v3math');

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const chain = new Chain(null, null, () => {}, 'robinhood');
const slot0 = { sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 };
const roomy = { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6, min_quote_usd: 1 };
const rules = (filters = {}) => rulesFor({ sizing: { mode: 'pct', pct: 50, ...roomy }, filters: { min_target_quote_usd: 1, ...filters } });
const act = { venue: 'v3', token0: A, token1: B, fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: String(10n ** 21n), valueQuote: 500, quoteSymbol: 'USDG', tokenId: '7', target: '0xabc' };
const plan = (r, over = {}) => planEntry({ ...act, ...over }, { chain, rules: r, slot0, dec0: 18, dec1: 18, ethUsd: 2500, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0 });

// off (default): skipped as before
let r = plan(rules());
assert.strictEqual(r.verdict, 'skip');
assert.match(r.reason, /tanpa aset kuotasi/);

// on, but no USD price known yet: a clear skip, not a $0 position
r = plan(rules({ allow_no_quote: true }));
assert.strictEqual(r.verdict, 'skip');
assert.match(r.reason, /harga dolar token belum terbaca/);

// on, with an anchor: copied, sized and booked in USD
setAnchor(chain, A, 2);
r = plan(rules({ allow_no_quote: true }));
assert.strictEqual(r.verdict, 'copy', r.reason);
assert.strictEqual(r.plan.noQuote, true);
assert.strictEqual(r.plan.quoteSide, null);
assert.strictEqual(r.plan.quoteSymbol, 'USDG');
assert.ok(r.plan.valueUsd > 0 && Math.abs(r.plan.valueUsd - r.plan.valueQuote) < 1e-9);

// blacklist applies to BOTH tokens
r = plan(rules({ allow_no_quote: true, token_blacklist: [B] }));
assert.strictEqual(r.verdict, 'skip');
assert.match(r.reason, /daftar hitam/);

// a pair that has a quote asset is untouched by the switch
const withQuote = plan(rules({ allow_no_quote: true }), { token0: chain.ADDR.usdg });
assert.notStrictEqual(withQuote.plan?.noQuote, true);
console.log('ok');

// Exit side: both tokens of a pair without a quote asset are memecoins sold into USDG.
const { Engine } = require('../src/engine');
const me = { chain };
const pos = { token0: A, token1: B };
const roles = Engine.prototype.leftoverRoles.call(me, pos);
assert.deepStrictEqual(roles.memes, [A, B]);
assert.strictEqual(roles.quote, chain.ADDR.usdg.toLowerCase());
assert.strictEqual(Engine.prototype.leftoverRoles.call(me, { token0: chain.ADDR.usdg, token1: chain.ADDR.weth }), null);
assert.deepStrictEqual(Engine.prototype.leftoverRoles.call(me, { token0: chain.ADDR.usdg, token1: A }).memes, [A]);
// fee claim: the larger side (by USD) goes in the fee ledger
const toks = [{ decimals: 18 }, { decimals: 18 }];
const meme = Engine.prototype.memeSideOf.call(me, pos, 10n ** 18n, 5n * 10n ** 18n, slot0, toks);
assert.strictEqual(meme.token, B);
assert.strictEqual(meme.quote, chain.ADDR.usdg.toLowerCase());
console.log('ok exit');
