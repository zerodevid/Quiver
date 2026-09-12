'use strict';
// Uji pencatatan tarik sebagian (decrease) posisi bot.
//
// Kasus nyata: posisi #25 (FOMOBRAIN/USDG, modal $129,19) ditarik sebagian saat target
// menarik sebagian -> 54,75 USDG + 51.564 FOMOBRAIN masuk wallet, FOMOBRAIN-nya terjual
// $13,77. Dulu hanya likuiditasnya yang dikurangi; $68,52 itu hilang dari catatan dan
// posisi terbaca rugi $64,20 saat tutup, padahal untung ~$4.
//
// Jalankan: node test/kurangi.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');

const MEME = '0x' + 'f0'.repeat(20);
const POOL = '0x' + 'ab'.repeat(32);
const E18 = 10n ** 18n;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const dekat = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);

function dunia() {
  const store = new Store(':memory:');
  const chain = {
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' }
      : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
  };
  const positions = new Positions({ rpc: { ethCallMany: async (c) => c.map(() => '0x') }, store, chain, log: () => {} });
  // MEME(18)/USDG(6), modal 129,19 USDG, likuiditas 1000
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,cost_quote,cost1,liquidity,quote_symbol)
    VALUES('v4',?,?,?,'open',?,129.19,'129190000','1000','USDG')`, POOL, MEME, ADDR.usdg, Date.now());
  store.run("INSERT INTO txs(hash,detail) VALUES('0xdec','{}'),('0xburn','{}'),('0xsale','{}')");
  return { store, positions, id: Number(r.lastInsertRowid) };
}
const row = (d) => d.store.get('SELECT * FROM positions WHERE id=?', d.id);
// tarik sebagian: 54,75 USDG + 51.564 MEME (dinilai 11,62 di harga saat itu)
const kurangi = (d) => d.positions.markDecreased(d.id, {
  liquidity: '400', out0: 51_564n * E18, out1: 54_748_687n, outQuote: 54.748687 + 11.62, txHash: '0xdec',
  left: { token: MEME, amount: 51_564n * E18, quote: 11.62 },
});

(async () => {
  await t('tarik sebagian: hasil masuk out_quote, likuiditas sisa, posisi tetap terbuka', () => {
    const d = dunia();
    kurangi(d);
    const r = row(d);
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.liquidity, '400');
    assert.strictEqual(r.out0, (51_564n * E18).toString());
    assert.strictEqual(r.out1, '54748687');
    dekat(r.out_quote, 66.368687, 'out_quote');
    assert.strictEqual(r.left_token, MEME);
    assert.strictEqual(r.left_amount, (51_564n * E18).toString());
    const detail = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0xdec'").detail);
    assert.strictEqual(detail.decreaseProceeds.amount1, '54748687');
    assert.ok(!detail.closeProceeds, 'bukan tutup');
  });

  await t('memecoin dari tarik sebagian terjual: taksiran diganti hasil nyata (13,77)', () => {
    const d = dunia();
    kurangi(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, usdOut: 13.9, ethUsd: 2500, txHash: '0xsale' });
    const r = row(d);
    dekat(r.out_quote, 54.748687 + 13.771173, 'out_quote');
    assert.strictEqual(r.left_amount, '0');
    assert.strictEqual(r.status, 'open');
  });

  await t('tutup setelah tarik sebagian: PnL = semua yang keluar − modal (untung, bukan rugi $64)', () => {
    const d = dunia();
    kurangi(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, ethUsd: 2500 });
    // tutup: 49,11 USDG + 76.782 MEME (taksiran 15,9), lalu MEME terjual 15,88
    d.positions.markClosed(d.id, { out0: 76_782n * E18, out1: 49_113_513n, outQuote: 49.113513 + 15.9, txHash: '0xburn', exitSqrt: null,
      left: { token: MEME, amount: 76_782n * E18, quote: 15.9 } });
    let r = row(d);
    assert.strictEqual(r.status, 'closed');
    assert.strictEqual(r.out0, ((51_564n + 76_782n) * E18).toString(), 'out0 akumulasi');
    assert.strictEqual(r.out1, String(54_748_687 + 49_113_513), 'out1 akumulasi');
    assert.strictEqual(r.left_amount, (76_782n * E18).toString(), 'sisa hanya yang belum terjual');
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 76_782n * E18, quoteToken: ADDR.usdg,
      amountOut: 15_878_260n, ethUsd: 2500 });
    r = row(d);
    dekat(r.out_quote, 54.748687 + 13.771173 + 49.113513 + 15.87826, 'out_quote total');
    dekat(r.out_quote - r.cost_quote, 4.321633, 'pnl');
    const detail = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0xburn'").detail);
    assert.strictEqual(detail.closeProceeds.amount1, '49113513', 'closeProceeds hanya tx tutup');
  });

  await t('tutup tanpa tarik sebagian: perilaku lama tidak berubah (claimed ikut, out tidak berlipat)', () => {
    const d = dunia();
    d.store.run('UPDATE positions SET claimed_quote=2.5 WHERE id=?', d.id);
    d.positions.markClosed(d.id, { out0: 0n, out1: 140_000_000n, outQuote: 140, txHash: '0xburn', exitSqrt: null });
    const r = row(d);
    dekat(r.out_quote, 142.5, 'out_quote = tutup + fee terklaim');
    assert.strictEqual(r.out1, '140000000');
    assert.strictEqual(r.left_token, null);
  });

  await t('summary: posisi terbuka yang ditarik sebagian tidak terbaca rugi sebesar tarikannya', () => {
    const d = dunia();
    kurangi(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, ethUsd: 2500 });
    // sinkron terakhir: sisa posisi bernilai 62, fee 1
    d.positions.live = [{ id: d.id, valueUsd: 62, feeUsd: 1, empty: false }];
    const s = d.positions.summary(2500);
    dekat(s.unrealizedUsd, 62 + 1 + 54.748687 + 13.771173 - 129.19, 'unrealized memuat hasil tarikan');
    dekat(s.exposureUsd, 62, 'eksposur = nilai yang masih di pool');
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
