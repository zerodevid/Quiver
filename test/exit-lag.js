'use strict';
// Test: reading the TARGET's liquidity is not fooled by a lagging node or by a later
// target action.
//  - v4 reconciliation: getPositionLiquidity answers 0 for an NFT the node does not know yet;
//    a freshly opened mirror must not be closed because of that.
//  - partial withdrawal: the "before" liquidity is computed from the state at the action's block, not `latest`.
//  - strict eth_call: only a revert is read as null; "block not found" throws.
// Run: node test/exit-lag.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { RpcPool } = require('../src/rpc');
const { ADDR } = require('../src/chain');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const POOL = '0x' + 'ab'.repeat(32);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

function engineWith(ethCallMany) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const eng = new Engine({ rpc: { ethCallMany, call: async () => null }, store, chain: {}, cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
  eng.notify = () => {};
  return { eng, store };
}
const addPos = (store, { mirrorOf = '999', openedTs = Date.now() - 3600_000, liquidity = '1000', venue = 'v4' } = {}) => Number(store.run(
  `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
   VALUES(?,?,?,?,?,3000,60,?,-600,600,?,?,?,'open',?,10,'USDG')`,
  venue, String(Math.floor(Math.random() * 1e9)), POOL, ADDR.usdg, MEME, ADDR.native, liquidity, TARGET, mirrorOf, openedTs).lastInsertRowid);
const addAct = (store, over = {}) => {
  const a = { ts: Date.now(), block: 5000, txHash: '0x' + Math.random().toString(16).slice(2), logIndex: 3, target: TARGET, venue: 'v4', kind: 'decrease',
    tokenId: '999', poolRef: POOL, tickLower: -600, tickUpper: 600, liquidity: '-400', ...over };
  a.id = Number(store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,tick_lower,tick_upper,liquidity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId, a.poolRef, a.tickLower, a.tickUpper, a.liquidity).lastInsertRowid);
  return a;
};

(async () => {
  console.log('Pembacaan likuiditas target:\n');

  await t('v4 reconciliation: node answers 0 for a 1-minute-old mirror → NOT closed; a 1-hour mirror → closed', async () => {
    const { eng, store } = engineWith(async (c) => c.map(() => word(0)));
    const fresh = addPos(store, { mirrorOf: '1', openedTs: Date.now() - 60_000 });
    const old = addPos(store, { mirrorOf: '2' });
    const closed = [];
    eng.executeExit = async (plan, pos) => { closed.push(pos.id); return { note: 'ok' }; };
    await eng.reconcileExits(); await eng.reconcileExits(); await eng.reconcileExits();
    assert.deepStrictEqual(closed, [old]);
    assert.ok(!closed.includes(fresh));
  });

  await t('partial withdrawal read at the action\'s block: target withdraws 40% then closes fully later → mirror withdrawn 40%, not closed', async () => {
    const tags = [];
    const { eng, store } = engineWith(async (c, tag) => { tags.push(tag); return c.map(() => word(tag === 'latest' ? 0 : 600)); });
    addPos(store, { liquidity: '1000' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(addAct(store), eng.rulesFrom(TARGET));
    assert.deepStrictEqual(tags, ['0x1388']);
    assert.strictEqual(plan.full, false);
    assert.strictEqual(plan.liquidity, '400');
  });

  await t('node does not have that block\'s state (throws) → falls back to latest', async () => {
    const tags = [];
    const { eng, store } = engineWith(async (c, tag) => { tags.push(tag); if (tag !== 'latest') throw new Error('eth_call tidak terbaca dari RPC: missing trie node'); return c.map(() => word(600)); });
    addPos(store, { liquidity: '1000' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(addAct(store), eng.rulesFrom(TARGET));
    assert.deepStrictEqual(tags, ['0x1388', 'latest']);
    assert.strictEqual(plan.liquidity, '400');
  });

  await t('two target withdrawals in the same block: the first action is computed from the state before the second action', async () => {
    // target L 1000 → withdraw 400 (log 3) → withdraw 300 (log 7). State at block = 300.
    const { eng, store } = engineWith(async (c) => c.map(() => word(300)));
    addPos(store, { liquidity: '1000' });
    const first = addAct(store, { logIndex: 3, liquidity: '-400' });
    addAct(store, { logIndex: 7, liquidity: '-300' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(first, eng.rulesFrom(TARGET));
    assert.strictEqual(plan.liquidity, '400', 'before = 300 + 300 + 400 = 1000 → 40%');
  });

  await t('strict eth_call: revert → null; "block not found" → throws (not taken as an NFT burned)', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false });
    p.batch = async () => [{ error: { code: 3, message: 'execution reverted: NOT_MINTED' } }];
    assert.deepStrictEqual(await p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10', { strict: true }), [null]);
    p.batch = async () => [{ error: { code: -32000, message: 'block not found' } }];
    await assert.rejects(p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10', { strict: true }), /tidak terbaca/);
    assert.deepStrictEqual(await p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10'), [null], 'non-strict stays null');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
