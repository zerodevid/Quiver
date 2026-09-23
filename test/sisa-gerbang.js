'use strict';
// Uji gerbang batas rugi saat menjual sisa memecoin, dan penjualan bertahap.
//
// Kasus nyata yang melahirkan berkas ini (diukur 17 Sep 2026 dari DB produksi, 244 swap
// sejak modal mulai dicatat):
//
//   swap yang Kyber punya harga USD-nya : 223 swap, $2.735, meleset  +0,4%
//   swap yang Kyber TIDAK punya harganya:  21 swap,   $313, meleset −33,6%
//
// Semua −$105 "slippage" ada di kolom kedua, −$100 di antaranya dari SATU posisi (#82,
// FREEDOM: taksiran tutup $173 → terjual $73). Sebabnya bukan rute yang buruk melainkan
// gerbangnya sendiri: Kyber mengembalikan amountInUsd kosong untuk memecoin tipis,
// lossBps() jadi null, dan gerbangnya ditulis `loss != null && loss > batas` — jadi
// TIDAK TERUKUR berarti LOLOS. Log #82 memperlihatkannya: ditolak berkali-kali di
// 42–57%, lalu satu kutipan datang tanpa harga USD dan swap penuh berangkat.
//
// Dua sifat yang dijaga di sini:
//   1. tidak terukur ≠ aman. Sisi keluar selalu bisa dinilai sendiri (aset kuotasi), dan
//      kalau tetap tidak terukur, penjualan otomatis menahan diri — bukan membuang buta.
//   2. yang tidak muat utuh dijual sebagian. Tanpa ini, menutup celah di atas hanya
//      menukar "dibuang murah" dengan "macet selamanya" — dua-duanya bukan yang kita mau.
//
// Jalankan: node test/sisa-gerbang.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Kyber } = require('../src/kyber');
const { ADDR } = require('../src/chain');

