'use strict';
// Automatic fee harvest: claim mode (fees withdrawn, then the memecoin side sold), compound
// for v3 positions, the fee ledger that replaces the estimated claim price with the actual
// sale result, and the "target starts harvesting diligently" signal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { ADDR, ABI, TOPIC } = require('../src/chain');
const m = require('../src/v3math');
const coder = ethers.AbiCoder.defaultAbiCoder();
const ME = '0x' + '11'.repeat(20), TOKEN = '0x' + '22'.repeat(20), POOL = '0x' + '33'.repeat(32);
const TARGET = '0x' + '44'.repeat(20), POOL3 = '0x' + '55'.repeat(20);

// The claim sends 150000 memecoin + 150000 USDG to our wallet (read from the receipt).
const transfer = (token, amount = 150000n) => ({ address: token,
  topics: [TOPIC.transfer, ethers.zeroPadValue(ADDR.poolManager, 32), ethers.zeroPadValue(ME, 32)],
  data: coder.encode(['uint256'], [amount]) });

function fixture({ venue = 'v4' } = {}) {
  const store = new Store(':memory:');
  const state = { owner: ME, fee0: 150000n, fee1: 150000n, notes: [] };
  const receipt = { status: '0x1', logs: [transfer(TOKEN), transfer(ADDR.usdg)], gasUsed: '0x100', effectiveGasPrice: '0x2', blockNumber: '0x10' };
  const rpc = {
    ethCallMany: async (calls) => (calls.length === 9
      ? [10n * m.Q128, 10n * m.Q128, 0n, 0n, 0n, 0n, 1_000_000n, 0n, 0n].map((n) => coder.encode(['uint256'], [n]))
      : calls.map(() => coder.encode(['address'], [state.owner]))),
    // unclaimedV3 reads fees via an eth_call collect() gathered by rpc.batch.
    batch: async () => [{ result: coder.encode(['uint256', 'uint256'], [state.fee0, state.fee1]) }],
    call: async () => receipt,
  };
  const chain = {
    slot0V4: async () => ({ tick: 0, sqrtPriceX96: m.Q96 }),
    slot0V3: async () => ({ tick: 0, sqrtPriceX96: m.Q96 }),
    poolLiquidity: async () => 1n,
    tokens: async (list) => list.map((address) => ({ address, decimals: 6, symbol: address === ADDR.usdg ? 'USDG' : 'MEME' })),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0 + amount1) / 1e6, kind: 'usd' }),
  };
  const e = new Engine({ store, rpc, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  e.exec.address = () => ME;
  e.exec.ensureAllowance = async () => [];
  e.topUpGas = async () => {};
  e.poolKeyOf = async () => ({ currency0: TOKEN, currency1: ADDR.usdg, fee: 3000, tickSpacing: 60, hooks: ADDR.native });
  e.positions.sync = async () => {};
  e.positions.markSlotFor = async () => ({ sqrtPriceX96: m.Q96, tick: 0 });
  const notice = [];
  e.onNotify = (msg, detail) => notice.push({ msg, detail });
  const id = e.positions.record({ venue, poolRef: venue === 'v4' ? POOL : POOL3, token0: TOKEN, token1: ADDR.usdg,
    fee: 3000, tickSpacing: 60, tickLower: -600, tickUpper: 600, liquidity: '1000000',
    amount0: '5000000', amount1: '5000000', valueQuote: 10, quoteSymbol: 'USDG' },
  { tokenId: '123', target: TARGET });
  const sent = [];
  e.exec.send = async (tx, options) => {
    sent.push({ tx, ...options });
    const hash = '0x' + String(sent.length).padStart(64, '0');
    store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), options.kind, 'pending', JSON.stringify(options.detail));
    return hash;
  };
  e.exec.waitReceipt = async (hash) => {
    store.run('UPDATE txs SET status=? WHERE hash=?', 'sukses', hash);
    return { ok: true, receipt };
  };
  // Leftover/fee sales are represented: what is tested here is the queue, not the swap.
  const sold = [];
  e.sellToken = async (item) => { sold.push(item); return 'jual MEME'; };
  return { e, store, state, sent, dijual: sold, notice, id,
    pos: () => store.get('SELECT * FROM positions WHERE id=?', id), c: e.compound };
}

test('claim mode withdraws fees and queues the memecoin side into the quote asset', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true, mode: 'claim', sellFee: true, minUsd: 0.2 });
    f.store.run('UPDATE positions SET fees_quote=? WHERE id=?', 0.3, f.id);
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'claim_fees');
    // Fees on both sides are booked at the claim price…
    assert.equal(f.pos().claimed_quote, 0.3);
    assert.equal(f.pos().fees_quote, 0);
    // …and ONLY the memecoin side goes into the fee ledger + sell queue.
    const ledger = f.store.all('SELECT * FROM fee_leftovers');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].token, TOKEN);
    assert.equal(ledger[0].amount, '150000');
    assert.equal(ledger[0].est_quote, 0.15);
    assert.equal(f.dijual.length, 1);
    assert.equal(f.dijual[0].token, TOKEN);
    assert.equal(f.dijual[0].quote, ADDR.usdg);
    assert.equal(f.dijual[0].kind, 'fee');
    assert.match(f.notice.at(-1).msg, /panen fee posisi #/);
  } finally { f.store.db.close(); }
});

