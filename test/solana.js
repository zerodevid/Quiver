'use strict';
// Uji dukungan Solana (Meteora DLMM, Orca Whirlpools, Raydium CLMM).
//
// Kode asli dipakai untuk satuan, pengamat (selisih potret), perencana, dan mesin;
// yang dipalsukan hanya batas luar: RPC, adapter venue (baca/susun transaksi), Jupiter,
// dan pengirim transaksi. Pertanyaannya sama dengan uji EVM: "kalau target melakukan
// X, apakah bot memutuskan dan membukukan hal yang benar?"
//
// Jalankan: node test/solana.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const u = require('../src/solana/units');
const m = require('../src/v3math');
const { Store } = require('../src/db');
const { normAddr, isSolana, WSOL } = require('../src/networks');
const { SolanaWatcher } = require('../src/solana/watcher');
const { SolanaChain } = require('../src/solana/chain');
const { SolanaEngine } = require('../src/solana/engine');
const { planEntrySol } = require('../src/solana/planner');
const { rulesFor, deepMerge } = require('../src/policy');
const { solanaTemplate } = require('../src/multichain');
const { feeGrowthInside, unclaimed } = require('../src/solana/clmm-math');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.stack.split('\n').slice(0, process.env.V ? 14 : 3).join('\n       ')}`); }
}

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'MeMeCoin1111111111111111111111111111111111pump';
const TARGET = '6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD';
const ME = 'Me11111111111111111111111111111111111111111';
const POOL = 'Poo1111111111111111111111111111111111111111';

// Pool DLMM MEME/SOL: binStep 100, bin aktif 0 → harga mentah 1 (9 vs 9 desimal = 1 SOL/MEME).
const BIN_STEP = 100;
const poolState = (over = {}) => ({
  venue: 'meteora', id: POOL, token0: MEME, token1: WSOL, dec0: 9, dec1: 9,
  sqrtX96: u.binSqrtX96(0, BIN_STEP), tick: u.binToTick(0, BIN_STEP), current: 0, spacing: 1, binStep: BIN_STEP,
  ticksPerUnit: u.ticksPerBin(BIN_STEP), fee: 10_000, tickSpacing: 100, liquidity: null, enabled: true, ...over,
});

// Chain Solana asli dengan RPC, adapter, dan Jupiter palsu.
function fakeChain(store, { pool = poolState(), adapter = {}, prices = {} } = {}) {
  const rpc = { run: async () => { throw new Error('rpc palsu'); }, primary: () => null, slot: async () => 1, allCooling: () => false, stats: () => [] };
  const jup = {
    prices: async (mints) => new Map(mints.filter((x) => prices[x] != null).map((x) => [x, prices[x]])),
    tokenInfo: async () => new Map(), quote: async () => { throw new Error('tidak dipakai'); },
  };
  const chain = new SolanaChain(rpc, store, () => {}, 'solana', { jupiter: jup });
  chain.tokenCache.set(MEME, { address: MEME, symbol: 'MEME', name: 'Meme', decimals: 9 });
  chain.pools = async (venue, addrs) => new Map(addrs.map((a) => [a, { ...pool, id: a }]));
  chain.adapters.meteora = Object.assign(chain.adapters.meteora, adapter);
  return chain;
}

(async () => {
  console.log('solana');

  // ---- alamat ------------------------------------------------------------------------
  await t('alamat Solana: base58 dipertahankan hurufnya, EVM tetap huruf kecil, yang tak sah ditolak', () => {
    assert.ok(isSolana('solana') && !isSolana('bsc'));
    assert.strictEqual(normAddr('solana', ` ${TARGET} `), TARGET);
    assert.strictEqual(normAddr('solana', '0xabc'), null);
    assert.strictEqual(normAddr('solana', TARGET.replace('m', '0')), null, 'angka 0 bukan base58');
    assert.strictEqual(normAddr('bsc', '0xE9C209FD02A1562761C99700FC3D126E64B981EE'), '0xe9c209fd02a1562761c99700fc3d126e64b981ee');
    assert.strictEqual(normAddr('bsc', TARGET), null);
  });

  // ---- satuan --------------------------------------------------------------------------
  await t('bin DLMM ↔ tick setara: bin aktif di [lower, upper] ⇔ tick-nya di [tickLower, tickUpper)', () => {
    for (const bs of [1, 4, 10, 25, 80, 100, 250]) {
      for (const [lo, hi] of [[-10, 10], [-5388, -5343], [0, 0], [100, 169]]) {
        const { tickLower, tickUpper } = u.binRangeToTicks(lo, hi, bs);
        assert.ok(tickUpper > tickLower, `bs ${bs} [${lo},${hi}] lebar nol`);
        for (let a = lo - 3; a <= hi + 3; a++) {
          const inBins = a >= lo && a <= hi;
          const tk = u.binToTick(a, bs);
          assert.strictEqual(tk >= tickLower && tk < tickUpper, inBins, `bs ${bs} bin ${a} [${lo},${hi}]`);
        }
        assert.strictEqual(u.tickToBin(tickLower, bs), lo, `bs ${bs} tickToBin(${tickLower}) balik ke ${lo}`);
      }
    }
  });

  await t('harga bin DLMM & sqrt Q64 Orca/Raydium dinormalkan ke harga yang sama dengan rumus Uniswap', () => {
    // SOL/USDC DLMM binStep 4, bin −5426 → ~114 USDC per SOL (terukur di mainnet 2026-09-24)
    const p = m.priceFromSqrt(u.binSqrtX96(-5426, 4), 9, 6);
    assert.ok(p > 113 && p < 115, `harga ${p}`);
    assert.ok(Math.abs(m.tickToPrice(u.binToTick(-5426, 4), 9, 6) - p) / p < 0.001, 'tick setara memberi harga yang sama');
    // Q64.64 → Q96: tick 0 = sqrt 1.0 = 2^64 (Q64) = 2^96 (Q96)
    assert.strictEqual(u.x64ToX96(1n << 64n), 1n << 96n);
    assert.strictEqual(m.getTickAtSqrtRatio(u.x64ToX96(1n << 64n)), 0);
  });

  await t('fee CLMM (Orca/Raydium): pertumbuhan di dalam rentang × L >> 64, dengan putaran 2^128', () => {
    const g = 1000n << 64n;
    // harga di dalam rentang: inside = global − below − above
    const inside = feeGrowthInside({ tickCurrent: 0, tickLower: -10, tickUpper: 10, global: g, lowerOut: 100n << 64n, upperOut: 50n << 64n });
    assert.strictEqual(inside, 850n << 64n);
    assert.strictEqual(unclaimed({ liquidity: 2n, inside, checkpoint: 800n << 64n, owed: 7n }), 7n + 100n);
    // checkpoint "di depan" (sudah berputar): tetap positif kecil, bukan negatif raksasa
    assert.strictEqual(unclaimed({ liquidity: 1n, inside: 5n << 64n, checkpoint: ((1n << 128n) - (3n << 64n)), owed: 0n }), 8n);
  });

  await t('pool SOL/USDC: stablecoin jadi kuotasi (harga USDC per SOL, nilai dalam USD); pool MEME/SOL tetap SOL', () => {
    const chain = fakeChain(new Store(':memory:'));
    assert.deepStrictEqual([chain.quoteSideOf(WSOL, USDC).side, chain.quoteSideOf(WSOL, USDC).symbol], [1, 'USDC']);
    assert.deepStrictEqual([chain.quoteSideOf(USDC, WSOL).side, chain.quoteSideOf(USDC, WSOL).symbol], [0, 'USDC']);
    assert.deepStrictEqual([chain.quoteSideOf(MEME, WSOL).side, chain.quoteSideOf(MEME, WSOL).symbol], [1, 'SOL']);
    assert.strictEqual(chain.quoteSideOf(MEME, 'Other1111111111111111111111111111111111111'), null);
  });

  await t('penilaian selalu dalam satuan kuotasi baris posisi (baris lama ber-SOL tetap benar walau kuotasi kini USDC)', () => {
    const chain = fakeChain(new Store(':memory:'));
    // pool SOL/USDC 113 USDC per SOL; posisi 1 SOL + 113 USDC = 226 USDC = 2 SOL
    const args = { sqrtPriceX96: u.sqrtX96FromPrice(113 * 10 ** (6 - 9)), amount0: 10n ** 9n, amount1: 113n * 10n ** 6n, dec0: 9, dec1: 6, token0: WSOL, token1: USDC };
    assert.ok(Math.abs(chain.valueAs(args, 'USDC', 113) - 226) < 1e-6);
    assert.ok(Math.abs(chain.valueAs(args, 'SOL', 113) - 2) < 1e-9);
  });

  // ---- pengamat ------------------------------------------------------------------------
  await t('selisih potret: posisi baru = tambah, L naik = tambah, L turun = tarik sebanding, hilang = tutup', () => {
    const P = (L, a0 = '0', a1 = '0') => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower: -5, upper: 5, tickLower: -500, tickUpper: 600, liquidity: String(L), amount0: a0, amount1: a1 });
    const prev = { A: P(100), B: P(100), C: P(100), D: P(100) };
    const now = { A: P(100), B: P(150), C: P(25), E: P(40) };
    const acts = SolanaWatcher.diff(TARGET, prev, now);
    const by = Object.fromEntries(acts.map((a) => [a.id, a]));
    assert.strictEqual(by.A, undefined, 'tidak berubah = tidak ada aksi');
    assert.deepStrictEqual([by.B.kind, by.B.delta, by.B.before], ['increase', 50n, 100n]);
    assert.deepStrictEqual([by.C.kind, by.C.delta, by.C.before], ['decrease', -75n, 100n]);
    assert.deepStrictEqual([by.D.kind, by.D.delta, by.D.before, by.D.gone], ['decrease', -100n, 100n, true]);
    assert.deepStrictEqual([by.E.kind, by.E.delta, by.E.before], ['increase', 40n, 0n]);
  });

  await t('venue yang gagal dibaca TIDAK terbaca sebagai "semua posisinya ditutup"', async () => {
    const store = new Store(':memory:');
    store.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('solana',?,1,?)", TARGET, Date.now());
    const chain = fakeChain(store);
    chain.adapters.meteora.listPositions = async () => { throw new Error('429 Too Many Requests'); };
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [{ signature: 'sig2', slot: 9 }] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    w.saveSnap(TARGET, { sig: 'sig1', positions: { X: { venue: 'meteora', pool: POOL, liquidity: '500', amount0: '1', amount1: '1' } } });
    const acts = await w.scanTarget(TARGET);
    assert.deepStrictEqual(acts, []);
    assert.ok(w.loadSnap(TARGET).positions.X, 'potret lama venue gagal tetap disimpan');
  });

  await t('pemindaian pertama target hanya membuat potret — posisi lama tidak disalin', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: '9', amount0: 1n, amount1: 1n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    assert.deepStrictEqual(await w.scanTarget(TARGET), []);
    assert.ok(w.loadSnap(TARGET).positions.P1);
  });

  await t('venue yang gagal saat potret awal: begitu terbaca, posisinya jadi potret — TIDAK disalin massal', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    let rayOk = false;
    chain.adapters.meteora.listPositions = async () => [];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => {
      if (!rayOk) throw new Error('403 Forbidden: Indexed requests require a personal token');
      return [{ venue: 'raydium', id: 'OldRay', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 10, tickLower: 0, tickUpper: 10, liquidity: '500', amount0: 1n, amount1: 1n }];
    };
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [{ signature: 'S' + Math.random(), slot: 1 }] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    await w.scanTarget(TARGET);                   // potret awal: raydium gagal
    rayOk = true;
    assert.deepStrictEqual(await w.scanTarget(TARGET), [], 'posisi lama raydium bukan aksi baru');
    assert.ok(w.loadSnap(TARGET).positions.OldRay);
    // sesudahnya gerakan raydium sungguhan tetap terdeteksi
    chain.adapters.raydium.listPositions = async () => [];
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(acts[0].gone, true);
  });

  await t('tanda tangan terakhir tidak dikenal endpoint ("not found") → tetap terpindai, bukan macet selamanya', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async (pk, o) => {
      if (o.until) throw new Error('failed to get signatures for address: Transaction OLD not found');
      return [{ signature: 'NEW2' }, { signature: 'NEW1' }, { signature: 'OLD' }];
    } }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    const sigs = await w.newSignatures(TARGET, 'OLD');
    assert.deepStrictEqual(sigs.map((x) => x.signature), ['NEW2', 'NEW1']);
  });

  await t('RPC: tanda tangan target tidak pernah dibaca dari endpoint tanpa riwayat (publicnode)', async () => {
    const { SolanaRpc } = require('../src/solana/rpc');
    const rpc = new SolanaRpc([{ url: 'https://solana-rpc.publicnode.com', no_gpa: true, no_history: true }, { url: 'https://api.mainnet-beta.solana.com' }], () => {});
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(rpc.order({ needsHistory: true }).map((e) => new URL(e.url).hostname), ['api.mainnet-beta.solana.com']);
    assert.strictEqual(rpc.order({}).length, 2, 'baca akun biasa tetap memakai keduanya');
    const hit = [];
    await rpc.run(async (c, e) => { hit.push(new URL(e.url).hostname); return 1; }, { needsHistory: true });
    assert.deepStrictEqual(hit, ['api.mainnet-beta.solana.com']);
  });

  await t('gerakan saham remeh (<0,1%) bukan aksi; yang menumpuk tetap tertangkap sekali', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    let L = 10n ** 26n;
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: L.toString(), amount0: 1000n, amount1: 1000n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [{ signature: 'S' + Math.random() }] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    await w.scanTarget(TARGET);
    const step = 10n ** 26n / 5000n;                 // 0,02% per putaran
    for (let i = 0; i < 4; i++) { L -= step; assert.deepStrictEqual(await w.scanTarget(TARGET), [], `putaran ${i}`); }
    L -= step;                                        // total 0,1% → lewat ambang
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(-acts[0].delta, step * 5n, 'seluruh geseran yang menumpuk');
  });

  await t('jumlah yang bergerak = isi × ΔL/L di komposisi sekarang (bukan selisih isi yang ikut bergeser harga)', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const w = new SolanaWatcher({ rpc: {}, store, chain, cfg: { rules: {} }, log: () => {} });
    const P = (L, a0, a1) => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, tickLower: -300, tickUpper: 400, liquidity: String(L), amount0: String(a0), amount1: String(a1) });
    // L 100 → 150, harga bergeser: isi sesudahnya 300 MEME + 0 SOL (sisi SOL "turun")
    const [a] = SolanaWatcher.diff(TARGET, { X: P(100, 100, 200) }, { X: P(150, 300, 0) });
    const [row] = await w.persist([{ ...a, sig: 'S', slot: 1 }]);
    assert.strictEqual(row.amount0, '100', '300 × 50/150');
    assert.strictEqual(row.amount1, '0');
  });

  await t('tarik sebagian yang bulat ke 0 bps tidak dikirim', async () => {
    const pos = { venue: 'meteora', id: 'OurPos', pool: POOL, liquidity: '1000000', amount0: 1n, amount1: 1n, fee0: 0n, fee1: 0n };
    const { store, eng, sent } = engineHarness({ position: pos });
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
      VALUES('solana','meteora','OurPos',?,?,?,-300,400,'1000000',?,'TPos','open',?,10,'SOL')`, POOL, MEME, WSOL, TARGET, Date.now());
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,ext)
      VALUES('solana',?,1,'s:tiny',0,?,'meteora','decrease','TPos',?,?,?,'-1',?)`, Date.now(), TARGET, POOL, MEME, WSOL, JSON.stringify({ liquidityBefore: '1000000' }));
    await eng.handle(SolanaWatcher.actFromRow(store.get('SELECT * FROM actions')));
    assert.match(store.get('SELECT reason FROM decisions').reason, /terlalu kecil/);
    assert.strictEqual(sent.length, 0);
  });

  // ---- perencana -----------------------------------------------------------------------
  const rulesSol = (over = {}) => rulesFor(deepMerge(solanaTemplate().rules, over));
  const act = (over = {}) => ({
    id: 1, target: TARGET, venue: 'meteora', kind: 'increase', tokenId: 'TPos', poolRef: POOL, token0: MEME, token1: WSOL,
    lower: -3, upper: 3, tickLower: u.binToTick(-3, BIN_STEP), tickUpper: u.binToTick(4, BIN_STEP),
    amount0: String(3n * 10n ** 9n), amount1: String(4n * 10n ** 9n),   // target setor 3 MEME + 4 SOL = 7 SOL
    valueQuote: 7, liquidity: '100', liquidityBefore: '0', ...over,
  });
  const ctx = (store, over = {}) => ({ chain: fakeChain(store), pool: poolState(), ethUsd: 100, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0, cash: null, existingUsd: null, ...over });

  await t('rentang exact: bin target disalin apa adanya dan komposisi X/Y target diskala', () => {
    const store = new Store(':memory:');
    const d = planEntrySol(act(), { ...ctx(store), rules: rulesSol({ sizing: { mode: 'fixed_quote', fixed_quote_eth: 0.7, max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }) });
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.deepStrictEqual([d.plan.lower, d.plan.upper], [-3, 3]);
    // 0,7 SOL = 1/10 dari posisi target → 0,3 MEME + 0,4 SOL (dibulatkan ke bawah, ≤ 1 satuan)
    const near = (x, want) => { const d0 = want - BigInt(x); return d0 >= 0n && d0 <= 1n; };
    assert.ok(near(d.plan.amount0, 3n * 10n ** 8n), d.plan.amount0);
    assert.ok(near(d.plan.amount1, 4n * 10n ** 8n), d.plan.amount1);
    assert.ok(Math.abs(d.plan.valueUsd - 70) < 0.01, `valueUsd ${d.plan.valueUsd}`);
  });

  await t('mirror & pct menskala nilai tambahan target; plafon per posisi memotong', () => {
    const store = new Store(':memory:');
    const big = { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 };
    const mir = planEntrySol(act(), { ...ctx(store), rules: rulesSol({ sizing: { mode: 'mirror', ...big } }) });
    assert.ok(Math.abs(mir.plan.valueUsd - 700) < 0.01);
    const pct = planEntrySol(act(), { ...ctx(store), rules: rulesSol({ sizing: { mode: 'pct', pct: 10, ...big } }) });
    assert.ok(Math.abs(pct.plan.valueUsd - 70) < 0.01);
    const cap = planEntrySol(act(), { ...ctx(store), rules: rulesSol({ sizing: { mode: 'mirror', ...big, max_quote_per_position_usd: 25 } }) });
    assert.ok(Math.abs(cap.plan.valueUsd - 25) < 0.01);
    assert.match(cap.reason, /batas per posisi/);
  });

  await t('filter: venue mati, daftar hitam (peka huruf), satu sisi = lewati, rentang DLMM > 1400 bin', () => {
    const store = new Store(':memory:');
    const c = ctx(store);
    assert.match(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { venues: ['orca'] } }) }).reason, /venue meteora dimatikan/);
    assert.match(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { token_blacklist: [MEME] } }) }).reason, /daftar hitam/);
    assert.strictEqual(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { token_blacklist: [MEME.toLowerCase()] } }) }).verdict, 'copy', 'huruf kecil = alamat lain di Solana');
    const above = act({ lower: 5, upper: 9, tickLower: u.binToTick(5, BIN_STEP), tickUpper: u.binToTick(10, BIN_STEP), amount1: '0' });
    assert.match(planEntrySol(above, { ...c, rules: rulesSol({ onesided: { policy: 'skip' } }) }).reason, /satu sisi/);
    const wide = act({ lower: -800, upper: 800 });
    assert.match(planEntrySol(wide, { ...c, rules: rulesSol() }).reason, /1400/);
  });

  await t('kas: pool berkuotasi SOL, kas cuma USDC → ruang jembatan ikut dihitung', () => {
    const store = new Store(':memory:');
    const d = planEntrySol(act(), { ...ctx(store, { cash: { usd: 20, sol: 0 } }), rules: rulesSol({ sizing: { mode: 'mirror', max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }) });
    assert.strictEqual(d.verdict, 'copy');
    assert.ok(d.plan.valueUsd < 20 / 1.05 && d.plan.valueUsd > 17, `valueUsd ${d.plan.valueUsd}`);
    assert.match(d.reason, /kas tersedia/);
  });

  // ---- mesin ---------------------------------------------------------------------------
  function engineHarness({ dry = false, balances = new Map(), position = null, prices = { [MEME]: 100 } } = {}) {
    const store = new Store(':memory:');
    store.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('solana',?,1,?)", TARGET, Date.now());
    const sent = [];
    const adapter = {
      getPositions: async (items) => new Map(items.map((it) => [it.id, position])),
      buildDecrease: async (p) => { sent.push({ kind: 'decrease', ...p }); return { groups: [{ instructions: [] }] }; },
      buildOpen: async (p) => { sent.push({ kind: 'open', ...p }); return { groups: [{ instructions: [] }], position: 'NewPos', native: { lower: p.lower, upper: p.upper } }; },
    };
    const chain = fakeChain(store, { adapter, prices });
    const cfg = { mode: { dry_run: dry }, rules: solanaTemplate().rules, gas: { native_reserve_lamports: 100_000_000 }, loop: {}, prices: { auto_eth_price: false, eth_usd: 100 }, notify: {}, wallet: {} };
    const eng = new SolanaEngine({ rpc: chain.rpc, store, chain, cfg, log: () => {} });
    eng.ethUsd = 100;
    const swaps = [];
    eng.exec.address = () => ME;
    eng.exec.balances = async () => new Map(balances);
    eng.exec.sendGroups = async () => ({ ok: true, hashes: ['TxHash1'] });
    eng.swap = async (inMint, outMint, amount, opts) => { swaps.push({ inMint, outMint, amount, kind: opts.kind }); return { hash: 'SwapTx', out: 1n }; };
    eng.positions.resync = async () => [];
    return { store, chain, eng, sent, swaps };
  }

  await t('tarik sebagian target 25% → cermin kita ditarik 25% (bps), hasil dibukukan, posisi tetap terbuka', async () => {
    const pos = { venue: 'meteora', id: 'OurPos', pool: POOL, liquidity: '1000', amount0: 4n * 10n ** 9n, amount1: 6n * 10n ** 9n, fee0: 0n, fee1: 0n };
    const { store, eng, sent } = engineHarness({ position: pos });
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
      VALUES('solana','meteora','OurPos',?,?,?,-300,400,'1000',?,'TPos','open',?,10,'SOL')`, POOL, MEME, WSOL, TARGET, Date.now());
    const id = store.get('SELECT id FROM positions').id;
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,ext)
      VALUES('solana',?,1,'s:TPos',0,?,'meteora','decrease','TPos',?,?,?,'-25',?)`, Date.now(), TARGET, POOL, MEME, WSOL, JSON.stringify({ liquidityBefore: '100' }));
    const a = SolanaWatcher.actFromRow(store.get('SELECT * FROM actions'));
    eng.rulesFrom = () => rulesFor({ ...solanaTemplate().rules, exit: { sell_leftover: false } });
    await eng.handle(a);
    const d = store.get('SELECT verdict, reason FROM decisions');
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.strictEqual(sent[0].bps, 2500);
    assert.strictEqual(sent[0].close, false);
    const p = store.get('SELECT * FROM positions WHERE id=?', id);
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.liquidity, '750');
    assert.strictEqual(p.out0, String(10n ** 9n));          // 25% dari 4 MEME
    assert.strictEqual(p.out1, String(15n * 10n ** 8n));    // 25% dari 6 SOL
    assert.ok(Math.abs(p.out_quote - 2.5) < 1e-6, `out_quote ${p.out_quote}`);   // 1 MEME (1 SOL) + 1,5 SOL
  });

  await t('target menutup → cermin ditutup penuh, fee ikut dihitung, memecoin dicatat sebagai sisa', async () => {
    const pos = { venue: 'meteora', id: 'OurPos', pool: POOL, liquidity: '1000', amount0: 2n * 10n ** 9n, amount1: 3n * 10n ** 9n, fee0: 10n ** 8n, fee1: 2n * 10n ** 8n };
    const { store, eng, sent } = engineHarness({ position: pos });
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
      VALUES('solana','meteora','OurPos',?,?,?,-300,400,'1000',?,'TPos','open',?,5,'SOL')`, POOL, MEME, WSOL, TARGET, Date.now());
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,ext)
      VALUES('solana',?,1,'s:TPos',0,?,'meteora','decrease','TPos',?,?,?,'-100',?)`, Date.now(), TARGET, POOL, MEME, WSOL, JSON.stringify({ liquidityBefore: '100', gone: true }));
    eng.rulesFrom = () => rulesFor({ ...solanaTemplate().rules, exit: { sell_leftover: false } });
    await eng.handle(SolanaWatcher.actFromRow(store.get('SELECT * FROM actions')));
    assert.strictEqual(sent[0].close, true);
    const p = store.get('SELECT * FROM positions');
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.left_token, MEME);
    assert.strictEqual(p.left_amount, String(21n * 10n ** 8n));   // 2 + 0,1 fee
    assert.ok(Math.abs(p.out_quote - 5.3) < 1e-6, `out_quote ${p.out_quote}`);   // 2,1 MEME + 3,2 SOL
  });

  await t('mode simulasi: masuk diputuskan "dry" — transaksi disimulasikan, tidak ada yang dikirim', async () => {
    const { store, eng } = engineHarness({ dry: true });
    let kirim = 0;
    eng.exec.sendGroups = async () => { kirim++; return { ok: true, hashes: ['X'] }; };
    eng.exec.simulateGroups = async () => ({ ok: true, cu: 12345 });
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:TPos',0,?,'meteora','increase','TPos',?,?,?,?,?,'100',?,?,7,'SOL',?)`, Date.now(), TARGET, POOL, MEME, WSOL,
    u.binToTick(-3, BIN_STEP), u.binToTick(4, BIN_STEP), String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify({ lower: -3, upper: 3, liquidityBefore: '0' }));
    await eng.handle(SolanaWatcher.actFromRow(store.get('SELECT * FROM actions')));
    const d = store.get('SELECT verdict, reason FROM decisions');
    assert.strictEqual(d.verdict, 'dry', d.reason);
    assert.match(d.reason, /simulasi OK \(12345 CU\)/);
    assert.strictEqual(kirim, 0);
  });

  await t('sisa entry: yang dijual kembali hanya token yang DIBELI entry ini — saldo lama pemilik tidak disentuh', async () => {
    const { eng, swaps } = engineHarness({ balances: new Map([[MEME, 1000n * 10n ** 9n]]) });   // pemilik sudah pegang 1000 MEME
    // entry membeli 5 MEME; sesudah mint, sisa di wallet 1002 MEME (3 masuk posisi)
    eng.exec.balances = async () => new Map([[MEME, 1002n * 10n ** 9n]]);
    await eng.rescueTokens(new Map([[MEME, 5n * 10n ** 9n]]), new Map([[MEME, 1000n * 10n ** 9n]]), null);
    assert.strictEqual(swaps.length, 1);
    assert.strictEqual(swaps[0].amount, 2n * 10n ** 9n, 'hanya 2 MEME sisa pembelian');
    // saldo malah turun di bawah awal (dipakai posisi) → tidak ada yang dijual
    swaps.length = 0;
    eng.exec.balances = async () => new Map([[MEME, 998n * 10n ** 9n]]);
    await eng.rescueTokens(new Map([[MEME, 5n * 10n ** 9n]]), new Map([[MEME, 1000n * 10n ** 9n]]), null);
    assert.strictEqual(swaps.length, 0);
  });

  await t('kas: SOL native + wSOL dikurangi cadangan; USDC+USDT dijumlah', async () => {
    const { eng, chain } = engineHarness({ balances: new Map([['SOL', 300_000_000n], [WSOL, 50_000_000n], [USDC, 12_000_000n], [chain0usdt(), 3_000_000n]]) });
    const c = await eng.spendableCash();
    assert.ok(Math.abs(c.sol - 0.25) < 1e-9, `sol ${c.sol}`);
    assert.ok(Math.abs(c.usd - 15) < 1e-9, `usd ${c.usd}`);
    const cash = await eng.refreshCash();
    assert.ok(Math.abs(cash.usd - (15 + 0.35 * 100)) < 1e-9);
    void chain;
  });

  await t('saldo sesudah swap: menunggu sampai token yang dibeli BENAR-BENAR terbaca, bukan dua bacaan basi yang sama', async () => {
    const { eng } = engineHarness();
    const reads = [new Map(), new Map(), new Map([[MEME, 5n * 10n ** 9n]])];   // dua bacaan basi, lalu yang baru
    let i = 0;
    eng.exec.balances = async () => reads[Math.min(i++, reads.length - 1)];
    const b = await eng.balancesAfter(new Map(), MEME, 5n * 10n ** 9n);
    assert.strictEqual(b.get(MEME), 5n * 10n ** 9n);
    assert.strictEqual(i, 3);
  });

  await t('entry gagal di tengah (swap kedua) → token dari swap pertama dijual kembali, galat tetap dilaporkan', async () => {
    const { eng, swaps } = engineHarness({ balances: new Map([['SOL', 2n * 10n ** 9n]]) });
    let n = 0;
    eng.swap = async (inMint, outMint, amount, o) => {
      swaps.push({ inMint, outMint, amount, kind: o.kind });
      if (++n === 2 && o.kind === 'entry_swap') throw new Error('rute tidak ada');
      return { hash: 'H' + n, out: 5n * 10n ** 9n };
    };
    // Saldo mengikuti swap yang terjadi (bukan urutan panggilan).
    const wallet = new Map([['SOL', 2n * 10n ** 9n]]);
    const swap0 = eng.swap;
    eng.swap = async (inMint, outMint, amount, o) => { const r = await swap0(inMint, outMint, amount, o); if (n === 1) { wallet.set('SOL', 10n ** 9n); wallet.set(MEME, 5n * 10n ** 9n); } return r; };
    eng.exec.balances = async () => new Map(wallet);
    eng.chain.jup.prices = async (ms) => new Map(ms.map((m0) => [m0, 1]));
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: USDC, lower: -3, upper: 3,
      amount0: String(5n * 10n ** 9n), amount1: String(50n * 10n ** 6n), quoteKind: 'usd' };
    eng.chain.tokenCache.set(USDC, { address: USDC, symbol: 'USDC', decimals: 6 });
    await assert.rejects(eng.executeEntry(plan, { target: TARGET }), /rute tidak ada|kas tidak cukup/);
    const rescue = swaps.find((x) => x.kind === 'rescue_sell');
    assert.ok(rescue, 'ada jual-kembali');
    assert.strictEqual(rescue.inMint, MEME);
    assert.strictEqual(rescue.amount, 5n * 10n ** 9n);
  });

  await t('Raydium: tarik sebagian ikut mengirim fee → fee masuk hasil; DLMM tidak', async () => {
    for (const [venue, withFee] of [['raydium', true], ['meteora', false]]) {
      const pos = { venue, id: 'OurPos', pool: POOL, liquidity: '1000', amount0: 4n * 10n ** 9n, amount1: 4n * 10n ** 9n, fee0: 10n ** 9n, fee1: 0n };
      const { store, eng, chain } = engineHarness({ position: pos });
      chain.adapters[venue] = Object.assign(chain.adapters[venue], chain.adapters.meteora);
      store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
        VALUES('solana',?,'OurPos',?,?,?,-300,400,'1000',?,'TPos','open',?,10,'SOL')`, venue, POOL, MEME, WSOL, TARGET, Date.now());
      eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
      const row = store.get('SELECT * FROM positions');
      await eng.executeExit({ full: false, liquidity: '500' }, row);
      const p = store.get('SELECT out0 FROM positions');
      assert.strictEqual(p.out0, String(2n * 10n ** 9n + (withFee ? 10n ** 9n : 0n)), venue);
    }
  });

  await t('sisa entry (rescue) yang terjual tidak dibukukan ke posisi lain yang memegang token sama', async () => {
    const { store, eng } = engineHarness();
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,liquidity,status,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol,left_token,left_amount,left_quote)
      VALUES('solana','meteora','X',?,?,?,'0','closed',1,2,5,5,'SOL',?,'1000',1)`, POOL, MEME, WSOL, MEME);
    eng.swap = async () => ({ hash: 'S', out: 3n * 10n ** 6n });
    await eng.sellLeftover({ posId: null, token: MEME, amount: '400', rescue: true });
    const p = store.get('SELECT left_amount, out_quote FROM positions');
    assert.strictEqual(p.left_amount, '1000');
    assert.strictEqual(p.out_quote, 5);
  });

  await t('pengamat: sesudah tanda tangan baru, posisi dibaca ulang ~30 dtk walau tidak ada tanda tangan lagi (node tertinggal)', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    let L = '100';
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: L, amount0: 1n, amount1: 1n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    let sigs = [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => sigs }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    await w.scanTarget(TARGET);                    // potret awal
    sigs = [{ signature: 'S1', slot: 5 }];
    assert.deepStrictEqual(await w.scanTarget(TARGET), [], 'tanda tangan terlihat, state belum');
    sigs = [];
    L = '300';                                     // state baru terbaca belakangan
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(acts[0].kind, 'increase');
    assert.strictEqual(acts[0].delta, 200n);
  });

  await t('entry sukses end-to-end: tanpa swap → buka → posisi dibukukan dari isi posisi sesungguhnya', async () => {
    const got = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '777', amount0: 29n * 10n ** 8n, amount1: 39n * 10n ** 8n, fee0: 0n, fee1: 0n, tickLower: -300, tickUpper: 400, ext: { binStep: BIN_STEP } };
    const { store, eng, sent, swaps } = engineHarness({ position: got, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, tickLower: -300, tickUpper: 400,
      amount0: String(3n * 10n ** 9n), amount1: String(4n * 10n ** 9n), valueQuote: 7, quoteSymbol: 'SOL', quoteKind: 'eth', mirrorOf: 'TPos', target: TARGET };
    const r = await eng.executeEntry(plan, { target: TARGET });
    assert.strictEqual(swaps.length, 0, 'kas cukup, tanpa swap');
    assert.strictEqual(sent[0].kind, 'open');
    assert.strictEqual(sent[0].amount0, 3n * 10n ** 9n);
    const p = store.get('SELECT * FROM positions WHERE id=?', r.positionId);
    assert.strictEqual(p.token_id, 'NewPos');
    assert.strictEqual(p.cost0, String(29n * 10n ** 8n), 'modal = isi posisi yang terbaca, bukan rencana');
    assert.strictEqual(p.liquidity, '777');
    assert.ok(Math.abs(p.cost_quote - 6.8) < 1e-9, `cost_quote ${p.cost_quote}`);
    assert.strictEqual(JSON.parse(p.ext).lower, -3);
  });

  await t('entry: simulasi gagal (harga bergeser) → disusun ulang sekali; gagal kedua kali → galat', async () => {
    const got = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '1', amount0: 1n, amount1: 1n, fee0: 0n, fee1: 0n, tickLower: 0, tickUpper: 1 };
    const { eng, sent } = engineHarness({ position: got, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, amount0: '1000', amount1: '1000', valueQuote: 1, quoteSymbol: 'SOL', quoteKind: 'eth' };
    let n = 0;
    eng.exec.sendGroups = async () => { if (++n === 1) throw new Error('simulasi mint gagal: {"Custom":6017}'); return { ok: true, hashes: ['H'] }; };
    await eng.executeEntry(plan, { target: TARGET });
    assert.strictEqual(sent.filter((x) => x.kind === 'open').length, 2, 'disusun dua kali');
    n = 0;
    eng.exec.sendGroups = async () => { throw new Error('simulasi mint gagal: {"Custom":6017}'); };
    await assert.rejects(eng.executeEntry(plan, { target: TARGET }), /6017/);
  });

  // ---- tahap 1: keamanan mesin -----------------------------------------------------------
  const openRow = (store, over = {}) => {
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
      VALUES('solana','meteora',?,?,?,?,-300,400,?,?,?,'open',?,10,'SOL')`, over.token_id || 'OurPos', POOL, MEME, WSOL, over.liquidity || '1000',
    over.target === undefined ? TARGET : over.target, over.mirror_of === undefined ? 'TPos' : over.mirror_of, over.opened_ts || Date.now() - 3600_000);
    return store.get('SELECT * FROM positions ORDER BY id DESC LIMIT 1');
  };
  const POSV = { venue: 'meteora', id: 'OurPos', pool: POOL, liquidity: '1000', amount0: 2n * 10n ** 9n, amount1: 3n * 10n ** 9n, fee0: 0n, fee1: 0n };

  await t('keluar yang belum terkirim (simulasi gagal) dicoba lagi; yang sudah terkirim tidak pernah dikirim ulang', async () => {
    const { store, eng } = engineHarness({ position: POSV });
    eng.exitRetryWaits = [1, 1];
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
    const row = openRow(store);
    let n = 0;
    eng.exec.sendGroups = async () => { if (++n < 3) throw new Error('simulasi burn gagal: {"Custom":1}'); return { ok: true, hashes: ['H'] }; };
    await eng.executeExitRetry({ full: true, liquidity: '1000' }, row);
    assert.strictEqual(n, 3);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
    // konfirmasi tak terbaca (timeout): TIDAK diulang, catatan tertunda ditinggal untuk sinkron
    const { store: s2, eng: e2 } = engineHarness({ position: POSV });
    const r2 = openRow(s2);
    let m = 0;
    e2.exitRetryWaits = [1, 1];
    e2.exec.sendGroups = async () => { m++; return { ok: false, hashes: ['T'], last: { timeout: true } }; };
    await assert.rejects(e2.executeExitRetry({ full: true, liquidity: '1000' }, r2));
    assert.strictEqual(m, 1);
    assert.ok(s2.getState(e2.pendingExitKey(r2.id)), 'catatan keluar tertunda disimpan');
  });

  await t('keluar tertunda: posisi hilang di chain → dibukukan dari isi sebelum kirim; tidak berubah >3 mnt → dibuang', async () => {
    const { store, eng } = engineHarness({ position: null });
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
    const row = openRow(store);
    store.setState(eng.pendingExitKey(row.id), JSON.stringify({ ts: Date.now(), full: true, bps: 10000, ourL: '1000', before: { liquidity: '1000', amount0: String(2n * 10n ** 9n), amount1: String(3n * 10n ** 9n), fee0: '0', fee1: '0' } }));
    await eng.bookPendingExits();
    const p = store.get('SELECT status, out_quote FROM positions');
    assert.strictEqual(p.status, 'closed');
    assert.ok(Math.abs(p.out_quote - 5) < 1e-9);
    const { store: s2, eng: e2 } = engineHarness({ position: POSV });
    const r2 = openRow(s2);
    s2.setState(e2.pendingExitKey(r2.id), JSON.stringify({ ts: Date.now() - 4 * 60_000, full: true, bps: 10000, ourL: '1000', before: {} }));
    await e2.bookPendingExits();
    assert.strictEqual(s2.getState(e2.pendingExitKey(r2.id)), null);
    assert.strictEqual(s2.get('SELECT status FROM positions').status, 'open');
  });

  await t('rekonsiliasi: posisi target hilang dua kali berturut-turut → cermin ditutup (sinyal keluar terlewat)', async () => {
    const { store, eng, sent } = engineHarness();
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
    openRow(store);
    const ad = eng.chain.adapters.meteora;
    ad.getPositions = async (items) => new Map(items.map((it) => [it.id, it.id === 'TPos' ? null : POSV]));
    await eng.reconcileExits();
    assert.strictEqual(sent.length, 0, 'sekali belum cukup');
    await eng.reconcileExits();
    assert.strictEqual(sent[0].close, true);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('entry yang terputus (proses mati sesudah kirim): adopsi menautkannya lagi ke target, bukan posisi yatim', async () => {
    const live = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '555', amount0: 10n ** 9n, amount1: 10n ** 9n, fee0: 0n, fee1: 0n, tickLower: -300, tickUpper: 400, lower: -3, upper: 3 };
    const { store, eng } = engineHarness();
    eng.chain.adapters.meteora.listPositions = async () => [live];
    eng.chain.adapters.orca.listPositions = async () => [];
    eng.chain.adapters.raydium.listPositions = async () => [];
    store.setState(eng.sk('sol_pending_entry:NewPos'), JSON.stringify({ ts: Date.now() - 5000, target: TARGET, mirrorOf: 'TPos',
      plan: { venue: 'meteora', poolRef: POOL, token0: MEME, token1: WSOL, fee: 1, tickSpacing: 1, tickLower: -300, tickUpper: 400, liquidity: '555', amount0: '1', amount1: '1', valueQuote: 2, quoteSymbol: 'SOL', mirrorOf: 'TPos', lower: -3, upper: 3 } }));
    await eng.adoptOwnPositions(ME);
    const p = store.get('SELECT * FROM positions');
    assert.strictEqual(p.target, TARGET);
    assert.strictEqual(p.mirror_of, 'TPos');
    assert.strictEqual(p.cost0, String(10n ** 9n));
    assert.strictEqual(store.getState(eng.sk('sol_pending_entry:NewPos')), null);
  });

  await t('klaim fee: dibukukan ke claimed_quote; sisi memecoin dicatat di buku fee lalu dijual kalau diminta', async () => {
    const pos = { ...POSV, fee0: 10n ** 9n, fee1: 5n * 10n ** 8n };
    const { store, eng, swaps } = engineHarness({ position: pos });
    eng.chain.adapters.meteora.buildClaim = async () => ({ groups: [{ instructions: [] }] });
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); return { hash: 'SW', out: 9n * 10n ** 8n }; };
    const row = openRow(store);
    const r = await eng.claimFees(row.id, { sell: true });
    assert.ok(r.ok);
    const p = store.get('SELECT claimed_quote FROM positions');
    // klaim 1 MEME (≈1 SOL) + 0,5 SOL = 1,5; MEME terjual 0,9 SOL → taksiran diganti hasil jual: 1,4
    assert.ok(Math.abs(p.claimed_quote - 1.4) < 1e-9, `claimed ${p.claimed_quote}`);
    assert.strictEqual(swaps[0].i, MEME);
    assert.strictEqual(swaps[0].o, WSOL, 'dijual ke aset kuotasi pool');
    assert.strictEqual(swaps[0].amt, 10n ** 9n);
  });

  await t('compound: fee diklaim lalu dimasukkan lagi; yang masuk = compound_runs, sisanya = klaim fee', async () => {
    let reads = 0;
    const before = { ...POSV, fee0: 10n ** 9n, fee1: 10n ** 9n };
    const after = { ...POSV, liquidity: '1500', amount0: POSV.amount0 + 9n * 10n ** 8n, amount1: POSV.amount1 + 9n * 10n ** 8n, fee0: 0n, fee1: 0n };
    const { store, eng } = engineHarness();
    const ad = eng.chain.adapters.meteora;
    ad.getPositions = async (items) => new Map(items.map((it) => [it.id, reads++ === 0 ? before : after]));
    ad.buildClaim = async () => ({ groups: [{ instructions: [] }] });
    ad.buildIncrease = async (p) => { ad.inc = p; return { groups: [{ instructions: [] }] }; };
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6 } }));
    const row = openRow(store);
    eng.compound.configure(row.id, { enabled: true, mode: 'compound', minUsd: 1, intervalMinutes: 5 });
    await eng.compound.runCompound(row, eng.compound.status(row));
    assert.ok(ad.inc.amount0 > 0n && ad.inc.amount0 <= 10n ** 9n);
    const run = store.get('SELECT * FROM compound_runs');
    assert.strictEqual(run.liquidity, '500');
    assert.ok(Math.abs(run.reinvested_quote - 1.8) < 1e-9, `masuk ${run.reinvested_quote}`);
    const p = store.get('SELECT claimed_quote FROM positions');
    assert.ok(Math.abs(p.claimed_quote - 0.2) < 1e-9, `sisa ke wallet ${p.claimed_quote}`);
    assert.strictEqual(eng.compound.status(row).supported, true);
  });

  await t('umur pool minimum & isi SOL: pool muda dilewati; SOL di bawah separuh cadangan dibeli dari USDC', async () => {
    const { store, eng, swaps } = engineHarness({ dry: true });
    eng.chain.poolAgeMinutes = async () => 12;
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { filters: { min_pool_age_minutes: 60 } }));
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:young',0,?,'meteora','increase','TPos',?,?,?,'100',7,'SOL','{}')`, Date.now(), TARGET, POOL, MEME, WSOL);
    await eng.handle(SolanaWatcher.actFromRow(store.get('SELECT * FROM actions')));
    assert.match(store.get('SELECT reason FROM decisions').reason, /pool baru 12 menit/);
    const { eng: e2, swaps: sw2 } = engineHarness({ balances: new Map([['SOL', 20_000_000n], [USDC, 50_000_000n]]) });
    await e2.topUpGas([]);
    assert.strictEqual(sw2[0]?.inMint, USDC);
    assert.strictEqual(sw2[0]?.outMint, WSOL);
    void swaps;
  });

  await t('buka lagi: target masih di dalam & harga kembali dekat rentang → entry baru dinilai (reentry)', async () => {
    const tp = { venue: 'meteora', id: 'TPos', pool: POOL, liquidity: '100', amount0: 3n * 10n ** 9n, amount1: 4n * 10n ** 9n, fee0: 0n, fee1: 0n, tickLower: u.binToTick(-3, BIN_STEP), tickUpper: u.binToTick(4, BIN_STEP), lower: -3, upper: 3 };
    const { store, eng } = engineHarness({ dry: true, position: tp });
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { out_of_range_pct: 50, reenter_within_pct: 10 }, sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }));
    eng.exec.simulateGroups = async () => ({ ok: true, cu: 1 });
    eng.watchReentry({ target: TARGET, venue: 'meteora', tokenId: 'TPos' }, eng.rulesFrom(TARGET), { why: 'ditutup' });
    assert.strictEqual(eng.reentryWatches().length, 1);
    await eng.reentryTick();
    const a = store.get("SELECT * FROM actions WHERE kind='reentry'");
    assert.ok(a, 'aksi reentry dibuat');
    assert.strictEqual(store.get('SELECT verdict FROM decisions WHERE action_id=?', a.id).verdict, 'dry');
    assert.strictEqual(eng.reentryWatches().length, 0);
  });

  await t('sapu wallet: token non-kuotasi bernilai ≥ minimum dijual; debu & aset kuotasi dibiarkan', async () => {
    const DUST = 'Dust111111111111111111111111111111111111111';
    const { eng, swaps } = engineHarness({ balances: new Map([['SOL', 10n ** 9n], [USDC, 10n ** 6n], [MEME, 10n ** 9n], [DUST, 1n]]), prices: { [MEME]: 5, [DUST]: 1 } });
    eng.chain.tokenCache.set(DUST, { address: DUST, symbol: 'DUST', decimals: 9 });
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); return { hash: 'SW', out: 10n ** 6n }; };
    const r = await eng.sweepWallet({ minUsd: 1 });
    assert.strictEqual(r.swept, 1);
    assert.deepStrictEqual(swaps.map((x) => x.i), [MEME]);
  });

  // ---- LP manual, swap, ikuti aksi (solana/manual.js) -------------------------------------
  const { SolanaManual } = require('../src/solana/manual');
  const { Manual } = require('../src/manual');
  function manualHarness({ balances = new Map(), pool = poolState(), prices = { [MEME]: 100, [WSOL]: 100, [USDC]: 1 } } = {}) {
    const h = engineHarness({ balances, prices });
    h.chain.pools = async (venue, addrs) => new Map(addrs.map((a) => [a, { ...pool, id: a }]));
    h.chain.pool = async (venue, a) => ({ ...pool, id: a });
    h.chain.venueOfPool = async () => pool.venue;
    h.chain.rememberPool({ ...pool, id: POOL });
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6 } }));
    const man = new SolanaManual({ engine: h.eng, store: h.store, chain: h.chain, rpc: h.chain.rpc, log: () => {} });
    return { ...h, man };
  }

  await t('LP manual DLMM: rentang ±% jadi bin, jumlah token dari nilai, satu sisi di atas harga = hanya token0', async () => {
    const { man } = manualHarness({ balances: new Map([['SOL', 10n ** 12n]]) });
    const r = await man.planLp({ poolRef: POOL, usd: 100, widthPct: 20 });
    assert.ok(!r.error, r.error);
    assert.ok(r.plan.lower < 0 && r.plan.upper > 0, `bin ${r.plan.lower}..${r.plan.upper} mengapit bin aktif`);
    assert.strictEqual(r.preview.nativeUnit, 'bin');
    assert.ok(Math.abs(r.plan.valueUsd - 100) < 1, `nilai $${r.plan.valueUsd}`);
    const one = await man.planLp({ poolRef: POOL, usd: 50, lowerPct: 0, upperPct: 30 });
    assert.ok(!one.error, one.error);
    assert.strictEqual(one.plan.side, 'token0_only');
    assert.ok(one.plan.lower > 0, 'batas bawah di atas bin aktif');
    assert.strictEqual(one.plan.amount1, '0');
    // pool yang tidak dikenal chain → galat jelas
    const none = await man.planLp({ poolRef: 'not-a-pool', usd: 10 });
    assert.match(none.error, /pool tidak dikenal/);
  });

  await t('LP manual Orca: tick dibulatkan ke spacing; simulasi tukar membeli kekurangan dari USDC lewat Jupiter', async () => {
    const orca = { venue: 'orca', id: POOL, token0: MEME, token1: USDC, dec0: 9, dec1: 6,
      sqrtX96: u.sqrtX96FromPrice(100 * 1e-3), tick: Math.floor(Math.log(0.1) / Math.log(1.0001)), current: Math.floor(Math.log(0.1) / Math.log(1.0001)), spacing: 64, tickSpacing: 64, fee: 3000, liquidity: 10n ** 12n, enabled: true };
    const { man } = manualHarness({ pool: orca, balances: new Map([['SOL', 10n ** 9n], [USDC, 1_000_000_000n]]), prices: { [MEME]: 100, [WSOL]: 100, [USDC]: 1 } });
    const r = await man.planLp({ poolRef: POOL, usd: 200, widthPct: 10 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(Math.abs(r.plan.lower % 64), 0); assert.strictEqual(Math.abs(r.plan.upper % 64), 0);
    assert.strictEqual(r.preview.nativeUnit, 'tick');
    assert.strictEqual(r.preview.swaps.length, 1, 'satu tukar: USDC → MEME');
    assert.strictEqual(r.preview.swaps[0].dari.token, USDC);
    assert.strictEqual(r.preview.swaps[0].ke.token, MEME);
    assert.strictEqual(r.preview.swaps[0].router, 'Jupiter');
    const usdcAfter = r.preview.saldo.tokens.find((x) => x.token === USDC).sesudah;
    assert.ok(usdcAfter > 790 && usdcAfter < 810, `USDC sesudah ≈ 800, dapat ${usdcAfter}`);
  });

  await t('swap manual: token kustom base58 disimpan apa adanya; SOL = native + wSOL dikurangi cadangan; swap lewat engine.swap', async () => {
    const { man, eng, store, swaps } = manualHarness({ balances: new Map([['SOL', 500_000_000n], [WSOL, 100_000_000n], [USDC, 5_000_000n]]) });
    const JUPM = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    man.addCustomToken(JUPM);
    man.addCustomToken('0xe9c209fd02a1562761c99700fc3d126e64b981ee');
    assert.deepStrictEqual(man.customTokens(), [JUPM], 'huruf dipertahankan; alamat EVM dibuang');
    const held = await man.held();
    const sol = held.find((x) => x.address === WSOL);
    assert.strictEqual(sol.raw, '600000000');
    assert.strictEqual(await man.amountRaw(WSOL, 'semua'), 500_000_000n, 'cadangan 0,1 SOL tidak ikut');
    assert.strictEqual(await man.amountRaw(USDC, '1.5'), 1_500_000n);
    await assert.rejects(man.amountRaw(USDC, '10'), /saldo cuma/);
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); store.run("INSERT INTO txs(chain,hash,ts,kind,status) VALUES('solana','SWX',?, 'swap_manual','ok')", Date.now()); return { hash: 'SWX', out: 12_000_000n, usdOut: 12 }; };
    const r = await man.doSwap({ tokenIn: WSOL, tokenOut: USDC, amountRaw: 100_000_000n });
    assert.strictEqual(swaps[0].kind, 'swap_manual');
    assert.match(r.note, /^0\.10+ SOL → 12\.0+ USDC$/);
    assert.strictEqual(JSON.parse(store.get("SELECT detail FROM txs WHERE hash='SWX'").detail).symbolOut, 'USDC');
  });

  await t('ikuti aksi: aksi Solana yang dilewati bisa diikuti; mode exact memakai bin target apa adanya', async () => {
    assert.strictEqual(Manual.followable({ kind: 'increase', venue: 'meteora', verdict: 'skip', token_id: 'TPos', pool_ref: POOL, tick_lower: -1, tick_upper: 1, target: TARGET }, new Set()), true);
    const { man, store, eng } = manualHarness({ balances: new Map([['SOL', 10n ** 12n]]) });
    eng.targetLiquidity = async () => ({ liquidity: 100n });
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { range: { mode: 'exact' }, sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6 } }));
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:f',0,?,'meteora','increase','TPos',?,?,?,?,?,'100',1,'SOL',?)`, Date.now(), TARGET, POOL, MEME, WSOL,
    u.binToTick(-5, BIN_STEP), u.binToTick(8, BIN_STEP), JSON.stringify({ lower: -5, upper: 7 }));
    const a = store.get('SELECT id FROM actions');
    store.run("INSERT INTO decisions(action_id,ts,verdict,reason) VALUES(?,?,'skip','cooldown')", a.id, Date.now());
    const r = await man.planFollow({ actionId: a.id, usd: 20 });
    assert.ok(!r.error, r.error);
    assert.deepStrictEqual([r.plan.lower, r.plan.upper], [-5, 7]);
    assert.strictEqual(r.plan.mirrorOf, 'TPos');
  });

  // ---- modal, hasil token, kedalaman, holder, scout -------------------------------------
  const { SolanaCapital } = require('../src/solana/capital');
  const { SolanaProceeds } = require('../src/solana/proceeds');
  const key = (k, signer = false) => ({ pubkey: { toBase58: () => k }, signer });
  const ix = (p) => ({ programId: { toBase58: () => p } });
  const ptx = ({ keys, programs, pre = [], post = [], preTok = [], postTok = [], fee = 5000 }) => ({
    blockTime: 1_700_000_000,
    transaction: { message: { accountKeys: keys, instructions: programs.map(ix) } },
    meta: { err: null, fee, preBalances: pre, postBalances: post, preTokenBalances: preTok, postTokenBalances: postTok, innerInstructions: [] },
  });
  const tb = (owner, mint, amount) => ({ owner, mint, uiTokenAmount: { amount: String(amount) } });

  await t('modal Solana: USDC masuk dari luar = setoran; SOL keluar lewat transfer biasa = penarikan; tx dagang wallet dilewati', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store, { prices: { [WSOL]: 100 } });
    const cap = new SolanaCapital({ engine: { ethUsd: 100 }, rpc: chain.rpc, store, chain, cfg: {}, log: () => {} });
    const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', SYS = '11111111111111111111111111111111', JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
    const txs = {
      dep: ptx({ keys: [key('Sender1111111111111111111111111111111111111', true), key('ata1'), key('ata2')], programs: [TOKEN], pre: [1e9, 0, 0], post: [1e9 - 5000, 0, 0], preTok: [tb(ME, USDC, 0)], postTok: [tb(ME, USDC, 50_000_000)] }),
      wd: ptx({ keys: [key(ME, true), key('Friend11111111111111111111111111111111111111')], programs: [SYS], pre: [2e9, 0], post: [1e9 - 5000, 1e9] }),
      trade: ptx({ keys: [key(ME, true), key('x')], programs: [JUP], pre: [2e9, 0], post: [1e9, 0], preTok: [tb(ME, USDC, 0)], postTok: [tb(ME, USDC, 100_000_000)] }),
    };
    chain.rpc.run = async (fn) => fn({ getParsedTransaction: async (sig) => txs[sig] });
    for (const sig of Object.keys(txs)) await cap.readTx(ME, { signature: sig, slot: 5, blockTime: 1_700_000_000 });
    const rows = cap.rows();
    assert.deepStrictEqual(rows.map((r) => [r.tx_hash, r.kind, r.symbol, Math.round(r.usd)]), [['dep', 'deposit', 'USDC', 50], ['wd', 'withdraw', 'SOL', 100]]);
  });

  await t('hasil token Solana: keluar dengan USDC masuk di tx yang sama = jual (USD dari saldo tx); masuk dari luar = pasokan', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const pr = new SolanaProceeds({ rpc: chain.rpc, store, chain, research: {}, log: () => {} });
    const txs = {
      sell: ptx({ keys: [key(ME, true)], programs: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'], pre: [1e9], post: [1e9 - 5000], preTok: [tb(ME, MEME, 1000), tb(ME, USDC, 0)], postTok: [tb(ME, MEME, 400), tb(ME, USDC, 7_000_000)] }),
      gift: ptx({ keys: [key('Other1111111111111111111111111111111111111', true)], programs: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], pre: [1e9], post: [1e9], preTok: [tb(ME, MEME, 400)], postTok: [tb(ME, MEME, 900)] }),
    };
    pr.tokenAccounts = async () => [TARGET];   // alamat sah apa saja: tanda tangannya dipalsukan
    chain.rpc.run = async (fn) => fn({
      getSignaturesForAddress: async () => [{ signature: 'gift', slot: 20 }, { signature: 'sell', slot: 10 }],
      getParsedTransaction: async (sig) => txs[sig],
    });
    const known = [];
    await pr.scanTransfers(ME, MEME, 1, 100, { ethUsd: 100, known, seenTx: new Set(), lpTx: new Set() });
    assert.deepStrictEqual(known.map((k) => [k.tx_hash, k.tok_out, k.quote_usd]), [['sell', '600', 7]]);
    assert.strictEqual(store.get('SELECT tok_in FROM wflows').tok_in, '500');
    assert.strictEqual((await pr.receivedIn(['gift'], ME, MEME)).get('gift'), 500n);
  });

  await t('kedalaman DLMM: bin → L setara; membeli satu bin penuh di model = menukar isi bin itu', async () => {
    const { poolDepthSol, uniformL } = require('../src/solana/pool-depth');
    const { makeCurve, buyToPrice } = await import('../web/src/liquidityRisk.mjs');
    const store = new Store(':memory:');
    const pool = poolState({ token1: USDC, dec1: 9 });
    // tiap bin memuat 1000 token nilai Y (bin di atas: X saja, di bawah: Y saja, aktif: separuh)
    const bins = [];
    for (let b = -20; b <= 20; b++) {
      const p = (1 + BIN_STEP / 1e4) ** b;
      bins.push({ bin: b, x: b > 0 ? BigInt(Math.round(1000e9 / p)) : b === 0 ? BigInt(Math.round(500e9 / p)) : 0n, y: b < 0 ? 1000n * 10n ** 9n : b === 0 ? 500n * 10n ** 9n : 0n });
    }
    const chain = fakeChain(store, { pool, adapter: { depth: async () => bins } });
    chain.venueOfPool = async () => 'meteora';
    chain.pool = async () => pool;
    const d = await poolDepthSol({ rpc: { slot: async () => 9, run: async () => { throw new Error('x'); } }, chain, store, engine: { ethUsd: 100, exec: { address: () => null } } }, POOL);
    assert.ok(!d.error, d.error);
    const c = makeCurve(d);
    assert.ok(c, 'kurva terbentuk');
    // dari tengah bin aktif sampai atas bin +5 = ½ bin aktif + 5 bin penuh ≈ 5.500 USDC (+fee)
    const target = (1 + BIN_STEP / 1e4) ** 6;
    const r = buyToPrice(c, target);
    const q = r.quote * (1 - d.buyFee);
    assert.ok(q > 5300 && q < 5700, `butuh ${q.toFixed(0)} USDC`);
    assert.ok(uniformL(0n, 10n ** 9n, -100, 100, 1) > 0);
  });

  await t('holder Solana: RPC publik menolak daftar holder → jumlah & porsi top holder dari Jupiter', async () => {
    const { solanaHolders } = require('../src/solana/holders');
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    chain.jup.tokenRecord = async () => ({ holderCount: 1234, decimals: 9, audit: { topHoldersPercentage: 41.5 } });
    const r = await solanaHolders({ rpc: { run: async () => { throw new Error('403 Request blocked'); } }, chain }, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
    assert.deepStrictEqual([r.error, r.holderCount, r.top10Pct, r.source, r.items.length], [undefined, 1234, 41.5, 'Jupiter', 0]);
  });

  await t('scout Solana: posisi hidup semua venue, nilai & fee dalam USD, venue yang gagal dicatat', async () => {
    const { scoutWalletSol } = require('../src/solana/scout');
    const store = new Store(':memory:');
    const pool = poolState({ token1: USDC, dec1: 9 });
    const chain = fakeChain(store, { pool });
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, liquidity: '10', amount0: 10n ** 9n, amount1: 10n ** 9n, fee0: 0n, fee1: 10n ** 8n, tickLower: -500, tickUpper: 500, lower: -5, upper: 4 }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => { throw new Error('gPA ditolak'); };
    const rpc = { slot: async () => 7, run: async () => [] };
    const r = await scoutWalletSol(rpc, chain, TARGET, { ethUsd: 100, store });
    assert.strictEqual(r.positionsAlive, 1);
    assert.deepStrictEqual(r.venuesFailed, ['raydium']);
    assert.ok(Math.abs(r.totalValueUsd - 2) < 1e-6, `nilai ${r.totalValueUsd}`);
    assert.ok(Math.abs(r.totalUnclaimedFeeUsd - 0.1) < 1e-6);
    assert.strictEqual(r.pairs['MEME/USDC'].n, 1);
  });

  // ---- dasbor --------------------------------------------------------------------------
  await t('dasbor Solana: target base58 disimpan apa adanya; scout, swap & riset wallet tersedia', async () => {
    const { createServer } = require('../src/server');
    const store = new Store(':memory:');
    const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
    const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-sol-')), 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const chain = fakeChain(store);
    const engine = {
      cfg, store, ethUsd: 100, chain, positions: { live: [], lastSync: 0, summary: () => ({}) }, watcher: { unsupported: new Map(), enabledSet: () => new Set() },
      exec: { address: () => ME, balances: async () => new Map() }, leftovers: () => [], compound: { status: () => ({}) },
      dryRun: () => true, paused: () => false,
    };
    const server = createServer({ engine, store, cfg, cfgPath, chain, rpc: { stats: () => [] }, log: () => {}, telegram: null });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = async (p, body) => (await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    try {
      assert.deepStrictEqual(await post('/api/targets', { address: TARGET, label: 'dlmm' }), { ok: true });
      assert.strictEqual(store.get('SELECT address FROM targets').address, TARGET, 'huruf tidak diubah');
      assert.match((await post('/api/targets', { address: '0xe9c209fd02a1562761c99700fc3d126e64b981ee' })).error, /tidak valid/);
      await post('/api/targets/toggle', { address: TARGET, enabled: false });
      assert.strictEqual(store.get('SELECT enabled FROM targets').enabled, 0, 'toggle menemukan alamat base58');
      // tidak ada lagi rute yang ditutup untuk Solana
      const r = await (await fetch(`${base}/api/scout?address=${TARGET}`)).json();
      assert.strictEqual(r.unsupported, undefined);
      assert.strictEqual(r.status, 'kosong');
      const tk = await (await fetch(`${base}/api/manual/tokens`)).json();
      assert.ok(Array.isArray(tk.tokens) && tk.tokens.some((x) => x.address === WSOL && x.symbol === 'SOL'), 'daftar swap memuat SOL');
      assert.deepStrictEqual(await post('/api/manual/tokens/add', { address: '0xe9c209fd02a1562761c99700fc3d126e64b981ee' }), { error: 'alamat tidak valid — alamat Solana (base58, 32–44 karakter)' });
      // riset wallet sekarang didukung di Solana (belum dipindai = found:false, bukan galat)
      const w = await (await fetch(`${base}/api/wallet?address=${TARGET}`)).json();
      assert.strictEqual(w.found, false);
      assert.strictEqual(w.unsupported, undefined);
    } finally { await new Promise((r) => server.close(r)); }
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();

function chain0usdt() { return require('../src/networks').build('solana').ADDR.usdt; }
