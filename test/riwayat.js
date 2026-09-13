'use strict';
// Uji GET /api/position/history — riwayat satu posisi bot untuk laci di halaman Posisi:
// transaksi yang menyentuhnya (zap, mint, tutup, jual sisa) dengan jumlah & nilai,
// dan catatan bot (keputusan + baris log yang menyebut "#<id>").
//
// Jalankan: node test/riwayat.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x' + '22'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-riwayat-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api };
}

const T0 = 1_700_000_000_000;
function isiPosisi(store) {
  // posisi #1: USDG/MEME, modal 200 USDG, tutup -> 215 USDG (fee 13)
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,target,opened_ts,closed_ts,
    cost0,cost1,cost_quote,out0,out1,out_quote,fees_quote,quote_symbol,tx_open,tx_close)
    VALUES(1,'v4','2452759',?,?,?,3000,'closed',?,?,?,?,?,200,?,?,215.15,13.63,'USDG','0xmint1','0xburn1')`,
  POOL, ADDR.usdg, MEME, TARGET, T0 + 60_000, T0 + 360_000,
  (100n * 10n ** 6n).toString(), (100_000n * 10n ** 18n).toString(),
  (53n * 10n ** 6n).toString(), (614_765n * 10n ** 18n).toString());
  // posisi #10: pool lain, dibuka jauh kemudian — jangan tercampur ke riwayat #1
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,cost_quote,quote_symbol,tx_open)
    VALUES(10,'v4','9','0x'||?,?,?,'open',?,50,'USDG','0xmint10')`, 'cd'.repeat(32), ADDR.usdg, MEME, T0 + 900_000);

  const tx = (hash, ts, kind, status, detail, gas) => store.run(
    'INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES(?,?,?,?,?,?,?)',
    hash, ts, kind, status, gas ? 100_000 : null, gas ? '1000000000' : null, detail ? JSON.stringify(detail) : null);
  tx('0xzap1', T0 + 30_000, 'zap_swap', 'sukses', { via: 'kyber', pool: POOL, dex: 'uniswap-v4', usdIn: 100, usdOut: 99.2 }, true);
  tx('0xmint1', T0 + 60_000, 'mint', 'sukses', { pool: POOL, target: TARGET, venue: 'v4' }, true);
  tx('0xburn1', T0 + 360_000, 'burn', 'sukses', { position: 1, closeProceeds: { amount0: '53000000', amount1: (614_765n * 10n ** 18n).toString(), quote: 148 } }, true);
  tx('0xsell1', T0 + 400_000, 'sell_leftover', 'sukses', { position: 1, dex: 'kyber', usdIn: 73.7, usdOut: 73.1 }, true);
  tx('0xapprove', T0 + 40_000, 'approve_permit2', 'sukses', null, true);                  // tanpa detail: tidak ikut
  tx('0xzapLain', T0 + 30_000, 'zap_swap', 'sukses', { pool: '0x' + 'cd'.repeat(32) }, true); // pool lain: tidak ikut
  tx('0xmint10', T0 + 900_000, 'mint', 'sukses', { pool: '0x' + 'cd'.repeat(32) }, true);

  store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,value_quote,quote_symbol)
    VALUES(1,?,100,'0xtgt',0,?,'v4','mint','777',?,?,?,400,'USDG')`, T0 + 10_000, TARGET, POOL, ADDR.usdg, MEME);
  store.run("INSERT INTO decisions(action_id,ts,verdict,reason,tx_hash,position_id) VALUES(1,?,'copy','ukuran 50% dari target — USDG/MEME $200,00','0xmint1',1)", T0 + 60_000);
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 360_000, 'info', 'LP ditutup: tutup penuh posisi #1 · jual 614,8 rb MEME');
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 361_000, 'warn', 'sisa #10 tidak terukur: rpc 429');   // #10 bukan #1
  store.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', T0 + 362_000, 'info', 'ETH/USD dari chain: $2500');          // tidak menyebut posisi
}

(async () => {
  console.log('riwayat posisi');
  const { store, api } = dunia();
  isiPosisi(store);
  const r = await api('GET', '/api/position/history', {}, { id: '1' });

  await t('posisi #1: ringkasan modal/hasil/fee/PnL dalam USD', () => {
    assert.equal(r.position.symbol0, 'USDG'); assert.equal(r.position.symbol1, 'MEME');
    assert.equal(r.position.costUsd, 200); assert.equal(r.position.outUsd, 215.15);
    assert.equal(r.position.feesUsd, 13.63); assert.ok(Math.abs(r.position.pnlUsd - 15.15) < 1e-9);
  });
  await t('urutan kejadian: zap -> mint -> tutup -> jual sisa; approve & pool lain tidak ikut', () => {
    assert.deepEqual(r.events.map((e) => e.kind), ['zap_swap', 'mint', 'burn', 'sell_leftover']);
    assert.deepEqual(r.events.map((e) => e.hash), ['0xzap1', '0xmint1', '0xburn1', '0xsell1']);
  });
  await t('mint membawa jumlah modal & nilai; tutup membawa hasil & fee', () => {
    const mint = r.events[1], burn = r.events[2];
    assert.equal(mint.amount0, (100n * 10n ** 6n).toString()); assert.equal(mint.valueUsd, 200);
    assert.equal(mint.reason, 'ukuran 50% dari target — USDG/MEME $200,00'); assert.equal(mint.targetUsd, 400);
    assert.equal(burn.amount0, (53n * 10n ** 6n).toString()); assert.equal(burn.valueUsd, 148); assert.equal(burn.feesUsd, 13.63);
  });
  await t('swap membawa USD masuk/keluar dan dex; gas dihitung ke USD', () => {
    const zap = r.events[0];
    assert.equal(zap.usdIn, 100); assert.equal(zap.usdOut, 99.2); assert.equal(zap.dex, 'uniswap-v4');
    assert.ok(Math.abs(zap.gasUsd - 0.25) < 1e-9, `gas ${zap.gasUsd}`);   // 100k gas × 1 gwei × $2500
  });
  await t('catatan: keputusan + log yang menyebut #1, bukan #10 maupun baris umum', () => {
    assert.equal(r.notes.length, 2);
    assert.equal(r.notes[0].kind, 'keputusan'); assert.equal(r.notes[0].verdict, 'copy'); assert.equal(r.notes[0].actionKind, 'mint');
    assert.equal(r.notes[1].kind, 'log'); assert.match(r.notes[1].msg, /posisi #1 /);
  });
  await t('posisi tanpa tx di tabel (diadopsi) tetap punya kejadian buka/tutup sintetis', () => {
    store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol)
      VALUES(20,'v3','5','0x'||?,?,?,'closed',?,?,80,90,'USDG')`, 'ef'.repeat(20), ADDR.usdg, MEME, T0, T0 + 1000);
    return api('GET', '/api/position/history', {}, { id: '20' }).then((x) => {
      assert.deepEqual(x.events.map((e) => [e.kind, !!e.synthetic]), [['mint', true], ['burn', true]]);
      assert.equal(x.events[1].valueUsd, null);
    });
  });
  await t('swap manual bertaut lewat alokasi FIFO, termasuk jauh setelah tutup', async () => {
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', '0xmanual', T0 + 9000000, 'swap_manual', 'sukses', JSON.stringify({
      tokenIn: MEME, tokenOut: ADDR.usdg, symbolIn: 'MEME', symbolOut: 'USDG', amountIn: 100, amountOut: 30,
      positionSales: [{ position: 1, closeQuote: 10, gotQuote: 30 }, { position: 10, closeQuote: 5, gotQuote: 8 }]
    }));
    const x = await api('GET', '/api/position/history', {}, { id: '1' });
    const ev = x.events.find(e => e.hash === '0xmanual');
    assert.equal(ev.swap.amountOut, 30); assert.equal(ev.saleDeltaUsd, 20);
    assert.equal(x.position.closeUsd, 148); assert.equal(x.position.outUsd, 215.15);
  });

  await t('dua posisi berurutan di pool yang sama: mint/zap tetangga tidak bocor ke riwayat', async () => {
    // #6 dan #7 seperti di lp2: pool sama, #7 dibuka 90 detik setelah #6 ditutup,
    // dan sebelum #7 ada zap yang GAGAL berlanjut ke mint (entry batal) — bukan milik siapa pun.
    const P2 = '0x' + '77'.repeat(32), T1 = T0 + 5_000_000;
    const pos = (id, opened, closed, txo, txc) => store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,opened_ts,closed_ts,
      cost_quote,out_quote,quote_symbol,tx_open,tx_close) VALUES(?,'v4',?,?,?,?,'closed',?,?,80,80,'USDG',?,?)`, id, String(id * 100), P2, ADDR.usdg, MEME, opened, closed, txo, txc);
    pos(6, T1 + 30_000, T1 + 120_000, '0xmint6', '0xburn6');
    pos(7, T1 + 200_000, T1 + 500_000, '0xmint7', '0xburn7');
    const tx = (hash, ts, kind, detail) => store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, ts, kind, 'sukses', JSON.stringify(detail));
    tx('0xzap6', T1 + 20_000, 'zap_swap', { pool: P2, usdIn: 40, usdOut: 39 });
    tx('0xmint6', T1 + 30_000, 'mint', { pool: P2, recorded: 6 });                                    // mint lama: zap ditaksir
    tx('0xburn6', T1 + 120_000, 'burn', { position: 6, closeProceeds: { amount0: '80000000', amount1: '0', quote: 80 } });
    tx('0xzapBatal', T1 + 150_000, 'zap_swap', { pool: P2, usdIn: 30, usdOut: 29 });   // entry batal: tidak ada mint sesudahnya
    tx('0xmint7', T1 + 200_000, 'mint', { pool: P2, recorded: 7, zapped: { hashes: ['0xzap7'] } });   // mint baru: zap-nya tercatat
    tx('0xzap7', T1 + 190_000, 'zap_swap', { pool: P2, usdIn: 40, usdOut: 39 });
    tx('0xburn7', T1 + 500_000, 'burn', { position: 7, closeProceeds: { amount0: '80000000', amount1: '0', quote: 80 } });
    const h6 = await api('GET', '/api/position/history', {}, { id: '6' });
    assert.deepEqual(h6.events.map((e) => e.hash), ['0xzap6', '0xmint6', '0xburn6']);
    const h7 = await api('GET', '/api/position/history', {}, { id: '7' });
    assert.deepEqual(h7.events.map((e) => e.hash), ['0xzap7', '0xmint7', '0xburn7']);
  });

  await t('posisi tidak ada -> error', async () => {
    const x = await api('GET', '/api/position/history', {}, { id: '999' });
    assert.equal(x.error, 'posisi tidak ditemukan');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
