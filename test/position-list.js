'use strict';
// Test GET /api/positions — the open position list for the Positions page and the
// "Active positions" panel on the Summary.
//
// The list MUST come from the database, not from the sync cache (`engine.positions.live`)
// that is only refreshed every 30 seconds. It used to come from the cache, so: after a restart
// the table was empty until the first sync finished, a freshly minted position only appeared
// half a minute later, and a freshly closed position was still shown.
//
// Run: node test/position-list.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function world({ live = [], lastSync = T0, resync } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-daftar-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  // `positions` here imitates Positions: `live`/`lastSync` are the last sync
  // result, and `resync` reads the chain again then updates them.
  const pos = { live, lastSync, resync: null };
  pos.resync = resync ? () => resync(pos) : async () => { pos.lastSync = Date.now(); };
  const engine = {
    cfg, store, ethUsd: 2500, positions: pos, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
    freshCash: async () => null, refreshCash: async () => null,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api, pos };
}

// One open position in the DB; not necessarily synced yet.
function open(store, id, { cost = 200, opened = T0 } = {}) {
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,
      status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open)
    VALUES(?,'v4',?,?,?,?,3000,-60,60,'1000','open',?,'0','0',?,'USDG',?)`,
  id, String(2_000_000 + id), POOL, ADDR.usdg, MEME, opened, cost, '0xmint' + id);
}

function close(store, id, { out = 250, target = null, mirrorOf = null } = {}) {
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,opened_ts,closed_ts,
      cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close,target,mirror_of)
    VALUES(?,'v4',?,?,?,?,3000,'closed',?,?,'0','0',200,?,'USDG',?,?,?,?)`,
  id, String(2_000_000 + id), POOL, ADDR.usdg, MEME, T0, T0 + 60_000, out, '0xmint' + id, '0xburn' + id,
  target, mirrorOf);
}

// A target wallet along with one of its positions, as left behind by the research
// scan — the source of the "target PnL" figure in the closed positions table.
function target(store, address, label) {
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', address, label, T0);
}
function researchPosition(store, wallet, tokenId, { invested = 1000, pnl = 50, status = 'closed', quote = 'USDG' } = {}) {
  store.run(`INSERT INTO wpositions(wallet,venue,token_id,pool_ref,token0,token1,fee,status,
      opened_ts,closed_ts,invested_q,pnl_q,quote_symbol)
    VALUES(?,'v4',?,?,?,?,3000,?,?,?,?,?,?)`,
  wallet, tokenId, POOL, ADDR.usdg, MEME, status, T0, status === 'closed' ? T0 + 90_000 : null,
  invested, pnl, quote);
}

// Shape of a sync result row, just enough for this test.
const syncResult = (id, extra = {}) => ({
  id, venue: 'v4', token_id: String(2_000_000 + id), pool_ref: POOL, token0: ADDR.usdg, token1: MEME,
  symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, tick_lower: -60, tick_upper: 60, curTick: 0,
  inRange: true, valueUsd: 210, feeUsd: 4, costUsd: 200, pnlUsd: 14, pnlPct: 7, empty: false, ...extra,
});

