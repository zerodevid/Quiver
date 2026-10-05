'use strict';
// Share card. Run: node test/share.js
//
// The card is drawn on the server (src/share-card.js) from the same route data as
// the dashboard, then replied as a PNG (GET /api/share/card) or sent to each
// Telegram chat (POST /api/share/telegram). What is locked here: all three card types
// really become a PNG from the data in the DB, the caption follows the language,
// the calendar day is computed in the reader's time zone, and a partial send
// failure is reported without cancelling the ones that succeeded.
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');
const shareCard = require('../src/share-card');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
// 2024-01-15 23:30 UTC = 16 Jan 06:30 in Jakarta: a different day depending on the time zone.
const T_CLOSE = Date.UTC(2024, 0, 15, 23, 30);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

// Fake GeckoTerminal (candles for the position card's background chart); `gagalLilin` imitates
// an unreachable GeckoTerminal — the card must still be produced, without the chart.
let candleFail = false;
globalThis.fetch = async (url) => {
  if (candleFail) throw new Error('fetch failed');
  if (String(url).includes('geckoterminal')) {
    const list = [];
    for (let i = 0; i < 60; i++) list.push([Math.floor((Date.now() - (60 - i) * 300_000) / 1000), 1 + i / 100, 1.02 + i / 100, 0.98 + i / 100, 1 + i / 100, 500]);
    return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: list.reverse() } } }) };
  }
  return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
};

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

