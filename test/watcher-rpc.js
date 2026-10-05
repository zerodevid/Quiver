'use strict';
// Test: the target action scanner must not equate "RPC unreadable" with a valid
// answer. If it did, target actions would be lost (the cursor still advances) or — worse —
// an NFT deposit into the router would be read as "target released the position".
// Run: node test/watcher-rpc.js
const assert = require('node:assert');
const { Watcher } = require('../src/watcher');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const ROUTER = '0x' + 'ab'.repeat(20);
const { ADDR } = require('../src/chain');
const w = (rpc) => new Watcher({ rpc, store: null, chain: null, log: () => {}, cfg: {} });

(async () => {
  console.log('watcher-rpc:');

  await t('eth_getCode hits quota: throws and does NOT store "not a contract"', async () => {
    let answer = { error: { code: 429, message: 'Too Many Requests' } };
    const x = w({ batch: async (c) => c.map(() => answer) });
    await assert.rejects(x.contractCheck([ROUTER]), /tidak terbaca/);
    assert.strictEqual(x.isContract.has(ROUTER), false, 'not cached');
    answer = { result: '0x6080' };
    await x.contractCheck([ROUTER]);
    assert.strictEqual(x.isContract.get(ROUTER), true, 'read again correctly');
  });

  await t('eth_getCode tanpa balasan (null): melempar', async () => {
    const x = w({ batch: async (c) => c.map(() => null) });
    await assert.rejects(x.contractCheck([ROUTER]));
  });

  await t('an EOA (0x) is still recorded as not a contract', async () => {
    const x = w({ batch: async (c) => c.map(() => ({ result: '0x' })) });
    await x.contractCheck([ROUTER]);
    assert.strictEqual(x.isContract.get(ROUTER), false);
  });

  await t('ownerOf is read strict: an RPC error is thrown, not an empty owner', async () => {
    let opts = null;
    const x = w({ ethCallMany: async (c, b, o) => { opts = o; throw new Error('eth_call tidak terbaca dari RPC: rate limit'); } });
    await assert.rejects(x.resolveOwners('v4', ['123']), /tidak terbaca/);
    assert.ok(opts?.strict);
    assert.strictEqual(x.knownOwner('v4', '123'), null);
  });

  // "LP router is not an NFT" warning: only for target txs that really go to the LP router.
  const TARGET = '0x' + 'e7'.repeat(20);
  const HOOK_VAULT = '0x' + '6f'.repeat(20);
  const warnHarness = (to) => {
    const logs = [];
    const x = w({ batch: async (c) => c.map((q) => ({ result: { hash: q.params[0], from: TARGET, to } })) });
    x.store = { log: (lvl, msg, meta) => logs.push({ lvl, msg, meta }) };
    x.unsupportedSender.set('0xtx1', [HOOK_VAULT]);
    return { x, logs };
  };

  await t('a swap through an aggregator touching a hooked pool: NOT warned', async () => {
    const { x, logs } = warnHarness(ADDR.dexRouter);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 0);
  });

  await t('a tx to a foreign LP router: warned once per (target, router), the message contains tx + sender', async () => {
    const { x, logs } = warnHarness(ROUTER);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 1, 'sekali saja');
    assert.match(logs[0].msg, /0xtx1/);
    assert.match(logs[0].msg, new RegExp(HOOK_VAULT));
    assert.deepStrictEqual(logs[0].meta, { target: TARGET, tx: '0xtx1', to: ROUTER, senders: [HOOK_VAULT] });
    // another router for the same target still warns
    const other = '0x' + 'cd'.repeat(20);
    x.rpc = { batch: async (c) => c.map((q) => ({ result: { hash: q.params[0], from: TARGET, to: other } })) };
    await x.warnIfTargetUnsupported(['0xtx1'], new Set([TARGET]));
    assert.strictEqual(logs.length, 2);
  });

  await t('a tx not from the target: silent', async () => {
    const { x, logs } = warnHarness(ROUTER);
    await x.warnIfTargetUnsupported(['0xtx1'], new Set(['0x' + '11'.repeat(20)]));
    assert.strictEqual(logs.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
