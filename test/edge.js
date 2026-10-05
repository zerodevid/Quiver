'use strict';
// Edge case tests of the copy-LP engine.
//
// All tests here use the REAL CODE (policy/engine/watcher). Only the outer boundaries are
// faked: the chain and transaction submission. The goal is to answer one question —
// "if the target does X, does the bot make the right decision?" — for
// action shapes that rarely happen but are expensive to get wrong.
//
// Run: node test/edge.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';

// The pool price is pinned in the middle of the test range so the position needs both tokens.
const TICK = 0;
const SQRT = m.getSqrtRatioAtTick(TICK);

function harness({ balances = {}, rules = {}, positions = [], targetLiquidityAfter = null } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const tokens = {
    [USDG]: { address: USDG, symbol: 'USDG', decimals: 6 },
    [ETH]: { address: ETH, symbol: 'ETH', decimals: 18 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const chain = {
    tokens: async (list) => list.map((a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    token: async (a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 },
    slot0V4: async () => ({ sqrtPriceX96: SQRT, tick: TICK }),
    slot0V3: async () => ({ sqrtPriceX96: SQRT, tick: TICK }),
    poolLiquidity: async () => 10n ** 24n,
    poolAgeMinutes: async () => 10_000,
    ethUsd: async () => 2500,
    quoteSideOf(t0, t1) {
      const q = { [USDG]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ETH]: { symbol: 'ETH', decimals: 18, kind: 'eth' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
    blockTs: async (b) => b * 101,
  };
  const cfg = { mode: { dry_run: false, paused: false }, rules, gas: {}, loop: {} };
  // getPositionLiquidity is used by handleExit to compute the target's L BEFORE the action.
  const rpc = {
    ethCallMany: async (c) => c.map(() => (targetLiquidityAfter == null ? '0x' : '0x' + targetLiquidityAfter.toString(16).padStart(64, '0'))),
    // the tx receipt whose log is seen certainly exists on chain (no liquidity logs here);
    // getCode = '0x' (EOA)
    batch: async (c) => c.map((x) => ({ result: x.method === 'eth_getTransactionReceipt' ? { logs: [] } : x.method === 'eth_getCode' ? '0x' : null })),
    blockNumber: async () => 1e6, call: async () => null,
  };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  eng.ethUsd = 2500;
  const sent = [];
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((t) => [String(t).toLowerCase(), BigInt(balances[String(t).toLowerCase()] ?? 0)]));
  eng.exec.send = async (tx, meta) => { sent.push({ kind: meta?.kind, tx }); return '0x' + (sent.length + '').padStart(64, '0'); };
  eng.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [], gasUsed: '0x0', effectiveGasPrice: '0x0' } });
  eng.exec.ensureAllowance = async () => [];
  eng.exec.ensureRouterAllowance = async () => [];
  eng.exec.deadline = () => 9e9;
  eng.kyber.swap = async () => ({ hash: '0xswap', amountOut: 10n ** 24n, quote: { dex: 'uji', usdIn: 1, usdOut: 1 } });
  eng.notify = () => {};
  for (const p of positions) store.run(
    `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
      target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,last_sync)
     VALUES('v4',?,?,?,?,?,?,?,?,?,?,?,?,'open',?,'0','0',?,?,?)`,
    p.tokenId, POOL, p.token0 || USDG, p.token1 || MEME, 3000, 60, ADDR.native,
    p.tickLower ?? -600, p.tickUpper ?? 600, p.liquidity, TARGET, p.mirrorOf, Date.now(), p.cost ?? 100, 'USDG', Date.now());
  return { eng, store, sent };
}

// A target action shaped as the watcher produces it.
function action(over = {}) {
  const liq = 10n ** 20n;
  return {
    id: null, ts: Date.now(), block: 1000, txHash: '0xtx', logIndex: 1,
    target: TARGET, venue: 'v4', kind: 'increase', tokenId: '999',
    poolRef: POOL, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
    token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    tickLower: -600, tickUpper: 600, liquidity: liq.toString(),
    amount0: '0', amount1: '0', valueQuote: 400, quoteSymbol: 'USDG',
    slot0: { sqrtPriceX96: SQRT, tick: TICK },
    ...over,
  };
}
const rec = (store, act) => {
  const r = store.run(
    `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
      tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    act.ts, act.block, act.txHash + Math.random(), act.logIndex, act.target, act.venue, act.kind, act.tokenId,
    act.poolRef, act.token0, act.token1, act.fee, act.tickSpacing, act.hooks, act.tickLower, act.tickUpper,
    act.liquidity, act.amount0, act.amount1, act.valueQuote, act.quoteSymbol);
  act.id = Number(r.lastInsertRowid);
  return act;
};
const verdictOf = (store) => store.get('SELECT verdict, reason FROM decisions ORDER BY id DESC LIMIT 1');

const RICH = { [USDG]: 10n ** 12n, [MEME]: 10n ** 30n, [ETH]: 10n ** 19n };
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  OK   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + e.message.split('\n')[0]); fail++; }
}

(async () => {
  console.log('copy-LP engine edge case tests\n');

  await t('target adds to a position we already mirror -> adds, not opening a new position', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 19n).toString() }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.match(v.reason, /menambah posisi/, v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'increase').length, 1, 'must send an increase');
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1, 'there must be no second position');
  });

  await t('target withdraws PARTIALLY -> we withdraw proportionally, the position stays open', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,   // target withdraws 40%, leaving 60%
    });
    const a = action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() });
    await eng.handle(rec(store, a));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'decrease').length, 1, 'must be a decrease, not a burn');
    const p = store.get('SELECT status, liquidity FROM positions');
    assert.strictEqual(p.status, 'open', 'the position must stay open');
    assert.strictEqual(p.liquidity, (6n * 10n ** 19n).toString(), 'sisa L salah: ' + p.liquidity);
  });

  // ---- exit retry ------------------------------------------------------
  // An exit signal is only decided once; if the broadcast fails, our position
  // is left open. Retried — but only while the exit tx has not been sent.
  const exitHarness = (sendFn) => {
    const h = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,
    });
    h.eng.exitRetryWaits = [1, 1, 1];
    h.eng.chainLiquidity = async () => 10n ** 20n;   // our position on chain has not changed
    h.eng.exec.txLanded = async () => false;
    let n = 0;
    h.eng.exec.send = async (tx, meta) => sendFn(++n, meta, h);
    h.tries = () => n;
    return h;
  };
  const decreaseAct = () => action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() });

  await t('exit broadcast rejected by the RPC once -> retried and succeeds', async () => {
    const h = exitHarness((n, meta) => {
      if (n === 1) throw Object.assign(new Error('eth_sendRawTransaction: Method not found'), { txHash: '0xaa' });
      h.sent.push({ kind: meta?.kind });
      return '0x' + 'bb'.repeat(32);
    });
    await h.eng.handle(rec(h.store, decreaseAct()));
    const v = verdictOf(h.store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(h.tries(), 2);
    assert.strictEqual(h.store.get('SELECT liquidity FROM positions').liquidity, (6n * 10n ** 19n).toString());
  });

  await t('exit broadcast keeps failing -> gives up after 4 attempts, an error is recorded', async () => {
    const h = exitHarness(() => { throw new Error('eth_sendRawTransaction: Method not found'); });
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.strictEqual(verdictOf(h.store).verdict, 'error');
    assert.strictEqual(h.tries(), 4);
  });

  await t('an exit tx thought to have failed actually landed -> NOT resent', async () => {
    const h = exitHarness(() => { throw Object.assign(new Error('timeout'), { txHash: '0xaa' }); });
    h.eng.exec.txLanded = async () => true;
    await h.eng.handle(rec(h.store, decreaseAct()));
    const v = verdictOf(h.store);
    assert.strictEqual(v.verdict, 'error');
    assert.match(v.reason, /ternyata masuk/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('our liquidity on chain has already decreased -> NOT resent', async () => {
    const h = exitHarness(() => { throw new Error('timeout'); });
    h.eng.chainLiquidity = async () => 6n * 10n ** 19n;
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.match(verdictOf(h.store).reason, /sudah berubah/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('exit tx sent but reverted -> NOT repeated', async () => {
    const h = exitHarness(() => '0x' + 'cc'.repeat(32));
    h.eng.exec.waitReceipt = async () => ({ ok: false, receipt: {} });
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.match(verdictOf(h.store).reason, /revert/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('RpcPool.sendRaw: satu endpoint "Method not found" -> endpoint lain menyiarkan', async () => {
    const { RpcPool } = require('../src/rpc');
    const pool = new RpcPool([{ url: 'https://baca.example' }, { url: 'https://kirim.example' }], () => {});
    pool.resolve = async () => [];
    pool.post = async (url) => (url.includes('baca')
      ? { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: 1, result: '0xhash' });
    assert.strictEqual(await pool.sendRaw('0x02'), '0xhash');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pool.eps[0].noSend, true, 'a read-only endpoint must be flagged');
    pool.post = async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'insufficient funds' } });
    await assert.rejects(() => pool.sendRaw('0x02'), /insufficient funds/);
  });

  await t('target moves the NFT to another wallet -> we close fully', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
    });
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'burn').length, 1, 'must burn');
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('deposit into an automation contract -> NOT treated as an exit', async () => {
    const { eng, store, sent } = harness({ balances: RICH, positions: [{ tokenId: '5', mirrorOf: '999', liquidity: '1' }] });
    await eng.handle(rec(store, action({ kind: 'custody_out' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0, 'must not send anything');
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'open');
  });

  await t('pool with a hook rejected while allow_hooks is off', async () => {
    const { eng, store } = harness({ balances: RICH });
    const hook = '0x1111111111111111111111111111111111111111';
    await eng.handle(rec(store, action({ hooks: hook, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: hook } })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /hook/i, v.reason);
  });

  await t('the open position count limit is respected', async () => {
    const { eng, store } = harness({
      balances: RICH, rules: { filters: { max_open_positions: 1 } },
      positions: [{ tokenId: '7', mirrorOf: 'lain', liquidity: '1' }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /posisi terbuka/i, v.reason);
  });

  await t('the pause between copies in the same pool is respected', async () => {
    const { eng, store } = harness({ balances: RICH, rules: { filters: { cooldown_seconds: 60 } } });
    eng.lastCopyAt.set(POOL, Date.now());
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /cooldown/i, v.reason);
  });

  await t('total exposure limit used up -> skipped, not forced', async () => {
    const { eng, store } = harness({
      balances: RICH,
      rules: { sizing: { mode: 'mirror', max_total_exposure_usd: 50, max_quote_per_position_usd: 200 } },
      positions: [{ tokenId: '7', mirrorOf: 'lain', liquidity: (10n ** 20n).toString(), cost: 50 }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /eksposur|minimum/i, v.reason);
  });

  await t('exit action without a mirror -> skipped silently, does not close other positions', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '9', mirrorOf: 'posisi-lain', liquidity: (10n ** 20n).toString(), tickLower: -1200, tickUpper: 1200 }],
    });
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: '-1' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'open');
  });

  await t('pair of two quote assets (ETH/USDG) -> no memecoin to sell', async () => {
    const { eng } = harness({ balances: RICH });
    const r = await eng.sellLeftover(
      { id: 1, target: TARGET, token0: ETH, token1: USDG, pool_ref: POOL },
      { logs: [{ address: USDG, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x'.padEnd(66, '0'), '0x' + ME.slice(2).padStart(64, '0')], data: '0x' + (10n ** 6n).toString(16).padStart(64, '0') }] },
    );
    assert.strictEqual(r, null, 'must not sell a quote asset');
  });

  await t('leftover memecoin that failed to sell enters the retry queue', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    eng.kyber.swap = async () => { throw new Error('rute tidak ada'); };
    await assert.rejects(() => eng.sellToken({ posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0 }));
    const q = JSON.parse(store.getState('leftovers:robinhood', '[]'));
    assert.strictEqual(q.length, 1, 'must be stored to retry');
    assert.strictEqual(q[0].tries, 1);
    assert.ok(q[0].next > Date.now(), 'must be rescheduled');
  });

  await t('the sell queue never gives up: the item stays, rescheduled every few seconds', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    eng.kyber.swap = async () => { throw new Error('rute tidak ada'); };
    for (let i = 0; i < 20; i++) {
      const q = JSON.parse(store.getState('leftovers:robinhood', '[]'));
      const item = q[0] || { posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0 };
      await eng.sellToken(item).catch(() => {});
    }
    const q = JSON.parse(store.getState('leftovers:robinhood', '[]'));
    assert.strictEqual(q.length, 1, 'the item must stay stored — the money is still stuck');
    assert.strictEqual(q[0].tries, 20);
    assert.ok(q[0].since > 0, 'the time it started being stuck is recorded');
    assert.ok(q[0].next - Date.now() <= 5000 + 50 && q[0].next > Date.now(), 'scheduled every 5 seconds (default), not minutes');
  });

  await t('leftover hunter: each tick only QUOTES; a real swap only when the loss is already below the limit', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    let usdOut = 40, quotes = 0, swaps = 0;
    eng.kyber.quote = async () => { quotes++; return { usdIn: 100, usdOut, amountOut: 1n, dex: 'uji', routeSummary: {} }; };
    eng.kyber.swap = async () => { swaps++; return { hash: '0xjual', amountOut: 1n, quote: { usdIn: 100, usdOut, dex: 'uji' } }; };
    eng.saveLeftovers([{ posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0, next: 0 }]);
    await eng.retryLeftovers();
    assert.strictEqual(quotes, 1, 'one quote');
    assert.strictEqual(swaps, 0, 'loss 60% > 15%: do not swap');
    let q = JSON.parse(store.getState('leftovers:robinhood', '[]'));
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].lastLossBps, 6000, 'the last quote is stored for the dashboard');
    assert.match(q[0].why, /rugi 60\.0%/);
    // The schedule has not arrived -> the next tick does not re-quote.
    await eng.retryLeftovers();
    assert.strictEqual(quotes, 1, 'not yet its schedule: no new quote');
    // Liquidity improves: a 10% loss -> sold right away and the queue is empty.
    usdOut = 90;
    eng.saveLeftovers(q.map((x) => ({ ...x, next: 0 })));
    await eng.retryLeftovers();
    assert.strictEqual(swaps, 1, 'loss already below the limit: swap sent');
    assert.strictEqual(JSON.parse(store.getState('leftovers:robinhood', '[]')).length, 0, 'sold: leaves the queue');
  });

  await t('a leftover refused for sale is reported LOUDLY once at the start, then reminded every 6 hours — not every tick', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    const notice = [];
    eng.notify = (msg, d) => notice.push(d);
    eng.kyber.quote = async () => ({ usdIn: 229.44, usdOut: 90.01, amountOut: 1n, dex: 'uji', routeSummary: {} });
    eng.saveLeftovers([{ posId: 9, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0, next: 0 }]);
    for (let i = 0; i < 30; i++) {
      eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0 })));
      await eng.retryLeftovers();
    }
    let stuck = notice.filter((d) => d?.kind === 'leftover_stuck');
    assert.strictEqual(stuck.length, 1, 'only one notice for 30 consecutive failures');
    assert.strictEqual(stuck[0].tries, 1);
    assert.ok(Math.abs(stuck[0].lossBps - 6077) < 1, String(stuck[0].lossBps));
    assert.strictEqual(stuck[0].maxLossBps, 1500);
    assert.strictEqual(stuck[0].retrySec, 5);
    assert.ok(/60\.8%/.test(stuck[0].why), stuck[0].why);
    // Six hours later still stuck -> a reminder.
    eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0, alertedAt: Date.now() - 7 * 3600_000 })));
    await eng.retryLeftovers();
    stuck = notice.filter((d) => d?.kind === 'leftover_stuck');
    assert.strictEqual(stuck.length, 2, 'reminder after 6 hours');
    assert.strictEqual(stuck[1].reminder, true);
  });

  await t('one-sided position (range above the price) is still copied as a limit order', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    // the range is entirely ABOVE the current price -> only one token is needed
    await eng.handle(rec(store, action({ tickLower: 6000, tickUpper: 12000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((x) => x.kind === 'mint').length, 1);
  });

  await t('one-sided position is skipped if the rule says so', async () => {
    const { eng, store, sent } = harness({ balances: RICH, rules: { onesided: { policy: 'skip' } } });
    await eng.handle(rec(store, action({ tickLower: 6000, tickUpper: 12000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /satu sisi/i, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('target is switched off -> copies nothing', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    store.run('UPDATE targets SET enabled=0 WHERE address=?', TARGET);
    await eng.handle(rec(store, action()));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
  });

  await t('bot paused -> copies nothing', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    store.setState('paused', '1');
    await eng.handle(rec(store, action()));
    assert.match(verdictOf(store).reason, /dijeda/i);
    assert.strictEqual(sent.length, 0);
  });

  // Kyber with no route -> fallback to a direct swap into a pool. What is used is NOT the position's pool
  // as it is, but the best pool for that pair (see test/zap-pool.js for its
  // picker). Only on the open-position path: leftover sales & closing positions stay Kyber only.
  await t('zap without a Kyber route -> swap via the cheapest-fee pool, not the position\'s pool', async () => {
    const { eng, store, sent } = harness({ balances: { ...RICH, [MEME]: 0n } });
    eng.kyber.swap = async () => null;
    // Another pool for the same pair, much cheaper than the position's pool (0.3%).
    store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block)
      VALUES(?,'v4',?,?,500,10,?,1)`, '0x' + 'be'.repeat(32), USDG, MEME, '0x' + '0'.repeat(40));
    eng.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: SQRT, tick: TICK, lpFee: 0 }));
    eng.chain.poolLiquidityMany = async (ids) => ids.map(() => 10n ** 24n);
    // Every simulated candidate has its transaction built; what decides
    // is which transaction is finally SENT.
    // (one pool can be built twice: two v4 swap params shapes are simulated too)
    const built = [];
    const original = eng.exec.buildSwapV4.bind(eng.exec);
    eng.exec.buildSwapV4 = (key, ...rest) => {
      const tx = original(key, ...rest);
      built.push({ key, tx });
      return tx;
    };
    // MEME only exists in the wallet AFTER the zap is sent — without this the zap round thinks
    // the price moved and cancels the opening.
    let meme = 0n;
    const sendOrig = eng.exec.send;
    eng.exec.send = async (tx, meta) => {
      if (meta?.kind === 'zap_swap') meme = 10n ** 30n;
      return sendOrig(tx, meta);
    };
    eng.exec.balances = async (list) => new Map(list.map((a) => {
      const k = String(a).toLowerCase();
      return [k, k === MEME ? meme : BigInt(RICH[k] ?? 0)];
    }));
    await eng.handle(rec(store, action()));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    const zap = sent.find((s) => s.kind === 'zap_swap');
    assert.ok(zap, 'the zap must be sent via a direct pool');
    const fee = new Set(built.map((d) => d.key.fee));
    assert.ok(fee.has(500) && fee.has(3000), 'both pools must be evaluated');
    const consumed = built.find((d) => d.tx.data === zap.tx.data);
    assert.ok(consumed, 'what is sent must be one of the simulated calldatas');
    assert.strictEqual(consumed.key.fee, 500, 'the 0.05% pool must beat the position\'s 0.3% pool');
    assert.strictEqual(consumed.key.tickSpacing, 10, 'poolKey is taken from the chosen pool, not the position\'s pool');
  });

  await t('bridge fails midway through execution -> a clear error, no position recorded', async () => {
    const { eng, store } = harness({ balances: { ...RICH, [MEME]: 0n } });
    eng.kyber.swap = async () => null;               // no patching route
    eng.ensureQuoteAsset = async () => { throw new Error('kas kurang untuk jembatan: butuh 0.07 ETH untuk 170.00 USDG, punya 0.01 ETH'); };
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'error', v.reason);
    assert.strictEqual(store.all("SELECT id FROM positions").length, 0, 'must not record a position that failed to open');
  });

  // A wallet exactly like on the server when Bang GE entered $1,000 (cap $200): cash
  // mostly in WETH, native ETH below the gas reserve. It used to say: "ETH balance
  // empty — no cash to bridge" although there was ~$173 of WETH.
  const e18 = (x) => BigInt(Math.round(x * 1e18));
  const WALLET_SERVER = { [USDG]: 36_107_783n, [ADDR.weth]: e18(0.069436618), [ETH]: e18(0.000861055) };
  // Balances that also change through unwrap and the Kyber swap — without this the step after the
  // bridge (zap, mint) reads the old balance and the result is meaningless.
  // `rate` = the ETH price on Kyber (USDG per ETH); the bot itself values ETH at 2500.
  function liveWallet(eng, sent, initial, rate = 2500n) {
    const bal = new Map(Object.entries(initial).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
    const get = (a) => bal.get(String(a).toLowerCase()) || 0n;
    const add = (a, x) => bal.set(String(a).toLowerCase(), get(a) + x);
    // USDG<->MEME 1:1 in raw units (pool price at tick 0).
    const conv = (a, b, x) => {
      a = String(a).toLowerCase(); b = String(b).toLowerCase();
      if (a === ETH && b === USDG) return (x * rate) / 10n ** 12n;
      if (a === USDG && b === ETH) return (x * 10n ** 12n) / rate;
      return x;
    };
    eng.exec.balances = async (list) => new Map(list.map((a) => [String(a).toLowerCase(), get(a)]));
    eng.exec.send = async (tx, meta) => {
      if (meta?.kind === 'unwrap_weth') { const amt = BigInt('0x' + tx.data.slice(10)); add(ADDR.weth, -amt); add(ETH, amt); }
      sent.push({ kind: meta?.kind, tx });
      return '0x' + (sent.length + '').padStart(64, '0');
    };
    eng.kyber.quote = async (a, b, x) => ({ amountOut: conv(a, b, x) });
    eng.kyber.swap = async (a, b, x, o) => {
      if (get(a) < x) throw new Error(`swap melebihi saldo ${a}`);
      const out = conv(a, b, x);
      add(a, -x); add(b, out);
      sent.push({ kind: o?.kind || 'swap', from: a, to: b, amountIn: x });
      return { hash: '0xswap', amountOut: out, quote: { dex: 'uji', usdIn: 1, usdOut: 1 } };
    };
    return { get };
  }

  await t('cash as WETH + native ETH below the reserve -> WETH is used, the position opens', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 200, max_total_exposure_usd: 400 } } });
    const w = liveWallet(eng, sent, WALLET_SERVER);
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.match(v.reason, /kas tersedia/, 'cash ~$206 is not enough for $200 + reserve — the size must be cut to the cash');
    const kinds = sent.map((x) => x.kind);
    assert.ok(kinds.includes('unwrap_weth'), kinds.join(','));
    assert.ok(sent.some((x) => x.kind === 'bridge_swap' && x.from === ETH), 'the ETH -> USDG bridge must run');
    assert.ok(w.get(ETH) >= 1_900_000_000_000_000n, `the gas reserve must be refilled, left ${w.get(ETH)}`);
    const plan = JSON.parse(store.get('SELECT plan FROM decisions ORDER BY id DESC LIMIT 1').plan);
    assert.ok(plan.valueUsd > 150 && plan.valueUsd < 200, `ukuran ${plan.valueUsd}`);
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1);
  });

  await t('Kyber rate 0.8% worse than the bot\'s ETH price -> a tight size is still paid', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 200, max_total_exposure_usd: 400 } } });
    liveWallet(eng, sent, WALLET_SERVER, 2480n);
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
  });

  await t('cash in the pool\'s own quote asset is not cut by bridge room', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 500, max_total_exposure_usd: 1000 } } });
    liveWallet(eng, sent, { [USDG]: 210_000_000n, [ETH]: e18(0.002) });
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    const plan = JSON.parse(store.get('SELECT plan FROM decisions ORDER BY id DESC LIMIT 1').plan);
    assert.ok(Math.abs(plan.valueUsd - 200) < 0.5, `210 USDG / 1,05 = $200, dapat ${plan.valueUsd}`);
    assert.ok(!sent.some((x) => x.kind === 'bridge_swap'), 'no bridge needed');
  });

  await t('little cash -> the reason "below the minimum" names cash as the cause', async () => {
    const { eng, store, sent } = harness({ balances: { [USDG]: 3_000_000n } });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /minimum.*kas tersedia/, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('WETH dust does not trigger a gas top-up unwrap', async () => {
    const { eng, sent } = harness({});
    liveWallet(eng, sent, { [ADDR.weth]: 10_000_000_000n, [ETH]: e18(0.0005) });
    const notes = [];
    await eng.topUpGas(notes);
    assert.strictEqual(sent.length, 0, sent.map((x) => x.kind).join(','));
  });

  await t('exit with native ETH below the reserve -> gas is topped up from WETH first, then burn', async () => {
    const { eng, store, sent } = harness({ positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }] });
    liveWallet(eng, sent, { ...RICH, [ETH]: e18(0.0005), [ADDR.weth]: e18(0.05) });
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.deepStrictEqual(sent.map((x) => x.kind).slice(0, 2), ['unwrap_weth', 'burn']);
  });

  await t('gas top-up fails (RPC down) -> exit STILL runs', async () => {
    const { eng, store, sent } = harness({ balances: RICH, positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }] });
    const bal0 = eng.exec.balances;
    let first = true;
    eng.exec.balances = async (list) => {
      if (first && list.includes(ADDR.weth)) { first = false; throw new Error('RPC 429'); }
      return bal0(list);
    };
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'burn').length, 1);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('cash empty -> skipped with a clear reason, without a transaction', async () => {
    const { eng, store, sent } = harness({ balances: { [ETH]: e18(0.0015) } });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /kas tersedia/, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('simulation mode is not limited by cash (the test wallet may be empty)', async () => {
    const { eng, store } = harness({ balances: {} });
    eng.cfg.mode.dry_run = true;
    eng.exec.simulate = async () => ({ ok: true, gas: 1 });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'dry', v.reason);
    assert.doesNotMatch(v.reason, /kas tersedia/, v.reason);
  });

  await t('bridge short of cash -> message in human units, not wei', async () => {
    const { eng, sent } = harness({});
    liveWallet(eng, sent, { [ADDR.weth]: e18(0.01), [ETH]: e18(0.001) });
    const plan = { quoteSide: 0, token0: USDG, token1: MEME };
    const rules = { swap: { enabled: true, max_slippage_bps: 100, max_price_impact_bps: 500 } };
    await assert.rejects(() => eng.ensureQuoteAsset(plan, rules, 200_000_000n), (e) => {
      assert.match(e.message, /butuh 0\.0808 ETH untuk 200\.00 USDG, punya 0\.01 ETH/, e.message);
      assert.match(e.message, /ETH\+WETH di atas cadangan gas 0\.002 ETH/, e.message);
      assert.doesNotMatch(e.message, /\d{10,}/, 'there must be no raw numbers');
      return true;
    });
    assert.strictEqual(sent.length, 0, 'nothing is sent if cash really is insufficient');
  });

  await t('result after being cut by the limit below the minimum -> skipped', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 3, min_quote_usd: 10 } },
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /minimum/i, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('the same action processed twice -> does not open a double position', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    const a = rec(store, action());
    await eng.handle(a);
    await eng.handle(a);   // repeat the exact same action
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1, 'must remain one position');
    assert.strictEqual(sent.filter((x) => x.kind === 'mint').length, 1, 'mint only once');
    assert.strictEqual(sent.filter((x) => x.kind === 'increase').length, 0, 'must not add capital for the same action');
    assert.strictEqual(store.all('SELECT id FROM decisions').length, 1, 'only one decision per action');
  });

  await t('closing an already-closed position -> skipped, sends no tx', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
    });
    store.run("UPDATE positions SET status='closed'");
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: '-1' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
  });

  await t('exit receipt without a token log -> nothing is sold, not an error', async () => {
    const { eng } = harness({ balances: RICH });
    const r = await eng.sellLeftover({ id: 1, target: TARGET, token0: USDG, token1: MEME, pool_ref: POOL }, { logs: [] });
    assert.strictEqual(r, null);
  });

  await t('mint succeeded on chain but the RPC answer was lost -> not treated as a failure', async () => {
    const { eng } = harness({ balances: RICH });
    const { ethers } = require('ethers');
    // use the REAL send() (the harness replaces it with a fake sender)
    eng.exec.send = Object.getPrototypeOf(eng.exec).send.bind(eng.exec);
    // test wallet: enough to sign, its key is never used anywhere
    const w = ethers.Wallet.createRandom();
    eng.exec.loadWallet = () => w;
    eng.exec.gasFees = async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    eng.exec.estimateGas = async () => 21000n;
    let asked = 0;
    eng.exec.rpc = {
      call: async (method) => {
        if (method === 'eth_getTransactionCount') return '0x1';
        if (method === 'eth_sendRawTransaction') throw new Error('nonce too low: address x, tx: 1 state: 2');
        if (method === 'eth_getTransactionByHash') { asked++; return { hash: '0xada' }; }   // it had actually landed
        return null;
      },
    };
    const h = await eng.exec.send({ to: ME, data: '0x', value: '0' }, { kind: 'uji' });
    assert.ok(h && h.startsWith('0x'), 'must return the hash, not throw');
    assert.ok(asked > 0, 'must check the chain before giving up');
  });

  await t('a mint that really failed is still reported as failed', async () => {
    const { eng } = harness({ balances: RICH });
    const { ethers } = require('ethers');
    eng.exec.send = Object.getPrototypeOf(eng.exec).send.bind(eng.exec);
    eng.exec.txLanded = async () => false;   // speed up: does not wait 6 times
    const w = ethers.Wallet.createRandom();
    eng.exec.loadWallet = () => w;
    eng.exec.gasFees = async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    eng.exec.estimateGas = async () => 21000n;
    eng.exec.rpc = {
      call: async (method) => {
        if (method === 'eth_getTransactionCount') return '0x1';
        if (method === 'eth_sendRawTransaction') throw new Error('insufficient funds');
        if (method === 'eth_getTransactionByHash') return null;   // it really did not land
        return null;
      },
    };
    await assert.rejects(() => eng.exec.send({ to: ME, data: '0x', value: '0' }, { kind: 'uji' }), /insufficient funds/);
  });

  // ---- what must NOT trigger anything -----------------------------------
  // A reasonable worry: if the target sends ETH/tokens, bridges, or swaps, does
  // the bot follow? No — the bot only reads liquidity events from the PoolManager and
  // position NFT moves. This test locks that behaviour in.
  const { Watcher } = require('../src/watcher');
  const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const TOPIC_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const LAIN = '0x1234567890123456789012345678901234567890';

  function watcherWith(range) {
    const store = new Store(':memory:');
    store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
    const rpc = { ethCallMany: async (c) => c.map(() => '0x'), batch: async (c) => c.map((x) => ({ result: x.method === 'eth_getTransactionReceipt' ? { logs: [] } : x.method === 'eth_getCode' ? '0x' : null })), getLogs: async () => [] };
    const chain = { blockTs: async (b) => b * 101, tokens: async (l) => l.map((a) => ({ address: a, symbol: '?', decimals: 18 })), slot0V4Many: async (ids) => ids.map(() => null), quoteSideOf: () => null, valueInQuote: () => null, poolKeyOfId: async () => null };
    const w = new Watcher({ rpc, store, chain, cfg: {}, log: () => {} });
    w.fetchRange = async () => range;
    w.contractCheck = async () => {};
    return w;
  }
  const log = (address, topics, data = '0x' + '0'.repeat(64)) => ({ address, topics, data, blockNumber: '0x1', transactionHash: '0xdead', logIndex: '0x1' });

  await t('target sends USDG to another address -> bot stays silent', async () => {
    const w = watcherWith({
      modLiq: [], npm: [], xferV4: [],   // the ERC20 transfer is on the USDG contract, not on the POSM
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('any ERC20 token touching the target -> bot stays silent even if its log came along', async () => {
    // defence in depth: even if an ERC20 log made it into the query result, its shape is
    // 3 topics (not a 4-topic NFT) and must be ignored.
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(USDG, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN)])],
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('target does a swap (not LP) -> bot stays silent', async () => {
    const w = watcherWith({
      modLiq: [log(ADDR.poolManager, [TOPIC_SWAP_V4, '0x' + 'aa'.repeat(32), pad32(TARGET)])],
      xferV4: [], npm: [],
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('target mengirim NFT koleksi lain -> bot diam', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(LAIN, [TOPIC_TRANSFER, pad32(TARGET), pad32(ME), pad32('0x01')])],
    });
    const acts = await w.scan(1, 1);
    // only NFTs from the PositionManager count; other collections are not considered positions
    assert.strictEqual(acts.filter((a) => a.venue === 'v4' && a.kind !== 'transfer_out').length, 0);
  });

  await t('positive control: a position NFT that moves IS still detected', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(ADDR.posmV4, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN), pad32('0x7b')])],
    });
    const acts = await w.scan(1, 1);
    assert.strictEqual(acts.length, 1, 'a position NFT move must be detected');
    assert.strictEqual(acts[0].kind, 'transfer_out');
    assert.strictEqual(acts[0].tokenId, '123');
  });

  await t('target switched off -> its actions are not recorded (activity & alerts silent)', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(ADDR.posmV4, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN), pad32('0x7b')])],
    });
    w.store.run('UPDATE targets SET enabled=0 WHERE address=?', TARGET);
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('target switched off but still has an open mirror -> ONLY the exit signal for that mirror is recorded', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [
        log(ADDR.posmV4, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN), pad32('0x7b')]),   // our mirror (#123)
        log(ADDR.posmV4, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN), pad32('0x7c')]),   // not a mirror
      ],
    });
    w.store.run('UPDATE targets SET enabled=0 WHERE address=?', TARGET);
    w.store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts)
      VALUES('v4','5',?,?,?,-600,600,'1',?,'123','open',?)`, POOL, USDG, MEME, TARGET, Date.now());
    const acts = await w.scan(1, 1);
    assert.deepStrictEqual(acts.map((a) => [a.kind, a.tokenId]), [['transfer_out', '123']]);
  });

  await t('bot paused -> ENTRY signal skipped, the target\'s EXIT signal still followed', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,
    });
    store.run("INSERT INTO state(k,v) VALUES('paused','1')");
    await eng.handle(rec(store, action({ tokenId: '1000' })));
    assert.match(verdictOf(store).reason, /dijeda/);
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.strictEqual(sent.filter((x) => x.kind === 'decrease').length, 1);
  });

  await t('target switched off -> entry skipped, but a full exit for the existing mirror is still followed', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 0n,
    });
    store.run('UPDATE targets SET enabled=0');
    await eng.handle(rec(store, action({ tokenId: '1000' })));
    assert.match(verdictOf(store).reason, /dimatikan/);
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: (-(10n ** 20n)).toString() })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.strictEqual(sent.filter((x) => x.kind === 'burn').length, 1);
  });

  await t('target has identical positions A & B, we only mirror A; target closes B -> mirror A is NOT closed', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 0n,
    });
    await eng.handle(rec(store, action({ kind: 'decrease', tokenId: '888', liquidity: (-(10n ** 20n)).toString() })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'open');
  });

  await t('pool+range fallback still works for positions whose tokenId origin is not recorded', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: null, liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 0n,
    });
    await eng.handle(rec(store, action({ kind: 'decrease', tokenId: '888', liquidity: (-(10n ** 20n)).toString() })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.strictEqual(sent.filter((x) => x.kind === 'burn').length, 1);
  });

  await t('two mirrors for one target position (different ranges) -> a partial withdrawal hits BOTH, one decision', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [
        { tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() },
        { tokenId: '6', mirrorOf: '999', liquidity: (2n * 10n ** 20n).toString(), tickLower: -1200, tickUpper: 1200 },
      ],
      targetLiquidityAfter: 6n * 10n ** 19n,
    });
    const a = rec(store, action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() }));
    await eng.handle(a);
    assert.strictEqual(sent.filter((x) => x.kind === 'decrease').length, 2);
    assert.deepStrictEqual(store.all('SELECT liquidity FROM positions ORDER BY id').map((r) => r.liquidity), [(6n * 10n ** 19n).toString(), (12n * 10n ** 19n).toString()]);
    assert.strictEqual(store.get('SELECT COUNT(*) n FROM decisions WHERE action_id=?', a.id).n, 1);
    assert.strictEqual(verdictOf(store).verdict, 'copy');
  });

  await t('two mirrors, target adds in the SECOND mirror\'s range -> adds to the second mirror, not a new position', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [
        { tokenId: '5', mirrorOf: '999', liquidity: (10n ** 19n).toString(), tickLower: -1200, tickUpper: 1200 },
        { tokenId: '6', mirrorOf: '999', liquidity: (10n ** 19n).toString() },
      ],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.match(v.reason, /menambah posisi #2/);
    assert.strictEqual(sent.filter((x) => x.kind === 'increase').length, 1);
    assert.strictEqual(store.get("SELECT COUNT(*) n FROM positions WHERE status='open'").n, 2);
  });

  await t('PER-TARGET stop loss applies on the standalone exit trigger (global off); other targets & manual positions use the global', async () => {
    const { eng, store } = harness({ balances: RICH, positions: [
      { tokenId: '5', mirrorOf: '999', liquidity: '1000' },
      { tokenId: '6', mirrorOf: '998', liquidity: '1000' },
    ] });
    const LAIN2 = '0x' + '77'.repeat(20);
    store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', LAIN2, 'lain', Date.now());
    store.run('UPDATE positions SET target=? WHERE token_id=?', LAIN2, '6');
    store.run('UPDATE targets SET rules=? WHERE address=?', JSON.stringify({ exit: { stop_loss_pct: 10 } }), TARGET);
    const rows = store.all("SELECT * FROM positions ORDER BY id");
    eng.positions.live = rows.map((r) => ({ ...r, pnlPct: -50, inRange: true, ageHours: 1 }));
    for (const k of ['reconcileFeeClaims', 'reconcileExits', 'bookPendingMints', 'bookPendingExits', 'recoverStrandedZaps', 'refreshCash']) eng[k] = async () => {};
    eng.compound.reconcile = async () => {}; eng.compound.tick = async () => {};
    eng.positions.sync = async () => eng.positions.live;
    eng.positions.refreshLeftovers = async () => {};
    eng.capital.available = () => false;
    eng.cfg.prices = { auto_eth_price: false };
    eng.lastAdopt = Date.now();
    const closed = [];
    eng.executeExit = async (plan, pos) => { closed.push(pos.token_id); return { note: 'ok' }; };
    await eng.syncPositionsOnce();
    assert.deepStrictEqual(closed, ['5']);
  });

  await t('dashboard cash is re-read as soon as a tx lands in a block — not waiting for the 30-second sync', async () => {
    const { eng } = harness({ balances: RICH });
    const bal = { usdg: 1_000_000_000n };
    const reads = [];
    eng.exec.balances = async (list, block = 'latest') => {
      reads.push(block);
      return new Map(list.map((tk) => [String(tk).toLowerCase(), String(tk).toLowerCase() === USDG ? bal.usdg : 0n]));
    };
    eng.positions.refreshLeftovers = async () => {};
    eng.ethUsd = 2500;
    // First read: 'latest', cash $1000.
    assert.strictEqual((await eng.freshCash()).usdg, 1000);
    assert.deepStrictEqual(reads, ['latest']);
    // Without a tx, the next request uses the cache — no more RPC.
    assert.strictEqual((await eng.freshCash()).usdg, 1000);
    assert.strictEqual(reads.length, 1);
    // Position opened: $200 leaves the wallet, the tx lands in block 500. Old cash ($1000)
    // + the new position ($200) = a total surplus of $200 — the reported bug.
    bal.usdg = 800_000_000n;
    eng.exec.txSeq++; eng.exec.minedBlock = 500;
    // Two simultaneous requests (two tabs) share one read, pinned at its tx's block.
    const [a, b] = await Promise.all([eng.freshCash(), eng.freshCash()]);
    assert.strictEqual(a.usdg, 800); assert.strictEqual(b.usdg, 800);
    assert.deepStrictEqual(reads, ['latest', '0x1f4']);
    // After that it goes back to 'latest' (a deposit without a bot tx is still read;
    // pinning every read is refused by free endpoints as an archive request).
    bal.usdg = 850_000_000n;
    await eng.refreshCash();
    assert.strictEqual(eng.cash.usdg, 850);
    assert.strictEqual(reads[2], 'latest');
    // The chain head is past the tx block: the reference is the head, not the old tx block.
    eng.exec.txSeq++; eng.head = 620;
    await eng.refreshCash();
    assert.strictEqual(reads[3], '0x26c');
    // RPC fails while cash is stale: the old figure is returned, not null/throw.
    eng.exec.txSeq++;
    eng.exec.balances = async () => { throw new Error('429'); };
    assert.strictEqual((await eng.freshCash()).usdg, 850);
  });

  await t('equity point: a tx that lands in a block BETWEEN cash reads does not become a false peak', async () => {
    const { eng, store } = harness();
    // A mint lands in the block right after the balance is read: cash is still the old ($1000), but
    // the position summary after it already contains the new $200 position — the equity point
    // counts that money twice ($1200, not $1000). This is the +$100 spike on lp3's
    // curve at 2026-09-24 08:40 UTC.
    let minted = false, reads = 0;
    eng.positions.refreshLeftovers = async () => {};
    eng.exec.balances = async (list) => {
      const usdg = minted ? 800_000_000n : 1_000_000_000n;
      reads++;
      if (!minted) { minted = true; eng.exec.txSeq++; eng.exec.minedBlock = 500; }
      return new Map(list.map((tk) => [String(tk).toLowerCase(), String(tk).toLowerCase() === USDG ? usdg : 0n]));
    };
    eng.positions.summary = () => ({
      exposureUsd: minted ? 200 : 0, leftoverUsd: 0, feeUsd: 0, costUsd: minted ? 200 : 0,
      realizedUsd: 0, unrealizedUsd: 0, openCount: minted ? 1 : 0, inRange: minted ? 1 : 0,
    });
    await eng.snapshotEquity();
    const rows = store.all('SELECT * FROM equity');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(reads, 2);                       // repeated once with the cash after the tx
    assert.strictEqual(Math.round(rows[0].wallet_quote), 800);
    assert.strictEqual(Math.round(rows[0].total_quote), 1000);

    // Still busy on the second attempt -> the point is skipped, not written wrong.
    store.run('DELETE FROM equity');
    eng.exec.balances = async (list) => {
      eng.exec.txSeq++;
      return new Map(list.map((tk) => [String(tk).toLowerCase(), 0n]));
    };
    await eng.snapshotEquity();
    assert.strictEqual(store.all('SELECT * FROM equity').length, 0);
  });

  await t('a receipt that is read marks the tx as landed — success or failure (gas is still burned)', async () => {
    const { Executor } = require('../src/executor');
    const store = new Store(':memory:');
    const calls = [];
    const rpc = { call: async (m, [h]) => { calls.push(m); return { status: h === '0xbad' ? '0x0' : '0x1', gasUsed: '0x5208', blockNumber: '0x64' }; } };
    const ex = new Executor({ rpc, store, chain: {}, cfg: {}, log: () => {} });
    assert.strictEqual(ex.txSeq, 0);
    await ex.waitReceipt('0xgood');
    assert.strictEqual(ex.txSeq, 1); assert.strictEqual(ex.minedBlock, 100);
    await ex.waitReceipt('0xbad');
    assert.strictEqual(ex.txSeq, 2);
  });

  await t('manually follow a skipped action: recorded as a target mirror (exit still automatic), decision becomes copied', async () => {
    const { Manual } = require('../src/manual');
    const { eng, store } = harness({ balances: RICH, targetLiquidityAfter: 10n ** 20n });
    const act = rec(store, action({ ts: Date.now() - 42 * 60_000 }));
    eng.decide(act.id, 'skip', 'cooldown pool 20s');
    const manual = new Manual({ engine: eng, store, chain: eng.chain, rpc: eng.rpc, log: () => {} });
    const row = () => store.get('SELECT a.*, d.verdict FROM actions a JOIN decisions d ON d.action_id=a.id WHERE a.id=?', act.id);
    assert.ok(Manual.followable(row(), manual.openMirrorKeys()), 'a skipped entry action can be followed');

    const pv = await manual.planFollow({ actionId: act.id, usd: 60 });
    assert.ok(!pv.error, pv.error);
    assert.strictEqual(pv.plan.target, TARGET);
    assert.strictEqual(pv.plan.mirrorOf, '999');
    assert.ok(pv.follow.ageMs >= 42 * 60_000, 'lateness is sent to the modal');
    assert.strictEqual(pv.follow.exit.followTarget, true);
    // range = the target rule (exact) over the target's range
    assert.deepStrictEqual([pv.plan.tickLower, pv.plan.tickUpper], [-600, 600]);

    let used = null;
    eng.executeEntry = async (plan, a) => {
      used = { plan, a };
      const id = eng.positions.record(plan, { tokenId: '5001', txHash: '0xmint', target: plan.target });
      return { txHash: '0xmint', positionId: id, note: 'USDG/MEME $60.00', pair: 'USDG/MEME', valueUsd: 60 };
    };
    const r = await manual.follow({ actionId: act.id, usd: 60 });
    assert.strictEqual(used.a.target, TARGET);
    const pos = store.get('SELECT target, mirror_of FROM positions WHERE id=?', r.positionId);
    assert.deepStrictEqual({ ...pos }, { target: TARGET, mirror_of: '999' }, 'position = mirror of the target position');
    const d = store.get('SELECT verdict, reason, position_id, plan FROM decisions WHERE action_id=?', act.id);
    assert.strictEqual(d.verdict, 'copy');
    assert.match(d.reason, /^diikuti manual 42 mnt setelah target masuk — /);
    assert.strictEqual(d.position_id, r.positionId);
    assert.strictEqual(JSON.parse(d.plan).followedManually.reason, 'cooldown pool 20s', 'the original decision is not lost');
    assert.strictEqual(store.get('SELECT COUNT(*) n FROM decisions WHERE action_id=?', act.id).n, 1);
    assert.ok(!Manual.followable(row(), manual.openMirrorKeys()), 'after being followed its button disappears');
    assert.match((await manual.planFollow({ actionId: act.id })).error, /sudah disalin/);
  });

  await t('manual follow is rejected if the target has already closed its position', async () => {
    const { Manual } = require('../src/manual');
    const { eng, store } = harness({ balances: RICH, targetLiquidityAfter: 0n });
    const act = rec(store, action());
    eng.decide(act.id, 'error', 'rute Kyber rugi 19.4% (batas 5.9%)');
    const manual = new Manual({ engine: eng, store, chain: eng.chain, rpc: eng.rpc, log: () => {} });
    assert.match((await manual.planFollow({ actionId: act.id })).error, /target sudah menutup/);
    // an exit action can never be followed
    const out = rec(store, action({ kind: 'decrease' }));
    eng.decide(out.id, 'skip', 'kita tidak punya cermin posisi ini');
    assert.match((await manual.planFollow({ actionId: out.id })).error, /hanya aksi buka/);
  });

  await t('take over: exit, additions, reconciliation, and the target\'s SL do not touch the position; hand back -> follows again', async () => {
    const { Manual } = require('../src/manual');
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,
    });
    const manual = new Manual({ engine: eng, store, chain: eng.chain, rpc: eng.rpc, log: () => {} });
    const id = store.get('SELECT id FROM positions').id;
    await manual.takeover(id);
    assert.ok(store.get('SELECT takeover_ts FROM positions WHERE id=?', id).takeover_ts > 0);

    // target withdraws 40%: not followed
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() })));
    let v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip');
    assert.match(v.reason, /posisi #\d+ dalam kendali manual — keluar target tidak diikuti/);
    // target adds: not followed
    await eng.handle(rec(store, action({ kind: 'increase', ts: Date.now() })));
    v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip');
    assert.match(v.reason, /tambahan target tidak diikuti/);
    // reconciliation (target looks empty) does not close
    const closed = [];
    eng.executeExit = async (plan, pos) => { closed.push(pos.id); return { note: 'ok' }; };
    let reads = 0;
    const ecm = eng.rpc.ethCallMany;
    eng.rpc.ethCallMany = async (c, ...r) => { reads++; return ecm(c, ...r); };
    await eng.reconcileExits(); await eng.reconcileExits();
    assert.strictEqual(reads, 0, 'a manual position is not even read by reconciliation');
    // a triggered stop loss does not close
    store.run('UPDATE positions SET liquidity=? WHERE id=?', (10n ** 20n).toString(), id);
    const row = store.get('SELECT * FROM positions WHERE id=?', id);
    eng.positions.live = [{ ...row, pnlPct: -80, inRange: true, ageHours: 1 }];
    store.run('UPDATE targets SET rules=? WHERE address=?', JSON.stringify({ exit: { stop_loss_pct: 10 } }), TARGET);
    for (const k of ['reconcileFeeClaims', 'reconcileExits', 'bookPendingMints', 'bookPendingExits', 'recoverStrandedZaps', 'refreshCash']) eng[k] = async () => {};
    eng.compound.reconcile = async () => {}; eng.compound.tick = async () => {};
    eng.positions.sync = async () => eng.positions.live;
    eng.positions.refreshLeftovers = async () => {};
    eng.capital.available = () => false;
    eng.cfg.prices = { auto_eth_price: false };
    eng.lastAdopt = Date.now();
    await eng.syncPositionsOnce();
    assert.deepStrictEqual(closed, [], 'stop loss does not apply during manual control');
    assert.strictEqual(sent.length, 0, 'no transaction at all');

    // give back (target still has liquidity) -> SL applies again
    await manual.handBack(id);
    assert.strictEqual(store.get('SELECT takeover_ts FROM positions WHERE id=?', id).takeover_ts, null);
    await eng.syncPositionsOnce();
    assert.deepStrictEqual(closed, [id]);
  });

  await t('hand back is rejected if the target has already closed its position; a position without a target cannot be taken over', async () => {
    const { Manual } = require('../src/manual');
    const { eng, store } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 0n,
    });
    const manual = new Manual({ engine: eng, store, chain: eng.chain, rpc: eng.rpc, log: () => {} });
    const id = store.get('SELECT id FROM positions').id;
    await manual.takeover(id);
    assert.strictEqual((await manual.handBackInfo(id)).targetOpen, false);
    await assert.rejects(manual.handBack(id), /target sudah menutup posisi #999/);
    assert.ok(store.get('SELECT takeover_ts FROM positions WHERE id=?', id).takeover_ts > 0, 'stays manual');
    store.run('UPDATE positions SET target=NULL, mirror_of=NULL WHERE id=?', id);
    await assert.rejects(manual.takeover(id), /tidak mengikuti target/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
