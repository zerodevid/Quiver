'use strict';
// Test the public read-only API (/api/v1) and its API keys:
//  - no key / a made-up key / a revoked key are refused; the dashboard token is NOT an API key
//  - a key opens /api/v1/* only, never the dashboard /api/*
//  - key management needs the dashboard token, and a key cannot manage keys
//  - the key is stored hashed, and it is rate limited per key
//  - the endpoints return trimmed shapes (balance, positions, equity, pnl)
//
// Run: node test/api-v1.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const TOKEN = 'rahasia-akses-uji';
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function serve() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: { auth_token: TOKEN }, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-v1-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const summary = { openCount: 0, inRange: 0, exposureUsd: 0, feeUsd: 0, costUsd: 0, realizedUsd: 12.5, unrealizedUsd: 1.5, leftoverUsd: 0 };
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now(), resync: async () => {}, summary: () => summary },
    watcher: { unsupported: new Map() }, exec: { address: () => '0xabc', balances: async () => new Map() },
    leftovers: () => [], dryRun: () => true, paused: () => false, freshCash: async () => ({ usd: 100 }),
    stats: { startedAt: Date.now() }, head: 5, cursor: 5, drawdownStatus: () => null,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: { stats: () => ({}) }, log: () => {}, telegram: null });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      store, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    }));
  });
}

(async () => {
  console.log('\nAPI v1:\n');
  const s = await serve();
  const dash = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const v1 = (p, key) => fetch(`${s.base}/api/v1/${p}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });

  await t('no key and a made-up key are refused', async () => {
    assert.equal((await v1('balance')).status, 401);
    assert.equal((await v1('balance', 'lpk_dummy')).status, 401);
  });

  await t('the dashboard token is not an API key', async () => {
    assert.equal((await v1('balance', TOKEN)).status, 401);
  });

  await t('creating a key needs the dashboard token and a name', async () => {
    const no = await fetch(`${s.base}/api/apikeys`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
    assert.equal(no.status, 401);
    const empty = await (await fetch(`${s.base}/api/apikeys`, { method: 'POST', headers: dash, body: '{"name":"  "}' })).json();
    assert.ok(empty.error);
  });

  let key, id;
  await t('a created key is shown once and stored only as a hash', async () => {
    const r = await (await fetch(`${s.base}/api/apikeys`, { method: 'POST', headers: dash, body: '{"name":"sheet"}' })).json();
    assert.match(r.key, /^lpk_[A-Za-z0-9_-]{32}$/);
    key = r.key; id = r.id;
    const list = await (await fetch(`${s.base}/api/apikeys`, { headers: dash })).json();
    assert.equal(list.keys.length, 1);
    assert.ok(!JSON.stringify(list).includes(key));
    assert.ok(!JSON.stringify(s.store.all('SELECT * FROM api_keys')).includes(key));
  });

  await t('the key opens /api/v1 (Bearer and X-API-Key) but not the dashboard routes', async () => {
    assert.equal((await v1('balance', key)).status, 200);
    assert.equal((await fetch(`${s.base}/api/v1/balance`, { headers: { 'x-api-key': key } })).status, 200);
    assert.equal((await fetch(`${s.base}/api/logs`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
    assert.equal((await fetch(`${s.base}/api/apikeys`, { headers: { authorization: `Bearer ${key}` } })).status, 401);
  });

  await t('only GET is allowed and unknown endpoints are 404', async () => {
    assert.equal((await fetch(`${s.base}/api/v1/balance`, { method: 'POST', headers: { authorization: `Bearer ${key}` } })).status, 405);
    assert.equal((await v1('nope', key)).status, 404);
    assert.equal((await v1('constructor', key)).status, 404);
  });

  await t('balance has the trimmed shape', async () => {
    const b = await (await v1('balance', key)).json();
    assert.equal(b.cashUsd, 100);
    assert.equal(b.realizedUsd, 12.5);
    assert.equal(b.pnlUsd, 14);
    assert.equal(b.totalUsd, 100);
  });

  await t('positions, equity, pnl and the index answer', async () => {
    const b0 = await (await v1('balance', key)).json();
    const p = await (await v1('positions?status=all', key)).json();
    assert.deepEqual([p.open, p.closed], [[], []]);
    const e = await (await v1('equity?range=24h', key)).json();
    assert.ok(Array.isArray(e.series));
    const pnl = await (await v1('pnl', key)).json();
    assert.ok(Array.isArray(pnl.dailyUtc));
    // internal fields stay out of the cash breakdown
    assert.ok(!('ts' in (b0.cashAssets || {})));
    const idx = await (await v1('', key)).json();
    assert.ok(idx.endpoints['/api/v1/balance']);
    assert.equal((await v1('status', key)).status, 200);
  });

  await t('last-used time is recorded', async () => {
    const list = await (await fetch(`${s.base}/api/apikeys`, { headers: dash })).json();
    assert.ok(list.keys[0].lastUsedTs > 0);
  });

  await t('a revoked key is refused at once', async () => {
    const r = await (await fetch(`${s.base}/api/apikeys/revoke`, { method: 'POST', headers: dash, body: JSON.stringify({ id }) })).json();
    assert.equal(r.ok, true);
    assert.equal((await v1('balance', key)).status, 401);
  });

  await t('rate limit: the 61st request in a minute is 429 with Retry-After', async () => {
    const k = (await (await fetch(`${s.base}/api/apikeys`, { method: 'POST', headers: dash, body: '{"name":"busy"}' })).json()).key;
    let last;
    for (let i = 0; i < 61; i++) last = await v1('', k);
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  await s.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
