'use strict';
// Test: a dashboard action's progress lists its own transactions — sent through a shared send
// queue like the executor's — and not those of another action running at the same time.
//
// Run: node test/progress.js
const assert = require('node:assert');
const progress = require('../src/progress');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The executor's shape: one promise queue shared by everyone, reports from inside it.
let queue = Promise.resolve();
let seq = 0;
const send = (kind) => {
  const run = queue.then(async () => {
    progress.emit({ phase: 'prepare', kind });
    await sleep(5);
    const hash = `0x${(++seq).toString(16).padStart(4, '0')}`;
    progress.emit({ phase: 'sent', kind, hash });
    return hash;
  });
  queue = run.catch(() => {});
  return run;
};
const confirm = async (hash, ok = true) => { await sleep(3); progress.emit({ phase: 'done', hash, ok }); };

(async () => {
  const a = progress.run('op-aaaa', async () => {
    const h1 = await send('zap_swap'); await confirm(h1);
    const h2 = await send('mint'); await confirm(h2);
    return { ok: true };
  });
  const b = progress.run('op-bbbb', async () => {
    const h = await send('burn'); await confirm(h, false);
    return { error: 'reverted' };
  });
  // outside any action: never recorded
  await confirm(await send('compound'));
  await Promise.all([a, b]);

  const pa = progress.get('op-aaaa');
  assert.deepStrictEqual(pa.steps.map((s) => [s.kind, s.phase, s.ok]), [['zap_swap', 'done', true], ['mint', 'done', true]]);
  assert.ok(pa.done && !pa.error);
  const pb = progress.get('op-bbbb');
  assert.deepStrictEqual(pb.steps.map((s) => [s.kind, s.ok]), [['burn', false]]);
  assert.strictEqual(pb.error, 'reverted');

  // a failed estimate marks its prepared step failed
  await progress.run('op-cccc', async () => { progress.emit({ phase: 'prepare', kind: 'approve_erc20' }); progress.fail('approve_erc20', 'execution reverted'); });
  assert.strictEqual(progress.get('op-cccc').steps[0].ok, false);

  // ids that are not ours are refused; no id = plain run
  assert.strictEqual(progress.get('../x'), null);
  assert.strictEqual(await progress.run(undefined, async () => 7), 7);
  console.log('progress: ok');
})().catch((e) => { console.error(e); process.exit(1); });
