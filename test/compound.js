'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Executor } = require('../src/executor');
const { ADDR, ABI, TOPIC } = require('../src/chain');
const m = require('../src/v3math');
const coder = ethers.AbiCoder.defaultAbiCoder();
const ME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), POOL = '0x' + '33'.repeat(32);

function fixture() {
  const store = new Store(':memory:');
  const state = { growth0: 10n * m.Q128, growth1: 10n * m.Q128, owner: ME, timeout: false, revert: false, now: Date.now() };
  const liquidity = 1_000_000n;
  const transfer = (token) => ({ address: token, topics: [TOPIC.transfer, ethers.zeroPadValue(ADDR.poolManager, 32), ethers.zeroPadValue(ME, 32)], data: coder.encode(['uint256'], [150000n]) });
  const receipt = { status: '0x1', logs: [transfer(TOKEN), transfer(ADDR.usdg)], gasUsed: '0x100', effectiveGasPrice: '0x2', blockNumber: '0x10' };
  const rpc = {
    ethCallMany: async (calls) => calls.length === 10
      ? [state.growth0, state.growth1, 0n, 0n, 0n, 0n, liquidity, 0n, 0n, 0n].map((n) => coder.encode(['uint256'], [n]))
      : [coder.encode(['address'], [state.owner])],
    call: async () => state.timeout ? null : { ...receipt, status: state.revert ? '0x0' : '0x1' },
  };
  const chain = {
    slot0V4: async () => ({ tick: 0, sqrtPriceX96: m.Q96 }),
    poolLiquidity: async () => 1n,   // pool hidup: harga pool sendiri yang dipakai menilai
    tokens: async (list) => list.map((address) => ({ address, decimals: 6, symbol: 'TOK' })),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0 + amount1) / 1e6, kind: 'usd' }),
  };
  const e = new Engine({ store, rpc, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  e.exec.address = () => ME;
  e.poolKeyOf = async () => ({ currency0: TOKEN, currency1: ADDR.usdg, fee: 3000, tickSpacing: 60, hooks: ADDR.native });
  e.positions.sync = async () => {};
  const id = e.positions.record({ venue: 'v4', poolRef: POOL, token0: TOKEN, token1: ADDR.usdg, fee: 3000,
    tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: String(liquidity),
    amount0: '5000000', amount1: '5000000', valueQuote: 10, quoteSymbol: 'USDG' }, { tokenId: '123' });
  const sent = [];
  e.exec.send = async (tx, options) => {
    sent.push({ tx, ...options });
    const hash = '0x' + String(sent.length).padStart(64, '0');
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), options.kind, 'pending', JSON.stringify(options.detail));
    return hash;
  };
  e.exec.waitReceipt = async (hash) => {
    if (state.timeout) return { ok: false, timeout: true };
    store.run('UPDATE txs SET status=? WHERE hash=?', state.revert ? 'gagal' : 'sukses', hash);
    return { ok: !state.revert, receipt };
  };
  return { e, store, state, sent, id, pos: () => store.get('SELECT * FROM positions WHERE id=?', id), c: e.compound };
}

test('default OFF; per-position settings persist and reject invalid values', () => {
  const f = fixture();
  try {
    assert.equal(f.c.status(f.pos()).enabled, false);
    const s = f.c.configure(f.id, { enabled: true, minUsd: 2.5, intervalMinutes: 60 });
    assert.equal(s.enabled, true); assert.equal(s.minUsd, 2.5); assert.equal(s.intervalMinutes, 60);
    f.c.configure(f.id, { enabled: false });
    assert.equal(f.c.status(f.pos()).minUsd, 2.5);
    for (const input of [{ minUsd: 0 }, { minUsd: NaN }, { intervalMinutes: 0 }, { intervalMinutes: 1.5 }, { enabled: 'true' }]) {
      assert.throws(() => f.c.configure(f.id, input));
    }
    // v3 ikut dipanen sejak jalur multicall collect+increaseLiquidity ada; venue tanpa
    // NFT posisi (pool langsung) tetap ditolak.
    f.store.run("UPDATE positions SET venue='v3' WHERE id=?", f.id);
    assert.equal(f.c.configure(f.id, { enabled: true }).supported, true);
    f.store.run("UPDATE positions SET venue='v3pool' WHERE id=?", f.id);
    assert.throws(() => f.c.configure(f.id, { enabled: true }), /v3 dan v4/);
  } finally { f.store.db.close(); }
});