test('fees below the minimum are not claimed', async () => {
  const f = fixture();
  try {
    f.c.configure(f.id, { enabled: true, mode: 'claim', minUsd: 5 });
    f.store.run('UPDATE positions SET fees_quote=? WHERE id=?', 0.3, f.id);
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 0);
    assert.match(f.c.status(f.pos()).lastNote, /minimum klaim/);
  } finally { f.store.db.close(); }
});

test('a manual claim sells nothing unless asked', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id);
    assert.equal(f.dijual.length, 0);
    // Nothing is sold, but the memecoin is booked in the fee ledger so a later manual swap can correct the estimate.
    const ledger = f.store.all('SELECT * FROM fee_leftovers');
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].amount, '150000');
    await f.e.claimFees(f.id, { sell: true });
    assert.equal(f.dijual.length, 1);
    assert.equal(f.store.all('SELECT * FROM fee_leftovers').length, 2, 'selling does not book the claim a second time');
  } finally { f.store.db.close(); }
});

test('the fee sale proceeds replace the claim price estimate, also after the position is closed', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id, { sell: false });
    assert.equal(f.pos().claimed_quote, 0.3);
    // Sold for just $0.05, not $0.15: the estimate is replaced by the actual result.
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 150000n, quoteToken: ADDR.usdg,
      amountOut: '50000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().claimed_quote - 0.2) < 1e-9);
    assert.equal(f.store.get("SELECT amount FROM fee_leftovers").amount, '0');
    // Closed position: markClosed has already folded claimed_quote into out_quote, so
    // the next correction must hit both.
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '100000', estQuote: 0.1 });
    f.e.positions.markClosed(f.id, { out0: '0', out1: '0', outQuote: 1, txHash: null, exitSqrt: null });
    const before = f.pos().out_quote;
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 100000n, quoteToken: ADDR.usdg,
      amountOut: '20000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().out_quote - (before - 0.08)) < 1e-9);
  } finally { f.store.db.close(); }
});

test('fee memecoin that vanished from the wallet stops using the claim price estimate', async () => {
  const f = fixture();
  try {
    await f.e.claimFees(f.id, { sell: false });
    // Sold on another DEX / sent out: the wallet balance is down to zero.
    f.e.positions.rpc = { ethCallMany: async (calls) => calls.map(() => coder.encode(['uint256'], [0n])) };
    f.e.positions.poolLiquidityOf = async () => 1n;
    await f.e.positions.refreshLeftovers(3000, ME);
    assert.equal(f.store.get('SELECT amount FROM fee_leftovers').amount, '0', 'fee ledger closed');
    // Valued at the current pool price (same as the claim price in this fixture).
    assert.ok(Math.abs(f.pos().claimed_quote - 0.3) < 1e-9);
  } finally { f.store.db.close(); }
});

test('one sale is split between the fee ledger and the close-leftover ledger', async () => {
  const f = fixture();
  try {
    f.e.positions.noteFeeLeftover({ posId: f.id, token: TOKEN, amount: '100000', estQuote: 0.1 });
    f.e.positions.markClosed(f.id, { out0: '0', out1: '0', outQuote: 1, txHash: null, exitSqrt: null,
      left: { token: TOKEN, amount: '100000', quote: 0.1 } });
    const out0 = f.pos().out_quote, claimed0 = f.pos().claimed_quote;
    // 200000 tokens (100000 from each ledger) only sold for 100000 USDG-units = $0.10, so
    // each ledger receives $0.05 in place of its $0.10 estimate.
    f.e.positions.recordTokenSale({ posId: f.id, token: TOKEN, amount: 200000n, quoteToken: ADDR.usdg,
      amountOut: '100000', ethUsd: 3000 });
    assert.ok(Math.abs(f.pos().claimed_quote - (claimed0 - 0.05)) < 1e-9, 'fee ledger: estimate 0.10 becomes result 0.05');
    // out_quote carries both: the fee ledger correction (position already closed) −0.05
    // and the closing-leftover correction −0.05.
    assert.ok(Math.abs(f.pos().out_quote - (out0 - 0.1)) < 1e-9);
    assert.equal(f.pos().left_amount, '0');
    assert.equal(f.store.get('SELECT amount FROM fee_leftovers').amount, '0');
  } finally { f.store.db.close(); }
});

