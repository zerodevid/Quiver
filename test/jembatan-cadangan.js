'use strict';
// Uji jalan CADANGAN jembatan aset kuotasi: yang dipakai kalau Kyber tidak memberi rute.
//
// Latar: 25 Sep 2026 satu entry di lp2 batal dengan pesan "estimasi gas gagal (transaksi
// kemungkinan akan revert)". Sebab aslinya berlapis — kutipan Kyber kosong (tidak
// tercatat sama sekali), lalu cadangannya menembak satu pool ETH/USDG yang hook-nya
// menolak swap. Ke-12 pool ETH/USDG di chain itu ber-hook dan semuanya menolak, jadi
// cadangannya memang mustahil berhasil, tetapi pesannya menuduh node basi.
//
// Yang dijaga di sini: (1) pool disimulasikan dulu, tidak dikirim buta; (2) kandidat yang
// menolak dilewati, bukan mematikan jembatan; (3) kalau semua menolak, galatnya menyebut
// sebab Kyber DAN penolakan pool.
//
// Jalankan: node test/jembatan-cadangan.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native;
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
// Harga pool jembatan: 2500 USDG per ETH. currency0 = ETH(18), currency1 = USDG(6).
const sqrtFor = (usdgPerEth) => m.getSqrtRatioAtTick(m.getTickAtSqrtRatio(
  BigInt(Math.floor(Math.sqrt(usdgPerEth / 10 ** 12) * 2 ** 48)) << 48n));

// Pool jembatan palsu; `hooks` cuma penanda, yang menentukan adalah jawaban simulasi.
function pool(id, usdgPerEth, liquidity) {
  return {
    poolId: '0x' + String(id).repeat(64).slice(0, 64),
    poolKey: { currency0: ETH, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: '0x' + 'dd'.repeat(20) },
    slot0: { sqrtPriceX96: sqrtFor(usdgPerEth), tick: 0 },
    liquidity: BigInt(liquidity),
  };
}

// Engine seadanya: yang diuji hanya ensureQuoteAsset, jadi batas luarnya dipalsukan.
function harness({ pools, terima = () => false, kyberQuote = async () => null, balances, izin = [] }) {
  const store = new Store(':memory:');
  const chain = { ethUsd: async () => 2500 };
  const cfg = { mode: { dry_run: false, paused: false }, rules: {}, gas: {}, loop: {} };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), batch: async (c) => c.map(() => ({ result: null })), blockNumber: async () => 1e6, call: async () => null };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  const bal = new Map(Object.entries(balances).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  const sent = [], disimulasi = [];
  eng.chain.bestEthUsdgPool = async () => (pools.length ? { ...pools[0], candidates: pools } : null);
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((t) => [String(t).toLowerCase(), bal.get(String(t).toLowerCase()) || 0n]));
  eng.exec.send = async (tx, meta) => { sent.push({ kind: meta?.kind, detail: meta?.detail }); return '0x' + (sent.length + '').padStart(64, '0'); };
  eng.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [], gasUsed: '0x0', effectiveGasPrice: '0x0' } });
  eng.exec.ensureRouterAllowance = async () => izin;
  eng.exec.deadline = () => 9e9;
  eng.exec.gasReserve = async () => 0n;
  eng.exec.simulate = async (tx) => {
    disimulasi.push(tx);
    return terima(disimulasi.length - 1) ? { ok: true, gas: '300000' } : { ok: false, error: 'execution reverted' };
  };
  // quoteRetry dipintas supaya uji di bawah tidak ikut menunggu jeda coba-ulangnya;
  // perilaku coba-ulang itu diuji tersendiri lewat kyber.quote asli.
  eng.kyber.quoteRetry = kyberQuote;
  eng.kyber.quote = kyberQuote;
  eng.kyber.swap = async () => null;
  return { eng, store, sent, disimulasi };
}

// plan: butuh USDG, kas ada di ETH -> jembatan ETH→USDG.
const plan = { quoteSide: 0, token0: USDG, token1: '0x' + '11'.repeat(20) };
const rules = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 5000 } };
const KAYA = { [ETH]: 10n ** 18n, [USDG]: 0n };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  OK   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

