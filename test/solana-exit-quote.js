'use strict';
// SolanaEngine.exitQuote: the read-only exit estimate behind the close / reduce / claim dialogs.
// The swap router and chain are stubbed; the engine method is the real code.
//
// Run: node test/solana-exit-quote.js
const assert = require('node:assert');
const { SolanaEngine } = require('../src/solana/engine');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const USDC = 'USDCmint', MEME = 'MEMEmint';
const QUOTES = { [USDC]: { symbol: 'USDC', decimals: 6, kind: 'usd' } };

function engine({ route = async () => ({ outAmount: '9000000', aggregator: 'jupiter' }), gas = [] } = {}) {
  const e = Object.create(SolanaEngine.prototype);
  e.ethUsd = 150;
  e.rulesFrom = () => ({ swap: { max_slippage_bps: 100 } });
  e.store = { all: () => gas };
  e.chain = {
    network: 'solana', ADDR: { usdg: USDC }, QUOTES,
    quoteSideOf: (a, b) => (QUOTES[a] ? { side: 0, ...QUOTES[a] } : QUOTES[b] ? { side: 1, ...QUOTES[b] } : null),
    // memecoin worth 1 USDC per 1e6 raw units: the mid value of `amount` raw is amount / 1e6
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0 + amount1) / 1e6 }),
    router: { quote: async (...a) => route(...a) },
  };
  return e;
}
// MEME(6)/USDC(6): 10 MEME + 10 USDC in the position, mid value $20
const live = {
  id: 1, token0: MEME, token1: USDC, dec0: 6, dec1: 6, curSqrt: '1', markSqrt: null,
  amount0: '10000000', amount1: '10000000', fee0: '0', fee1: '0',
  valueUsd: 20, feeUsd: 0, claimedUsd: 0, withdrawnUsd: 0, costUsd: 20, pnlUsd: 0,
};

(async () => {
  await t('the memecoin side is valued at the router quote, the quote asset side at face value', async () => {
    const q = await engine().exitQuote(live);
    // memecoin mid $10 sells for $9; USDC side kept at $10
    assert.ok(Math.abs(q.receiveUsd - 19) < 1e-9, `receive ${q.receiveUsd}`);
    assert.ok(Math.abs(q.sellCostUsd - 1) < 1e-9, `sell cost ${q.sellCostUsd}`);
    assert.strictEqual(q.quoted, true);
    assert.strictEqual(q.legs.length, 1);
    assert.strictEqual(q.legs[0].via, 'jupiter');
  });

  await t('no route: the leg falls back to the mid price and the quote is flagged as not quoted', async () => {
    const q = await engine({ route: async () => { throw new Error('no route'); } }).exitQuote(live);
    assert.strictEqual(q.quoted, false);
    assert.ok(Math.abs(q.receiveUsd - 20) < 1e-9);
    assert.strictEqual(q.sellCostUsd, 0);
  });

  await t('a scaled-down live (partial decrease) only quotes the part that leaves', async () => {
    let asked = null;
    const e = engine({ route: async (_in, _out, amount) => { asked = amount; return { outAmount: '4500000' }; } });
    const q = await e.exitQuote({ ...live, amount0: '5000000', amount1: '5000000', valueUsd: 10 });
    assert.strictEqual(String(asked), '5000000');
    assert.ok(Math.abs(q.receiveUsd - 9.5) < 1e-9, `receive ${q.receiveUsd}`);
  });

  await t('a pool whose both sides are quote assets has no leftover to sell', async () => {
    const e = engine();
    e.chain.QUOTES = { ...QUOTES, [MEME]: { symbol: 'SOL', decimals: 6, kind: 'eth' } };
    let calls = 0;
    e.chain.router.quote = async () => { calls++; return { outAmount: '1' }; };
    const q = await e.exitQuote(live);
    assert.strictEqual(calls, 0);
    assert.strictEqual(q.legs.length, 0);
  });

  await t('gas is the average of recent exit and sale transactions', async () => {
    const gas = [{ kind: 'burn', gas_quote: 0.02 }, { kind: 'burn', gas_quote: 0.04 }, { kind: 'sell_leftover', gas_quote: 0.01 }];
    const q = await engine({ gas }).exitQuote(live);
    assert.ok(Math.abs(q.gasUsd - 0.04) < 1e-9, `gas ${q.gasUsd}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
