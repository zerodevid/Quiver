'use strict';
// Test: a position whose liquidity is zero on chain without a recorded close is NOT booked at $0
// if the proceeds can be found.
//
// Real case (12 Sep): #45 ($110) withdrawn manually through Uniswap → the sync saw
// liquidity 0 → closed with out_quote 0 = "loss $110", although 112 USDG entered the wallet.
// Second case: the bot's exit tx was sent, the receipt could not be read (RPC down) → the position
// stayed open → the next sync closed it at $0 the same way.
//
// Run: node test/exit-deferred.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Positions } = require('../src/positions');
const { ADDR, TOPIC } = require('../src/chain');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const ME = '0x' + '11'.repeat(20);
const TX = '0x' + 'c1'.repeat(32), TX_OLD = '0x' + 'c0'.repeat(32);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const pad = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const sqrt = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));
const xfer = (token, from, to, v) => ({ address: token, topics: [TOPIC.transfer, pad(from), pad(to)], data: hex(v) });
// withdraw receipt: 112 USDG (+ optional MEME) entered the wallet
const receipt = ({ usdg = 112_000_000n, meme = 0n, status = '0x1' } = {}) => ({
  status, gasUsed: '0x0', effectiveGasPrice: '0x0',
  logs: [xfer(ADDR.usdg, ADDR.poolManager, ME, usdg), ...(meme ? [xfer(MEME, ADDR.poolManager, ME, meme)] : [])],
});
const modLog = (tokenId, delta, txHash, block) => ({
  address: ADDR.poolManager, topics: [TOPIC.modifyLiquidity, POOL, pad(ME)], transactionHash: txHash, blockNumber: '0x' + block.toString(16),
  data: '0x' + [hex(0).slice(2), hex(0).slice(2), hex(BigInt.asUintN(256, delta)).slice(2), hex(tokenId).slice(2)].join(''),
});

