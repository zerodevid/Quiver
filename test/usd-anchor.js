'use strict';
// Positions in a pair with no quote asset (memecoin / memecoin) are valued in USD through
// a DexScreener anchor on one token.
//
// Real case (2026-10-14): a target's HOOD/CUCK v3 position showed PnL, fees and capital
// as $0.00 because valueInQuote() returns null when neither token is USDG/ETH/WETH.
//
// Run: node test/usd-anchor.js
const assert = require('node:assert');
const { ensureChain } = require('../src/networks');
const { ensureAnchor, valueAnchoredUsd } = require('../src/usd-anchor');
const m = require('../src/v3math');

const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
const chain = ensureChain({ network: 'robinhood' });

(async () => {
  const sqrt = m.getSqrtRatioAtTick(0);   // price 1:1 at equal decimals
  const args = { sqrtPriceX96: sqrt, amount0: 10n ** 18n, amount1: 2n * 10n ** 18n, dec0: 18, dec1: 18, token0: A, token1: B };
  assert.strictEqual(chain.valueInQuote ? chain.valueInQuote(args) : null, null);
  assert.strictEqual(valueAnchoredUsd(chain, args), null, 'no anchor yet: unknown, not zero');

  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    const base = url.split('/').pop();
    return { ok: true, json: async () => [
      { baseToken: { address: base }, quoteToken: { address: '0x' + 'cc'.repeat(20) }, priceUsd: base === A ? '3' : '1', priceNative: '1', liquidity: { usd: 100 } },
    ] };
  };
  await ensureAnchor(chain, A, B, fake);
  // 1 A + 2 B at a 1:1 pool price = 3 A-units * $3
  assert.ok(Math.abs(valueAnchoredUsd(chain, args) - 9) < 1e-9);
  await ensureAnchor(chain, A, B, fake);
  assert.strictEqual(calls.length, 2, 'second call is served from the cache');
  console.log('ok');
})();
