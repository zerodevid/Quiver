'use strict';
// Uji penilaian ulang posisi wallet yang masih terbuka (WalletResearch.refreshOpen).
//
// Bug yang dijaga di sini: baris wpositions hanya ditulis ulang saat wallet-nya
// dipindai, dan pemindaian cuma dipicu halaman Wallet/Target atau aksi baru si target.
// Target yang diam berjam-jam karena itu tampil dengan nilai dari beberapa detik
// setelah dia mint — di halaman Pool angka itu berdampingan dengan posisi bot yang
// dihitung ulang tiap 30 detik, sehingga pool yang SAMA dengan rentang yang SAMA
// terbaca +1,6% di satu tabel dan −2,2% di tabel sebelahnya.
//
// Jalankan: node test/nilai-riset.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { WalletResearch } = require('../src/wallet');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const W = '0xe1d742e039aea02402b2d864b70ea55b5e0f3e79';
const MEME = '0xe2324ff2a59f8ecba8c321c6466e59121c00e795';
const POOL = '0x' + '11'.repeat(32);
// Rentang asli dari kejadian yang memunculkan bug: USDG/MEME, mint di LUAR rentang
// (seluruhnya USDG) lalu harga turun masuk ke dalamnya.
const LO = 321574, HI = 340856, ENTRY = 321420;
const L = 6196195902088646n;
const MODAL = 399.054643;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

