'use strict';
// Test: the Meteora DLMM data API client and where it is used (Market pool stats / token
// pools / candles, SolanaChain.poolAgeMinutes, SolanaManual.scanPools, the entry filter).
// The network is faked: every call goes through an injected fetch.
// Run: node test/meteora-api.js
const assert = require('node:assert');
const { MeteoraApi, normalizePool, poolStats } = require('../src/solana/meteora-api');
const { Market } = require('../src/market');
const { Store } = require('../src/db');
const { SolanaChain } = require('../src/solana/chain');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'MeMeCoin11111111111111111111111111111pump';
const POOL = '5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6';

// A raw pool as the API returns it (trimmed). fee_tvl_ratio / apr are already percent.
const rawPool = (over = {}) => ({
  address: POOL, name: 'MEME-SOL',
  token_x: { address: MEME, symbol: 'MEME', name: 'Meme', decimals: 9, price: 0.5, market_cap: 5e6, is_verified: false },
  token_y: { address: SOL, symbol: 'SOL', name: 'Wrapped SOL', decimals: 9, price: 100, market_cap: 5e10, is_verified: true },
  token_x_amount: 1000, token_y_amount: 50, created_at: 1_700_000_000_000,
  pool_config: { bin_step: 80, base_fee_pct: 0.8, max_fee_pct: 10, protocol_fee_pct: 5 }, dynamic_fee_pct: 0.2,
  tvl: 120_000, current_price: 0.005,
  apr: 0.5, apy: 500, has_farm: false, farm_apr: 0,
  volume: { '30m': 100, '1h': 250, '2h': 500, '4h': 900, '12h': 3000, '24h': 12_000 },
  fees: { '24h': 96 }, fee_tvl_ratio: { '24h': 0.08 },
  is_blacklisted: false, ...over,
});