const ME = '0x' + '11'.repeat(20);
const MEME = '0x' + 'a1'.repeat(20);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Dunia tiruan sederhana. `kurva(amount)` menentukan berapa USDG yang keluar untuk satu
// jumlah — dipakai untuk meniru pool tipis: makin besar yang dijual, makin buruk harganya.
function dunia({ kurva, usdKyber = true, punyaPosisi = true, nilaiPool = null, poolJual = null, pengamanGagal = false } = {}) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((address) => ({ address, symbol: address === MEME ? 'MEME' : 'USDG', decimals: address === MEME ? 18 : 6 })),
    token: async (a) => ({ address: a, symbol: a === MEME ? 'MEME' : 'USDG', decimals: a === MEME ? 18 : 6 }),
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' }
      : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
  };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), call: async () => '0x0' };
  const e = new Engine({ rpc, store, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  e.exec.address = () => ME;
  e.exec.balances = async (l) => new Map(l.map((a) => [a.toLowerCase(), a.toLowerCase() === MEME ? 10n * E18 : 0n]));
  e.topUpGas = async () => {};
  e.notify = () => {};
  e.ethUsd = 2500;

  // Pembanding harga pool: inilah yang membuat gerbang tetap bisa mengukur walau Kyber
  // tidak punya feed harga token ini.
  e.positions.leftoverRows = () => (punyaPosisi ? [{ id: 82, left_token: MEME }] : []);
  e.positions.valueLeftover = async (rows, amt) => (nilaiPool == null ? null : (nilaiPool * Number(amt)) / Number(10n * E18));
  const dicatat = [];
  e.positions.recordLeftoverSale = (x) => { dicatat.push(x); return []; };

  const kutipan = [];
  e.kyber.quote = async (tokenIn, tokenOut, amountIn) => {
    kutipan.push(amountIn);
    const usdOut = kurva(amountIn);
    // usdIn = nilai nosional token yang dibayar (harga wajar × jumlah), usdOut = yang
    // benar-benar bisa ditarik lewat rute itu. Selisihnya = fee + dampak harga.
    const nosional = nilaiPool == null ? null : (nilaiPool * Number(amountIn)) / Number(10n * E18);
    return {
      amountOut: BigInt(Math.round(usdOut * 1e6)), routeSummary: {}, dex: 'uji',
      // Justru dua baris inilah yang kosong pada memecoin tipis di produksi.
      usdIn: usdKyber ? nosional : null,
      usdOut: usdKyber ? usdOut : null,
    };
  };
  // Pengaman asli dipakai apa adanya; hanya lapisan HTTP/tx-nya yang ditiru.
  const terjual = [];
  e.kyber.swap = async (tokenIn, tokenOut, amountIn, o) => {
    // Pengaman yang gagal (router tidak cocok, calldata janggal) melempar galat polos:
    // tanpa .loss dan tanpa .reverted — itu yang membedakannya dari galat pasar.
    if (pengamanGagal) throw new Error('router Kyber tidak cocok: 0xdead ≠ whitelist');
    const q = await e.kyber.quote(tokenIn, tokenOut, amountIn);
    const loss = Kyber.routeLoss(q, o.ref);
    if (o.maxLossBps != null && o.requireLoss && !loss) throw new Error('rugi rute tidak terukur');
    if (o.maxLossBps != null && loss && loss.bps > o.maxLossBps) {
      const err = new Error(`rute Kyber rugi ${(loss.bps / 100).toFixed(1)}%`);
      err.loss = { lossBps: loss.bps, maxLossBps: o.maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut };
      throw err;
    }
    terjual.push(amountIn);
    return { hash: '0x' + 'e'.repeat(64), amountOut: q.amountOut, quote: q };
  };
  // Cadangan pool langsung. `poolJual(amount)` mengembalikan berapa USDG yang keluar,
  // atau null kalau pool juga tidak layak — persis bentuk balasan sellViaPool asli.
  const lewatPool = [];
  e.sellViaPool = async (it, amount) => {
    lewatPool.push(amount);
    const out = poolJual ? poolJual(amount) : null;
    if (out == null) return null;
    return { hash: '0x' + 'p'.repeat(64), amountOut: BigInt(Math.round(out * 1e6)),
      quote: { dex: 'pool v4 0x1234abcd…', usdIn: null, usdOut: out } };
  };
  return { e, store, kutipan, terjual, dicatat, lewatPool };
}

const item = () => ({ posId: 82, target: null, token: MEME, quote: ADDR.usdg, amount: (10n * E18).toString(), tries: 0 });

(async () => {
  console.log('Gerbang batas rugi & penjualan bertahap:\n');

  await t('routeLoss: Kyber tanpa harga USD sama sekali -> sisi keluar dinilai sendiri', () => {
    // 100 token dinilai $173 oleh pool kita, Kyber cuma sanggup mengembalikan 73 USDG.
    const q = { amountOut: 73_000_000n, usdIn: null, usdOut: null };
    const r = Kyber.routeLoss(q, { usdIn: 173, usdPerOut: 1, outDecimals: 6 });
    assert.ok(r, 'harus terukur dari pembanding, bukan null');
    assert.ok(Math.abs(r.bps - 5780) < 20, `rugi ~57,8%, dapat ${r.bps}`);
  });

  await t('routeLoss: tanpa Kyber DAN tanpa pembanding tetap null — tidak mengarang angka', () => {
    assert.strictEqual(Kyber.routeLoss({ amountOut: 1n, usdIn: null, usdOut: null }), null);
    assert.strictEqual(Kyber.routeLoss(null), null);
  });

  await t('routeLoss: harga USD Kyber tetap yang dipakai kalau ada (223 swap yang sudah benar)', () => {
    const r = Kyber.routeLoss({ amountOut: 1n, usdIn: 100, usdOut: 98 }, { usdIn: 999, usdPerOut: 1, outDecimals: 6 });
    assert.strictEqual(Math.round(r.bps), 200, 'pembanding tidak boleh menggeser yang sudah terukur');
  });

  await t('antrean: kutipan tanpa harga USD TIDAK lagi lolos gerbang', async () => {
    // Persis bentuk #82: pool menilai sisa $173, rute cuma memberi $73.
    const d = dunia({ kurva: () => 73, usdKyber: false, nilaiPool: 173 });
    d.e.saveLeftovers([{ ...item(), next: 0 }]);
    await d.e.retryLeftovers();
    assert.strictEqual(d.terjual.length, 0, 'rugi 58% > batas 15%: tidak boleh terjual');
    const q = d.e.leftovers();
    assert.strictEqual(q.length, 1, 'tetap di antrean');
    assert.ok(Math.abs(q[0].lastLossBps - 5780) < 20, `rugi tercatat ${q[0].lastLossBps}`);
  });

  await t('antrean: tidak terukur sama sekali -> ditahan, bukan dibuang buta', async () => {
    const d = dunia({ kurva: () => 73, usdKyber: false, punyaPosisi: false });
    d.e.saveLeftovers([{ ...item(), next: 0 }]);
    await d.e.retryLeftovers();
    assert.strictEqual(d.terjual.length, 0, 'tanpa angka rugi tidak boleh menjual');
    assert.match(d.e.leftovers()[0].why, /tidak terukur/);
  });

  await t('jual: rute wajar tetap lewat seperti biasa', async () => {
    const d = dunia({ kurva: () => 98, nilaiPool: 100 });
    await d.e.sellToken(item());
    assert.strictEqual(d.terjual.length, 1);
    assert.strictEqual(d.terjual[0], 10n * E18, 'jumlah penuh');
    assert.strictEqual(d.e.leftovers().length, 0, 'habis terjual: keluar dari antrean');
  });

  await t('jual bertahap: yang tidak muat utuh dijual sebagian, sisanya kembali antre', async () => {
    // Pool tipis: $10/token untuk potongan kecil, harga jatuh sebanding ukuran.
    // Jumlah penuh (10 token) rugi ~50%; seperempatnya masih di dalam batas 15%.
    const penuh = 10n * E18;
    const kurva = (amt) => {
      const frac = Number(amt) / Number(penuh);
      return 100 * frac * (1 - 0.5 * frac);     // dampak harga tumbuh linear terhadap ukuran
    };
    const d = dunia({ kurva, nilaiPool: 100 });
    await d.e.sellToken(item());
    assert.strictEqual(d.terjual.length, 1, 'tepat satu swap dikirim');
    assert.ok(d.terjual[0] < penuh, 'yang dijual harus lebih kecil dari jumlah penuh');
    assert.ok(d.terjual[0] > 0n, 'harus ada yang terjual, bukan menyerah');
    const sisa = d.e.leftovers();
    assert.strictEqual(sisa.length, 1, 'sisanya wajib kembali ke antrean');
    assert.strictEqual(BigInt(sisa[0].amount), penuh - d.terjual[0], 'jumlah sisa harus pas');
    assert.strictEqual(sisa[0].tries, 1, 'terjual sebagian itu kemajuan, penghitung direset');
    assert.strictEqual(d.dicatat[0].amount, d.terjual[0], 'yang tercatat = yang benar-benar dijual');
  });

  await t('jual bertahap: potongan sekecil apa pun tetap rugi -> tidak ada tx, tetap antre', async () => {
    // Rugi 90% berapa pun ukurannya: token memang sudah tidak ada pembelinya.
    const d = dunia({ kurva: (amt) => (100 * Number(amt) * 0.1) / Number(10n * E18), nilaiPool: 100 });
    await d.e.sellToken(item()).catch(() => {});
    assert.strictEqual(d.terjual.length, 0, 'tidak boleh ada swap');
    assert.strictEqual(d.e.leftovers().length, 1, 'tetap di antrean untuk dicoba lagi');
  });

  await t('jual bertahap: pencarian potongan dibatasi beberapa kutipan, bukan menggerinda', async () => {
    const d = dunia({ kurva: (amt) => (100 * Number(amt) * 0.1) / Number(10n * E18), nilaiPool: 100 });
    await d.e.sellToken(item()).catch(() => {});
    assert.ok(d.kutipan.length <= 8, `kutipan ${d.kutipan.length} terlalu banyak untuk satu penjualan`);
  });

  await t('cadangan: rute Kyber terlalu rugi, pool langsung muat -> terjual UTUH lewat pool', async () => {
    // Kyber merutekan lewat jalur buruk (rugi 50%), sementara pool yang kita kenal cuma
    // rugi 3%. Dulu jumlah penuh dipotong dan dijual mahal-mahal lewat Kyber; sekarang
    // pool langsung dicoba dulu — pengaman rugi yang sama tetap berlaku di sana.
    const penuh = 10n * E18;
    const d = dunia({ kurva: () => 50, nilaiPool: 100, poolJual: () => 97 });
    await d.e.sellToken(item());
    assert.strictEqual(d.terjual.length, 0, 'tidak boleh ada swap Kyber');
    assert.deepStrictEqual(d.lewatPool, [penuh], 'pool dicoba sekali, untuk jumlah PENUH');
    assert.strictEqual(d.e.leftovers().length, 0, 'habis terjual: keluar dari antrean');
    assert.strictEqual(d.dicatat[0].amount, penuh, 'yang tercatat = jumlah penuh');
  });

  await t('cadangan: pool juga tidak layak -> kembali ke jual bertahap lewat Kyber', async () => {
    const penuh = 10n * E18;
    const kurva = (amt) => {
      const frac = Number(amt) / Number(penuh);
      return 100 * frac * (1 - 0.5 * frac);
    };
    const d = dunia({ kurva, nilaiPool: 100, poolJual: () => null });
    await d.e.sellToken(item());
    assert.strictEqual(d.lewatPool.length, 1, 'pool tetap dicoba lebih dulu');
    assert.strictEqual(d.terjual.length, 1, 'lalu jual bertahap lewat Kyber seperti dulu');
    assert.ok(d.terjual[0] < penuh, 'yang dijual lebih kecil dari jumlah penuh');
  });

  await t('cadangan: galat PENGAMAN tidak pernah dialihkan ke pool', async () => {
    // Router tidak cocok / calldata janggal bukan soal harga — kalau galat begini boleh
    // jatuh ke pool, pengaman Kyber berubah jadi sekadar saran.
    const d = dunia({ kurva: () => 98, nilaiPool: 100, poolJual: () => 97, pengamanGagal: true });
    await d.e.sellToken(item()).catch(() => {});
    assert.strictEqual(d.lewatPool.length, 0, 'pool tidak boleh dicoba');
    assert.strictEqual(d.e.leftovers().length, 1, 'tetap di antrean untuk dicoba lagi');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
