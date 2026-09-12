'use strict';
// Uji penyapu sisa wallet: yang mana yang boleh dijual, yang mana yang HARUS dibiarkan,
// dan apa yang terjadi setelah masuk antrean.
//
// Ini menyentuh uang sungguhan di wallet bot, jadi yang diuji bukan cuma "jalan atau
// tidak" tapi batas-batasnya: aset kuotasi dan token posisi yang masih terbuka tidak
// boleh ikut tersapu, penyapuan sendiri tidak boleh mengirim transaksi apa pun, dan
// batas rugi harus tetap menolak rute yang buruk walau itemnya datang dari sapuan.
//
// Kasus nyata: wallet produksi 0xe9c2…81ee memegang 8 token (GM, Puff, CME, MBGA, GD,
// PONS, ChatGpt, WETH) sementara antrean jual kosong dan tidak ada posisi tertutup yang
// mencatat sisa — tidak ada satu pun jalur yang akan pernah menyentuhnya.
//
// Jalankan: node test/sapu.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { ADDR } = require('../src/chain');

const ME = '0x' + '11'.repeat(20);
const GM = '0x' + 'a1'.repeat(20);       // memecoin nganggur, berharga
const PUFF = '0x' + 'a2'.repeat(20);     // memecoin nganggur, nyaris tak berharga
const DUST = '0x' + 'a3'.repeat(20);     // debu $0
const BUKAN_RUTE = '0x' + 'a4'.repeat(20); // tidak bisa dirutekan Kyber
const DIPAKAI = '0x' + 'a5'.repeat(20);  // token posisi yang MASIH TERBUKA
const POOL = '0x' + '33'.repeat(32);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Dunia tiruan: saldo wallet apa adanya, kutipan Kyber per token yang bisa diatur,
// dan pencatat setiap transaksi yang DICOBA dikirim.
function dunia({ saldo = {}, harga = {}, dryRun = false } = {}) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((address) => ({ address, symbol: META[address]?.symbol || '?', decimals: META[address]?.decimals ?? 18 })),
    quoteSideOf: (t0, t1) => {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' }, [ADDR.weth]: { symbol: 'WETH', decimals: 18, kind: 'eth' } };
      if (q[t0]) return { side: 0, ...q[t0] };
      if (q[t1]) return { side: 1, ...q[t1] };
      return null;
    },
    token: async (a) => ({ address: a, symbol: META[a]?.symbol || '?', decimals: META[a]?.decimals ?? 18 }),
  };
  const META = {
    [GM]: { symbol: 'GM', decimals: 18 }, [PUFF]: { symbol: 'Puff', decimals: 18 },
    [DUST]: { symbol: 'MBGA', decimals: 18 }, [BUKAN_RUTE]: { symbol: 'PONS', decimals: 18 },
    [DIPAKAI]: { symbol: 'INPOS', decimals: 18 }, [ADDR.usdg]: { symbol: 'USDG', decimals: 6 },
    [ADDR.weth]: { symbol: 'WETH', decimals: 18 },
  };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), call: async () => '0x0' };
  const cfg = { mode: { dry_run: dryRun }, rules: {}, gas: {} };
  const e = new Engine({ rpc, store, chain, cfg, log: () => {} });
  e.exec.address = () => ME;

  const bal = new Map(Object.entries(saldo).map(([a, v]) => [a.toLowerCase(), v]));
  e.exec.balances = async (list) => new Map(list.map((a) => [a.toLowerCase(), bal.get(a.toLowerCase()) || 0n]));

  // Setiap transaksi yang benar-benar akan keluar ke chain lewat sini.
  const dikirim = [];
  e.exec.send = async (tx, opt) => { dikirim.push({ tx, ...opt }); return '0x' + 'f'.repeat(64); };
  e.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [] } });

  // Kutipan Kyber: `harga[token]` = USD yang bisa ditarik. null = tidak ada rute.
  const dikutip = [];
  e.kyber.quote = async (tokenIn, tokenOut, amountIn) => {
    dikutip.push({ tokenIn, tokenOut, amountIn });
    const usd = harga[tokenIn.toLowerCase()];
    if (usd == null) return null;
    // usdIn dibuat sedikit di atas usdOut supaya lossBps-nya nyata, seperti rute asli.
    return { usdIn: usd / (1 - (harga[`${tokenIn.toLowerCase()}:loss`] ?? 0.01)), usdOut: usd,
      amountOut: 1n, routeSummary: {}, dex: 'uniswapv3' };
  };
  const terjual = [];
  e.kyber.swap = async (tokenIn, tokenOut, amountIn, o) => {
    const q = await e.kyber.quote(tokenIn, tokenOut, amountIn);
    if (!q) return null;
    const loss = ((q.usdIn - q.usdOut) / q.usdIn) * 10_000;
    if (o.maxLossBps != null && loss > o.maxLossBps) {
      const err = new Error(`rute Kyber rugi ${(loss / 100).toFixed(1)}% (batas ${(o.maxLossBps / 100).toFixed(1)}%)`);
      err.loss = { lossBps: loss, maxLossBps: o.maxLossBps, usdIn: q.usdIn, usdOut: q.usdOut };
      throw err;
    }
    terjual.push({ tokenIn, tokenOut, amountIn });
    return { hash: '0x' + 'e'.repeat(64), amountOut: q.amountOut, quote: q };
  };
  e.notify = () => {};

  for (const [a, m] of Object.entries(META)) {
    store.run('INSERT OR REPLACE INTO tokens(address,symbol,decimals,seen_ts) VALUES(?,?,?,?)', a, m.symbol, m.decimals, Date.now());
  }
  return { e, store, dikirim, dikutip, terjual, bal };
}

