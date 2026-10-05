'use strict';
// Test the loss-limit gate when selling leftover memecoins, and staged selling.
//
// The real case that gave birth to this file (measured 17 Sep 2026 from the production DB, 244 swaps
// since capital started being recorded):
//
//   swaps where Kyber has the USD price : 223 swaps, $2,735, off  +0.4%
//   swaps where Kyber has NO price      :  21 swaps,   $313, off −33.6%
//
// All of the −$105 "slippage" is in the second column, −$100 of it from ONE position (#82,
// FREEDOM: close estimate $173 → sold $73). The cause was not a bad route but the
// gate itself: Kyber returns an empty amountInUsd for thin memecoins,
// lossBps() becomes null, and the gate was written `loss != null && loss > limit` — so
// UNMEASURABLE meant PASS. The #82 log shows it: rejected many times at
// 42–57%, then one quote came without a USD price and the full swap went out.
//
// Two properties guarded here:
//   1. unmeasurable ≠ safe. The exit side can always be valued on its own (quote asset), and
//      if it is still unmeasurable, the automatic sale holds back — rather than dumping blind.
//   2. what does not fit whole is sold in part. Without this, closing the gap above just
//      trades "dumped cheap" for "stuck forever" — neither is what we want.
//
// Run: node test/leftover-gate.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Kyber } = require('../src/kyber');
const { ADDR } = require('../src/chain');

