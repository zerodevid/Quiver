'use strict';
// Meteora DAMM v2 and creating Solana pools from manual LP: the adapter's pool/position math
// against the SDK, the planner using the pool's own range, the create specs (DAMM v2 pool
// address & starting price, DLMM preset & starting bin, existing pools refused), the create
// spec reaching the venue builder, and DAMM v2 staying out of copy watching by default.
// Run: node test/solana-damm.js
const assert = require('node:assert');
const { PublicKey } = require('@solana/web3.js');
const BN = require('bn.js');
const D = require('@meteora-ag/cp-amm-sdk');
const m = require('../src/v3math');
const u = require('../src/solana/units');
const { Store } = require('../src/db');
const { WSOL } = require('../src/networks');
const { SolanaChain } = require('../src/solana/chain');
const { SolanaEngine } = require('../src/solana/engine');
const { SolanaWatcher } = require('../src/solana/watcher');
const { SolanaManual } = require('../src/solana/manual');
const { DammV2Venue, tickOf } = require('../src/solana/venues/dammv2');
const { rulesFor, deepMerge } = require('../src/policy');
const { solanaTemplate } = require('../src/multichain');

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'METvsvVRapdj9cFLzq4Tr43xK4tAjQfwX76z3n6mWQL';
const ME = 'Me11111111111111111111111111111111111111111';
const POOL = 'BnztueWcXv93mgW7yJe8WYpnCxpz34nujPhfjQT6SLu1';

const tests = [];
const test = (n, f) => tests.push([n, f]);

// A decoded DAMM v2 pool (the MET/USDC pool read on mainnet 2026-10-15): 1% base fee, price
// ≈ 0.366 USDC per MET, concentrated range 0.025–10.
const rawPool = (over = {}) => ({
  tokenAMint: new PublicKey(MEME), tokenBMint: new PublicKey(USDC),
  sqrtPrice: new BN('11171455369164270257'), sqrtMinPrice: new BN('2916686334356757942'), sqrtMaxPrice: new BN('58333726687135158849'),
  liquidity: new BN('63701525037427006751375683897058'), tokenAAmount: new BN('4610150182268'), tokenBAmount: new BN('1545309017272'),
  collectFeeMode: 1, poolStatus: 0, activationType: 1,
  poolFees: { baseFee: { baseFeeInfo: { data: [128, 150, 152, ...Array(29).fill(0)] } }, dynamicFee: { initialized: 1 } },
  ...over,
});

test('pool state: Q64 sqrt → Q96 and ticks, the 1% fee, the pool range, Uniswap-equivalent L', () => {
  const ad = new DammV2Venue({ rpc: null });
  const st = ad.poolState(POOL, rawPool(), new Map([[MEME, 6], [USDC, 6]]));
  assert.strictEqual(st.venue, 'dammv2');
  assert.strictEqual(st.sqrtX96, BigInt('11171455369164270257') << 32n);
  const p = u.priceFromSqrtX96(st.sqrtX96, 6, 6);
  assert.ok(Math.abs(p - 0.3667) < 0.001, `price ${p}`);
  assert.ok(Math.abs(1.0001 ** st.tick / p - 1) < 0.0002, 'tick matches the price');
  assert.strictEqual(st.fee, 10_000, '1% in 1e-6 units');
  assert.ok(st.rangeLower < st.tick && st.tick < st.rangeUpper);
  assert.ok(Math.abs(1.0001 ** st.rangeLower / 0.025 - 1) < 0.001 && Math.abs(1.0001 ** st.rangeUpper / 10 - 1) < 0.001);
  assert.strictEqual(st.liquidity, BigInt('63701525037427006751375683897058') >> 64n);
  assert.strictEqual(ad.nativeRange(st, -5, 5).lower, st.rangeLower, 'a requested range is ignored');
});

