'use strict';
// Uji ongkos jalan posisi: gas yang terbakar + selisih swap, dipisah saat MEMBUKA
// dan saat MENUTUP (src/costs.js, lalu bentuk yang dikirim /api/position).
//
// Yang dijaga di sini:
//   - gas dihitung dari gas_used × gas_price, dan memakai gas_quote (harga ETH saat
//     transaksi) kalau sudah dibukukan — bukan harga ETH hari ini;
//   - transaksi yang REVERT tetap dihitung: gasnya benar-benar terbakar;
//   - approve yang tidak menyebut nomor posisi ikut ke transaksi bertuan sesudahnya;
//   - zap milik percobaan masuk yang BATAL tidak dibebankan ke posisi berikutnya;
//   - satu penjualan sisa yang menutup dua posisi dibagi rata;
//   - selisih swap = (kutipan masuk − kutipan keluar) + geseran harga saat eksekusi.
//
// Jalankan: node test/ongkos.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { Costs } = require('../src/costs');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const POOL2 = '0x' + 'cd'.repeat(32);
const T0 = 1_700_000_000_000;
const ETH_USD = 2500;
// 100.000 gas × 1 gwei = 0,0001 ETH = $0,25 pada $2500/ETH
const GAS = { used: 100_000, price: '1000000000', usd: 0.25 };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const dekat = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function dunia() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-ongkos-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: ETH_USD, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api };
}

const posisi = (store, id, { pool = POOL, status = 'closed', cost = 200, out = 210, txOpen, txClose } = {}) => store.run(
  `INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,opened_ts,closed_ts,
     cost_quote,out_quote,quote_symbol,tx_open,tx_close)
   VALUES(?,'v4',?,?,?,?,3000,?,?,?,?,?,'USDG',?,?)`,
  id, String(1000 + id), pool, ADDR.usdg, MEME, status, T0, status === 'closed' ? T0 + 300_000 : null,
  cost, status === 'closed' ? out : 0, txOpen ?? `0xmint${id}`, txClose ?? (status === 'closed' ? `0xburn${id}` : null));

const tx = (store, hash, ts, kind, detail, { gas = true, status = 'sukses', gasQuote = null } = {}) => store.run(
  'INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,gas_quote,detail) VALUES(?,?,?,?,?,?,?,?)',
  hash, ts, kind, status, gas ? GAS.used : null, gas ? GAS.price : null, gasQuote, detail ? JSON.stringify(detail) : null);