const ME = '0x' + '11'.repeat(20);
const MEME = '0x' + 'a1'.repeat(20);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// A simple fake world. `curve(amount)` determines how much USDG comes out for a given
// amount — used to imitate a thin pool: the more sold, the worse the price.
function world({ curve, usdKyber = true, hasPosition = true, poolValue = null, poolSell = null, safeguardFailed = false } = {}) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((address) => ({ address, symbol: address === MEME ? 'MEME' : 'USDG', decimals: address === MEME ? 18 : 6 })),
    token: async (a) => ({ address: a, symbol: a === MEME ? 'MEME' : 'USDG', decimals: a === MEME ? 18 : 6 }),
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' }
      : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
  };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), call: async () => '0x0' };
  const e = new Engine({ rpc, store, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  e.exec.address = () => ME;
  e.exec.balances = async (l) => new Map(l.map((a) => [a.toLowerCase(), a.toLowerCase() === MEME ? 10n * E18 : 0n]));
  e.topUpGas = async () => {};
  e.notify = () => {};
  e.ethUsd = 2500;

  // Pool price comparator: this is what lets the gate still measure even when Kyber
  // has no price feed for this token.
  e.positions.leftoverRows = () => (hasPosition ? [{ id: 82, left_token: MEME }] : []);
  e.positions.valueLeftover = async (rows, amt) => (poolValue == null ? null : (poolValue * Number(amt)) / Number(10n * E18));
  const recorded = [];
  e.positions.recordLeftoverSale = (x) => { recorded.push(x); return []; };

  const quoteText = [];
  e.kyber.quote = async (tokenIn, tokenOut, amountIn) => {
    quoteText.push(amountIn);
    const usdOut = curve(amountIn);
    // usdIn = the notional value of the token paid (fair price × amount), usdOut = what can
    // really be withdrawn through that route. The difference = fee + price impact.
    const nosional = poolValue == null ? null : (poolValue * Number(amountIn)) / Number(10n * E18);
    return {
      amountOut: BigInt(Math.round(usdOut * 1e6)), routeSummary: {}, dex: 'uji',
      // These are exactly the two lines that are empty for thin memecoins in production.
      usdIn: usdKyber ? nosional : null,
      usdOut: usdKyber ? usdOut : null,
    };
  };
  // The real safeguard is used as it is; only the HTTP/tx layer is imitated.
  const sold = [];
  e.kyber.swap = async (tokenIn, tokenOut, amountIn, o) => {
    // A failing safeguard (router mismatch, odd calldata) throws a plain error:
    // without .loss and without .reverted — that is what sets it apart from a market error.
    if (safeguardFailed) throw new Error('router Kyber tidak cocok: 0xdead ≠ whitelist');
    const q = await e.kyber.quote(tokenIn, tokenOut, amountIn);
    const loss = Kyber.routeLoss(q, o.ref);
    if (o.maxLossBps != null && o.requireLoss && !loss) throw new Error('rugi rute tidak terukur');
    if (o.maxLossBps != null && loss && loss.bps > o.maxLossBps) {
      const err = new Error(`rute Kyber rugi ${(loss.bps / 100).toFixed(1)}%`);
      err.loss = { lossBps: loss.bps, maxLossBps: o.maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut };
      throw err;
    }
    sold.push(amountIn);
    return { hash: '0x' + 'e'.repeat(64), amountOut: q.amountOut, quote: q };
  };
  // Direct pool fallback. `poolSell(amount)` returns how much USDG comes out,
  // or null if the pool is not viable either — exactly the reply shape of the real sellViaPool.
  const skipPool = [];
  e.sellViaPool = async (it, amount) => {
    skipPool.push(amount);
    const out = poolSell ? poolSell(amount) : null;
    if (out == null) return null;
    return { hash: '0x' + 'p'.repeat(64), amountOut: BigInt(Math.round(out * 1e6)),
      quote: { dex: 'pool v4 0x1234abcd…', usdIn: null, usdOut: out } };
  };
  return { e, store, quoteText, sold, recorded, skipPool };
}

const item = () => ({ posId: 82, target: null, token: MEME, quote: ADDR.usdg, amount: (10n * E18).toString(), tries: 0 });

(async () => {
  console.log('Loss-limit gate & staged selling:\n');

  await t('routeLoss: Kyber with no USD price at all -> the exit side is valued on its own', () => {
    // 100 tokens valued at $173 by our pool, Kyber can only return 73 USDG.
    const q = { amountOut: 73_000_000n, usdIn: null, usdOut: null };
    const r = Kyber.routeLoss(q, { usdIn: 173, usdPerOut: 1, outDecimals: 6 });
    assert.ok(r, 'must be measurable from the comparator, not null');
    assert.ok(Math.abs(r.bps - 5780) < 20, `loss ~57.8%, got ${r.bps}`);
  });

  await t('routeLoss: without Kyber AND without a comparator it stays null — does not invent a figure', () => {
    assert.strictEqual(Kyber.routeLoss({ amountOut: 1n, usdIn: null, usdOut: null }), null);
    assert.strictEqual(Kyber.routeLoss(null), null);
  });

  await t('routeLoss: Kyber\'s USD price is still what is used if present (the 223 swaps that were already right)', () => {
    const r = Kyber.routeLoss({ amountOut: 1n, usdIn: 100, usdOut: 98 }, { usdIn: 999, usdPerOut: 1, outDecimals: 6 });
    assert.strictEqual(Math.round(r.bps), 200, 'the comparator must not shift what is already measured');
  });

  await t('queue: a quote without a USD price NO LONGER passes the gate', async () => {
    // Exactly the shape of #82: the pool values the leftover at $173, the route only gives $73.
    const d = world({ curve: () => 73, usdKyber: false, poolValue: 173 });
    d.e.saveLeftovers([{ ...item(), next: 0 }]);
    await d.e.retryLeftovers();
    assert.strictEqual(d.sold.length, 0, 'loss 58% > limit 15%: must not be sold');
    const q = d.e.leftovers();
    assert.strictEqual(q.length, 1, 'stays in the queue');
    assert.ok(Math.abs(q[0].lastLossBps - 5780) < 20, `recorded loss ${q[0].lastLossBps}`);
  });

  await t('queue: not measurable at all -> held back, not dumped blind', async () => {
    const d = world({ curve: () => 73, usdKyber: false, hasPosition: false });
    d.e.saveLeftovers([{ ...item(), next: 0 }]);
    await d.e.retryLeftovers();
    assert.strictEqual(d.sold.length, 0, 'without a loss figure it must not sell');
    assert.match(d.e.leftovers()[0].why, /tidak terukur/);
  });

  await t('sell: a sane route still passes as usual', async () => {
    const d = world({ curve: () => 98, poolValue: 100 });
    await d.e.sellToken(item());
    assert.strictEqual(d.sold.length, 1);
    assert.strictEqual(d.sold[0], 10n * E18, 'full amount');
    assert.strictEqual(d.e.leftovers().length, 0, 'sold out: leaves the queue');
  });

  await t('staged selling: what does not fit whole is sold in part, the rest goes back to the queue', async () => {
    // Thin pool: $10/token for a small chunk, the price falls in proportion to the size.
    // The full amount (10 tokens) loses ~50%; a quarter of it is still inside the 15% limit.
    const full = 10n * E18;
    const curve = (amt) => {
      const frac = Number(amt) / Number(full);
      return 100 * frac * (1 - 0.5 * frac);     // price impact grows linearly with size
    };
    const d = world({ curve, poolValue: 100 });
    await d.e.sellToken(item());
    assert.strictEqual(d.sold.length, 1, 'exactly one swap is sent');
    assert.ok(d.sold[0] < full, 'what is sold must be smaller than the full amount');
    assert.ok(d.sold[0] > 0n, 'something must be sold, not give up');
    const leftover = d.e.leftovers();
    assert.strictEqual(leftover.length, 1, 'the remainder must go back to the queue');
    assert.strictEqual(BigInt(leftover[0].amount), full - d.sold[0], 'the remaining amount must be exact');
    assert.strictEqual(leftover[0].tries, 1, 'a partial sale is progress, the counter is reset');
    assert.strictEqual(d.recorded[0].amount, d.sold[0], 'what is recorded = what was really sold');
  });

  await t('staged selling: a chunk of any size still loses -> no tx, stays queued', async () => {
    // A 90% loss regardless of size: the token genuinely has no buyers left.
    const d = world({ curve: (amt) => (100 * Number(amt) * 0.1) / Number(10n * E18), poolValue: 100 });
    await d.e.sellToken(item()).catch(() => {});
    assert.strictEqual(d.sold.length, 0, 'there must be no swap');
    assert.strictEqual(d.e.leftovers().length, 1, 'stays in the queue to retry');
  });

  await t('staged selling: the chunk search is bounded to a few quotes, not grinding', async () => {
    const d = world({ curve: (amt) => (100 * Number(amt) * 0.1) / Number(10n * E18), poolValue: 100 });
    await d.e.sellToken(item()).catch(() => {});
    assert.ok(d.quoteText.length <= 8, `${d.quoteText.length} quotes is too many for one sale`);
  });

  await t('fallback: the Kyber route loses too much, a direct pool fits -> sold WHOLE via the pool', async () => {
    // Kyber routes through a bad path (50% loss), while the pool we know only
    // loses 3%. The full amount used to be cut and sold at a high cost via Kyber; now the
    // direct pool is tried first — the same loss safeguard still applies there.
    const full = 10n * E18;
    const d = world({ curve: () => 50, poolValue: 100, poolSell: () => 97 });
    await d.e.sellToken(item());
    assert.strictEqual(d.sold.length, 0, 'there must be no Kyber swap');
    assert.deepStrictEqual(d.skipPool, [full], 'the pool is tried once, for the FULL amount');
    assert.strictEqual(d.e.leftovers().length, 0, 'sold out: leaves the queue');
    assert.strictEqual(d.recorded[0].amount, full, 'what is recorded = the full amount');
  });

  await t('fallback: the pool is not viable either -> back to staged selling via Kyber', async () => {
    const full = 10n * E18;
    const curve = (amt) => {
      const frac = Number(amt) / Number(full);
      return 100 * frac * (1 - 0.5 * frac);
    };
    const d = world({ curve, poolValue: 100, poolSell: () => null });
    await d.e.sellToken(item());
    assert.strictEqual(d.skipPool.length, 1, 'the pool is still tried first');
    assert.strictEqual(d.sold.length, 1, 'then staged selling via Kyber as before');
    assert.ok(d.sold[0] < full, 'what is sold is smaller than the full amount');
  });

  await t('fallback: a SAFEGUARD error is never diverted to a pool', async () => {
    // A router mismatch / odd calldata is not a price matter — if an error like this may
    // fall through to the pool, the Kyber safeguard becomes merely advice.
    const d = world({ curve: () => 98, poolValue: 100, poolSell: () => 97, safeguardFailed: true });
    await d.e.sellToken(item()).catch(() => {});
    assert.strictEqual(d.skipPool.length, 0, 'the pool must not be tried');
    assert.strictEqual(d.e.leftovers().length, 1, 'stays in the queue to retry');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