test('position amounts = the v3 formula over the pool range with L >> 64; compounding = pro-rata reserves', () => {
  const d = rawPool();
  const L = 6549731246996024249305000000n;
  const a = DammV2Venue.amountsOf(d, L);
  const v3 = m.amountsForLiquidity(BigInt(d.sqrtPrice.toString()) << 32n, BigInt(d.sqrtMinPrice.toString()) << 32n, BigInt(d.sqrtMaxPrice.toString()) << 32n, L >> 64n);
  for (const k of ['amount0', 'amount1']) assert.ok(Math.abs(Number(a[k] - v3[k])) <= 2, `${k}: ${a[k]} vs ${v3[k]}`);
  assert.ok(a.amount0 > 470_000_000n && a.amount1 > 150_000_000n, 'about 474 MET + 159 USDC, as read on mainnet');
  const c = rawPool({ collectFeeMode: 2, liquidity: new BN(1000), tokenAAmount: new BN(5000), tokenBAmount: new BN(2000) });
  assert.deepStrictEqual(DammV2Venue.amountsOf(c, 100n), { amount0: 500n, amount1: 200n });
  assert.strictEqual(DammV2Venue.lv3(c, 100n), (100n * 3162n) / 1000n, 'sqrt(5000·2000) = 3162');
});

// ---- the chain / engine / manual harness --------------------------------------------------
function harness({ state, balances = new Map([['SOL', 10n ** 12n], [USDC, 10n ** 12n], [MEME, 10n ** 15n]]), rpcAccounts = {} } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    run: async (fn) => fn({
      getAccountInfo: async (k) => rpcAccounts[k.toBase58()] || null,
      getMultipleAccountsInfo: async (ks) => ks.map((k) => rpcAccounts[k.toBase58()] || null),
    }),
    primary: () => null, slot: async () => 1, allCooling: () => false, stats: () => [],
  };
  const prices = { [MEME]: 0.366, [WSOL]: 100, [USDC]: 1 };
  const jup = { prices: async (ms) => new Map(ms.filter((x) => prices[x] != null).map((x) => [x, prices[x]])), tokenInfo: async () => new Map() };
  const noMeteora = { pool: async () => null, pools: async () => ({ total: 0, pools: [] }), ohlcv: async () => null };
  const chain = new SolanaChain(rpc, store, () => {}, 'solana', { jupiter: jup, meteoraApi: noMeteora });
  chain.tokenCache.set(MEME, { address: MEME, symbol: 'MET', name: 'Meteora', decimals: 6 });
  if (state) {
    chain.pools = async (venue, addrs) => new Map(addrs.map((a) => [a, { ...state, id: a }]));
    chain.pool = async (venue, a) => ({ ...state, id: a });
    chain.venueOfPool = async () => state.venue;
    chain.rememberPool({ ...state, id: state.id || POOL });
  }
  const cfg = { mode: { dry_run: false }, rules: solanaTemplate().rules, gas: { native_reserve_lamports: 100_000_000 }, loop: {}, prices: { auto_eth_price: false, eth_usd: 100 }, notify: {}, wallet: {} };
  const eng = new SolanaEngine({ rpc, store, chain, cfg, log: () => {} });
  eng.ethUsd = 100;
  eng.exec.address = () => ME;
  eng.exec.balances = async () => new Map(balances);
  eng.exec.gasReserveCached = () => 100_000_000n;
  eng.rulesFrom = () => rulesFor(deepMerge(solanaTemplate().rules, { sizing: { max_quote_per_position_usd: 1e6, max_total_exposure_usd: 1e6 } }));
  const man = new SolanaManual({ engine: eng, store, chain, rpc, log: () => {} });
  return { store, chain, eng, man };
}

