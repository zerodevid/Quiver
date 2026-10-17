'use strict';
// Test: previewEntry, the rules simulation (dry verdict for a past target entry).
// Guards: it uses the same static filters as the real entry plan, applies the sizing mode, the
// per-position ceiling and the minimum (with force_min), and never throws on a bare row.
// Run: node test/rules-simulate.js
const assert = require('node:assert');
const { rulesFor, previewEntry } = require('../src/policy');
const { ADDR } = require('../src/chain');

const USDG = ADDR.usdg, MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const chain = {
  ADDR, QUOTES: { [USDG]: { symbol: 'USDG', decimals: 6, kind: 'usd' } },
  quoteSideOf(t0, t1) {
    if (String(t0).toLowerCase() === USDG) return { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' };
    if (String(t1).toLowerCase() === USDG) return { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' };
    return null;
  },
};
const row = (over = {}) => ({ venue: 'v3', token0: USDG, token1: MEME, fee: 3000, valueQuote: 400, quoteSymbol: 'USDG', ...over });
const run = (r, over = {}) => previewEntry(r, { rules: rulesFor(over), chain, ethUsd: 2500 });

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ok   ' + name); pass++; } catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.message).split('\n')[0]); fail++; }
}

t('default pct 25% of a $400 target copies $100', () => {
  const d = run(row());
  assert.equal(d.verdict, 'copy'); assert.equal(d.usd, 100);
});
t('target below the minimum size is skipped', () => {
  const d = run(row({ valueQuote: 10 }));
  assert.equal(d.verdict, 'skip'); assert.match(d.reason, /target cuma/);
});
t('blacklisted token is skipped', () => {
  const d = run(row(), { filters: { token_blacklist: [MEME] } });
  assert.equal(d.verdict, 'skip'); assert.match(d.reason, /daftar hitam/);
});
t('disabled venue is skipped', () => {
  assert.equal(run(row(), { filters: { venues: ['v4'] } }).verdict, 'skip');
});
t('fee tier above the cap is skipped', () => {
  assert.equal(run(row({ fee: 10000 }), { filters: { max_fee_bps: 3000 } }).verdict, 'skip');
});
t('pool without a quote asset is skipped unless allowed', () => {
  const r = row({ token0: MEME, token1: '0x' + '11'.repeat(20) });
  assert.equal(run(r).verdict, 'skip');
});
t('per-position ceiling cuts the size', () => {
  const d = run(row({ valueQuote: 4000 }), { sizing: { pct: 100, max_quote_per_position_usd: 250 } });
  assert.equal(d.verdict, 'copy'); assert.equal(d.usd, 250); assert.match(d.reason, /dipotong/);
});
t('below minimum skips; force_min raises it', () => {
  const small = row({ valueQuote: 40 });
  const cfg = { filters: { min_target_quote_usd: 0 }, sizing: { pct: 10, min_quote_usd: 20 } };
  assert.equal(run(small, cfg).verdict, 'skip');
  const forced = run(small, { ...cfg, sizing: { ...cfg.sizing, force_min: true, force_min_usd: 25 } });
  assert.equal(forced.verdict, 'copy'); assert.equal(forced.usd, 25);
});
t('equity mode with skip fallback is skipped in the simulation', () => {
  assert.equal(run(row(), { sizing: { mode: 'equity', equity_fallback: 'skip' } }).verdict, 'skip');
});
t('a bare row does not throw', () => {
  const d = previewEntry({ venue: 'v3', token0: USDG, token1: MEME }, { rules: rulesFor({}), chain, ethUsd: 2500 });
  assert.equal(d.verdict, 'skip');
});

console.log(`\n${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
