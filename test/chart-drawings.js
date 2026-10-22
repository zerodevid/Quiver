'use strict';
// Test the shared chart drawing list (/api/chart/drawings) and the chart preferences
// (/api/chart/prefs) behind web/src/chartSync.js.
//
// What is guarded:
//   - drawings are merged by id: two charts saving different drawings never overwrite each other;
//   - a removal only drops the named drawing;
//   - a token with no list yet offers the old per-pool list (chart_overlays:<pool>) to adopt,
//     without the stale dataIndex the old payload carried;
//   - a malformed key or drawing is refused, and the indicator preference keeps only short names.
//
// Run: node test/chart-drawings.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const TOKEN = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function serve() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-drawings-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0 }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({
      store,
      get: async (p) => (await fetch(base + p)).json(),
      post: async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(),
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

const line = (id, value, extra = {}) => ({ id, name: 'horizontalStraightLine', points: [{ timestamp: 1, value }], unit: 'usd', updated: Date.now(), ...extra });

(async () => {
  console.log('chart drawings');
  const s = await serve();
  try {
    await t('two charts saving different drawings both survive; a removal drops only its id', async () => {
      const key = `tok:${TOKEN}`;
      assert.deepStrictEqual((await s.post('/api/chart/drawings', { key, upsert: [line('a', 1)] })).ok, true);
      await s.post('/api/chart/drawings', { key, upsert: [line('b', 2)] });
      await s.post('/api/chart/drawings', { key, upsert: [line('a', 1.5)] });
      let items = (await s.get(`/api/chart/drawings?key=${key}`)).items;
      assert.deepStrictEqual(items.map((i) => [i.id, i.points[0].value]).sort(), [['a', 1.5], ['b', 2]]);
      await s.post('/api/chart/drawings', { key, remove: ['a'] });
      items = (await s.get(`/api/chart/drawings?key=${key}`)).items;
      assert.deepStrictEqual(items.map((i) => i.id), ['b']);
    });

    await t('the key is canonical: an upper-case address reaches the same list', async () => {
      const items = (await s.get(`/api/chart/drawings?key=tok:${TOKEN.toUpperCase().replace('0X', '0x')}`)).items;
      assert.deepStrictEqual(items.map((i) => i.id), ['b']);
    });

    await t('a token with no list offers the old per-pool drawings, without dataIndex', async () => {
      const other = '0x' + '12'.repeat(20);
      s.store.setState(`chart_overlays:${POOL}`, JSON.stringify({ overlays: [{ name: 'segment', points: [{ dataIndex: 7, timestamp: 5, value: 0.5 }, { dataIndex: 9, timestamp: 6, value: 0.6 }], lock: false }] }));
      const r = await s.get(`/api/chart/drawings?key=tok:${other}&legacy=${POOL}`);
      assert.strictEqual(r.legacy, true);
      assert.deepStrictEqual(r.items[0].points, [{ timestamp: 5, value: 0.5 }, { timestamp: 6, value: 0.6 }]);
      assert.strictEqual(r.items[0].unit, null, 'the adopting chart decides the unit');
      // once the token has its own list, the old one is no longer offered
      await s.post('/api/chart/drawings', { key: `tok:${other}`, upsert: [line('x', 1)] });
      const r2 = await s.get(`/api/chart/drawings?key=tok:${other}&legacy=${POOL}`);
      assert.ok(!r2.legacy);
      assert.deepStrictEqual(r2.items.map((i) => i.id), ['x']);
    });

    await t('a malformed key or drawing is refused', async () => {
      assert.ok((await s.get('/api/chart/drawings?key=tok:nope')).error);
      assert.ok((await s.post('/api/chart/drawings', { key: 'evil:0x1', upsert: [line('z', 1)] })).error);
      await s.post('/api/chart/drawings', { key: `pool:${POOL}`, upsert: [{ id: 'q'.repeat(80), name: 'segment' }, { id: 'ok' }, line('good', 3)] });
      const items = (await s.get(`/api/chart/drawings?key=pool:${POOL}`)).items;
      assert.deepStrictEqual(items.map((i) => i.id), ['good']);
    });

    await t('the indicator preference is shared and keeps only short names', async () => {
      assert.deepStrictEqual((await s.get('/api/chart/prefs')).prefs, null);
      await s.post('/api/chart/prefs', { prefs: { indicators: ['VOL', 'RSI', 'x'.repeat(40), 42] } });
      assert.deepStrictEqual((await s.get('/api/chart/prefs')).prefs, { indicators: ['VOL', 'RSI'] });
    });
  } finally { await s.close(); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
