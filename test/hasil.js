'use strict';
// Uji pelacakan hasil tutup posisi (proceeds.js): terealisasi vs belum.
//
// Yang dipalsukan hanya chain & RPC; Proceeds asli. Skenario dibangun dari kasus
// nyata wallet Bang GE: posisi USDG/MEME ditutup, wallet menerima USDG + MEME,
// lalu MEME-nya dijual beberapa blok kemudian (ke USDG atau ke ETH native).
//
// Jalankan: node test/hasil.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Proceeds } = require('../src/proceeds');
const { ADDR, TOPIC } = require('../src/chain');
const mm = require('../src/v3math');

const W = '0x54e29aac8ed96c56463b18027c676d09b5c0be98';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const HEAD = 1_000_000;
const ETH = 2000;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const w = (n) => '0x' + BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const hexb = (n) => '0x' + n.toString(16);
const txh = (n) => '0x' + n.toString(16).padStart(64, '0');
const xfer = (token, from, to, amt, block, tx) => ({
  address: token, blockNumber: hexb(block), logIndex: '0x0', transactionHash: tx,
  topics: [TOPIC.transfer, pad32(from), pad32(to)], data: w(amt),
});
// pool "1 MEME = 0,001 USDG": token0 USDG(6), token1 MEME(18) -> 1000 MEME per USDG.
// Tick adalah langkah 0,01%, jadi harga dari tick meleset sedikit — toleransi 0,01%.
const SQRT = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));
const dekat = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-4 + 1e-6, `${msg}: ${a} vs ${b}`);

// Posisi tertutup: modal 1000 USDG, keluar 200 USDG + 800.000 MEME (nilai tutup 200 + 800 = 1000).
function dunia({ logs = [], receipts = {}, txs = {}, balances = {}, arsip = true, sqrtNow = SQRT, pre = 0n } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    hasArchive: () => arsip,
    blockNumber: async () => HEAD,
    callAt: async (to, data) => {
      if (to === MEME && data.startsWith('0x70a08231')) return w(pre);     // balanceOf
      throw new Error('missing trie node');
    },
    getLogs: async (f) => {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return logs.filter((l) => l.address === f.address && (f.topics || []).every((s, i) => s == null || s === l.topics[i])
        && parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
    },
    batch: async (calls) => calls.map((c) => {
      if (c.method === 'eth_getTransactionReceipt') return { result: receipts[c.params[0]] || null };
      if (c.method === 'eth_getTransactionByHash') return { result: txs[c.params[0]] || { from: W, value: '0x0', gasPrice: '0x1' } };
      if (c.method === 'eth_getBalance') {
        const b = balances[parseInt(c.params[1], 16)];
        return b == null ? { error: { message: 'missing trie node' } } : { result: w(b) };
      }
      return { result: null };
    }),
  };
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4: async () => (sqrtNow ? { sqrtPriceX96: sqrtNow, tick: 0 } : null),
    blockTs: async (b) => b * 101,
    ethUsdAt: async () => ETH,
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      const p = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p : a1 + a0 * p, kind: 'usd' };
    },
  };
  const research = { priceAt: async () => SQRT };
  const proceeds = new Proceeds({ rpc, store, chain, research, log: () => {} });
  return { store, proceeds };
}

