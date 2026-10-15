'use strict';
// Creating a v3/v4 pool from manual LP: the pool spec (ordering, starting price, existing
// pool refused), the v4 mint wrapped with initializePool in one multicall, and the entry's
// guard on the starting price.
// Run: node test/create-pool.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Manual } = require('../src/manual');
const { Engine } = require('../src/engine');
const { Executor } = require('../src/executor');
const { ABI } = require('../src/chain');
const m = require('../src/v3math');

const IF = new ethers.Interface(ABI.posmV4);
const NATIVE = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const LOW = '0x0000000000000000000000000000000000000abc';    // sorts before USDG
const HIGH = '0xfffffffffffffffffffffffffffffffffffff123';   // sorts after USDG
const QUOTES = { [USDG]: { symbol: 'USDG', kind: 'usd' }, [NATIVE]: { symbol: 'ETH', kind: 'eth' }, [WETH]: { symbol: 'WETH', kind: 'eth' } };

const tests = [];
const test = (n, f) => tests.push([n, f]);

function fakeManual({ existingV4 = false, existingV3 = null } = {}) {
  const man = Object.create(Manual.prototype);
  const dec = { [USDG]: 6, [NATIVE]: 18, [WETH]: 18, [LOW]: 18, [HIGH]: 9 };
  man.chain = {
    ADDR: { posmV4: '0xposm', poolManager: '0xpm', weth: WETH },
    QUOTES,
    venues: [{ key: 'v3', npmV3: '0xnpm', factory: '0xfactory' }],
    venueOf: (v) => (v === 'v3' ? { key: 'v3', npmV3: '0xnpm', factory: '0xfactory' } : null),
    tokens: async (a) => a.map((x) => ({ address: x, symbol: x === USDG ? 'USDG' : x.slice(0, 6), decimals: dec[x] ?? 18 })),
    quoteSideOf: (t0, t1) => (QUOTES[t0] ? { side: 0, ...QUOTES[t0] } : QUOTES[t1] ? { side: 1, ...QUOTES[t1] } : null),
    slot0V4: async () => (existingV4 ? { sqrtPriceX96: 1n, tick: 0 } : null),
  };
  const F = new ethers.Interface(ABI.v3Factory);
  man.rpc = { ethCallMany: async () => [F.encodeFunctionResult('getPool', [existingV3 || NATIVE])] };
  return man;
}

// The price the pool will start at, back in "quote per token" for the spec's pair.
const startPrice = (s) => {
  const p10 = m.tickToPrice(s.init.tick, s.pool.dec0, s.pool.dec1);
  return s.pool.quoteSide === 1 ? p10 : 1 / p10;
};

test('pair is ordered by address and the starting price is quote per token on both sides', async () => {
  for (const token of [LOW, HIGH]) {
    const s = await fakeManual().createSpec({ venue: 'v4', token, quote: USDG, fee: 3000, tickSpacing: 60, price: 0.0042 });
    assert.ok(!s.error, s.error);
    assert.ok(BigInt(s.pool.token0) < BigInt(s.pool.token1), 'currency0 < currency1');
    assert.strictEqual(s.pool.quoteSide, token === LOW ? 1 : 0);
    assert.ok(Math.abs(startPrice(s) / 0.0042 - 1) < 1e-4, `start price ${startPrice(s)}`);
    assert.strictEqual(BigInt(s.init.sqrtPriceX96), m.getSqrtRatioAtTick(s.init.tick));
  }
});

test('v4 poolId is keccak(poolKey); native ETH is currency0; v3 pairs native as WETH', async () => {
  const s = await fakeManual().createSpec({ venue: 'v4', token: HIGH, quote: NATIVE, fee: 10000, tickSpacing: 200, price: 2 });
  assert.strictEqual(s.pool.token0, NATIVE);
  const want = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'uint24', 'int24', 'address'], [NATIVE, HIGH, 10000, 200, NATIVE]));
  assert.strictEqual(s.pool.poolRef, want);
  const v3 = await fakeManual().createSpec({ venue: 'v3', token: HIGH, quote: NATIVE, fee: 3000, price: 2 });
  assert.ok(!v3.error, v3.error);
  assert.strictEqual(v3.pool.token0, WETH);
  assert.strictEqual(v3.pool.tickSpacing, 60);
  assert.strictEqual(v3.pool.poolRef, null, 'the v3 address only exists after creation');
});