(async () => {
  console.log('ongkos jalan posisi');

  // ---- satu posisi utuh: approve + zap + mint, lalu burn + approve + jual sisa ----
  {
    const { store, api } = dunia();
    posisi(store, 1);
    tx(store, '0xapprove1', T0 - 40_000, 'approve_kyber', null);                                   // sebelum zap
    tx(store, '0xzap1', T0 - 30_000, 'zap_swap', { pool: POOL, usdIn: 100, usdOut: 99.2 });
    tx(store, '0xmint1', T0, 'mint', { pool: POOL, recorded: 1, zapped: { hashes: ['0xzap1'] } });
    tx(store, '0xburn1', T0 + 300_000, 'burn', { position: 1 });
    tx(store, '0xapprove1b', T0 + 310_000, 'approve_kyber', null);                                 // sebelum jual sisa
    tx(store, '0xsell1', T0 + 320_000, 'sell_leftover', { position: 1, usdIn: 73.7, usdOut: 73.1, execSlipUsd: 0.1 });
    const c = new Costs(store).of(1, ETH_USD);

    await t('fase buka: approve + zap + mint (3 tx), gas 3 × $0,25', () => {
      assert.equal(c.open.txN, 3);
      assert.ok(dekat(c.open.gasUsd, 3 * GAS.usd), `gas buka ${c.open.gasUsd}`);
      assert.ok(dekat(c.open.slipUsd, 0.8), `slip buka ${c.open.slipUsd}`);
    });
    await t('fase tutup: burn + approve + jual sisa, slip = rugi rute + geseran eksekusi', () => {
      assert.equal(c.close.txN, 3);
      assert.ok(dekat(c.close.gasUsd, 3 * GAS.usd), `gas tutup ${c.close.gasUsd}`);
      assert.ok(dekat(c.close.slipUsd, 0.7), `slip tutup ${c.close.slipUsd}`);   // 0,6 rute + 0,1 eksekusi
    });
    await t('total = gas + slippage, dan porsinya terhadap modal', async () => {
      assert.ok(dekat(c.totalUsd, 6 * GAS.usd + 1.5), `total ${c.totalUsd}`);
      const r = await api('GET', '/api/position', {}, { id: '1' });
      assert.ok(dekat(r.position.cost.totalUsd, c.totalUsd));
      assert.ok(dekat(r.position.cost.pctOfCost, (c.totalUsd / 200) * 100), `pct ${r.position.cost.pctOfCost}`);
    });
  }

  // ---- gas_quote: harga ETH SAAT ITU, bukan harga sekarang ----
  {
    const { store } = dunia();
    posisi(store, 1, { status: 'open' });
    tx(store, '0xmint1', T0, 'mint', { recorded: 1 }, { gasQuote: 0.4 });
    const c = new Costs(store).of(1, ETH_USD);
    await t('gas yang sudah dibukukan dalam USD dipakai apa adanya', () => {
      assert.ok(dekat(c.open.gasUsd, 0.4), `gas ${c.open.gasUsd}`);
    });
  }

  // ---- transaksi gagal tetap membakar gas ----
  {
    const { store } = dunia();
    posisi(store, 1, { status: 'open' });
    tx(store, '0xmintGagal', T0 - 1000, 'mint', { plan: { positionId: 1 } }, { status: 'gagal' });
    tx(store, '0xmint1', T0, 'mint', { recorded: 1 });
    const c = new Costs(store).of(1, ETH_USD);
    await t('mint yang revert ikut dihitung: gasnya tetap hilang', () => {
      assert.equal(c.open.txN, 2);
      assert.ok(dekat(c.open.gasUsd, 2 * GAS.usd), `gas ${c.open.gasUsd}`);
    });
  }

  // ---- zap dari percobaan masuk yang batal tidak dibebankan ke posisi berikutnya ----
  {
    const { store } = dunia();
    posisi(store, 2, { status: 'open', txOpen: '0xmint2' });
    tx(store, '0xzapBatal', T0 - 60_000, 'zap_swap', { pool: POOL, usdIn: 30, usdOut: 29 });
    tx(store, '0xzap2', T0 - 30_000, 'zap_swap', { pool: POOL, usdIn: 100, usdOut: 99 });
    tx(store, '0xmint2', T0, 'mint', { pool: POOL, recorded: 2, zapped: { hashes: ['0xzap2'] } });
    const c = new Costs(store).of(2, ETH_USD);
    await t('mint menyebut zap-nya sendiri: zap entry batal tidak ikut', () => {
      assert.equal(c.open.txN, 2);
      assert.ok(dekat(c.open.slipUsd, 1), `slip ${c.open.slipUsd}`);
    });
  }

  // ---- zap di pool lain tidak bocor ----
  {
    const { store } = dunia();
    posisi(store, 3, { status: 'open', txOpen: '0xmint3' });
    tx(store, '0xzapPoolLain', T0 - 20_000, 'zap_swap', { pool: POOL2, usdIn: 50, usdOut: 45 });
    tx(store, '0xmint3', T0, 'mint', { pool: POOL, recorded: 3 });
    const c = new Costs(store).of(3, ETH_USD);
    await t('zap di pool lain bukan ongkos posisi ini', () => {
      assert.equal(c.open.txN, 1);
      assert.ok(dekat(c.open.slipUsd, 0), `slip ${c.open.slipUsd}`);
    });
  }

  // ---- satu penjualan sisa untuk dua posisi: dibagi rata ----
  {
    const { store } = dunia();
    posisi(store, 4, { txClose: '0xburn4' });
    posisi(store, 5, { txClose: '0xburn5' });
    tx(store, '0xmint4', T0, 'mint', { recorded: 4 });
    tx(store, '0xmint5', T0, 'mint', { recorded: 5 });
    tx(store, '0xburn4', T0 + 300_000, 'burn', { position: 4 });
    tx(store, '0xburn5', T0 + 300_000, 'burn', { position: 5 });
    tx(store, '0xsellGabung', T0 + 320_000, 'sell_leftover',
      { usdIn: 100, usdOut: 98, positionSales: [{ position: 4 }, { position: 5 }] });
    const costs = new Costs(store);
    await t('jual sisa dua posisi: gas & selisihnya dibagi dua', () => {
      for (const id of [4, 5]) {
        const c = costs.of(id, ETH_USD);
        assert.ok(dekat(c.close.gasUsd, GAS.usd + GAS.usd / 2), `gas #${id} ${c.close.gasUsd}`);
        assert.ok(dekat(c.close.slipUsd, 1), `slip #${id} ${c.close.slipUsd}`);
      }
    });
  }

  // ---- klaim fee & compound: ongkos, tapi bukan ongkos buka/tutup ----
  {
    const { store } = dunia();
    posisi(store, 6, { status: 'open' });
    tx(store, '0xmint6', T0, 'mint', { recorded: 6 });
    tx(store, '0xclaim6', T0 + 100_000, 'claim_fees', { position: 6 });
    const c = new Costs(store).of(6, ETH_USD);
    await t('klaim fee masuk kolom "lain", bukan buka atau tutup', () => {
      assert.equal(c.open.txN, 1); assert.equal(c.close.txN, 0); assert.equal(c.lain.txN, 1);
      assert.ok(dekat(c.totalUsd, 2 * GAS.usd));
    });
  }

  // ---- approve yatim dari alur yang jauh sebelumnya tidak dibebankan ----
  {
    const { store } = dunia();
    posisi(store, 7, { status: 'open' });
    tx(store, '0xapproveYatim', T0 - 60 * 60_000, 'approve_kyber', null);   // sejam sebelum mint
    tx(store, '0xmint7', T0, 'mint', { recorded: 7 });
    const c = new Costs(store).of(7, ETH_USD);
    await t('approve berumur satu jam sebelum mint: di luar jendela, tidak ikut', () => {
      assert.equal(c.open.txN, 1);
    });
  }

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
