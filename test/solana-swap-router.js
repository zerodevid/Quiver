'use strict';
// Tests of the Solana multi-aggregator swap router (src/solana/swap-router.js) and the Raydium
// adapter (src/solana/swap-raydium.js). No network: aggregators are fakes / fake fetch.
//
// Run: node test/solana-swap-router.js
const assert = require('node:assert');
const { SwapRouter } = require('../src/solana/swap-router');
const { RaydiumSwap } = require('../src/solana/swap-raydium');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const agg = (name, out, { fail: f = null, txFail = false } = {}) => ({
  name, label: name.toUpperCase(),
  quote: async () => { if (f) throw new Error(f); return { inputMint: SOL, outputMint: USDC, outAmount: String(out) }; },
  swapTx: async (q) => { if (txFail) throw new Error('build failed'); return { tx: { by: name }, lastValidBlockHeight: 1 }; },
});
const router = (...aggregators) => new SwapRouter({ aggregators, log: () => {}, tokenAccount: async () => 'ACC' });

(async () => {
  console.log('solana swap router');

  await t('the quote with the largest output wins and carries the others as alternatives', async () => {
    const q = await router(agg('jupiter', 100), agg('raydium', 120)).quote(SOL, USDC, 1n);
    assert.strictEqual(q.aggregator, 'raydium');
    assert.deepStrictEqual(q.alternatives.map((a) => a.aggregator), ['jupiter']);
  });

  await t('an aggregator that errors is skipped, the other one still quotes', async () => {
    const q = await router(agg('jupiter', 0, { fail: 'boom' }), agg('raydium', 50)).quote(SOL, USDC, 1n);
    assert.strictEqual(q.aggregator, 'raydium');
  });

  await t('no route anywhere throws and names every aggregator', async () => {
    await assert.rejects(router(agg('jupiter', 0, { fail: 'a' }), agg('raydium', 0, { fail: 'b' })).quote(SOL, USDC, 1n),
      /jupiter: a; raydium: b/);
  });

  await t('quoteAll lists failures after the ok routes', async () => {
    const r = await router(agg('jupiter', 0, { fail: 'x' }), agg('raydium', 5)).quoteAll(SOL, USDC, 1n);
    assert.deepStrictEqual(r.map((x) => [x.id, x.state]), [['raydium', 'ok'], ['jupiter', 'error']]);
  });

  await t('swapTx falls back to the next aggregator and reports the quote actually used', async () => {
    const r = router(agg('jupiter', 100), agg('raydium', 120, { txFail: true }));
    const q = await r.quote(SOL, USDC, 1n);
    const b = await r.swapTx(q, 'OWNER');
    assert.strictEqual(b.tx.by, 'jupiter');
    assert.strictEqual(b.quote.aggregator, 'jupiter');
  });

  await t('swapTx throws when every aggregator fails to build', async () => {
    const r = router(agg('jupiter', 100, { txFail: true }), agg('raydium', 120, { txFail: true }));
    await assert.rejects(r.swapTx(await r.quote(SOL, USDC, 1n), 'OWNER'), /every aggregator/);
  });

  await t('mode "order" follows the configured order even when a later aggregator pays more', async () => {
    const r = router(agg('jupiter', 100), agg('raydium', 120));
    r.setConfig({ aggregators: { mode: 'order', order: ['jupiter', 'raydium'] } });
    assert.strictEqual((await r.quote(SOL, USDC, 1n)).aggregator, 'jupiter');
    r.setConfig({ aggregators: { mode: 'order', order: ['raydium', 'jupiter'] } });
    assert.strictEqual((await r.quote(SOL, USDC, 1n)).aggregator, 'raydium');
  });

  await t('a disabled aggregator is never asked; all disabled is a clear error', async () => {
    const r = router(agg('jupiter', 100), agg('raydium', 120));
    r.setConfig({ aggregators: { raydium: { enabled: false } } });
    assert.strictEqual((await r.quote(SOL, USDC, 1n)).aggregator, 'jupiter');
    r.setConfig({ aggregators: { jupiter: { enabled: false }, raydium: { enabled: false } } });
    await assert.rejects(r.quote(SOL, USDC, 1n), /dimatikan/);
  });

  await t('order() lists configured ids first and appends unmentioned ones; byId has settings-page fields', async () => {
    const r = router(agg('jupiter', 1), agg('raydium', 1));
    r.setConfig({ aggregators: { order: ['raydium', 'nonsense'] } });
    assert.deepStrictEqual(r.order(), ['raydium', 'jupiter']);
    assert.strictEqual(r.byId.get('jupiter').enabled(), true);
    assert.strictEqual(r.mode(), 'best');
  });

  // ---- Raydium adapter ----------------------------------------------------------------
  const resp = (body, status = 200) => ({ ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });

  await t('Raydium quote is normalised (impact percent → fraction, route labels)', async () => {
    const ray = new RaydiumSwap({ fetchImpl: async () => resp({ success: true, data: {
      outputAmount: '120039404', otherAmountThreshold: '118839009', priceImpactPct: 0.5, routePlan: [{}, {}] } }) });
    const q = await ray.quote(SOL, USDC, 1_000_000_000n);
    assert.strictEqual(q.outAmount, '120039404');
    assert.strictEqual(Number(q.priceImpactPct), 0.005);
    assert.strictEqual(q.routePlan.length, 2);
  });

  await t('Raydium: a Cloudflare page or success:false is an error, not a quote', async () => {
    await assert.rejects(new RaydiumSwap({ fetchImpl: async () => resp('<html>Just a moment', 403) }).quote(SOL, USDC, 1n), /raydium 403/);
    await assert.rejects(new RaydiumSwap({ fetchImpl: async () => resp({ success: false, msg: 'ROUTE_NOT_FOUND' }) }).quote(SOL, USDC, 1n), /ROUTE_NOT_FOUND/);
  });

  await t('Raydium swapTx refuses a multi-transaction answer and a missing input account', async () => {
    const ray = new RaydiumSwap({ fetchImpl: async () => resp({ success: true, data: [{ transaction: 'AA==' }, { transaction: 'AA==' }] }) });
    await assert.rejects(ray.swapTx({ inputMint: SOL, outputMint: USDC, raw: {} }, 'OWNER'), /2 transactions/);
    await assert.rejects(ray.swapTx({ inputMint: USDC, outputMint: SOL, raw: {} }, 'OWNER'), /input token account/);
  });

  await t('Raydium swapTx wraps SOL in, unwraps SOL out and caps the priority fee', async () => {
    const bodies = [];
    const ray = new RaydiumSwap({ fetchImpl: async (url, o) => {
      if (url.includes('auto-fee')) return resp({ data: { default: { h: 9_000_000 } } });
      bodies.push(JSON.parse(o.body)); return resp({ success: true, data: [] });
    } });
    await assert.rejects(ray.swapTx({ inputMint: SOL, outputMint: USDC, raw: {} }, 'OWNER', { maxPriorityLamports: 400_000 }));
    await assert.rejects(ray.swapTx({ inputMint: USDC, outputMint: SOL, raw: {} }, 'OWNER', { inputAccount: 'ACC' }));
    assert.strictEqual(bodies[0].wrapSol, true); assert.strictEqual(bodies[0].unwrapSol, false);
    assert.strictEqual(bodies[0].computeUnitPriceMicroLamports, '1000000', '400k lamports / 400k CU = 1M micro-lamports');
    assert.strictEqual(bodies[1].unwrapSol, true); assert.strictEqual(bodies[1].inputAccount, 'ACC');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
