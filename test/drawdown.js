'use strict';
// Test the daily drawdown breaker (engine.js: updateDrawdown/drawdownTripped/drawdownStatus).
//
// Unlike the manual pause (paused): this is automatic from equity, and only stops
// new ENTRIES — exit signals are still processed as usual.
//
// Run: node test/drawdown.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';

function harness({ pct = 10, tz } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const chain = { ethUsd: async () => 2500 };
  const cfg = { mode: { dry_run: true }, risk: { max_daily_drawdown_pct: pct }, telegram: tz ? { timezone: tz } : {}, rules: {} };
  const rpc = { blockNumber: async () => 1e6 };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  const notified = [];
  eng.notify = (msg) => notified.push(msg);
  return { eng, store, notified };
}

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n       ' + e.message.split('\n')[0]); fail++; }
}

(async () => {
  console.log('daily drawdown breaker test\n');

  await t('off (0%): the peak is still recorded but never triggered', async () => {
    const { eng, notified } = harness({ pct: 0 });
    eng.updateDrawdown(1000);
    eng.updateDrawdown(1); // plunged 99.9%
    assert.strictEqual(eng.drawdownTripped(), false);
    assert.strictEqual(notified.length, 0);
  });

  await t('falls below the limit: not yet triggered', async () => {
    const { eng, notified } = harness({ pct: 10 });
    eng.updateDrawdown(1000);
    eng.updateDrawdown(920); // -8%
    assert.strictEqual(eng.drawdownTripped(), false);
    assert.strictEqual(notified.length, 0);
  });

  await t('touches the limit: triggered once, new entries paused, news already sent', async () => {
    const { eng, notified } = harness({ pct: 10 });
    eng.updateDrawdown(1000);
    eng.updateDrawdown(890); // -11%
    assert.strictEqual(eng.drawdownTripped(), true);
    assert.strictEqual(notified.length, 1);
    assert.match(notified[0], /drawdown harian/i);
    // Equity rises again: the breaker does NOT release by itself on the same day (one-shot trigger).
    eng.updateDrawdown(1000);
    assert.strictEqual(eng.drawdownTripped(), true);
    assert.strictEqual(notified.length, 1, 'must not send the news twice');
  });

  await t('dust portfolio (peak < $1): not triggered even when down 100%', async () => {
    const { eng, notified } = harness({ pct: 10 });
    eng.updateDrawdown(0.5);
    eng.updateDrawdown(0);
    assert.strictEqual(eng.drawdownTripped(), false);
    assert.strictEqual(notified.length, 0);
  });

  await t('the peak keeps rising following the day\'s highest equity', async () => {
    const { eng } = harness({ pct: 10 });
    eng.updateDrawdown(1000);
    eng.updateDrawdown(1200);
    eng.updateDrawdown(1100); // -8.3% from the 1200 peak, not from 1000
    assert.strictEqual(eng.drawdownTripped(), false);
    const st = eng.drawdownStatus();
    assert.strictEqual(st.peakUsd, 1200);
  });

  await t('hari berganti: puncak & status tersentuh direset', async () => {
    const { eng } = harness({ pct: 10 });
    const t0 = Date.parse('2026-09-17T10:00:00Z');
    const t1 = Date.parse('2026-09-18T10:00:00Z');
    const orig = Date.now;
    Date.now = () => t0;
    eng.updateDrawdown(1000);
    eng.updateDrawdown(890);
    assert.strictEqual(eng.drawdownTripped(), true);
    Date.now = () => t1;
    assert.strictEqual(eng.drawdownTripped(), false, 'new day: a stale flag from yesterday must not keep blocking');
    eng.updateDrawdown(890); // a new day starts from here -> this is its own peak
    assert.strictEqual(eng.drawdownTripped(), false);
    assert.strictEqual(eng.drawdownStatus().peakUsd, 890);
    Date.now = orig;
  });

  await t('handle(): new entries are skipped once triggered, but exits are still processed', async () => {
    const { eng, store } = harness({ pct: 10 });
    eng.updateDrawdown(1000);
    eng.updateDrawdown(880); // -12%, tripped
    assert.strictEqual(eng.drawdownTripped(), true);

    const r = store.run(
      `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
        tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      Date.now(), 1000, '0xentry', 1, TARGET, 'v4', 'increase', '999', '0x' + 'ab'.repeat(32),
      ADDR.usdg, ADDR.native, 3000, 60, ADDR.native, -600, 600, (10n ** 18n).toString(), '0', '0', 100, 'USDG');
    await eng.handle({ id: Number(r.lastInsertRowid), kind: 'increase', target: TARGET });
    const dEntry = store.get('SELECT verdict, reason FROM decisions WHERE action_id=?', Number(r.lastInsertRowid));
    assert.strictEqual(dEntry.verdict, 'skip');
    assert.match(dEntry.reason, /drawdown harian/i);

    // Exit signal (decrease) for a position we do not have: still PROCESSED (not
    // subject to the paused/drawdown gate), its own decision (skip, not mirror) — the difference
    // from the entry above is the reason, not drawdown.
    const r2 = store.run(
      `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
        tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      Date.now(), 1001, '0xexit', 1, TARGET, 'v4', 'decrease', '999', '0x' + 'ab'.repeat(32),
      ADDR.usdg, ADDR.native, 3000, 60, ADDR.native, -600, 600, (10n ** 18n).toString(), '0', '0', 100, 'USDG');
    await eng.handle({ id: Number(r2.lastInsertRowid), kind: 'decrease', target: TARGET, liquidity: (10n ** 18n).toString() });
    const dExit = store.get('SELECT verdict, reason FROM decisions WHERE action_id=?', Number(r2.lastInsertRowid));
    assert.strictEqual(dExit.verdict, 'skip');
    assert.doesNotMatch(dExit.reason, /drawdown harian/i, 'exit must not be hit by the drawdown gate');
  });

  await t('time zone: dayKey follows telegram.timezone, not UTC', async () => {
    const { eng } = harness({ tz: 'Asia/Jakarta' }); // UTC+7
    const utcLateNight = Date.parse('2026-09-17T23:30:00Z'); // 18 Sep 06:30 WIB
    assert.strictEqual(eng.dayKey(utcLateNight), '2026-09-18');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
