'use strict';
// Uji memecoin sisa posisi bot: dari "dinilai harga tutup" ke "hasil jual sesungguhnya",
// dan penilaiannya di ekuitas selama belum terjual.
//
// Kasus nyata: posisi #9 (copy DRIPPYPIGEON $200) tutup -> 58,66 USDG + 688 rb DRIPPY.
// DB mencatat out_quote $148 (DRIPPY di harga tutup) -> "rugi $52". Dua menit kemudian
// DRIPPY-nya dijual manual jadi ETH senilai $156,89 -> sebenarnya UNTUNG $15. Dan selama
// dua menit itu grafik total anjlok $150 karena DRIPPY tidak dihitung sama sekali.
//
// Jalankan: node test/sisa.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const W = '0x' + '11'.repeat(20);
const ETH = 2500;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const dekat = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);
const E18 = 10n ** 18n;
// pool token0 USDG(6) / token1 MEME(18): 1 MEME = 0,001 USDG
const sqrtOf = (memePerUsdg) => mm.getSqrtRatioAtTick(mm.priceToTick(memePerUsdg, 6, 18));

function dunia({ price = 1000, balance = null } = {}) {
  const store = new Store(':memory:');
  const st = { price, balance };
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4: async () => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 }),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrtOf(st.price), tick: 0 })),
    quoteSideOf: (t0, t1) => {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' }, [ADDR.weth]: { symbol: 'WETH', decimals: 18, kind: 'eth' } };
      if (q[t0]) return { side: 0, ...q[t0] };
      if (q[t1]) return { side: 1, ...q[t1] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      const p = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p : a1 + a0 * p, kind: q.kind };
    },
  };
  const rpc = { ethCallMany: async (calls) => calls.map(() => (st.balance == null ? '0x' : '0x' + st.balance.toString(16).padStart(64, '0'))) };
  const positions = new Positions({ rpc, store, chain, log: () => {} });
  return { store, positions, st };
}

