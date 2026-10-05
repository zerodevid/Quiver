'use strict';
// Test the FALLBACK path of the quote-asset bridge: what is used when Kyber gives no route.
//
// Background: on 25 Sep 2026 an entry on lp2 was cancelled with the message "gas estimation failed (the transaction
// would probably revert)". The real cause was layered — the Kyber quote was empty (not
// recorded at all), then the fallback fired at a single ETH/USDG pool whose hook
// rejects swaps. All 12 ETH/USDG pools on that chain are hooked and all reject, so the
// fallback could never succeed, yet the message accused a stale node.
//
// What is guarded here: (1) the pool is simulated first, not sent blind; (2) a candidate that
// rejects is skipped, not allowed to kill the bridge; (3) if all reject, the error names
// both the Kyber cause AND the pool rejection.
//
// Run: node test/bridge-fallback.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native;
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
// Bridge pool price: 2500 USDG per ETH. currency0 = ETH(18), currency1 = USDG(6).
const sqrtFor = (usdgPerEth) => m.getSqrtRatioAtTick(m.getTickAtSqrtRatio(
  BigInt(Math.floor(Math.sqrt(usdgPerEth / 10 ** 12) * 2 ** 48)) << 48n));

// Fake bridge pool; `hooks` is just a marker, what decides is the simulation answer.
function pool(id, usdgPerEth, liquidity) {
  return {
    poolId: '0x' + String(id).repeat(64).slice(0, 64),
    poolKey: { currency0: ETH, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: '0x' + 'dd'.repeat(20) },
    slot0: { sqrtPriceX96: sqrtFor(usdgPerEth), tick: 0 },
    liquidity: BigInt(liquidity),
  };
}

// A minimal engine: only ensureQuoteAsset is tested, so the outer boundary is faked.
function harness({ pools, receive = () => false, kyberQuote = async () => null, balances, permission = [] }) {
  const store = new Store(':memory:');
  const chain = { ethUsd: async () => 2500 };
  const cfg = { mode: { dry_run: false, paused: false }, rules: {}, gas: {}, loop: {} };
  const rpc = { ethCallMany: async (c) => c.map(() => '0x'), batch: async (c) => c.map(() => ({ result: null })), blockNumber: async () => 1e6, call: async () => null };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  const bal = new Map(Object.entries(balances).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
  const sent = [], simulated = [];
  eng.chain.bestEthUsdgPool = async () => (pools.length ? { ...pools[0], candidates: pools } : null);
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((t) => [String(t).toLowerCase(), bal.get(String(t).toLowerCase()) || 0n]));
  eng.exec.send = async (tx, meta) => { sent.push({ kind: meta?.kind, detail: meta?.detail }); return '0x' + (sent.length + '').padStart(64, '0'); };
  eng.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [], gasUsed: '0x0', effectiveGasPrice: '0x0' } });
  eng.exec.ensureRouterAllowance = async () => permission;
  eng.exec.deadline = () => 9e9;
  eng.exec.gasReserve = async () => 0n;
  eng.exec.simulate = async (tx) => {
    simulated.push(tx);
    return receive(simulated.length - 1) ? { ok: true, gas: '300000' } : { ok: false, error: 'execution reverted' };
  };
  // quoteRetry is bypassed so the tests below do not wait for its retry delay;
  // the retry behaviour is tested separately through the real kyber.quote.
  eng.kyber.quoteRetry = kyberQuote;
  eng.kyber.quote = kyberQuote;
  eng.kyber.swap = async () => null;
  return { eng, store, sent, simulated };
}

// plan: needs USDG, cash is in ETH -> ETH→USDG bridge.
const plan = { quoteSide: 0, token0: USDG, token1: '0x' + '11'.repeat(20) };
const rules = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 5000 } };
const RICH = { [ETH]: 10n ** 18n, [USDG]: 0n };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  OK   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

