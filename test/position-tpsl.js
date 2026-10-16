'use strict';
// Test: per-position take profit / stop loss.
//  - sl_pct / tp_pct (NULL = follow the rules, 0 = off, >0 = threshold) win over the rules.
//  - a trigger from a per-position value is marked `own`; one from the rules is not.
//  - Manual.setExit validates, persists, and updates the sync cache at once.
// Run: node test/position-tpsl.js
const assert = require('node:assert');
const { Positions } = require('../src/positions');
const { Manual } = require('../src/manual');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  FAIL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

const rules = (sl, tp) => ({ exit: { stop_loss_pct: sl, take_profit_pct: tp, max_age_hours: 0, out_of_range_pct: 0, out_of_range_minutes: 0 } });
function triggers(pos, r) {
  const p = Object.create(Positions.prototype);
  p.live = [{ id: 1, pnlPct: 0, inRange: true, ageHours: 1, sl_pct: null, tp_pct: null, ...pos }];
  p.farStreak = new Map();
  p.store = { getState: () => 0, setState: () => {} };
  return p.exitTriggers(() => r);
}

(async () => {
  await t('no per-position value: rules decide, trigger is not own', () => {
    const [x] = triggers({ pnlPct: -12 }, rules(10, 0));
    assert.ok(x && /^stop loss/.test(x.reason) && !x.own);
  });
  await t('per-position stop loss fires with no rules and is own', () => {
    const [x] = triggers({ pnlPct: -6, sl_pct: 5 }, rules(0, 0));
    assert.ok(x && x.own);
  });
  await t('per-position stop loss overrides a looser rule', () => {
    assert.strictEqual(triggers({ pnlPct: -6, sl_pct: 5 }, rules(20, 0)).length, 1);
  });
  await t('per-position 0 switches off a rule-level stop loss', () => {
    assert.strictEqual(triggers({ pnlPct: -50, sl_pct: 0 }, rules(10, 0)).length, 0);
  });
  await t('per-position take profit fires and is own; below it nothing fires', () => {
    assert.ok(triggers({ pnlPct: 8, tp_pct: 8 }, rules(0, 0))[0]?.own);
    assert.strictEqual(triggers({ pnlPct: 7.9, tp_pct: 8 }, rules(0, 0)).length, 0);
  });
  await t('stale value never triggers a per-position stop loss', () => {
    assert.strictEqual(triggers({ pnlPct: -90, sl_pct: 5, valueStale: true }, rules(0, 0)).length, 0);
  });

  const store = new Store(':memory:');
  store.run(`INSERT INTO positions(venue,pool_ref,status,target,mirror_of,opened_ts) VALUES('v4','0xab','open','0xt','55',1)`);
  const live = { id: 1, sl_pct: null, tp_pct: null };
  const engine = { positions: { live: [live] }, rulesFrom: () => rules(0, 0), dryRun: () => false };
  const manual = new Manual({ engine, store, chain: { network: 'robinhood' } });
  const row = () => store.get('SELECT sl_pct, tp_pct FROM positions WHERE id=1');

  await t('setExit stores values and refreshes the sync cache', () => {
    manual.setExit(1, { slPct: 7.5, tpPct: 40 });
    assert.deepStrictEqual({ ...row() }, { sl_pct: 7.5, tp_pct: 40 });
    assert.strictEqual(live.sl_pct, 7.5);
  });
  await t('setExit leaves an omitted side alone; null returns it to the rules', () => {
    manual.setExit(1, { slPct: null });
    assert.deepStrictEqual({ ...row() }, { sl_pct: null, tp_pct: 40 });
  });
  await t('setExit rejects out-of-range numbers', () => {
    assert.throws(() => manual.setExit(1, { slPct: 100 }), /stop loss/);
    assert.throws(() => manual.setExit(1, { tpPct: -1 }), /take profit/);
    assert.throws(() => manual.setExit(1, { slPct: 'abc' }), /stop loss/);
  });
  await t('setExit refuses a closed or unknown position', () => {
    assert.throws(() => manual.setExit(99, { slPct: 5 }), /tidak ditemukan/);
    store.run("UPDATE positions SET status='closed' WHERE id=1");
    assert.throws(() => manual.setExit(1, { slPct: 5 }), /tertutup/);
  });
  await t('exitInfo reports copy origin and the rule-level thresholds', () => {
    store.run("UPDATE positions SET status='open' WHERE id=1");
    const i = manual.exitInfo(1);
    assert.ok(i.isCopy && i.tpPct === 40 && i.slPct === null && i.rules.stopLossPct === 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
