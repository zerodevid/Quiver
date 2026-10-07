'use strict';
// Tests of Solana support (Meteora DLMM, Orca Whirlpools, Raydium CLMM).
//
// The real code is used for units, the watcher (snapshot diffs), the planner and the engine;
// only the outer edges are faked: RPC, venue adapters (reading/building transactions), Jupiter,
// and the transaction sender. The question is the same as the EVM tests: "when the target does
// X, does the bot decide and book the right thing?"
//
// Run: node test/solana.js
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
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.stack.split('\n').slice(0, process.env.V ? 14 : 3).join('\n       ')}`); }
}

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'MeMeCoin1111111111111111111111111111111111pump';
const TARGET = '6mch5rCLBtZ9DCnM2mx18Ud1XXhXAip7otw9LkrTXwTD';
const ME = 'Me11111111111111111111111111111111111111111';
const POOL = 'Poo1111111111111111111111111111111111111111';

// DLMM MEME/SOL pool: binStep 100, active bin 0 → raw price 1 (9 vs 9 decimals = 1 SOL/MEME).
const BIN_STEP = 100;
const poolState = (over = {}) => ({
  venue: 'meteora', id: POOL, token0: MEME, token1: WSOL, dec0: 9, dec1: 9,
  sqrtX96: u.binSqrtX96(0, BIN_STEP), tick: u.binToTick(0, BIN_STEP), current: 0, spacing: 1, binStep: BIN_STEP,
  ticksPerUnit: u.ticksPerBin(BIN_STEP), fee: 10_000, tickSpacing: 100, liquidity: null, enabled: true, ...over,
});

// The real Solana chain with a fake RPC, adapters and Jupiter.
// Meteora data API: offline by default (every address is "not a DLMM pool").
const noMeteora = () => ({ pool: async () => null, pools: async () => ({ total: 0, pools: [] }), ohlcv: async () => null });
function fakeChain(store, { pool = poolState(), adapter = {}, prices = {}, meteoraApi = noMeteora() } = {}) {
  const rpc = { run: async () => { throw new Error('rpc palsu'); }, primary: () => null, slot: async () => 1, allCooling: () => false, stats: () => [] };
  const jup = {
    prices: async (mints) => new Map(mints.filter((x) => prices[x] != null).map((x) => [x, prices[x]])),
    tokenInfo: async () => new Map(), quote: async () => { throw new Error('tidak dipakai'); },
  };
  const chain = new SolanaChain(rpc, store, () => {}, 'solana', { jupiter: jup, meteoraApi });
  chain.tokenCache.set(MEME, { address: MEME, symbol: 'MEME', name: 'Meme', decimals: 9 });
  chain.pools = async (venue, addrs) => new Map(addrs.map((a) => [a, { ...pool, id: a }]));
  chain.adapters.meteora = Object.assign(chain.adapters.meteora, adapter);
  return chain;
}

(async () => {
  console.log('solana');

  // ---- addresses ---------------------------------------------------------------------
  await t('Solana addresses: base58 keeps its case, EVM stays lower-case, invalid ones are rejected', () => {
    assert.ok(isSolana('solana') && !isSolana('bsc'));
    assert.strictEqual(normAddr('solana', ` ${TARGET} `), TARGET);
    assert.strictEqual(normAddr('solana', '0xabc'), null);
    assert.strictEqual(normAddr('solana', TARGET.replace('m', '0')), null, 'the digit 0 is not base58');
    assert.strictEqual(normAddr('bsc', '0xE9C209FD02A1562761C99700FC3D126E64B981EE'), '0xe9c209fd02a1562761c99700fc3d126e64b981ee');
    assert.strictEqual(normAddr('bsc', TARGET), null);
  });

  // ---- units ---------------------------------------------------------------------------
  await t('DLMM bin ↔ equivalent tick: active bin in [lower, upper] ⇔ its tick in [tickLower, tickUpper)', () => {
    for (const bs of [1, 4, 10, 25, 80, 100, 250]) {
      for (const [lo, hi] of [[-10, 10], [-5388, -5343], [0, 0], [100, 169]]) {
        const { tickLower, tickUpper } = u.binRangeToTicks(lo, hi, bs);
        assert.ok(tickUpper > tickLower, `bs ${bs} [${lo},${hi}] zero width`);
        for (let a = lo - 3; a <= hi + 3; a++) {
          const inBins = a >= lo && a <= hi;
          const tk = u.binToTick(a, bs);
          assert.strictEqual(tk >= tickLower && tk < tickUpper, inBins, `bs ${bs} bin ${a} [${lo},${hi}]`);
        }
        assert.strictEqual(u.tickToBin(tickLower, bs), lo, `bs ${bs} tickToBin(${tickLower}) maps back to ${lo}`);
      }
    }
  });

  await t('DLMM bin prices & Orca/Raydium Q64 sqrt normalise to the same price as the Uniswap formula', () => {
    // SOL/USDC DLMM binStep 4, bin −5426 → ~114 USDC per SOL (measured on mainnet 2026-09-24)
    const p = m.priceFromSqrt(u.binSqrtX96(-5426, 4), 9, 6);
    assert.ok(p > 113 && p < 115, `price ${p}`);
    assert.ok(Math.abs(m.tickToPrice(u.binToTick(-5426, 4), 9, 6) - p) / p < 0.001, 'the equivalent tick gives the same price');
    // Q64.64 → Q96: tick 0 = sqrt 1.0 = 2^64 (Q64) = 2^96 (Q96)
    assert.strictEqual(u.x64ToX96(1n << 64n), 1n << 96n);
    assert.strictEqual(m.getTickAtSqrtRatio(u.x64ToX96(1n << 64n)), 0);
  });

  await t('CLMM fees (Orca/Raydium): growth inside the range × L >> 64, with 2^128 wrap-around', () => {
    const g = 1000n << 64n;
    // price inside the range: inside = global − below − above
    const inside = feeGrowthInside({ tickCurrent: 0, tickLower: -10, tickUpper: 10, global: g, lowerOut: 100n << 64n, upperOut: 50n << 64n });
    assert.strictEqual(inside, 850n << 64n);
    assert.strictEqual(unclaimed({ liquidity: 2n, inside, checkpoint: 800n << 64n, owed: 7n }), 7n + 100n);
    // checkpoint "ahead" (already wrapped): stays small positive, not a huge negative
    assert.strictEqual(unclaimed({ liquidity: 1n, inside: 5n << 64n, checkpoint: ((1n << 128n) - (3n << 64n)), owed: 0n }), 8n);
  });

  await t('SOL/USDC pool: the stablecoin is the quote (USDC per SOL, value in USD); a MEME/SOL pool stays SOL', () => {
    const chain = fakeChain(new Store(':memory:'));
    assert.deepStrictEqual([chain.quoteSideOf(WSOL, USDC).side, chain.quoteSideOf(WSOL, USDC).symbol], [1, 'USDC']);
    assert.deepStrictEqual([chain.quoteSideOf(USDC, WSOL).side, chain.quoteSideOf(USDC, WSOL).symbol], [0, 'USDC']);
    assert.deepStrictEqual([chain.quoteSideOf(MEME, WSOL).side, chain.quoteSideOf(MEME, WSOL).symbol], [1, 'SOL']);
    assert.strictEqual(chain.quoteSideOf(MEME, 'Other1111111111111111111111111111111111111'), null);
  });

  await t('valuation is always in the position row’s quote units (an old SOL row stays right even though the quote is now USDC)', () => {
    const chain = fakeChain(new Store(':memory:'));
    // SOL/USDC pool at 113 USDC per SOL; position 1 SOL + 113 USDC = 226 USDC = 2 SOL
    const args = { sqrtPriceX96: u.sqrtX96FromPrice(113 * 10 ** (6 - 9)), amount0: 10n ** 9n, amount1: 113n * 10n ** 6n, dec0: 9, dec1: 6, token0: WSOL, token1: USDC };
    assert.ok(Math.abs(chain.valueAs(args, 'USDC', 113) - 226) < 1e-6);
    assert.ok(Math.abs(chain.valueAs(args, 'SOL', 113) - 2) < 1e-9);
  });

  // ---- watcher -------------------------------------------------------------------------
  await t('snapshot diff: new position = increase, L up = increase, L down = proportional withdrawal, gone = close', () => {
    const P = (L, a0 = '0', a1 = '0') => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower: -5, upper: 5, tickLower: -500, tickUpper: 600, liquidity: String(L), amount0: a0, amount1: a1 });
    const prev = { A: P(100), B: P(100), C: P(100), D: P(100) };
    const now = { A: P(100), B: P(150), C: P(25), E: P(40) };
    const acts = SolanaWatcher.diff(TARGET, prev, now);
    const by = Object.fromEntries(acts.map((a) => [a.id, a]));
    assert.strictEqual(by.A, undefined, 'unchanged = no action');
    assert.deepStrictEqual([by.B.kind, by.B.delta, by.B.before], ['increase', 50n, 100n]);
    assert.deepStrictEqual([by.C.kind, by.C.delta, by.C.before], ['decrease', -75n, 100n]);
    assert.deepStrictEqual([by.D.kind, by.D.delta, by.D.before, by.D.gone], ['decrease', -100n, 100n, true]);
    assert.deepStrictEqual([by.E.kind, by.E.delta, by.E.before], ['increase', 40n, 0n]);
  });

  await t('a venue that fails to read does NOT read as "all its positions closed"', async () => {
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
    assert.ok(w.loadSnap(TARGET).positions.X, 'the failed venue’s old snapshot is kept');
  });

  await t('a target’s first scan only takes a snapshot — existing positions are not copied', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: '9', amount0: 1n, amount1: 1n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    assert.deepStrictEqual(await w.scanTarget(TARGET), []);
    assert.ok(w.loadSnap(TARGET).positions.P1);
  });

  await t('a venue that failed during the first snapshot: once read, its positions become snapshot — NOT copied en masse', async () => {
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
    await w.scanTarget(TARGET);                   // first snapshot: raydium fails
    rayOk = true;
    assert.deepStrictEqual(await w.scanTarget(TARGET), [], 'old raydium positions are not new actions');
    assert.ok(w.loadSnap(TARGET).positions.OldRay);
    // afterwards a real raydium move is still detected
    chain.adapters.raydium.listPositions = async () => [];
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(acts[0].gone, true);
  });

  await t('last signature unknown to the endpoint ("not found") → still scanned, not stuck forever', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async (pk, o) => {
      if (o.until) throw new Error('failed to get signatures for address: Transaction OLD not found');
      return [{ signature: 'NEW2' }, { signature: 'NEW1' }, { signature: 'OLD' }];
    } }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    const sigs = await w.newSignatures(TARGET, 'OLD');
    assert.deepStrictEqual(sigs.map((x) => x.signature), ['NEW2', 'NEW1']);
  });

  await t('RPC: full history never comes from a day-of-history endpoint; target polling prefers it, the full one is the fallback', async () => {
    const { SolanaRpc } = require('../src/solana/rpc');
    const rpc = new SolanaRpc([{ url: 'https://api.mainnet-beta.solana.com' }, { url: 'https://solana-rpc.publicnode.com', no_gpa: true, no_history: true }], () => {});
    const hosts = (list) => list.map((e) => new URL(e.url).hostname);
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(hosts(rpc.order({ needsHistory: true })), ['api.mainnet-beta.solana.com']);
    for (let i = 0; i < 4; i++) assert.deepStrictEqual(hosts(rpc.order({ recentHistory: true })), ['solana-rpc.publicnode.com', 'api.mainnet-beta.solana.com']);
    assert.strictEqual(rpc.order({}).length, 2, 'plain account reads still use both');
    // the watcher's signature poll lands on publicnode; when it is resting, mainnet-beta answers
    const store = new Store(':memory:');
    store.run("INSERT INTO targets(chain,address,enabled,added_ts) VALUES('solana',?,1,?)", TARGET, Date.now());
    const chain = fakeChain(store);
    const w = new SolanaWatcher({ rpc, store, chain, cfg: { rules: solanaTemplate().rules }, log: () => {} });
    const hit = [];
    for (const e of rpc.eps) e.conn = { getSignaturesForAddress: async () => { hit.push(new URL(e.url).hostname); return []; } };
    await w.newSignatures(TARGET, null);
    rpc.eps[1].cooldownUntil = Date.now() + 60_000;
    await w.newSignatures(TARGET, null);
    assert.deepStrictEqual(hit, ['solana-rpc.publicnode.com', 'api.mainnet-beta.solana.com']);
  });

  await t('trivial share moves (<0.1%) are not actions; ones that add up are still caught once', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    let L = 10n ** 26n;
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: L.toString(), amount0: 1000n, amount1: 1000n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => [{ signature: 'S' + Math.random() }] }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    await w.scanTarget(TARGET);
    const step = 10n ** 26n / 5000n;                 // 0.02% per round
    for (let i = 0; i < 4; i++) { L -= step; assert.deepStrictEqual(await w.scanTarget(TARGET), [], `round ${i}`); }
    L -= step;                                        // total 0.1% → crosses the threshold
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(-acts[0].delta, step * 5n, 'all the accumulated drift');
  });

  await t('the amount that moved = contents × ΔL/L at the current composition (not the contents difference, which shifts with price)', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const w = new SolanaWatcher({ rpc: {}, store, chain, cfg: { rules: {} }, log: () => {} });
    const P = (L, a0, a1) => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, tickLower: -300, tickUpper: 400, liquidity: String(L), amount0: String(a0), amount1: String(a1) });
    // L 100 → 150, price moved: contents afterwards 300 MEME + 0 SOL (the SOL side "fell")
    const [a] = SolanaWatcher.diff(TARGET, { X: P(100, 100, 200) }, { X: P(150, 300, 0) });
    const [row] = await w.persist([{ ...a, sig: 'S', slot: 1 }]);
    assert.strictEqual(row.amount0, '100', '300 × 50/150');
    assert.strictEqual(row.amount1, '0');
  });

  await t('a partial withdrawal that rounds to 0 bps is not sent', async () => {
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

  // ---- planner -------------------------------------------------------------------------
  const rulesSol = (over = {}) => rulesFor(deepMerge(solanaTemplate().rules, over));
  const act = (over = {}) => ({
    id: 1, target: TARGET, venue: 'meteora', kind: 'increase', tokenId: 'TPos', poolRef: POOL, token0: MEME, token1: WSOL,
    lower: -3, upper: 3, tickLower: u.binToTick(-3, BIN_STEP), tickUpper: u.binToTick(4, BIN_STEP),
    amount0: String(3n * 10n ** 9n), amount1: String(4n * 10n ** 9n),   // target deposits 3 MEME + 4 SOL = 7 SOL
    valueQuote: 7, liquidity: '100', liquidityBefore: '0', ...over,
  });
  const ctx = (store, over = {}) => ({ chain: fakeChain(store), pool: poolState(), ethUsd: 100, openExposureUsd: 0, spentTodayUsd: 0, openCount: 0, cash: null, existingUsd: null, ...over });

  await t('exact range: the target’s bins are copied as is and its X/Y composition scaled', () => {
    const store = new Store(':memory:');
    const d = planEntrySol(act(), { ...ctx(store), rules: rulesSol({ sizing: { mode: 'fixed_quote', fixed_quote_eth: 0.7, max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }) });
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.deepStrictEqual([d.plan.lower, d.plan.upper], [-3, 3]);
    // 0.7 SOL = 1/10 of the target position → 0.3 MEME + 0.4 SOL (rounded down, ≤ 1 unit)
    const near = (x, want) => { const d0 = want - BigInt(x); return d0 >= 0n && d0 <= 1n; };
    assert.ok(near(d.plan.amount0, 3n * 10n ** 8n), d.plan.amount0);
    assert.ok(near(d.plan.amount1, 4n * 10n ** 8n), d.plan.amount1);
    assert.ok(Math.abs(d.plan.valueUsd - 70) < 0.01, `valueUsd ${d.plan.valueUsd}`);
  });

  await t('mirror & pct scale the value the target added; the per-position cap trims', () => {
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

  await t('filters: disabled venue, blacklist (case-sensitive), one-sided = skip, DLMM range > 1400 bins', () => {
    const store = new Store(':memory:');
    const c = ctx(store);
    assert.match(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { venues: ['orca'] } }) }).reason, /venue meteora dimatikan/);
    assert.match(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { token_blacklist: [MEME] } }) }).reason, /daftar hitam/);
    assert.strictEqual(planEntrySol(act(), { ...c, rules: rulesSol({ filters: { token_blacklist: [MEME.toLowerCase()] } }) }).verdict, 'copy', 'lower case = a different address on Solana');
    const above = act({ lower: 5, upper: 9, tickLower: u.binToTick(5, BIN_STEP), tickUpper: u.binToTick(10, BIN_STEP), amount1: '0' });
    assert.match(planEntrySol(above, { ...c, rules: rulesSol({ onesided: { policy: 'skip' } }) }).reason, /satu sisi/);
    const wide = act({ lower: -800, upper: 800 });
    assert.match(planEntrySol(wide, { ...c, rules: rulesSol() }).reason, /1400/);
  });

  await t('cash: SOL-quoted pool, cash only in USDC → bridge room is accounted for', () => {
    const store = new Store(':memory:');
    const d = planEntrySol(act(), { ...ctx(store, { cash: { usd: 20, sol: 0 } }), rules: rulesSol({ sizing: { mode: 'mirror', max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }) });
    assert.strictEqual(d.verdict, 'copy');
    assert.ok(d.plan.valueUsd < 20 / 1.05 && d.plan.valueUsd > 17, `valueUsd ${d.plan.valueUsd}`);
    assert.match(d.reason, /kas tersedia/);
  });

  // ---- engine --------------------------------------------------------------------------
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

  await t('target withdraws 25% → our mirror withdraws 25% (bps), proceeds booked, position stays open', async () => {
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
    assert.strictEqual(p.out0, String(10n ** 9n));          // 25% of 4 MEME
    assert.strictEqual(p.out1, String(15n * 10n ** 8n));    // 25% of 6 SOL
    assert.ok(Math.abs(p.out_quote - 2.5) < 1e-6, `out_quote ${p.out_quote}`);   // 1 MEME (1 SOL) + 1.5 SOL
  });

  await t('target closes → mirror fully closed, fees counted, memecoin recorded as a leftover', async () => {
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
    assert.strictEqual(p.left_amount, String(21n * 10n ** 8n));   // 2 + 0.1 fee
    assert.ok(Math.abs(p.out_quote - 5.3) < 1e-6, `out_quote ${p.out_quote}`);   // 2.1 MEME + 3.2 SOL
  });

  await t('dry run: an entry is decided "dry" — the transaction is simulated, nothing is sent', async () => {
    const { store, eng } = engineHarness({ dry: true });
    let sendCount = 0;
    eng.exec.sendGroups = async () => { sendCount++; return { ok: true, hashes: ['X'] }; };
    eng.exec.simulateGroups = async () => ({ ok: true, cu: 12345 });
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:TPos',0,?,'meteora','increase','TPos',?,?,?,?,?,'100',?,?,7,'SOL',?)`, Date.now(), TARGET, POOL, MEME, WSOL,
    u.binToTick(-3, BIN_STEP), u.binToTick(4, BIN_STEP), String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify({ lower: -3, upper: 3, liquidityBefore: '0' }));
    await eng.handle(SolanaWatcher.actFromRow(store.get('SELECT * FROM actions')));
    const d = store.get('SELECT verdict, reason FROM decisions');
    assert.strictEqual(d.verdict, 'dry', d.reason);
    assert.match(d.reason, /simulasi OK \(12345 CU\)/);
    assert.strictEqual(sendCount, 0);
  });

  await t('simulation with a virtual balance: the entry is booked from virtual cash, synced from the books, and the target exit closes it', async () => {
    const { store, eng } = engineHarness({ dry: true });
    eng.exec.address = () => null;
    eng.cfg.mode.sim_balance_usd = 1000;
    eng.cfg.mode.sim_friction_pct = 0;
    eng.notify = () => {};
    let sendCount = 0;
    eng.exec.sendGroups = async () => { sendCount++; return { ok: true, hashes: ['X'] }; };
    const entry = (id, kind, liq, extra) => store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,?,0,?,'meteora',?,'TPos',?,?,?,?,?,?,?,?,7,'SOL',?)`, Date.now(), `s:${id}`, TARGET, kind, POOL, MEME, WSOL,
    u.binToTick(-3, BIN_STEP), u.binToTick(4, BIN_STEP), liq, String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify(extra));
    entry('in', 'increase', '100', { lower: -3, upper: 3, liquidityBefore: '0' });
    await eng.handle(SolanaWatcher.actFromRow(store.get("SELECT * FROM actions WHERE tx_hash='s:in'")));
    const d = store.get('SELECT verdict, reason FROM decisions');
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.match(d.reason, /\[simulasi\]/);
    const p = store.get('SELECT * FROM positions');
    assert.ok(p.token_id.startsWith('sim:'));
    assert.strictEqual(p.status, 'open');
    assert.ok(BigInt(p.liquidity) > 0n);
    const cash = eng.paper.cashUsd();
    assert.ok(cash < 1000 && cash > 0, `cash ${cash}`);
    // sync reads the position from the books at the pool price — never from the chain
    eng.chain.adapters.meteora.getPositions = async () => { throw new Error('a simulated position must not be read from the chain'); };
    const live = await eng.positions.sync(eng.ethUsd);
    assert.strictEqual(live.length, 1);
    assert.ok(Math.abs(live[0].valueUsd - (1000 - cash)) < 1, `value ${live[0].valueUsd} vs spent ${1000 - cash}`);
    assert.strictEqual(live[0].empty, false);
    // the target closes
    entry('out', 'decrease', '-100', { liquidityBefore: '100', gone: true });
    await eng.handle(SolanaWatcher.actFromRow(store.get("SELECT * FROM actions WHERE tx_hash='s:out'")));
    assert.strictEqual(store.get("SELECT verdict FROM decisions WHERE action_id=(SELECT id FROM actions WHERE tx_hash='s:out')").verdict, 'copy');
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
    assert.ok(Math.abs(eng.paper.cashUsd() - 1000) < 1, `cash back to about the balance (no price move, no friction): ${eng.paper.cashUsd()}`);
    assert.strictEqual(sendCount, 0, 'nothing is sent');
  });

  await t('entry leftovers: only tokens BOUGHT by this entry are sold back — the owner’s existing balance is untouched', async () => {
    const { eng, swaps } = engineHarness({ balances: new Map([[MEME, 1000n * 10n ** 9n]]) });   // the owner already holds 1000 MEME
    // the entry buys 5 MEME; after the mint the wallet holds 1002 MEME (3 went into the position)
    eng.exec.balances = async () => new Map([[MEME, 1002n * 10n ** 9n]]);
    await eng.rescueTokens(new Map([[MEME, 5n * 10n ** 9n]]), new Map([[MEME, 1000n * 10n ** 9n]]), null);
    assert.strictEqual(swaps.length, 1);
    assert.strictEqual(swaps[0].amount, 2n * 10n ** 9n, 'only the 2 MEME left over from the purchase');
    // the balance even fell below the start (used by the position) → nothing is sold
    swaps.length = 0;
    eng.exec.balances = async () => new Map([[MEME, 998n * 10n ** 9n]]);
    await eng.rescueTokens(new Map([[MEME, 5n * 10n ** 9n]]), new Map([[MEME, 1000n * 10n ** 9n]]), null);
    assert.strictEqual(swaps.length, 0);
  });

  await t('cash: native SOL + wSOL minus the reserve; USDC+USDT summed', async () => {
    const { eng, chain } = engineHarness({ balances: new Map([['SOL', 300_000_000n], [WSOL, 50_000_000n], [USDC, 12_000_000n], [chain0usdt(), 3_000_000n]]) });
    const c = await eng.spendableCash();
    assert.ok(Math.abs(c.sol - 0.25) < 1e-9, `sol ${c.sol}`);
    assert.ok(Math.abs(c.usd - 15) < 1e-9, `usd ${c.usd}`);
    const cash = await eng.refreshCash();
    assert.ok(Math.abs(cash.usd - (15 + 0.35 * 100)) < 1e-9);
    void chain;
  });

  await t('balances after a swap: wait until the bought token REALLY shows, not two identical stale reads', async () => {
    const { eng } = engineHarness();
    const reads = [new Map(), new Map(), new Map([[MEME, 5n * 10n ** 9n]])];   // two stale reads, then the fresh one
    let i = 0;
    eng.exec.balances = async () => reads[Math.min(i++, reads.length - 1)];
    const b = await eng.balancesAfter(new Map(), MEME, 5n * 10n ** 9n);
    assert.strictEqual(b.get(MEME), 5n * 10n ** 9n);
    assert.strictEqual(i, 3);
  });

  await t('entry fails midway (second swap) → tokens from the first swap are sold back, the error is still reported', async () => {
    const { eng, swaps } = engineHarness({ balances: new Map([['SOL', 2n * 10n ** 9n]]) });
    let n = 0;
    eng.swap = async (inMint, outMint, amount, o) => {
      swaps.push({ inMint, outMint, amount, kind: o.kind });
      if (++n === 2 && o.kind === 'entry_swap') throw new Error('rute tidak ada');
      return { hash: 'H' + n, out: 5n * 10n ** 9n };
    };
    // Balances follow the swaps that happened (not the call order).
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
    assert.ok(rescue, 'there is a sell-back');
    assert.strictEqual(rescue.inMint, MEME);
    assert.strictEqual(rescue.amount, 5n * 10n ** 9n);
  });

  await t('Raydium: a partial withdrawal also sends fees → fees go into proceeds; DLMM does not', async () => {
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

  await t('a sold entry leftover (rescue) is not booked to another position holding the same token', async () => {
    const { store, eng } = engineHarness();
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,liquidity,status,opened_ts,closed_ts,cost_quote,out_quote,quote_symbol,left_token,left_amount,left_quote)
      VALUES('solana','meteora','X',?,?,?,'0','closed',1,2,5,5,'SOL',?,'1000',1)`, POOL, MEME, WSOL, MEME);
    eng.swap = async () => ({ hash: 'S', out: 3n * 10n ** 6n });
    await eng.sellLeftover({ posId: null, token: MEME, amount: '400', rescue: true });
    const p = store.get('SELECT left_amount, out_quote FROM positions');
    assert.strictEqual(p.left_amount, '1000');
    assert.strictEqual(p.out_quote, 5);
  });

  await t('watcher: after a new signature, positions are re-read for ~30 s even without further signatures (lagging node)', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    let L = '100';
    chain.adapters.meteora.listPositions = async () => [{ venue: 'meteora', id: 'P1', pool: POOL, token0: MEME, token1: WSOL, lower: 0, upper: 1, tickLower: 0, tickUpper: 1, liquidity: L, amount0: 1n, amount1: 1n }];
    chain.adapters.orca.listPositions = async () => [];
    chain.adapters.raydium.listPositions = async () => [];
    let sigs = [];
    const w = new SolanaWatcher({ rpc: { run: async (fn) => fn({ getSignaturesForAddress: async () => sigs }) }, store, chain, cfg: { rules: {} }, log: () => {} });
    await w.scanTarget(TARGET);                    // first snapshot
    sigs = [{ signature: 'S1', slot: 5 }];
    assert.deepStrictEqual(await w.scanTarget(TARGET), [], 'signature visible, state not yet');
    sigs = [];
    L = '300';                                     // the new state is read later
    const acts = await w.scanTarget(TARGET);
    assert.strictEqual(acts.length, 1);
    assert.strictEqual(acts[0].kind, 'increase');
    assert.strictEqual(acts[0].delta, 200n);
  });

  await t('successful entry end-to-end: no swap → open → position booked from its actual contents', async () => {
    const got = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '777', amount0: 29n * 10n ** 8n, amount1: 39n * 10n ** 8n, fee0: 0n, fee1: 0n, tickLower: -300, tickUpper: 400, ext: { binStep: BIN_STEP } };
    const { store, eng, sent, swaps } = engineHarness({ position: got, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, tickLower: -300, tickUpper: 400,
      amount0: String(3n * 10n ** 9n), amount1: String(4n * 10n ** 9n), valueQuote: 7, quoteSymbol: 'SOL', quoteKind: 'eth', mirrorOf: 'TPos', target: TARGET };
    const r = await eng.executeEntry(plan, { target: TARGET });
    assert.strictEqual(swaps.length, 0, 'enough cash, no swap');
    assert.strictEqual(sent[0].kind, 'open');
    assert.strictEqual(sent[0].amount0, 3n * 10n ** 9n);
    const p = store.get('SELECT * FROM positions WHERE id=?', r.positionId);
    assert.strictEqual(p.token_id, 'NewPos');
    assert.strictEqual(p.cost0, String(29n * 10n ** 8n), 'capital = the position contents read, not the plan');
    assert.strictEqual(p.liquidity, '777');
    assert.ok(Math.abs(p.cost_quote - 6.8) < 1e-9, `cost_quote ${p.cost_quote}`);
    assert.strictEqual(JSON.parse(p.ext).lower, -3);
  });

  await t('entry: failed simulation (price moved) → rebuilt once; a second failure → error', async () => {
    const got = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '1', amount0: 1n, amount1: 1n, fee0: 0n, fee1: 0n, tickLower: 0, tickUpper: 1 };
    const { eng, sent } = engineHarness({ position: got, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, amount0: '1000', amount1: '1000', valueQuote: 1, quoteSymbol: 'SOL', quoteKind: 'eth' };
    let n = 0;
    eng.exec.sendGroups = async () => { if (++n === 1) throw new Error('simulasi mint gagal: {"Custom":6017}'); return { ok: true, hashes: ['H'] }; };
    await eng.executeEntry(plan, { target: TARGET });
    assert.strictEqual(sent.filter((x) => x.kind === 'open').length, 2, 'built twice');
    n = 0;
    eng.exec.sendGroups = async () => { throw new Error('simulasi mint gagal: {"Custom":6017}'); };
    await assert.rejects(eng.executeEntry(plan, { target: TARGET }), /6017/);
  });

  // ---- stage 1: engine safety ----------------------------------------------------------
  const openRow = (store, over = {}) => {
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol)
      VALUES('solana','meteora',?,?,?,?,-300,400,?,?,?,'open',?,10,'SOL')`, over.token_id || 'OurPos', POOL, MEME, WSOL, over.liquidity || '1000',
    over.target === undefined ? TARGET : over.target, over.mirror_of === undefined ? 'TPos' : over.mirror_of, over.opened_ts || Date.now() - 3600_000);
    return store.get('SELECT * FROM positions ORDER BY id DESC LIMIT 1');
  };
  const POSV = { venue: 'meteora', id: 'OurPos', pool: POOL, liquidity: '1000', amount0: 2n * 10n ** 9n, amount1: 3n * 10n ** 9n, fee0: 0n, fee1: 0n };

  await t('an exit not yet sent (failed simulation) is retried; one already sent is never sent again', async () => {
    const { store, eng } = engineHarness({ position: POSV });
    eng.exitRetryWaits = [1, 1];
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
    const row = openRow(store);
    let n = 0;
    eng.exec.sendGroups = async () => { if (++n < 3) throw new Error('simulasi burn gagal: {"Custom":1}'); return { ok: true, hashes: ['H'] }; };
    await eng.executeExitRetry({ full: true, liquidity: '1000' }, row);
    assert.strictEqual(n, 3);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
    // confirmation unreadable (timeout): NOT retried, the pending note is left for the sync
    const { store: s2, eng: e2 } = engineHarness({ position: POSV });
    const r2 = openRow(s2);
    let m = 0;
    e2.exitRetryWaits = [1, 1];
    e2.exec.sendGroups = async () => { m++; return { ok: false, hashes: ['T'], last: { timeout: true } }; };
    await assert.rejects(e2.executeExitRetry({ full: true, liquidity: '1000' }, r2));
    assert.strictEqual(m, 1);
    assert.ok(s2.getState(e2.pendingExitKey(r2.id)), 'the pending exit note is stored');
  });

  await t('pending exit: position gone on chain → booked from the contents before sending; unchanged >3 min → dropped', async () => {
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

  await t('reconciliation: the target position missing twice in a row → mirror closed (missed exit signal)', async () => {
    const { store, eng, sent } = engineHarness();
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: false } }));
    openRow(store);
    const ad = eng.chain.adapters.meteora;
    ad.getPositions = async (items) => new Map(items.map((it) => [it.id, it.id === 'TPos' ? null : POSV]));
    await eng.reconcileExits();
    assert.strictEqual(sent.length, 0, 'once is not enough');
    await eng.reconcileExits();
    assert.strictEqual(sent[0].close, true);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('an interrupted entry (process died after sending): adoption links it back to the target, not an orphan', async () => {
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

  await t('fee claim: booked to claimed_quote; the memecoin side recorded in the fee ledger then sold when asked', async () => {
    const pos = { ...POSV, fee0: 10n ** 9n, fee1: 5n * 10n ** 8n };
    const { store, eng, swaps } = engineHarness({ position: pos });
    eng.chain.adapters.meteora.buildClaim = async () => ({ groups: [{ instructions: [] }] });
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); return { hash: 'SW', out: 9n * 10n ** 8n }; };
    const row = openRow(store);
    const r = await eng.claimFees(row.id, { sell: true });
    assert.ok(r.ok);
    const p = store.get('SELECT claimed_quote FROM positions');
    // claim 1 MEME (≈1 SOL) + 0.5 SOL = 1.5; MEME sold for 0.9 SOL → the estimate is replaced by the sale: 1.4
    assert.ok(Math.abs(p.claimed_quote - 1.4) < 1e-9, `claimed ${p.claimed_quote}`);
    assert.strictEqual(swaps[0].i, MEME);
    assert.strictEqual(swaps[0].o, WSOL, 'sold to the pool’s quote asset');
    assert.strictEqual(swaps[0].amt, 10n ** 9n);
  });

  // ---- target fee harvests (exit.follow_claim) ---------------------------------------------
  await t('target harvest detected: DLMM claimable fees drop with L unchanged; CLMM checkpoint moves and owed fees reset', () => {
    const D = (fee0, fee1, L = 100) => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower: -5, upper: 5, tickLower: -500, tickUpper: 600, liquidity: String(L), amount0: '1', amount1: '1', fee0: String(fee0), fee1: String(fee1), feeMark: null });
    const C = (mark, fee0, fee1, L = 100) => ({ ...D(fee0, fee1, L), venue: 'orca', feeMark: mark });
    const acts = SolanaWatcher.diff(TARGET, {
      A: D(1000, 500), B: D(1000, 500), N: D(0, 0), X: D(1000, 500),
      O: C('1:1', 0, 0), U: C('1:1', 0, 0),
    }, {
      A: D(10, 0),          // harvested
      B: D(1200, 600),      // fees keep growing — nothing
      N: D(0, 0),           // nothing to harvest
      X: D(5, 0, 40),       // fees gone but L dropped: a withdrawal, not a claim
      O: C('9:9', 0, 0),    // checkpoint moved, owed reset to zero: claimed
      U: C('9:9', 70, 30),  // update_fees_and_rewards: checkpoint moved, fees now owed — not a claim
    });
    const by = Object.fromEntries(acts.map((a) => [a.id, a.kind]));
    assert.deepStrictEqual(by, { A: 'claim', X: 'decrease', O: 'claim' });
  });

  await t('target harvest: skipped by default; with exit.follow_claim the mirror claims too (dry run = "dry")', async () => {
    const pos = { ...POSV, fee0: 10n ** 9n, fee1: 5n * 10n ** 8n };
    const insertClaim = (store, n) => {
      store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,amount0,amount1,ext)
        VALUES('solana',?,1,?,0,?,'meteora','claim','TPos',?,?,?,'0','1000','500','{}')`, Date.now(), `s:claim${n}`, TARGET, POOL, MEME, WSOL);
      return SolanaWatcher.actFromRow(store.get('SELECT * FROM actions WHERE tx_hash=?', `s:claim${n}`));
    };
    // off (default)
    let h = engineHarness({ position: pos });
    openRow(h.store);
    await h.eng.handle(insertClaim(h.store, 1));
    assert.match(h.store.get('SELECT verdict, reason FROM decisions').reason, /klaim tidak dicermin/);
    // on: the mirror's fees are claimed
    h = engineHarness({ position: pos });
    let claimed = null;
    h.eng.claimFees = async (id, opts) => { claimed = { id, opts }; return { ok: true, tx: 'ClaimTx', claimedUsd: 150 }; };
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { follow_claim: true } }));
    const row = openRow(h.store);
    await h.eng.handle(insertClaim(h.store, 2));
    const d = h.store.get('SELECT verdict, reason, tx_hash FROM decisions');
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.strictEqual(claimed.id, row.id);
    assert.strictEqual(d.tx_hash, 'ClaimTx');
    // dry run: decided "dry", nothing claimed
    h = engineHarness({ position: pos, dry: true });
    claimed = null;
    h.eng.claimFees = async () => { claimed = true; return { ok: true }; };
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { follow_claim: true } }));
    openRow(h.store);
    await h.eng.handle(insertClaim(h.store, 3));
    assert.strictEqual(h.store.get('SELECT verdict FROM decisions').verdict, 'dry');
    assert.strictEqual(claimed, null);
  });

  await t('compound: fees claimed then added back; what went in = compound_runs, the rest = fee claim', async () => {
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
    assert.ok(Math.abs(run.reinvested_quote - 1.8) < 1e-9, `reinvested ${run.reinvested_quote}`);
    const p = store.get('SELECT claimed_quote FROM positions');
    assert.ok(Math.abs(p.claimed_quote - 0.2) < 1e-9, `left to the wallet ${p.claimed_quote}`);
    assert.strictEqual(eng.compound.status(row).supported, true);
  });

  await t('minimum pool age & SOL top-up: young pools skipped; SOL below half the reserve bought with USDC', async () => {
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

  await t('re-entry: target still in & price back near the range → a new entry is evaluated (reentry)', async () => {
    const tp = { venue: 'meteora', id: 'TPos', pool: POOL, liquidity: '100', amount0: 3n * 10n ** 9n, amount1: 4n * 10n ** 9n, fee0: 0n, fee1: 0n, tickLower: u.binToTick(-3, BIN_STEP), tickUpper: u.binToTick(4, BIN_STEP), lower: -3, upper: 3 };
    const { store, eng } = engineHarness({ dry: true, position: tp });
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { out_of_range_pct: 50, reenter_within_pct: 10 }, sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }));
    eng.exec.simulateGroups = async () => ({ ok: true, cu: 1 });
    eng.watchReentry({ target: TARGET, venue: 'meteora', tokenId: 'TPos' }, eng.rulesFrom(TARGET), { why: 'ditutup' });
    assert.strictEqual(eng.reentryWatches().length, 1);
    await eng.reentryTick();
    const a = store.get("SELECT * FROM actions WHERE kind='reentry'");
    assert.ok(a, 'a reentry action is created');
    assert.strictEqual(store.get('SELECT verdict FROM decisions WHERE action_id=?', a.id).verdict, 'dry');
    assert.strictEqual(eng.reentryWatches().length, 0);
  });

  await t('wallet sweep: non-quote tokens worth ≥ the minimum are sold; dust & quote assets left alone', async () => {
    const DUST = 'Dust111111111111111111111111111111111111111';
    const { eng, swaps } = engineHarness({ balances: new Map([['SOL', 10n ** 9n], [USDC, 10n ** 6n], [MEME, 10n ** 9n], [DUST, 1n]]), prices: { [MEME]: 5, [DUST]: 1 } });
    eng.chain.tokenCache.set(DUST, { address: DUST, symbol: 'DUST', decimals: 9 });
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); return { hash: 'SW', out: 10n ** 6n }; };
    const r = await eng.sweepWallet({ minUsd: 1 });
    assert.strictEqual(r.swept, 1);
    assert.deepStrictEqual(swaps.map((x) => x.i), [MEME]);
  });

  // ---- manual LP, swap, follow an action (solana/manual.js) -------------------------------
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

  await t('manual DLMM LP: ±% range becomes bins, token amounts from value, one-sided above price = token0 only', async () => {
    const { man } = manualHarness({ balances: new Map([['SOL', 10n ** 12n]]) });
    const r = await man.planLp({ poolRef: POOL, usd: 100, widthPct: 20 });
    assert.ok(!r.error, r.error);
    assert.ok(r.plan.lower < 0 && r.plan.upper > 0, `bin ${r.plan.lower}..${r.plan.upper} straddles the active bin`);
    assert.strictEqual(r.preview.nativeUnit, 'bin');
    assert.ok(Math.abs(r.plan.valueUsd - 100) < 1, `value $${r.plan.valueUsd}`);
    const one = await man.planLp({ poolRef: POOL, usd: 50, lowerPct: 0, upperPct: 30 });
    assert.ok(!one.error, one.error);
    assert.strictEqual(one.plan.side, 'token0_only');
    assert.ok(one.plan.lower > 0, 'the lower bound is above the active bin');
    assert.strictEqual(one.plan.amount1, '0');
    // a pool the chain does not know → a clear error
    const none = await man.planLp({ poolRef: 'not-a-pool', usd: 10 });
    assert.match(none.error, /pool tidak dikenal/);
  });

  await t('manual Orca LP: ticks rounded to spacing; the swap simulation buys the shortfall with USDC through Jupiter', async () => {
    const orca = { venue: 'orca', id: POOL, token0: MEME, token1: USDC, dec0: 9, dec1: 6,
      sqrtX96: u.sqrtX96FromPrice(100 * 1e-3), tick: Math.floor(Math.log(0.1) / Math.log(1.0001)), current: Math.floor(Math.log(0.1) / Math.log(1.0001)), spacing: 64, tickSpacing: 64, fee: 3000, liquidity: 10n ** 12n, enabled: true };
    const { man } = manualHarness({ pool: orca, balances: new Map([['SOL', 10n ** 9n], [USDC, 1_000_000_000n]]), prices: { [MEME]: 100, [WSOL]: 100, [USDC]: 1 } });
    const r = await man.planLp({ poolRef: POOL, usd: 200, widthPct: 10 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(Math.abs(r.plan.lower % 64), 0); assert.strictEqual(Math.abs(r.plan.upper % 64), 0);
    assert.strictEqual(r.preview.nativeUnit, 'tick');
    assert.strictEqual(r.preview.swaps.length, 1, 'one swap: USDC → MEME');
    assert.strictEqual(r.preview.swaps[0].dari.token, USDC);
    assert.strictEqual(r.preview.swaps[0].ke.token, MEME);
    assert.strictEqual(r.preview.swaps[0].router, 'Jupiter');
    const usdcAfter = r.preview.saldo.tokens.find((x) => x.token === USDC).after;
    assert.ok(usdcAfter > 790 && usdcAfter < 810, `USDC after ≈ 800, got ${usdcAfter}`);
  });

  await t('manual swap: custom base58 tokens stored as is; SOL = native + wSOL minus the reserve; swaps go through engine.swap', async () => {
    const { man, eng, store, swaps } = manualHarness({ balances: new Map([['SOL', 500_000_000n], [WSOL, 100_000_000n], [USDC, 5_000_000n]]) });
    const JUPM = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
    man.addCustomToken(JUPM);
    man.addCustomToken('0xe9c209fd02a1562761c99700fc3d126e64b981ee');
    assert.deepStrictEqual(man.customTokens(), [JUPM], 'case kept; EVM addresses dropped');
    const held = await man.held();
    const sol = held.find((x) => x.address === WSOL);
    assert.strictEqual(sol.raw, '600000000');
    assert.strictEqual(await man.amountRaw(WSOL, 'semua'), 500_000_000n, 'the 0.1 SOL reserve is excluded');
    assert.strictEqual(await man.amountRaw(USDC, '1.5'), 1_500_000n);
    await assert.rejects(man.amountRaw(USDC, '10'), /saldo cuma/);
    eng.swap = async (i, o, amt, opt) => { swaps.push({ i, o, amt, kind: opt.kind }); store.run("INSERT INTO txs(chain,hash,ts,kind,status) VALUES('solana','SWX',?, 'swap_manual','ok')", Date.now()); return { hash: 'SWX', out: 12_000_000n, usdOut: 12 }; };
    const r = await man.doSwap({ tokenIn: WSOL, tokenOut: USDC, amountRaw: 100_000_000n });
    assert.strictEqual(swaps[0].kind, 'swap_manual');
    assert.match(r.note, /^0\.10+ SOL → 12\.0+ USDC$/);
    assert.strictEqual(JSON.parse(store.get("SELECT detail FROM txs WHERE hash='SWX'").detail).symbolOut, 'USDC');
  });

  await t('follow an action: a skipped Solana action can be followed; exact mode uses the target’s bins as is', async () => {
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

  // ---- capital, token proceeds, depth, holders, scout -----------------------------------
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

  await t('Solana capital: USDC in from outside = deposit; SOL out by a plain transfer = withdrawal; the wallet’s trading txs skipped', async () => {
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

  await t('Solana token proceeds: out with USDC in within the same tx = sale (USD from tx balances); in from outside = supply', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const pr = new SolanaProceeds({ rpc: chain.rpc, store, chain, research: {}, log: () => {} });
    const txs = {
      sell: ptx({ keys: [key(ME, true)], programs: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'], pre: [1e9], post: [1e9 - 5000], preTok: [tb(ME, MEME, 1000), tb(ME, USDC, 0)], postTok: [tb(ME, MEME, 400), tb(ME, USDC, 7_000_000)] }),
      gift: ptx({ keys: [key('Other1111111111111111111111111111111111111', true)], programs: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'], pre: [1e9], post: [1e9], preTok: [tb(ME, MEME, 400)], postTok: [tb(ME, MEME, 900)] }),
    };
    pr.tokenAccounts = async () => [TARGET];   // any valid address: its signatures are faked
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

  await t('Solana token proceeds: a refused RPC read (429) is reported incomplete, not cached, and the window is not marked covered', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const pr = new SolanaProceeds({ rpc: chain.rpc, store, chain, research: {}, log: () => {} });
    const sale = ptx({ keys: [key(ME, true)], programs: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'], pre: [1e9], post: [1e9 - 5000], preTok: [tb(ME, MEME, 1000), tb(ME, USDC, 0)], postTok: [tb(ME, MEME, 0), tb(ME, USDC, 7_000_000)] });
    pr.tokenAccounts = async () => [TARGET];
    const scan = () => { const known = []; return pr.scanTransfers(ME, MEME, 1, 100, { ethUsd: 100, known, seenTx: new Set(), lpTx: new Set() }).then((ok) => ({ ok, known })); };

    // 1. the signature list is refused
    chain.rpc.run = async () => { throw new Error('429 Too Many Requests'); };
    assert.strictEqual((await scan()).ok, false);

    // 2. the list works but the transaction read is refused: still incomplete, nothing cached
    let refuseTx = true;
    chain.rpc.run = async (fn) => fn({
      getSignaturesForAddress: async () => [{ signature: 'sell', slot: 10 }],
      getParsedTransaction: async () => { if (refuseTx) throw new Error('429 Too Many Requests'); return sale; },
    });
    assert.strictEqual((await scan()).ok, false);

    // 3. the same window read again once the RPC answers: complete, and the sale is found
    refuseTx = false;
    const r = await scan();
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.known.map((k) => [k.tx_hash, k.tok_out, k.quote_usd]), [['sell', '1000', 7]]);
  });

  await t('trackToken keeps the scanned span unset after an incomplete scan, so the next pass reads the window again', async () => {
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    const pr = new SolanaProceeds({ rpc: chain.rpc, store, chain, research: {}, log: () => {} });
    const lots = [{ closed_block: 50, token_id: 'P1', pool_ref: POOL, wallet: ME, venue: 'meteora', outN: 10n, out0: '10', out1: '0', tracked_to: null, held_tok: '0', sold_tok: '0', s: { side: 0 } }];
    let ok = false;
    pr.receivedIn = async () => new Map();
    pr.allocate = async () => {};
    pr.scanTransfers = async () => ok;
    const key2 = `wflow_span:${pr.network}:${ME}:${MEME}`;
    await pr.trackToken(ME, MEME, lots, { head: 100, ethUsd: 100 });
    assert.strictEqual(store.getState(key2), null, 'incomplete scan: window not remembered');
    ok = true;
    await pr.trackToken(ME, MEME, lots, { head: 100, ethUsd: 100 });
    assert.deepStrictEqual(JSON.parse(store.getState(key2)), { from: 50, to: 100 });
  });

  await t('DLMM depth: bins → equivalent L; buying one full bin in the model = swapping that bin’s contents', async () => {
    const { poolDepthSol, uniformL } = require('../src/solana/pool-depth');
    const { makeCurve, buyToPrice } = await import('../web/src/liquidityRisk.mjs');
    const store = new Store(':memory:');
    const pool = poolState({ token1: USDC, dec1: 9 });
    // each bin holds 1000 tokens of Y value (bins above: X only, below: Y only, active: half)
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
    assert.ok(c, 'a curve is built');
    // from the middle of the active bin to the top of bin +5 = ½ active bin + 5 full bins ≈ 5,500 USDC (+fee)
    const target = (1 + BIN_STEP / 1e4) ** 6;
    const r = buyToPrice(c, target);
    const q = r.quote * (1 - d.buyFee);
    assert.ok(q > 5300 && q < 5700, `needs ${q.toFixed(0)} USDC`);
    assert.ok(uniformL(0n, 10n ** 9n, -100, 100, 1) > 0);
  });

  await t('Solana holders: public RPC refuses the holder list → count & top-holder share from Jupiter', async () => {
    const { solanaHolders } = require('../src/solana/holders');
    const store = new Store(':memory:');
    const chain = fakeChain(store);
    chain.jup.tokenRecord = async () => ({ holderCount: 1234, decimals: 9, audit: { topHoldersPercentage: 41.5 } });
    const r = await solanaHolders({ rpc: { run: async () => { throw new Error('403 Request blocked'); } }, chain }, 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN');
    assert.deepStrictEqual([r.error, r.holderCount, r.top10Pct, r.source, r.items.length], [undefined, 1234, 41.5, 'Jupiter', 0]);
  });

  await t('Solana scout: live positions on all venues, value & fees in USD, failed venues recorded', async () => {
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
    assert.ok(Math.abs(r.totalValueUsd - 2) < 1e-6, `value ${r.totalValueUsd}`);
    assert.ok(Math.abs(r.totalUnclaimedFeeUsd - 0.1) < 1e-6);
    assert.strictEqual(r.pairs['MEME/USDC'].n, 1);
  });

  // ---- dashboard -----------------------------------------------------------------------
  await t('Solana dashboard: base58 targets stored as is; scout, swap & wallet research available', async () => {
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
      assert.strictEqual(store.get('SELECT address FROM targets').address, TARGET, 'case unchanged');
      assert.match((await post('/api/targets', { address: '0xe9c209fd02a1562761c99700fc3d126e64b981ee' })).error, /tidak valid/);
      await post('/api/targets/toggle', { address: TARGET, enabled: false });
      assert.strictEqual(store.get('SELECT enabled FROM targets').enabled, 0, 'toggle finds the base58 address');
      // no route is closed for Solana any more
      const r = await (await fetch(`${base}/api/scout?address=${TARGET}`)).json();
      assert.strictEqual(r.unsupported, undefined);
      assert.strictEqual(r.status, 'kosong');
      const tk = await (await fetch(`${base}/api/manual/tokens`)).json();
      assert.ok(Array.isArray(tk.tokens) && tk.tokens.some((x) => x.address === WSOL && x.symbol === 'SOL'), 'the swap list includes SOL');
      assert.deepStrictEqual(await post('/api/manual/tokens/add', { address: '0xe9c209fd02a1562761c99700fc3d126e64b981ee' }), { error: 'alamat tidak valid — alamat Solana (base58, 32–44 karakter)' });
      // wallet research is supported on Solana now (not scanned yet = found:false, not an error)
      const w = await (await fetch(`${base}/api/wallet?address=${TARGET}`)).json();
      assert.strictEqual(w.found, false);
      assert.strictEqual(w.unsupported, undefined);
    } finally { await new Promise((r) => server.close(r)); }
  });

  // ---- DLMM liquidity shape (spot / curve / bid-ask) -------------------------------------
  const { dlmmShape, shapeWeight } = require('../src/solana/dlmm-shape');
  // Bins around active bin 0 whose VALUE follows `w(d)`: X side holds value / price.
  const shapedBins = (w, left = 10, right = 10, bs = BIN_STEP) => {
    const r = 1 + bs / 10_000, out = [];
    for (let k = -left; k <= right; k++) {
      if (k > 0) out.push({ binId: k, x: (1e9 * w(k)) / r ** k, y: 0 });
      else if (k < 0) out.push({ binId: k, x: 0, y: 1e9 * w(-k) });
      else out.push({ binId: 0, x: 5e8, y: 5e8 });
    }
    return out;
  };

  await t('DLMM shape: spot, curve and bid-ask are read back from per-bin value; too few bins = unknown', () => {
    assert.strictEqual(dlmmShape(shapedBins(() => 1), 0, BIN_STEP).strategy, 'spot');
    assert.ok(Math.abs(dlmmShape(shapedBins(() => 1), 0, BIN_STEP).ratio - 1) < 1e-9, 'X amounts fall with price but value stays flat');
    assert.strictEqual(dlmmShape(shapedBins((d) => 11 - d), 0, BIN_STEP).strategy, 'curve');
    assert.strictEqual(dlmmShape(shapedBins((d) => d + 1), 0, BIN_STEP).strategy, 'bidask');
    // one-sided (only above the price) still classifies
    assert.strictEqual(dlmmShape(shapedBins((d) => d + 1, 0, 12), 0, BIN_STEP).strategy, 'bidask');
    assert.strictEqual(dlmmShape(shapedBins(() => 1, 2, 2), 0, BIN_STEP), null, '2 bins per side cannot tell');
    // mainnet: a CurveImBalanced open measured 0.21; a mildly drifted spot 1.1
    assert.strictEqual(dlmmShape(shapedBins((d) => (d <= 3 ? 1 : d <= 6 ? 0.5 : 0.21), 10, 10), 0, BIN_STEP).strategy, 'curve');
    assert.strictEqual(dlmmShape(shapedBins((d) => 1 + d / 100), 0, BIN_STEP).strategy, 'spot');
  });

  await t('Meteora adapter: listed positions carry ext.strategy read from their bins', () => {
    const { MeteoraVenue } = require('../src/solana/venues/meteora');
    const bins = shapedBins((d) => d + 1).map((b) => ({ binId: b.binId, positionXAmount: String(Math.floor(b.x)), positionYAmount: String(Math.floor(b.y)), positionLiquidity: '1' }));
    const p = { publicKey: 'TPos', positionData: { positionBinData: bins, lowerBinId: -10, upperBinId: 10, totalXAmount: '1', totalYAmount: '1', owner: TARGET } };
    const v = new MeteoraVenue({ rpc: null, log: () => {} });
    assert.strictEqual(v.norm(POOL, BIN_STEP, p, 0).ext.strategy, 'bidask');
    assert.strictEqual(v.norm(POOL, BIN_STEP, p).ext.strategy, null, 'no active bin → unknown');
  });

  await t('planner: mirror follows the target shape; an explicit rule overrides it; unknown = spot; Orca has none', () => {
    const store = new Store(':memory:');
    const c = ctx(store);
    const big = { sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } };
    assert.strictEqual(rulesSol().range.dlmm_strategy, 'mirror', 'default');
    const m1 = planEntrySol(act({ ext: { strategy: 'bidask' } }), { ...c, rules: rulesSol(big) });
    assert.strictEqual(m1.plan.strategy, 'bidask');
    assert.match(m1.reason, /bid-ask/);
    assert.strictEqual(planEntrySol(act({ ext: { strategy: 'bidask' } }), { ...c, rules: rulesSol({ ...big, range: { dlmm_strategy: 'curve' } }) }).plan.strategy, 'curve');
    assert.strictEqual(planEntrySol(act(), { ...c, rules: rulesSol(big) }).plan.strategy, 'spot');
    const orcaPool = poolState({ venue: 'orca', spacing: 64, tickSpacing: 64 });
    const o = planEntrySol(act({ venue: 'orca', ext: { strategy: 'curve' }, lower: -640, upper: 640, tickLower: -640, tickUpper: 640 }),
      { ...c, pool: orcaPool, rules: rulesSol({ ...big, range: { mode: 'exact' } }) });
    assert.strictEqual(o.verdict, 'copy', o.reason);
    assert.strictEqual(o.plan.strategy, null);
    assert.doesNotMatch(o.reason, /spot|curve/);
  });

  await t('planner: the X/Y split of a non-exact DLMM range follows the shape', () => {
    const { share0 } = require('../src/solana/planner');
    const pool = poolState();
    // symmetric around the active bin: half and half whatever the shape
    for (const s of ['spot', 'curve', 'bidask']) assert.ok(Math.abs(share0('meteora', pool, 0, 0, -5, 5, s) - 0.5) < 1e-9, s);
    // more bins above the price: bid-ask weighs the far (X-only) bins most, curve least
    const [sp, cu, ba] = ['spot', 'curve', 'bidask'].map((s) => share0('meteora', pool, 0, 0, -3, 9, s));
    assert.ok(Math.abs(sp - 9.5 / 13) < 1e-9, `spot ${sp}`);
    assert.ok(cu < sp && sp < ba, `curve ${cu} < spot ${sp} < bid-ask ${ba}`);
    assert.strictEqual(shapeWeight('spot', 4, 9), 1);
  });

  await t('rules: dlmm_strategy accepts mirror/spot/curve/bidask only', () => {
    const { validateRules } = require('../src/policy');
    assert.strictEqual(validateRules({ range: { dlmm_strategy: 'bidask' } }).rules.range.dlmm_strategy, 'bidask');
    assert.match(validateRules({ range: { dlmm_strategy: 'wave' } }).error, /dlmm_strategy/);
    assert.strictEqual(rulesFor({ range: { dlmm_strategy: 'wave' } }).range.dlmm_strategy, 'mirror', 'a broken config value falls back to the default');
  });

  await t('engine: the plan strategy reaches the open (live & simulated), is stored on the position, and compound reuses it', async () => {
    const got = { venue: 'meteora', id: 'NewPos', pool: POOL, liquidity: '777', amount0: 29n * 10n ** 8n, amount1: 39n * 10n ** 8n, fee0: 0n, fee1: 0n, tickLower: -300, tickUpper: 400, ext: { binStep: BIN_STEP, strategy: 'spot' } };
    const { store, eng, sent } = engineHarness({ position: got, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    const plan = { venue: 'meteora', action: 'mint', poolRef: POOL, token0: MEME, token1: WSOL, lower: -3, upper: 3, tickLower: -300, tickUpper: 400, strategy: 'curve',
      amount0: String(3n * 10n ** 9n), amount1: String(4n * 10n ** 9n), valueQuote: 7, quoteSymbol: 'SOL', quoteKind: 'eth', mirrorOf: 'TPos', target: TARGET };
    const r = await eng.executeEntry(plan, { target: TARGET });
    assert.strictEqual(sent[0].strategy, 'curve');
    const row = store.get('SELECT * FROM positions WHERE id=?', r.positionId);
    assert.strictEqual(JSON.parse(row.ext).strategy, 'curve', 'intended shape wins over the read-back one');
    // compound adds the fees in the same shape
    const ad = eng.chain.adapters.meteora;
    let reads = 0;
    ad.getPositions = async (items) => new Map(items.map((it) => [it.id, reads++ === 0 ? { ...got, fee0: 10n ** 9n, fee1: 10n ** 9n } : got]));
    ad.buildClaim = async () => ({ groups: [{ instructions: [] }] });
    ad.buildIncrease = async (p) => { ad.inc = p; return { groups: [{ instructions: [] }] }; };
    eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6 } }));
    eng.compound.configure(row.id, { enabled: true, mode: 'compound', minUsd: 1, intervalMinutes: 5 });
    await eng.compound.runCompound(row, eng.compound.status(row));
    assert.strictEqual(ad.inc.strategy, 'curve');
    // dry run with a wallet: the simulated open uses the target's shape
    const h = engineHarness({ dry: true });
    h.eng.exec.simulateGroups = async () => ({ ok: true, cu: 1 });
    h.store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:TPos',0,?,'meteora','increase','TPos',?,?,?,?,?,'100',?,?,7,'SOL',?)`, Date.now(), TARGET, POOL, MEME, WSOL,
    u.binToTick(-3, BIN_STEP), u.binToTick(4, BIN_STEP), String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify({ lower: -3, upper: 3, liquidityBefore: '0', strategy: 'bidask' }));
    await h.eng.handle(SolanaWatcher.actFromRow(h.store.get('SELECT * FROM actions')));
    const d = h.store.get('SELECT verdict, reason, plan FROM decisions');
    assert.strictEqual(d.verdict, 'dry', d.reason);
    assert.strictEqual(h.sent[0].strategy, 'bidask');
    assert.strictEqual(JSON.parse(d.plan).strategy, 'bidask');
  });

  await t('manual LP & follow: shape choice for DLMM (rules "mirror" = spot for a manual LP; follow uses the target shape)', async () => {
    const { man, store, eng } = manualHarness({ balances: new Map([['SOL', 10n ** 12n]]) });
    eng.targetLiquidity = async () => ({ liquidity: 100n });
    const a = await man.planLp({ poolRef: POOL, usd: 100, widthPct: 20 });
    assert.strictEqual(a.plan.strategy, 'spot');
    assert.strictEqual(a.preview.strategy, 'spot');
    const b = await man.planLp({ poolRef: POOL, usd: 100, widthPct: 20, strategy: 'bidask' });
    assert.strictEqual(b.plan.strategy, 'bidask');
    assert.match((await man.planLp({ poolRef: POOL, usd: 100, strategy: 'wave' })).error, /strategi/);
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext)
      VALUES('solana',?,1,'s:F',0,?,'meteora','increase','TPosF',?,?,?,?,?,'100',?,?,7,'SOL',?)`, Date.now(), TARGET, POOL, MEME, WSOL,
    u.binToTick(-3, BIN_STEP), u.binToTick(4, BIN_STEP), String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify({ lower: -3, upper: 3, liquidityBefore: '0', strategy: 'curve' }));
    const aid = store.get("SELECT id FROM actions WHERE tx_hash='s:F'").id;
    store.run("INSERT INTO decisions(action_id,ts,verdict,reason) VALUES(?,?,'skip','test')", aid, Date.now());
    const f = await man.planFollow({ actionId: aid, usd: 20 });
    assert.ok(!f.error, f.error);
    assert.strictEqual(f.plan.strategy, 'curve');
  });

  await t('equity sizing: the target’s share of its equity × our equity; unknown equity → pct or skip', () => {
    const store = new Store(':memory:');
    const big = { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 };
    // target adds 7 SOL = $700 out of $7,000 equity (10%) → 10% of our $500 = $50
    const r = (sz) => rulesSol({ sizing: { mode: 'equity', pct: 20, ...big, ...sz } });
    const d = planEntrySol(act(), { ...ctx(store), rules: r({}), targetEquityUsd: 7000, ourEquityUsd: 500, ourCashUsd: 200 });
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.ok(Math.abs(d.plan.valueUsd - 50) < 0.5, `valueUsd ${d.plan.valueUsd}`);
    assert.match(d.reason, /equity: target 10\.0%/);
    // cash basis and the share cap
    const c = planEntrySol(act(), { ...ctx(store), rules: r({ equity_our_basis: 'cash', equity_max_pct: 5 }), targetEquityUsd: 7000, ourEquityUsd: 500, ourCashUsd: 200 });
    assert.ok(Math.abs(c.plan.valueUsd - 10) < 0.5, `5% of $200 cash, got ${c.plan.valueUsd}`);
    // target equity unknown → pct (20% of $700 = $140), or skipped
    const f = planEntrySol(act(), { ...ctx(store), rules: r({}), targetEquityUsd: null, ourEquityUsd: 500 });
    assert.ok(Math.abs(f.plan.valueUsd - 140) < 0.5, `pct fallback, got ${f.plan.valueUsd}`);
    assert.match(f.reason, /equity target tidak terbaca → pct 20%/);
    assert.match(planEntrySol(act(), { ...ctx(store), rules: r({ equity_fallback: 'skip' }), targetEquityUsd: null, ourEquityUsd: 500 }).reason, /dilewati/);
    // a manual target equity replaces the on-chain read
    assert.ok(Math.abs(planEntrySol(act(), { ...ctx(store), rules: r({ equity_target_usd: 3500 }), targetEquityUsd: null, ourEquityUsd: 500 }).plan.valueUsd - 100) < 0.5);
  });

  await t('equity sizing (engine): target equity = quote cash + researched open LP + an uncovered action; never researched → asks for research', async () => {
    const { eng, store } = engineHarness();
    const asked = [];
    eng.onResearchNeeded = (w, mode) => asked.push([w, mode]);
    const a = { target: TARGET, venue: 'meteora', tokenId: 'TPos', token0: MEME, token1: WSOL, block: 500, valueQuote: 7 };
    assert.strictEqual(await eng.targetEquity(a), null);
    assert.deepStrictEqual(asked, [[TARGET, 'full']]);
    store.run('INSERT INTO wallets(chain,address,first_block,scanned_to,last_scan_ts,stats,positions_n) VALUES(?,?,?,?,?,?,?)', 'solana', TARGET, 1, 400, Date.now(), '{}', 1);
    store.run(`INSERT INTO wpositions(chain,wallet,venue,token_id,pool_ref,token0,token1,status,live_value_q,live_fee_q)
      VALUES('solana',?,'meteora','Other',?,?,?,'open',300,20)`, TARGET, POOL, MEME, WSOL);
    eng.holdings = { of: async () => [
      { address: WSOL, isQuote: true, amount: 2 },                      // 2 SOL × $100
      { address: USDC, isQuote: true, amount: 50 },
      { address: MEME, isQuote: false, amount: 1e6 },                   // memecoins not counted
    ] };
    eng.research = { refreshOpen: async () => {} };
    // $200 + $50 cash + $320 LP + this $700 action (the research stopped at slot 400 < 500)
    assert.ok(Math.abs(await eng.targetEquity(a) - 1270) < 1e-6);
    const s = await eng.sizingEquity(a, { exposureUsd: 100, leftoverUsd: 5, feeUsd: 3 }, { usd: 40, sol: 1 }, rulesFor({ sizing: { mode: 'equity' } }));
    assert.strictEqual(s.ourCashUsd, 140);
    assert.strictEqual(s.ourEquityUsd, 248);
  });

  await t('scan watchdog: a tick stuck past the limit is released and reported; the next scan records lastScanAt', async () => {
    const { eng, store } = engineHarness();
    eng.cfg.loop = { tick_stuck_seconds: 1 };
    let hang = true;
    eng.rpc.slot = async () => 5;
    eng.watcher.scan = async () => { if (hang) await new Promise(() => {}); return []; };
    eng.watcher.persist = async () => [];
    const first = eng.tick();                      // never finishes
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(eng.lastScanAt, 0);
    eng.busySince = Date.now() - 5000;             // pretend it has hung for 5 s
    await eng.tick();                              // busy → unwedge
    assert.strictEqual(eng.busy, false, 'released');
    assert.match(store.get("SELECT msg FROM logs WHERE msg LIKE 'pemindaian macet%'")?.msg || '', /macet/);
    hang = false;
    await eng.tick();
    assert.ok(eng.lastScanAt > 0, 'a successful scan is recorded');
    void first;
  });

  // ---- target range shift (Meteora rebalance_liquidity) & per-bin mirror ---------------
  await t('snapshot diff: same position over new bins = rebalance (not a withdrawal); fees claimed with it = claim too', () => {
    const R = (lower, upper, L, fee0 = '0', fee1 = '0') => ({ venue: 'meteora', pool: POOL, token0: MEME, token1: WSOL, lower, upper, tickLower: lower * 100, tickUpper: (upper + 1) * 100, liquidity: String(L), amount0: '1', amount1: '1', fee0, fee1, feeMark: null });
    const acts = SolanaWatcher.diff(TARGET, { A: R(-5, 5, 100), B: R(-5, 5, 100, '900', '50') }, { A: R(-2, 8, 140), B: R(0, 10, 90, '0', '0') });
    assert.deepStrictEqual(acts.map((a) => `${a.id}:${a.kind}`), ['A:rebalance', 'B:rebalance', 'B:claim']);
  });

  await t('per-bin weights: X above the active bin, Y below, half each in it; each side sums to 10000 bps', () => {
    const { binWeights, weightDistribution, weightShare0 } = require('../src/solana/dlmm-shape');
    // a bid-ask-like custom shape: heavy at the far edges, 5 bins around active 0, binStep 100
    const w = binWeights([{ binId: -2, y: 400 }, { binId: -1, y: 100 }, { binId: 0, x: 50, y: 50 }, { binId: 1, x: 100 / 1.01 }, { binId: 2, x: 400 / 1.01 ** 2 }], -2, 2, 100);
    assert.deepStrictEqual(w.map((x) => Math.round(x / 655.35)), [100, 25, 25, 25, 100]);
    const d = weightDistribution(w, -2, 0, 100);
    assert.deepStrictEqual(d.map((b) => b.binId), [-2, -1, 0, 1, 2]);
    assert.strictEqual(d.reduce((s, b) => s + b.x, 0), 10000);
    assert.strictEqual(d.reduce((s, b) => s + b.y, 0), 10000);
    assert.deepStrictEqual([d[0].x, d[1].x, d[3].y, d[4].y], [0, 0, 0, 0]);
    assert.ok(d[0].y > 3 * d[1].y, 'the far bin keeps its weight');
    assert.ok(Math.abs(weightShare0(w, -2, 0) - 0.5) < 1e-9);
  });

  await t('dlmm_strategy mirror on the target’s own bins: its per-bin weights are copied; other rules or ranges use a preset', () => {
    const store = new Store(':memory:');
    const weights = [65535, 30000, 10000, 5000, 10000, 30000, 65535];
    const sizing = { mode: 'fixed_quote', fixed_quote_eth: 0.7, max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 };
    const a = act({ ext: { strategy: 'bidask', weights } });
    let d = planEntrySol(a, { ...ctx(store), rules: rulesSol({ sizing, range: { dlmm_strategy: 'mirror' } }) });
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.deepStrictEqual(d.plan.weights, weights);
    assert.match(d.reason, /bentuk per-bin target/);
    d = planEntrySol(a, { ...ctx(store), rules: rulesSol({ sizing, range: { dlmm_strategy: 'spot' } }) });
    assert.strictEqual(d.plan.weights, null);
    d = planEntrySol(a, { ...ctx(store), rules: rulesSol({ sizing, range: { dlmm_strategy: 'mirror', mode: 'width_pct', width_pct: 10 } }) });
    assert.strictEqual(d.plan.weights, null, 'a different range cannot take the target’s bins');
    assert.strictEqual(d.plan.strategy, 'bidask');
  });

  const insertRebalance = (store, n = 1) => {
    store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,liquidity,amount0,amount1,ext)
      VALUES('solana',?,1,?,0,?,'meteora','rebalance','TPos',?,?,?,'0',?,?,?)`, Date.now(), `s:reb${n}`, TARGET, POOL, MEME, WSOL,
    String(3n * 10n ** 9n), String(4n * 10n ** 9n), JSON.stringify({ lower: -2, upper: 4, prevLower: -3, prevUpper: 3, liquidityBefore: '100', binStep: BIN_STEP }));
    return SolanaWatcher.actFromRow(store.get('SELECT * FROM actions WHERE tx_hash=?', `s:reb${n}`));
  };

  await t('target rebalance, mirror still in range: not moved by default (out_of_range); off = skipped; no mirror = skipped', async () => {
    let h = engineHarness({ position: POSV });
    openRow(h.store);
    await h.eng.handle(insertRebalance(h.store));
    let d = h.store.get('SELECT verdict, reason FROM decisions');
    assert.strictEqual(d.verdict, 'skip');
    assert.match(d.reason, /masih di dalam rentangnya/);
    assert.strictEqual(h.sent.length, 0);
    h = engineHarness({ position: POSV });
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { range: { follow_rebalance: 'off' } }));
    openRow(h.store);
    await h.eng.handle(insertRebalance(h.store));
    assert.match(h.store.get('SELECT reason FROM decisions').reason, /dimatikan/);
    h = engineHarness({ position: POSV });
    await h.eng.handle(insertRebalance(h.store));
    assert.match(h.store.get('SELECT reason FROM decisions').reason, /tidak punya cermin/);
  });

  await t('target rebalance, out of range (or always): mirror closed and reopened over the new bins with what came back, memecoin not sold', async () => {
    const got = { ...POSV, id: 'NewPos', liquidity: '900', tickLower: -200, tickUpper: 500, ext: { binStep: BIN_STEP } };
    const h = engineHarness({ position: POSV, balances: new Map([['SOL', 10n * 10n ** 9n], [MEME, 10n * 10n ** 9n]]) });
    h.chain.adapters.meteora.getPositions = async (items) => new Map(items.map((it) => [it.id, it.id === 'NewPos' ? got : POSV]));
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { exit: { sell_leftover: true }, range: { follow_rebalance: 'always' }, sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6, daily_budget_usd: 1e6 } }));
    const sold = [];
    h.eng.sellLeftover = async (x) => { sold.push(x); };
    const old = openRow(h.store);
    await h.eng.handle(insertRebalance(h.store));
    const d = h.store.get('SELECT verdict, reason, position_id FROM decisions');
    assert.strictEqual(d.verdict, 'copy', d.reason);
    assert.match(d.reason, /dipindah →/);
    assert.deepStrictEqual(h.sent.map((x) => x.kind), ['decrease', 'open']);
    assert.strictEqual(h.sent[0].close, true);
    assert.deepStrictEqual([h.sent[1].lower, h.sent[1].upper], [-2, 4]);
    const o = h.store.get('SELECT * FROM positions WHERE id=?', old.id);
    assert.strictEqual(o.status, 'closed');
    assert.strictEqual(o.left_token, null, 'redeposited, not a leftover');
    assert.strictEqual(sold.length, 0);
    const n = h.store.get("SELECT * FROM positions WHERE status='open'");
    assert.strictEqual(n.token_id, 'NewPos');
    assert.strictEqual(n.mirror_of, 'TPos');
    // sized at what the close returned: 2 MEME (=2 SOL) + 3 SOL = 5 SOL, ±rounding
    const gap = h.sent[1].amount0 + h.sent[1].amount1 - 5n * 10n ** 9n;
    assert.ok((gap < 0n ? -gap : gap) < 10n ** 7n, `${h.sent[1].amount0} + ${h.sent[1].amount1}`);
  });

  await t('target rebalance in a dry run: decided "dry", nothing sent', async () => {
    const h = engineHarness({ position: POSV, dry: true });
    h.eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { range: { follow_rebalance: 'always' } }));
    openRow(h.store);
    await h.eng.handle(insertRebalance(h.store));
    assert.strictEqual(h.store.get('SELECT verdict FROM decisions').verdict, 'dry');
    assert.strictEqual(h.sent.length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

function chain0usdt() { return require('../src/networks').build('solana').ADDR.usdt; }