function world(telegram) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {}, telegram: { timezone: 'Asia/Jakarta' } };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-bagikan-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const pos = {
    live: [], lastSync: Date.now(), resync: async () => {},
    summary: () => ({ exposureUsd: 0, feeUsd: 0, realizedUsd: 50, unrealizedUsd: 0, costUsd: 0, openCount: 0, inRange: 0, leftoverUsd: 0 }),
  };
  const engine = {
    cfg, store, ethUsd: 2500, positions: pos, watcher: { unsupported: new Map() }, cash: { usd: 1000 },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
    freshCash() { return this.cash; }, refreshCash: async () => null,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  // One position closed at a $50 profit (capital 200 → result 250).
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,status,opened_ts,closed_ts,
      cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close,entry_sqrt,exit_sqrt)
    VALUES(7,'v4','2000007',?,?,?,3000,-60,60,'closed',?,?,'0','0',200,250,'USDG','0xmint7','0xburn7',?,?)`,
  POOL, ADDR.usdg, MEME, T_CLOSE - 3600e3, T_CLOSE, String(2n ** 96n), String(2n ** 96n * 11n / 10n));
  return server;
}

// Fake bot: records what was sent, and can be told to fail for a given chat.
function fakeBot({ token = 'tok', chats = ['1'], gagal: failure = [] } = {}) {
  const sendOrig = [];
  return {
    sendOrig,
    token: () => token,
    chats: () => chats,
    async sendPhoto(chatId, png, caption) {
      if (failure.includes(chatId)) throw new Error('chat not found');
      sendOrig.push({ chatId, png, caption });
    },
  };
}

// GET the image over real HTTP: the PNG route does not go through the JSON table.
const fetchPng = (server, query) => new Promise((resolve, reject) => {
  const { port } = server.address();
  http.get({ host: '127.0.0.1', port, path: '/api/share/card?' + query }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }));
  }).on('error', reject);
});
const withServer = async (telegram, fn) => {
  const server = world(telegram);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server); } finally { server.close(); }
};

(async () => {
  await t('renderer: all three card types become a 2400×1260 PNG, language & hidden amounts honoured', () => {
    const p = { id: 1, venue: 'v4', fee: 3000, token0: ADDR.usdg, token1: MEME, symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, quoteSide: 0,
      entrySqrt: String(2n ** 96n), curTick: 10, costUsd: 200, valueUsd: 230, feeUsd: 5, claimedUsd: 0, pnlUsd: 35, pnlPct: 17.5, ageHours: 3, opened_ts: Date.now(), inRange: true, status: 'open' };
    for (const [kind, data] of [['position', p], ['total', { now: { pnl: 10, value: 100, capital: 90, realizedUsd: 10, unrealizedUsd: 0, feeUsd: 1, openCount: 1 }, stats: { closedCount: 2, wins: 1, losses: 1, winRatePct: 50, best: 5 } }],
      ['daily', { day: '2024-01-16', rows: [{ symbol0: 'USDG', symbol1: 'MEME', cost: 200, pnl: 50 }], monthTotal: 50 }]]) {
      const png = shareCard.render(kind, data, { lang: 'id', timeZone: 'Asia/Jakarta' });
      assert.ok(png.subarray(0, 4).equals(PNG), `${kind}: not a PNG`);
      // PNG width & height are in the IHDR chunk (bytes 16–23).
      assert.strictEqual(png.readUInt32BE(16), 2400); assert.strictEqual(png.readUInt32BE(20), 1260);
    }
    const id = shareCard.svgOf('position', p, { lang: 'id' }), en = shareCard.svgOf('position', p, { lang: 'en' });
    assert.ok(id.includes('Harga masuk') && !id.includes('Entry price'));
    assert.ok(en.includes('Entry price') && en.includes('+17.50%'), 'English labels & figures');
    assert.ok(id.includes('+17,50%'), 'koma desimal Indonesia');
    const hidden = shareCard.svgOf('position', p, { lang: 'id', hideAmounts: true });
    assert.ok(!hidden.includes('$35,00') && hidden.includes('Nominal disembunyikan'), 'dollar amounts must not leak');
    assert.strictEqual(shareCard.caption('position', p, 'en'), 'USDG / MEME +17.50% · Quiver');
  });

  await t('total card: net PnL (value − real capital) if capital is tracked, position PnL if not', () => {
    const now = { pnl: 129.36, value: 1198.29, capital: 1068.93, realizedUsd: 118.29, unrealizedUsd: 11.07, feeUsd: 28.06, openCount: 2 };
    const stats = { closedCount: 99, wins: 37, losses: 62, winRatePct: 37, best: 29.62 };
    const net = shareCard.svgOf('total', { now: { ...now, netPnl: 98.29, capitalNet: 1100 }, stats }, { lang: 'en' });
    assert.ok(net.includes('Net PnL') && net.includes('$98.29') && net.includes('+8.94%'), 'figures & percent from the net PnL against real capital');
    assert.ok(net.includes('capital $1,100.00 · position PnL $129.36'), 'sub-text: real capital + position PnL');
    assert.strictEqual(shareCard.caption('total', { now: { ...now, netPnl: 98.29, capitalNet: 1100 } }, 'en'), 'Net PnL $98.29 · Quiver');
    const position = shareCard.svgOf('total', { now, stats }, { lang: 'en' });
    assert.ok(position.includes('Total PnL') && position.includes('$129.36') && position.includes('realized $118.29'), 'without tracked capital: position PnL');
  });

  await t('renderer: square/story sizes and every theme become a PNG; a foreign size/theme falls back to the default', () => {
    const p = { id: 1, venue: 'v4', fee: 3000, token0: ADDR.usdg, token1: MEME, symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, quoteSide: 0,
      entrySqrt: String(2n ** 96n), curTick: 10, costUsd: 200, valueUsd: 280, feeUsd: 5, claimedUsd: 0, pnlUsd: 85, pnlPct: 42.5, ageHours: 3, opened_ts: Date.now(), inRange: true, status: 'open' };
    for (const [size, w, h] of [['square', 2160, 2160], ['story', 2160, 3840], ['apa', 2400, 1260]]) {
      const png = shareCard.render('position', p, { lang: 'id', size });
      assert.strictEqual(png.readUInt32BE(16), w, `${size}: width`); assert.strictEqual(png.readUInt32BE(20), h, `${size}: tinggi`);
    }
    // Each theme has a different background; a profit ≥ 20% gets a stamp.
    const bgs = new Set();
    for (const theme of Object.keys(shareCard.THEMES)) {
      const svg = shareCard.svgOf('position', p, { lang: 'en', theme, size: 'square' });
      bgs.add(svg.match(/<linearGradient id="bg"[^>]*>([\s\S]*?)<\/linearGradient>/)[1]);
      assert.ok(svg.includes('BIG WIN'), `${theme}: big-profit stamp`);
    }
    assert.strictEqual(bgs.size, Object.keys(shareCard.THEMES).length, 'each theme\'s background must differ');
    assert.strictEqual(shareCard.themeKey('apa'), 'dark'); assert.strictEqual(shareCard.sizeKey('story'), 'story');
    const light = shareCard.svgOf('position', { ...p, pnlUsd: 5, pnlPct: 2.5 }, { lang: 'id', theme: 'light' });
    assert.ok(light.includes('fill="#111827"') && !light.includes('UNTUNG BESAR'), 'light theme: dark logo; a small profit without a stamp');
    // Pixel theme: Pixelify Sans font, box corners, stepped chart lines (H/V, not L).
    const t0 = Date.now();
    const chart = { kind: 'line', pts: Array.from({ length: 20 }, (_, i) => [t0 + i * 60e3, 1 + Math.sin(i / 3)]), band: [0.5, 1.5], marks: [{ t: t0 + 5 * 60e3, v: 1.2 }] };
    const pixel = shareCard.svgOf('position', p, { lang: 'id', theme: 'pixel', chart });
    assert.ok(pixel.includes('font-family="Pixelify Sans"') && pixel.includes('rx="0"'), 'tema piksel: font & sudut kotak');
    assert.ok(/<path d="M[\d.]+ [\d.]+ H[\d.]+ V/.test(pixel) && pixel.includes('url(#chartFill)'), 'grafik bertangga + isian');
    const smooth = shareCard.svgOf('position', p, { lang: 'id', chart });
    assert.ok(/<path d="M[\d.]+ [\d.]+ L[\d.]+ /.test(smooth) && smooth.includes('stroke-dasharray="6 6"'), 'other themes: diagonal lines + range bounds');
    assert.ok(!shareCard.svgOf('position', p, { lang: 'id' }).includes('chartFill'), 'tanpa data → tanpa grafik');
    const bars = shareCard.svgOf('daily', { day: '2024-01-16', rows: [{ symbol0: 'USDG', symbol1: 'MEME', cost: 200, pnl: 50 }], monthTotal: 50 },
      { lang: 'id', chart: { kind: 'bars', bars: Array.from({ length: 31 }, (_, i) => ({ v: i === 15 ? 50 : i % 4 ? 0 : -3, on: i === 15 })) } });
    assert.strictEqual((bars.match(/fill-opacity="0.85"/g) || []).length, 1, 'daily: a single highlighted bar');
  });

  await t('GET /api/share/card: a position from the DB is answered with a PNG; wrong kind/id → 400 JSON', async () => {
    await withServer(null, async (server) => {
      const r = await fetchPng(server, 'kind=position&id=7&lang=id');
      assert.strictEqual(r.status, 200); assert.strictEqual(r.type, 'image/png'); assert.ok(r.body.subarray(0, 4).equals(PNG));
      const total = await fetchPng(server, 'kind=total');
      assert.strictEqual(total.status, 200);
      // Size & theme via query; story = 1080×1920 (2× = 2160×3840).
      const story = await fetchPng(server, 'kind=position&id=7&size=story&theme=neon');
      assert.strictEqual(story.status, 200); assert.strictEqual(story.body.readUInt32BE(20), 3840);
      // Background chart: from GeckoTerminal candles; if GeckoTerminal is unreachable,
      // the card is still answered with 200 (without the chart), not an error.
      const original = shareCard.render; let last = null;
      shareCard.render = (kind, data, opts) => { last = opts; return original(kind, data, opts); };
      try {
        assert.strictEqual((await fetchPng(server, 'kind=position&id=7')).status, 200);
        assert.strictEqual(last.chart?.kind, 'line'); assert.strictEqual(last.chart.pts.length, 60);
        assert.ok(last.chart.band && last.chart.marks.length === 2, 'LP range + entry & exit points (closed position)');
        assert.strictEqual((await fetchPng(server, 'kind=daily&day=2024-01-16&tz=Asia/Jakarta')).status, 200);
        assert.strictEqual(last.chart?.kind, 'bars'); assert.strictEqual(last.chart.bars.length, 31);
        assert.ok(last.chart.bars[15].on && last.chart.bars[15].v === 50, 'day 16 highlighted with its PnL');
        // New server: the candles on the old server are already stored in the Market cache.
        candleFail = true;
        await withServer(null, async (s2) => {
          const without = await fetchPng(s2, 'kind=position&id=7');
          assert.strictEqual(without.status, 200, 'GeckoTerminal down → the card is still produced');
          assert.strictEqual(last.chart, null, 'tanpa grafik');
        });
      } finally { candleFail = false; shareCard.render = original; }
      const wrong = await fetchPng(server, 'kind=position&id=999');
      assert.strictEqual(wrong.status, 400); assert.match(JSON.parse(wrong.body).error, /tidak ditemukan/);
      const kindName = await fetchPng(server, 'kind=apa');
      assert.strictEqual(kindName.status, 400);
    });
  });

  await t('daily card: the day follows the reader\'s time zone (tz), not the server\'s', async () => {
    await withServer(null, async (server) => {
      // Closed 15 Jan 23:30 UTC → in Jakarta that is 16 Jan.
      const jkt = await fetchPng(server, 'kind=daily&day=2024-01-16&tz=Asia/Jakarta');
      assert.strictEqual(jkt.status, 200, 'Jakarta: 16 Jan must be there');
      const utc = await fetchPng(server, 'kind=daily&day=2024-01-15&tz=UTC');
      assert.strictEqual(utc.status, 200, 'UTC: 15 Jan must be there');
      const empty = await fetchPng(server, 'kind=daily&day=2024-01-15&tz=Asia/Jakarta');
      assert.strictEqual(empty.status, 400); assert.match(JSON.parse(empty.body).error, /tidak ada posisi/);
      const defective = await fetchPng(server, 'kind=daily&day=kemarin');
      assert.strictEqual(defective.status, 400);
    });
  });

  await t('GET /api/share/telegram: not ready without a bot, ready if token & chat exist', async () => {
    assert.deepStrictEqual(await world(null).api('GET', '/api/share/telegram'), { ready: false, chats: 0 });
    assert.strictEqual((await world(fakeBot({ chats: [] })).api('GET', '/api/share/telegram')).ready, false);
    assert.deepStrictEqual(await world(fakeBot({ chats: ['1', '2'] })).api('GET', '/api/share/telegram'), { ready: true, chats: 2 });
  });

  await t('POST /api/share/telegram: the card is drawn by the server then sent to each chat with a language caption', async () => {
    const bot = fakeBot({ chats: ['1', '2'] });
    const r = await world(bot).api('POST', '/api/share/telegram', { kind: 'position', id: 7, lang: 'en' });
    assert.deepStrictEqual(r, { sent: 2, failed: 0, lastErr: null });
    assert.deepStrictEqual(bot.sendOrig.map((k) => k.chatId), ['1', '2']);
    assert.ok(Buffer.isBuffer(bot.sendOrig[0].png) && bot.sendOrig[0].png.subarray(0, 4).equals(PNG), 'what is sent must be a PNG');
    assert.strictEqual(bot.sendOrig[0].caption, 'USDG / MEME +25.00% · Quiver');
  });

  await t('POST: one chat failing does not cancel the others; all failing → error; without bot/chat → a clear error', async () => {
    const partial = fakeBot({ chats: ['1', '2'], gagal: ['2'] });
    assert.deepStrictEqual(await world(partial).api('POST', '/api/share/telegram', { kind: 'total' }), { sent: 1, failed: 1, lastErr: 'chat not found' });
    const all = fakeBot({ chats: ['1'], gagal: ['1'] });
    assert.deepStrictEqual(await world(all).api('POST', '/api/share/telegram', { kind: 'total' }), { error: 'chat not found' });
    assert.match((await world(fakeBot({ token: null })).api('POST', '/api/share/telegram', { kind: 'total' })).error, /belum dipasang/);
    assert.match((await world(fakeBot({ chats: [] })).api('POST', '/api/share/telegram', { kind: 'total' })).error, /chat/);
    assert.match((await world(fakeBot()).api('POST', '/api/share/telegram', { kind: 'position', id: 999 })).error, /tidak ditemukan/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
