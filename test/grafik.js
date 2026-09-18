'use strict';
// Uji kartu grafik posisi (src/chart-card.js + server.chartCard): gambar lilin dengan
// indikator, pita rentang LP, dan garis BEP yang dipakai tombol "📈 Grafik" di bot.
//
// Yang dijaga:
//   - skala harga selalu memuat rentang posisi & BEP, bukan cuma lilinnya — kalau
//     tidak, gambar ini menjawab pertanyaan yang salah;
//   - indikator hanya digambar kalau bitnya menyala (tombol saklar di Telegram);
//   - panel bawah (VOL/RSI/MACD) menambah tinggi gambar, bukan menindih lilin;
//   - posisi tertutup memakai lilin di sekitar masa hidupnya dan menandai harga keluar;
//   - pool yang belum terindeks menjawab galat, bukan gambar kosong.
//
// Jalankan: node test/grafik.js
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
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Lilin palsu dari GeckoTerminal: harga naik pelan dari 0,9 ke 1,3.
function ohlcv(n = 120, from = T0) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const base = 0.9 + (0.4 * i) / n;
    const t = Math.floor((from + i * 3600_000) / 1000);
    list.push([t, base, base * 1.02, base * 0.98, base * 1.01, 1000 + i * 10]);
  }
  return list.reverse();   // GeckoTerminal mengirim terbaru dulu
}

// fetch palsu: hanya dua host yang disentuh Market (GeckoTerminal & DexScreener).
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

