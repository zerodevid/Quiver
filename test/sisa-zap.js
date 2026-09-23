'use strict';
// Uji: kelebihan token zap pada entry yang BERHASIL masuk antrean jual.
// Kasus nyata (#417, 22 Sep): zap beli 3.394 NOSH untuk LP $110, harga pool bergerak
// 482 tick dalam 9 detik sebelum mint masuk, mint cuma menyetor 371,62 NOSH — 3.022,38
// NOSH sisanya duduk telanjang di wallet (rescueZap cuma jalan kalau LP gagal, sapu
// wallet melewati token posisi yang masih terbuka).
// Jalankan: node test/sisa-zap.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR, TOPIC } = require('../src/chain');

const USDG = ADDR.usdg;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const PM = '0x' + '99'.repeat(20);
const MINT = '0x' + 'ab'.repeat(32);
const coder = ethers.AbiCoder.defaultAbiCoder();

const PLAN = { venue: 'v4', poolRef: '0x' + '33'.repeat(32), token0: USDG, token1: MEME, target: null };
// 1 MEME = $0,0028 (18 desimal vs 6 desimal USDG) — dipakai gerbang debu.
const HARGA = 0.0028;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// Receipt mint: `masuk` MEME keluar dari wallet ke PoolManager (modal yang benar-benar
// jadi likuiditas). spentIn membacanya dari log Transfer, bukan dari selisih saldo.
function receiptMint(masuk) {
  return { status: '0x1', blockNumber: '0x10', logs: [{
    address: MEME, topics: [TOPIC.transfer, ethers.zeroPadValue(ME, 32), ethers.zeroPadValue(PM, 32)],
    data: coder.encode(['uint256'], [masuk]),
  }] };
}

function engineWith({ saldo = null } = {}) {
  const store = new Store(':memory:');
  const eng = new Engine({
    store,
    rpc: { call: async () => null, ethCallMany: async (c) => c.map(() => null) },
    // Tanpa ADDR/isV3Venue supaya ensureChain melengkapinya dengan chain robinhood asli
    // (QUOTES sungguhan: USDG itu kas, MEME bukan).
    chain: {
      slot0V4: async () => ({ sqrtPriceX96: 1n, tick: 0 }),
      token: async (a) => ({ address: a, symbol: 'MEME', decimals: 18 }),
      tokens: async (list) => list.map((a) => ({ address: a, symbol: a === USDG ? 'USDG' : 'MEME', decimals: a === USDG ? 6 : 18 })),
      valueInQuote: ({ amount1 }) => ({ value: (Number(amount1) / 1e18) * HARGA, kind: 'usd', symbol: 'USDG', side: 0 }),
    },
    cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {},
  });
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((x) => [String(x).toLowerCase(), saldo == null ? 10n ** 30n : saldo]));
  eng.notify = () => {};
  // Baris tx mint, supaya penanda "sudah disapu" punya tempat ditulis.
  store.run('INSERT INTO txs(chain,hash,ts,kind,status,detail) VALUES(?,?,?,?,?,?)',
    'robinhood', MINT, Date.now(), 'mint', 'sukses', JSON.stringify({ pool: PLAN.poolRef }));
  return { eng, store };
}

const zap = (gained, extra = {}) => ({ token: MEME, quote: USDG, before: 0n, gained: String(gained), hashes: ['0x' + 'cd'.repeat(32)], ...extra });

(async () => {
  console.log('Kelebihan zap sesudah LP dibuka:\n');

  await t('yang dibeli tapi tidak jadi disetor masuk antrean jual', async () => {
    const { eng } = engineWith();
    const beli = 3394000000000000000000n, masuk = 371617226748265173792n;
    const r = await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(masuk), { hash: MINT });
    assert.strictEqual(r.amount, String(beli - masuk), 'yang diantrekan = beli - yang masuk LP');
    const q = eng.leftovers();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].token, MEME);
    assert.strictEqual(q[0].amount, String(beli - masuk));
    assert.strictEqual(q[0].posId ?? null, null, 'bukan sisa posisi: hasil jualnya tidak boleh dibukukan ke posisi');
    assert.strictEqual(q[0].quote, USDG);
  });

  await t('zap yang terpakai habis tidak meninggalkan apa-apa', async () => {
    const { eng } = engineWith();
    const beli = 3394000000000000000000n;
    assert.strictEqual(await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(beli), { hash: MINT }), null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('debu di bawah $0,50 dibiarkan di wallet', async () => {
    const { eng } = engineWith();
    const beli = 3394000000000000000000n;
    // sisa 50 MEME ~ $0,14: penjualannya tidak menutup gasnya sendiri
    await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(beli - 50n * 10n ** 18n), { hash: MINT });
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('tidak pernah mengantre lebih dari yang benar-benar bebas di wallet', async () => {
    // Saldo nyata cuma 1.000 MEME (sebagian sudah terpakai program lain / sudah terjual):
    // yang diantrekan ikut saldo, bukan angka receipt.
    const { eng } = engineWith({ saldo: 1000n * 10n ** 18n });
    const beli = 3394000000000000000000n, masuk = 371617226748265173792n;
    const r = await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(masuk), { hash: MINT });
    assert.strictEqual(r.amount, String(1000n * 10n ** 18n));
  });

  await t('hasil zap yang tidak terbaca tidak ditebak dari saldo', async () => {
    const { eng } = engineWith();
    const r = await eng.sweepZapSurplus(PLAN, zap(0, { gainedUnknown: true }), receiptMint(0n), { hash: MINT });
    assert.strictEqual(r, null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('sekali per mint: alur masuk + pembukuan tertunda tidak menghitung dua kali', async () => {
    const { eng } = engineWith();
    const beli = 3394000000000000000000n, masuk = 371617226748265173792n;
    await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(masuk), { hash: MINT });
    const lagi = await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(masuk), { hash: MINT });
    assert.strictEqual(lagi, null);
    assert.strictEqual(eng.leftovers().length, 1);
    assert.strictEqual(eng.leftovers()[0].amount, String(beli - masuk), 'jumlahnya tidak berlipat');
  });

  await t('item lama untuk token yang sama ditambah, bukan ditimpa', async () => {
    const { eng } = engineWith();
    eng.keepLeftover({ posId: null, target: null, token: MEME, quote: USDG, amount: '1000', tries: 0, since: Date.now() }, 'uji');
    const beli = 3394000000000000000000n, masuk = 371617226748265173792n;
    await eng.sweepZapSurplus(PLAN, zap(beli), receiptMint(masuk), { hash: MINT });
    assert.strictEqual(eng.leftovers().length, 1);
    assert.strictEqual(eng.leftovers()[0].amount, String(beli - masuk + 1000n));
  });

  await t('aset kuotasi tidak pernah dianggap sisa', async () => {
    const { eng } = engineWith();
    const r = await eng.sweepZapSurplus({ ...PLAN, token1: USDG }, { ...zap(10n ** 18n), token: USDG }, receiptMint(0n), { hash: MINT });
    assert.strictEqual(r, null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
