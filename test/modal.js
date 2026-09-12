'use strict';
// Uji pelacak modal wallet (capital.js): baseline, klasifikasi setoran/penarikan,
// dan PnL bersih = nilai − modal.
//
// Kasus nyata: modal disetor 0,1552 ETH (~$381) + wallet awal ~$20 → ~$401; dasbor
// bilang "modal $447" karena modal diturunkan dari PnL per-posisi (nilai − PnL) yang
// tidak memuat biaya zap/gas/swap. Pemilik menghitung "400 → 520 = untung 120".
//
// Jalankan: node test/modal.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Capital } = require('../src/capital');
const { ADDR } = require('../src/chain');

const W = '0x' + '11'.repeat(20);
const EOA = '0x' + '22'.repeat(20);
const CONTRACT = '0x' + '33'.repeat(20);
const KYBER = '0x' + '44'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const dekat = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// Dunia tiruan: blok 1000 = ts 1.000.000 s; wallet awal 0,002 ETH + 12 USDG; ETH $2500.
function dunia({ transfers = [], senders = {}, code = {} } = {}) {
  const store = new Store(':memory:');
  store.run("INSERT INTO txs(hash,ts,kind,status) VALUES('0xown',1,'burn','sukses')");
  store.run('INSERT INTO equity(ts,total_quote) VALUES(?,0)', 1000 * 1000 * 1000);   // bot mulai mencatat di blok 1000
  const rpc = {
    blockNumber: async () => 2000,
    call: async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { timestamp: hex(parseInt(params[0], 16) * 1000) };
      if (method === 'eth_getTransactionByHash') return { from: senders[params[0]] || EOA };
      if (method === 'eth_getCode') return code[params[0]] ? '0x6080' : '0x';
      throw new Error('rpc ' + method);
    },
    ethCallMany: async (c) => c.map(() => '0x'),
  };
  const chain = { ethUsdAt: async () => 2500 };
  const cfg = { chain: { endpoints: [{ url: 'https://x.g.alchemy.com/v2/KEY' }] } };
  const cap = new Capital({ rpc, store, chain, cfg, log: () => {} });
  cap.alchemy = async (method, [q, tag]) => {
    if (method === 'eth_getBalance') return hex(2n * 10n ** 15n);
    if (method === 'eth_call') return word(q.to === ADDR.usdg ? 12_000_000 : 0);
    return { transfers: transfers.filter((x) => (q.toAddress ? x.to === W : x.from === W)) };
  };
  return { store, cap };
}
const tr = ({ dir, asset = 'eth', value, block = 1500, hash, cp = EOA }) => ({
  hash, blockNum: hex(block), uniqueId: `${hash}:${dir}`, category: asset === 'eth' ? 'external' : 'erc20',
  from: dir === 'in' ? cp : W, to: dir === 'in' ? W : cp,
  rawContract: { value: hex(value), address: asset === 'eth' ? null : asset },
  metadata: { blockTimestamp: new Date(block * 1000 * 1000).toISOString() },
});

(async () => {
  await t('baseline: kas di blok awal + posisi yang sudah ada (adopsi)', async () => {
    const d = dunia();
    d.store.run(`INSERT INTO positions(venue,pool_ref,status,opened_ts,cost_quote,quote_symbol) VALUES('v4','p','closed',?,12.46,'USDG')`, 900 * 1000 * 1000);
    d.store.run(`INSERT INTO positions(venue,pool_ref,status,opened_ts,cost_quote,quote_symbol) VALUES('v4','p','open',?,200,'USDG')`, 1500 * 1000 * 1000);
    const b = await d.cap.baseline(W);
    assert.strictEqual(b.block, 1000);
    dekat(b.cashUsd, 12 + 0.002 * 2500, 'kas awal');
    dekat(b.positionsUsd, 12.46, 'hanya posisi yang sudah terbuka saat itu');
    dekat(d.cap.capitalAt(), b.usd, 'modal = baseline tanpa setoran');
  });

  await t('setoran ETH dari luar dinilai harga ETH saat itu; tx bot & hasil swap sendiri dilewati', async () => {
    const d = dunia({
      transfers: [
        tr({ dir: 'in', value: 12n * 10n ** 16n, hash: '0xdep' }),                                  // 0,12 ETH dari EOA
        tr({ dir: 'in', asset: ADDR.usdg, value: 200_000_000, hash: '0xown', cp: ADDR.poolManager }), // hasil tutup posisi (tx bot)
        tr({ dir: 'in', asset: ADDR.usdg, value: 17_000_000, hash: '0xswap', cp: KYBER }),           // hasil swap manual (kita pengirimnya)
      ],
      senders: { '0xswap': W, '0xdep': EOA },
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'deposit'); assert.strictEqual(rows[0].symbol, 'ETH');
    dekat(rows[0].usd, 0.12 * 2500, 'usd setoran');
    const s = d.cap.summary();
    dekat(s.depositsUsd, 300, 'total setoran');
    dekat(s.capitalUsd, s.baselineUsd + 300, 'modal');
  });

  await t('keluar: ke kontrak (swap/LP) bukan penarikan; ke EOA yang kita kirim = penarikan', async () => {
    const d = dunia({
      transfers: [
        tr({ dir: 'out', asset: ADDR.usdg, value: 50_000_000, hash: '0xlp', cp: ADDR.poolManager }),
        tr({ dir: 'out', asset: ADDR.usdg, value: 30_000_000, hash: '0xsw', cp: CONTRACT }),
        tr({ dir: 'out', value: 1n * 10n ** 16n, hash: '0xwd', cp: EOA }),
        tr({ dir: 'out', asset: ADDR.usdg, value: 5_000_000, hash: '0xpull', cp: EOA }),   // ditarik pihak lain (bukan kita pengirimnya)
      ],
      senders: { '0xlp': W, '0xsw': W, '0xwd': W, '0xpull': CONTRACT },
      code: { [CONTRACT]: true },
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'withdraw'); dekat(rows[0].usd, 25, 'usd penarikan');
    dekat(d.cap.summary().capitalUsd, d.cap.summary().baselineUsd - 25, 'modal berkurang');
  });

  await t('sync ulang tidak menggandakan; modal pada waktu t hanya memuat setoran sampai t', async () => {
    const d = dunia({ transfers: [tr({ dir: 'in', value: 1n * 10n ** 17n, hash: '0xa', block: 1200 }), tr({ dir: 'in', value: 1n * 10n ** 17n, hash: '0xb', block: 1800 })] });
    await d.cap.sync(W);
    d.store.setState('deposits_scanned_to', '1000');  // paksa pindai ulang rentang yang sama
    await d.cap.sync(W);
    assert.strictEqual(d.cap.rows().length, 2);
    const base = d.cap.summary().baselineUsd;
    dekat(d.cap.capitalAt(1500 * 1000 * 1000), base + 250, 'setelah setoran pertama saja');
    dekat(d.cap.capitalAt(), base + 500, 'sekarang');
  });

  await t('tanpa endpoint Alchemy: tidak tersedia, summary null', async () => {
    const d = dunia();
    d.cap.cfg = { chain: { endpoints: [{ url: 'https://rpc.example' }] } };
    assert.strictEqual(d.cap.available(), false);
    assert.strictEqual(await d.cap.sync(W), null);
    assert.strictEqual(d.cap.summary(), null);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
