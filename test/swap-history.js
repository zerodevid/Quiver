'use strict';
// Swap history test (src/swaplog.js): every kind of asset-swapping tx gets the right method and
// route, and old rows that never recorded token/amount are still read as best as possible
// from their old detail (pay/buy zap, positionSales, bridge direction).
//
// Run: node test/swap-history.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { ensureChain } = require('../src/networks');
const { swapHistory } = require('../src/swaplog');

const chain = ensureChain({});
const { ADDR } = chain;
const MEME = '0x' + 'a1'.repeat(20);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function world() {
  const store = new Store(':memory:');
  store.run('INSERT INTO tokens(chain,address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?,?)', chain.network, MEME, 'MEME', 'Meme', 18, 0);
  store.run(`INSERT INTO positions(id, chain, venue, pool_ref, token0, token1, status, liquidity) VALUES(7, ?, 'v4', '0xpool', ?, ?, 'closed', '0')`,
    chain.network, MEME, ADDR.usdg);
  let ts = 1000;
  const tx = (kind, detail, extra = {}) => store.run(
    'INSERT INTO txs(hash, ts, kind, status, detail, chain, gas_used, gas_price) VALUES(?,?,?,?,?,?,?,?)',
    extra.hash || `0x${kind}${ts}`, ts++, kind, extra.status || 'sukses', JSON.stringify(detail), chain.network, 100000, '0x3b9aca00');
  return { store, tx };
}
const history = (store, o = {}) => swapHistory({ store, chain, ethUsd: 4000, ...o });
const byKind = (list, k) => list.find((x) => x.kind === k);

t('txs that are not swaps (mint, approve) are not included', () => {
  const { store, tx } = world();
  tx('mint', { position: 7 }); tx('approve_kyber', {}); tx('swap_manual', { tokenIn: MEME, tokenOut: ADDR.usdg, symbolIn: 'MEME', symbolOut: 'USDG', amountIn: 5 });
  const l = history(store);
  assert.deepStrictEqual(l.map((x) => x.kind), ['swap_manual']);
  assert.strictEqual(l[0].method, 'manual');
  assert.strictEqual(l[0].route, 'kyber');
});

t('old zap: token from pay/buy, amount out from gotOut, direct pool route from via', () => {
  const { store, tx } = world();
  tx('zap_swap', { via: 'kyber', pay: ADDR.usdg, buy: MEME, gotOut: (3n * E18).toString(), dex: 'uniswap-v4' });
  tx('zap_swap', { via: '0xpoolref', pay: ADDR.usdg, buy: MEME, payRaw: '2500000' });
  const [direct, kyber] = history(store);
  assert.strictEqual(kyber.method, 'zap');
  assert.strictEqual(kyber.route, 'kyber');
  assert.strictEqual(kyber.detail.symbolIn, 'USDG');
  assert.strictEqual(kyber.detail.symbolOut, 'MEME');
  assert.strictEqual(kyber.detail.amountOut, 3);
  assert.strictEqual(direct.route, 'pool');
  assert.strictEqual(direct.detail.amountIn, 2.5);
});

t('leftover sale: origin distinguished (LP close, selling back a zap, fee, sweep)', () => {
  const { store, tx } = world();
  tx('sell_leftover', { position: 7, positionSales: [{ amount: (2n * E18).toString() }, { amount: E18.toString() }], gotOut: '1500000' });
  tx('sell_leftover', { position: null, source: 'zap', tokenIn: MEME, tokenOut: ADDR.usdg, amountInRaw: E18.toString() });
  tx('sell_leftover', { position: 7, source: 'fee' });
  tx('sell_leftover', { position: null, source: 'wallet' });
  tx('sell_leftover', { position: null });
  const l = history(store).reverse();
  assert.deepStrictEqual(l.map((x) => x.method), ['exit', 'unwind', 'fee_sell', 'sweep', 'leftover']);
  // Old row without a token: guessed from its position, amount from positionSales.
  assert.strictEqual(l[0].detail.symbolIn, 'MEME');
  assert.strictEqual(l[0].detail.symbolOut, 'USDG');
  assert.strictEqual(l[0].detail.amountIn, 3);
  assert.strictEqual(l[0].detail.amountOut, 1.5);
  assert.strictEqual(l[0].pair, 'MEME/USDG');
  assert.strictEqual(l[1].detail.amountIn, 1);
});

t('old bridge: direction from wantEth, direct pool recognised', () => {
  const { store, tx } = world();
  tx('bridge_swap', { pool: '0xp', wantEth: true });
  tx('bridge_swap', { via: 'kyber', wantEth: false, dex: 'orvex' });
  const [kyber, direct] = history(store);
  assert.strictEqual(direct.route, 'pool');
  assert.strictEqual(direct.detail.symbolIn, 'USDG');
  assert.strictEqual(direct.detail.symbolOut, 'ETH');
  assert.strictEqual(kyber.route, 'kyber');
  assert.strictEqual(kyber.detail.symbolIn, 'ETH');
});

t('fee claim: amount per side from fee_claims, USD value from the quote side', () => {
  const { store, tx } = world();
  tx('claim_fees', { position: 7 }, { hash: '0xklaim' });
  store.run('INSERT INTO fee_claims(tx_hash,position_id,ts,amount0,amount1,value_quote) VALUES(?,?,?,?,?,?)',
    '0xklaim', 7, 1, (4n * E18).toString(), '2000000', 2.4);
  const [k] = history(store);
  assert.strictEqual(k.method, 'claim');
  assert.strictEqual(k.route, null);
  assert.strictEqual(k.claim.amount0, 4);
  assert.strictEqual(k.claim.amount1, 2);
  assert.strictEqual(k.claim.usd, 2.4);
});

t('kind filter: only the requested kind, a foreign kind is ignored', () => {
  const { store, tx } = world();
  tx('swap_manual', {}); tx('claim_fees', { position: 7 }); tx('wrap_eth', { amountInRaw: E18.toString() });
  assert.deepStrictEqual(history(store, { kinds: ['claim_fees'] }).map((x) => x.kind), ['claim_fees']);
  assert.deepStrictEqual(history(store, { kinds: ['burn'] }), []);
  const w = history(store, { kinds: ['wrap_eth'] })[0];
  assert.strictEqual(w.detail.amountIn, 1);
  assert.strictEqual(w.detail.amountOut, 1);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
