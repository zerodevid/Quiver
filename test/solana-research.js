'use strict';
// Tests of Solana wallet research (src/solana/research.js) on REAL MAINNET TRANSACTIONS
// stored as fixtures (test/fixtures/solana/*.json, RPC jsonParsed format):
//   meteora-rebalance      withdraw + claim fees (ClaimFee & ClaimFee2) + close + open + add
//   orca-open / orca-close open+add; withdraw + collect_fees (no event) + close
//   raydium-increase       add (pool & price from LiquidityChange/LiquidityCalculate)
//   raydium-decrease-close withdraw (fees separate) + close
// No network: only pool state & live positions are faked.
//
// Run: node test/solana-research.js
const assert = require('node:assert');
const { SolanaWalletResearch } = require('../src/solana/research');
const { Store } = require('../src/db');
const u = require('../src/solana/units');
const m = require('../src/v3math');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}
const fx = (n) => require(`./fixtures/solana/${n}.json`);
const WSOL = 'So11111111111111111111111111111111111111112', USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function research({ pools = {}, live = [] } = {}) {
  const store = new Store(':memory:');
  const { SolanaChain } = require('../src/solana/chain');
  const chain = new SolanaChain({ run: async () => { throw new Error('rpc palsu'); } }, store, () => {}, 'solana', { jupiter: { prices: async () => new Map(), tokenInfo: async () => new Map() } });
  chain.pool = async (venue, addr) => pools[addr] || null;
  chain.tokens = async (list) => list.map((a) => ({ address: a, symbol: a === WSOL ? 'SOL' : a === USDC ? 'USDC' : 'X', decimals: a === WSOL ? 9 : 6 }));
  for (const a of Object.values(chain.adapters)) a.listPositions = async () => live.filter((p) => p.venue === a.key);
  // The token tracker (proceeds) reads transfer history: answer "no transfers" so a scan is
  // complete — a refused read would (rightly) leave the tokens counted as still held.
  const conn = { getSignaturesForAddress: async () => [], getTokenAccountsByOwner: async () => ({ value: [] }), getParsedTransaction: async () => null };
  const rpc = { slot: async () => 1, run: async (fn) => fn(conn) };
  return { r: new SolanaWalletResearch({ rpc, store, chain, log: () => {} }), store };
}
const ev = (r, name) => { const f = fx(name); return r.extract({ sig: f.signature, tx: f.tx }); };

