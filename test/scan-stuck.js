'use strict';
// Test: a scan that HANGS heals itself.
// Real incident (lpcopy3, 2026-09-25): a single await inside the tick never finished,
// `busy` was never released, and every 1.5 seconds the tick came in and immediately left.
// 15 hours without a single new block scanned — no error, and the dashboard kept showing
// "lag 0" because `head` is also only updated INSIDE the tick. Two target positions were missed.
// Run: node test/scan-stuck.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function engineWith({ stuckSeconds = 0.05 } = {}) {
  const store = new Store(':memory:');
  const eng = new Engine({
    rpc: { allCooling: () => false, call: async () => null, ethCallMany: async (c) => c.map(() => null) },
    store, chain: {}, log: () => {},
    cfg: { mode: { dry_run: false }, gas: {}, rules: {}, loop: { tick_stuck_seconds: stuckSeconds } },
  });
  eng.exec.address = () => '0xme';
  const notice = [];
  eng.onNotify = (msg, detail) => notice.push({ msg, detail });
  eng.notice = notice;
  eng.cursor = 0; eng.span = 1000;
  let head = 100;
  eng.rpc.safeHead = async () => ({ min: head, max: head, spread: 0 });
  const calls = [];
  let hang = false, release = null;
  eng.watcher.scan = (from, to) => {
    calls.push([from, to]);
    if (!hang) return Promise.resolve([]);
    hang = false;                      // only one tick is hung
    return new Promise((res) => { release = () => res([]); });
  };
  return {
    eng, store, calls, notice: eng.notice,
    hung: () => { hang = true; },
    release: () => release && release(),
    setHead: (n) => { head = n; },
  };
}

(async () => {
  console.log('Scan stuck:\n');

  await t('a hanging tick is force-released after the limit, scanning runs again', async () => {
    const h = engineWith();
    h.hung();
    h.eng.tick();                       // deliberately not awaited: this tick will never finish
    await sleep(5);
    assert.strictEqual(h.eng.busy, true, 'the first tick is still hanging');

    await h.eng.tick();                 // still within the patience limit: leave it alone
    assert.strictEqual(h.eng.busy, true, 'a tick that is merely slow must not be cut');
    assert.strictEqual(h.eng.lastError, null);

    await sleep(60);
    await h.eng.tick();                 // past the limit: force release
    assert.strictEqual(h.eng.busy, false, 'flag sibuk dilepas');
    assert.match(String(h.eng.lastError), /macet/);
    assert.match(String(h.eng.lastError), /pindai blok 1-100/, 'the message names the stage that is hanging');

    h.setHead(500);
    await h.eng.tick();                 // the new cycle really scans
    assert.strictEqual(h.eng.cursor, 500);
    assert.deepStrictEqual(h.calls, [[1, 100], [1, 500]]);
  });

  await t('a stale tick that finally finishes does not move the cursor back', async () => {
    const h = engineWith();
    h.hung();
    h.eng.tick();
    await sleep(60);
    await h.eng.tick();                 // force release
    h.setHead(500);
    await h.eng.tick();                 // cursor advances to 500
    assert.strictEqual(h.eng.cursor, 500);

    h.release();                          // the old tick (range 1-100) only finishes now
    await sleep(10);
    assert.strictEqual(h.eng.cursor, 500, 'the stale tick\'s result is discarded, the cursor does not go back');
    assert.strictEqual(h.eng.busy, false, 'a stale tick does not touch the flag belonging to the new tick');
    assert.strictEqual(Number(h.store.getState('cursor:robinhood', 0)), 500);
  });

  await t('the age of the last scan is only counted from SUCCESSFUL ticks', async () => {
    const h = engineWith();
    await h.eng.tick();
    const first = h.eng.lastScanAt;
    assert.ok(first > 0);
    h.hung();
    h.eng.tick();
    await sleep(60);
    await h.eng.tick();
    assert.strictEqual(h.eng.lastScanAt, first, 'a stuck tick must not refresh this marker');
    assert.ok(h.eng.tickStuckMs() === 0, 'there is no hanging tick any more after release');
  });

  await t('the stuck state is reported (ntfy + Telegram), then closed with a recovery notice', async () => {
    const h = engineWith();
    h.hung();
    h.eng.tick();
    await sleep(60);
    await h.eng.tick();                 // force release
    assert.strictEqual(h.notice.length, 1, 'one stuck notice');
    assert.match(h.notice[0].msg, /macet.*tahap "pindai blok 1-100"/);
    assert.strictEqual(h.notice[0].detail.cursor, 0);
    // The log line is also raised to the 'warn' level — on the dashboard this is a problem, not ordinary news.
    assert.strictEqual(h.store.all('SELECT level,msg FROM logs ORDER BY id DESC LIMIT 1')[0].level, 'warn');

    h.setHead(500);
    await h.eng.tick();
    assert.strictEqual(h.notice.length, 2, 'the recovery notice follows');
    assert.match(h.notice[1].msg, /pulih/);
  });

  await t('consecutive stuck states do not flood the chat, but still go into the log', async () => {
    const h = engineWith();
    for (let i = 0; i < 3; i++) {
      h.hung();
      h.eng.tick();
      await sleep(60);
      await h.eng.tick();               // force release, with no successful scan in between
    }
    assert.strictEqual(h.notice.length, 1, 'only the first is reported (15-minute pause)');
    const row = h.store.all("SELECT msg FROM logs WHERE msg LIKE 'pemindaian macet%'");
    assert.strictEqual(row.length, 3, 'all three are still recorded');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