(async () => {
  await t('all pools refuse -> no tx sent, the error names Kyber AND the pool refusals', async () => {
    const { eng, sent, simulated } = harness({ pools: [pool(1, 2500, 1e15), pool(2, 2490, 1e14)], balances: RICH });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, rules, 100_000000n),
      (e) => {
        assert.match(e.message, /Kyber tidak memberi kutipan/, `sebab Kyber hilang: ${e.message}`);
        assert.match(e.message, /2 pool .* menolak swap/, `penolakan pool hilang: ${e.message}`);
        assert.doesNotMatch(e.message, /estimasi gas/, `still blames the gas estimate: ${e.message}`);
        return true;
      });
    assert.equal(simulated.length, 2, 'both candidates must be simulated');
    assert.ok(!sent.some((x) => x.kind === 'bridge_swap'), 'no swap may be sent blind');
  });

  await t('deepest pool refuses, second candidate accepts -> the bridge still runs', async () => {
    const p = [pool(1, 2500, 1e15), pool(2, 2490, 1e14)];
    const { eng, sent, simulated } = harness({ pools: p, receive: (i) => i === 1, balances: RICH });
    const notes = await eng.ensureQuoteAsset(plan, rules, 100_000000n);
    assert.equal(simulated.length, 2, 'must fall through to the second candidate');
    const swap = sent.find((x) => x.kind === 'bridge_swap');
    assert.ok(swap, `bridge was not sent (sent: ${sent.map((x) => x.kind).join(',')})`);
    assert.equal(swap.detail.pool, p[1].poolId, 'must use the pool that PASSES simulation, not the deepest');
    assert.ok(notes.some((n) => /jembatan/.test(n)), notes.join(' | '));
  });

  await t('first candidate passes -> the next candidate is not simulated', async () => {
    const { eng, simulated } = harness({ pools: [pool(1, 2500, 1e15), pool(2, 2490, 1e14)], receive: (i) => i === 0, balances: RICH });
    await eng.ensureQuoteAsset(plan, rules, 100_000000n);
    assert.equal(simulated.length, 1, 'stops at the first candidate that passes');
  });

  await t('the cause of falling back is recorded even if the Kyber quote is empty', async () => {
    const { eng, store } = harness({ pools: [pool(1, 2500, 1e15)], balances: RICH });
    await eng.ensureQuoteAsset(plan, rules, 100_000000n).catch(() => {});
    const logs = store.all("SELECT msg FROM logs WHERE level='warn'").map((r) => r.msg);
    assert.ok(logs.some((l) => /Kyber tidak memberi kutipan/.test(l)),
      `an empty Kyber quote must be recorded, not silent: ${JSON.stringify(logs)}`);
  });

  await t('price impact above the limit -> a price error, not a pool refusal', async () => {
    const strict = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 1 } };
    const { eng, simulated } = harness({ pools: [pool(1, 2500, 1e6)], balances: RICH });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, strict, 100_000000n),
      (e) => { assert.match(e.message, /menggeser harga/, e.message); return true; });
    assert.equal(simulated.length, 0, 'the one that is too expensive need not be simulated');
  });

  // The reverse direction: needs ETH, cash in USDG -> USDG→ETH bridge, and this side needs router
  // approval. That approval is a real transaction, so it must not be sent for a bridge that
  // is certain to fail at the cheap gate (price impact / insufficient cash).
  const planEth = { quoteSide: 0, token0: ETH, token1: '0x' + '11'.repeat(20) };
  const RICH_USDG = { [USDG]: 10n ** 9n, [ETH]: 0n };
  const PERMISSION = [{ kind: 'approve_router', to: USDG, data: '0x' }];

  await t('price impact eliminates all candidates -> the router allowance is not sent either', async () => {
    const strict = { swap: { enabled: true, max_slippage_bps: 150, max_price_impact_bps: 1 } };
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e6)], balances: RICH_USDG, permission: PERMISSION });
    await assert.rejects(
      () => eng.ensureQuoteAsset(planEth, strict, 10n ** 16n),
      (e) => { assert.match(e.message, /menggeser harga/, e.message); return true; });
    assert.ok(!sent.some((x) => x.kind === 'approve_router'),
      `router allowance sent for a bridge that was eliminated: ${sent.map((x) => x.kind).join(',')}`);
  });

  await t('a viable candidate exists -> the router allowance is still prepared before simulation', async () => {
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e15)], receive: () => true, balances: RICH_USDG, permission: PERMISSION });
    await eng.ensureQuoteAsset(planEth, rules, 10n ** 16n);
    const ordered = sent.map((x) => x.kind);
    assert.ok(ordered.indexOf('approve_router') >= 0 && ordered.indexOf('approve_router') < ordered.indexOf('bridge_swap'),
      `the allowance must precede the swap: ${ordered.join(',')}`);
  });

  await t('insufficient cash in the cheapest pool -> a cash error, not a pool refusal error', async () => {
    const { eng, sent } = harness({ pools: [pool(1, 2500, 1e15)], balances: { [ETH]: 1n, [USDG]: 0n } });
    await assert.rejects(
      () => eng.ensureQuoteAsset(plan, rules, 100_000000n),
      (e) => { assert.match(e.message, /kas kurang untuk jembatan/, e.message); return true; });
    assert.equal(sent.length, 0, 'no tx when cash really is insufficient');
  });

  await t('a momentarily failing Kyber quote is retried, not straight to the fallback', async () => {
    const { Kyber } = require('../src/kyber');
    const k = new Kyber({ exec: { address: () => ME }, rpc: {}, cfg: {}, chain: null, log: () => {} });
    let n = 0;
    k.quote = async () => (++n < 3 ? null : { amountOut: 1n });
    const q = await k.quoteRetry(ETH, USDG, 1n);
    assert.equal(n, 3, 'must try until it gets one');
    assert.ok(q, 'a quote that finally succeeds must not be discarded');
    let m2 = 0;
    k.quote = async () => { m2++; return null; };
    assert.equal(await k.quoteRetry(ETH, USDG, 1n), null, 'one that genuinely has no route stays null');
    assert.equal(m2, 3, 'attempts are bounded, not forever');
  });

  // ETH/USDG pool list cache: it used to be permanent, now it is rescanned. An unlucky
  // scan must not shorten the list — a v4 pool that was born does not disappear.
  const { Chain } = require('../src/pools');
  const logPool = (id, fee, ts, hooks) => ({
    topics: [null, '0x' + String(id).repeat(64).slice(0, 64)],
    data: '0x' + fee.toString(16).padStart(64, '0') + ts.toString(16).padStart(64, '0')
      + '00'.repeat(12) + hooks.replace(/^0x/, ''),
  });
  const fakeChain = (store, logs) => ({
    network: 'robinhood', store,
    ADDR: { poolManager: '0x' + '11'.repeat(20), native: ETH, usdg: USDG },
    rpc: { getLogs: async () => logs },
  });
  const OLD = [
    { poolId: '0x' + 'a'.repeat(64), fee: 3000, tickSpacing: 60, hooks: '0x' + 'dd'.repeat(20) },
    { poolId: '0x' + 'b'.repeat(64), fee: 500, tickSpacing: 10, hooks: '0x' + 'ee'.repeat(20) },
  ];

  await t('a rescan that only gets part -> the list is merged, does not shrink', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify(OLD));   // old shape = stale
    const fresh = logPool(9, 100, 1, '0x' + 'ff'.repeat(20));
    const outcome = await Chain.prototype.findEthUsdgPools.call(fakeChain(store, [fresh]), 1000);
    const ids = outcome.map((p) => p.poolId.toLowerCase());
    for (const p of OLD) assert.ok(ids.includes(p.poolId), `old pool ${p.poolId.slice(0, 10)} is gone`);
    assert.equal(outcome.length, 3, `must be 2 old + 1 new, got ${outcome.length}`);
    const save = JSON.parse(store.getState('eth_usdg_pools:robinhood'));
    assert.ok(save.ts > 0, 'the new shape must be timestamped');
  });

  await t('a total scan failure -> the old list is kept and not timestamped', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify(OLD));
    const outcome = await Chain.prototype.findEthUsdgPools.call(fakeChain(store, []), 1000);
    assert.equal(outcome.length, 2, 'the old list must be intact');
    assert.ok(Array.isArray(JSON.parse(store.getState('eth_usdg_pools:robinhood'))),
      'the cache must not be timestamped by an empty scan (it would lock for 24 hours)');
  });

  await t('a still-fresh list is used as it is, without a rescan', async () => {
    const store = new Store(':memory:');
    store.setState('eth_usdg_pools:robinhood', JSON.stringify({ ts: Date.now(), pools: OLD }));
    let dipindai = 0;
    const c = fakeChain(store, []);
    c.rpc.getLogs = async () => { dipindai++; return []; };
    const outcome = await Chain.prototype.findEthUsdgPools.call(c, 1000);
    assert.equal(dipindai, 0, 'a still-fresh one need not be scanned');
    assert.equal(outcome.length, 2);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
