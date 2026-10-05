'use strict';
// Test GET /api/feed — the dashboard alert feed: target open actions and closed
// mirror positions (with PnL). The first call only gives a starting point; close items
// are only those newer than `closedAfter` and no older than 15 minutes.
//
// Run: node test/alert-feed.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const TGT = '0x' + '11'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function world() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-umpan-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
    freshCash: async () => null, refreshCash: async () => null,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TGT, 'Paus', Date.now());
  return { store, api: server.api };
}

function close(store, id, { cost = 200, out = 250, closed = Date.now(), opened = Date.now() - 3600_000, quote = 'USDG', mirrored = false } = {}) {
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,opened_ts,closed_ts,
      cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close,target,mirror_of)
    VALUES(?,'v4',?,?,?,?,3000,'closed',?,?,'0','0',?,?,?,?,?,?,?)`,
  id, String(2_000_000 + id), POOL, ADDR.usdg, MEME, opened, closed, cost, out, quote, '0xmint' + id, '0xburn' + id, TGT, '77');
  if (mirrored) {
    store.run(`INSERT INTO actions(ts,block,log_index,tx_hash,target,venue,kind,token_id) VALUES(?,1,0,?,?,'v4','decrease','77')`, closed - 5000, '0xact' + id, TGT);
    const aid = store.get('SELECT MAX(id) AS id FROM actions').id;
    store.run(`INSERT INTO decisions(action_id,ts,verdict,reason,position_id) VALUES(?,?,'copy','ikut target',?)`, aid, closed - 1000, id);
  }
}

(async () => {
  console.log('alert feed');
  await t('first call: a starting point with no items', async () => {
    const { store, api } = world();
    close(store, 1, { closed: Date.now() - 1000 });
    const r = await api('GET', '/api/feed');
    assert.deepStrictEqual(r.items, []);
    assert.ok(r.lastClosed > 0, 'lastClosed diisi');
    assert.strictEqual(r.lastId, 0);
  });
  await t('a position closed after the starting point shows up with its PnL', async () => {
    const { store, api } = world();
    const t0 = Date.now() - 10_000;
    close(store, 1, { closed: t0, mirrored: true });
    close(store, 2, { closed: t0 + 2000, cost: 100, out: 80 });
    const r = await api('GET', '/api/feed', {}, { after: 0, closedAfter: t0 });
    assert.strictEqual(r.items.length, 1);
    const it = r.items[0];
    assert.strictEqual(it.kind, 'close');
    assert.strictEqual(it.positionId, 2);
    assert.strictEqual(it.symbol1, 'MEME');
    assert.strictEqual(it.pnlUsd, -20);
    assert.strictEqual(it.pnlPct, -20);
    assert.strictEqual(it.mirrored, false);
    assert.strictEqual(it.targetLabel, 'Paus');
    assert.ok(it.ageHours > 0.9 && it.ageHours < 1.1);
  });
  await t('a close that follows the target is marked mirrored, ETH quote converted', async () => {
    const { store, api } = world();
    close(store, 1, { closed: Date.now() - 1000, cost: 0.1, out: 0.12, quote: 'WETH', mirrored: true });
    const r = await api('GET', '/api/feed', {}, { after: 0, closedAfter: 0 });
    assert.strictEqual(r.items.length, 1);
    assert.strictEqual(r.items[0].mirrored, true);
    assert.ok(Math.abs(r.items[0].pnlUsd - 50) < 1e-6);
    assert.ok(Math.abs(r.items[0].costUsd - 250) < 1e-6);
  });
  await t('an old close (>15 minutes) is not announced even though it passes the cursor', async () => {
    const { store, api } = world();
    close(store, 1, { closed: Date.now() - 20 * 60_000 });
    const r = await api('GET', '/api/feed', {}, { after: 0, closedAfter: 0 });
    assert.deepStrictEqual(r.items, []);
  });
  await t('without closedAfter: close items are not included', async () => {
    const { store, api } = world();
    close(store, 1, { closed: Date.now() - 1000 });
    const r = await api('GET', '/api/feed', {}, { after: 0 });
    assert.deepStrictEqual(r.items, []);
  });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
