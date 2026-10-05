'use strict';
// Test the wallet leftover sweeper: which ones may be sold, which MUST be left alone,
// and what happens after entering the queue.
//
// This touches real money in the bot wallet, so what is tested is not just "works or
// not" but the boundaries: quote assets and tokens of still-open positions must
// not be swept, the sweep itself must not send any transaction, and
// the loss limit must still reject a bad route even if the item came from a sweep.
//
// Real case: the production wallet 0xe9c2…81ee held 8 tokens (GM, Puff, CME, MBGA, GD,
// PONS, ChatGpt, WETH) while the sell queue was empty and no closed position
// recorded leftovers — no path would ever have touched them.
//
// Run: node test/sweep.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { ADDR } = require('../src/chain');

const ME = '0x' + '11'.repeat(20);
const GM = '0x' + 'a1'.repeat(20);       // idle memecoin, valuable
const PUFF = '0x' + 'a2'.repeat(20);     // idle memecoin, nearly worthless
const DUST = '0x' + 'a3'.repeat(20);     // $0 dust
const NOT_A_ROUTE = '0x' + 'a4'.repeat(20); // cannot be routed by Kyber
const USED = '0x' + 'a5'.repeat(20);  // token of a position that is STILL OPEN
const POOL = '0x' + '33'.repeat(32);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// Fake world: wallet balances as they are, Kyber quotes per token that can be configured,
// and a recorder of every transaction that was ATTEMPTED.
function world({ saldo: balance = {}, harga: price = {}, dryRun = false } = {}) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((address) => ({ address, symbol: META[address]?.symbol || '?', decimals: META[address]?.decimals ?? 18 })),
    quoteSideOf: (t0, t1) => {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' }, [ADDR.weth]: { symbol: 'WETH', decimals: 18, kind: 'eth' } };
      if (q[t0]) return { side: 0, ...q[t0] };
      if (q[t1]) return { side: 1, ...q[t1] };
      return null;
    },
    token: async (a) => ({ address: a, symbol: META[a]?.symbol || '?', decimals: META[a]?.decimals ?? 18 }),
  };
  const META = {
    [GM]: { symbol: 'GM', decimals: 18 }, [PUFF]: { symbol: 'Puff', decimals: 18 },
    [DUST]: { symbol: 'MBGA', decimals: 18 }, [NOT_A_ROUTE]: { symbol: 'PONS', decimals: 18 },
    [USED]: { symbol: 'INPOS', decimals: 18 }, [ADDR.usdg]: { symbol: 'USDG', decimals: 6 },
    [ADDR.weth]: { symbol: 'WETH', decimals: 18 },
  };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), call: async () => '0x0' };
  const cfg = { mode: { dry_run: dryRun }, rules: {}, gas: {} };
  const e = new Engine({ rpc, store, chain, cfg, log: () => {} });
  e.exec.address = () => ME;

  const bal = new Map(Object.entries(balance).map(([a, v]) => [a.toLowerCase(), v]));
  e.exec.balances = async (list) => new Map(list.map((a) => [a.toLowerCase(), bal.get(a.toLowerCase()) || 0n]));

  // Every transaction that would really go out to the chain through here.
  const sent = [];
  e.exec.send = async (tx, opt) => { sent.push({ tx, ...opt }); return '0x' + 'f'.repeat(64); };
  e.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [] } });

  // Kyber quote: `price[token]` = USD that can be withdrawn. null = no route.
  const quoted = [];
  e.kyber.quote = async (tokenIn, tokenOut, amountIn) => {
    quoted.push({ tokenIn, tokenOut, amountIn });
    const usd = price[tokenIn.toLowerCase()];
    if (usd == null) return null;
    // usdIn is made slightly above usdOut so lossBps is real, like a real route.
    return { usdIn: usd / (1 - (price[`${tokenIn.toLowerCase()}:loss`] ?? 0.01)), usdOut: usd,
      amountOut: 1n, routeSummary: {}, dex: 'uniswapv3' };
  };
  const sold = [];
  e.kyber.swap = async (tokenIn, tokenOut, amountIn, o) => {
    const q = await e.kyber.quote(tokenIn, tokenOut, amountIn);
    if (!q) return null;
    const loss = ((q.usdIn - q.usdOut) / q.usdIn) * 10_000;
    if (o.maxLossBps != null && loss > o.maxLossBps) {
      const err = new Error(`rute Kyber rugi ${(loss / 100).toFixed(1)}% (batas ${(o.maxLossBps / 100).toFixed(1)}%)`);
      err.loss = { lossBps: loss, maxLossBps: o.maxLossBps, usdIn: q.usdIn, usdOut: q.usdOut };
      throw err;
    }
    sold.push({ tokenIn, tokenOut, amountIn });
    return { hash: '0x' + 'e'.repeat(64), amountOut: q.amountOut, quote: q };
  };
  e.notify = () => {};

  for (const [a, m] of Object.entries(META)) {
    store.run('INSERT OR REPLACE INTO tokens(address,symbol,decimals,seen_ts) VALUES(?,?,?,?)', a, m.symbol, m.decimals, Date.now());
  }
  return { e, store, sent, quoted, sold, bal };
}

