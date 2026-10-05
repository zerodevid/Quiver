'use strict';
// Test: a stale ENTRY signal is not copied, an EXIT signal is still followed.
//
// Case: VPS/RPC down for an hour. The cursor resumes from the stored block, the scan catches up
// and finds the target's entry from an hour ago. It used to open that entry right away at the
// current price (zap + mint), then close it again as soon as the exit signal was read — double the cost.
//
// Run: node test/stale-signal.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const POOL = '0x' + 'ab'.repeat(32);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const SENTINEL = 'lolos-gerbang-basi';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

function engineWith({ loop = {}, block = null, dryRun = false } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const calls = [];
  const rpc = {
    call: async (method, params) => {
      calls.push(method);
      if (method === 'eth_getBlockByNumber') return typeof block === 'function' ? block(params[0]) : block;
      return null;
    },
    ethCallMany: async (c) => c.map(() => null),
  };
  const eng = new Engine({ rpc, store, chain: {}, cfg: { mode: { dry_run: dryRun }, gas: {}, loop, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
  eng.notify = () => {};
  // First step of handleEntry after the gate: if we get here, the signal is considered fresh.
  eng.refreshActionState = async () => { throw new Error(SENTINEL); };
  let entries = 0;
  eng.executeEntry = async () => { entries++; return { txHash: '0x1', positionId: 1, note: '' }; };
  return { eng, store, calls, entries: () => entries };
}

const entryAct = (over = {}) => ({
  ts: Date.now() - 3600_000, block: 1000, txHash: '0x' + 'e'.repeat(64), logIndex: 1, target: TARGET, venue: 'v4', kind: 'increase',
  tokenId: '42', poolRef: POOL, poolKey: { currency0: ADDR.usdg, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
  token0: ADDR.usdg, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native, tickLower: -600, tickUpper: 600,
  liquidity: '1000000', amount0: '0', amount1: '0', valueQuote: null, quoteSymbol: 'USDG', slot0: null, ...over,
});
const decision = (store) => store.get('SELECT verdict, reason FROM decisions ORDER BY id DESC LIMIT 1');
const blockAt = (msAgo) => ({ number: '0x3e8', timestamp: '0x' + Math.floor((Date.now() - msAgo) / 1000).toString(16) });

(async () => {
  console.log('Stale entry signal:\n');

  await t('target entry an hour ago (confirmed by block timestamp) → skipped "stale", no execution', async () => {
    const { eng, store, calls, entries } = engineWith({ block: blockAt(3600_000) });
    const [id] = [store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind) VALUES(?,?,?,?,?,?,?)`,
      Date.now() - 3600_000, 1000, '0xa', 1, TARGET, 'v4', 'increase').lastInsertRowid];
    await eng.handle(entryAct({ id: Number(id) }));
    const d = decision(store);
    assert.strictEqual(d.verdict, 'skip');
    assert.match(d.reason, /sinyal masuk basi/);
    assert.match(d.reason, /1 jam/);
    assert.strictEqual(entries(), 0);
    assert.ok(calls.includes('eth_getBlockByNumber'), 'the age is confirmed from the real block');
  });

  await t('fresh entry (30 s) → passes the gate without an extra RPC call', async () => {
    const { eng, calls } = engineWith();
    await assert.rejects(eng.handleEntry(entryAct({ ts: Date.now() - 30_000 }), eng.rulesFrom(TARGET)), new RegExp(SENTINEL));
    assert.ok(!calls.includes('eth_getBlockByNumber'));
  });

  await t('the ts estimate says stale but the real block timestamp is fresh → NOT discarded', async () => {
    const { eng } = engineWith({ block: blockAt(20_000) });
    await assert.rejects(eng.handleEntry(entryAct({ ts: Date.now() - 400_000 }), eng.rulesFrom(TARGET)), new RegExp(SENTINEL));
  });

  await t('block unreadable from the RPC → the ts estimate is used', async () => {
    const { eng, store } = engineWith({ block: () => { throw new Error('429'); } });
    store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind) VALUES(7,?,1000,'0xb',1,?,'v4','increase')`, Date.now(), TARGET);
    await eng.handleEntry(entryAct({ id: 7, ts: Date.now() - 900_000 }), eng.rulesFrom(TARGET));
    assert.match(decision(store).reason, /sinyal masuk basi — target masuk 15 mnt lalu \(batas 5 mnt\)/);
  });

  await t('the limit can be set (loop.stale_action_seconds) and 0 = off', async () => {
    const a = engineWith({ loop: { stale_action_seconds: 60 }, block: blockAt(90_000) });
    a.store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind) VALUES(1,?,1000,'0xc',1,?,'v4','increase')`, Date.now(), TARGET);
    await a.eng.handleEntry(entryAct({ id: 1, ts: Date.now() - 90_000 }), a.eng.rulesFrom(TARGET));
    assert.match(decision(a.store).reason, /basi/);
    const b = engineWith({ loop: { stale_action_seconds: 0 } });
    await assert.rejects(b.eng.handleEntry(entryAct({ ts: Date.now() - 86400_000 }), b.eng.rulesFrom(TARGET)), new RegExp(SENTINEL));
  });

  await t('simulation mode also flags stale (the preview is the same as LIVE)', async () => {
    const { eng, store } = engineWith({ dryRun: true, block: blockAt(3600_000) });
    store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind) VALUES(3,?,1000,'0xd',1,?,'v4','increase')`, Date.now(), TARGET);
    await eng.handleEntry(entryAct({ id: 3 }), eng.rulesFrom(TARGET));
    assert.strictEqual(decision(store).verdict, 'skip');
  });

  await t('tick catching up on a lag: an old entry is skipped, an old EXIT in the same range is still followed', async () => {
    const { eng, store, entries } = engineWith({ block: blockAt(3600_000) });
    eng.cursor = 900; eng.span = 1500;
    eng.rpc.allCooling = () => false;
    eng.rpc.safeHead = async () => ({ min: 2000, max: 2020, spread: 20 });
    const exits = [];
    eng.handleExit = async (act) => { exits.push(act.tokenId); eng.decide(act.id, 'copy', 'uji keluar'); };
    eng.watcher.scan = async () => [
      entryAct({ tokenId: '42', logIndex: 1 }),
      { ...entryAct({ tokenId: '41', logIndex: 2 }), kind: 'decrease', liquidity: '-1000000', txHash: '0x' + 'f'.repeat(64) },
    ];
    await eng.tick();
    await eng.settled();
    const rows = store.all('SELECT a.kind, d.verdict, d.reason FROM actions a JOIN decisions d ON d.action_id=a.id ORDER BY a.log_index');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].kind, 'increase'); assert.strictEqual(rows[0].verdict, 'skip'); assert.match(rows[0].reason, /basi/);
    assert.deepStrictEqual(exits, ['41']);
    assert.strictEqual(entries(), 0);
    assert.strictEqual(eng.cursor, 2000);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