(async () => {
  console.log('riset wallet solana');

  await t('Meteora rebalance: withdraw, claim fees ONCE (ClaimFee & ClaimFee2), close, open with a bin range, add', () => {
    const { r } = research();
    const e = ev(r, 'meteora-rebalance');
    assert.deepStrictEqual(e.map((x) => x.kind), ['decrease', 'collect', 'close', 'open', 'increase']);
    const [dec, col, , open, inc] = e;
    assert.strictEqual(dec.a1, 52478545n); assert.strictEqual(dec.activeBin, -5408);
    assert.deepStrictEqual([col.f0, col.f1], [47206n, 5420n]);
    assert.strictEqual(e.filter((x) => x.kind === 'collect').length, 1, 'not twice');
    assert.notStrictEqual(open.id, dec.id, 'new position');
    assert.deepStrictEqual([open.lowerBin, open.upperBin], [-5414, -5408]);
    assert.strictEqual(inc.a1, 52483529n);
  });

  await t('Orca: open + add (ticks & L from events); close: withdraw + collect_fees from vault transfers + close', () => {
    const { r } = research();
    const o = ev(r, 'orca-open');
    assert.deepStrictEqual(o.map((x) => x.kind), ['open', 'increase']);
    assert.deepStrictEqual([o[1].tickLower, o[1].tickUpper, o[1].liq], [-21596, -21192, 1123967762n]);
    const c = ev(r, 'orca-close');
    assert.deepStrictEqual(c.map((x) => x.kind), ['decrease', 'collect', 'close']);
    assert.deepStrictEqual([c[1].f0, c[1].f1], [57n, 23n]);
    assert.strictEqual(c[0].id, o[0].id, 'the same position');
  });

  await t('Raydium: position from the NFT mint PDA, pool & sqrt price from the accompanying event; withdrawal fees separate', () => {
    const { r } = research();
    const inc = ev(r, 'raydium-increase');
    assert.strictEqual(inc.length, 1);
    assert.ok(inc[0].pool && inc[0].sqrtX96 > 0n);
    assert.deepStrictEqual([inc[0].a0, inc[0].a1], [3129889n, 8974638n]);
    const d = ev(r, 'raydium-decrease-close');
    assert.deepStrictEqual(d.map((x) => x.kind), ['decrease', 'close']);
    assert.strictEqual(d[0].f1, 282398n);
    assert.strictEqual(d[1].id, d[0].id);
  });

  await t('price from the range composition (Orca): √P = √A + amount1/L, clamped to the range', () => {
    const sa = m.getSqrtRatioAtTick(-100), sb = m.getSqrtRatioAtTick(100);
    assert.strictEqual(SolanaWalletResearch.sqrtFromAmounts(10n ** 12n, 5n, 0n, -100, 100), sa, 'all token0: lower edge');
    assert.strictEqual(SolanaWalletResearch.sqrtFromAmounts(10n ** 12n, 0n, 5n, -100, 100), sb, 'all token1: upper edge');
    const mid = m.getSqrtRatioAtTick(0);
    const L = 10n ** 18n;
    const { amount0, amount1 } = m.amountsForLiquidity(mid, sa, sb, L);
    const got = SolanaWalletResearch.sqrtFromAmounts(L, amount0, amount1, -100, 100);
    assert.ok((got > mid ? got - mid : mid - got) * 1_000_000n < mid, 'a mid-range price is recovered');
  });

  await t('Orca position cycle open→close: capital, proceeds, fees, PnL and events stored in USD', async () => {
    const pool = { venue: 'orca', id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', token0: WSOL, token1: USDC, dec0: 9, dec1: 6,
      sqrtX96: u.sqrtX96FromPrice(113 * 1e-3), tick: -21700, fee: 400, tickSpacing: 4 };
    const { r, store } = research({ pools: { [pool.id]: pool } });
    const txs = ['orca-open', 'orca-close'].map((n) => ({ sig: fx(n).signature, tx: fx(n).tx }));
    const positions = await r.build(fx('orca-open').wallet, txs, 113);
    await r.persist(fx('orca-open').wallet, positions, { fromSlot: 1, head: 2, ethUsd: 113 });
    const p = store.get('SELECT * FROM wpositions');
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.incomplete, 0);
    assert.ok(p.invested_q > 7 && p.invested_q < 8.5, `capital $${p.invested_q}`);   // 0.0336 SOL + 3.79 USDC ≈ $7.6
    assert.ok(p.returned_q > 7 && p.returned_q < 8.5, `proceeds $${p.returned_q}`);
    assert.ok(p.fees_q > 0);
    // The token tracker owns the PnL of a closed position: the SOL side that came back is tracked
    // like any non-quote side (as ETH is on EVM), realized where sold and valued now where held.
    assert.ok(p.realized_q != null && p.unrealized_q != null, 'tracked');
    assert.ok(Math.abs(p.pnl_q - (p.realized_q + p.unrealized_q - p.invested_q)) < 1e-9);
    assert.deepStrictEqual([p.tick_lower, p.tick_upper], [-21596, -21192]);
    assert.deepStrictEqual(store.all('SELECT kind FROM wevents ORDER BY block, log_index').map((x) => x.kind), ['mint', 'decrease', 'collect']);
    const w = JSON.parse(store.get('SELECT stats FROM wallets').stats);
    assert.strictEqual(w.closedCount, 1);
  });

  await t('a position no longer live without a withdrawal/close event read → incomplete (not a 100% loss)', async () => {
    const pool = { venue: 'orca', id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', token0: WSOL, token1: USDC, dec0: 9, dec1: 6, sqrtX96: u.sqrtX96FromPrice(0.113), tick: -21700 };
    const { r, store } = research({ pools: { [pool.id]: pool } });
    const positions = await r.build(fx('orca-open').wallet, [{ sig: fx('orca-open').signature, tx: fx('orca-open').tx }], 113);
    await r.persist(fx('orca-open').wallet, positions, { fromSlot: 1, head: 2, ethUsd: 113 });
    const p = store.get('SELECT * FROM wpositions');
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.incomplete, 1);
    assert.strictEqual(p.pnl_q, null);
    assert.strictEqual(JSON.parse(store.get('SELECT stats FROM wallets').stats).totalProfitUsd, 0, 'not counted as profit');
  });

  await t('a position still live: status open, valued from its current contents', async () => {
    const pool = { venue: 'orca', id: 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE', token0: WSOL, token1: USDC, dec0: 9, dec1: 6, sqrtX96: u.sqrtX96FromPrice(0.113), tick: -21400 };
    const id = fx('orca-open').tx.meta.logMessages ? r0id() : null;
    function r0id() { const { r } = research(); return ev(r, 'orca-open')[0].id; }
    const live = [{ venue: 'orca', id, pool: pool.id, liquidity: '1123967762', amount0: 10n ** 8n, amount1: 5_000_000n, fee0: 0n, fee1: 1_000_000n, tickLower: -21596, tickUpper: -21192 }];
    const { r, store } = research({ pools: { [pool.id]: pool }, live });
    const positions = await r.build(fx('orca-open').wallet, [{ sig: fx('orca-open').signature, tx: fx('orca-open').tx }], 113);
    await r.persist(fx('orca-open').wallet, positions, { fromSlot: 1, head: 2, ethUsd: 113 });
    const p = store.get('SELECT * FROM wpositions');
    assert.strictEqual(p.status, 'open');
    assert.ok(Math.abs(p.live_value_q - (0.1 * 113 + 5)) < 0.01, `value $${p.live_value_q}`);
    assert.ok(Math.abs(p.live_fee_q - 1) < 1e-6);
    assert.strictEqual(p.in_range, 1);
  });

  await t('public RPC: old transactions refused by the history endpoint (constant 429) are skipped quickly — the scan does not hang', async () => {
    const { r } = research();
    const now = Math.floor(Date.now() / 1000);
    // 3 new transactions (on the fast endpoint), 40 old ones (only on the history endpoint, which always 429s)
    const sigs = [...Array(43)].map((_, i) => ({ signature: `s${i}`, blockTime: i < 3 ? now - 60 * 30 : now - 3600 * 40 - i }));
    let histCalls = 0;
    r.rpc = { run: async (fn, o = {}) => {
      if (o.needsHistory) { histCalls++; throw new Error('429 Too Many Requests'); }
      return fn({ getParsedTransaction: async (s) => (Number(s.slice(1)) < 3 ? { meta: { err: null }, transaction: {} } : null) });
    } };
    r.withRetry = (f) => f();
    const t0 = Date.now();
    const txs = await r.transactions(sigs);
    assert.strictEqual(txs.length, 3);
    assert.strictEqual(txs.oldUnread, 40);
    assert.strictEqual(txs.missing.length, 0, 'not made pending (it will never be available)');
    assert.ok(histCalls <= 12, `history endpoint asked ${histCalls}× — must stop after a few refusals`);
    assert.ok(Date.now() - t0 < 15_000, 'finishes quickly');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