const antre = (e) => e.leftovers().map((x) => x.token);

(async () => {
  await t('aset kuotasi tidak pernah disapu, sebanyak apa pun saldonya', async () => {
    const d = dunia({
      saldo: { [ADDR.usdg]: 276_186_557n, [ADDR.weth]: 2_158_692_439_168_406n, [ADDR.native]: 5n * E18 },
      harga: { [ADDR.usdg]: 276.19, [ADDR.weth]: 5.43 },
    });
    const r = await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [], 'USDG/WETH/ETH masuk antrean jual');
    assert.equal(r.scanned, 0);
    assert.ok(!d.dikutip.some((q) => [ADDR.usdg, ADDR.weth, ADDR.native].includes(q.tokenIn)), 'kuotasi ikut dikutip');
  });

  await t('token posisi yang masih TERBUKA tidak disentuh', async () => {
    const d = dunia({ saldo: { [DIPAKAI]: 1000n * E18, [GM]: 200n * E18 }, harga: { [DIPAKAI]: 500, [GM]: 6.9 } });
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,liquidity)
      VALUES('v4',?,?,?,'open',?,'1')`, POOL, ADDR.usdg, DIPAKAI, Date.now());
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [GM], 'token posisi terbuka ikut tersapu');
  });

  await t('token posisi yang sudah TUTUP boleh disapu', async () => {
    const d = dunia({ saldo: { [DIPAKAI]: 1000n * E18 }, harga: { [DIPAKAI]: 500 } });
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,closed_ts,liquidity)
      VALUES('v4',?,?,?,'closed',?,?,'0')`, POOL, ADDR.usdg, DIPAKAI, Date.now(), Date.now());
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [DIPAKAI]);
  });

  await t('debu di bawah ambang dilewat — tidak jadi item yang gagal selamanya', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18, [PUFF]: 194_814n * E18, [DUST]: 1000n * E18 },
      harga: { [GM]: 6.9, [PUFF]: 0.84, [DUST]: 0.0 } });
    const r = await d.e.sweepWallet({ minUsd: 0.5 });
    assert.deepEqual(antre(d.e).sort(), [GM, PUFF].sort());
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].token, DUST);
    assert.ok(/cuma \$0\.00/.test(r.skipped[0].why), `alasan tidak jelas: ${r.skipped[0].why}`);
  });

  await t('ambang dihormati: $5 menyisakan yang kecil di wallet', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18, [PUFF]: 194_814n * E18 }, harga: { [GM]: 6.9, [PUFF]: 0.84 } });
    await d.e.sweepWallet({ minUsd: 5 });
    assert.deepEqual(antre(d.e), [GM]);
  });

  await t('tanpa rute Kyber: dilewat dengan alasannya, bukan diantrekan diam-diam', async () => {
    const d = dunia({ saldo: { [BUKAN_RUTE]: 8n * E18 }, harga: {} });
    const r = await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), []);
    assert.equal(r.skipped[0].why, 'Kyber tidak menemukan rute');
  });

  await t('menyapu TIDAK mengirim transaksi apa pun', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    assert.equal(d.dikirim.length, 0, `sapuan mengirim ${d.dikirim.length} tx`);
    assert.equal(d.terjual.length, 0, 'sapuan langsung menjual');
  });

  await t('menyapu dua kali tidak menggandakan antrean', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    const r2 = await d.e.sweepWallet();
    assert.equal(d.e.leftovers().length, 1, 'item tergandakan');
    assert.equal(r2.scanned, 0, 'token yang sudah mengantre dikutip ulang percuma');
  });

  await t('sisa dari posisi yang sudah mengantre tidak disapu ulang', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    d.e.keepLeftover({ posId: 7, target: null, token: GM, quote: ADDR.usdg, amount: (200n * E18).toString(), tries: 0 }, 'x');
    await d.e.sweepWallet();
    assert.equal(d.e.leftovers().length, 1);
    assert.equal(d.e.leftovers()[0].posId, 7, 'item posisi tertimpa item sapuan');
  });

  await t('token yang ditambahkan manual di halaman Swap ikut tersapu', async () => {
    const LUAR = '0x' + 'b9'.repeat(20);   // tidak ada di tabel tokens, tidak pernah dipindai
    const d = dunia({ saldo: { [LUAR]: 100n * E18 }, harga: { [LUAR]: 6.9 } });
    d.store.setState('swap_tokens', JSON.stringify([LUAR]));
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [LUAR], 'token manual tidak terpindai');
  });

  await t('token yang pernah masuk wallet (swap_seen) ikut tersapu', async () => {
    const LUAR = '0x' + 'b8'.repeat(20);
    const d = dunia({ saldo: { [LUAR]: 100n * E18 }, harga: { [LUAR]: 6.9 } });
    d.store.setState('swap_seen', JSON.stringify({ wallet: ME, block: 1, tokens: [LUAR] }));
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [LUAR]);
  });

  await t('swap_seen milik wallet LAIN diabaikan', async () => {
    const LUAR = '0x' + 'b7'.repeat(20);
    const d = dunia({ saldo: { [LUAR]: 100n * E18 }, harga: { [LUAR]: 6.9 } });
    d.store.setState('swap_seen', JSON.stringify({ wallet: '0x' + '99'.repeat(20), block: 1, tokens: [LUAR] }));
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [], 'daftar token wallet lain ikut dipakai');
  });

  await t('tanpa wallet: menolak, tidak diam-diam tidak melakukan apa-apa', async () => {
    const d = dunia({ saldo: {}, harga: {} });
    d.e.exec.address = () => null;
    await assert.rejects(() => d.e.sweepWallet(), /wallet bot belum diatur/);
  });

  // ---- sesudah masuk antrean: yang menjual tetap jalur lama, dengan pengaman lama ----

  await t('batas rugi tetap menolak rute buruk walau itemnya dari sapuan', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    // rugi 30% > batas bawaan 15%
    d.e.kyber.quote = async () => ({ usdIn: 10, usdOut: 7, amountOut: 1n, routeSummary: {}, dex: 'x' });
    await d.e.sweepWallet();
    assert.deepEqual(antre(d.e), [GM]);
    // jadwal tunggu dilewati, kalau tidak percobaannya tidak pernah terjadi dan tes ini
    // lulus tanpa menguji apa pun
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.terjual.length, 0, 'rute rugi 30% tetap dieksekusi');
    assert.deepEqual(antre(d.e), [GM], 'item hilang dari antrean padahal belum terjual');
    assert.ok(/rugi 30\.0%/.test(d.e.leftovers()[0].why), d.e.leftovers()[0].why);
  });

  await t('rute yang lolos batas: terjual, item keluar dari antrean', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.e.leftovers();
    // jadwal tunggu dilewati supaya tick berikutnya langsung mengeksekusi
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.terjual.length, 1, 'tidak terjual padahal rutenya lolos');
    assert.equal(d.terjual[0].tokenIn, GM);
    assert.equal(d.terjual[0].tokenOut, ADDR.usdg);
    assert.deepEqual(antre(d.e), [], 'item tetap mengantre setelah terjual');
  });

  await t('saldo menyusut setelah diantre: yang dijual sebatas saldo nyata', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.bal.set(GM, 50n * E18);            // sebagian sudah dipakai di luar bot
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.terjual[0].amountIn, 50n * E18, 'menjual lebih banyak dari saldo');
  });

  await t('saldo habis di luar bot: item dibuang, bukan dicoba selamanya', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.bal.set(GM, 0n);
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.deepEqual(antre(d.e), [], 'item bersaldo nol tetap mengantre');
    assert.equal(d.terjual.length, 0);
  });

  await t('mode simulasi: antrean tidak pernah dieksekusi', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 }, dryRun: true });
    await d.e.sweepWallet();
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.terjual.length, 0, 'menjual dalam mode simulasi');
    assert.equal(d.dikirim.length, 0);
  });

  await t('posId null tidak merusak pencatatan posisi tertutup', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    // posisi tertutup yang TIDAK mencatat sisa apa pun — seperti 13 posisi di produksi
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,closed_ts,out_quote,cost_quote,quote_symbol,liquidity)
      VALUES('v4',?,?,?,'closed',?,?,150,200,'USDG','0')`, POOL, ADDR.usdg, GM, Date.now(), Date.now());
    const sebelum = d.store.get('SELECT out_quote,left_amount FROM positions WHERE id=1');
    await d.e.sweepWallet();
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    const sesudah = d.store.get('SELECT out_quote,left_amount FROM positions WHERE id=1');
    assert.equal(d.terjual.length, 1, 'tidak terjual');
    assert.deepEqual(sesudah, sebelum, 'PnL posisi tertutup ikut berubah padahal tidak punya sisa');
  });

  await t('antrean sapuan dan antrean posisi hidup berdampingan untuk token yang sama', async () => {
    const d = dunia({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    d.e.keepLeftover({ posId: 3, target: null, token: GM, quote: ADDR.usdg, amount: (10n * E18).toString(), tries: 0 }, 'x');
    // sapuan melewatinya (sudah mengantre), lalu item posisi dibuang manual
    await d.e.sweepWallet();
    d.e.dropLeftover({ posId: 3, token: GM });
    assert.deepEqual(antre(d.e), [], 'dropLeftover meleset');
    // sekarang sapuan boleh mengambil alih
    await d.e.sweepWallet();
    assert.equal(d.e.leftovers()[0].posId, null);
    d.e.dropLeftover({ posId: null, token: GM });
    assert.deepEqual(antre(d.e), [], 'item sapuan tidak bisa dibuang');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
