'use strict';
// Test: the "all chains" view merges every chain's replies (src/allchains.js).
//   - equity series: forward fill onto a common grid, a cash-less point voids the total
//   - overview / portfolio: USD sums, net PnL only when every chain has capital, stats weighted
//   - lists tagged with their chain and sorted; the feed cursor round-trips per chain
//   - createAllChains: default set = live chains, ?chains= overrides, primary first
// Run: node test/allchains.js
const assert = require('node:assert');
const A = require('../src/allchains');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const M = 300_000;

(async () => {
  console.log('All chains:');

  await t('mergeSeries carries each chain forward and sums, a chain adds nothing before its first point', () => {
    const a = [{ ts: 0, total: 100 }, { ts: 2 * M, total: 110 }];
    const b = [{ ts: M + 10, total: 50 }];
    const r = A.mergeSeries([a, b], { fields: ['total'] });
    assert.deepStrictEqual(r.map((x) => [x.ts, x.total]), [[0, 100], [M + 10, 150], [2 * M, 160]]);
  });

  await t('mergeSeries: two points in one bucket collapse to the later ts; strict field goes null', () => {
    const a = [{ ts: 10, cash: 1, total: 5 }];
    const b = [{ ts: 20, cash: null, total: 7 }];
    const r = A.mergeSeries([a, b], { fields: ['cash', 'total'], strict: ['cash'] });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].ts, 20);
    assert.strictEqual(r[0].cash, null);
    assert.strictEqual(r[0].total, 12);
  });

  await t('mergeOverview sums wallet value/pnl, keeps netPnl only if every chain has it, tags leftovers', () => {
    const ov = (v, net, extra = {}) => ({
      mode: { dry_run: false, paused: false, wallet: '0xw' }, wallet: { value: v, pnl: v / 10, netPnl: net },
      chain: { key: 'x', lag: 1, stuckSec: 0, lastScan: 1000 }, stats: { copied: 2, startedAt: 1 }, totals: { actions: 3 },
      summary: { openCount: 1, exposureUsd: v }, equity: [], skipReasons: [{ reason: 'r', n: 1 }], leftovers: [{ token: '0xt' }], lastSync: 5, ...extra,
    });
    const r = A.mergeOverview([
      { key: 'robinhood', label: 'RH', data: ov(100, 10) },
      { key: 'bsc', label: 'BSC', data: ov(50, null, { chain: { key: 'bsc', lag: 9, stuckSec: 3, lastScan: 500 } }) },
    ]);
    assert.strictEqual(r.wallet.value, 150);
    assert.strictEqual(r.wallet.pnl, 15);
    assert.strictEqual(r.wallet.netPnl, null);
    assert.strictEqual(r.chain.key, 'all');
    assert.strictEqual(r.chain.lag, 9);
    assert.strictEqual(r.chain.lastScan, 500);
    assert.strictEqual(r.summary.exposureUsd, 150);
    assert.strictEqual(r.stats.copied, 4);
    assert.deepStrictEqual(r.skipReasons, [{ reason: 'r', n: 2 }]);
    assert.deepStrictEqual(r.leftovers.map((l) => l.chain), ['robinhood', 'bsc']);
    assert.strictEqual(r.room, null);
    assert.strictEqual(r.byChain.length, 2);
  });

  await t('mergeOverview reports a chain that failed and still answers from the rest', () => {
    const r = A.mergeOverview([
      { key: 'robinhood', data: { mode: {}, wallet: null, chain: {}, summary: {}, equity: [] } },
      { key: 'bsc', data: { error: 'rpc down' } },
    ]);
    assert.deepStrictEqual(r.failed, [{ key: 'bsc', error: 'rpc down' }]);
    assert.deepStrictEqual(r.chain.chains, ['robinhood']);
  });

  await t('mergePortfolio: series sum, net voided without every capital, stats weighted, natives per chain', () => {
    const pf = (v, capital, stats) => ({
      range: '7d', from: 0,
      series: [{ ts: 0, cash: v / 2, pos: v / 2, fee: 0, total: v, pnl: 1, n: 1, net: capital ? 2 : undefined }, { ts: 10 * M, cash: v / 2, pos: v / 2, fee: 0, total: v + 10, pnl: 2, n: 1, net: capital ? 3 : undefined, live: true }],
      baseline: null,
      now: { value: v, pnl: 2, positionsUsd: v / 2, cash: { usd: v / 2, usdg: 10, eth: 0.01, weth: 0, ts: 1 }, netPnl: capital ? 3 : null, capitalNet: capital ? v : null },
      capital: capital ? { baselineUsd: v, capitalUsd: v, baselineTs: 5, deposits: [{ ts: 3, usd: 1 }] } : null,
      stats, closed: [[7, 1]], byTarget: [{ target: '0xa', net: 1 }],
    });
    const parts = [
      { key: 'robinhood', nativeSymbol: 'ETH', data: pf(100, true, { closedCount: 3, wins: 2, losses: 1, avgPnl: 1, best: 5, worst: -2, avgHoldHours: 2 }) },
      { key: 'bsc', nativeSymbol: 'BNB', data: pf(40, true, { closedCount: 1, wins: 0, losses: 1, avgPnl: -3, best: -3, worst: -3, avgHoldHours: 6 }) },
    ];
    const r = A.mergePortfolio(parts);
    assert.strictEqual(r.series.at(-1).total, 160);
    assert.strictEqual(r.series.at(-1).net, 6);
    assert.ok(r.series.at(-1).live);
    assert.strictEqual(r.now.value, 140);
    assert.strictEqual(r.now.netPnl, 6);
    assert.strictEqual(r.now.cash.usd, 70);
    assert.strictEqual(r.now.cash.usdg, 20);
    assert.deepStrictEqual(r.now.cash.natives.map((n) => [n.chain, n.symbol, n.usd]), [['robinhood', 'ETH', 40], ['bsc', 'BNB', 10]]);
    assert.strictEqual(r.capital.capitalUsd, 140);
    assert.deepStrictEqual(r.capital.deposits.map((x) => x.chain), ['robinhood', 'bsc']);
    assert.strictEqual(r.stats.closedCount, 4);
    assert.strictEqual(r.stats.winRatePct, 50);
    assert.strictEqual(r.stats.avgPnl, 0);
    assert.strictEqual(r.stats.avgHoldHours, 3);
    assert.strictEqual(r.stats.best, 5);
    assert.strictEqual(r.stats.worst, -3);
    assert.strictEqual(r.extremes.value.hi, 160);

    parts[1].data.capital = null;
    const r2 = A.mergePortfolio(parts);
    assert.strictEqual(r2.now.netPnl, null);
    assert.strictEqual(r2.capital, null);
    assert.ok(r2.series.every((x) => x.net == null));
  });

  await t('mergePositions / mergeList tag rows with their chain and sort newest first', () => {
    const p = A.mergePositions([
      { key: 'robinhood', data: { positions: [{ id: 1, opened_ts: 5 }], closed: [{ id: 2, closed_ts: 1 }], syncedAt: 10 } },
      { key: 'bsc', data: { positions: [{ id: 1, opened_ts: 3 }], closed: [{ id: 2, closed_ts: 9 }], syncedAt: 7 } },
    ]);
    assert.deepStrictEqual(p.positions.map((x) => x.chain), ['bsc', 'robinhood']);
    assert.deepStrictEqual(p.closed.map((x) => x.chain), ['bsc', 'robinhood']);
    assert.strictEqual(p.syncedAt, 7);
    const l = A.mergeList([
      { key: 'robinhood', data: { activity: [{ id: 1, ts: 1 }, { id: 2, ts: 4 }] } },
      { key: 'bsc', data: { activity: [{ id: 9, ts: 3 }] } },
    ], 'activity', 2);
    assert.deepStrictEqual(l.activity.map((x) => [x.chain, x.ts]), [['robinhood', 4], ['bsc', 3]]);
  });

  await t('feed cursor: first call only sets the start; later items get chain-prefixed ids', () => {
    const first = A.mergeFeed([{ key: 'robinhood', data: { lastId: 5, lastClosed: 100, items: [] } }, { key: 'bsc', data: { lastId: 2, lastClosed: 0, items: [] } }], new Map());
    assert.strictEqual(first.cursor, 'robinhood:5:100,bsc:2:0');
    const prev = A.parseCursor(first.cursor);
    assert.deepStrictEqual(prev.get('bsc'), { id: 2, ts: 0 });
    const next = A.mergeFeed([
      { key: 'robinhood', data: { lastId: 6, lastClosed: 100, items: [{ kind: 'open', id: 6, ts: 50 }] } },
      { key: 'bsc', data: { lastId: 2, lastClosed: 0, items: [{ kind: 'close', id: 'c3', ts: 70 }] } },
    ], prev);
    assert.deepStrictEqual(next.items.map((i) => i.id), ['robinhood:6', 'bsc:c3']);
    assert.strictEqual(next.cursor, 'robinhood:6:100,bsc:2:70');
  });

  await t('createAllChains: live chains by default (primary first), ?chains= overrides, sim-only = all', async () => {
    const asked = [];
    const srv = (key) => ({ api: async (m, p) => { asked.push(`${key}${p}`); return { txs: [{ id: 1, ts: key.length }] }; } });
    const servers = { bsc: srv('bsc'), robinhood: srv('robinhood'), base: srv('base') };
    const dry = { bsc: false, robinhood: false, base: true };
    const nets = Object.fromEntries(Object.keys(servers).map((k) => [k, { label: k, engine: { dryRun: () => dry[k] } }]));
    const { routes } = A.createAllChains({ servers: () => servers, nets: () => nets, primaryKey: 'robinhood' });
    await routes['GET /api/txs'](new URL('http://x/api/txs'));
    assert.deepStrictEqual(asked, ['robinhood/api/txs', 'bsc/api/txs']);
    asked.length = 0;
    const r = await routes['GET /api/txs'](new URL('http://x/api/txs?chains=base,nope'));
    assert.deepStrictEqual(asked, ['base/api/txs']);
    assert.strictEqual(r.txs[0].chain, 'base');
    asked.length = 0;
    dry.bsc = dry.robinhood = true;
    await routes['GET /api/txs'](new URL('http://x/api/txs'));
    assert.strictEqual(asked.length, 3);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
