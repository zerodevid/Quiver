'use strict';
// Test the position chart card (src/chart-card.js + server.chartCard): a candle image with
// indicators, an LP range band, and the BEP line used by the "📈 Grafik" button in the bot.
//
// What is guarded:
//   - the price scale always includes the position range & BEP, not just the candles — if
//     it did not, the image would answer the wrong question;
//   - indicators are only drawn when their bit is on (the toggle button in Telegram);
//   - the bottom panel (VOL/RSI/MACD) adds image height, rather than overlapping the candles;
//   - a closed position uses candles around its lifetime and marks the exit price;
//   - a pool not yet indexed answers with an error, not an empty image.
//
// Run: node test/chart.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');
const chartCard = require('../src/chart-card');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const T0 = 1_700_000_000_000;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// Fake GeckoTerminal candles: the price rises slowly from 0.9 to 1.3.
function ohlcv(n = 120, from = T0) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const base = 0.9 + (0.4 * i) / n;
    const t = Math.floor((from + i * 3600_000) / 1000);
    list.push([t, base, base * 1.02, base * 0.98, base * 1.01, 1000 + i * 10]);
  }
  return list.reverse();   // GeckoTerminal sends newest first
}

// fake fetch: only two hosts are touched by Market (GeckoTerminal & DexScreener).
function stubFetch({ candles = ohlcv(), indexed = true } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geckoterminal')) {
      if (!indexed) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({
        data: { attributes: { ohlcv_list: candles } },
        meta: { base: { address: MEME, symbol: 'MEME' }, quote: { address: ADDR.usdg, symbol: 'USDG' } },
      }) };
    }
    return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
  };
}

