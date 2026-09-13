'use strict';
// Kartu bagikan. Jalankan: node test/bagikan.js
//
// Kartu digambar di server (src/share-card.js) dari data rute yang sama dengan
// dasbor, lalu dibalas sebagai PNG (GET /api/share/card) atau dikirim ke tiap chat
// Telegram (POST /api/share/telegram). Yang dikunci di sini: ketiga jenis kartu
// benar-benar jadi PNG dari data di DB, keterangan (caption) mengikuti bahasa,
// hari di kalender dihitung menurut zona waktu pembaca, dan kegagalan sebagian
// pengiriman dilaporkan tanpa membatalkan yang berhasil.
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
// 2024-01-15 23:30 UTC = 16 Jan 06:30 di Jakarta: hari yang berbeda menurut zona waktu.
const T_CLOSE = Date.UTC(2024, 0, 15, 23, 30);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia(telegram) {
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
  // Satu posisi ditutup untung $50 (modal 200 → hasil 250).
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,status,opened_ts,closed_ts,
      cost0,cost1,cost_quote,out_quote,quote_symbol,tx_open,tx_close)
    VALUES(7,'v4','2000007',?,?,?,3000,-60,60,'closed',?,?,'0','0',200,250,'USDG','0xmint7','0xburn7')`,
  POOL, ADDR.usdg, MEME, T_CLOSE - 3600e3, T_CLOSE);
  return server;
}

// Bot tiruan: mencatat apa yang dikirim, dan bisa disuruh gagal untuk chat tertentu.
function botTiruan({ token = 'tok', chats = ['1'], gagal = [] } = {}) {
  const kirim = [];
  return {
    kirim,
    token: () => token,
    chats: () => chats,
    async sendPhoto(chatId, png, caption) {
      if (gagal.includes(chatId)) throw new Error('chat not found');
      kirim.push({ chatId, png, caption });
    },
  };
}

// GET gambar lewat HTTP sungguhan: rute PNG tidak lewat tabel JSON.
const ambilPng = (server, query) => new Promise((resolve, reject) => {
  const { port } = server.address();
  http.get({ host: '127.0.0.1', port, path: '/api/share/card?' + query }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(parts) }));
  }).on('error', reject);
});
const denganServer = async (telegram, fn) => {
  const server = dunia(telegram);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server); } finally { server.close(); }
};

(async () => {
  await t('penggambar: ketiga jenis kartu jadi PNG 2400×1260, bahasa & nominal tersembunyi dihormati', () => {
    const p = { id: 1, venue: 'v4', fee: 3000, token0: ADDR.usdg, token1: MEME, symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, quoteSide: 0,
      entrySqrt: String(2n ** 96n), curTick: 10, costUsd: 200, valueUsd: 230, feeUsd: 5, claimedUsd: 0, pnlUsd: 35, pnlPct: 17.5, ageHours: 3, opened_ts: Date.now(), inRange: true, status: 'open' };
    for (const [kind, data] of [['position', p], ['total', { now: { pnl: 10, value: 100, capital: 90, realizedUsd: 10, unrealizedUsd: 0, feeUsd: 1, openCount: 1 }, stats: { closedCount: 2, wins: 1, losses: 1, winRatePct: 50, best: 5 } }],
      ['daily', { day: '2024-01-16', rows: [{ symbol0: 'USDG', symbol1: 'MEME', cost: 200, pnl: 50 }], monthTotal: 50 }]]) {
      const png = shareCard.render(kind, data, { lang: 'id', timeZone: 'Asia/Jakarta' });
      assert.ok(png.subarray(0, 4).equals(PNG), `${kind}: bukan PNG`);
      // Lebar & tinggi PNG ada di potongan IHDR (byte 16–23).
      assert.strictEqual(png.readUInt32BE(16), 2400); assert.strictEqual(png.readUInt32BE(20), 1260);
    }
    const id = shareCard.svgOf('position', p, { lang: 'id' }), en = shareCard.svgOf('position', p, { lang: 'en' });
    assert.ok(id.includes('Harga masuk') && !id.includes('Entry price'));
    assert.ok(en.includes('Entry price') && en.includes('+17.50%'), 'label & angka Inggris');
    assert.ok(id.includes('+17,50%'), 'koma desimal Indonesia');
    const hidden = shareCard.svgOf('position', p, { lang: 'id', hideAmounts: true });
    assert.ok(!hidden.includes('$35,00') && hidden.includes('Nominal disembunyikan'), 'nominal dolar tidak boleh bocor');
    assert.strictEqual(shareCard.caption('position', p, 'en'), 'USDG / MEME +17.50% · Quiver');
  });

  await t('GET /api/share/card: posisi dari DB dibalas PNG; jenis/id salah → 400 JSON', async () => {
    await denganServer(null, async (server) => {
      const r = await ambilPng(server, 'kind=position&id=7&lang=id');
      assert.strictEqual(r.status, 200); assert.strictEqual(r.type, 'image/png'); assert.ok(r.body.subarray(0, 4).equals(PNG));
      const total = await ambilPng(server, 'kind=total');
      assert.strictEqual(total.status, 200);
      const salah = await ambilPng(server, 'kind=position&id=999');
      assert.strictEqual(salah.status, 400); assert.match(JSON.parse(salah.body).error, /tidak ditemukan/);
      const jenis = await ambilPng(server, 'kind=apa');
      assert.strictEqual(jenis.status, 400);
    });
  });

  await t('kartu harian: hari mengikuti zona waktu pembaca (tz), bukan server', async () => {
    await denganServer(null, async (server) => {
      // Ditutup 15 Jan 23:30 UTC → di Jakarta itu 16 Jan.
      const jkt = await ambilPng(server, 'kind=daily&day=2024-01-16&tz=Asia/Jakarta');
      assert.strictEqual(jkt.status, 200, 'Jakarta: 16 Jan harus ada');
      const utc = await ambilPng(server, 'kind=daily&day=2024-01-15&tz=UTC');
      assert.strictEqual(utc.status, 200, 'UTC: 15 Jan harus ada');
      const kosong = await ambilPng(server, 'kind=daily&day=2024-01-15&tz=Asia/Jakarta');
      assert.strictEqual(kosong.status, 400); assert.match(JSON.parse(kosong.body).error, /tidak ada posisi/);
      const cacat = await ambilPng(server, 'kind=daily&day=kemarin');
      assert.strictEqual(cacat.status, 400);
    });
  });

  await t('GET /api/share/telegram: belum siap tanpa bot, siap kalau token & chat ada', async () => {
    assert.deepStrictEqual(await dunia(null).api('GET', '/api/share/telegram'), { ready: false, chats: 0 });
    assert.strictEqual((await dunia(botTiruan({ chats: [] })).api('GET', '/api/share/telegram')).ready, false);
    assert.deepStrictEqual(await dunia(botTiruan({ chats: ['1', '2'] })).api('GET', '/api/share/telegram'), { ready: true, chats: 2 });
  });

  await t('POST /api/share/telegram: kartu digambar server lalu dikirim ke tiap chat dengan caption berbahasa', async () => {
    const bot = botTiruan({ chats: ['1', '2'] });
    const r = await dunia(bot).api('POST', '/api/share/telegram', { kind: 'position', id: 7, lang: 'en' });
    assert.deepStrictEqual(r, { sent: 2, failed: 0, lastErr: null });
    assert.deepStrictEqual(bot.kirim.map((k) => k.chatId), ['1', '2']);
    assert.ok(Buffer.isBuffer(bot.kirim[0].png) && bot.kirim[0].png.subarray(0, 4).equals(PNG), 'yang dikirim harus PNG');
    assert.strictEqual(bot.kirim[0].caption, 'USDG / MEME +25.00% · Quiver');
  });

  await t('POST: satu chat gagal tidak membatalkan yang lain; semua gagal → error; tanpa bot/chat → error jelas', async () => {
    const sebagian = botTiruan({ chats: ['1', '2'], gagal: ['2'] });
    assert.deepStrictEqual(await dunia(sebagian).api('POST', '/api/share/telegram', { kind: 'total' }), { sent: 1, failed: 1, lastErr: 'chat not found' });
    const semua = botTiruan({ chats: ['1'], gagal: ['1'] });
    assert.deepStrictEqual(await dunia(semua).api('POST', '/api/share/telegram', { kind: 'total' }), { error: 'chat not found' });
    assert.match((await dunia(botTiruan({ token: null })).api('POST', '/api/share/telegram', { kind: 'total' })).error, /belum dipasang/);
    assert.match((await dunia(botTiruan({ chats: [] })).api('POST', '/api/share/telegram', { kind: 'total' })).error, /chat/);
    assert.match((await dunia(botTiruan()).api('POST', '/api/share/telegram', { kind: 'position', id: 999 })).error, /tidak ditemukan/);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