const w256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// Dunia palsu: hanya harga pool dan storage PoolManager yang dipalsukan; penilaian
// (valueInQuote/quoteSideOf) dan matematika tick memakai kode sungguhan.
function dunia({ tick = ENTRY, likuiditasOnchain = L, tokensTable = true } = {}) {
  const store = new Store(':memory:');
  const hit = { slot0: 0, fee: 0 };
  const rpc = {
    // unclaimedV4 membaca 9 slot per posisi; yang penting di sini slot ke-7 (L).
    // Sisanya nol -> fee berjalan nol, cukup untuk menguji nilai pokoknya.
    ethCallMany: async (calls) => {
      hit.fee++;
      return calls.map((_, i) => (i % 9 === 6 ? w256(likuiditasOnchain) : w256(0)));
    },
  };
  const chain = new Chain(rpc, store, () => {});
  chain.slot0V4Many = async (ids) => {
    hit.slot0++;
    return ids.map(() => ({ sqrtPriceX96: m.getSqrtRatioAtTick(tick), tick, protocolFee: 0, lpFee: 0 }));
  };
  if (tokensTable) {
    store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
    store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  }
  store.run(
    `INSERT INTO wpositions (wallet,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,
       invested_q,returned_q,fees_q,pnl_q,live_value_q,live_fee_q,in_range,quote_symbol,status,opened_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    W, 'v4', '2449473', POOL, ADDR.usdg, MEME, 31100, LO, HI, L.toString(),
    MODAL, 0, 0, 0, MODAL, 0, 0, 'USDG', 'open', Date.now());
  const research = new WalletResearch({ rpc, store, chain, log: () => {} });
  const baris = () => store.all('SELECT * FROM wpositions WHERE wallet=?', W)
    .map((r) => ({ ...r, dec0: 6, dec1: 18 }));
  return { store, research, baris, hit };
}

(async () => {
  console.log('\nPenilaian ulang posisi wallet terbuka');

  await t('REGRESI: nilai tidak lagi ketinggalan di foto saat pemindaian', async () => {
    // Harga turun jauh ke dalam rentang: USDG-nya sebagian sudah berganti MEME, jadi
    // nilainya dalam USDG tidak mungkin sama dengan modal.
    const { research, baris } = dunia({ tick: (LO + HI) / 2 | 0 });
    const rows = baris();
    assert.strictEqual(rows[0].pnl_q, 0, 'prasyarat: baris tersimpan masih foto lama');
    await research.refreshOpen(rows, 2500);
    assert.ok(rows[0].liveTs, 'baris ditandai sudah dinilai di harga sekarang');
    assert.ok(rows[0].live_value_q < MODAL, `nilai turun setelah harga jatuh (dapat ${rows[0].live_value_q})`);
    assert.ok(rows[0].pnl_q < -1, `PnL ikut negatif (dapat ${rows[0].pnl_q})`);
    assert.strictEqual(rows[0].in_range, 1, 'harga sekarang di dalam rentang');
  });

  await t('hasilnya ditulis ke DB, jadi ringkasan wallet tidak berbeda dengan tabelnya', async () => {
    const { research, baris, store } = dunia({ tick: (LO + HI) / 2 | 0 });
    await research.refreshOpen(baris(), 2500);
    const r = store.get('SELECT live_value_q, pnl_q FROM wpositions WHERE wallet=?', W);
    assert.ok(r.live_value_q < MODAL && r.pnl_q < -1, 'nilai & PnL tersimpan ikut segar');
  });

  await t('harga masih di luar rentang: posisi tetap seluruhnya USDG, nilainya tidak berubah', async () => {
    const { research, baris } = dunia({ tick: ENTRY });
    const rows = baris();
    await research.refreshOpen(rows, 2500);
    assert.ok(Math.abs(rows[0].live_value_q - MODAL) < 0.01, `nilai tetap modal (dapat ${rows[0].live_value_q})`);
    assert.strictEqual(rows[0].in_range, 0);
  });

  await t('desimal token dicari sendiri kalau pemanggil tidak menghiasi barisnya', async () => {
    const { research, store } = dunia({ tick: (LO + HI) / 2 | 0 });
    const polos = store.all('SELECT * FROM wpositions WHERE wallet=?', W);   // tanpa dec0/dec1
    await research.refreshOpen(polos, 2500);
    const { research: r2, baris } = dunia({ tick: (LO + HI) / 2 | 0 });
    const dihias = baris();
    await r2.refreshOpen(dihias, 2500);
    assert.ok(Math.abs(polos[0].live_value_q - dihias[0].live_value_q) < 1e-9,
      'nilainya sama dengan baris yang sudah membawa desimal');
  });

  await t('likuiditas on-chain sudah nol: angka lama dipertahankan, tidak dicap segar', async () => {
    // Posisi ditutup setelah pemindaian terakhir — hasil tutupnya belum terbaca, jadi
    // menuliskan nilai 0 sekarang akan menampilkannya seolah rugi seluruh modal.
    const { research, baris } = dunia({ tick: (LO + HI) / 2 | 0, likuiditasOnchain: 0n });
    const rows = baris();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(rows[0].liveTs, undefined, 'tidak ditandai segar; UI menyebutnya "tersimpan"');
    assert.strictEqual(rows[0].pnl_q, 0, 'angka tersimpan tidak disentuh');
  });

  await t('harga pool tidak terbaca: baris dibiarkan apa adanya, bukan dinolkan', async () => {
    const { research, baris, store } = dunia({ tick: (LO + HI) / 2 | 0 });
    research.chain.slot0V4Many = async () => { throw new Error('RPC 429'); };
    const rows = baris();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(rows[0].liveTs, undefined);
    assert.strictEqual(store.get('SELECT live_value_q v FROM wpositions WHERE wallet=?', W).v, MODAL);
  });

  await t('cache pendek: halaman yang dipoll tiap beberapa detik tidak membanjiri RPC', async () => {
    const { research, baris, hit } = dunia({ tick: (LO + HI) / 2 | 0 });
    await research.refreshOpen(baris(), 2500);
    const slot0 = hit.slot0, fee = hit.fee;
    const rows = baris();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(hit.slot0, slot0, 'harga tidak dibaca ulang dalam TTL');
    assert.strictEqual(hit.fee, fee, 'fee tidak dibaca ulang dalam TTL');
    assert.ok(rows[0].liveTs, 'baris kedua tetap memakai angka segar dari cache');
    await research.refreshOpen(baris(), 2500, { ttlMs: 0 });
    assert.strictEqual(hit.slot0, slot0 + 1, 'TTL habis -> baca lagi');
  });

  await t('posisi tertutup tidak ikut dinilai ulang', async () => {
    const { research, store, hit } = dunia({ tick: (LO + HI) / 2 | 0 });
    store.run("UPDATE wpositions SET status='closed' WHERE wallet=?", W);
    await research.refreshOpen(store.all('SELECT * FROM wpositions WHERE wallet=?', W), 2500);
    assert.strictEqual(hit.slot0, 0, 'tidak ada panggilan chain sama sekali');
  });

  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  process.exit(fail ? 1 : 0);
})();
