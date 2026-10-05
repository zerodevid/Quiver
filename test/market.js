'use strict';
// Market data for the position detail page: DexScreener/GeckoTerminal cache and
// deriving the entry price for old positions. Run: node test/market.js
const assert = require('node:assert');
const { Market } = require('../src/market');
const { Positions } = require('../src/positions');
const m = require('../src/v3math');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const POOL = '0x' + 'ab'.repeat(32);
function fake({ status = 200, candles = [[1000, 1, 2, 0.5, 1.5, 10], [2000, 1.5, 3, 1, 2, 20]] } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (status !== 200) return { ok: false, status, json: async () => ({}) };
    if (url.startsWith('https://api.dexscreener.com/')) {
      return { ok: true, status: 200, json: async () => ({ pairs: [{ url: 'u', dexId: 'uniswap', labels: ['v4'], baseToken: { address: '0xA', symbol: 'X' }, quoteToken: { address: '0xB', symbol: 'USDG' }, priceUsd: '0.5', liquidity: { usd: 100 } }] }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: candles } }, meta: { base: { address: '0xA', symbol: 'X' }, quote: { address: '0xB', symbol: 'USDG' } } }) };
  };
  return { mk: new Market({ fetch: fetchImpl }), calls };
}

(async () => {
  console.log('market');

  await check('candles sorted ascending and their time in milliseconds', async () => {
    const { mk } = fake({ candles: [[2000, 1.5, 3, 1, 2, 20], [1000, 1, 2, 0.5, 1.5, 10]] });
    const r = await mk.candles(POOL, '1h');
    assert.deepStrictEqual(r.candles.map((c) => c.t), [1000000, 2000000]);
    assert.strictEqual(r.candles[0].c, 1.5);
    assert.strictEqual(r.base.address, '0xa');
  });

  await check('a failed call (429/502) uses the last good answer, marked stale', async () => {
    let gagalkan = false;
    const mk = new Market({ fetch: async (url) => {
      if (gagalkan) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[1000, 1, 2, 0.5, 1.5, 10]] } } }) };
    } });
    const baik = await mk.memo('k', 0, () => mk.candles(POOL, '1h'));
    assert.ok(!baik.error && !baik.stale, 'the first call must be clean');
    gagalkan = true;
    const backup = await mk.memo('k', 0, async () => ({ error: 'batas panggilan (429) — coba lagi sebentar' }));
    assert.ok(!backup.error, `must use the fallback: ${backup.error}`);
    assert.strictEqual(backup.stale, true, 'ditandai stale');
    assert.ok(backup.staleAt > 0, 'the fallback\'s age is carried');
    assert.strictEqual(backup.candles.length, 1, 'its content is the last good answer');
  });

  await check('pool transactions: buy/sell direction relative to the speculative token, price from the swap amounts, newest first', async () => {
    const X = '0x' + 'a'.repeat(40), USDG = '0x' + 'b'.repeat(40);
    const row = (id, ts, from, to, fromAmt, toAmt, kind) => ({ id, attributes: {
      block_timestamp: ts, tx_hash: `0x${id}`, tx_from_address: '0x' + 'c'.repeat(40), kind,
      from_token_address: from, to_token_address: to, from_token_amount: String(fromAmt), to_token_amount: String(toAmt),
      price_from_in_usd: '1', price_to_in_usd: '0.5', volume_in_usd: '10',
    } });
    const calls = [];
    const mk = new Market({ fetch: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ data: [
        // GeckoTerminal labels it "sell" (its base is USDG), but relative to this X it is a buy.
        row('1', '2026-09-20T15:00:00Z', USDG, X, 10, 20, 'sell'),
        row('2', '2026-09-20T15:01:00Z', X, USDG, 40, 20, 'buy'),
      ] }) };
    } });
    const r = await mk.trades(POOL, { token: X });
    assert.match(calls[0], /\/pools\/0xab.*\/trades\?/);
    assert.deepStrictEqual(r.trades.map((x) => x.side), ['sell', 'buy'], 'newest first, direction relative to X');
    assert.deepStrictEqual(r.trades.map((x) => x.base), [40, 20], 'speculative token amount');
    assert.deepStrictEqual(r.trades.map((x) => x.priceQuote), [0.5, 0.5], 'price = quote / speculative');
    assert.strictEqual(r.trades[1].priceUsd, 0.5, 'USD price of the speculative token side');
    assert.strictEqual(r.trades[1].ts, Date.parse('2026-09-20T15:00:00Z'));
    // Without a token address, follow the GeckoTerminal label.
    const r2 = await new Market({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [row('3', '2026-09-20T15:00:00Z', USDG, X, 10, 20, 'sell')] }) }) }).trades(POOL);
    assert.strictEqual(r2.trades[0].side, 'sell');
    // Cache: a second poll within 10 seconds does not call GeckoTerminal again.
    await mk.trades(POOL, { token: X });
    assert.strictEqual(calls.length, 1);
  });

  await check('without a previous good answer, an error stays an error', async () => {
    const mk = new Market({ fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    const r = await mk.memo('kosong', 0, async () => ({ error: 'batas panggilan (429) — coba lagi sebentar' }));
    assert.match(r.error, /429/);
  });

  await check('the same request within the cache window is a single outbound call', async () => {
    const { mk, calls } = fake();
    await Promise.all([mk.candles(POOL, '1h'), mk.candles(POOL, '1h'), mk.pair(POOL), mk.pair(POOL)]);
    await mk.candles(POOL, '1h');
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 1);
    assert.strictEqual(calls.filter((u) => u.includes('dexscreener')).length, 1);
  });

  await check('the time range and base token are passed on to GeckoTerminal', async () => {
    const { mk, calls } = fake();
    await mk.candles(POOL, '4h', { limit: 50, token: '0xabc' });
    const u = new URL(calls[0]);
    assert.ok(u.pathname.endsWith('/ohlcv/hour'));
    assert.strictEqual(u.searchParams.get('aggregate'), '4');
    assert.strictEqual(u.searchParams.get('limit'), '50');
    assert.strictEqual(u.searchParams.get('token'), '0xabc');
    assert.strictEqual(u.searchParams.get('currency'), 'token');
  });

  await check('the end bound is rounded to a candle so the cache gets hits', async () => {
    const { mk, calls } = fake();
    await mk.candles(POOL, '1h', { before: 3_600_000 * 10 + 1000 });
    await mk.candles(POOL, '1h', { before: 3_600_000 * 10 + 900_000 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(new URL(calls[0]).searchParams.get('before_timestamp'), String(3600 * 11));
  });

  await check('rate limit (429) becomes an error message, not a throw; retried after a pause', async () => {
    const { mk, calls } = fake({ status: 429 });
    const r = await mk.pair(POOL);
    assert.match(r.error, /429/);
    await mk.pair(POOL);
    assert.strictEqual(calls.length, 1, 'the error is stored briefly');
  });

  await check('429 from GeckoTerminal holds all calls there for 20 seconds; DexScreener is not affected', async () => {
    const calls = [];
    const mk = new Market({ fetch: async (url) => {
      calls.push(url);
      if (url.startsWith('https://api.geckoterminal.com/')) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ pairs: [{ baseToken: {}, quoteToken: {} }] }) };
    } });
    assert.match((await mk.candles(POOL, '1h')).error, /429/);
    assert.match((await mk.trades(POOL)).error, /429/, 'pool lain/endpoint lain ikut ditahan');
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 1, 'only one shot gets through');
    assert.ok(!(await mk.pair(POOL)).error, 'DexScreener is still called');
    mk.gtCooldown = 0;
    await mk.trades('0x' + 'cd'.repeat(32));
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 2, 'retried after the pause');
  });

  await check('GMGN candles: X-APIKEY + chain + range in ms, USD price, amount becomes volume; without a key -> error', async () => {
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, headers: opts.headers });
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [
        { time: 2000, open: '2', high: '3', low: '1', close: '2.5', volume: '999', amount: '42' },
        { time: 1000, open: '1', high: '2', low: '0.5', close: '1.5', volume: '999', amount: '10' },
      ] } }) };
    };
    const mk = new Market({ fetch: fetchImpl, chain: { geckoterminal: 'robinhood', gmgn: 'robinhood' }, gmgnKey: () => 'kunci123' });
    const r = await mk.candlesGmgn('0xABC', '5m', { limit: 100 });
    assert.strictEqual(r.source, 'gmgn'); assert.strictEqual(r.currency, 'usd');
    assert.deepStrictEqual(r.candles.map((c) => [c.t, c.c, c.v]), [[1000000, 1.5, 10], [2000000, 2.5, 42]]);
    const u = new URL(calls[0].url);
    assert.strictEqual(u.origin + u.pathname, 'https://openapi.gmgn.ai/v1/market/token_kline');
    assert.strictEqual(u.searchParams.get('chain'), 'robinhood');
    assert.strictEqual(u.searchParams.get('address'), '0xabc');
    assert.strictEqual(u.searchParams.get('resolution'), '5m');
    assert.strictEqual(Number(u.searchParams.get('to')) - Number(u.searchParams.get('from')), 100 * 300 * 1000, 'range = candle limit, in ms');
    assert.strictEqual(calls[0].headers['X-APIKEY'], 'kunci123');
    assert.ok(!mk.gmgnEnabled.call(new Market({ fetch: fetchImpl })), 'tanpa key = nonaktif');
    assert.match((await new Market({ fetch: fetchImpl }).candlesGmgn('0xabc', '5m')).error, /API key/);
  });

  await check('the GMGN limit (RATE_LIMIT_*) holds calls for 10 seconds and uses the fallback; a rejected key is explained', async () => {
    let mode = 'ok';
    const calls = [];
    const mk = new Market({ fetch: async (url) => {
      calls.push(url);
      if (mode === 'limit') return { ok: false, status: 200, json: async () => ({ code: 40001, error: 'RATE_LIMIT_EXCEEDED', message: 'slow down' }) };
      if (mode === 'auth') return { ok: false, status: 401, json: async () => ({ code: 401, message: 'invalid key' }) };
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { list: [{ time: 1000, open: '1', high: '2', low: '0.5', close: '1.5', amount: '1' }] } }) };
    }, gmgnKey: () => 'k' });
    assert.strictEqual((await mk.memo('a', 0, () => mk.candlesGmgn('0xabc', '1h'))).candles.length, 1);
    mode = 'limit';
    const cad = await mk.memo('a', 0, () => mk.candlesGmgn('0xabc', '1h', { limit: 11 }));
    assert.ok(cad.stale && cad.candles.length === 1, 'fallback used at the limit');
    const n = calls.length;
    await mk.memo('b', 0, () => mk.candlesGmgn('0xdef', '1h'));
    assert.strictEqual(calls.length, n, 'during the pause there is no outbound call');
    mk.gmgnCooldown = 0; mode = 'auth';
    assert.match((await mk.candlesGmgn('0x999', '1h')).error, /menolak API key/);
  });

  await check('a pool not yet indexed (404) is explained', async () => {
    const { mk } = fake({ status: 404 });
    const r = await mk.candles(POOL, '1h');
    assert.match(r.error, /GeckoTerminal/);
  });

  console.log('entry price of an old position');

  await check('derived back from the deposited amounts, the same as the price at mint', () => {
    const lo = 343200, hi = 356000, tick = 349600;
    const s = m.getSqrtRatioAtTick(tick);
    const L = 25346118802953558n;
    const amt = m.amountsForLiquidity(s, m.getSqrtRatioAtTick(lo), m.getSqrtRatioAtTick(hi), L);
    const got = BigInt(Positions.entrySqrtOf({ liquidity: L.toString(), cost0: amt.amount0.toString(), cost1: amt.amount1.toString(), tick_lower: lo, tick_upper: hi }));
    const diff = Number((got - s) * 10n ** 9n / s) / 1e9;
    assert.ok(Math.abs(diff) < 1e-9, `selisih ${diff}`);
  });

  await check('one side = the price at the range edge; the stored column wins', () => {
    const lo = 100, hi = 200;
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '10', cost0: '5', cost1: '0', tick_lower: lo, tick_upper: hi }), m.getSqrtRatioAtTick(lo).toString());
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '10', cost0: '0', cost1: '5', tick_lower: lo, tick_upper: hi }), m.getSqrtRatioAtTick(hi).toString());
    assert.strictEqual(Positions.entrySqrtOf({ entry_sqrt: '123', liquidity: '10', cost0: '5', cost1: '5', tick_lower: lo, tick_upper: hi }), '123');
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '0', cost0: '5', cost1: '5', tick_lower: lo, tick_upper: hi }), null);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
