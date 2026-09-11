'use strict';
// Uji riset wallet, khususnya jalur Uniswap v3.
//
// Yang dipalsukan hanya chain; WalletResearch dan WalletV3 asli. Uji terpenting di
// sini adalah yang paling murah: wallet yang TIDAK punya posisi v4 sama sekali tetap
// harus terbaca kalau ia ber-LP di v3. Dulu tidak — scan() keluar lebih awal begitu
// daftar posisi v4 kosong, sehingga halaman riset wallet v3 selalu kosong.
//
// Jalankan: node test/riset.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { WalletResearch } = require('../src/wallet');
const { WalletV3 } = require('../src/walletv3');
const { ADDR, TOPIC, ABI } = require('../src/chain');
const { ethers } = require('ethers');
const mm = require('../src/v3math');

const IF_NPM = new ethers.Interface(ABI.npmV3);
const W = '0x54e29aac8ed96c56463b18027c676d09b5c0be98';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0xdddddddddddddddddddddddddddddddddddddddd';
const HEAD = 1_000_000;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const idTopic = (id) => '0x' + BigInt(id).toString(16).padStart(64, '0');
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');

const xfer = (id, from, to, block) => ({
  address: ADDR.npmV3, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
  transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  topics: [TOPIC.transfer, pad32(from), pad32(to), idTopic(id)], data: '0x',
});
const ev = (kind, id, { liq = 0, a0 = 0, a1 = 0, block }) => ({
  address: ADDR.npmV3, blockNumber: '0x' + block.toString(16), logIndex: '0x1',
  transactionHash: '0x' + (block + 1).toString(16).padStart(64, '0'),
  topics: [{ increase: TOPIC.increaseLiq, decrease: TOPIC.decreaseLiq, collect: TOPIC.collectV3 }[kind], idTopic(id)],
  data: '0x' + w(kind === 'collect' ? 0 : liq) + w(a0) + w(a1),
});