test('manual DAMM v2 LP: the pool range is used whatever was asked; the value split follows it', async () => {
  const st = { ...new DammV2Venue({ rpc: null }).poolState(POOL, rawPool(), new Map([[MEME, 6], [USDC, 6]])), id: POOL };
  const { man } = harness({ state: st });
  const r = await man.planLp({ poolRef: POOL, usd: 100, lowerPct: 5, upperPct: 5 });
  assert.ok(!r.error, r.error);
  assert.deepStrictEqual([r.plan.lower, r.plan.upper], [st.rangeLower, st.rangeUpper]);
  assert.strictEqual(r.plan.side, 'both');
  assert.strictEqual(r.preview.fixedRange, true);
  assert.ok(Math.abs(r.plan.valueUsd - 100) < 1, `value $${r.plan.valueUsd}`);
  // The token split is the one the pool needs: MET value / USDC value as in a live position.
  const v0 = Number(r.plan.amount0) / 1e6 * 0.3667, v1 = Number(r.plan.amount1) / 1e6;
  const live = (474.571081 * 0.3667) / 158.682117;
  assert.ok(Math.abs(v0 / v1 / live - 1) < 0.01, `split ${v0 / v1} vs ${live}`);
});

test('create DAMM v2: pool address from the two mints, starting price kept, fee checked, existing pool refused', async () => {
  const { man } = harness();
  const s = await man.createSpec({ venue: 'dammv2', token: MEME, quote: USDC, fee: 10_000, price: 0.42 });
  assert.ok(!s.error, s.error);
  assert.strictEqual(s.pool.poolRef, D.deriveCustomizablePoolAddress(new PublicKey(MEME), new PublicKey(USDC)).toBase58());
  assert.deepStrictEqual([s.pool.token0, s.pool.token1], [MEME, USDC], 'token = A, quote = B');
  const px = Number(D.getPriceFromSqrtPrice(new BN(s.create.sqrtQ64), 6, 6));
  assert.ok(Math.abs(px / 0.42 - 1) < 1e-9, `start ${px}`);
  assert.strictEqual(s.create.feeBps, 100);
  assert.ok(Math.abs(u.priceFromSqrtX96(s.state.sqrtX96, 6, 6) / 0.42 - 1) < 1e-9, 'the planning state starts there too');
  assert.match((await man.createSpec({ venue: 'dammv2', token: MEME, quote: USDC, fee: 150, price: 1 })).error, /kelipatan 0,01%/);
  assert.match((await man.createSpec({ venue: 'dammv2', token: USDC, quote: WSOL, fee: 10_000, price: 1 })).error, /bukan aset kuotasi/);
  assert.match((await man.createSpec({ venue: 'dammv2', token: MEME, quote: MEME, fee: 10_000, price: 1 })).error, /kuotasi/);
  const taken = harness({ rpcAccounts: { [s.pool.poolRef]: { owner: new PublicKey(D.CP_AMM_PROGRAM_ID) } } });
  assert.match((await taken.man.createSpec({ venue: 'dammv2', token: MEME, quote: USDC, fee: 10_000, price: 0.42 })).error, /sudah ada/);
});

test('create DAMM v2 plan: full range, half the value each side, and the create spec rides on the plan', async () => {
  const { man } = harness();
  const d = await man.planCreate({ venue: 'dammv2', token: MEME, quote: USDC, fee: 10_000, price: 0.42, usd: 50 });
  assert.ok(!d.error, d.error);
  assert.strictEqual(d.plan.venue, 'dammv2');
  assert.strictEqual(d.plan.create.tokenA, MEME);
  assert.strictEqual(d.plan.poolRef, d.preview.create.poolRef);
  const v0 = Number(d.plan.amount0) / 1e6 * 0.42, v1 = Number(d.plan.amount1) / 1e6;
  assert.ok(Math.abs(v0 / v1 - 1) < 0.01, `full range splits value evenly (${v0} / ${v1})`);
  assert.match(d.warnings[0], /LP pertama/);
  // L for those amounts at the starting price uses (almost) all of both
  const L = DammV2Venue.createLiquidity(BigInt(d.plan.create.sqrtQ64), d.plan.amount0, d.plan.amount1);
  const need = DammV2Venue.amountsOf({ ...rawPool(), sqrtPrice: new BN(d.plan.create.sqrtQ64), sqrtMinPrice: D.MIN_SQRT_PRICE, sqrtMaxPrice: D.MAX_SQRT_PRICE, collectFeeMode: 1 }, BigInt(L.toString()));
  assert.ok(need.amount0 <= BigInt(d.plan.amount0) && need.amount1 <= BigInt(d.plan.amount1));
  assert.ok(Number(need.amount0) / Number(d.plan.amount0) > 0.99 && Number(need.amount1) / Number(d.plan.amount1) > 0.99);
});