// A fetch that serves routes from a table and counts the calls per path.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    const u = new URL(url);
    calls.push(u.pathname + u.search);
    const h = routes(u);
    if (h instanceof Error) throw h;
    const [status, body] = h || [404, { message: 'not found' }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

(async () => {
  console.log('Meteora DLMM data API');

  await t('normalizePool: camelCase numbers, windows, fee/TVL and APR kept as percent', () => {
    const p = normalizePool(rawPool());
    assert.strictEqual(p.tvlUsd, 120_000);
    assert.strictEqual(p.binStep, 80);
    assert.strictEqual(p.volume.h24, 12_000);
    assert.strictEqual(p.volume.m30, 100);
    assert.strictEqual(p.feeTvl.h24, 0.08);
    assert.strictEqual(p.dailyYieldPct, 0.5);
    assert.strictEqual(p.aprPct, 182.5);          // 0.5 %/day x 365
    assert.strictEqual(p.createdAt, 1_700_000_000_000);
    assert.strictEqual(p.tokenX.symbol, 'MEME');
    const s = poolStats(p);
    assert.strictEqual(s.feeTvl24Pct, 0.08);
    assert.strictEqual(s.volume24hUsd, 12_000);
    assert.strictEqual(poolStats(null), null);
  });

  await t('pool(): hit, 404 means "not a DLMM pool" (null, cached), other errors throw', async () => {
    const f = fakeFetch((u) => (u.pathname === `/pools/${POOL}` ? [200, rawPool()] : u.pathname.includes('boom') ? [500, {}] : null));
    const api = new MeteoraApi({ fetch: f });
    assert.strictEqual((await api.pool(POOL)).tvlUsd, 120_000);
    await api.pool(POOL);
    assert.strictEqual(f.calls.length, 1, 'second read is served from the cache');
    assert.strictEqual(await api.pool('Orca1111111111111111111111111111111111111111'), null);
    await assert.rejects(api.pool('boom'), /HTTP 500/);
  });

  await t('pool(): a failing API falls back to the last good answer', async () => {
    let down = false;
    const f = fakeFetch(() => (down ? [503, {}] : [200, rawPool()]));
    const api = new MeteoraApi({ fetch: f });
    await api.pool(POOL);
    api.cache.clear();            // expire the short cache, keep the last-good copy
    down = true;
    assert.strictEqual((await api.pool(POOL)).tvlUsd, 120_000);
  });

  await t('pools(): query/sort/filter go out as the API parameters', async () => {
    const f = fakeFetch((u) => (u.pathname === '/pools' ? [200, { total: 1, data: [rawPool()] }] : null));
    const api = new MeteoraApi({ fetch: f });
    const r = await api.pools({ query: MEME, sortBy: 'tvl:desc', filterBy: 'tvl>=1000', pageSize: 20 });
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.pools[0].address, POOL);
    const q = new URL(`http://x${f.calls[0]}`).searchParams;
    assert.strictEqual(q.get('query'), MEME);
    assert.strictEqual(q.get('sort_by'), 'tvl:desc');
    assert.strictEqual(q.get('filter_by'), 'tvl>=1000');
    assert.strictEqual(q.get('page_size'), '20');
  });

  await t('ohlcv(): window from the limit, ascending candles; unsupported timeframes are not asked', async () => {
    const f = fakeFetch((u) => (u.pathname.endsWith('/ohlcv')
      ? [200, { data: [{ timestamp: 7200, open: 2, high: 3, low: 1, close: 2, volume: 5 }, { timestamp: 3600, open: 1, high: 2, low: 1, close: 2, volume: 4 }] }] : null));
    const api = new MeteoraApi({ fetch: f });
    const r = await api.ohlcv(POOL, '1h', { limit: 50, endMs: 7_200_000 });
    assert.deepStrictEqual(r.candles.map((c) => c.t), [3_600_000, 7_200_000]);
    const q = new URL(`http://x${f.calls[0]}`).searchParams;
    assert.strictEqual(q.get('timeframe'), '1h');
    assert.strictEqual(Number(q.get('end_time')) - Number(q.get('start_time')), 50 * 3600);
    // a long window is split into requests of at most 90 candles and stitched, without duplicates
    const g = fakeFetch((u) => (u.pathname.endsWith('/ohlcv')
      ? [200, { data: [{ timestamp: Number(u.searchParams.get('end_time')), open: 1, high: 1, low: 1, close: 1, volume: 1 }] }] : null));
    const long = await new MeteoraApi({ fetch: g }).ohlcv(POOL, '1h', { limit: 200, endMs: 3600 * 1000 * 1000 });
    assert.strictEqual(g.calls.length, 3);
    for (const c of g.calls) {
      const q = new URL(`http://x${c}`).searchParams;
      assert.ok(Number(q.get('end_time')) - Number(q.get('start_time')) <= 90 * 3600, 'chunk within the API limit');
    }
    assert.strictEqual(long.candles.length, 3);
    assert.strictEqual(await api.ohlcv(POOL, '15m'), null);
    assert.strictEqual(await api.ohlcv(POOL, '1m'), null);
    assert.strictEqual(f.calls.length, 1);
  });

  // ---- Market ------------------------------------------------------------------------
  const solChain = (meteora) => ({ kind: 'solana', network: 'solana', dexscreener: 'solana', geckoterminal: 'solana', meteora });
  const mkt = (meteora, dsPair = null, gt = null) => {
    const m = new Market({ chain: solChain(meteora), log: () => {} });
    m.json = async (url) => {
      if (url.includes('dexscreener')) return dsPair ? (url.includes('token-pairs') ? [dsPair] : { pairs: [dsPair] }) : null;
      if (url.includes('geckoterminal')) return gt;
      return null;
    };
    return m;
  };

  await t('Market.pair: a DLMM pool takes Meteora TVL/volume/creation time, DexScreener only adds what Meteora lacks', async () => {
    const api = new MeteoraApi({ fetch: fakeFetch(() => [200, rawPool()]) });
    const ds = { priceChange: { h1: 4.2 }, txns: { h24: { buys: 3, sells: 2 } }, volume: { h6: 777, h24: 1 }, liquidity: { usd: 5 }, pairCreatedAt: 1, info: { imageUrl: 'http://img' } };
    const p = await mkt(api, ds).pair(POOL);
    assert.strictEqual(p.dexId, 'meteora');
    assert.strictEqual(p.liquidityUsd, 120_000);
    assert.strictEqual(p.volume.h24, 12_000);
    assert.strictEqual(p.volume.h6, 777, 'h6 exists only at DexScreener');
    assert.strictEqual(p.pairCreatedAt, 1_700_000_000_000);
    assert.strictEqual(p.priceChange.h1, 4.2);
    assert.strictEqual(p.imageUrl, 'http://img');
    assert.strictEqual(p.meteora.binStep, 80);
    assert.strictEqual(p.meteora.feeTvl.h24, 0.08);
  });

  await t('Market.pair: DexScreener being down does not lose the Meteora answer', async () => {
    const api = new MeteoraApi({ fetch: fakeFetch(() => [200, rawPool()]) });
    const m = mkt(api);
    m.json = async () => { throw new Error('ds down'); };
    const p = await m.pair(POOL);
    assert.strictEqual(p.liquidityUsd, 120_000);
    assert.deepStrictEqual(p.priceChange, {});
  });

  await t('Market.pair: not a DLMM pool (Orca/Raydium) → DexScreener as before', async () => {
    const api = new MeteoraApi({ fetch: fakeFetch(() => null) });
    const p = await mkt(api, { dexId: 'orca', liquidity: { usd: 42 }, volume: { h24: 9 }, baseToken: {}, quoteToken: {} }).pair('Orca1111111111111111111111111111111111111111');
    assert.strictEqual(p.dexId, 'orca');
    assert.strictEqual(p.liquidityUsd, 42);
  });

  await t('Market.pair: Meteora API failing falls back to DexScreener', async () => {
    const api = new MeteoraApi({ fetch: fakeFetch(() => new Error('network')) });
    const p = await mkt(api, { dexId: 'meteora', liquidity: { usd: 42 }, volume: { h24: 9 }, baseToken: {}, quoteToken: {} }).pair(POOL);
    assert.strictEqual(p.liquidityUsd, 42);
  });

  await t('Market.token: Meteora pools overlay DexScreener rows and add the ones DexScreener lacks', async () => {
    const other = rawPool({ address: 'NewPool11111111111111111111111111111111111111', tvl: 900_000 });
    const api = new MeteoraApi({ fetch: fakeFetch((u) => (u.pathname === '/pools' ? [200, { total: 2, data: [rawPool(), other] }] : null)) });
    const ds = { pairAddress: POOL, dexId: 'meteora', liquidity: { usd: 1 }, volume: { h24: 1 }, baseToken: { address: MEME }, quoteToken: { address: SOL } };
    const r = await mkt(api, ds).token(MEME);
    assert.deepStrictEqual(r.pairs.map((p) => p.pool), ['NewPool11111111111111111111111111111111111111', POOL], 'sorted by TVL');
    assert.strictEqual(r.pairs[1].liquidityUsd, 120_000);
    assert.strictEqual(r.pairs[1].volume.h24, 12_000);
    assert.strictEqual(r.pairs[0].meteora.binStep, 80);
  });

  await t('Market.candles: Meteora candles in the pool quote; the price base token Y inverts the series', async () => {
    const api = new MeteoraApi({ fetch: fakeFetch((u) => (u.pathname.endsWith('/ohlcv')
      ? [200, { data: [{ timestamp: 3600, open: 2, high: 4, low: 1, close: 2, volume: 9 }] }] : [200, rawPool()])) });
    const m = mkt(api);
    const x = await m.candles(POOL, '1h', { token: MEME });
    assert.strictEqual(x.source, 'meteora');
    assert.deepStrictEqual([x.candles[0].o, x.candles[0].h, x.candles[0].l], [2, 4, 1]);
    assert.strictEqual(x.base.symbol, 'MEME');
    const y = await m.candles(POOL, '1h', { token: SOL, limit: 301 });
    assert.deepStrictEqual([y.candles[0].o, y.candles[0].h, y.candles[0].l], [0.5, 1, 0.25]);
    assert.strictEqual(y.base.symbol, 'SOL');
  });

  await t('Market.candles: USD currency, 15m and non-DLMM pools stay on GeckoTerminal', async () => {
    const f = fakeFetch((u) => (u.pathname.endsWith('/ohlcv') ? [200, { data: [{ timestamp: 3600, open: 1, high: 1, low: 1, close: 1, volume: 1 }] }] : null));
    const api = new MeteoraApi({ fetch: f });
    const gt = { data: { attributes: { ohlcv_list: [[1800, 1, 2, 1, 2, 3]] } }, meta: {} };
    const m = mkt(api, null, gt);
    assert.strictEqual((await m.candles(POOL, '1h', { currency: 'usd' })).source, undefined);
    assert.strictEqual((await m.candles(POOL, '15m', { token: MEME })).source, undefined);
    assert.strictEqual(f.calls.length, 0, 'Meteora not asked for what it cannot serve');
    const none = mkt(new MeteoraApi({ fetch: fakeFetch(() => null) }), null, gt);
    assert.strictEqual((await none.candles('Orca1111111111111111111111111111111111111111', '1h', { token: MEME })).candles.length, 1);
  });

  // ---- chain.poolAgeMinutes ---------------------------------------------------------------
  const chainWith = (meteoraApi) => {
    const store = new Store(':memory:');
    const rpc = { run: async () => { throw new Error('rpc'); }, primary: () => null, slot: async () => 1, allCooling: () => false, stats: () => [] };
    const chain = new SolanaChain(rpc, store, () => {}, 'solana', { jupiter: {}, meteoraApi });
    chain.venueOfPool = async () => 'meteora';
    return { chain, store };
  };

  await t('poolAgeMinutes: the Meteora creation time is used and stored once', async () => {
    const created = Date.now() - 90 * 60_000;
    const f = fakeFetch(() => [200, rawPool({ created_at: created })]);
    const { chain, store } = chainWith(new MeteoraApi({ fetch: f }));
    const age = await chain.poolAgeMinutes(POOL);
    assert.ok(Math.abs(age - 90) < 0.5, `age ${age}`);
    assert.strictEqual(store.get('SELECT first_ts FROM pools WHERE chain=? AND pool_ref=?', 'solana', POOL).first_ts, created);
    await chain.poolAgeMinutes(POOL);
    assert.strictEqual(f.calls.length, 1);
  });

  await t('poolAgeMinutes: not a DLMM pool → DexScreener creation time', async () => {
    const created = Date.now() - 30 * 60_000;
    const { chain } = chainWith(new MeteoraApi({ fetch: fakeFetch(() => null) }));
    const real = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ pairs: [{ pairCreatedAt: created }] }) });
    try {
      const age = await chain.poolAgeMinutes('Orca1111111111111111111111111111111111111111');
      assert.ok(Math.abs(age - 30) < 0.5, `age ${age}`);
    } finally { globalThis.fetch = real; }
  });

  // ---- SolanaManual.scanPools ----------------------------------------------------------
  await t('scanPools: Meteora pools come with stats, exact TVL and creation time (other indexes down)', async () => {
    const { SolanaManual } = require('../src/solana/manual');
    const { PublicKey } = require('@solana/web3.js');
    const api = new MeteoraApi({ fetch: fakeFetch((u) => (u.pathname === '/pools' ? [200, { total: 1, data: [rawPool({ address: POOL })] }] : null)) });
    const { chain, store } = chainWith(api);
    const meteoraProgram = chain.adapters.meteora.program;
    chain.rpc.run = async (fn) => fn({ getMultipleAccountsInfo: async (keys) => keys.map(() => ({ owner: new PublicKey(meteoraProgram) })) });
    chain.pools = async (venue, addrs) => new Map(addrs.map((a) => [a, { venue: 'meteora', id: a, token0: MEME, token1: SOL, dec0: 9, dec1: 9, fee: 8000, liquidity: 5n, enabled: true }]));
    chain.tokens = async (l) => l.map((a) => ({ address: a, symbol: a === SOL ? 'SOL' : 'MEME', decimals: 9 }));
    chain.quoteSideOf = () => ({ side: 1, symbol: 'SOL', kind: 'eth' });
    const man = new SolanaManual({ engine: {}, store, chain, rpc: chain.rpc, log: () => {} });
    // chain.pools records the pool row in production; the fake does not, so seed it
    store.run('INSERT INTO pools(chain,pool_ref,venue) VALUES(?,?,?)', 'solana', POOL, 'meteora');
    const down = async () => { throw new Error('index down'); };
    const pools = await man.scanPools(MEME, { fetchImpl: down });
    assert.strictEqual(pools.length, 1);
    assert.strictEqual(pools[0].liquidityUsd, 120_000);
    assert.strictEqual(pools[0].createdAt, 1_700_000_000_000);
    assert.strictEqual(pools[0].stats.volume24hUsd, 12_000);
    assert.strictEqual(pools[0].stats.feeTvl24Pct, 0.08);
    assert.strictEqual(pools[0].stats.binStep, 80);
    // the creation time is stored for the pool-age filter
    assert.strictEqual(store.get('SELECT first_ts FROM pools WHERE chain=? AND pool_ref=?', 'solana', POOL)?.first_ts ?? null, 1_700_000_000_000);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
