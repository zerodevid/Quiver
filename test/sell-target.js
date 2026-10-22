'use strict';
// The "sell into" choice of the claim / close / decrease dialogs: which quote assets are offered,
// that anything else is refused, and that the pick replaces only the asset sold into.
//
// Run: node test/sell-target.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { ADDR, QUOTES } = require('../src/chain');

const MEME = '0x' + 'aa'.repeat(20), MEME2 = '0x' + 'bb'.repeat(20);
const quoteSideOf = (t0, t1) => {
  const q = QUOTES[String(t0).toLowerCase()] ? 0 : QUOTES[String(t1).toLowerCase()] ? 1 : null;
  return q == null ? null : { side: q, ...QUOTES[String(q === 0 ? t0 : t1).toLowerCase()] };
};
const eng = Object.assign(Object.create(Engine.prototype), { chain: { ADDR, QUOTES, quoteSideOf } });

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

t('offers the quote assets except native ETH', () => {
  const syms = eng.sellTargets().map((x) => x.symbol).sort();
  assert.deepStrictEqual(syms, ['USDG', 'WETH']);
});
t('no pick keeps the pool quote asset', () => {
  assert.strictEqual(eng.leftoverRoles({ token0: ADDR.weth, token1: MEME }).quote, ADDR.weth.toLowerCase());
  assert.strictEqual(eng.sellTargetOf(''), null);
});
t('a pick replaces the asset sold into, the memecoin stays the same', () => {
  const r = eng.leftoverRoles({ token0: ADDR.weth, token1: MEME }, ADDR.usdg.toUpperCase().replace('0X', '0x'));
  assert.strictEqual(r.quote, ADDR.usdg.toLowerCase());
  assert.deepStrictEqual(r.memes, [MEME]);
});
t('a pair without a quote asset sells both sides into the pick', () => {
  const r = eng.leftoverRoles({ token0: MEME, token1: MEME2 }, ADDR.weth);
  assert.strictEqual(r.quote, ADDR.weth.toLowerCase());
  assert.strictEqual(r.memes.length, 2);
});
t('native ETH and random tokens are refused', () => {
  assert.throws(() => eng.sellTargetOf(ADDR.native), /tidak didukung/);
  assert.throws(() => eng.sellTargetOf(MEME), /tidak didukung/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