(async () => {
  console.log('position list');

  await t('a freshly minted position shows right away, marked not yet synced', async () => {
    const { store, api } = world();            // sync cache empty
    open(store, 7, { cost: 150 });
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 1, 'a position in the DB must be listed');
    const p = r.positions[0];
    assert.equal(p.id, 7);
    assert.equal(p.syncing, true, 'must be marked syncing so the UI does not present an estimated figure as certain news');
    assert.equal(p.symbol0, 'USDG');
    assert.equal(p.symbol1, 'MEME');
    assert.equal(p.costUsd, 150);
    assert.equal(p.valueUsd, 150, 'before sync, value = capital');
    assert.equal(p.feeUsd, 0);
    assert.equal(p.ilUsd, null);
  });

  await t('after a restart, the list is not empty although the first sync has not run', async () => {
    const { store, api } = world({ lastSync: 0 });
    open(store, 1); open(store, 2);
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 2);
    assert.equal(r.syncedAt, 0, 'syncedAt 0 = the first sync is not finished; the UI uses it for an indicator');
    assert.ok(r.positions.every((p) => p.syncing));
  });

  await t('a position already synced uses figures from the chain, without the syncing flag', async () => {
    const { store, api } = world({ live: [syncResult(3)] });
    open(store, 3);
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 1);
    const p = r.positions[0];
    assert.ok(!p.syncing);
    assert.equal(p.valueUsd, 210);
    assert.equal(p.feeUsd, 4);
    assert.equal(p.inRange, true);
    assert.equal(r.syncedAt, T0);
  });

  await t('a freshly closed position disappears right away, not waiting for the next sync', async () => {
    // The sync cache still holds #4 (stale): the DB already says closed.
    const { store, api } = world({ live: [syncResult(4)] });
    close(store, 4, { out: 250 });
    const r = await api('GET', '/api/positions', {}, {});
    assert.equal(r.positions.length, 0, 'a closed position must not be in the open list');
    assert.equal(r.closed.length, 1);
    assert.equal(r.closed[0].symbol0, 'USDG', 'a closed position still gets its symbol decorated');
    assert.equal(r.closed[0].symbol1, 'MEME');
  });

  await t('mixed: one synced, one new, one just closed', async () => {
    const { store, api } = world({ live: [syncResult(5), syncResult(6)] });
    open(store, 5); open(store, 6);
    // #6 closed after the last sync: the DB is already 'closed', the cache still holds it.
    store.run("UPDATE positions SET status='closed', closed_ts=?, out_quote=250 WHERE id=6", T0 + 120_000);
    open(store, 8, { opened: T0 + 60_000 });           // #8 minted after the last sync
    const r = await api('GET', '/api/positions', {}, {});
    assert.deepEqual(r.positions.map((p) => p.id), [5, 8]);
    assert.equal(r.positions.find((p) => p.id === 5).syncing, undefined);
    assert.equal(r.positions.find((p) => p.id === 8).syncing, true);
  });

  await t('the detail of a position not yet synced is also marked', async () => {
    const { store, api } = world();
    open(store, 9);
    const r = await api('GET', '/api/position', {}, { id: '9' });
    assert.equal(r.position.id, 9);
    assert.equal(r.position.syncing, true);
  });

  await t('the detail of a closed position is not marked syncing', async () => {
    const { store, api } = world();
    close(store, 11);
    const r = await api('GET', '/api/position', {}, { id: '11' });
    assert.equal(r.position.syncing, false);
  });

  // ---- the "Refresh" button in the table header --------------------------------------
  // Without this, the button only refetches the SAME sync result — which can be
  // 30 seconds old — and returns exactly the same figures. A button that blinks
  // and then changes nothing is worse than no button: the user
  // thinks the figures on screen were just confirmed, when they were not.
  await t('Refresh reads the chain again, not repeating the old sync result', async () => {
    let dibaca = 0;
    const { api, pos } = world({
      lastSync: T0,
      resync: async (p) => { dibaca++; p.live = [syncResult(12, { valueUsd: 999 })]; p.lastSync = T0 + 60_000; },
    });
    const r = await api('POST', '/api/positions/sync', {}, {});
    assert.equal(dibaca, 1, 'must really order a sync, not just reply');
    assert.equal(r.ok, true);
    assert.equal(r.syncedAt, T0 + 60_000, 'the sync time replied must be the new one');
    assert.equal(pos.live[0].valueUsd, 999);
  });

  await t('sync failed: its error is reported, the table keeps the old figures', async () => {
    const { store, api } = world({
      live: [syncResult(13)], lastSync: T0,
      resync: async () => { throw new Error('RPC 429'); },
    });
    open(store, 13);
    const r = await api('POST', '/api/positions/sync', {}, {});
    assert.equal(r.error, 'RPC 429');
    assert.equal(r.syncedAt, T0, 'the sync time must not advance if the chain is unreadable');
    const list = await api('GET', '/api/positions', {}, {});
    assert.equal(list.positions[0].valueUsd, 210, 'the last known figures are still presented');
  });

  await t('the closed-table PnL in USD is the same as the detail for WETH, ETH, and USDG', async () => {
    for (const quote of ['WETH', 'ETH', 'USDG']) {
      const { store, api } = world();
      close(store, 30);
      const k = quote === 'USDG' ? 1 : 2500;
      store.run('UPDATE positions SET cost_quote=?, out_quote=?, quote_symbol=? WHERE id=30', 100.26 / k, 38.83 / k, quote);
      const c = (await api('GET', '/api/positions', {}, {})).closed[0];
      const detail = (await api('GET', '/api/position', {}, { id: '30' })).position;
      assert.ok(Math.abs(c.costUsd - 100.26) < 1e-9);
      assert.ok(Math.abs(c.outUsd - 38.83) < 1e-9);
      assert.ok(Math.abs(c.pnlUsd + 61.43) < 1e-9);
      assert.equal(c.pnlUsd, detail.pnlUsd);
      assert.equal(c.pnlPct, detail.pnlPct);
    }
  });

  // ---- position origin: who was copied, and how the original did --------------
  // The closed positions table sets our PnL beside the PnL of the target position we
  // mirror. Without it, the only way to compare the two is to open the
  // target page in another tab and match NFT numbers by eye.
  const PAUS = '0x' + 'e1'.repeat(20);

  await t('a copy position carries the target label and the original position\'s figures', async () => {
    const { store, api } = world();
    target(store, PAUS, 'Paus CME');
    researchPosition(store, PAUS, '2302256', { invested: 1000, pnl: 59.12 });
    close(store, 20, { out: 221.84, target: PAUS, mirrorOf: '2302256' });
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.equal(c.targetLabel, 'Paus CME');
    assert.equal(c.mirror.tokenId, '2302256');
    assert.equal(c.mirror.costUsd, 1000);
    assert.ok(Math.abs(c.mirror.pnlUsd - 59.12) < 1e-9);
    assert.ok(Math.abs(c.mirror.pnlPct - 5.912) < 1e-9, 'the percent is computed from the target\'s capital, not ours');
    assert.equal(c.mirror.stale, false, 'the target position has closed — its figures are final');
  });

  await t('a still-open target position is marked, because its figures come from the last scan', async () => {
    const { store, api } = world();
    target(store, PAUS, null);
    researchPosition(store, PAUS, '2481984', { invested: 800, pnl: -40, status: 'open' });
    close(store, 21, { out: 232.58, target: PAUS, mirrorOf: '2481984' });
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.equal(c.targetLabel, null, 'a target without a label is still valid — the UI falls back to a short address');
    assert.equal(c.mirror.status, 'open');
    assert.equal(c.mirror.stale, true);
    assert.equal(c.mirror.pnlUsd, -40);
  });

  await t('a WETH-quoted target position: research figures are already USD, not multiplied by the ETH price again', async () => {
    // lp2 #2: target "Smart LP" capital $30,001 showed as $75 million because ETH's price was multiplied twice.
    const { store, api } = world();
    target(store, PAUS, 'Smart LP');
    researchPosition(store, PAUS, '1152470', { invested: 30001.33, pnl: 11761.05, quote: 'WETH' });
    close(store, 26, { out: 232.58, target: PAUS, mirrorOf: '1152470' });
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.ok(Math.abs(c.mirror.costUsd - 30001.33) < 1e-9, `capital ${c.mirror.costUsd}`);
    assert.ok(Math.abs(c.mirror.pnlUsd - 11761.05) < 1e-9, `pnl ${c.mirror.pnlUsd}`);
  });

  await t('a target not yet researched: its source is still named, its figures empty', async () => {
    const { store, api } = world();
    target(store, PAUS, 'Sniper kecil');
    close(store, 22, { target: PAUS, mirrorOf: '2468552' });     // wpositions empty
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.equal(c.targetLabel, 'Sniper kecil');
    assert.equal(c.mirror, null, 'do not invent figures for a wallet that has never been scanned');
  });

  await t('a manual position copies no one', async () => {
    const { store, api } = world();
    close(store, 23);
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.equal(c.target, null);
    assert.equal(c.targetLabel, null);
    assert.equal(c.mirror, null);
  });

  // Target positions are keyed by (wallet, venue, token_id): the same NFT number in
  // another wallet must not leak in as this position's "target result".
  await t('the same NFT number owned by another wallet does not come along', async () => {
    const { store, api } = world();
    target(store, PAUS, 'Paus CME');
    researchPosition(store, '0x' + '77'.repeat(20), '2302256', { invested: 500, pnl: 300 });
    close(store, 24, { target: PAUS, mirrorOf: '2302256' });
    const c = (await api('GET', '/api/positions', {}, {})).closed[0];
    assert.equal(c.mirror, null);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