const queue = (e) => e.leftovers().map((x) => x.token);

(async () => {
  await t('a quote asset is never swept, however large its balance', async () => {
    const d = world({
      saldo: { [ADDR.usdg]: 276_186_557n, [ADDR.weth]: 2_158_692_439_168_406n, [ADDR.native]: 5n * E18 },
      harga: { [ADDR.usdg]: 276.19, [ADDR.weth]: 5.43 },
    });
    const r = await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [], 'USDG/WETH/ETH enter the sell queue');
    assert.equal(r.scanned, 0);
    assert.ok(!d.quoted.some((q) => [ADDR.usdg, ADDR.weth, ADDR.native].includes(q.tokenIn)), 'kuotasi ikut dikutip');
  });

  await t('a token of a still OPEN position is not touched', async () => {
    const d = world({ saldo: { [USED]: 1000n * E18, [GM]: 200n * E18 }, harga: { [USED]: 500, [GM]: 6.9 } });
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,liquidity)
      VALUES('v4',?,?,?,'open',?,'1')`, POOL, ADDR.usdg, USED, Date.now());
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [GM], 'a token of an open position is also swept');
  });

  await t('a token of a position that has CLOSED may be swept', async () => {
    const d = world({ saldo: { [USED]: 1000n * E18 }, harga: { [USED]: 500 } });
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,closed_ts,liquidity)
      VALUES('v4',?,?,?,'closed',?,?,'0')`, POOL, ADDR.usdg, USED, Date.now(), Date.now());
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [USED]);
  });

  await t('dust below the threshold is skipped — it does not become an item that fails forever', async () => {
    const d = world({ saldo: { [GM]: 200n * E18, [PUFF]: 194_814n * E18, [DUST]: 1000n * E18 },
      harga: { [GM]: 6.9, [PUFF]: 0.84, [DUST]: 0.0 } });
    const r = await d.e.sweepWallet({ minUsd: 0.5 });
    assert.deepEqual(queue(d.e).sort(), [GM, PUFF].sort());
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].token, DUST);
    assert.ok(/cuma \$0\.00/.test(r.skipped[0].why), `reason unclear: ${r.skipped[0].why}`);
  });

  await t('the threshold is respected: $5 leaves the small ones in the wallet', async () => {
    const d = world({ saldo: { [GM]: 200n * E18, [PUFF]: 194_814n * E18 }, harga: { [GM]: 6.9, [PUFF]: 0.84 } });
    await d.e.sweepWallet({ minUsd: 5 });
    assert.deepEqual(queue(d.e), [GM]);
  });

  await t('without a Kyber route: skipped with its reason, not queued silently', async () => {
    const d = world({ saldo: { [NOT_A_ROUTE]: 8n * E18 }, harga: {} });
    const r = await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), []);
    assert.equal(r.skipped[0].why, 'Tidak ada agregator yang menemukan rute');
  });

  await t('sweeping does NOT send any transaction', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    assert.equal(d.sent.length, 0, `sapuan mengirim ${d.sent.length} tx`);
    assert.equal(d.sold.length, 0, 'sapuan langsung menjual');
  });

  await t('sweeping twice does not double the queue', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    const r2 = await d.e.sweepWallet();
    assert.equal(d.e.leftovers().length, 1, 'item tergandakan');
    assert.equal(r2.scanned, 0, 'a token already queued is quoted again in vain');
  });

  await t('the leftover of a position already queued is not swept again', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    d.e.keepLeftover({ posId: 7, target: null, token: GM, quote: ADDR.usdg, amount: (200n * E18).toString(), tries: 0 }, 'x');
    await d.e.sweepWallet();
    assert.equal(d.e.leftovers().length, 1);
    assert.equal(d.e.leftovers()[0].posId, 7, 'the position item was overwritten by the sweep item');
  });

  await t('a token added manually on the Swap page is also swept', async () => {
    const OUTSIDE = '0x' + 'b9'.repeat(20);   // not in the tokens table, never scanned
    const d = world({ saldo: { [OUTSIDE]: 100n * E18 }, harga: { [OUTSIDE]: 6.9 } });
    d.store.setState('swap_tokens:robinhood', JSON.stringify([OUTSIDE]));
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [OUTSIDE], 'the manual token was not scanned');
  });

  await t('a token that ever entered the wallet (swap_seen) is also swept', async () => {
    const OUTSIDE = '0x' + 'b8'.repeat(20);
    const d = world({ saldo: { [OUTSIDE]: 100n * E18 }, harga: { [OUTSIDE]: 6.9 } });
    d.store.setState('swap_seen:robinhood', JSON.stringify({ wallet: ME, block: 1, tokens: [OUTSIDE] }));
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [OUTSIDE]);
  });

  await t('swap_seen of ANOTHER wallet is ignored', async () => {
    const OUTSIDE = '0x' + 'b7'.repeat(20);
    const d = world({ saldo: { [OUTSIDE]: 100n * E18 }, harga: { [OUTSIDE]: 6.9 } });
    d.store.setState('swap_seen:robinhood', JSON.stringify({ wallet: '0x' + '99'.repeat(20), block: 1, tokens: [OUTSIDE] }));
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [], 'the other wallet\'s token list was also used');
  });

  await t('without a wallet: refuses, not silently doing nothing', async () => {
    const d = world({ saldo: {}, harga: {} });
    d.e.exec.address = () => null;
    await assert.rejects(() => d.e.sweepWallet(), /wallet bot belum diatur/);
  });

  // ---- after entering the queue: the seller is still the old path, with the old safeguards ----

  await t('the loss limit still refuses a bad route even if the item came from a sweep', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    // loss 30% > default limit 15%
    d.e.kyber.quote = async () => ({ usdIn: 10, usdOut: 7, amountOut: 1n, routeSummary: {}, dex: 'x' });
    await d.e.sweepWallet();
    assert.deepEqual(queue(d.e), [GM]);
    // the wait schedule is skipped, otherwise the attempt never happens and this test
    // passes without testing anything
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.sold.length, 0, 'a route losing 30% was still executed');
    assert.deepEqual(queue(d.e), [GM], 'the item vanished from the queue although not sold');
    assert.ok(/rugi 30\.0%/.test(d.e.leftovers()[0].why), d.e.leftovers()[0].why);
  });

  await t('a route that passes the limit: sold, the item leaves the queue', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.e.leftovers();
    // the wait schedule is skipped so the next tick executes right away
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.sold.length, 1, 'not sold although the route passed');
    assert.equal(d.sold[0].tokenIn, GM);
    assert.equal(d.sold[0].tokenOut, ADDR.usdg);
    assert.deepEqual(queue(d.e), [], 'the item stays queued after being sold');
  });

  await t('balance shrank after queueing: what is sold is capped at the real balance', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.bal.set(GM, 50n * E18);            // partly already used outside the bot
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.sold[0].amountIn, 50n * E18, 'sold more than the balance');
  });

  await t('balance used up outside the bot: the item is dropped, not retried forever', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    await d.e.sweepWallet();
    d.bal.set(GM, 0n);
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.deepEqual(queue(d.e), [], 'an item with a zero balance stays queued');
    assert.equal(d.sold.length, 0);
  });

  await t('simulation mode: the queue is never executed', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 }, dryRun: true });
    await d.e.sweepWallet();
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    assert.equal(d.sold.length, 0, 'sold in simulation mode');
    assert.equal(d.sent.length, 0);
  });

  await t('posId null does not break the closed position bookkeeping', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    // a closed position that did NOT record any leftover — like the 13 positions in production
    d.store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,closed_ts,out_quote,cost_quote,quote_symbol,liquidity)
      VALUES('v4',?,?,?,'closed',?,?,150,200,'USDG','0')`, POOL, ADDR.usdg, GM, Date.now(), Date.now());
    const before = d.store.get('SELECT out_quote,left_amount FROM positions WHERE id=1');
    await d.e.sweepWallet();
    d.e.saveLeftovers(d.e.leftovers().map((x) => ({ ...x, next: 0 })));
    await d.e.retryLeftovers();
    const after = d.store.get('SELECT out_quote,left_amount FROM positions WHERE id=1');
    assert.equal(d.sold.length, 1, 'not sold');
    assert.deepEqual(after, before, 'a closed position\'s PnL also changed although it has no leftover');
  });

  await t('the sweep queue and the live position queue coexist for the same token', async () => {
    const d = world({ saldo: { [GM]: 200n * E18 }, harga: { [GM]: 6.9 } });
    d.e.keepLeftover({ posId: 3, target: null, token: GM, quote: ADDR.usdg, amount: (10n * E18).toString(), tries: 0 }, 'x');
    // the sweep skipped it (already queued), then the position item was dropped manually
    await d.e.sweepWallet();
    d.e.dropLeftover({ posId: 3, token: GM });
    assert.deepEqual(queue(d.e), [], 'dropLeftover meleset');
    // now the sweep may take over
    await d.e.sweepWallet();
    assert.equal(d.e.leftovers()[0].posId, null);
    d.e.dropLeftover({ posId: null, token: GM });
    assert.deepEqual(queue(d.e), [], 'a sweep item cannot be discarded');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
