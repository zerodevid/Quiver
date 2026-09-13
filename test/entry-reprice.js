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
  e.cfg = { gas: {} }; e.ethUsd = 2500; e.entryRetryWaits = [0, 0];
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
        // v3: amountDesired DISETOR apa adanya — di atas saldo = revert "STF" di chain.
        assert.ok(BigInt(tx.plan['amount' + i + 'Max']) <= balances.get(tok), 'token maximum never exceeds wallet balance (v3 STF)');
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
test('moving price during zaps: opens what the balance fits instead of selling the zap back', async () => {
  const f = fixture({ ticks: [-323405, -328000, -334000], complete: true });
  const r = await f.e.executeEntry(f.plan, {});
  assert.equal(r.txHash, 'SIMULATED');
  assert.ok(f.stats().swaps <= 3, 'zap dibatasi lintas percobaan');
  assert.ok(BigInt(f.stats().mint.liquidity) > 0n);
});
test('zaps are capped across retries and a hopeless entry stops (no endless buy/sell)', async () => {
  // Harga lari terus: setiap zap cuma memberi 10% dari yang dibutuhkan.
  const f = fixture({ ticks: [-323405], loss: 0.9, complete: true });
  const state = new Map();
  f.e.store = { getState: (k, d) => state.get(k) ?? d, setState: (k, v) => state.set(k, v), log: () => {}, get: () => null };
  await assert.rejects(f.e.executeEntry(f.plan, {}), /harga berubah setelah swap|saldo kurang untuk zap/);
  assert.ok(f.stats().swaps <= 3, `zap ${f.stats().swaps}× — harus berhenti`);
  assert.equal(f.stats().mint, undefined);
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

test('price crossing range during approvals: never mints without the token; the retry buys it and opens', async () => {
  // Belum ada zap (rencana USDG saja), lalu harga masuk rentang saat approval: butuh BOW
  // yang tidak dimiliki. Percobaan pertama berhenti sebelum mint; percobaan ulang menilai
  // dari harga baru, membeli BOW, dan membuka posisinya (dulu: entry hilang begitu saja).
  const f = fixture({ ticks: [-323399], approvalTick: -323458, complete: true });
  const r = await f.e.executeEntry(f.plan, {});
  assert.equal(r.txHash, 'SIMULATED');
  assert.equal(f.stats().swaps, 1);
  assert.equal(f.stats().bridge, 1, 'jembatan tidak diulang');
});

test('price drift during approvals after a zap refits the size instead of stranding the token', async () => {
  // Kasus lpcopy2 (12 Sep): zap $26 USDG→PAIREX sukses, harga bergeser selama approval,
  // mint dibatalkan "harga berubah sebelum mint" — PAIREX ditinggal telanjang di wallet.
  for (const drift of [-323412, -323458, -324000, -323401]) {
    const f = fixture({ ticks: [-323405], approvalTick: drift, complete: true });
    const result = await f.e.executeEntry(f.plan, {});
    assert.equal(result.txHash, 'SIMULATED');
    assert.equal(f.stats().swaps, 1);
    assert.ok(BigInt(f.stats().mint.liquidity) > 0n);
    assert.ok(result.valueUsd <= 200.000001);
  }
});

test('mint failing after a zap queues the bought token for sale instead of stranding it', async () => {
  const f = fixture({ ticks: [-323405], complete: true });
  const state = new Map(); const logs = [];
  f.e.store = { getState: (k, d) => state.get(k) ?? d, setState: (k, v) => state.set(k, v), log: (lvl, msg) => logs.push(msg) };
  f.e.rulesFrom = () => ({ swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 500 }, exit: {} });
  const send = f.e.exec.send;
  f.e.exec.send = async (tx) => { if (tx.simulatedMint) throw new Error('MINT_BOOM'); return send(tx); };
  await assert.rejects(f.e.executeEntry(f.plan, {}), /MINT_BOOM/);
  assert.equal(f.stats().swaps, 1);
  const q = JSON.parse(state.get('leftovers'));
  assert.equal(q.length, 1);
  assert.equal(q[0].token, TOKEN); assert.equal(q[0].quote, ADDR.usdg); assert.equal(q[0].source, 'zap');
  assert.equal(BigInt(q[0].amount), f.balances.get(TOKEN));   // persis yang terbeli (saldo awal 0)
  assert.match(q[0].why, /MINT_BOOM/);
  assert.ok(logs.some((m) => /masuk antrean jual/.test(m)));
});

test('pool RPC failure stops before token swap or mint', async () => {
  const f = fixture({ complete: true });
  f.e.chain.slot0V4 = async () => null;
  await assert.rejects(f.e.executeEntry(f.plan, {}), /gagal membaca harga pool/);
  assert.equal(f.stats().swaps, 0);
  assert.equal(f.stats().mint, undefined);
});

test('bridge runs at most once per entry even when the attempt after it fails and is retried', async () => {
  const f = fixture({ complete: true });
  let calls = 0;
  f.e.ensureQuoteAsset = async () => { calls++; f.balances.set(ADDR.usdg, 212_259_831n); return ['jembatan ETH→USDG via Kyber (uji)']; };
  const send = f.e.exec.send; let first = true;
  f.e.exec.send = async (tx) => { if (tx.simulatedMint && first) { first = false; throw new Error('estimasi gas gagal (transaksi kemungkinan akan revert): execution reverted: STF'); } return send(tx); };
  const r = await f.e.executeEntry(f.plan, {});
  assert.equal(r.txHash, 'SIMULATED');
  assert.equal(calls, 1, 'jembatan tidak diulang');
});

// Node yang tertinggal: saldo sesudah zap terbaca seperti sebelum zap. Receipt (amountOut)
// sudah membuktikan token masuk, jadi bot tidak boleh zap kedua kalinya.
test('stale balance after a confirmed zap (lagging node): no second zap, mint proceeds with receipt-proven amount', async () => {
  const f = fixture({ complete: true });
  f.e.ensureQuoteAsset = async () => { f.balances.set(ADDR.usdg, 212_259_831n); return []; };
  const realBalances = f.e.exec.balances;
  let stale = null, staleReads = 0;
  f.e.exec.balances = async (toks) => { if (stale && staleReads-- > 0) return new Map(stale); return realBalances(toks); };
  const kyberSwap = f.e.kyber.swap;
  f.e.kyber.swap = async (pay, buy, amount) => {
    stale = new Map(f.balances); staleReads = 3;   // tiga pembacaan berikutnya "sebelum zap"
    const before = f.balances.get(buy);
    await kyberSwap(pay, buy, amount);
    return { hash: '0xzap', amountOut: f.balances.get(buy) - before };
  };
  const r = await f.e.executeEntry(f.plan, {});
  assert.equal(r.txHash, 'SIMULATED');
  assert.equal(f.stats().swaps, 1, 'hanya satu zap');
});

test('stale balance and no receipt amount (unknown): retries reads, then continues with what it sees', async () => {
  const f = fixture({ complete: true });
  f.e.ensureQuoteAsset = async () => { f.balances.set(ADDR.usdg, 212_259_831n); return []; };
  const bal = await f.e.balancesAfterSwap([TOKEN], TOKEN, 0n, null, { tries: 2, waitMs: 0 });
  assert.equal(bal.get(TOKEN), 0n);
  let n = 0;
  f.e.exec.balances = async () => { n++; return new Map([[TOKEN, 5n]]); };
  const b2 = await f.e.balancesAfterSwap([TOKEN], TOKEN, 0n, 100n, { tries: 3, waitMs: 0 });
  assert.equal(n, 3); assert.equal(b2.get(TOKEN), 100n, 'angka receipt dipakai setelah percobaan habis');
});
test('v3: booked from the IncreaseLiquidity event, not the planned amounts', async () => {
  // Di v3 NPM menyetor amountDesired (rencana + ruang slippage) apa adanya, jadi posisi
  // nyata ~1% lebih besar dari rencana. lp2 #2/#3: modal tercatat 1,2% di bawah chain.
  const { TOPIC } = require('../src/chain');
  const f = fixture({ venue: 'v3', complete: true });
  let booked;
  f.e.positions = { record: (plan, r) => { booked = { plan, ...r }; return 1; } };
  f.e.store = { get: () => null, run: () => {}, log: () => {} };
  const w = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  f.e.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [{
    address: ADDR.npmV3, topics: [TOPIC.increaseLiq, w(1152471)],
    data: '0x' + [w(3100000000000000n), w(20053532020992362n), w(1952790474080453n)].map((x) => x.slice(2)).join(''),
  }] } });
  const r = await f.e.executeEntry(f.plan, {});
  assert.equal(r.txHash, 'SIMULATED');
  assert.equal(booked.cost0, '20053532020992362');
  assert.equal(booked.cost1, '1952790474080453');
  assert.equal(booked.plan.liquidity, '3100000000000000');
});
