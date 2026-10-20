'use strict';
// Manual partial decrease: the engine plumbing behind POST /api/positions/decrease.
// Only the outer boundaries are stubbed; executeExit / sellLeftover / recordExit are the real code.
//
// Run: node test/decrease-manual.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// An Engine with no constructor side effects and just enough state for executeExit.
function engine({ chainL = 1000n, sellRule = false } = {}) {
  const e = Object.create(Engine.prototype);
  e.stopping = false;
  e.exiting = new Set();
  e.compound = null;
  e.pendingFeeClaim = () => null;
  e.store = { get: () => ({ status: 'open' }), log: () => {} };
  e.chainLiquidity = async () => chainL;
  e.sent = [];
  e.sendExit = async (plan, pos, opts) => { e.sent.push({ plan, opts }); return { txHash: '0xabc', note: 'ok' }; };
  e.rulesFrom = () => ({ exit: { sell_leftover: sellRule } });
  return e;
}
const pos = { id: 7, liquidity: '1000', venue: 'v4', token_id: '1' };
const plan = (liquidity) => ({ venue: 'v4', action: 'decrease', full: false, manual: true, liquidity, tokenId: '1' });

(async () => {
  await t('manual partial decrease is sent when the chain holds enough liquidity', async () => {
    const e = engine();
    const r = await e.executeExit(plan('250'), pos, { sell: true });
    assert.strictEqual(r.txHash, '0xabc');
    assert.strictEqual(e.sent.length, 1);
    assert.deepStrictEqual(e.sent[0].opts, { sell: true });
    assert.ok(!e.exiting.has(7), 'lock released');
  });

  await t('manual partial decrease is refused when the chain liquidity is below the amount', async () => {
    const e = engine({ chainL: 200n });
    await assert.rejects(() => e.executeExit(plan('250'), pos), /lebih kecil/);
    assert.strictEqual(e.sent.length, 0);
    assert.ok(!e.exiting.has(7));
  });

  await t('an unreadable chain liquidity does not block a manual partial decrease', async () => {
    const e = engine({ chainL: null });
    await e.executeExit(plan('250'), pos);
    assert.strictEqual(e.sent.length, 1);
  });

  await t('a second decrease while one is in flight is rejected', async () => {
    const e = engine();
    e.exiting.add(7);
    await assert.rejects(() => e.executeExit(plan('250'), pos), /sedang dalam proses/);
  });

  await t('sellLeftover: opts.sell=false overrides a target rule that sells', async () => {
    const e = engine({ sellRule: true });
    e.leftoverRoles = () => { throw new Error('must not be reached'); };
    assert.strictEqual(await e.sellLeftover(pos, {}, { sell: false }), null);
  });

  await t('sellLeftover: opts.sell=true overrides a target rule that does not sell', async () => {
    const e = engine({ sellRule: false });
    let reached = false;
    e.leftoverRoles = () => { reached = true; return null; };   // null roles = nothing to sell, ends early
    assert.strictEqual(await e.sellLeftover(pos, {}, { sell: true }), null);
    assert.ok(reached, 'rule bypassed');
  });

  await t('sellLeftover: without an override the target rule decides', async () => {
    const e = engine({ sellRule: false });
    e.leftoverRoles = () => { throw new Error('must not be reached'); };
    assert.strictEqual(await e.sellLeftover(pos, {}), null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
