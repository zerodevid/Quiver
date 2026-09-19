'use strict';
// Uji: modal tidak menganggur di posisi yang jauh dari harga.
//  - exit.out_of_range_pct: cermin yang harganya > X% di luar rentang ditutup (dua sinkron
//    berturut-turut), dan entry target yang rentangnya sejauh itu DITUNDA, bukan disalin.
//  - exit.reenter_within_pct: yang ditunda/ditutup dibuka lagi begitu harga ≤ Y% dari
//    rentang DAN posisi target masih berisi; target keluar → pantauan dilepas.
// Jalankan: node test/rentang-jauh.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Positions } = require('../src/positions');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const { validateRules } = require('../src/policy');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// Tick ↔ persen: 1.0001^d − 1. 4800 tick ≈ +61,6%; 9600 ≈ +161%.
const tickFor = (pct) => Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));

function harness({ rules = {}, tick = 0 } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const tokens = {
    [USDG]: { address: USDG, symbol: 'USDG', decimals: 6 },
    [ETH]: { address: ETH, symbol: 'ETH', decimals: 18 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const state = { tick, targetLiq: 10n ** 20n };
  const slot0 = () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(state.tick), tick: state.tick });
  const chain = {
    tokens: async (list) => list.map((a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    slot0V4: async () => slot0(), slot0V3: async () => slot0(),
    poolAgeMinutes: async () => 10_000, ethUsd: async () => 2500,
    quoteSideOf(t0, t1) {
      const q = { [USDG]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ETH]: { symbol: 'ETH', decimals: 18, kind: 'eth' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
  };
  const cfg = { mode: { dry_run: false, paused: false }, rules, gas: {}, loop: {} };
  const rpc = { ethCallMany: async (c) => c.map(() => null), call: async () => null, blockNumber: async () => 1e6 };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  eng.ethUsd = 2500;
  eng.exec.address = () => ME;
  eng.notify = () => {};
  eng.spendableCash = async () => null;
  eng.targetLiquidity = async () => ({ liquidity: state.targetLiq, atBlock: false });
  const entries = [];
  eng.executeEntry = async (plan, act) => {
    entries.push({ plan, act });
    const id = Number(store.run(
      `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
       VALUES('v4',?,?,?,?,3000,60,?,?,?,?,?,?,'open',?,10,'USDG')`,
      String(1000 + entries.length), POOL, USDG, MEME, ADDR.native, plan.tickLower, plan.tickUpper, plan.liquidity, TARGET, plan.mirrorOf, Date.now()).lastInsertRowid);
    return { txHash: '0x1', positionId: id, note: 'uji', pair: 'USDG/MEME' };
  };
  return { eng, store, state, entries };
}

// Aksi target: rentang [lo, hi) di pool USDG/MEME, seperti yang dihasilkan watcher.
function action(store, { tickLower = -600, tickUpper = 600 } = {}) {
  const a = {
    ts: Date.now(), block: 1000, txHash: '0x' + Math.random().toString(16).slice(2), logIndex: 1,
    target: TARGET, venue: 'v4', kind: 'increase', tokenId: '999',
    poolRef: POOL, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
    token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    tickLower, tickUpper, liquidity: (10n ** 20n).toString(), amount0: '0', amount1: '0', valueQuote: null, quoteSymbol: 'USDG', slot0: null,
  };
  a.id = Number(store.run(
    `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,quote_symbol)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId, a.poolRef, a.token0, a.token1, a.fee, a.tickSpacing, a.hooks,
    a.tickLower, a.tickUpper, a.liquidity, a.quoteSymbol).lastInsertRowid);
  return a;
}
const lastDecision = (store) => store.get('SELECT verdict, reason FROM decisions ORDER BY id DESC LIMIT 1');
const RULES = { exit: { out_of_range_pct: 50, reenter_within_pct: 10 }, filters: { min_target_quote_usd: 0, cooldown_seconds: 0 }, sizing: { mode: 'fixed_quote', fixed_quote_usd: 10, min_quote_usd: 0 } };

(async () => {
  console.log('Rentang jauh dari harga:\n');

  await t('jarak ke rentang: di dalam = 0; 4800 tick di atas ≈ 61,6%; sama untuk bawah', () => {
    assert.strictEqual(m.distanceFromRangePct(0, -600, 600), 0);
    assert.strictEqual(m.distanceFromRangePct(599, -600, 600), 0);
    assert.ok(Math.abs(m.distanceFromRangePct(600 + 4800 - 1, -600, 600) - 61.6) < 0.2);
    assert.ok(Math.abs(m.distanceFromRangePct(-600 - 4800, -600, 600) - 61.6) < 0.2);
    assert.ok(m.distanceFromRangePct(600 + 20000, -600, 600) > 600);
  });

  await t('pemicu keluar: 61% di luar (batas 50%) → ditutup pada sinkron KEDUA, dengan kind oor; 30% → tidak', () => {
    const store = new Store(':memory:');
    const pos = new Positions({ rpc: {}, store, chain: {}, log: () => {} });
    const mk = (id, tick) => ({ id, tick_lower: -600, tick_upper: 600, curTick: tick, inRange: false, empty: false, pnlPct: 0, ageHours: 1 });
    const rules = { exit: { out_of_range_pct: 50, out_of_range_minutes: 0, stop_loss_pct: 0, take_profit_pct: 0, max_age_hours: 0 } };
    pos.live = [mk(1, 600 + tickFor(61)), mk(2, 600 + tickFor(30))];
    assert.deepStrictEqual(pos.exitTriggers(rules), [], 'sinkron pertama: baru dicatat');
    const outs = pos.exitTriggers(rules);
    assert.deepStrictEqual(outs.map((o) => o.pos.id), [1]);
    assert.strictEqual(outs[0].kind, 'oor');
    assert.match(outs[0].reason, /di luar rentang 6\d% dari harga \(batas 50%\)/);
    // Kembali mendekat di antara dua sinkron: hitungan diulang dari nol.
    pos.live = [mk(1, 600 + tickFor(30))];
    pos.exitTriggers(rules);
    pos.live = [mk(1, 600 + tickFor(61))];
    assert.deepStrictEqual(pos.exitTriggers(rules), []);
  });

  await t('entry target 161% di atas harga → DITUNDA (skip) dan posisi target dipantau', async () => {
    const { eng, store, entries } = harness({ rules: RULES, tick: -(600 + tickFor(161)) });
    await eng.handle(action(store));
    const d = lastDecision(store);
    assert.strictEqual(d.verdict, 'skip');
    assert.match(d.reason, /rentang 16\d% dari harga \(batas 50%\) — ditunda; dibuka begitu harga ≤ 10% dari rentang/);
    assert.strictEqual(entries.length, 0);
    const w = eng.reentryWatches();
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].tokenId, '999'); assert.strictEqual(w[0].why, 'ditunda');
  });

  await t('tanpa buka-lagi: entry jauh tetap dilewati, tapi tidak ada pantauan', async () => {
    const { eng, store } = harness({ rules: { ...RULES, exit: { out_of_range_pct: 50, reenter_within_pct: 0 } }, tick: -(600 + tickFor(161)) });
    await eng.handle(action(store));
    assert.match(lastDecision(store).reason, /tidak disalin$/);
    assert.strictEqual(eng.reentryWatches().length, 0);
  });

  await t('entry 30% di luar (di bawah batas) → disalin seperti biasa (posisi satu sisi)', async () => {
    const { eng, store, entries } = harness({ rules: RULES, tick: -(600 + tickFor(30)) });
    await eng.handle(action(store));
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(entries.length, 1);
  });

  await t('buka lagi: harga masih 40% dari rentang → menunggu; ≤ 10% → aksi reentry + posisi dibuka, pantauan dilepas', async () => {
    const { eng, store, state, entries } = harness({ rules: RULES, tick: -(600 + tickFor(161)) });
    await eng.handle(action(store));
    state.tick = -(600 + tickFor(40));
    await eng.reentryTick();
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(eng.reentryWatches().length, 1, 'masih dipantau');
    state.tick = -(600 + tickFor(8));
    await eng.reentryTick();
    assert.strictEqual(entries.length, 1, 'dibuka lagi');
    assert.strictEqual(entries[0].act.kind, 'reentry');
    assert.strictEqual(entries[0].plan.mirrorOf, '999');
    const a = store.get("SELECT * FROM actions WHERE kind='reentry'");
    assert.ok(a && a.token_id === '999' && a.liquidity === (10n ** 20n).toString(), 'aksi sintetis memakai likuiditas target sekarang');
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(eng.reentryWatches().length, 0);
    // Cermin sudah terbuka: tick berikutnya tidak membuka lagi.
    await eng.reentryTick();
    assert.strictEqual(entries.length, 1);
  });

  await t('buka lagi: target sudah keluar (likuiditas 0) → pantauan dilepas tanpa entry', async () => {
    const { eng, store, state, entries } = harness({ rules: RULES, tick: -(600 + tickFor(161)) });
    await eng.handle(action(store));
    state.targetLiq = 0n; state.tick = 0;
    await eng.reentryTick();
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(eng.reentryWatches().length, 0);
  });

  await t('buka lagi: likuiditas target tidak terbaca → tetap dipantau, tidak bertindak', async () => {
    const { eng, store, state, entries } = harness({ rules: RULES, tick: -(600 + tickFor(161)) });
    await eng.handle(action(store));
    eng.targetLiquidity = async () => null; state.tick = 0;
    await eng.reentryTick();
    assert.strictEqual(entries.length, 0);
    assert.strictEqual(eng.reentryWatches().length, 1);
  });

  await t('ditutup karena jauh (kind oor) → dipantau; ditutup karena stop loss → tidak', async () => {
    const { eng, store } = harness({ rules: RULES });
    const id = Number(store.run(
      `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
       VALUES('v4','7',?,?,?,3000,60,?,-600,600,'5',?,'999','open',?,10,'USDG')`, POOL, USDG, MEME, ADDR.native, TARGET, Date.now() - 3600_000).lastInsertRowid);
    const pos = store.get('SELECT * FROM positions WHERE id=?', id);
    let trig = [{ pos: { ...pos, empty: false }, kind: 'oor', reason: 'di luar rentang 70% dari harga (batas 50%)' }];
    eng.positions.sync = async () => []; eng.positions.exitTriggers = () => trig; eng.positions.refreshLeftovers = async () => {};
    eng.compound.reconcile = async () => {}; eng.compound.tick = async () => {};
    eng.reconcileFeeClaims = async () => {}; eng.reconcileExits = async () => {}; eng.bookPendingMints = async () => {};
    eng.bookPendingExits = async () => {}; eng.recoverStrandedZaps = async () => {}; eng.refreshCash = async () => {};
    eng.capital.available = () => false; eng.adoptOwnPositions = async () => {}; eng.reentryTick = async () => {};
    eng.executeExit = async (plan, p) => { store.run("UPDATE positions SET status='closed' WHERE id=?", p.id); return { txHash: '0x2', note: 'ok' }; };
    await eng.syncPositionsOnce();
    assert.deepStrictEqual(eng.reentryWatches().map((w) => [w.tokenId, w.why, w.posId]), [['999', 'ditutup', id]]);
    store.run('DELETE FROM state'); store.run("UPDATE positions SET status='open' WHERE id=?", id);
    trig = [{ pos: { ...pos, empty: false }, reason: 'stop loss -20%' }];
    await eng.syncPositionsOnce();
    assert.strictEqual(eng.reentryWatches().length, 0);
  });

  await t('validasi: ambang buka-lagi ≥ ambang tutup ditolak; di bawahnya diterima', () => {
    assert.ok(validateRules({ exit: { out_of_range_pct: 50, reenter_within_pct: 50 } }).error);
    assert.ok(validateRules({ exit: { out_of_range_pct: 50, reenter_within_pct: 60 } }).error);
    assert.ok(!validateRules({ exit: { out_of_range_pct: 50, reenter_within_pct: 10 } }).error);
    assert.ok(!validateRules({ exit: { out_of_range_pct: 0, reenter_within_pct: 10 } }).error);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