function dunia({ logs = [], posisi = {}, owed = {}, arsip = null, receipts = {} } = {}) {
  const store = new Store(':memory:');
  const SQRT = mm.getSqrtRatioAtTick(0);
  const meta = {
    [ADDR.usdg]: { address: ADDR.usdg, symbol: 'USDG', decimals: 6 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const rpc = {
    blockNumber: async () => HEAD,
    call: async (m, p) => (m === 'eth_getTransactionReceipt' ? receipts[p[0]] || null : null),
    hasArchive: () => arsip != null,
    callAt: async () => (arsip == null ? '0x'
      : ethers.AbiCoder.defaultAbiCoder().encode(['uint160','int24','uint16','uint16','uint16','uint8','bool'], [arsip, 0, 0, 0, 0, 0, true])),
    getLogs: async (f) => {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      const cocok = (nilai, syarat) => syarat == null || (Array.isArray(syarat) ? syarat.includes(nilai) : syarat === nilai);
      return logs.filter((l) => {
        if (f.address && String(f.address).toLowerCase() !== l.address.toLowerCase()) return false;
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        return (f.topics || []).every((s, i) => cocok(l.topics[i], s));
      });
    },
    ethCallMany: async (calls) => calls.map((c) => {
      // token0() / token1() / fee() pada kontrak pool
      if (c.data === '0x0dfe1681') return pad32(ADDR.usdg);
      if (c.data === '0xd21220a7') return pad32(MEME);
      if (c.data === '0xddca3f43') return '0x' + w(10000);
      // positions(tokenId)
      const id = BigInt('0x' + c.data.slice(10)).toString();
      const p = posisi[id];
      if (!p) return '0x';
      return IF_NPM.encodeFunctionResult('positions', [
        0, ADDR.native, p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, 0, 0, 0, 0]);
    }),
    // collect((tokenId, recipient, max0, max1)) — tuple statis, jadi tokenId ada di
    // kata PERTAMA calldata setelah selektor.
    batch: async (calls) => calls.map((c) => {
      const id = BigInt('0x' + c.params[0].data.slice(10, 10 + 64)).toString();
      const o = owed[id] || { fee0: 0n, fee1: 0n };
      return { result: '0x' + w(o.fee0) + w(o.fee1) };
    }),
  };
  const chain = {
    tokens: async (l) => l.map((a) => meta[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    poolV3Addr: async () => POOL,
    slot0V3: async () => ({ sqrtPriceX96: SQRT, tick: 0 }),
    blockTs: async (b) => b * 101,
    quoteSideOf(t0, t1) {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
  };
  return { store, rpc, chain };
}

// Satu posisi tertutup penuh: masuk 1 USDG, tarik pokok 1 USDG, terima 1,1 USDG.
// Selisihnya (0,1) fee. Semua di sisi kuotasi, jadi nilainya bisa dihitung di kepala.
const TUTUP = [
  xfer(7, '0x0', W, 100),
  ev('increase', 7, { liq: 5000, a0: 1_000_000, block: 110 }),
  ev('decrease', 7, { liq: 5000, a0: 1_000_000, block: 200 }),
  ev('collect', 7, { a0: 1_100_000, block: 201 }),
  xfer(7, W, '0x0', 210),
];
const POSISI_TUTUP = { 7: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 0n } };

(async () => {
  console.log('riset wallet (v3)\n');

  await t('fee dipisahkan dari pokok: Collect − Decrease', async () => {
    const d = dunia({ logs: TUTUP, posisi: POSISI_TUTUP });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.ok(p, 'posisi harus terbaca');
    assert.strictEqual(p.venue, 'v3');
    assert.strictEqual(p.agg.in0, 1_000_000n);
    assert.strictEqual(p.agg.out0, 1_000_000n, 'Decrease adalah pokok');
    assert.strictEqual(p.agg.fee0, 100_000n, 'fee = yang diterima − pokok yang menunggu');
    assert.ok(Math.abs(p.investedQ - 1) < 1e-9, `modal ${p.investedQ}`);
    assert.ok(Math.abs(p.returnedQ - 1.1) < 1e-9, `kembali ${p.returnedQ}`);
    assert.ok(Math.abs(p.feesQ - 0.1) < 1e-9, `fee ${p.feesQ}`);
    assert.ok(Math.abs(p.pnlQ - 0.1) < 1e-9, `pnl ${p.pnlQ}`);
    assert.strictEqual(p.status, 'closed');
  });

  await t('klaim fee tanpa penarikan terbaca utuh sebagai fee', async () => {
    const logs = [
      xfer(8, '0x0', W, 100),
      ev('increase', 8, { liq: 5000, a0: 1_000_000, block: 110 }),
      ev('collect', 8, { a0: 250_000, block: 150 }),      // murni fee, tidak ada Decrease
    ];
    const d = dunia({ logs, posisi: { 8: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.agg.fee0, 250_000n, 'tanpa pokok yang menunggu, seluruh Collect adalah fee');
    assert.ok(Math.abs(p.feesQ - 0.25) < 1e-9, `fee ${p.feesQ}`);
    assert.strictEqual(p.status, 'open', 'masih dipegang dan masih berlikuiditas');
  });

  await t('posisi yang masih hidup dinilai di harga sekarang', async () => {
    const logs = [xfer(9, '0x0', W, 100), ev('increase', 9, { liq: 10n ** 12n, a0: 1_000_000, block: 110 })];
    const posisi = { 9: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n } };
    const d = dunia({ logs, posisi, owed: { 9: { fee0: 50_000n, fee1: 0n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.inRange, true, 'harga di tengah rentang');
    assert.ok(p.liveValueQ > 0, 'posisi hidup harus punya nilai');
    assert.ok(Math.abs(p.liveFeeQ - 0.05) < 1e-9, `fee berjalan ${p.liveFeeQ}`);
    // pnl posisi terbuka = nilai + fee berjalan + yang sudah ditarik − modal
    assert.ok(Math.abs(p.pnlQ - (p.liveValueQ + p.liveFeeQ + p.returnedQ - p.investedQ)) < 1e-9);
  });

  await t('harga di blok kejadian dipakai kalau ada; kalau tidak, ditandai taksiran', async () => {
    const SQRT = mm.getSqrtRatioAtTick(0);
    const swap = (block) => ({
      address: POOL, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
      transactionHash: '0x' + block.toString(16).padStart(64, '0'),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(SQRT) + w(0) + w(0),
    });
    const dasar = [
      xfer(11, '0x0', W, 100),
      // kedua sisi terisi: sisi spekulatif HANYA bisa dinilai kalau harganya terbaca
      ev('increase', 11, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }),
    ];
    const posisi = { 11: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };

    const tanpa = new WalletV3({ ...dunia({ logs: dasar, posisi }), log: () => {} });
    const [a] = await tanpa.scan(W, { from: 0, head: HEAD });
    assert.ok(Math.abs(a.investedQ - 1) < 1e-9, `tanpa harga, hanya sisi kuotasi yang terhitung: ${a.investedQ}`);
    assert.strictEqual(a.incomplete, true, 'harus ditandai taksiran');

    const dengan = new WalletV3({ ...dunia({ logs: [...dasar, swap(111)], posisi }), log: () => {} });
    const [b] = await dengan.scan(W, { from: 0, head: HEAD });
    assert.ok(b.investedQ > 1, `dengan harga, sisi spekulatif ikut terhitung: ${b.investedQ}`);
    assert.strictEqual(b.incomplete, false, 'tidak perlu ditandai kalau harganya terbaca');
  });

  await t('harga dari log Swap dipakai walau node arsip menjawab beda', async () => {
    // Terukur di chain sungguhan: arsip menjawab 4,7x meleset dari tiga Swap yang
    // sepakat, lalu beberapa menit kemudian menolak blok itu sama sekali. Log event
    // adalah bagian dari bloknya sendiri — ia yang menang.
    const SQRT = mm.getSqrtRatioAtTick(0);
    const swap = (block, sq) => ({
      address: POOL, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
      transactionHash: '0x' + block.toString(16).padStart(64, '0'),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(sq) + w(0) + w(0),
    });
    const logs = [
      xfer(12, '0x0', W, 100),
      ev('increase', 12, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }),
      swap(109, SQRT),
    ];
    const posisi = { 12: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };
    // arsip sengaja menjawab harga yang jauh berbeda
    const d = dunia({ logs, posisi, arsip: SQRT * 5n });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    const tersimpan = d.store.get('SELECT sqrt_price, src_block FROM wprices WHERE pool_ref=? AND block=?', POOL, 110);
    assert.strictEqual(tersimpan.sqrt_price, SQRT.toString(), 'harga harus dari log Swap, bukan dari arsip');
    assert.strictEqual(tersimpan.src_block, 109, 'sumbernya blok Swap-nya');
    assert.strictEqual(p.incomplete, false, 'Swap 1 blok dari kejadian bukan taksiran');
  });

  await t('harga dari Swap yang jauh ditandai taksiran', async () => {
    const SQRT = mm.getSqrtRatioAtTick(0);
    const jauh = {
      address: POOL, blockNumber: '0x' + (110 + 5000).toString(16), logIndex: '0x0',
      transactionHash: '0x' + 'ab'.repeat(32),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(SQRT) + w(0) + w(0),
    };
    const logs = [xfer(13, '0x0', W, 100), ev('increase', 13, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }), jauh];
    const posisi = { 13: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };
    const v3 = new WalletV3({ ...dunia({ logs, posisi }), log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.incomplete, true, 'Swap 5.000 blok jauhnya (~8 menit) harus ditandai taksiran');
  });

  await t('NFT yang berpindah tangan lalu kembali tetap dihitung milik kita', async () => {
    const logs = [
      xfer(7, '0x0', W, 100),
      ev('increase', 7, { liq: 5000, a0: 1_000_000, block: 110 }),
      xfer(7, W, '0x00000000000000000000000000000000000000aa', 120),
      xfer(7, '0x00000000000000000000000000000000000000aa', W, 130),
    ];
    const d = dunia({ logs, posisi: { 7: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.status, 'open', 'Transfer TERAKHIR yang menentukan kepemilikan');
  });

  await t('posisi yang NFT-nya sudah dibakar tetap masuk riwayat', async () => {
    // positions() tidak menjawab lagi, tapi transaksi pembukaannya masih memancarkan
    // Mint di kontrak pool: alamat lognya adalah poolnya, tick-nya ada di topiknya.
    // ev() memberi tiap kejadian tx = hex(block + 1); pakai rumus yang sama
    const txBuka = '0x' + (110 + 1).toString(16).padStart(64, '0');
    const logs = [
      xfer(21, '0x0', W, 100),
      ev('increase', 21, { liq: 5000, a0: 1_000_000, block: 110 }),
      ev('decrease', 21, { liq: 5000, a0: 1_000_000, block: 200 }),
      ev('collect', 21, { a0: 1_150_000, block: 201 }),
      xfer(21, W, '0x0', 205),                       // dibakar
    ];
    const receipts = {
      [txBuka]: { logs: [{
        address: POOL,
        topics: [TOPIC.mintV3Pool, pad32(ADDR.npmV3), idTopic(-600 & 0xffffff), idTopic(600)],
      }] },
    };
    // sengaja TIDAK ada di `posisi`: positions() akan menjawab '0x'
    const d = dunia({ logs, posisi: {}, receipts });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.ok(p, 'posisi yang dibakar harus tetap terbaca');
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.poolId, POOL, 'alamat pool dipulihkan dari log Mint');
    assert.strictEqual(p.tickUpper, 600, 'tick dipulihkan dari topik log Mint');
    assert.ok(Math.abs(p.investedQ - 1) < 1e-9, `modal ${p.investedQ}`);
    assert.ok(Math.abs(p.feesQ - 0.15) < 1e-9, `fee ${p.feesQ}`);
    assert.ok(Math.abs(p.pnlQ - 0.15) < 1e-9, `pnl ${p.pnlQ}`);
  });

  await t('REGRESI: wallet tanpa posisi v4 sama sekali tetap terbaca dari v3', async () => {
    const d = dunia({ logs: TUTUP, posisi: POSISI_TUTUP });
    const res = new WalletResearch({ ...d, log: () => {} });
    const r = await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    assert.strictEqual(r.positions.length, 1, 'posisi v3 harus ikut walau v4 kosong');
    assert.strictEqual(r.positions[0].venue, 'v3');
    // dan benar-benar tersimpan, bukan cuma dikembalikan
    const baris = d.store.all('SELECT * FROM wpositions WHERE wallet=?', W);
    assert.strictEqual(baris.length, 1);
    assert.strictEqual(baris[0].venue, 'v3');
    assert.strictEqual(baris[0].token0, ADDR.usdg);
    assert.strictEqual(baris[0].fee, 10000);
    assert.ok(d.store.all('SELECT * FROM wevents WHERE wallet=?', W).length >= 3, 'kejadiannya ikut tersimpan');
    const stats = JSON.parse(d.store.get('SELECT stats FROM wallets WHERE address=?', W).stats);
    assert.strictEqual(stats.positionsTotal, 1);
  });

  await t('REGRESI: pembaruan lanjutan juga membaca v3', async () => {
    const d = dunia({ logs: TUTUP, posisi: POSISI_TUTUP });
    const res = new WalletResearch({ ...d, log: () => {} });
    await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    d.store.run('DELETE FROM wpositions WHERE wallet=?', W);   // seolah hilang
    const r = await res.refresh(W, { ethUsd: 2500 });
    assert.strictEqual(r.positions.filter((p) => p.venue === 'v3').length, 1, 'refresh harus ikut membaca v3');
  });

  await t('kegagalan jalur v3 tidak menjatuhkan riset', async () => {
    const d = dunia({ logs: TUTUP, posisi: POSISI_TUTUP });
    const res = new WalletResearch({ ...d, log: () => {} });
    res.v3.scan = async () => { throw new Error('RPC tumbang'); };
    const r = await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    assert.deepStrictEqual(r.positions, [], 'hasilnya kosong, tapi tidak melempar');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