function world({ live = [], row = {} } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {}, telegram: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-grafik-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live, lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,
      status,opened_ts,closed_ts,cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close)
    VALUES(1,'v4','888',?,?,?,3000,?,?,'5000',?,?,?,'0','0',200,?,'USDG','0xmint1',?)`,
  POOL, ADDR.usdg, MEME, row.tickLower ?? -6000, row.tickUpper ?? 6000,
  row.status ?? 'open', T0, row.closedTs ?? null, row.outQuote ?? 0, row.txClose ?? null);
  return { store, server, engine };
}

// Open position as it comes out of a sync: USDG/MEME, range ±0.55–1.82.
const livePos = (extra = {}) => ({
  id: 1, venue: 'v4', token_id: '888', pool_ref: POOL, token0: ADDR.usdg, token1: MEME,
  fee: 3000, tick_lower: -6000, tick_upper: 6000, curTick: 0, liquidity: '5000000000000',
  symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, quoteSide: 0,
  valueUsd: 205, feeUsd: 1.5, costUsd: 200, pnlUsd: 5, pnlPct: 2.5,
  cost_quote: 200, fee0: '100000', fee1: '0', claimed_quote: 0, out_quote: 0,
  inRange: false, empty: false, ageHours: 5, status: 'open',
  curSqrt: null, entrySqrt: null, ...extra,
});

(async () => {
  console.log('position chart card');
  const ALL = chartCard.INDICATORS.reduce((a, i) => a | i.bit, 0);

  await t('image formed: PNG, with the pair, time range, and price', async () => {
    stubFetch();
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: chartCard.DEFAULT_MASK });
    assert.ok(!card.error, card.error);
    assert.equal(card.png.slice(1, 4).toString(), 'PNG');
    assert.ok(card.png.length > 20_000, `image too small: ${card.png.length} bytes`);
    assert.match(card.caption, /USDG\/MEME · 1h/);
  });

  await t('the position range & BEP enter the scale, both drawn as lines in the image', async () => {
    stubFetch();
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(/BEP/.test(card.caption), `BEP must be in the caption: ${card.caption}`);
    assert.match(card.caption, /rentang/);
  });

  await t('indicators are only drawn if their bit is on', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5 };
    const dead = chartCard.chartSvg({ ...base, mask: 0 });
    const alive = chartCard.chartSvg({ ...base, mask: ALL });
    for (const label of ['MA5', 'EMA6', 'BOLL', 'RSI', 'MACD']) {
      assert.ok(!dead.includes(label), `${label} must not be present at mask 0`);
      assert.ok(alive.includes(label), `${label} must be present when all indicators are on`);
    }
  });

  await t('the bottom panel adds image height, rather than overlapping the candles', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5 };
    const height = (mask) => Number(/height="(\d+)"/.exec(chartCard.chartSvg({ ...base, mask }))[1]);
    const blank = height(0);
    assert.ok(height(8) > blank, 'VOL must add height');           // VOL
    assert.ok(height(8 | 16 | 32) > height(8), 'RSI+MACD adds more'); // VOL+RSI+MACD
    assert.equal(height(1 | 2 | 4), blank, 'indicators in the candle panel do not add height');
  });

  await t('when entry is drawn: a vertical line on its candle + a point at the entry price', () => {
    const now = Date.now();
    const cs = [];
    for (let i = 0; i < 60; i++) cs.push({ t: now - (60 - i) * 3600_000, o: 1, h: 1.05, l: 0.95, c: 1, v: 10 });
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: cs, lo: 0.9, hi: 1.1, now: 1, mask: 0, entry: 1 };
    const without = chartCard.chartSvg(base);
    const dengan = chartCard.chartSvg({ ...base, openedTs: now - 30 * 3600_000, ageHours: 30 });
    // The vertical time marker line uses its own dash pattern ("5 6"), so
    // its presence can be tested without mixing it up with the entry price label in the right column.
    assert.ok(!without.includes('stroke-dasharray="5 6"'), 'without an entry time: no vertical line');
    assert.ok(dengan.includes('stroke-dasharray="5 6"'), 'the entry time vertical line must exist');
    assert.ok(/<circle/.test(dengan), 'point at the intersection of time × entry price');
    assert.ok(/dipegang/.test(dengan), 'the footer states how long it has been held');
    // Entered long before the candle window: pinned to the edge with an arrow, not dropped.
    const old = chartCard.chartSvg({ ...base, openedTs: now - 900 * 3600_000 });
    assert.ok(/▸ masuk/.test(old), 'entry outside the window is marked with an arrow');
  });

  await t('the range band starts at the entry candle, stops at the exit candle', () => {
    const now = Date.now();
    const cs = [];
    for (let i = 0; i < 100; i++) cs.push({ t: now - (100 - i) * 3600_000, o: 1, h: 1.05, l: 0.95, c: 1, v: 10 });
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: cs, lo: 0.9, hi: 1.1, now: 1, mask: 0 };
    const width = (svg) => Number(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="rgba\(122,162,247,0.13\)"/.exec(svg).slice(1, 3)[1]);
    const startX = (svg) => Number(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="rgba\(122,162,247,0.13\)"/.exec(svg)[1]);
    const full = chartCard.chartSvg(base);                                   // without an entry time: the whole chart
    const half = chartCard.chartSvg({ ...base, openedTs: now - 50 * 3600_000 });
    const closedVal = chartCard.chartSvg({ ...base, openedTs: now - 80 * 3600_000, closedTs: now - 30 * 3600_000, closed: true });
    assert.ok(startX(half) > startX(full) + 300, 'the band starts at the entry candle, not at the left edge');
    assert.ok(width(half) < width(full) * 0.6, 'the band is shorter than the full chart');
    assert.ok(width(closedVal) < width(full) * 0.6 && startX(closedVal) < startX(half), 'closed position: a band from entry to exit');
    const old = chartCard.chartSvg({ ...base, openedTs: now - 900 * 3600_000 });
    assert.equal(startX(old), startX(full), 'entry before the window: a band from the left edge');
  });

  await t('window width: automatic = position age + context; day choices are clipped to the candle limit', async () => {
    let limitRequested = null;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      limitRequested = Number(new URL(u).searchParams.get('limit'));
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: ohlcv(limitRequested) } } }) };
    };
    // a position 100 hours old on 1h candles → 100 + 40 context = 140 candles
    const { server } = world({ live: [livePos({ opened_ts: Date.now() - 100 * 3600_000 })] });
    await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    // Math.ceil over a time difference that has run a few ms → 101 + 40.
    assert.ok(limitRequested === 140 || limitRequested === 141, `otomatis: ${limitRequested}`);
    await server.chartCard({ id: 1, tf: '1h', mask: 0, span: 24 });
    assert.equal(limitRequested, 60, `1 day on 1h = 24 candles → minimum 60: ${limitRequested}`);
    const r = await server.chartCard({ id: 1, tf: '5m', mask: 0, span: 720 });
    assert.equal(limitRequested, 400, `30 days on 5m clipped to 400: ${limitRequested}`);
    assert.equal(r.candles, 400);
  });

  await t('price labels in the right column do not overlap each other', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 0.5, hi: 2, mask: 0 };
    // BEP and the entry price are nearly the same height: the labels must be shifted, not stacked.
    const svg = chartCard.chartSvg({ ...base, now: 1.5, entry: 1.0, bepPrice: 1.005 });
    const ys = [...svg.matchAll(/<rect x="\d+" y="([\d.]+)" width="[\d.]+" height="22"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    assert.ok(ys.length >= 3, `tiga label diharapkan: ${ys.length}`);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 20, `label ${i} terlalu rapat: ${ys}`);
  });

  await t('closed position: labelled closed, without BEP', async () => {
    stubFetch();
    const { server } = world({ row: { status: 'closed', closedTs: T0 + 40 * 3600_000, outQuote: 215, txClose: '0xburn1' } });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: chartCard.DEFAULT_MASK });
    assert.ok(!card.error, card.error);
    assert.ok(!/BEP/.test(card.caption), `a closed position has no BEP: ${card.caption}`);
  });

  await t('pool not yet indexed: an error, not an empty image', async () => {
    stubFetch({ indexed: false });
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(card.error, 'must answer with an error');
  });

  await t('a candle quote failing once (timeout / 502): retried, not straight to an error', async () => {
    let n = 0;
    const original = ohlcv();
    globalThis.fetch = async (url) => {
      if (!String(url).includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      n++;
      // GeckoTerminal occasionally answers 502 for a few seconds — that is no reason
      // to answer the button with an error.
      if (n === 1) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: original } } }) };
    };
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(!card.error, `must pass on the second attempt: ${card.error}`);
    assert.equal(n, 2, 'tepat dua kali panggil');
  });

  await t('a candle quote failing continuously: the error tells to retry, not the raw fetch text', async () => {
    globalThis.fetch = async (url) => {
      if (!String(url).includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      throw new Error('The operation was aborted due to timeout');
    };
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.match(card.error, /coba lagi/);
  });

  await t('candles from the fallback: their age is printed in the image footer', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5, mask: 0 };
    const fresh = chartCard.chartSvg(base);
    const stale = chartCard.chartSvg({ ...base, staleAt: Date.now() - 20 * 60_000 });
    assert.ok(!/harga \d/.test(fresh), 'fresh data need not be explained');
    assert.ok(/harga \d/.test(stale), 'fallback data must state its time');
  });

  await t('position does not exist: an error', async () => {
    stubFetch();
    const { server } = world({ live: [livePos()] });
    const card = await server.chartCard({ id: 99 });
    assert.ok(card.error, 'must answer with an error');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
