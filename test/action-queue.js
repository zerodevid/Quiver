'use strict';
// Test: scans & exit signals are not blocked by a slow entry.
// Previously the tick waited for each action to finish — one entry (zap, approval, 90 s receipt)
// held up scanning for minutes, and the target's withdrawal in the next block came too late.
// Run: node test/action-queue.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const act = (kind, tokenId, block) => ({ ts: Date.now(), block, txHash: '0x' + block.toString(16).padStart(64, '0'), logIndex: 1, target: TARGET, venue: 'v4', kind, tokenId, liquidity: kind === 'increase' ? '10' : '-10' });

function engineWith() {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const eng = new Engine({ rpc: { allCooling: () => false, call: async () => null, ethCallMany: async (c) => c.map(() => null) }, store, chain: {}, cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xme';
  eng.notify = () => {};
  eng.cursor = 0; eng.span = 100;
  let head = 100;
  eng.rpc.safeHead = async () => ({ min: head, max: head, spread: 0 });
  const seen = [];
  const gates = [];
  eng.handleEntry = (a) => new Promise((res) => { seen.push(`entry:${a.tokenId}`); gates.push(() => { eng.decide(a.id, 'copy', 'uji'); res(); }); });
  eng.handleExit = async (a) => { seen.push(`exit:${a.tokenId}`); eng.decide(a.id, 'copy', 'uji keluar'); };
  let batch = [];
  eng.watcher.scan = async () => { const b = batch; batch = []; return b; };
  return { eng, store, seen, gates, next: (acts) => { batch = acts; head += 100; } };
}

(async () => {
  console.log('Action queue:\n');

  await t('hanging entry: the next tick still scans, and exit signals are processed without waiting for the entry', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 50)]);
    await h.eng.tick();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(h.seen, ['entry:1']);
    assert.strictEqual(h.eng.busy, false, 'scanning is no longer busy even though the entry is still running');
    h.next([act('decrease', '7', 150)]);
    await h.eng.tick();
    await h.eng.pumps.exit;
    assert.deepStrictEqual(h.seen, ['entry:1', 'exit:7']);
    assert.ok(h.eng.cursor >= 200, 'kursor maju dua kali');
    assert.strictEqual(h.eng.idle(), false, 'a hanging entry holds up the drain');
    h.gates.shift()();
    await h.eng.settled();
    assert.strictEqual(h.eng.idle(), true);
  });

  await t('within one range: exits are handled first, entries one at a time', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 10), act('increase', '2', 11), act('decrease', '3', 12)]);
    await h.eng.tick();
    await h.eng.pumps.exit;
    assert.deepStrictEqual([...h.seen].sort(), ['entry:1', 'exit:3'], 'exit does not wait for entry:1; entry:2 has not started');
    h.gates.shift()();
    await new Promise((r) => setTimeout(r, 10));
    assert.deepStrictEqual(h.seen.slice(2), ['entry:2']);
    h.gates.shift()();
    await h.eng.settled();
  });

  await t('stopping (deploy): the queue does not start, actions are stored without a decision for backfill', async () => {
    const h = engineWith();
    h.next([act('increase', '1', 10), act('increase', '2', 11)]);
    await h.eng.tick();
    h.eng.stopping = true;
    h.gates.shift()();
    await h.eng.settled();
    assert.deepStrictEqual(h.seen, ['entry:1']);
    assert.strictEqual(h.store.get('SELECT COUNT(*) n FROM actions a LEFT JOIN decisions d ON d.action_id=a.id WHERE d.id IS NULL').n, 1);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