// st.liq: #1's liquidity on chain; st.receipts: hash -> receipt|null; st.logs: ModifyLiquidity logs
function world(st) {
  const store = new Store(':memory:');
  const e = Object.create(Engine.prototype);
  e.store = store; e.cfg = { loop: {} }; e.ethUsd = 2500; e.exiting = new Set(); e.stats = { errors: 0 };
  e.log = () => {}; e.notified = [];
  e.notify = (msg, d) => e.notified.push({ msg, d });
  e.rulesFrom = () => ({ exit: { sell_leftover: false }, swap: {} });
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    token: async (a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 }),
    slot0V4: async () => ({ sqrtPriceX96: sqrt, tick: 0 }),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrt, tick: 0 })),
    poolLiquidity: async () => 1n, poolLiquidityMany: async (ids) => ids.map(() => 1n),
    markSqrtForPair: async () => null,
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 / 1000, kind: 'usd' }),
  };
  e.chain = chain;
  e.rpc = {
    ethCallMany: async (calls) => calls.map((c) => (c.to === ADDR.posmV4 ? hex(st.liq) : hex(0))),
    call: async (m, p) => {
      if (m === 'eth_getTransactionReceipt') { if (st.rpcDown) throw new Error('429'); return st.receipts[p[0]] ?? null; }
      if (m === 'eth_blockNumber') return '0x' + (10_000).toString(16);
      throw new Error('tidak diharapkan: ' + m);
    },
    getLogs: async (f) => {
      st.getLogsCalls = (st.getLogsCalls || 0) + 1;
      if (st.logsDown) throw new Error('semua endpoint tumbang');
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return (st.logs || []).filter((l) => parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
    },
  };
  e.exec = { address: () => ME, balances: async (l) => new Map(l.map((a) => [a, 0n])) };
  e.positions = new Positions({ rpc: e.rpc, store, chain, log: () => {} });
  store.setState('wallet_address', ME);
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,cost1,quote_symbol,liquidity,target,mirror_of)
    VALUES('v4',?,'77',?,?,-100,100,'open',?,110,'110000000','USDG','5000000',?,'99')`, POOL, ADDR.usdg, MEME, Date.now() - 60_000, '0x' + '22'.repeat(20));
  return { e, store, id: Number(r.lastInsertRowid), st };
}
const pos = (d) => d.store.get('SELECT * FROM positions WHERE id=?', d.id);
const txRow = (d, kind, hash, detail) => d.store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', hash, Date.now(), kind, 'pending', JSON.stringify(detail));

(async () => {
  console.log('exit-deferred:');

  await t('manual withdrawal (without a bot tx): proceeds are looked up from the ModifyLiquidity log, not $0', async () => {
    const d = world({ liq: 0n, receipts: { [TX]: receipt() }, logs: [modLog(77n, 5_000_000n, TX_OLD, 9000), modLog(77n, -5_000_000n, TX, 9900)] });
    await d.e.positions.sync(2500);
    const [trig] = d.e.positions.exitTriggers({ exit: {} });
    assert.ok(trig?.pos.empty, 'read as empty');
    await d.e.closeEmptyPosition(trig.pos);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX);
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `out_quote ${p.out_quote}`);
    assert.ok(d.e.notified.some((n) => /dicatat dari log ModifyLiquidity/.test(n.msg)));
  });

  await t('ModifyLiquidity logs of ANOTHER position in the same pool are ignored', async () => {
    const d = world({ liq: 0n, receipts: { [TX]: receipt() }, logs: [modLog(78n, -5_000_000n, TX, 9900)], logsDown: false });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, null);
    assert.strictEqual(p.out_quote, 0);
    assert.ok(d.e.notified.some((n) => /tidak ditemukan/.test(n.msg)), 'pemilik dikabari');
  });

  await t('bot exit tx whose receipt is not yet readable: the close is DEFERRED, not $0', async () => {
    const d = world({ liq: 0n, receipts: {} });
    txRow(d, 'burn', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    assert.strictEqual(pos(d).status, 'open');
    assert.strictEqual(d.st.getLogsCalls || 0, 0, 'no getLogs needed: the tx is already known');
    // the receipt is finally readable → booked from the receipt
    d.st.receipts[TX] = receipt();
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    const p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX);
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `out_quote ${p.out_quote}`);
  });

  await t('a partial withdrawal that was not booked (receipt failed) is booked later by bookPendingExits', async () => {
    const d = world({ liq: 3_000_000n, receipts: {}, rpcDown: true });
    txRow(d, 'decrease', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();                       // RPC still down: that is fine
    assert.strictEqual(pos(d).out_quote, 0);
    d.st.rpcDown = false; d.st.receipts[TX] = receipt({ usdg: 40_000_000n });
    await d.e.bookPendingExits();
    let p = pos(d);
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.liquidity, '3000000');
    assert.ok(Math.abs(p.out_quote - 40) < 1e-6, `out_quote ${p.out_quote}`);
    // not booked twice
    await d.e.bookPendingExits();
    p = pos(d);
    assert.ok(Math.abs(p.out_quote - 40) < 1e-6, `dobel: ${p.out_quote}`);
    // a partial-withdrawal tx that was ALREADY booked is no longer used to close: the close proceeds are looked up from the logs
    d.st.liq = 0n; d.st.logs = [modLog(77n, -3_000_000n, TX_OLD, 9950)]; d.st.receipts[TX_OLD] = receipt({ usdg: 70_000_000n });
    await d.e.positions.sync(2500);
    await d.e.closeEmptyPosition(d.e.positions.live[0]);
    p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.tx_close, TX_OLD);
    assert.ok(Math.abs(p.out_quote - 110) < 1e-6, `total out ${p.out_quote}`);
  });

  await t('race: the bot close was already booked between the sync and closeEmptyPosition → NOT booked again', async () => {
    // lp3 #220 (2026-09-21): the sync read the position as empty just as the bot's burn landed; the
    // exit flow booked +150, then the trigger loop called closeEmptyPosition with a stale
    // position object (status open) → the same tx was found again via the logs → out_quote 300.
    const d = world({ liq: 0n, receipts: { [TX]: receipt() }, logs: [modLog(77n, -5_000_000n, TX, 9900)] });
    txRow(d, 'burn', TX, { position: d.id });
    await d.e.positions.sync(2500);
    const stale = d.e.positions.live[0];
    assert.ok(stale.empty);
    // the bot's exit flow books it first
    await d.e.recordExit({ full: true, liquidity: '0' }, pos(d), TX, receipt());
    let p = pos(d);
    assert.strictEqual(p.status, 'closed');
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `out_quote ${p.out_quote}`);
    // the trigger loop's turn with the stale object
    await d.e.closeEmptyPosition(stale);
    p = pos(d);
    assert.ok(Math.abs(p.out_quote - 112) < 1e-6, `dobel: ${p.out_quote}`);
    assert.strictEqual(p.out0, '112000000');
    assert.ok(!d.e.notified.some((n) => /di luar alur bot/.test(n.msg)), 'not reported as a close outside the bot');
    // the last fence: markClosed refuses a position that is already closed
    assert.throws(() => d.e.positions.markClosed(d.id, { out0: 1n, out1: 0n, outQuote: 1, txHash: TX }), /sudah closed/);
    assert.ok(Math.abs(pos(d).out_quote - 112) < 1e-6);
  });

  await t('an exit tx that reverted is flagged failed and not booked', async () => {
    const d = world({ liq: 5_000_000n, receipts: { [TX]: receipt({ status: '0x0' }) } });
    txRow(d, 'burn', TX, { position: d.id });
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();
    assert.strictEqual(pos(d).status, 'open');
    assert.strictEqual(d.store.get('SELECT status FROM txs WHERE hash=?', TX).status, 'gagal');
  });

  await t('a position in the middle of exiting is not touched', async () => {
    const d = world({ liq: 0n, receipts: { [TX]: receipt() } });
    txRow(d, 'burn', TX, { position: d.id });
    d.e.exiting.add(d.id);
    await d.e.positions.sync(2500);
    await d.e.bookPendingExits();
    assert.strictEqual(pos(d).status, 'open');
  });

  await t('a mint whose receipt was delayed is booked later with the target link & capital from the receipt', async () => {
    const d = world({ liq: 5_000_000n, receipts: {} });
    const TGT = '0x' + '22'.repeat(20);
    const plan = { venue: 'v4', action: 'mint', poolRef: POOL, poolKey: { hooks: ADDR.native }, token0: ADDR.usdg, token1: MEME, fee: 3000, tickSpacing: 60,
      tickLower: -100, tickUpper: 100, liquidity: '4000000', amount0Max: '99000000', amount1Max: '0', valueQuote: 95, valueUsd: 95, quoteSymbol: 'USDG', target: TGT, mirrorOf: '555' };
    d.store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', TX, Date.now() - 5 * 60_000, 'mint', 'pending',
      JSON.stringify({ pool: POOL, target: TGT, venue: 'v4', plan, zapped: null }));
    await d.e.bookPendingMints();                     // no receipt yet, < 30 minutes: wait
    assert.strictEqual(d.store.all("SELECT id FROM positions WHERE mirror_of='555'").length, 0);
    // receipt: 95 USDG left the wallet, NFT #4242 minted to us
    d.st.receipts[TX] = { status: '0x1', gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
      xfer(ADDR.usdg, ME, ADDR.poolManager, 95_000_000n),
      { address: ADDR.posmV4, topics: [TOPIC.transfer, pad('0x' + '0'.repeat(40)), pad(ME), hex(4242)], data: '0x' },
    ] };
    await d.e.bookPendingMints();
    const p = d.store.get("SELECT * FROM positions WHERE mirror_of='555'");
    assert.ok(p, 'position recorded');
    assert.strictEqual(p.token_id, '4242');
    assert.strictEqual(p.target, TGT);
    assert.strictEqual(p.cost0, '95000000');
    assert.ok(Math.abs(p.cost_quote - 95) < 1e-6, `cost ${p.cost_quote}`);
    assert.strictEqual(p.tx_open, TX);
    assert.ok(d.e.notified.some((n) => /dibukukan belakangan/.test(n.msg)));
    await d.e.bookPendingMints();                     // not doubled
    assert.strictEqual(d.store.all("SELECT id FROM positions WHERE mirror_of='555'").length, 1);
  });

  await t('mint reverted after the zap: flagged failed, the zap token goes into the sell queue', async () => {
    const d = world({ liq: 5_000_000n, receipts: { [TX]: receipt({ status: '0x0' }) } });
    d.e.exec.balances = async (l) => new Map(l.map((a) => [a, a === MEME ? 700n : 0n]));
    d.e.rulesFrom = () => ({ exit: {}, swap: {} });
    d.store.run('INSERT INTO txs(hash,ts,kind,status,detail) VALUES(?,?,?,?,?)', TX, Date.now() - 5 * 60_000, 'mint', 'pending',
      JSON.stringify({ pool: POOL, target: null, venue: 'v4', plan: { action: 'mint', liquidity: '1' }, zapped: { token: MEME, quote: ADDR.usdg, before: '100' } }));
    await d.e.bookPendingMints();
    assert.strictEqual(d.store.get('SELECT status FROM txs WHERE hash=?', TX).status, 'gagal');
    const q = JSON.parse(d.store.getState('leftovers:robinhood'));
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].amount, '600');           // only what was bought (700 − 100)
    assert.strictEqual(q[0].source, 'zap');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
