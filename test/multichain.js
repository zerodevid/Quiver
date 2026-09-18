'use strict';
// Uji: dua chain (Robinhood + BSC) dalam satu proses & satu database.
//   - config lama dinormalkan ke chains.<nama>, tampilan per chain (Proxy) baca/tulis benar
//   - profil BSC: USDT 18 desimal sebagai slot usdg, BNB/WBNB dianggap "eth-like", dua venue v3
//   - migrasi DB: baris lama = robinhood, kunci state dinamai ulang, alamat sama boleh di dua chain
//   - dua mesin di satu Store tidak saling menimpa kursor/jeda, dan posisinya terpisah
// Jalankan: node test/multichain.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { normalizeCfg, chainView, enabledChains } = require('../src/multichain');
const { build, ensureChain, NETWORKS } = require('../src/networks');
const { Chain } = require('../src/pools');
const { Engine } = require('../src/engine');
const { usdPerQuote, validateRules } = require('../src/policy');
const { cfgForDisk } = require('../src/env');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}
const rpcStub = { blockNumber: async () => 100, ethCallMany: async (c) => c.map(() => null), call: async () => '0x0', allCooling: () => false, safeHead: async () => ({ min: 100, spread: 0 }), stats: () => [] };

(async () => {
  console.log('Multi-chain:');

  await t('config lama dinormalkan: kolom per-chain pindah ke chains.robinhood, blok bsc dibuat (simulasi, tanpa target)', () => {
    const cfg = { chain: { endpoints: [{ url: 'https://a' }] }, targets: [{ address: '0xabc' }], rules: { sizing: { pct: 10 } }, mode: { dry_run: false }, wallet: { key_file: '~/k' }, server: { port: 1 } };
    const notes = normalizeCfg(cfg);
    assert.ok(notes.length >= 2);
    assert.strictEqual(cfg.chain, undefined);
    assert.deepStrictEqual(cfg.chains.robinhood.chain.endpoints, [{ url: 'https://a' }]);
    assert.strictEqual(cfg.chains.robinhood.mode.dry_run, false);
    assert.strictEqual(cfg.chains.bsc.mode.dry_run, true, 'BSC bawaan simulasi');
    assert.deepStrictEqual(cfg.chains.bsc.targets, []);
    assert.ok(cfg.chains.bsc.chain.endpoints.length >= 2);
    assert.deepStrictEqual(enabledChains(cfg), ['robinhood', 'bsc']);
    assert.strictEqual(cfg.wallet.key_file, '~/k', 'wallet tetap global');
    // idempoten
    assert.deepStrictEqual(normalizeCfg(cfg), []);
  });

  await t('chainView: baca/tulis kolom per-chain ke chains.<nama>, kolom lain ke induk; JSON = config induk utuh', () => {
    const cfg = { chains: { robinhood: { chain: { endpoints: [] }, rules: { a: 1 }, mode: { dry_run: true } }, bsc: { chain: { endpoints: [] }, rules: { b: 2 }, mode: { dry_run: true } } }, server: { port: 7 } };
    normalizeCfg(cfg);
    const rh = chainView(cfg, 'robinhood'), bsc = chainView(cfg, 'bsc');
    assert.strictEqual(rh.network, 'robinhood'); assert.strictEqual(bsc.network, 'bsc');
    assert.strictEqual(rh.rules.a, 1); assert.strictEqual(bsc.rules.b, 2);
    assert.strictEqual(rh.server.port, 7); assert.strictEqual(bsc.server.port, 7);
    bsc.mode.dry_run = false;                     // mutasi lewat tampilan
    assert.strictEqual(cfg.chains.bsc.mode.dry_run, false);
    assert.strictEqual(cfg.chains.robinhood.mode.dry_run, true, 'chain lain tidak ikut berubah');
    bsc.rules = { c: 3 };                         // penggantian seluruh bagian
    assert.deepStrictEqual(cfg.chains.bsc.rules, { c: 3 });
    rh.server = { port: 9 };
    assert.strictEqual(cfg.server.port, 9);
    const disk = cfgForDisk(bsc);
    assert.ok(disk.chains && disk.chains.robinhood && disk.chains.bsc, 'writeCfg(view) menulis bentuk induk');
    assert.strictEqual(disk.chain, undefined);
  });

  await t('profil BSC: slot usdg = USDT 18 desimal, BNB/WBNB eth-like, venue v3 + pancakev3 dengan NPM berbeda', () => {
    const c = new Chain(rpcStub, new Store(':memory:'), () => {}, 'bsc');
    assert.strictEqual(c.CHAIN_ID, 56);
    assert.strictEqual(c.usdgSymbol, 'USDT'); assert.strictEqual(c.usdgDecimals, 18);
    assert.strictEqual(c.nativeSymbol, 'BNB'); assert.strictEqual(c.wethSymbol, 'WBNB');
    assert.ok(c.isEthLike('BNB') && c.isEthLike('WBNB') && !c.isEthLike('USDT') && !c.isEthLike('ETH'));
    assert.ok(c.isV3Venue('v3') && c.isV3Venue('pancakev3') && !c.isV3Venue('v4'));
    assert.notStrictEqual(c.npmFor('pancakev3'), c.npmFor('v3'));
    assert.strictEqual(c.npmFor('v3'), c.ADDR.npmV3);
    assert.strictEqual(c.legacyGasPricing, true);
    assert.strictEqual(c.QUOTES[c.ADDR.usdg].kind, 'usd');
    // Robinhood tidak berubah
    const r = new Chain(rpcStub, new Store(':memory:'), () => {}, 'robinhood');
    assert.strictEqual(r.usdgDecimals, 6); assert.strictEqual(r.nativeSymbol, 'ETH');
    assert.ok(r.isEthLike('ETH') && r.isEthLike('WETH') && !r.isEthLike('BNB'));
    assert.ok(!r.isV3Venue('pancakev3'));
  });

  await t('usdPerQuote & validasi aturan mengikuti chain: WBNB dikonversi di BSC, pancakev3 venue sah', () => {
    const bsc = build('bsc'); const chain = ensureChain({ ...bsc });
    assert.strictEqual(usdPerQuote('WBNB', 600, chain), 600);
    assert.strictEqual(usdPerQuote('USDT', 600, chain), 1);
    assert.strictEqual(usdPerQuote('WETH', 2500), 2500, 'tanpa chain: perilaku lama');
    assert.strictEqual(validateRules({ filters: { venues: ['v4', 'pancakev3'] } }).error, undefined);
    assert.ok(validateRules({ filters: { venues: ['v5'] } }).error);
  });

  await t('migrasi DB: baris lama = robinhood, kunci state dinamai ulang, alamat target sama boleh di dua chain', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE targets (address TEXT PRIMARY KEY, label TEXT, enabled INTEGER NOT NULL DEFAULT 1, rules TEXT, added_ts INTEGER NOT NULL, notes TEXT);
      CREATE TABLE state (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO targets(address,label,enabled,added_ts) VALUES('0xabc','lama',1,1);
      INSERT INTO state(k,v) VALUES('cursor','123'),('paused','1'),('tg_offset','5');`);
    // Store membuka path; pakai berkas sementara
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-mc-')), 'x.db');
    db.exec(`VACUUM INTO '${p}'`); db.close();
    const s = new Store(p);
    assert.deepStrictEqual(s.all('SELECT chain,address,label FROM targets').map((r) => ({ ...r })), [{ chain: 'robinhood', address: '0xabc', label: 'lama' }]);
    assert.strictEqual(s.getState('cursor:robinhood'), '123');
    assert.strictEqual(s.getState('paused:robinhood'), '1');
    assert.strictEqual(s.getState('tg_offset'), '5', 'kunci global tidak disentuh');
    s.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('bsc','0xabc',1,2)");
    assert.strictEqual(s.get('SELECT COUNT(*) n FROM targets').n, 2);
    const s2 = new Store(p);                      // buka ulang: idempoten
    assert.strictEqual(s2.get('SELECT COUNT(*) n FROM targets').n, 2);
  });

  await t('dua mesin, satu Store: kursor, jeda, target, dan posisi terpisah per chain', () => {
    const store = new Store(':memory:');
    const mk = (key) => new Engine({ rpc: rpcStub, store, chain: new Chain(rpcStub, store, () => {}, key), cfg: { mode: { dry_run: true }, rules: {}, loop: {}, gas: {}, prices: {} }, log: () => {} });
    const rh = mk('robinhood'), bsc = mk('bsc');
    rh.store.setState(rh.sk('cursor'), 10); bsc.store.setState(bsc.sk('cursor'), 20);
    assert.strictEqual(Number(store.getState('cursor:robinhood')), 10);
    assert.strictEqual(Number(store.getState('cursor:bsc')), 20);
    rh.setPaused(true);
    assert.ok(rh.paused() && !bsc.paused(), 'jeda per chain');
    store.setState('paused', '1');
    assert.ok(bsc.paused(), "kunci 'paused' lama = saklar global");
    store.setState('paused', '0'); rh.setPaused(false);
    store.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('robinhood','0xt',1,1)");
    assert.strictEqual(rh.watcher.enabledSet().size, 1);
    assert.strictEqual(bsc.watcher.enabledSet().size, 0);
    const id = bsc.positions.record({ venue: 'pancakev3', poolRef: '0xpool', token0: '0xa', token1: '0xb', tickLower: 0, tickUpper: 10, liquidity: '5', amount0: '1', amount1: '1', valueQuote: 1, quoteSymbol: 'USDT' }, { tokenId: '7' });
    assert.strictEqual(store.get('SELECT chain, venue FROM positions WHERE id=?', id).chain, 'bsc');
    assert.strictEqual(bsc.positions.open().length, 1);
    assert.strictEqual(rh.positions.open().length, 0, 'posisi BSC tidak bocor ke Robinhood');
    assert.strictEqual(rh.positions.summary(2500).openCount, 0);
    assert.strictEqual(bsc.positions.summary(600).openCount, 1);
  });

  await t('ensureChain: objek tiruan dilengkapi profil Robinhood; instance Chain dikembalikan apa adanya', () => {
    const mock = { tokens: async () => [] };
    const c = ensureChain(mock);
    assert.strictEqual(c, mock); assert.strictEqual(c.network, 'robinhood'); assert.ok(c.ADDR.posmV4);
    assert.strictEqual(typeof c.isV3Venue, 'function');
    const real = new Chain(rpcStub, new Store(':memory:'), () => {}, 'bsc');
    assert.strictEqual(ensureChain(real), real);
    assert.strictEqual(ensureChain(rpcStub).rpc, rpcStub, 'RpcPool lama dibungkus jadi chain');
  });

  await t('setiap jaringan di NETWORKS bisa dibangun dan alamatnya huruf kecil', () => {
    for (const key of Object.keys(NETWORKS)) {
      const p = build(key);
      for (const [k, a] of Object.entries(p.ADDR)) assert.ok(/^0x[0-9a-f]{40}$/.test(a), `${key}.${k} = ${a}`);
      assert.ok(p.venues.length >= 1);
    }
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
