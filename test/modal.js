'use strict';
// Uji pelacak modal wallet (capital.js): baseline, klasifikasi setoran/penarikan,
// dan PnL bersih = nilai − modal.
//
// Kasus nyata: modal disetor 0,1552 ETH (~$381) + wallet awal ~$20 → ~$401; dasbor
// bilang "modal $447" karena modal diturunkan dari PnL per-posisi (nilai − PnL) yang
// tidak memuat biaya zap/gas/swap. Pemilik menghitung "400 → 520 = untung 120".
//
// Sumber datanya RPC publik: log Transfer untuk USDG/WETH, selisih saldo untuk ETH
// polos (tidak ada log). Dulu alchemy_getAssetTransfers — berhenti saat kuota habis.
//
// Jalankan: node test/modal.js
const assert = require('node:assert');
const { ethers } = require('ethers');
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
const topic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TRANSFER = ethers.id('Transfer(address,address,uint256)');

// Dunia tiruan: blok 1000 = ts 1.000.000 s; wallet awal 0,002 ETH + 12 USDG; ETH $2500.
// `logs`: transfer token; `eth`: saldo ETH per blok (blok tanpa entri = saldo blok
// sebelumnya); `ourBlocks`: blok tempat tx bot mendarat; `blockTxs`: isi blok (tx wallet
// yang bukan tx bot) — tanpa itu, sisa selisih dianggap transfer internal.
function dunia({ logs = [], senders = {}, code = {}, eth = {}, ourBlocks = {}, blockTxs = {} } = {}) {
  const store = new Store(':memory:');
  store.run("INSERT INTO txs(hash,ts,kind,status) VALUES('0xown',1,'burn','sukses')");
  for (const [h, b] of Object.entries(ourBlocks)) store.run("INSERT INTO txs(hash,ts,kind,status) VALUES(?,?,'mint','sukses')", h, b * 1000 * 1000);
  store.run('INSERT INTO equity(ts,total_quote) VALUES(?,0)', 1000 * 1000 * 1000);   // bot mulai mencatat di blok 1000
  const balAt = (n) => { let v = 2n * 10n ** 15n; for (const b of Object.keys(eth).map(Number).sort((a, c) => a - c)) if (b <= n) v = BigInt(eth[b]); return v; };
  const one = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { timestamp: hex(parseInt(params[0], 16) * 1000), transactions: params[1] ? (blockTxs[parseInt(params[0], 16)] || []).map((t) => ({ ...t, value: hex(t.value || 0) })) : [] };
    if (method === 'eth_getTransactionByHash') return { from: senders[params[0]] || EOA };
    if (method === 'eth_getTransactionReceipt') return ourBlocks[params[0]] ? { blockNumber: hex(ourBlocks[params[0]]) } : null;
    if (method === 'eth_getCode') return code[params[0]] ? '0x6080' : '0x';
    if (method === 'eth_getBalance') return hex(balAt(parseInt(params[1], 16)));
    throw new Error('rpc ' + method);
  };
  const rpc = {
    blockNumber: async () => 2005,
    hasArchive: () => true,
    call: one,
    batch: async (calls) => Promise.all(calls.map(async (c) => { try { return { result: await one(c.method, c.params) }; } catch (e) { return { error: { message: e.message } }; } })),
    callAt: async (to) => word(to === ADDR.usdg ? 12_000_000 : 0),
    getLogs: async (f) => logs.filter((l) => f.address.includes(l.address) && (f.topics[1] == null || l.topics[1] === f.topics[1]) && (f.topics[2] == null || l.topics[2] === f.topics[2])
      && parseInt(l.blockNumber, 16) >= parseInt(f.fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(f.toBlock, 16)),
  };
  const chain = { ethUsdAt: async () => 2500 };
  const cap = new Capital({ rpc, store, chain, cfg: {}, log: () => {} });
  return { store, cap };
}
let li = 0;
const tr = ({ dir, asset = ADDR.usdg, value, block = 1500, hash, cp = EOA }) => ({
  address: asset, transactionHash: hash, blockNumber: hex(block), logIndex: hex(li++), data: word(value),
  topics: [TRANSFER, topic(dir === 'in' ? cp : W), topic(dir === 'in' ? W : cp)],
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

  await t('setoran ETH polos = selisih saldo yang tidak dijelaskan tx bot; hasil swap sendiri & tx bot dilewati', async () => {
    const d = dunia({
      logs: [
        tr({ dir: 'in', value: 200_000_000, hash: '0xown', cp: ADDR.poolManager }), // hasil tutup posisi (tx bot)
        tr({ dir: 'in', value: 17_000_000, hash: '0xswap', cp: KYBER }),           // hasil swap manual (kita pengirimnya)
      ],
      senders: { '0xswap': W },
      // blok 1300: tx bot bayar gas 0,0001 ETH; blok 1500: setoran 0,12 ETH dari luar
      eth: { 1300: 19n * 10n ** 14n, 1500: 19n * 10n ** 14n + 12n * 10n ** 16n },
      ourBlocks: { '0xgas': 1300 },
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'deposit'); assert.strictEqual(rows[0].symbol, 'ETH');
    assert.strictEqual(rows[0].amount, String(12n * 10n ** 16n));
    dekat(rows[0].usd, 0.12 * 2500, 'usd setoran');
    const s = d.cap.summary();
    dekat(s.depositsUsd, 300, 'total setoran');
    dekat(s.capitalUsd, s.baselineUsd + 300, 'modal');
  });

  await t('setoran USDG dari EOA tercatat dengan blok & waktunya', async () => {
    const d = dunia({ logs: [tr({ dir: 'in', value: 1_085_913_914, hash: '0xdep', block: 1700 })] });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.kind, 'deposit'); assert.strictEqual(row.block, 1700); assert.strictEqual(row.ts, 1700 * 1000 * 1000);
    dekat(row.usd, 1085.91, 'usd'); assert.strictEqual(row.counterparty, EOA);
  });

  await t('keluar: ke kontrak (swap/LP) bukan penarikan; ke EOA yang kita kirim = penarikan', async () => {
    const d = dunia({
      logs: [
        tr({ dir: 'out', value: 50_000_000, hash: '0xlp', cp: ADDR.poolManager }),
        tr({ dir: 'out', value: 30_000_000, hash: '0xsw', cp: CONTRACT }),
        tr({ dir: 'out', value: 5_000_000, hash: '0xpull', cp: EOA }),   // ditarik pihak lain (bukan kita pengirimnya)
      ],
      senders: { '0xlp': W, '0xsw': W, '0xpull': CONTRACT },
      code: { [CONTRACT]: true },
      eth: { 1600: 1n * 10n ** 15n },   // 0,001 ETH dikirim manual ke luar
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'withdraw'); assert.strictEqual(rows[0].symbol, 'ETH'); dekat(rows[0].usd, 2.5, 'usd penarikan');
    dekat(d.cap.summary().capitalUsd, d.cap.summary().baselineUsd - 2.5, 'modal berkurang');
  });

  await t('sync ulang tidak menggandakan; modal pada waktu t hanya memuat setoran sampai t', async () => {
    const d = dunia({ logs: [tr({ dir: 'in', value: 250_000_000, hash: '0xa', block: 1200 }), tr({ dir: 'in', value: 250_000_000, hash: '0xb', block: 1800 })] });
    await d.cap.sync(W);
    d.store.setState('deposits_scanned_to:robinhood', '1000');  // paksa pindai ulang rentang yang sama
    await d.cap.sync(W);
    assert.strictEqual(d.cap.rows().length, 2);
    const base = d.cap.summary().baselineUsd;
    dekat(d.cap.capitalAt(1500 * 1000 * 1000), base + 250, 'setelah setoran pertama saja');
    dekat(d.cap.capitalAt(), base + 500, 'sekarang');
  });

  await t('selisih saldo ETH: titik awal dari kursor lama (basis data versi Alchemy), tidak menghitung ulang jendela yang sudah lewat', async () => {
    const d = dunia({ eth: { 1200: 5n * 10n ** 17n, 1900: 6n * 10n ** 17n } });
    await d.cap.baseline(W);
    d.store.setState('deposits_scanned_to:robinhood', '1500');   // Alchemy sempat memindai sampai 1500
    d.store.setState('capital_eth_checkpoint:robinhood', null); d.store.run("DELETE FROM state WHERE k='capital_eth_checkpoint:robinhood'");
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.amount, String(1n * 10n ** 17n), 'hanya kenaikan setelah blok 1500');
    assert.strictEqual(row.tx_hash, 'eth:1900', 'blok tempat saldo berubah');
    assert.strictEqual((await d.cap.sync(W)).added, 0, 'jendela kosong: tidak ada yang baru');
  });

  await t('galat RPC di tengah jendela: tidak ada yang dicatat, kursor tidak maju', async () => {
    const d = dunia({ logs: [tr({ dir: 'in', value: 250_000_000, hash: '0xa' })], eth: { 1500: 1n * 10n ** 18n } });
    await d.cap.baseline(W);
    const { call, batch } = d.cap.rpc;
    d.cap.rpc.call = async (m, p) => { if (m === 'eth_getBalance') throw new Error('historical state unavailable'); return call(m, p); };
    d.cap.rpc.batch = async (calls) => { if (calls.some((c) => c.method === 'eth_getBalance')) throw new Error('historical state unavailable'); return batch(calls); };
    await assert.rejects(d.cap.sync(W), /historical state/);
    assert.strictEqual(d.cap.rows().length, 1, 'setoran token tetap tercatat (kursornya terpisah)');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 1000, 'titik awal ETH masih di baseline');
    d.cap.rpc.call = call; d.cap.rpc.batch = batch;
    assert.strictEqual((await d.cap.sync(W)).added, 1);
    assert.strictEqual(d.cap.rows().length, 2);
  });

  await t('jendela menumpuk dicicil: paling banyak 25 blok tx per sync, setoran di sela-selanya tetap ketemu', async () => {
    const ourBlocks = {}; const eth = {};
    let bal = 2n * 10n ** 15n;
    for (let i = 0; i < 50; i++) { const b = 1100 + i * 10; ourBlocks['0xtx' + i] = b; bal -= 10n ** 12n; eth[b] = bal; }   // 50 tx bot, tiap tx gas 0,000001 ETH
    // setoran 0,3 ETH di blok 1345 (di antara tx ke-25 dan ke-26: di luar cicilan pertama)
    for (let i = 0; i < 50; i++) { const b = 1100 + i * 10; if (b > 1345) eth[b] += 3n * 10n ** 17n; }
    eth[1345] = eth[1340] + 3n * 10n ** 17n;
    const d = dunia({ eth, ourBlocks });
    const r1 = await d.cap.sync(W);
    const ck1 = JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood'));
    assert.strictEqual(ck1.block, 1100 + 24 * 10, 'berhenti di blok tx ke-25');
    assert.strictEqual(r1.added, 0, 'setoran belum masuk jendela pertama');
    const r2 = await d.cap.sync(W);
    assert.strictEqual(r2.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.amount, String(3n * 10n ** 17n), 'setoran ketemu di cicilan kedua, gas tx bot tidak ikut');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 2000);
  });

  await t('ETH manual: ke router (kontrak) = swap, bukan penarikan; ke EOA = penarikan; dari EOA = setoran; unwrap WETH bukan penarikan', async () => {
    const ROUTER = '0x' + '55'.repeat(20);
    const d = dunia({
      eth: { 1300: 2n * 10n ** 15n - 4n * 10n ** 14n, 1500: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n, 1700: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n + 6n * 10n ** 14n, 1800: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n + 6n * 10n ** 14n + 1n * 10n ** 14n },
      blockTxs: {
        1300: [{ hash: '0xswap', from: W, to: ROUTER, value: 4n * 10n ** 14n }],          // swap manual 0,0004 ETH lewat router
        1500: [{ hash: '0xsend', from: W, to: EOA, value: 2n * 10n ** 14n }],             // kirim 0,0002 ETH ke orang
        1700: [{ hash: '0xrecv', from: EOA, to: W, value: 6n * 10n ** 14n }],             // terima 0,0006 ETH
        1800: [{ hash: '0xunwrap', from: W, to: ADDR.weth, value: 0 }],                   // unwrap WETH: ETH bertambah 0,0001
      },
      logs: [tr({ dir: 'out', asset: ADDR.weth, value: 1n * 10n ** 14n, hash: '0xunwrap', block: 1800, cp: '0x' + '0'.repeat(40) })],
      senders: { '0xunwrap': W },
      code: { [ROUTER]: true },
    });
    const r = await d.cap.sync(W);
    const rows = d.cap.rows().map((x) => [x.kind, x.symbol, x.tx_hash, x.amount]);
    assert.deepStrictEqual(rows, [['withdraw', 'ETH', '0xsend', String(2n * 10n ** 14n)], ['deposit', 'ETH', '0xrecv', String(6n * 10n ** 14n)]]);
    assert.strictEqual(r.added, 2);
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 1700, 'tiga titik per sync: berhenti di titik ketiga');
    assert.strictEqual(d.cap.backlog, true);
    assert.strictEqual((await d.cap.sync(W)).added, 0, 'unwrap: bukan penarikan, bukan setoran');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 2000);
    assert.strictEqual(d.cap.backlog, false);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