const CLOSE_TX = txh(500);
function posisi(store, { id = '1', closeBlock = 500, out0 = 200_000_000, out1 = 800_000n * 10n ** 18n, tx = CLOSE_TX } = {}) {
  store.run(`INSERT INTO wpositions(wallet,venue,token_id,pool_ref,token0,token1,out0,out1,invested_q,returned_q,fees_q,pnl_q,quote_symbol,
    opened_block,closed_block,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  W, 'v4', id, POOL, ADDR.usdg, MEME, String(out0), out1.toString(), 1000, 1000, 0, 0, 'USDG', closeBlock - 100, closeBlock, 'closed');
  store.run(`INSERT INTO wevents(wallet,token_id,block,tx_hash,log_index,kind,liq_delta,amount0,amount1) VALUES(?,?,?,?,?,?,?,?,?)`,
    W, id, closeBlock, tx, 5, 'decrease', '-1', String(out0), out1.toString());
}
const closeReceipt = (out1 = 800_000n * 10n ** 18n, to = W, tx = CLOSE_TX) => ({
  blockNumber: hexb(500), gasUsed: '0x0', effectiveGasPrice: '0x0',
  logs: [xfer(ADDR.usdg, ADDR.poolManager, W, 200_000_000, 500, tx), xfer(MEME, ADDR.poolManager, to, out1, 500, tx)],
});
const row = (store, id = '1') => store.get('SELECT * FROM wpositions WHERE token_id=?', id);

(async () => {
  await t('belum dijual: USDG terealisasi, MEME dipegang dinilai harga sekarang', async () => {
    const d = dunia({ receipts: { [CLOSE_TX]: closeReceipt() } });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, (800_000n * 10n ** 18n).toString());
    assert.strictEqual(r.sold_tok, '0');
    assert.ok(Math.abs(r.realized_q - 200) < 1e-6, `realized ${r.realized_q}`);
    dekat(r.unrealized_q, 800, 'unrealized');
    assert.ok(Math.abs(r.pnl_q) < 0.1, `pnl ${r.pnl_q}`);
    assert.strictEqual(r.tracked_to, HEAD);
  });

  await t('harga MEME jatuh separuh sebelum dijual: PnL tertutup ikut turun', async () => {
    const d = dunia({ receipts: { [CLOSE_TX]: closeReceipt() }, sqrtNow: mm.getSqrtRatioAtTick(mm.priceToTick(2000, 6, 18)) });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    dekat(r.unrealized_q, 400, 'unrealized');
    dekat(r.pnl_q, -400, 'pnl');
  });

  await t('dijual ke USDG: hasil jual sesungguhnya yang dipakai, bukan harga pool', async () => {
    const SELL = txh(600);
    const d = dunia({
      receipts: {
        [CLOSE_TX]: closeReceipt(),
        // jual 800.000 MEME, dapat cuma 700 USDG (price impact) — bukan 800 harga pool
        [SELL]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 700_000_000, 600, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
      balances: { 599: 10n ** 18n, 600: 10n ** 18n },
    });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.strictEqual(r.sold_tok, (800_000n * 10n ** 18n).toString());
    assert.ok(Math.abs(r.realized_q - 900) < 1e-6, `realized ${r.realized_q}`);
    assert.strictEqual(r.unrealized_q, 0);
    assert.ok(Math.abs(r.pnl_q - (-100)) < 1e-6, `pnl ${r.pnl_q}`);
    const s = d.store.get('SELECT * FROM wsales WHERE tx_hash=?', SELL);
    assert.strictEqual(s.kind, 'sell');
    assert.ok(Math.abs(s.quote_usd - 700) < 1e-6);
  });

  await t('dijual ke ETH native: dibaca dari selisih saldo + gas, harga ETH blok itu', async () => {
    const SELL = txh(600);
    const d = dunia({
      receipts: {
        [CLOSE_TX]: closeReceipt(),
        [SELL]: { blockNumber: hexb(600), gasUsed: '0x10', effectiveGasPrice: '0x2', logs: [
          xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)] },
      },
      txs: { [SELL]: { from: W, value: '0x0' } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
      // saldo naik 0,3 ETH, dikurangi gas 32 wei
      balances: { 599: 10n ** 18n, 600: 10n ** 18n + 3n * 10n ** 17n - 32n },
    });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    // 200 USDG + 0,3 ETH × 2000 = 800
    assert.ok(Math.abs(r.realized_q - 800) < 1e-6, `realized ${r.realized_q}`);
    assert.ok(Math.abs(r.pnl_q - (-200)) < 1e-6, `pnl ${r.pnl_q}`);
  });

  await t('saldo ETH gagal sementara (429): token dilewati & dicoba lagi, bukan dicatat salah', async () => {
    const SELL = txh(600);
    const d = dunia({
      receipts: { [CLOSE_TX]: closeReceipt(), [SELL]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)] } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
    });
    d.proceeds.rpc.batch = (async (orig) => async (calls) => {
      if (calls[0].method === 'eth_getBalance') return calls.map(() => ({ error: { message: 'HTTP 429: Too Many Requests' } }));
      return orig(calls);
    })(d.proceeds.rpc.batch);
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.tracked_to, null, 'harus tetap belum terlacak');
    assert.strictEqual(d.store.get('SELECT COUNT(*) n FROM wsales').n, 0);
  });

  await t('dikirim keluar tanpa aset kuotasi masuk: dinilai harga pool blok itu', async () => {
    const SEND = txh(600);
    const d = dunia({
      receipts: { [CLOSE_TX]: closeReceipt(), [SEND]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [xfer(MEME, W, '0x' + '11'.repeat(20), 800_000n * 10n ** 18n, 600, SEND)] } },
      logs: [xfer(MEME, W, '0x' + '11'.repeat(20), 800_000n * 10n ** 18n, 600, SEND)],
      balances: { 599: 0n, 600: 0n },
    });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(d.store.get('SELECT kind FROM wsales WHERE tx_hash=?', SEND).kind, 'send');
    dekat(r.realized_q, 1000, 'realized');
  });

  await t('FIFO: saldo lama habis dulu, lalu posisi tertua; sisanya dipegang posisi termuda', async () => {
    const SELL = txh(700);
    const CLOSE2 = txh(550);
    const d = dunia({
      pre: 100_000n * 10n ** 18n,
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(800_000n * 10n ** 18n, W, CLOSE2),
        // jual 1.000.000: 100.000 saldo lama + 800.000 posisi #1 + 100.000 posisi #2
        [SELL]: { blockNumber: hexb(700), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 1_000_000n * 10n ** 18n, 700, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 1_000_000_000, 700, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 1_000_000n * 10n ** 18n, 700, SELL)],
      balances: { 699: 0n, 700: 0n },
    });
    posisi(d.store, { id: '1' });
    posisi(d.store, { id: '2', closeBlock: 550, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r1 = row(d.store, '1'), r2 = row(d.store, '2');
    assert.strictEqual(r1.held_tok, '0');
    assert.strictEqual(r2.held_tok, (700_000n * 10n ** 18n).toString());
    // hasil 1000 USDG dibagi rata per token: #1 dapat 800, #2 dapat 100
    assert.ok(Math.abs(r1.realized_q - 1000) < 1e-6, `r1 ${r1.realized_q}`);
    assert.ok(Math.abs(r2.realized_q - 300) < 1e-6, `r2 ${r2.realized_q}`);
    dekat(r2.unrealized_q, 700, 'r2 unreal');
  });

  await t('zap-out: MEME tidak pernah sampai wallet -> sudah terealisasi di harga tutup, tidak dipegang', async () => {
    const d = dunia({ receipts: { [CLOSE_TX]: closeReceipt(800_000n * 10n ** 18n, ADDR.universalRouter) } });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.ok(Math.abs(r.realized_q - 1000) < 1e-6, `realized ${r.realized_q}`);
  });

  await t('pembaruan lanjutan: penjualan setelah pelacakan pertama ikut terbaca', async () => {
    const SELL = txh(900);
    const logs = [];
    const d = dunia({
      receipts: { [CLOSE_TX]: closeReceipt(), [SELL]: { blockNumber: hexb(900), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
        xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 900, SELL), xfer(ADDR.usdg, ADDR.poolManager, W, 750_000_000, 900, SELL)] } },
      logs, balances: { 899: 0n, 900: 0n },
    });
    posisi(d.store);
    await d.proceeds.track(W, { head: 800, ethUsd: ETH });
    assert.strictEqual(row(d.store).held_tok, (800_000n * 10n ** 18n).toString());
    logs.push(xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 900, SELL));
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.ok(Math.abs(r.realized_q - 950) < 1e-6, `realized ${r.realized_q}`);
    assert.strictEqual(r.tracked_to, HEAD);
  });

  await t('penjualan sebelum posisi ditutup tidak dibebankan ke posisi itu', async () => {
    // Bug nyata di lp3: wallet menjual murah, lalu esoknya membuka & menutup posisi
    // lain. Antrean yang tidak mengenal waktu menutupi kekurangan stok dengan lot
    // yang saat itu belum ada, jadi posisi yang sebenarnya untung tampil rugi besar.
    const SELL = txh(520), CLOSE2 = txh(600);
    const lot = 800_000n * 10n ** 18n;
    const d = dunia({
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(lot, W, CLOSE2),
        // 1.400.000 keluar padahal lot yang ada baru 800.000 — sisanya dari luar jendela pindai
        [SELL]: { blockNumber: hexb(520), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 1_400_000n * 10n ** 18n, 520, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 140_000_000, 520, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 1_400_000n * 10n ** 18n, 520, SELL)],
      balances: { 519: 0n, 520: 0n },
    });
    posisi(d.store, { id: '1' });
    posisi(d.store, { id: '2', closeBlock: 600, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r2 = row(d.store, '2');
    assert.strictEqual(r2.sold_tok, '0', 'posisi #2 belum ada saat penjualan itu');
    assert.strictEqual(r2.held_tok, lot.toString());
    assert.ok(Math.abs(r2.realized_q - 200) < 1e-6, `r2 realized ${r2.realized_q}`);
    dekat(r2.unrealized_q, 800, 'r2 unrealized');
  });

  await t('token yang dibeli di pasar ikut antre: penjualan tidak dibebankan ke lot LP', async () => {
    // Target memutar modal: tutup posisi -> jual, beli lagi di pasar -> jual lagi.
    // Pembelian pasar tidak pernah masuk antrean, jadi penjualan kedua menghabiskan
    // lot posisi berikutnya dan posisi itu tampak menjual murah padahal token-nya
    // masih utuh di wallet.
    const SELL1 = txh(520), BUY = txh(550), CLOSE2 = txh(600), SELL2 = txh(620);
    const lot = 800_000n * 10n ** 18n, beli = 900_000n * 10n ** 18n;
    const jual = (tok, usdg, block, tx) => ({ blockNumber: hexb(block), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
      xfer(MEME, W, ADDR.poolManager, tok, block, tx), xfer(ADDR.usdg, ADDR.poolManager, W, usdg, block, tx)] });
    const d = dunia({
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(lot, W, CLOSE2),
        [SELL1]: jual(lot, 800_000_000, 520, SELL1), [SELL2]: jual(beli, 90_000_000, 620, SELL2),
      },
      logs: [
        xfer(MEME, W, ADDR.poolManager, lot, 520, SELL1),
        xfer(MEME, ADDR.poolManager, W, beli, 550, BUY),
        xfer(MEME, W, ADDR.poolManager, beli, 620, SELL2),
      ],
      balances: { 519: 0n, 520: 0n, 619: 0n, 620: 0n },
    });
    posisi(d.store, { id: '1' });
    posisi(d.store, { id: '2', closeBlock: 600, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    assert.strictEqual(d.store.get('SELECT tok_in FROM wflows WHERE tx_hash=?', BUY).tok_in, beli.toString());
    const r1 = row(d.store, '1'), r2 = row(d.store, '2');
    assert.strictEqual(r1.sold_tok, lot.toString());
    assert.ok(Math.abs(r1.realized_q - 1000) < 1e-6, `r1 realized ${r1.realized_q}`);
    // penjualan murah itu token hasil beli di pasar, bukan lot posisi #2
    assert.strictEqual(r2.sold_tok, '0', 'posisi #2 tidak ikut terjual');
    assert.strictEqual(r2.held_tok, lot.toString());
    assert.ok(Math.abs(r2.realized_q - 200) < 1e-6, `r2 realized ${r2.realized_q}`);
    dekat(r2.unrealized_q, 800, 'r2 unrealized');
  });

  await t('sisa yang dikembalikan di tx yang sama tidak dihitung keluar', async () => {
    const ADD = txh(600);
    const d = dunia({
      receipts: { [CLOSE_TX]: closeReceipt(), [ADD]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
        xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, ADD),
        xfer(MEME, ADDR.poolManager, W, 100_000n * 10n ** 18n, 600, ADD)] } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, ADD)],
      balances: { 599: 0n, 600: 0n },
    });
    posisi(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    assert.strictEqual(d.store.get('SELECT tok_out FROM wsales WHERE tx_hash=?', ADD).tok_out, (700_000n * 10n ** 18n).toString());
    const r = row(d.store);
    assert.strictEqual(r.held_tok, (100_000n * 10n ** 18n).toString());
    dekat(r.realized_q, 900, 'realized');
  });

  await t('semua yang kembali USDG: terealisasi penuh tanpa panggilan chain', async () => {
    const d = dunia();
    posisi(d.store, { out0: 1_050_000_000, out1: 0n });
    d.store.run('UPDATE wpositions SET returned_q=1050');
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.realized_q, 1050);
    assert.strictEqual(r.pnl_q, 50);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
