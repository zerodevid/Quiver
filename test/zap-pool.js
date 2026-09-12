'use strict';
// Uji pemilih pool untuk swap langsung (src/swappool.js) — jalur CADANGAN auto-swap,
// dipakai saat Kyber tidak punya rute.
//
// Yang dijaga di sini: bot menukar di pool yang paling menguntungkan untuk pasangan
// itu (bukan asal pool posisinya), pool tipis ditolak oleh batas dampak harga, dan
// pool yang menolak swap ketahuan dari simulasi — bukan dari transaksi yang revert.
//
// Jalankan: node test/zap-pool.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { pickSwapPool } = require('../src/swappool');
const m = require('../src/v3math');

const USDG = '0x' + '11'.repeat(20);
const MEME = '0x' + '22'.repeat(20);
const ME = '0x' + '33'.repeat(20);
const ref = (n) => '0x' + String(n).repeat(64).slice(0, 64);
const SQRT = m.getSqrtRatioAtTick(0);          // harga 1:1 dalam satuan mentah
const BESAR = 10n ** 21n;                      // likuiditas pool dalam
const TIPIS = 10n ** 15n;
const BAYAR = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Dunia uji: sejumlah pool v4 untuk pasangan USDG/MEME, masing-masing dengan fee dan
// likuiditas sendiri. `tolak` = daftar pool yang revert saat swap disimulasikan.
function dunia(pools, { tolak = [] } = {}) {
  const store = new Store(':memory:');
  for (const p of pools) {
    store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,pool_addr,first_block)
      VALUES(?,?,?,?,?,?,?,?,?)`, p.ref, 'v4', USDG, MEME, p.fee, 60, p.hooks || '0x' + '0'.repeat(40), null, 1);
  }
  const byRef = new Map(pools.map((p) => [p.ref, p]));
  const dibangun = [];
  const disimulasikan = [];
  const chain = {
    slot0V4Many: async (ids) => ids.map((id) => ({ sqrtPriceX96: byRef.get(id).sqrt ?? SQRT, tick: 0, lpFee: byRef.get(id).lpFee ?? 0 })),
    poolLiquidityMany: async (ids) => ids.map((id) => byRef.get(id).L),
  };
  const exec = {
    address: () => ME,
    // Pool dikenali dari fee-nya: tiap pool uji punya fee sendiri.
    buildSwapV4: (pk, zeroForOne, amountIn, minOut, deadline) => {
      dibangun.push({ pk, zeroForOne, amountIn, minOut, deadline });
      return { to: '0x' + 'ab'.repeat(20), data: '0x' + String(pk.fee).padStart(8, '0'), value: '0' };
    },
    buildSwapV3: () => { throw new Error('tidak dipakai di uji ini'); },
  };
  const rpc = {
    ethCallMany: async (items) => items.map((i) => {
      const fee = Number(i.data.slice(2));
      disimulasikan.push({ fee, from: i.from });
      return tolak.includes(fee) ? null : '0x01';
    }),
  };
  return { store, chain, exec, rpc, dibangun, disimulasikan };
}

const panggil = (d, opts = {}) => pickSwapPool(d, {
  tokenIn: USDG, tokenOut: MEME, amountIn: BAYAR, minOut: 1n,
  maxImpactBps: 500, deadlineSec: 1234, ...opts,
});

(async () => {
  console.log('pemilih pool zap');

  await t('memilih pool berfee paling rendah saat likuiditasnya sama', async () => {
    const d = dunia([
      { ref: ref(1), fee: 10000, L: BESAR },   // pool posisi: 1%
      { ref: ref(2), fee: 500, L: BESAR },     // 0,05% — paling murah
      { ref: ref(3), fee: 3000, L: BESAR },
    ]);
    const info = {};
    const pick = await panggil(d, { info });
    assert.ok(pick, 'harus ada pool terpilih');
    assert.equal(pick.pool.pool_ref, ref(2));
    assert.equal(pick.feePpm, 500);
    assert.equal(info.scored, 3);
  });

  await t('pool dalam menang atas pool berfee rendah tapi tipis', async () => {
    const d = dunia([
      { ref: ref(1), fee: 3000, L: BESAR },
      { ref: ref(2), fee: 500, L: BAYAR * 2n },   // fee kecil, tapi dangkal
    ]);
    const pick = await panggil(d, { maxImpactBps: 0 });   // batas dampak dimatikan
    assert.equal(pick.pool.pool_ref, ref(1));
  });

  await t('pool tipis ditolak batas dampak harga, bukan dipakai', async () => {
    const d = dunia([{ ref: ref(1), fee: 500, L: TIPIS }]);
    const info = {};
    const pick = await panggil(d, { info });
    assert.equal(pick, null);
    assert.equal(info.tooDeep, 1);
    assert.match(info.reason, /dampak harga \d+ bps/);
  });

  await t('pool yang menolak swap tersaring simulasi; pilihan berikutnya dipakai', async () => {
    const d = dunia([
      { ref: ref(1), fee: 500, L: BESAR },     // terbaik di atas kertas, tapi revert
      { ref: ref(2), fee: 3000, L: BESAR },
    ], { tolak: [500] });
    const pick = await panggil(d);
    assert.equal(pick.pool.pool_ref, ref(2));
    assert.equal(pick.rank, 1, 'terpakai sebagai pilihan kedua');
    assert.equal(d.disimulasikan[0].from, ME, 'simulasi harus sebagai wallet bot — izin & saldo ikut terbaca');
  });

  await t('semua pool menolak: null dengan alasan, bukan transaksi yang revert', async () => {
    const d = dunia([
      { ref: ref(1), fee: 500, L: BESAR },
      { ref: ref(2), fee: 3000, L: BESAR },
    ], { tolak: [500, 3000] });
    const info = {};
    const pick = await panggil(d, { info });
    assert.equal(pick, null);
    assert.match(info.reason, /menolak swap saat disimulasikan/);
  });

  await t('pasangan tanpa pool sama sekali', async () => {
    const d = dunia([]);
    const info = {};
    const pick = await panggil(d, { info });
    assert.equal(pick, null);
    assert.match(info.reason, /tidak ada pool/);
  });

  await t('pool posisi ikut dinilai walau belum tercatat di tabel pools', async () => {
    const d = dunia([{ ref: ref(1), fee: 10000, L: BESAR }]);
    // Pool #9 hanya diketahui pemanggil (baru dibuat target, belum masuk DB).
    d.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: SQRT, tick: 0, lpFee: 0 }));
    d.chain.poolLiquidityMany = async (ids) => ids.map(() => BESAR);
    const pick = await panggil(d, {
      extra: [{ pool_ref: ref(9), venue: 'v4', token0: USDG, token1: MEME, fee: 100, tick_spacing: 1, hooks: null }],
    });
    assert.equal(pick.pool.pool_ref, ref(9), 'fee 0,01% harus menang dari 1%');
  });

  await t('poolKey yang dibangun memakai data pool terpilih', async () => {
    const d = dunia([{ ref: ref(1), fee: 3000, L: BESAR }]);
    await panggil(d);
    const b = d.dibangun[0];
    assert.equal(b.pk.currency0, USDG);
    assert.equal(b.pk.currency1, MEME);
    assert.equal(b.pk.fee, 3000);
    assert.equal(b.pk.tickSpacing, 60);
    assert.equal(b.zeroForOne, true, 'membayar dengan token0 = zeroForOne');
    assert.equal(b.amountIn, BAYAR);
    assert.equal(b.minOut, 1n, 'amountOutMinimum sungguhan ikut disimulasikan');
    assert.equal(b.deadline, 1234);
  });

  await t('fee dinamis dibaca dari slot0, bukan dari kolom fee', async () => {
    // 0x800000 = penanda fee dinamis; kolom fee-nya bukan besaran.
    const d = dunia([
      { ref: ref(1), fee: 0x800000, L: BESAR, lpFee: 100 },   // sebenarnya 0,01%
      { ref: ref(2), fee: 3000, L: BESAR },
    ]);
    const pick = await panggil(d);
    assert.equal(pick.pool.pool_ref, ref(1));
    assert.equal(pick.feePpm, 100);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