(async () => {
  await t('semua pool menolak -> tidak ada tx dikirim, galat menyebut Kyber DAN penolakan pool', async () => {
    const { eng, sent, disimulasi } = harness({ pools: [pool(1, 2500, 1e15), pool(2, 2490, 1e14)], balances: KAYA });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, rules, 100_000000n),
      (e) => {
        assert.match(e.message, /Kyber tidak memberi kutipan/, `sebab Kyber hilang: ${e.message}`);
        assert.match(e.message, /2 pool .* menolak swap/, `penolakan pool hilang: ${e.message}`);
        assert.doesNotMatch(e.message, /estimasi gas/, `masih menuduh estimasi gas: ${e.message}`);
        return true;
      });
    assert.equal(disimulasi.length, 2, 'kedua kandidat harus disimulasikan');
    assert.ok(!sent.some((x) => x.kind === 'bridge_swap'), 'tidak boleh ada swap dikirim buta');
  });

  await t('pool terdalam menolak, kandidat kedua menerima -> jembatan tetap jalan', async () => {
    const p = [pool(1, 2500, 1e15), pool(2, 2490, 1e14)];
    const { eng, sent, disimulasi } = harness({ pools: p, terima: (i) => i === 1, balances: KAYA });
    const notes = await eng.ensureQuoteAsset(plan, rules, 100_000000n);
    assert.equal(disimulasi.length, 2, 'harus turun ke kandidat kedua');
    const swap = sent.find((x) => x.kind === 'bridge_swap');
    assert.ok(swap, `jembatan tidak dikirim (sent: ${sent.map((x) => x.kind).join(',')})`);
    assert.equal(swap.detail.pool, p[1].poolId, 'harus memakai pool yang LOLOS simulasi, bukan yang terdalam');
    assert.ok(notes.some((n) => /jembatan/.test(n)), notes.join(' | '));
  });

  await t('kandidat pertama lolos -> kandidat berikutnya tidak ikut disimulasikan', async () => {
    const { eng, disimulasi } = harness({ pools: [pool(1, 2500, 1e15), pool(2, 2490, 1e14)], terima: (i) => i === 0, balances: KAYA });
    await eng.ensureQuoteAsset(plan, rules, 100_000000n);
    assert.equal(disimulasi.length, 1, 'berhenti di kandidat pertama yang lolos');
  });

  await t('sebab mundur ke cadangan tercatat walau kutipan Kyber kosong', async () => {
    const { eng, store } = harness({ pools: [pool(1, 2500, 1e15)], balances: KAYA });
    await eng.ensureQuoteAsset(plan, rules, 100_000000n).catch(() => {});
    const logs = store.all("SELECT msg FROM logs WHERE level='warn'").map((r) => r.msg);
    assert.ok(logs.some((l) => /Kyber tidak memberi kutipan/.test(l)),
      `kutipan Kyber yang kosong harus tercatat, bukan diam: ${JSON.stringify(logs)}`);
  });

  await t('dampak harga di atas batas -> galat soal harga, bukan soal penolakan pool', async () => {
    const ketat = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 1 } };
    const { eng, disimulasi } = harness({ pools: [pool(1, 2500, 1e6)], balances: KAYA });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, ketat, 100_000000n),
      (e) => { assert.match(e.message, /menggeser harga/, e.message); return true; });
    assert.equal(disimulasi.length, 0, 'yang terlalu mahal tidak perlu disimulasikan');
  });

  // Arah sebaliknya: butuh ETH, kas di USDG -> jembatan USDG→ETH, dan sisi ini butuh izin
  // router. Izin itu transaksi sungguhan, jadi tidak boleh terkirim untuk jembatan yang
  // sudah pasti gugur di gerbang murah (dampak harga / kas kurang).
  const planEth = { quoteSide: 0, token0: ETH, token1: '0x' + '11'.repeat(20) };
  const KAYA_USDG = { [USDG]: 10n ** 9n, [ETH]: 0n };
  const IZIN = [{ kind: 'approve_router', to: USDG, data: '0x' }];

  await t('dampak harga menggugurkan semua kandidat -> izin router tidak ikut terkirim', async () => {
    const ketat = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 1 } };
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e6)], balances: KAYA_USDG, izin: IZIN });
    await assert.rejects(
      () => eng.ensureQuoteAsset(planEth, ketat, 10n ** 16n),
      (e) => { assert.match(e.message, /menggeser harga/, e.message); return true; });
    assert.ok(!sent.some((x) => x.kind === 'approve_router'),
      `izin router terkirim untuk jembatan yang gugur: ${sent.map((x) => x.kind).join(',')}`);
  });

  await t('ada kandidat layak -> izin router tetap disiapkan sebelum simulasi', async () => {
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e15)], terima: () => true, balances: KAYA_USDG, izin: IZIN });
    await eng.ensureQuoteAsset(planEth, rules, 10n ** 16n);
    const urut = sent.map((x) => x.kind);
    assert.ok(urut.indexOf('approve_router') >= 0 && urut.indexOf('approve_router') < urut.indexOf('bridge_swap'),
      `izin harus mendahului swap: ${urut.join(',')}`);
  });

  await t('kas kurang di pool termurah -> galat kas, bukan galat penolakan pool', async () => {
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e15)], balances: { [ETH]: 1n, [USDG]: 0n } });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, rules, 100_000000n),
      (e) => { assert.match(e.message, /kas kurang untuk jembatan/, e.message); return true; });
    assert.equal(sent.length, 0, 'tidak ada tx saat kas memang kurang');
  });

  await t('kutipan Kyber yang gagal sesaat diulang, bukan langsung jatuh ke cadangan', async () => {
    const { Kyber } = require('../src/kyber');
    const k = new Kyber({ exec: { address: () => ME }, rpc: {}, cfg: {}, chain: null, log: () => {} });
    let n = 0;
    k.quote = async () => (++n < 3 ? null : { amountOut: 1n });
    const q = await k.quoteRetry(ETH, USDG, 1n);
    assert.equal(n, 3, 'harus mencoba sampai dapat');
    assert.ok(q, 'kutipan yang akhirnya berhasil tidak boleh dibuang');
    let m2 = 0;
    k.quote = async () => { m2++; return null; };
    assert.equal(await k.quoteRetry(ETH, USDG, 1n), null, 'yang memang tidak ada rute tetap null');
    assert.equal(m2, 3, 'percobaannya dibatasi, tidak selamanya');
  });

  // Cache daftar pool ETH/USDG: dulu permanen, sekarang dipindai ulang. Pindaian yang
  // apes tidak boleh memperpendek daftar — pool v4 yang sudah lahir tidak hilang.
  const { Chain } = require('../src/pools');
  const logPool = (id, fee, ts, hooks) => ({
    topics: [null, '0x' + String(id).repeat(64).slice(0, 64)],
    data: '0x' + fee.toString(16).padStart(64, '0') + ts.toString(16).padStart(64, '0')
      + '00'.repeat(12) + hooks.replace(/^0x/, ''),
  });
  const chainPalsu = (store, logs) => ({
    network: 'robinhood', store,
    ADDR: { poolManager: '0x' + '11'.repeat(20), native: ETH, usdg: USDG },
    rpc: { getLogs: async () => logs },
  });
  const LAMA = [
    { poolId: '0x' + 'a'.repeat(64), fee: 3000, tickSpacing: 60, hooks: '0x' + 'dd'.repeat(20) },
    { poolId: '0x' + 'b'.repeat(64), fee: 500, tickSpacing: 10, hooks: '0x' + 'ee'.repeat(20) },
  ];

  await t('pindaian ulang yang cuma dapat sebagian -> daftar digabung, tidak menyusut', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify(LAMA));   // bentuk lama = basi
    const baru = logPool(9, 100, 1, '0x' + 'ff'.repeat(20));
    const hasil = await Chain.prototype.findEthUsdgPools.call(chainPalsu(store, [baru]), 1000);
    const ids = hasil.map((p) => p.poolId.toLowerCase());
    for (const p of LAMA) assert.ok(ids.includes(p.poolId), `pool lama ${p.poolId.slice(0, 10)} hilang`);
    assert.equal(hasil.length, 3, `harus 2 lama + 1 baru, dapat ${hasil.length}`);
    const simpan = JSON.parse(store.getState('eth_usdg_pools:robinhood'));
    assert.ok(simpan.ts > 0, 'bentuk baru harus bercap waktu');
  });

  await t('pindaian yang gagal total -> daftar lama dipertahankan dan tidak dicap waktu', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify(LAMA));
    const hasil = await Chain.prototype.findEthUsdgPools.call(chainPalsu(store, []), 1000);
    assert.equal(hasil.length, 2, 'daftar lama harus utuh');
    assert.ok(Array.isArray(JSON.parse(store.getState('eth_usdg_pools:robinhood'))),
      'cache tidak boleh dicap waktu oleh pindaian kosong (nanti terkunci 24 jam)');
  });

  await t('daftar yang masih segar dipakai apa adanya, tanpa pindai ulang', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify({ ts: Date.now(), pools: LAMA }));
    let dipindai = 0;
    const c = chainPalsu(store, []);
    c.rpc.getLogs = async () => { dipindai++; return []; };
    const hasil = await Chain.prototype.findEthUsdgPools.call(c, 1000);
    assert.equal(dipindai, 0, 'yang masih segar tidak perlu dipindai');
    assert.equal(hasil.length, 2);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