// posisi $200 -> keluar 60 USDG + 700.000 MEME (harga tutup 0,0002 USDG -> $140); total out 200
function tutup(d, id = null, { meme = 700_000n * E18, memeQuote = 140, usdg = 60 } = {}) {
  const r = d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,cost_quote,quote_symbol)
    VALUES('v4',?,?,?,'open',?,200,'USDG')`, POOL, ADDR.usdg, MEME, Date.now());
  const pid = id ?? Number(r.lastInsertRowid);
  d.positions.markClosed(pid, { out0: usdg * 1e6, out1: meme, outQuote: usdg + memeQuote, txHash: '0x1', exitSqrt: null,
    left: { token: MEME, amount: meme, quote: memeQuote } });
  return pid;
}
const row = (d, id) => d.store.get('SELECT * FROM positions WHERE id=?', id);

(async () => {
  await t('tutup: sisa memecoin tercatat, out_quote memuat taksiran harga tutup', async () => {
    const d = dunia();
    const id = tutup(d);
    const r = row(d, id);
    assert.strictEqual(r.left_token, MEME);
    assert.strictEqual(r.left_amount, (700_000n * E18).toString());
    assert.strictEqual(r.left_quote, 140);
    assert.strictEqual(r.out_quote, 200);
  });

  await t('sisa terjual otomatis ke USDG: out_quote = USDG + hasil jual sesungguhnya', async () => {
    const d = dunia();
    const id = tutup(d);
    // Kyber menjual 700.000 MEME dan wallet menerima 156,89 USDG
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 700_000n * E18, quoteToken: ADDR.usdg, amountOut: 156_890_000n, usdOut: 150, ethUsd: ETH });
    const r = row(d, id);
    dekat(r.out_quote, 60 + 156.89, 'out_quote');
    assert.strictEqual(r.left_amount, '0');
    dekat(r.left_quote, 0, 'left_quote');
    dekat(r.out_quote - r.cost_quote, 16.89, 'pnl');
  });

  await t('sisa terjual ke ETH native: hasil dinilai lewat harga ETH', async () => {
    const d = dunia();
    const id = tutup(d);
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 700_000n * E18, quoteToken: ADDR.native, amountOut: 6n * 10n ** 16n, usdOut: null, ethUsd: ETH });
    dekat(row(d, id).out_quote, 60 + 0.06 * ETH, 'out_quote');
  });

  await t('swap manual tanpa tahu posisinya: FIFO ke posisi tertua dulu', async () => {
    const d = dunia();
    const a = tutup(d), b = tutup(d);
    d.store.run('UPDATE positions SET closed_ts=closed_ts-1000 WHERE id=?', a);
    // jual 1.000.000 dari 1.400.000: 700.000 punya #a, 300.000 punya #b, dapat 200 USDG
    d.positions.recordLeftoverSale({ token: MEME, amount: 1_000_000n * E18, quoteToken: ADDR.usdg, amountOut: 200_000_000n, ethUsd: ETH });
    const ra = row(d, a), rb = row(d, b);
    assert.strictEqual(ra.left_amount, '0');
    dekat(ra.out_quote, 60 + 140, 'a: 700/1000 × 200 = 140');
    assert.strictEqual(rb.left_amount, (400_000n * E18).toString());
    dekat(rb.out_quote, 200 - 60 + 60, 'b: 140 - 60 taksiran + 60 hasil');
    dekat(rb.left_quote, 80, 'b: sisa taksiran 4/7 × 140');
  });

  await t('penjualan lebih besar dari sisa yang tercatat: hanya bagian sisa yang dialokasikan', async () => {
    const d = dunia();
    const id = tutup(d);
    d.positions.recordLeftoverSale({ posId: id, token: MEME, amount: 900_000n * E18, quoteToken: ADDR.usdg, amountOut: 90_000_000n, ethUsd: ETH });
    // 700/900 × 90 = 70 menggantikan taksiran 140
    dekat(row(d, id).out_quote, 60 + 70, 'out_quote');
  });

  await t('belum terjual: ekuitas menilai sisa di harga pool kini, selisihnya jadi uPnL', async () => {
    const d = dunia({ price: 2000 });   // 1 MEME = 0,0005 USDG -> 700.000 MEME = $350
    tutup(d);
    await d.positions.refreshLeftovers(ETH, W);
    const s = d.positions.summary(ETH);
    dekat(s.leftoverUsd, 350, 'leftoverUsd');
    dekat(s.leftoverCloseUsd, 140, 'closeUsd');
    dekat(s.unrealizedUsd, 210, 'uPnL = 350 - 140');
    dekat(s.realizedUsd, 0, 'realized dari out_quote 200 - 200');
  });

  await t('harga pool tidak terbaca: nilai tutup dipakai, bukan nol', async () => {
    const d = dunia();
    tutup(d);
    d.positions.chain.slot0V4Many = async (ids) => ids.map(() => null);
    await d.positions.refreshLeftovers(ETH, W);
    dekat(d.positions.summary(ETH).leftoverUsd, 140, 'leftoverUsd');
  });

  await t('token hilang dari wallet (dijual di luar bot): dianggap terjual di harga kini', async () => {
    const d = dunia({ price: 1000, balance: 200_000n * E18 });   // tersisa 200.000 dari 700.000
    const id = tutup(d);
    await d.positions.refreshLeftovers(ETH, W);
    const r = row(d, id);
    assert.strictEqual(r.left_amount, (200_000n * E18).toString());
    // 500.000 MEME @ 0,001 = $500 menggantikan taksiran 5/7 × 140 = 100
    dekat(r.out_quote, 200 - 100 + 500, 'out_quote');
    dekat(d.positions.summary(ETH).leftoverUsd, 200, 'sisa 200.000 @ 0,001');
  });

  await t('tanpa sisa: summary tidak berubah', async () => {
    const d = dunia();
    await d.positions.refreshLeftovers(ETH, W);
    const s = d.positions.summary(ETH);
    assert.strictEqual(s.leftoverUsd, 0);
    assert.strictEqual(s.unrealizedUsd, 0);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
