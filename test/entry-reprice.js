'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine } = require('../src/engine');
const { Executor } = require('../src/executor');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');
const TOKEN = '0x451b42a15100c340ca12f7c66de06fac5ea2d751';
function fixture({ venue = 'v4', ticks = [-323405], enabled = true, singleSide, loss = 0, complete = false, approvalTick } = {}) {
  const e = Object.create(Engine.prototype);
  e.cfg = { gas: {} }; e.ethUsd = 2500;
  e.rulesFrom = () => ({ swap: { enabled, max_slippage_bps: 150, max_price_impact_bps: 500 } });
  e.topUpGas = async () => {};
  const balances = new Map([[TOKEN, 0n], [ADDR.usdg, 70_000_000n]]);
  let bridge = 0, swaps = 0, reads = 0, mint;
  let forcedTick;
  const slot = () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(forcedTick ?? ticks[Math.min(reads++, ticks.length - 1)]) });
  e.chain = {
    slot0V3: async () => slot(), slot0V4: async () => slot(),
    token: async () => ({ decimals: 6 }),
    tokens: async () => [{ decimals: 18 }, { decimals: 6 }],
    valueInQuote: ({ amount0, amount1, sqrtPriceX96 }) => ({
      value: Number(amount0) / 1e18 * m.priceFromSqrt(sqrtPriceX96, 18, 6) + Number(amount1) / 1e6, kind: 'usd',
    }),
  };
  e.ensureQuoteAsset = async () => { bridge++; balances.set(ADDR.usdg, 212_259_831n); return []; };
  e.exec = {
    balances: async () => new Map(balances),
    ensureAllowance: async () => { if (approvalTick != null) forcedTick = approvalTick; return []; },
    address: () => ADDR.usdg,
    send: async (tx) => {
      assert.equal(tx.simulatedMint, true);
      const amounts = m.amountsForLiquidity(m.getSqrtRatioAtTick(forcedTick ?? ticks[Math.min(reads - 1, ticks.length - 1)]),
        m.getSqrtRatioAtTick(plan.tickLower), m.getSqrtRatioAtTick(plan.tickUpper), BigInt(tx.plan.liquidity));
      for (const [i, tok] of [[0, TOKEN], [1, ADDR.usdg]]) {
        assert.ok(amounts['amount' + i] <= balances.get(tok), 'mint has enough token' + i);
        assert.ok(amounts['amount' + i] <= BigInt(tx.plan['amount' + i + 'Max']), 'mint respects token maximum');
      }
      assert.ok(e.chain.valueInQuote({ ...amounts, sqrtPriceX96: m.getSqrtRatioAtTick(forcedTick ?? ticks[Math.min(reads - 1, ticks.length - 1)]) }).value <= 200.000001);
      return 'SIMULATED';
    },
    waitReceipt: async () => ({ ok: true, receipt: { logs: [] } }),
    deadline: () => 0,
    buildV4Mint: p => { mint = p; if (complete) return { simulatedMint: true, plan: p }; throw new Error('MINT_READY'); },
    buildV3Mint: p => { mint = p; if (complete) return { simulatedMint: true, plan: p }; throw new Error('MINT_READY'); },
  };
  e.kyber = { swap: async (pay, buy, amount) => {
    swaps++;
    assert.equal(pay, ADDR.usdg);
    assert.ok(amount <= balances.get(pay));
    balances.set(pay, balances.get(pay) - amount);
    const price = Number(m.getSqrtRatioAtTick(ticks[Math.min(reads - 1, ticks.length - 1)])) ** 2 / Number(m.Q96) ** 2;
    balances.set(buy, balances.get(buy) + BigInt(Math.floor(Number(amount) / price * (1 - loss))));
    return {};
  } };
  e.positions = { record: () => 1 };
  const plan = { venue, poolRef: 'pool', poolKey: {}, token0: TOKEN, token1: ADDR.usdg,
    fee: 28000, tickLower: -346640, tickUpper: -323400, liquidity: '3063280869399836',
    amount0Max: '0', amount1Max: '203000000', quoteSide: 1, valueQuote: 200, valueUsd: 200, singleSide };
  return { e, plan, balances, stats: () => ({ bridge, swaps, mint }) };
}
for (const venue of ['v3', 'v4']) test(venue + ': reprice USDG-only plan after bridge, buy missing BOW and cap mint', async () => {
  const f = fixture({ venue });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /MINT_READY/);
  const { bridge, swaps, mint } = f.stats();
  assert.equal(bridge, 1); assert.equal(swaps, 1);
  const s = m.getSqrtRatioAtTick(-323405);
  const amounts = m.amountsForLiquidity(s, m.getSqrtRatioAtTick(f.plan.tickLower), m.getSqrtRatioAtTick(f.plan.tickUpper), BigInt(mint.liquidity));
  assert.ok(amounts.amount0 > 0n);
  assert.ok(amounts.amount0 <= f.balances.get(TOKEN));
  assert.ok(amounts.amount1 <= f.balances.get(ADDR.usdg));
  assert.ok(f.e.chain.valueInQuote({ ...amounts, sqrtPriceX96: s }).value <= 200);
});
test('auto-swap disabled reports missing token without a zap', async () => {
  const f = fixture({ enabled: false });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /auto-swap dimatikan/);
  assert.equal(f.stats().swaps, 0);
});
test('explicit single-sided mode rejects entry into range without buying BOW', async () => {
  const f = fixture({ singleSide: 'token1' });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /harga sudah masuk rentang/);
  assert.equal(f.stats().swaps, 0);
});
test('moving price stops after two corrective swaps without mint', async () => {
  const f = fixture({ ticks: [-323405, -328000, -334000] });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /harga berubah setelah swap/);
  assert.equal(f.stats().swaps, 2); assert.equal(f.stats().mint, undefined);
});
test('RPC failure is not a zero balance; genuine zero remains valid', async () => {
  const e = Object.create(Executor.prototype); e.address = () => ADDR.usdg;
  for (const response of [null, '0x', '0x123']) {
    e.rpc = { ethCallMany: async () => [response] };
    await assert.rejects(e.balances([TOKEN]), /gagal membaca saldo.*RPC/);
  }
  e.rpc = { ethCallMany: async () => ['0x' + '0'.repeat(64)] };
  assert.equal((await e.balances([TOKEN])).get(TOKEN), 0n);
});

test('full simulated execution: historical BOW tick path and fee/slippage matrix', async () => {
  let completed = 0;
  for (const venue of ['v3', 'v4']) for (const tick of [-323399, -323400, -323405, -323412, -323458, -324000])
    for (const loss of [0, 0.028, 0.045]) {
      const f = fixture({ venue, ticks: [tick], loss, complete: true });
      const result = await f.e.executeEntry(f.plan, {});
      assert.equal(result.txHash, 'SIMULATED');
      assert.ok(result.valueUsd <= 200.000001);
      assert.ok(f.stats().swaps <= 2);
      completed++;
    }
  assert.equal(completed, 36);
});

test('price crossing range during approvals must stop before sending mint', async () => {
  const f = fixture({ ticks: [-323399], approvalTick: -323458, complete: true });
  await assert.rejects(f.e.executeEntry(f.plan, {}), /harga berubah sebelum mint/);
  assert.equal(f.stats().mint, undefined);
});

test('pool RPC failure stops before token swap or mint', async () => {
  const f = fixture({ complete: true });
  f.e.chain.slot0V4 = async () => null;
  await assert.rejects(f.e.executeEntry(f.plan, {}), /gagal membaca harga pool/);
  assert.equal(f.stats().swaps, 0);
  assert.equal(f.stats().mint, undefined);
});
