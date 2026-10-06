'use strict';
// Test: two chains (Robinhood + BSC) in one process & one database.
//   - old config normalised into chains.<name>, per-chain view (Proxy) reads/writes correctly
//   - BSC profile: USDT with 18 decimals as the usdg slot, BNB/WBNB treated as "eth-like", two v3 venues
//   - DB migration: old rows = robinhood, state keys renamed, the same address allowed on two chains
//   - two engines on one Store do not overwrite each other's cursor/pause, and their positions are separate
// Run: node test/multichain.js
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

  await t('old config normalised: per-chain fields move to chains.robinhood, a bsc block is created (simulation, no targets)', () => {
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
    assert.strictEqual(cfg.wallet.key_file, '~/k', 'wallet stays global');
    // idempotent
    assert.deepStrictEqual(normalizeCfg(cfg), []);
  });

  await t('chainView: read/write per-chain fields to chains.<name>, other fields to the parent; JSON = the whole parent config', () => {
    const cfg = { chains: { robinhood: { chain: { endpoints: [] }, rules: { a: 1 }, mode: { dry_run: true } }, bsc: { chain: { endpoints: [] }, rules: { b: 2 }, mode: { dry_run: true } } }, server: { port: 7 } };
    normalizeCfg(cfg);
    const rh = chainView(cfg, 'robinhood'), bsc = chainView(cfg, 'bsc');
    assert.strictEqual(rh.network, 'robinhood'); assert.strictEqual(bsc.network, 'bsc');
    assert.strictEqual(rh.rules.a, 1); assert.strictEqual(bsc.rules.b, 2);
    assert.strictEqual(rh.server.port, 7); assert.strictEqual(bsc.server.port, 7);
    bsc.mode.dry_run = false;                     // mutation through the view
    assert.strictEqual(cfg.chains.bsc.mode.dry_run, false);
    assert.strictEqual(cfg.chains.robinhood.mode.dry_run, true, 'other chains are not changed');
    bsc.rules = { c: 3 };                         // replacing a whole section
    assert.deepStrictEqual(cfg.chains.bsc.rules, { c: 3 });
    rh.server = { port: 9 };
    assert.strictEqual(cfg.server.port, 9);
    const disk = cfgForDisk(bsc);
    assert.ok(disk.chains && disk.chains.robinhood && disk.chains.bsc, 'writeCfg(view) menulis bentuk induk');
    assert.strictEqual(disk.chain, undefined);
  });

  await t('BSC profile: usdg slot = USDT 18 decimals, BNB/WBNB eth-like, v3 venue + pancakev3 with a different NPM', () => {
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
    // Robinhood unchanged
    const r = new Chain(rpcStub, new Store(':memory:'), () => {}, 'robinhood');
    assert.strictEqual(r.usdgDecimals, 6); assert.strictEqual(r.nativeSymbol, 'ETH');
    assert.ok(r.isEthLike('ETH') && r.isEthLike('WETH') && !r.isEthLike('BNB'));
    assert.ok(!r.isV3Venue('pancakev3'));
  });

  await t('usdPerQuote & rule validation follow the chain: WBNB converted on BSC, pancakev3 a valid venue', () => {
    const bsc = build('bsc'); const chain = ensureChain({ ...bsc });
    assert.strictEqual(usdPerQuote('WBNB', 600, chain), 600);
    assert.strictEqual(usdPerQuote('USDT', 600, chain), 1);
    assert.strictEqual(usdPerQuote('WETH', 2500), 2500, 'without a chain: old behaviour');
    assert.strictEqual(validateRules({ filters: { venues: ['v4', 'pancakev3'] } }).error, undefined);
    assert.ok(validateRules({ filters: { venues: ['v5'] } }).error);
  });

  await t('DB migration: old rows = robinhood, state keys renamed, the same target address allowed on two chains', () => {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE targets (address TEXT PRIMARY KEY, label TEXT, enabled INTEGER NOT NULL DEFAULT 1, rules TEXT, added_ts INTEGER NOT NULL, notes TEXT);
      CREATE TABLE state (k TEXT PRIMARY KEY, v TEXT);
      INSERT INTO targets(address,label,enabled,added_ts) VALUES('0xabc','lama',1,1);
      INSERT INTO state(k,v) VALUES('cursor','123'),('paused','1'),('tg_offset','5');`);
    // Store opens a path; use a temp file
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-mc-')), 'x.db');
    db.exec(`VACUUM INTO '${p}'`); db.close();
    const s = new Store(p);
    assert.deepStrictEqual(s.all('SELECT chain,address,label FROM targets').map((r) => ({ ...r })), [{ chain: 'robinhood', address: '0xabc', label: 'lama' }]);
    assert.strictEqual(s.getState('cursor:robinhood'), '123');
    assert.strictEqual(s.getState('paused:robinhood'), '1');
    assert.strictEqual(s.getState('tg_offset'), '5', 'global keys are not touched');
    s.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('bsc','0xabc',1,2)");
    assert.strictEqual(s.get('SELECT COUNT(*) n FROM targets').n, 2);
    const s2 = new Store(p);                      // reopen: idempotent
    assert.strictEqual(s2.get('SELECT COUNT(*) n FROM targets').n, 2);
  });

  await t('two engines, one Store: cursor, pause, targets, and positions separate per chain', () => {
    const store = new Store(':memory:');
    const mk = (key) => new Engine({ rpc: rpcStub, store, chain: new Chain(rpcStub, store, () => {}, key), cfg: { mode: { dry_run: true }, rules: {}, loop: {}, gas: {}, prices: {} }, log: () => {} });
    const rh = mk('robinhood'), bsc = mk('bsc');
    rh.store.setState(rh.sk('cursor'), 10); bsc.store.setState(bsc.sk('cursor'), 20);
    assert.strictEqual(Number(store.getState('cursor:robinhood')), 10);
    assert.strictEqual(Number(store.getState('cursor:bsc')), 20);
    rh.setPaused(true);
    assert.ok(rh.paused() && !bsc.paused(), 'jeda per chain');
    store.setState('paused', '1');
    assert.ok(bsc.paused(), "old 'paused' key = global switch");
    store.setState('paused', '0'); rh.setPaused(false);
    store.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('robinhood','0xt',1,1)");
    assert.strictEqual(rh.watcher.enabledSet().size, 1);
    assert.strictEqual(bsc.watcher.enabledSet().size, 0);
    const id = bsc.positions.record({ venue: 'pancakev3', poolRef: '0xpool', token0: '0xa', token1: '0xb', tickLower: 0, tickUpper: 10, liquidity: '5', amount0: '1', amount1: '1', valueQuote: 1, quoteSymbol: 'USDT' }, { tokenId: '7' });
    assert.strictEqual(store.get('SELECT chain, venue FROM positions WHERE id=?', id).chain, 'bsc');
    assert.strictEqual(bsc.positions.open().length, 1);
    assert.strictEqual(rh.positions.open().length, 0, 'BSC positions do not leak into Robinhood');
    assert.strictEqual(rh.positions.summary(2500).openCount, 0);
    assert.strictEqual(bsc.positions.summary(600).openCount, 1);
  });

  await t('ensureChain: a mock object is completed with the Robinhood profile; a Chain instance is returned as it is', () => {
    const mock = { tokens: async () => [] };
    const c = ensureChain(mock);
    assert.strictEqual(c, mock); assert.strictEqual(c.network, 'robinhood'); assert.ok(c.ADDR.posmV4);
    assert.strictEqual(typeof c.isV3Venue, 'function');
    const real = new Chain(rpcStub, new Store(':memory:'), () => {}, 'bsc');
    assert.strictEqual(ensureChain(real), real);
    assert.strictEqual(ensureChain(rpcStub).rpc, rpcStub, 'an old RpcPool is wrapped into a chain');
  });

  await t('Telegram: /chain switches the chain per chat; the API & engine used by the screens follow its choice', async () => {
    const { Telegram } = require('../src/telegram');
    const store = new Store(':memory:');
    const cfg = { telegram: { bot_token: '1:x', chat_ids: ['7'], language: 'id' }, chains: {} };
    const mkEngine = (key, dry) => ({ network: key, dryRun: () => dry, paused: () => false, watcher: { enabledSet: () => new Set(key === 'bsc' ? ['0xa'] : []) } });
    const nets = {
      robinhood: { key: 'robinhood', label: 'Robinhood Chain', engine: mkEngine('robinhood', false) },
      bsc: { key: 'bsc', label: 'BNB Smart Chain', engine: mkEngine('bsc', true) },
    };
    const calls = [];
    const bot = new Telegram({
      cfg, cfgPath: null, store, engine: nets.robinhood.engine, nets, primaryKey: 'robinhood', log: () => {},
      api: async (m, p, b, q, chainKey) => {
        calls.push([p, chainKey]);
        return { mode: { dry_run: false, wallet: null, paused: false }, summary: { realizedUsd: 0, unrealizedUsd: 0, openCount: 0, exposureUsd: 0, inRange: 0, feeUsd: 0 },
          chain: { lag: 0, head: 1, cursor: 1 }, stats: { errors: 0, uptimeSec: 1 }, totals: { actions: 0, copied: 0, would: 0, skipped: 0, errors: 0 }, rpc: [], leftovers: [], targets: [], positions: [], logs: [] };
      },
    });
    const out = [];
    bot.tg = async (method, params) => { out.push([method, params]); return { message_id: 1 }; };
    // chain picker screen
    await bot.handle({ callback_query: { id: '1', data: 'ch', message: { chat: { id: 7 }, message_id: 1 } } });
    const pick = out.find(([m, p]) => m === 'editMessageText' || m === 'sendMessage')[1];
    assert.ok(/Pilih chain/.test(pick.text));
    assert.ok(JSON.stringify(pick.reply_markup).includes('chSet:bsc'));
    // pick BSC: stored per chat, the next screen uses that chain
    await bot.handle({ callback_query: { id: '2', data: 'chSet:bsc', message: { chat: { id: 7 }, message_id: 1 } } });
    assert.strictEqual(bot.chatChain('7'), 'bsc');
    calls.length = 0;
    await bot.handle({ message: { chat: { id: 7, type: 'private' }, text: '/menu' } });
    assert.ok(calls.length && calls.every(([, k]) => k === 'bsc'), JSON.stringify(calls));
    const caption = out[out.length - 1][1].text;
    assert.ok(caption.includes('BNB Smart Chain'), caption.slice(0, 120));
    // another chat stays on the main chain
    calls.length = 0;
    await bot.handle({ message: { chat: { id: 8, type: 'private' }, text: '/menu' } });
    assert.ok(calls.length === 0 || calls.every(([, k]) => k === 'robinhood'));
  });

  await t('every network in NETWORKS can be built; EVM addresses lower-case, Solana base58 kept intact', () => {
    const { isSolana, normAddr } = require('../src/networks');
    for (const key of Object.keys(NETWORKS)) {
      const p = build(key);
      for (const [k, a] of Object.entries(p.ADDR)) {
        if (isSolana(key)) assert.strictEqual(normAddr(key, a), a, `${key}.${k} = ${a}`);
        else assert.ok(/^0x[0-9a-f]{40}$/.test(a), `${key}.${k} = ${a}`);
      }
      assert.ok(p.venues.length >= 1);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
