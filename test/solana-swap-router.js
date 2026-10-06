'use strict';
// Tests of the Solana multi-aggregator swap router (src/solana/swap-router.js) and the Raydium
// adapter (src/solana/swap-raydium.js). No network: aggregators are fakes / fake fetch.
//
// Run: node test/solana-swap-router.js
const assert = require('node:assert');
const { SwapRouter } = require('../src/solana/swap-router');
const { RaydiumSwap } = require('../src/solana/swap-raydium');
const { LifiSwap, OkxSwap, OpenOceanSwap, DflowSwap, decodeTx } = require('../src/solana/swap-adapters');
const { SolanaManual } = require('../src/solana/manual');
const { Keypair, VersionedTransaction, TransactionMessage } = require('@solana/web3.js');
const bs58 = require('bs58').default;

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
    await assert.rejects(r.quote(SOL, USDC, 1n), /mati atau belum punya API key/);
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

  // ---- more aggregators (LI.FI, OKX, OpenOcean, DFlow) ------------------------------------------
  const payer = Keypair.generate();
  const mkTx = (kp = payer) => new VersionedTransaction(new TransactionMessage({
    payerKey: kp.publicKey, recentBlockhash: bs58.encode(Buffer.alloc(32, 1)), instructions: [] }).compileToV0Message());
  const b64 = (tx) => Buffer.from(tx.serialize()).toString('base64');
  const b58 = (tx) => bs58.encode(tx.serialize());
  const OWNER = payer.publicKey.toBase58();
  const quoteOf = (out, extra = {}) => ({ inputMint: SOL, outputMint: USDC, inAmount: '1000', outAmount: String(out), slippageBps: 100, ...extra });

  await t('decodeTx reads both base64 and base58 and rejects garbage', async () => {
    const tx = mkTx();
    assert.strictEqual(decodeTx(b64(tx)).message.staticAccountKeys[0].toBase58(), OWNER);
    assert.strictEqual(decodeTx(b58(tx)).message.staticAccountKeys[0].toBase58(), OWNER);
    assert.throws(() => decodeTx('not a transaction'), /unreadable/);
  });

  await t('LI.FI: quote works without a key; swapTx rebuilds for the wallet and refuses a drifted price', async () => {
    const calls = [];
    const reply = (toAmount) => async (url) => { calls.push(url);
      return resp({ estimate: { toAmount }, tool: 'okx', toolDetails: { name: 'OKX' }, transactionRequest: { data: b64(mkTx()) } }); };
    const l = new LifiSwap({ fetchImpl: reply('1000') });
    const q = await l.quote(SOL, USDC, 500n);
    assert.strictEqual(q.outAmount, '1000'); assert.match(q.routePlan[0].swapInfo.label, /OKX/);
    assert.ok(!calls[0].includes(OWNER), 'the quote uses a placeholder address');
    assert.ok(l.hasCredentials());
    const ok = await l.swapTx(q, OWNER);
    assert.strictEqual(ok.tx.message.staticAccountKeys[0].toBase58(), OWNER);
    assert.ok(calls[1].includes(OWNER), 'the build uses the real wallet');
    await assert.rejects(new LifiSwap({ fetchImpl: reply('900') }).swapTx(q, OWNER), /price moved/);
  });

  await t('keyed aggregators have no credentials until configured (OKX needs key+secret+passphrase)', async () => {
    let s = {};
    const okx = new OkxSwap({ settings: () => s }), dflow = new DflowSwap({ settings: () => s }), oo = new OpenOceanSwap({ settings: () => s });
    assert.deepStrictEqual([okx, dflow, oo].map((a) => a.hasCredentials()), [false, false, false]);
    s = { api_key: 'k', secret_key: 's' };
    assert.deepStrictEqual([okx.hasCredentials(), dflow.hasCredentials(), oo.hasCredentials()], [false, true, true]);
    s = { api_key: 'k', secret_key: 's', passphrase: 'p' };
    assert.strictEqual(okx.hasCredentials(), true);
  });

  await t('OKX: signed headers, native SOL mapped to the system address, base58 tx accepted', async () => {
    let seen;
    const okx = new OkxSwap({ settings: () => ({ api_key: 'K', secret_key: 'S', passphrase: 'P' }), fetchImpl: async (url, o) => {
      seen = { url, h: o.headers };
      return resp({ code: '0', data: [url.includes('/swap?')
        ? { routerResult: { toTokenAmount: '1000' }, tx: { data: b58(mkTx()) } }
        : { routerResult: { toTokenAmount: '1000', dexRouterList: [{ dexProtocol: { dexName: 'Whirlpool' } }] } }] });
    } });
    const q = await okx.quote(SOL, USDC, 500n);
    assert.ok(seen.url.includes('fromTokenAddress=11111111111111111111111111111111'));
    assert.ok(seen.h['OK-ACCESS-SIGN'] && seen.h['OK-ACCESS-KEY'] === 'K');
    assert.strictEqual(q.routePlan[0].swapInfo.label, 'Whirlpool');
    assert.strictEqual((await okx.swapTx(q, OWNER)).tx.message.staticAccountKeys[0].toBase58(), OWNER);
  });

  await t('DFlow: x-api-key header, quote then swap with the quote echoed back', async () => {
    let body;
    const d = new DflowSwap({ settings: () => ({ api_key: 'K' }), fetchImpl: async (url, o) => {
      assert.strictEqual(o.headers['x-api-key'], 'K');
      if (o.method === 'POST') { body = JSON.parse(o.body); return resp({ swapTransaction: b64(mkTx()) }); }
      return resp({ outAmount: '1000', routePlan: [{ venue: 'Orca' }] });
    } });
    const q = await d.quote(SOL, USDC, 500n);
    await d.swapTx(q, OWNER);
    assert.strictEqual(body.userPublicKey, OWNER); assert.strictEqual(body.quoteResponse.outAmount, '1000');
  });

  await t('OpenOcean: human-readable amount from decimals, apikey header, tx under data.data', async () => {
    let url0;
    const oo = new OpenOceanSwap({ settings: () => ({ api_key: 'K' }), decimalsOf: async () => 9, fetchImpl: async (url, o) => {
      url0 = url0 || url; assert.strictEqual(o.headers.apikey, 'K');
      return resp({ code: 200, data: { outAmount: '1000', data: b64(mkTx()) } });
    } });
    const q = await oo.quote(SOL, USDC, 1_500_000_000n);
    assert.ok(url0.includes('amount=1.5'), url0);
    assert.strictEqual((await oo.swapTx(q, OWNER)).tx.message.staticAccountKeys[0].toBase58(), OWNER);
  });

  await t('router refuses a transaction whose fee payer is not the wallet and falls back', async () => {
    const stranger = mkTx(Keypair.generate());
    const bad = { ...agg('raydium', 120), swapTx: async () => ({ tx: stranger, lastValidBlockHeight: 1 }) };
    const good = { ...agg('jupiter', 100), swapTx: async () => ({ tx: mkTx(), lastValidBlockHeight: 1 }) };
    const r = router(bad, good);
    const b = await r.swapTx(await r.quote(SOL, USDC, 1n), OWNER);
    assert.strictEqual(b.quote.aggregator, 'jupiter');
  });

  await t('keyless-off aggregators are listed as "off" with the reason and never asked', async () => {
    const asked = [];
    const keyed = { ...agg('okx', 999), needsKey: true, hasCredentials: () => false, quote: async () => { asked.push('okx'); return null; } };
    const r = router(agg('jupiter', 100), keyed);
    const routes = await r.quoteAll(SOL, USDC, 1n);
    assert.deepStrictEqual(routes.map((x) => [x.id, x.state]), [['jupiter', 'ok'], ['okx', 'off']]);
    assert.strictEqual(routes[1].blocker, 'butuh API key');
    assert.deepStrictEqual(asked, []);
    assert.strictEqual(r.byId.get('okx').enabled(), false);
  });

  // ---- balance reads under RPC rate limits -------------------------------------------------
  const WSOL_ = SOL;
  const fakeManual = (balances) => {
    const m = Object.create(SolanaManual.prototype);
    const calls = { n: 0 };
    m.log = () => {}; m.network = 'solana';
    m.engine = { exec: { address: () => OWNER, balances: async () => { calls.n++; return balances(calls.n); },
      staleBalances: (age) => (m.cache && Date.now() - m.cache.at <= age ? m.cache.map : null) },
      leftovers: () => [] };
    m.chain = { ADDR: { usdg: USDC, usdt: USDC }, QUOTES: {}, tokens: async () => [] };
    m.store = { all: () => [] };
    m.customTokens = () => [];
    m.rawOf = (bal, a) => bal.get(a) || 0n;
    m.cache = { at: Date.now(), map: new Map([[WSOL_, 5n * 10n ** 9n]]) };
    return { m, calls };
  };
  const E429 = () => new Error('429 Too Many Requests');

  await t('a quote still works from the cached balance when the RPC answers 429', async () => {
    const { m } = fakeManual(() => { throw E429(); });
    const held = await m.held();
    assert.strictEqual(held.find((x) => x.address === WSOL_).raw, String(5n * 10n ** 9n));
  });

  await t('with no cache and a 429, the page list is empty instead of failing', async () => {
    const { m } = fakeManual(() => { throw E429(); });
    m.cache = null;
    assert.strictEqual((await m.held()).find((x) => x.address === WSOL_).raw, '0');
  });

  await t('a real swap needs a FRESH balance: retried, then refused (never the stale one)', async () => {
    const { m, calls } = fakeManual(() => { throw E429(); });
    const t0 = Date.now();
    await assert.rejects(m.held({ fresh: true }), /429.*tidak ada transaksi dikirim/);
    assert.strictEqual(calls.n, 3, 'tried three times');
    assert.ok(Date.now() - t0 >= 3900, 'waited between tries');
  });

  await t('a real swap recovers when the RPC answers on the retry', async () => {
    const { m } = fakeManual((n) => { if (n < 2) throw E429(); return new Map([[WSOL_, 7n]]); });
    assert.strictEqual((await m.held({ fresh: true })).find((x) => x.address === WSOL_).raw, '7');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
