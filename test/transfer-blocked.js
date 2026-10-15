'use strict';
// Test: Executor.transferBlocked flags tokens that refuse a transfer from the bot wallet
// (airdrop bait / honeypot), leaves quote assets alone, and does not read a transient
// RPC failure as "blocked".
//
// Run: node test/transfer-blocked.js
const assert = require('node:assert');
const { Executor } = require('../src/executor');

const ME = '0x' + 'e9'.repeat(20);
const GOOD = '0x' + '11'.repeat(20);
const TRAP = '0x' + '22'.repeat(20);
const FLAKY = '0x' + '33'.repeat(20);
const USDG = '0x' + '44'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function exec() {
  const calls = [];
  const rpc = {
    ethCallMany: async (items, _block, opts = {}) => {
      calls.push(items.map((i) => i.to));
      return items.map((i) => {
        if (i.to === TRAP) return null;
        if (i.to === FLAKY) { if (opts.strict) throw new Error('transient'); return null; }
        return '0x' + '0'.repeat(63) + '1';
      });
    },
  };
  const ex = new Executor({ rpc, store: null, chain: { QUOTES: { [USDG]: { symbol: 'USDG' } }, ADDR: {} }, cfg: {}, log: () => {} });
  ex.address = () => ME;
  return { ex, calls };
}
const bal = (pairs) => new Map(pairs.map(([a, v]) => [a, BigInt(v)]));

(async () => {
  console.log('transferBlocked:');

  await t('a reverting token is blocked, a normal token passes', async () => {
    const { ex } = exec();
    const r = await ex.transferBlocked([GOOD, TRAP], bal([[GOOD, 5], [TRAP, 60000]]));
    assert.strictEqual(r.get(GOOD), false);
    assert.strictEqual(r.get(TRAP), true);
  });

  await t('quote assets and zero balances are not probed', async () => {
    const { ex, calls } = exec();
    const r = await ex.transferBlocked([USDG, GOOD], bal([[USDG, 9], [GOOD, 0]]));
    assert.strictEqual(r.size, 0);
    assert.strictEqual(calls.length, 0);
  });

  await t('a transient failure is left out, not flagged', async () => {
    const { ex } = exec();
    const r = await ex.transferBlocked([FLAKY], bal([[FLAKY, 7]]));
    assert.strictEqual(r.has(FLAKY), false);
  });

  await t('the result is cached per balance', async () => {
    const { ex, calls } = exec();
    await ex.transferBlocked([TRAP], bal([[TRAP, 10]]));
    const n = calls.length;
    await ex.transferBlocked([TRAP], bal([[TRAP, 10]]));
    assert.strictEqual(calls.length, n);
    await ex.transferBlocked([TRAP], bal([[TRAP, 11]]));
    assert.ok(calls.length > n);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