test('compound uses fixed INCREASE + TAKE_PAIR with no wallet funding or approvals', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true });
    await f.c.tick(f.state.now);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'compound');
    const tx = f.sent[0].tx;
    assert.equal(tx.value, '0');
    const [unlock] = new ethers.Interface(ABI.posmV4).decodeFunctionData('modifyLiquidities', tx.data);
    const [actions, params] = coder.decode(['bytes', 'bytes[]'], unlock);
    assert.equal(actions, '0x0011');
    const [tokenId, L, max0, max1] = coder.decode(['uint256', 'uint256', 'uint128', 'uint128', 'bytes'], params[0]);
    assert.equal(tokenId, 123n); assert.ok(L > 0n);
    assert.ok(max0 <= 10_000_000n && max1 <= 10_000_000n);
    assert.equal(coder.decode(['address', 'address', 'address'], params[1])[2].toLowerCase(), ME);
    assert.equal(f.pos().cost_quote, 10, 'reinvestment is profit, not fresh capital');
    assert.equal(f.pos().claimed_quote, 0.3, 'only residual fee tokens are realized');
    assert.equal(f.pos().status, 'open');
    assert.equal(f.store.all('SELECT * FROM compound_runs').length, 1);
    assert.ok(f.c.status(f.pos()).compoundedUsd > 19);
    await f.c.tick(f.state.now + 1);
    assert.equal(f.sent.length, 1, 'interval blocks repeated sends');
  } finally { f.store.db.close(); }
});

for (const guard of ['off', 'dry', 'paused', 'entry', 'exit', 'noWallet', 'busy']) test(`scheduler respects ${guard}`, async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: guard !== 'off' });
    if (guard === 'dry') f.e.cfg.mode.dry_run = true;
    if (guard === 'paused') f.store.setState('paused', '1');
    if (guard === 'entry') f.e.activeEntries = 1;
    if (guard === 'exit') f.e.exiting.add(f.id);
    if (guard === 'noWallet') f.e.exec.address = () => null;
    if (guard === 'busy') f.e.busy = true;
    await f.c.tick(f.state.now);
    assert.equal(f.sent.length, 0);
  } finally { f.store.db.close(); }
});

test('too-small fees and mismatched ratios skip without collecting or sending', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true, minUsd: 100 });
    await f.c.tick(f.state.now);
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /minimum/);
    f.c.configure(f.id, { minUsd: 1 });
    f.state.growth1 = 0n;
    await f.c.tick(f.state.now + 31 * 60000);
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /rasio/);
  } finally { f.store.db.close(); }
});

test('position/exposure caps and ownership are respected', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true });
    f.e.cfg.rules.sizing = { max_total_exposure_usd: 1 };
    await f.c.tick(f.state.now);
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /batas/);
    f.e.cfg.rules.sizing = {};
    f.state.owner = TOKEN;
    await f.c.tick(f.state.now + 31 * 60000);
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /bukan milik/);
  } finally { f.store.db.close(); }
});

test('timeout survives restart and never resends; finalization is idempotent', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true }); f.state.timeout = true;
    await f.c.tick(f.state.now);
    await f.c.tick(f.state.now + 31 * 60000);
    assert.equal(f.sent.length, 1);
    await assert.rejects(f.e.claimFees(f.id), /compound sebelumnya/);
    await assert.rejects(f.e.executeExit({}, f.pos()), /compound sebelumnya/);
    const { Compound } = require('../src/compound');
    f.e.compound = new Compound(f.e);
    f.state.timeout = false;
    await f.e.compound.reconcile();
    await f.e.compound.reconcile();
    assert.equal(f.store.all('SELECT * FROM compound_runs').length, 1);
    assert.equal(f.pos().claimed_quote, 0.3);
    assert.equal(f.pos().cost_quote, 10);
    assert.equal(f.sent.length, 1);
  } finally { f.store.db.close(); }
});

test('revert keeps principal and accounting unchanged', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true }); f.state.revert = true;
    await f.c.tick(f.state.now);
    assert.equal(f.store.all('SELECT * FROM compound_runs').length, 0);
    assert.equal(f.pos().cost_quote, 10); assert.equal(f.pos().claimed_quote, 0);
    assert.equal(f.pos().liquidity, '1000000');
    assert.match(f.c.status(f.pos()).lastNote, /revert/);
  } finally { f.store.db.close(); }
});

test('an exit trigger takes priority even when closing did not succeed', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true });
    await f.c.tick(f.state.now, new Set([f.id]));
    assert.equal(f.sent.length, 0);
  } finally { f.store.db.close(); }
});

test('a queued automatic send checks cancellation before accessing the wallet', async () => {
  const exec = Object.create(Executor.prototype);
  exec.loadWallet = () => { throw new Error('must not access wallet'); };
  await assert.rejects(exec.send({}, { guard: () => false }), /pengaturan berubah/);
});

test('turning OFF during RPC planning prevents an unsent compound', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true });
    const plan = f.c.plan.bind(f.c);
    f.c.plan = async (p) => { const r = await plan(p); f.c.configure(f.id, { enabled: false }); return r; };
    await f.c.tick(f.state.now);
    assert.equal(f.sent.length, 0);
  } finally { f.store.db.close(); }
});

test('signer serializes sends and a rejected send does not poison the queue', async () => {
  const exec = Object.create(Executor.prototype), order = [];
  exec.sendTransaction = async (tx) => { order.push(tx.id); await Promise.resolve(); if (tx.id === 1) throw new Error('first failed'); order.push(-tx.id); return tx.id; };
  const results = await Promise.allSettled([exec.send({ id: 1 }), exec.send({ id: 2 }), exec.send({ id: 3 })]);
  assert.deepEqual(order, [1, 2, -2, 3, -3]);
  assert.equal(results[0].status, 'rejected'); assert.equal(results[2].value, 3);
});
