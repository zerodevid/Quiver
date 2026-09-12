'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Manual } = require('../src/manual');
const { ADDR, ABI, TOPIC } = require('../src/chain');
const m = require('../src/v3math');
const coder = ethers.AbiCoder.defaultAbiCoder();
const ME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), POOL = '0x' + '33'.repeat(32);

function fixture({ quoteSide = 0, tick = 17, venue = 'v4', native = false } = {}) {
  const store = new Store(':memory:');
  const token0 = native ? ADDR.native : quoteSide === 0 ? ADDR.usdg : TOKEN;
  const token1 = native ? ADDR.usdg : quoteSide === 1 ? ADDR.usdg : TOKEN;
  const pool = { poolRef: POOL, venue, token0, token1, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    symbol0: 'A', symbol1: 'B', dec0: native ? 18 : 6, dec1: 6, pair: 'A/B', quoteSide, quoteKind: 'usd', quoteSymbol: 'USDG' };
  const slot = { tick, sqrtPriceX96: m.getSqrtRatioAtTick(tick) + 1n };
  const chain = {
    slot0V4: async () => slot, slot0V3: async () => slot,
    poolLiquidity: async () => 1n,   // pool hidup: harga pool sendiri yang dipakai menilai
    tokens: async (list) => list.map((address) => ({ address, symbol: address === ADDR.usdg ? 'USDG' : 'TOKEN', decimals: address === ADDR.native ? 18 : 6 })),
    token: async (address) => (await chain.tokens([address]))[0],
    quoteSideOf: () => ({ side: quoteSide, kind: 'usd', symbol: 'USDG', decimals: 6 }),
    valueInQuote({ amount0, amount1, sqrtPriceX96, dec0, dec1 }) {
      const price = m.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: quoteSide === 0 ? a0 + a1 / price : a1 + a0 * price, kind: 'usd' };
    },
  };
  let receipt;
  const rpc = {
    ethCallMany: async () => [coder.encode(['address'], [ME])],
    call: async (method) => {
      if (method === 'eth_getTransactionReceipt') return receipt;
      throw new Error('unexpected RPC ' + method);
    },
  };
  const eng = new Engine({ rpc, store, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  eng.exec.address = () => ME;
  eng.topUpGas = async () => {};
  eng.positions.sync = async () => {};
  eng.poolKeyOf = async () => ({ currency0: token0, currency1: token1, fee: 3000, tickSpacing: 60, hooks: ADDR.native });
  const balances = new Map([[token0, 1_000_000_000n], [token1, 1_000_000_000n], [ADDR.native, 10n ** 17n]]);
  eng.exec.balances = async () => balances;
  const sent = [];
  eng.exec.send = async (tx, options) => {
    sent.push({ tx, ...options });
    const hash = '0x' + String(sent.length).padStart(64, '0');
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), options.kind, 'pending', JSON.stringify(options.detail));
    return hash;
  };
  const transfer = (token, amount) => ({ address: token, topics: [TOPIC.transfer, ethers.zeroPadValue(ADDR.posmV4, 32), ethers.zeroPadValue(ME, 32)], data: coder.encode(['uint256'], [amount]) });
  receipt = { status: '0x1', blockNumber: '0x10', gasUsed: '0x64', effectiveGasPrice: '0x2', logs: [transfer(token0, 2_000_000n), transfer(token1, 3_000_000n)] };
  eng.exec.waitReceipt = async (hash) => {
    const ok = receipt.status === '0x1';
    store.run('UPDATE txs SET status=? WHERE hash=?', ok ? 'sukses' : 'gagal', hash);
    return { ok, receipt };
  };
  const manual = new Manual({ engine: eng, store, chain, rpc });
  manual.poolByRef = async () => pool;
  const id = eng.positions.record({ ...pool, tickLower: -600, tickUpper: 600, liquidity: '5000', amount0: '10000000', amount1: '0', valueQuote: 10 }, { tokenId: '123', target: null });
  return { eng, store, manual, pool, slot, balances, sent, rpc, id, receipt };
}

// [25, 0] / [0, 25] menempel di harga kini; [30, -10] / [-10, 30] bergeser menjauh
// (seluruhnya di bawah / di atas harga) dan tetap hanya butuh satu token.
for (const quoteSide of [0, 1]) for (const tick of [-121, 0, 17, 120]) for (const [lowerPct, upperPct] of [[25, 0], [0, 25], [30, -10], [-10, 30], [0.1, -0.05]]) {
  test(`single-sided q${quoteSide}, tick ${tick}, range ${lowerPct}/${upperPct}`, async () => {
    const f = fixture({ quoteSide, tick });
    try {
      const r = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct, upperPct });
      assert.ok(!r.error, r.error);
      const zeroSide = (lowerPct <= 0) === (quoteSide === 1) ? 1 : 0;
      assert.equal(r.plan[`amount${zeroSide}`], '0');
      assert.equal(r.plan[`amount${zeroSide}Max`], '0');
      assert.ok(BigInt(r.plan[`amount${1 - zeroSide}`]) > 0n);
      assert.ok(r.plan.tickLower % 60 === 0);
      assert.ok(r.plan.tickUpper % 60 === 0);
      assert.notEqual(r.preview.side, 'both');
      // Hold only the required token: no bridge or zap, even with auto-swap off.
      f.balances.set(zeroSide === 0 ? f.pool.token0 : f.pool.token1, 0n);
      f.eng.cfg.rules.swap = { enabled: false };
      const funded = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct, upperPct });
      assert.ok(!funded.error, funded.error);
      assert.deepEqual(funded.preview.swaps, []);
      assert.ok(!funded.warnings.some((w) => /auto-swap|jembatan/.test(w)));
    } finally { f.store.db.close(); }
  });
}