test('an existing pool and bad input are refused', async () => {
  assert.match((await fakeManual({ existingV4: true }).createSpec({ venue: 'v4', token: HIGH, quote: USDG, fee: 3000, tickSpacing: 60, price: 1 })).error, /sudah ada/);
  assert.match((await fakeManual({ existingV3: '0x00000000000000000000000000000000000000aa' }).createSpec({ venue: 'v3', token: HIGH, quote: USDG, fee: 3000, price: 1 })).error, /sudah ada/);
  const bad = (a) => fakeManual().createSpec({ venue: 'v4', token: HIGH, quote: USDG, fee: 3000, tickSpacing: 60, price: 1, ...a });
  assert.ok((await bad({ venue: 'v3', fee: 2500 })).error, 'not a v3 fee tier');
  assert.ok((await bad({ fee: 2_000_000 })).error, 'v4 fee above 100%');
  assert.ok((await bad({ tickSpacing: 0 })).error, 'zero tick spacing');
  assert.ok((await bad({ price: 0 })).error, 'zero price');
  assert.ok((await bad({ quote: LOW })).error, 'quote must be a known quote asset');
  assert.ok((await bad({ token: USDG })).error, 'token equals quote');
  assert.ok((await bad({ venue: 'pancakev3' })).error, 'venue not on this chain');
});

test('v4 mint for a new pool is one multicall: initializePool then modifyLiquidities', () => {
  const ex = new Executor({ rpc: {}, store: null, chain: { ADDR: { posmV4: '0xposm' } }, cfg: { gas: {} }, log: () => {} });
  ex.address = () => '0x00000000000000000000000000000000000000e1';
  const plan = {
    poolKey: { currency0: NATIVE, currency1: HIGH, fee: 3000, tickSpacing: 60, hooks: NATIVE },
    tickLower: -600, tickUpper: 600, liquidity: '1000', amount0Max: '77', amount1Max: '5',
  };
  const plain = ex.buildV4Mint(plan, 1);
  assert.strictEqual(IF.parseTransaction({ data: plain.data }).name, 'modifyLiquidities');
  const init = { sqrtPriceX96: m.getSqrtRatioAtTick(120).toString(), tick: 120 };
  const tx = ex.buildV4Mint({ ...plan, init }, 1);
  const outer = IF.parseTransaction({ data: tx.data });
  assert.strictEqual(outer.name, 'multicall');
  const [first, second] = outer.args[0].map((d) => IF.parseTransaction({ data: d }));
  assert.strictEqual(first.name, 'initializePool');
  assert.strictEqual(first.args[1], BigInt(init.sqrtPriceX96));
  assert.deepStrictEqual([...first.args[0]].map(String), [NATIVE, ethers.getAddress(HIGH), '3000', '60', NATIVE]);
  assert.strictEqual(second.name, 'modifyLiquidities');
  assert.strictEqual(outer.args[0][1], plain.data, 'the mint inside is the same as a plain mint');
  assert.strictEqual(tx.value, '77', 'native ETH value is carried by the multicall');
});

// The entry path up to the mint, with the chain and wallet stubbed.
function entry({ slot0 }) {
  const e = Object.create(Engine.prototype);
  e.cfg = { gas: {} }; e.ethUsd = 2500; e.entryRetryWaits = [];
  e.rulesFrom = () => ({ swap: { enabled: true, max_slippage_bps: 100, max_price_impact_bps: 500 } });
  e.topUpGas = async () => {};
  e.chain = {
    isV3Venue: () => false,
    slot0V4: async () => slot0,
    tokens: async () => [{ decimals: 18 }, { decimals: 6 }],
    valueInQuote: () => ({ value: 10, kind: 'usd' }),
  };
  let minted = null;
  e.exec = {
    balances: async (ts) => new Map(ts.map((t) => [t.toLowerCase(), 10n ** 30n])),
    ensureAllowance: async () => [], deadline: () => 0, address: () => USDG,
    buildV4Mint: (p) => { minted = p; throw new Error('MINT_READY'); },
  };
  const init = { sqrtPriceX96: m.getSqrtRatioAtTick(-276000).toString(), tick: -276000 };
  const plan = { venue: 'v4', poolRef: '0xid', poolKey: {}, token0: HIGH, token1: USDG, fee: 3000,
    tickLower: -276600, tickUpper: -275400, liquidity: '1000000000', amount0Max: '1', amount1Max: '1',
    quoteSide: 1, valueQuote: 10, valueUsd: 10, init };
  return { e, plan, minted: () => minted };
}

test('an uninitialized pool is minted at its starting price', async () => {
  const f = entry({ slot0: null });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /MINT_READY/);
  assert.ok(f.minted().init, 'the plan reaching the mint still carries init');
});

test('a pool already pushed away from the starting price is refused before the mint', async () => {
  const f = entry({ slot0: { sqrtPriceX96: m.getSqrtRatioAtTick(-275000), tick: -275000 } });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /bergeser/);
  assert.strictEqual(f.minted(), null);
  const g = entry({ slot0: { sqrtPriceX96: m.getSqrtRatioAtTick(-276010), tick: -276010 } });
  await assert.rejects(g.e.executeEntry(g.plan, {}), /MINT_READY/, 'within 1% it goes ahead');
});

(async () => {
  let ok = 0, bad = 0;
  for (const [n, f] of tests) {
    try { await f(); ok++; console.log('  ✓', n); } catch (e) { bad++; console.log('  ✗', n, '\n     ', e.stack.split('\n').slice(0, 3).join('\n      ')); }
  }
  console.log(`\n${ok} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})();