test('compound v3 memakai multicall collect + increaseLiquidity', async () => {
  const f = fixture({ venue: 'v3' });
  try {
    f.state.fee0 = 5_000_000n; f.state.fee1 = 5_000_000n;
    assert.equal(f.c.status(f.pos()).supported, true);
    f.c.configure(f.id, { enabled: true, mode: 'compound', minUsd: 1 });
    await f.c.tick(Date.now());
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'compound');
    const iface = new ethers.Interface(ABI.npmV3);
    const [calls] = iface.decodeFunctionData('multicall', f.sent[0].tx.data);
    assert.equal(calls.length, 2);
    const collect = iface.decodeFunctionData('collect', calls[0])[0];
    assert.equal(collect[0], 123n);
    assert.equal(collect[1].toLowerCase(), ME);
    const inc = iface.decodeFunctionData('increaseLiquidity', calls[1])[0];
    assert.equal(inc[0], 123n);
    assert.ok(inc[1] > 0n && inc[2] > 0n, 'both fee sides are used');
    assert.ok(inc[3] <= inc[1] && inc[4] <= inc[2], 'mins do not exceed what was requested');
    assert.equal(f.store.all('SELECT * FROM compound_runs').length, 1);
  } finally { f.store.db.close(); }
});

test('the target\'s harvest is recorded, not mirrored, and sounds if repeated', async () => {
  const f = fixture();
  try {
    f.store.run('INSERT INTO targets(chain,address,enabled,added_ts) VALUES(?,?,1,?)', 'robinhood', TARGET, Date.now());
    f.store.run('UPDATE positions SET mirror_of=? WHERE id=?', '777', f.id);
    const action = (i) => {
      const r = f.store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, 'robinhood', Date.now(), 100 + i, '0x' + String(i).padStart(64, '0'), i,
      TARGET, 'v4', 'claim', '777', POOL);
      return f.e.actFromRow(f.store.get('SELECT * FROM actions WHERE id=?', Number(r.lastInsertRowid)));
    };
    for (let i = 1; i <= 2; i++) await f.e.handle(action(i));
    assert.equal(f.sent.length, 0, 'a target claim never triggers a transaction');
    assert.equal(f.notice.length, 0, 'harvesting once or twice is normal');
    const verdictVal = f.store.all('SELECT * FROM decisions ORDER BY id');
    assert.equal(verdictVal.length, 2);
    assert.equal(verdictVal[0].verdict, 'skip');
    assert.match(verdictVal[1].reason, /panen fee/);
    await f.e.handle(action(3));
    assert.equal(f.notice.length, 1);
    assert.match(f.notice[0].msg, /3× dalam 24 jam/);
    assert.equal(f.notice[0].detail.kind, 'target_claim');
    assert.equal(f.notice[0].detail.positionId, f.id);
    // Silenced after it sounded: the fourth harvest does not repeat the same news.
    await f.e.handle(action(4));
    assert.equal(f.notice.length, 1);
  } finally { f.store.db.close(); }
});

test('follow_claim rule: the target\'s harvest also claims the mirror\'s fees', async () => {
  const f = fixture();
  try {
    f.store.run('INSERT INTO targets(chain,address,enabled,added_ts,rules) VALUES(?,?,1,?,?)', 'robinhood', TARGET, Date.now(),
      JSON.stringify({ exit: { follow_claim: true } }));
    f.store.run('UPDATE positions SET mirror_of=? WHERE id=?', '777', f.id);
    const action = (i, tokenId = '777') => {
      const r = f.store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref)
        VALUES(?,?,?,?,?,?,?,?,?,?)`, 'robinhood', Date.now(), 100 + i, '0x' + String(i).padStart(64, '0'), i,
      TARGET, 'v4', 'claim', tokenId, POOL);
      return f.e.actFromRow(f.store.get('SELECT * FROM actions WHERE id=?', Number(r.lastInsertRowid)));
    };
    await f.e.handle(action(1));
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].kind, 'claim_fees');
    let d = f.store.get('SELECT * FROM decisions ORDER BY id DESC LIMIT 1');
    assert.equal(d.verdict, 'copy');
    assert.equal(d.position_id, f.id);
    assert.equal(d.tx_hash, '0x' + '1'.padStart(64, '0'));
    assert.match(d.reason, /ikut klaim fee posisi #/);
    // Target position we do not mirror: nothing is claimed.
    await f.e.handle(action(2, '999'));
    assert.equal(f.sent.length, 1);
    // Manual control: the claim is not followed.
    f.store.run('UPDATE positions SET takeover_ts=? WHERE id=?', Date.now(), f.id);
    await f.e.handle(action(3));
    assert.equal(f.sent.length, 1);
    d = f.store.get('SELECT * FROM decisions ORDER BY id DESC LIMIT 1');
    assert.equal(d.verdict, 'skip');
    assert.match(d.reason, /kendali manual/);
  } finally { f.store.db.close(); }
});