test('create DLMM: preset must exist, the starting bin comes from the price, an existing pair is refused', async () => {
  const { man, chain } = harness();
  const ad = chain.adapter('meteora');
  ad.presets = async () => [{ key: '11111111111111111111111111111111', binStep: 80, baseFactor: 6250, pow: 0, index: 1, fee: 5000 }];
  let existing = null;
  ad.pairFor = async () => ({ pool: 'NewPair11111111111111111111111111111111111', existing });
  const s = await man.createSpec({ venue: 'meteora', token: MEME, quote: USDC, fee: 5000, binStep: 80, price: 0.42 });
  assert.ok(!s.error, s.error);
  const want = Math.round(Math.log(0.42) / Math.log(1.008));
  assert.strictEqual(s.init.activeId, want);
  assert.strictEqual(s.state.current, want);
  assert.ok(Math.abs(s.init.price / 0.42 - 1) < 0.004 + 1e-9, 'within half a bin of the asked price');
  assert.strictEqual(s.create, null, 'DLMM is created by its own transaction first');
  assert.match((await man.createSpec({ venue: 'meteora', token: MEME, quote: USDC, fee: 3000, binStep: 80, price: 0.42 })).error, /preset/);
  existing = 'Old11111111111111111111111111111111111111';
  assert.match((await man.createSpec({ venue: 'meteora', token: MEME, quote: USDC, fee: 5000, binStep: 80, price: 0.42 })).error, /sudah ada/);
  const venues = await man.createVenues();
  assert.deepStrictEqual(venues.map((v) => v.key), ['dammv2', 'meteora']);
  assert.deepStrictEqual(venues[1].presets, [{ binStep: 80, fee: 5000 }]);
});

test('the create spec reaches the venue builder (DAMM v2 pool + position in one transaction)', async () => {
  const { man, eng, chain } = harness();
  const d = await man.planCreate({ venue: 'dammv2', token: MEME, quote: USDC, fee: 10_000, price: 0.42, usd: 50 });
  assert.ok(!d.error, d.error);
  let got = null;
  chain.adapters.dammv2.buildOpen = async (p) => { got = p; throw new Error('BUILT'); };
  eng.rescueTokens = async () => {};
  await assert.rejects(eng.executeEntry(d.plan, { target: null }), /BUILT/);
  assert.deepStrictEqual(got.create, d.plan.create);
  assert.strictEqual(got.pool, d.plan.poolRef);
});

test('copy watching skips DAMM v2 unless the rules list it', () => {
  const chain = { adapters: { meteora: {}, orca: {}, raydium: {}, dammv2: { copy: false } } };
  const w = Object.create(SolanaWatcher.prototype);
  w.chain = chain;
  w.cfg = { rules: { filters: { venues: [] } } };
  assert.deepStrictEqual(w.venuesOn(), ['meteora', 'orca', 'raydium']);
  w.cfg = { rules: { filters: { venues: ['meteora', 'dammv2'] } } };
  assert.deepStrictEqual(w.venuesOn(), ['meteora', 'dammv2']);
});

test('tickOf clamps the full-range bounds inside the Uniswap tick range', () => {
  const lo = tickOf(D.MIN_SQRT_PRICE), hi = tickOf(D.MAX_SQRT_PRICE);
  assert.ok(lo >= m.MIN_TICK && hi <= m.MAX_TICK && lo < -440_000 && hi > 440_000, `${lo}..${hi}`);
});

(async () => {
  let ok = 0, bad = 0;
  for (const [n, f] of tests) {
    try { await f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.stack.split('\n').slice(0, 4).join('\n      ')); }
  }
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
