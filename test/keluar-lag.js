'use strict';
// Uji: pembacaan likuiditas TARGET tidak tertipu node yang tertinggal atau oleh aksi
// target yang datang sesudahnya.
//  - rekonsiliasi v4: getPositionLiquidity menjawab 0 untuk NFT yang belum dikenal node;
//    cermin yang baru dibuka tidak boleh ditutup karena itu.
//  - tarik sebagian: likuiditas "sebelum" dihitung dari state di blok aksi, bukan `latest`.
//  - strict eth_call: hanya revert yang dibaca null; "block not found" melempar.
// Jalankan: node test/keluar-lag.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { RpcPool } = require('../src/rpc');
const { ADDR } = require('../src/chain');

const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const POOL = '0x' + 'ab'.repeat(32);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const word = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

function engineWith(ethCallMany) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const eng = new Engine({ rpc: { ethCallMany, call: async () => null }, store, chain: {}, cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {} });
  eng.exec.address = () => '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
  eng.notify = () => {};
  return { eng, store };
}
const addPos = (store, { mirrorOf = '999', openedTs = Date.now() - 3600_000, liquidity = '1000', venue = 'v4' } = {}) => Number(store.run(
  `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
   VALUES(?,?,?,?,?,3000,60,?,-600,600,?,?,?,'open',?,10,'USDG')`,
  venue, String(Math.floor(Math.random() * 1e9)), POOL, ADDR.usdg, MEME, ADDR.native, liquidity, TARGET, mirrorOf, openedTs).lastInsertRowid);
const addAct = (store, over = {}) => {
  const a = { ts: Date.now(), block: 5000, txHash: '0x' + Math.random().toString(16).slice(2), logIndex: 3, target: TARGET, venue: 'v4', kind: 'decrease',
    tokenId: '999', poolRef: POOL, tickLower: -600, tickUpper: 600, liquidity: '-400', ...over };
  a.id = Number(store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,tick_lower,tick_upper,liquidity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId, a.poolRef, a.tickLower, a.tickUpper, a.liquidity).lastInsertRowid);
  return a;
};

(async () => {
  console.log('Pembacaan likuiditas target:\n');

  await t('rekonsiliasi v4: node menjawab 0 untuk cermin berumur 1 menit → TIDAK ditutup; cermin 1 jam → ditutup', async () => {
    const { eng, store } = engineWith(async (c) => c.map(() => word(0)));
    const fresh = addPos(store, { mirrorOf: '1', openedTs: Date.now() - 60_000 });
    const old = addPos(store, { mirrorOf: '2' });
    const closed = [];
    eng.executeExit = async (plan, pos) => { closed.push(pos.id); return { note: 'ok' }; };
    await eng.reconcileExits(); await eng.reconcileExits(); await eng.reconcileExits();
    assert.deepStrictEqual(closed, [old]);
    assert.ok(!closed.includes(fresh));
  });

  await t('tarik sebagian dibaca di blok aksi: target tarik 40% lalu tutup penuh belakangan → cermin ditarik 40%, bukan ditutup', async () => {
    const tags = [];
    const { eng, store } = engineWith(async (c, tag) => { tags.push(tag); return c.map(() => word(tag === 'latest' ? 0 : 600)); });
    addPos(store, { liquidity: '1000' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(addAct(store), eng.rulesFrom(TARGET));
    assert.deepStrictEqual(tags, ['0x1388']);
    assert.strictEqual(plan.full, false);
    assert.strictEqual(plan.liquidity, '400');
  });

  await t('node tidak punya state blok itu (melempar) → jatuh ke latest', async () => {
    const tags = [];
    const { eng, store } = engineWith(async (c, tag) => { tags.push(tag); if (tag !== 'latest') throw new Error('eth_call tidak terbaca dari RPC: missing trie node'); return c.map(() => word(600)); });
    addPos(store, { liquidity: '1000' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(addAct(store), eng.rulesFrom(TARGET));
    assert.deepStrictEqual(tags, ['0x1388', 'latest']);
    assert.strictEqual(plan.liquidity, '400');
  });

  await t('dua tarikan target di blok yang sama: aksi pertama dihitung dari state sebelum aksi kedua', async () => {
    // L target 1000 → tarik 400 (log 3) → tarik 300 (log 7). State di blok = 300.
    const { eng, store } = engineWith(async (c) => c.map(() => word(300)));
    addPos(store, { liquidity: '1000' });
    const first = addAct(store, { logIndex: 3, liquidity: '-400' });
    addAct(store, { logIndex: 7, liquidity: '-300' });
    let plan;
    eng.executeExitRetry = async (p) => { plan = p; return { txHash: '0x1', note: 'ok' }; };
    await eng.handleExit(first, eng.rulesFrom(TARGET));
    assert.strictEqual(plan.liquidity, '400', 'before = 300 + 300 + 400 = 1000 → 40%');
  });

  await t('strict eth_call: revert → null; "block not found" → melempar (bukan dianggap NFT dibakar)', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false });
    p.batch = async () => [{ error: { code: 3, message: 'execution reverted: NOT_MINTED' } }];
    assert.deepStrictEqual(await p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10', { strict: true }), [null]);
    p.batch = async () => [{ error: { code: -32000, message: 'block not found' } }];
    await assert.rejects(p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10', { strict: true }), /tidak terbaca/);
    assert.deepStrictEqual(await p.ethCallMany([{ to: ADDR.npmV3, data: '0x' }], '0x10'), [null], 'non-strict tetap null');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