function dunia({ live = [], row = {} } = {}) {
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

// Posisi terbuka seperti yang keluar dari sinkron: USDG/MEME, rentang ±0,55–1,82.
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
  console.log('kartu grafik posisi');
  const ALL = chartCard.INDICATORS.reduce((a, i) => a | i.bit, 0);

  await t('gambar terbentuk: PNG, dengan pasangan, rentang waktu, dan harga', async () => {
    stubFetch();
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: chartCard.DEFAULT_MASK });
    assert.ok(!card.error, card.error);
    assert.equal(card.png.slice(1, 4).toString(), 'PNG');
    assert.ok(card.png.length > 20_000, `gambar terlalu kecil: ${card.png.length} bita`);
    assert.match(card.caption, /USDG\/MEME · 1h/);
  });

  await t('rentang posisi & BEP ikut masuk skala, keduanya bergaris di gambar', async () => {
    stubFetch();
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(/BEP/.test(card.caption), `BEP harus ikut di caption: ${card.caption}`);
    assert.match(card.caption, /rentang/);
  });

  await t('indikator hanya digambar kalau bitnya menyala', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5 };
    const mati = chartCard.chartSvg({ ...base, mask: 0 });
    const hidup = chartCard.chartSvg({ ...base, mask: ALL });
    for (const nama of ['MA5', 'EMA6', 'BOLL', 'RSI', 'MACD']) {
      assert.ok(!mati.includes(nama), `${nama} tidak boleh ada saat mask 0`);
      assert.ok(hidup.includes(nama), `${nama} harus ada saat semua indikator menyala`);
    }
  });

  await t('panel bawah menambah tinggi gambar, bukan menindih lilin', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5 };
    const tinggi = (mask) => Number(/height="(\d+)"/.exec(chartCard.chartSvg({ ...base, mask }))[1]);
    const kosong = tinggi(0);
    assert.ok(tinggi(8) > kosong, 'VOL harus menambah tinggi');           // VOL
    assert.ok(tinggi(8 | 16 | 32) > tinggi(8), 'RSI+MACD menambah lagi'); // VOL+RSI+MACD
    assert.equal(tinggi(1 | 2 | 4), kosong, 'indikator di panel lilin tidak menambah tinggi');
  });

  await t('kapan masuk digambar: garis tegak di lilinnya + titik di harga masuk', () => {
    const now = Date.now();
    const cs = [];
    for (let i = 0; i < 60; i++) cs.push({ t: now - (60 - i) * 3600_000, o: 1, h: 1.05, l: 0.95, c: 1, v: 10 });
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: cs, lo: 0.9, hi: 1.1, now: 1, mask: 0, entry: 1 };
    const tanpa = chartCard.chartSvg(base);
    const dengan = chartCard.chartSvg({ ...base, openedTs: now - 30 * 3600_000, ageHours: 30 });
    // Garis tegak penanda waktu memakai pola putus-putusnya sendiri ("5 6"), jadi
    // keberadaannya bisa diuji tanpa tertukar dengan label harga masuk di kolom kanan.
    assert.ok(!tanpa.includes('stroke-dasharray="5 6"'), 'tanpa waktu masuk: tidak ada garis tegak');
    assert.ok(dengan.includes('stroke-dasharray="5 6"'), 'garis tegak waktu masuk harus ada');
    assert.ok(/<circle/.test(dengan), 'titik di perpotongan waktu × harga masuk');
    assert.ok(/dipegang/.test(dengan), 'kaki menyebut sudah dipegang berapa lama');
    // Masuk jauh sebelum jendela lilin: ditempel di tepi dengan panah, bukan hilang.
    const lama = chartCard.chartSvg({ ...base, openedTs: now - 900 * 3600_000 });
    assert.ok(/▸ masuk/.test(lama), 'masuk di luar jendela ditandai panah');
  });

  await t('pita rentang dimulai di lilin saat masuk, berhenti di lilin saat keluar', () => {
    const now = Date.now();
    const cs = [];
    for (let i = 0; i < 100; i++) cs.push({ t: now - (100 - i) * 3600_000, o: 1, h: 1.05, l: 0.95, c: 1, v: 10 });
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: cs, lo: 0.9, hi: 1.1, now: 1, mask: 0 };
    const lebar = (svg) => Number(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="rgba\(122,162,247,0.13\)"/.exec(svg).slice(1, 3)[1]);
    const mulaiX = (svg) => Number(/<rect x="([\d.]+)" y="[\d.]+" width="[\d.]+" height="[\d.]+" fill="rgba\(122,162,247,0.13\)"/.exec(svg)[1]);
    const penuh = chartCard.chartSvg(base);                                   // tanpa waktu masuk: seluruh grafik
    const separuh = chartCard.chartSvg({ ...base, openedTs: now - 50 * 3600_000 });
    const tertutup = chartCard.chartSvg({ ...base, openedTs: now - 80 * 3600_000, closedTs: now - 30 * 3600_000, closed: true });
    assert.ok(mulaiX(separuh) > mulaiX(penuh) + 300, 'pita mulai di lilin masuk, bukan di tepi kiri');
    assert.ok(lebar(separuh) < lebar(penuh) * 0.6, 'pita lebih pendek dari grafik penuh');
    assert.ok(lebar(tertutup) < lebar(penuh) * 0.6 && mulaiX(tertutup) < mulaiX(separuh), 'posisi tertutup: pita dari masuk sampai keluar');
    const lama = chartCard.chartSvg({ ...base, openedTs: now - 900 * 3600_000 });
    assert.equal(mulaiX(lama), mulaiX(penuh), 'masuk sebelum jendela: pita dari tepi kiri');
  });

  await t('lebar jendela: otomatis seumur posisi + konteks; pilihan hari dipangkas ke batas lilin', async () => {
    let limitDiminta = null;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (!u.includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      limitDiminta = Number(new URL(u).searchParams.get('limit'));
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: ohlcv(limitDiminta) } } }) };
    };
    // posisi berumur 100 jam pada lilin 1h → 100 + 40 konteks = 140 lilin
    const { server } = dunia({ live: [livePos({ opened_ts: Date.now() - 100 * 3600_000 })] });
    await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    // Math.ceil atas selisih waktu yang sudah berjalan beberapa ms → 101 + 40.
    assert.ok(limitDiminta === 140 || limitDiminta === 141, `otomatis: ${limitDiminta}`);
    await server.chartCard({ id: 1, tf: '1h', mask: 0, span: 24 });
    assert.equal(limitDiminta, 60, `1 hari pada 1h = 24 lilin → minimum 60: ${limitDiminta}`);
    const r = await server.chartCard({ id: 1, tf: '5m', mask: 0, span: 720 });
    assert.equal(limitDiminta, 400, `30 hari pada 5m dipangkas ke 400: ${limitDiminta}`);
    assert.equal(r.candles, 400);
  });

  await t('label harga di kolom kanan tidak saling menimpa', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 0.5, hi: 2, mask: 0 };
    // BEP dan harga masuk hampir sama tingginya: labelnya harus digeser, bukan bertumpuk.
    const svg = chartCard.chartSvg({ ...base, now: 1.5, entry: 1.0, bepPrice: 1.005 });
    const ys = [...svg.matchAll(/<rect x="\d+" y="([\d.]+)" width="[\d.]+" height="22"/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
    assert.ok(ys.length >= 3, `tiga label diharapkan: ${ys.length}`);
    for (let i = 1; i < ys.length; i++) assert.ok(ys[i] - ys[i - 1] >= 20, `label ${i} terlalu rapat: ${ys}`);
  });

  await t('posisi tertutup: berlabel ditutup, tanpa BEP', async () => {
    stubFetch();
    const { server } = dunia({ row: { status: 'closed', closedTs: T0 + 40 * 3600_000, outQuote: 215, txClose: '0xburn1' } });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: chartCard.DEFAULT_MASK });
    assert.ok(!card.error, card.error);
    assert.ok(!/BEP/.test(card.caption), `posisi tertutup tidak punya BEP: ${card.caption}`);
  });

  await t('pool belum terindeks: galat, bukan gambar kosong', async () => {
    stubFetch({ indexed: false });
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(card.error, 'harus menjawab galat');
  });

  await t('kutipan lilin gagal sekali (batas waktu / 502): dicoba lagi, bukan langsung galat', async () => {
    let n = 0;
    const asli = ohlcv();
    globalThis.fetch = async (url) => {
      if (!String(url).includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      n++;
      // GeckoTerminal sesekali menjawab 502 beberapa detik — itu bukan alasan
      // membalas tombol dengan galat.
      if (n === 1) return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: asli } } }) };
    };
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.ok(!card.error, `harus lolos di percobaan kedua: ${card.error}`);
    assert.equal(n, 2, 'tepat dua kali panggil');
  });

  await t('kutipan lilin gagal terus: galatnya menyuruh coba lagi, bukan teks mentah fetch', async () => {
    globalThis.fetch = async (url) => {
      if (!String(url).includes('geckoterminal')) return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
      throw new Error('The operation was aborted due to timeout');
    };
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 1, tf: '1h', mask: 0 });
    assert.match(card.error, /coba lagi/);
  });

  await t('lilin dari cadangan: umurnya ikut tercetak di kaki gambar', () => {
    const base = { pair: 'A/B', positionId: 1, tf: '1h', secs: 3600, candles: [], lo: 1, hi: 2, now: 1.5, mask: 0 };
    const segar = chartCard.chartSvg(base);
    const basi = chartCard.chartSvg({ ...base, staleAt: Date.now() - 20 * 60_000 });
    assert.ok(!/harga \d/.test(segar), 'data segar tidak perlu dijelaskan');
    assert.ok(/harga \d/.test(basi), 'data cadangan harus menyebut jamnya');
  });

  await t('posisi tidak ada: galat', async () => {
    stubFetch();
    const { server } = dunia({ live: [livePos()] });
    const card = await server.chartCard({ id: 99 });
    assert.ok(card.error, 'harus menjawab galat');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