test('single-sided execution rejects a price that entered the range before mint', async () => {
  const f = fixture();
  try {
    const r = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 0 });
    f.slot.sqrtPriceX96 = m.getSqrtRatioAtTick(r.plan.tickLower + 1);
    await assert.rejects(f.eng.executeEntry(r.plan, { target: null, slot0: f.slot }), /harga sudah masuk rentang/);
    assert.equal(f.sent.length, 0);
  } finally { f.store.db.close(); }
});

for (const venue of ['v3', 'v4']) test(`${venue} fee claim leaves liquidity open and records actual fees once`, async () => {
  const f = fixture({ venue });
  try {
    const result = await f.eng.claimFees(f.id);
    assert.equal(result.ok, true);
    assert.equal(result.amount0, '2000000'); assert.equal(result.amount1, '3000000');
    const tx = f.sent[0].tx;
    if (venue === 'v4') {
      const decoded = new ethers.Interface(ABI.posmV4).decodeFunctionData('modifyLiquidities', tx.data);
      const [actions, params] = coder.decode(['bytes', 'bytes[]'], decoded[0]);
      assert.equal(actions, '0x0111'); // DECREASE(0), TAKE_PAIR: never burn
      const decrease = coder.decode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], params[0]);
      assert.equal(decrease[0], 123n); assert.equal(decrease[1], 0n);
      const take = coder.decode(['address', 'address', 'address'], params[1]);
      assert.equal(take[2].toLowerCase(), ME);
    } else {
      const [collect] = new ethers.Interface(ABI.npmV3).decodeFunctionData('collect', tx.data);
      assert.equal(collect.tokenId, 123n); assert.equal(collect.recipient.toLowerCase(), ME);
      assert.equal(collect.amount0Max, (1n << 128n) - 1n);
    }
    const pos = f.store.get('SELECT * FROM positions WHERE id=?', f.id);
    assert.equal(pos.liquidity, '5000'); assert.equal(pos.status, 'open'); assert.ok(pos.claimed_quote > 4.9);
    await f.eng.recordFeeClaim(pos, result.tx, f.receipt);
    assert.equal(f.store.get('SELECT claimed_quote FROM positions WHERE id=?', f.id).claimed_quote, pos.claimed_quote);
    const pnlBeforeClose = f.eng.positions.summary(2500);
    assert.equal(pnlBeforeClose.realizedUsd, pos.claimed_quote);
    f.eng.positions.markClosed(f.id, { out0: 10, out1: 0, outQuote: 10 });
    assert.equal(f.eng.positions.summary(2500).realizedUsd, pos.claimed_quote);
  } finally { f.store.db.close(); }
});

test('claim rejects dry-run, unknown position, foreign owner and concurrent close', async () => {
  const f = fixture();
  try {
    f.eng.cfg.mode.dry_run = true;
    await assert.rejects(f.eng.claimFees(f.id), /simulasi/);
    f.eng.cfg.mode.dry_run = false;
    await assert.rejects(f.eng.claimFees(999), /tidak ditemukan/);
    f.eng.exiting.add(f.id);
    await assert.rejects(f.eng.claimFees(f.id), /diproses/);
    f.eng.exiting.clear();
    f.rpc.ethCallMany = async () => [coder.encode(['address'], [TOKEN])];
    await assert.rejects(f.eng.claimFees(f.id), /bukan milik/);
    assert.equal(f.sent.length, 0);
  } finally { f.store.db.close(); }
});

test('timeout resumes same claim after restart; pending claim blocks close', async () => {
  const f = fixture();
  try {
    const wait = f.eng.exec.waitReceipt;
    f.eng.exec.waitReceipt = async () => ({ ok: false, timeout: true });
    const result = await f.eng.claimFees(f.id);
    assert.equal(result.pending, true);
    await f.eng.claimFees(f.id);
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.eng.executeExit({}, { id: f.id }), /claim fee sebelumnya/);
    f.eng.exec.waitReceipt = wait;
    await f.eng.reconcileFeeClaims();
    assert.equal(f.sent.length, 1);
    assert.equal(f.eng.pendingFeeClaim(f.id), undefined);
    assert.equal(f.store.all('SELECT * FROM fee_claims').length, 1);
  } finally { f.store.db.close(); }
});

test('reverted claim never credits fees or closes the position', async () => {
  const f = fixture();
  try {
    f.receipt.status = '0x0';
    await assert.rejects(f.eng.claimFees(f.id), /revert/);
    const p = f.store.get('SELECT * FROM positions WHERE id=?', f.id);
    assert.equal(p.claimed_quote, 0); assert.equal(p.liquidity, '5000'); assert.equal(p.status, 'open');
    assert.equal(f.store.all('SELECT * FROM fee_claims').length, 0);
  } finally { f.store.db.close(); }
});

test('native fee accounting adds gas back and reads balances at receipt block', async () => {
  const f = fixture({ native: true, quoteSide: 1 });
  try {
    f.rpc.call = async (method, args) => {
      if (method === 'eth_getBalance') return args[1] === '0xf' ? '0x3e8' : '0x4b0'; // 1000 -> 1200, gas=200
      if (method === 'eth_getBlockByNumber') return { transactions: [] };
      throw new Error(method);
    };
    const r = await f.eng.claimFees(f.id);
    assert.equal(r.amount0, '400');
    assert.equal(r.amount1, '3000000');
  } finally { f.store.db.close(); }
});
