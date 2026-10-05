'use strict';
// Test: the GMGN rating used by the indicator shield in the positions list, and the
// multi-token route that feeds it.
//  - a single source of thresholds: gmgnSignals() is used by the Pool health panel AND the shield,
//    so the two must not disagree about the same token;
//  - "not yet rated" is not "safe": an empty column = grey, not green;
//  - without an API key, the route answers enabled:false — the UI then draws nothing.
// Run: node test/gmgn-indicators.js
const assert = require('node:assert');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

(async () => {
  console.log('Indikator keamanan GMGN\n');
  const { gmgnSignals, poolHealth } = await import('../web/src/poolHealth.mjs');

  await check('clean and filled-in contract → green', () => {
    const r = gmgnSignals({ security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 0, openSource: true, ownerRenounced: true } });
    assert.strictEqual(r.level, 'ok');
    assert.strictEqual(r.graded, true);
    assert.deepStrictEqual(r.signals, []);
  });

  await check('empty security columns → grey, NOT green', () => {
    const r = gmgnSignals({ security: { rugPct: null, insiderPct: null } });
    assert.strictEqual(r.level, 'unknown');
    assert.strictEqual(r.graded, false, 'without honeypot/tax/openSource it must not be considered rated');
    // A token GMGN itself does not know is also grey, not green.
    assert.strictEqual(gmgnSignals({}).level, 'unknown');
    assert.strictEqual(gmgnSignals(null).level, 'unknown');
  });

  await check('honeypot / pajak ≥10% / rug ≥50% → merah', () => {
    assert.strictEqual(gmgnSignals({ security: { honeypot: true } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { sellTaxPct: 12 } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { rugPct: 50 } }).level, 'risk');
    assert.strictEqual(gmgnSignals({ security: { insiderPct: 40 } }).level, 'risk');
  });

  await check('tax ≥3% / rug ≥20% / dev sold / contract unverified → yellow', () => {
    assert.strictEqual(gmgnSignals({ security: { sellTaxPct: 5 } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { rugPct: 20 } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { creatorSold: true } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { openSource: false } }).level, 'warn');
    assert.strictEqual(gmgnSignals({ security: { washTrading: true } }).level, 'warn');
  });

  await check('the shield and the Pool health panel use exactly the same threshold', () => {
    const gm = { address: '0xaa', security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 7, openSource: true, rugPct: 33 } };
    const own = gmgnSignals(gm, { skipTop10: true }).signals.map((s) => s.key);
    // holdersOk = true → poolHealth skips GMGN's top-10, same as skipTop10.
    const skipPanel = poolHealth({
      pool: { baseToken: '0xaa', fee: 3000 }, pair: null, gmgn: gm,
      holders: { token: '0xaa', items: [], holderCount: 500, fetchedAt: Date.now(), hasMore: false },
    }).signals.filter((s) => /GMGN/.test(s.key)).map((s) => s.key);
    assert.deepStrictEqual(skipPanel, own, 'two places, one signal list');
  });

  await check('GMGN\'s top-10 is only counted if our own holder list is missing', () => {
    const gm = { security: { honeypot: false, buyTaxPct: 0, sellTaxPct: 0, openSource: true, top10Pct: 70 } };
    assert.strictEqual(gmgnSignals(gm).level, 'risk', 'without a holder list: used');
    assert.strictEqual(gmgnSignals(gm, { skipTop10: true }).level, 'ok', 'with a holder list: not counted twice');
  });

  // ---- /api/gmgn/tokens route ----
  const path = require('node:path'), os = require('node:os'), fs = require('node:fs');
  const { Store } = require('../src/db');
  const { createServer } = require('../src/server');
  const makeServer = (apiKey) => {
    const store = new Store(':memory:');
    const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {}, gmgn: { api_key: apiKey } };
    const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-gmgn-')), 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const engine = {
      cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0 }, watcher: { unsupported: new Map() },
      exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [],
      dryRun: () => true, paused: () => false, compound: null,
    };
    const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
    return server;
  };

  await check('without an API key: enabled:false and zero calls to GMGN', async () => {
    const calls = [];
    globalThis.fetch = async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => ({}) }; };
    const s = makeServer(null);
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: '0x' + '11'.repeat(20) });
    assert.strictEqual(r.enabled, false);
    assert.deepStrictEqual(r.tokens, {});
    assert.strictEqual(calls.filter((u) => u.includes('gmgn')).length, 0);
  });

  await check('with an API key: invalid addresses are filtered out, the answer is mapped per address', async () => {
    const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
    globalThis.fetch = async (u) => {
      const url = new URL(String(u));
      const addr = (url.searchParams.get('address') || '').toLowerCase();
      const body = url.pathname.includes('security')
        ? { code: 0, data: { security: { is_honeypot: addr === B ? 'yes' : 'no', buy_tax: '0', sell_tax: '0', open_source: 'yes' } } }
        : { code: 0, data: { token: { address: addr, symbol: addr === A ? 'AAA' : 'BBB' } } };
      return { ok: true, status: 200, json: async () => body };
    };
    const s = makeServer('kunci-uji');
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: `${A},bukan-alamat,${B},${A}` });
    assert.strictEqual(r.enabled, true);
    assert.deepStrictEqual(Object.keys(r.tokens).sort(), [A, B].sort(), 'only valid addresses, without duplicates');
    assert.strictEqual(r.tokens[A].symbol, 'AAA');
    assert.strictEqual(r.tokens[A].security.honeypot, false);
    // The "Token security" panel in the history drawer uses GmgnSecurity, which reads
    // fetchedAt (data age) and links.gmgn — both must come along, not just security.
    assert.ok(Number.isFinite(r.tokens[A].fetchedAt), 'fetchedAt is sent along');
    assert.ok('links' in r.tokens[A], 'links is sent along');
    assert.strictEqual(r.tokens[B].security.honeypot, true);
    // And the result really rates the way the shield sees it.
    assert.strictEqual(gmgnSignals(r.tokens[A]).level, 'ok');
    assert.strictEqual(gmgnSignals(r.tokens[B]).level, 'risk');
  });

  await check('GMGN fails for one token → that token is marked error, the rest are still answered', async () => {
    const A = '0x' + 'cc'.repeat(20), B = '0x' + 'dd'.repeat(20);
    globalThis.fetch = async (u) => {
      const url = new URL(String(u));
      if ((url.searchParams.get('address') || '').toLowerCase() === B) throw new Error('fetch failed');
      return { ok: true, status: 200, json: async () => (url.pathname.includes('security')
        ? { code: 0, data: { security: { is_honeypot: 'no', buy_tax: '0', sell_tax: '0', open_source: 'yes' } } }
        : { code: 0, data: { token: { address: A, symbol: 'CCC' } } }) };
    };
    const s = makeServer('kunci-uji');
    const r = await s.api('GET', '/api/gmgn/tokens', null, { addresses: `${A},${B}` });
    assert.strictEqual(r.tokens[A].symbol, 'CCC');
    assert.ok(r.tokens[B].error, 'a failed token is flagged, not failing the whole answer');
    assert.strictEqual(gmgnSignals(r.tokens[B]).level, 'unknown');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
