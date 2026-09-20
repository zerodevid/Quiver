'use strict';
// Data pasar untuk halaman detail posisi: cache DexScreener/GeckoTerminal dan
// penurunan harga masuk untuk posisi lama. Jalankan: node test/market.js
const assert = require('node:assert');
const { Market } = require('../src/market');
const { Positions } = require('../src/positions');
const m = require('../src/v3math');

let lulus = 0, gagal = 0;
async function uji(nama, fn) {
  try { await fn(); lulus++; console.log(`  ok   ${nama}`); }
  catch (e) { gagal++; console.log(`  GAGAL ${nama}\n       ${e.message}`); }
}

const POOL = '0x' + 'ab'.repeat(32);
function palsu({ status = 200, candles = [[1000, 1, 2, 0.5, 1.5, 10], [2000, 1.5, 3, 1, 2, 20]] } = {}) {
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

  await uji('lilin diurutkan naik dan waktunya dalam milidetik', async () => {
    const { mk } = palsu({ candles: [[2000, 1.5, 3, 1, 2, 20], [1000, 1, 2, 0.5, 1.5, 10]] });
    const r = await mk.candles(POOL, '1h');
    assert.deepStrictEqual(r.candles.map((c) => c.t), [1000000, 2000000]);
    assert.strictEqual(r.candles[0].c, 1.5);
    assert.strictEqual(r.base.address, '0xa');
  });

  await uji('panggilan gagal (429/502) memakai jawaban baik terakhir, bertanda stale', async () => {
    let gagalkan = false;
    const mk = new Market({ fetch: async (url) => {
      if (gagalkan) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: [[1000, 1, 2, 0.5, 1.5, 10]] } } }) };
    } });
    const baik = await mk.memo('k', 0, () => mk.candles(POOL, '1h'));
    assert.ok(!baik.error && !baik.stale, 'panggilan pertama harus bersih');
    gagalkan = true;
    const cadangan = await mk.memo('k', 0, async () => ({ error: 'batas panggilan (429) — coba lagi sebentar' }));
    assert.ok(!cadangan.error, `harus memakai cadangan: ${cadangan.error}`);
    assert.strictEqual(cadangan.stale, true, 'ditandai stale');
    assert.ok(cadangan.staleAt > 0, 'umur cadangan dibawa');
    assert.strictEqual(cadangan.candles.length, 1, 'isinya jawaban baik terakhir');
  });

  await uji('transaksi pool: arah beli/jual terhadap token spekulatif, harga dari jumlah swap, terbaru di depan', async () => {
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
        // GeckoTerminal memberi label "sell" (base versinya USDG), tapi terhadap X ini beli.
        row('1', '2026-09-20T15:00:00Z', USDG, X, 10, 20, 'sell'),
        row('2', '2026-09-20T15:01:00Z', X, USDG, 40, 20, 'buy'),
      ] }) };
    } });
    const r = await mk.trades(POOL, { token: X });
    assert.match(calls[0], /\/pools\/0xab.*\/trades\?/);
    assert.deepStrictEqual(r.trades.map((x) => x.side), ['sell', 'buy'], 'terbaru di depan, arah terhadap X');
    assert.deepStrictEqual(r.trades.map((x) => x.base), [40, 20], 'jumlah token spekulatif');
    assert.deepStrictEqual(r.trades.map((x) => x.priceQuote), [0.5, 0.5], 'harga = kuotasi / spekulatif');
    assert.strictEqual(r.trades[1].priceUsd, 0.5, 'harga USD sisi token spekulatif');
    assert.strictEqual(r.trades[1].ts, Date.parse('2026-09-20T15:00:00Z'));
    // Tanpa alamat token, ikut label GeckoTerminal.
    const r2 = await new Market({ fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: [row('3', '2026-09-20T15:00:00Z', USDG, X, 10, 20, 'sell')] }) }) }).trades(POOL);
    assert.strictEqual(r2.trades[0].side, 'sell');
    // Cache: poll kedua dalam 10 detik tidak memanggil GeckoTerminal lagi.
    await mk.trades(POOL, { token: X });
    assert.strictEqual(calls.length, 1);
  });

  await uji('tanpa jawaban baik sebelumnya, galat tetap galat', async () => {
    const mk = new Market({ fetch: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    const r = await mk.memo('kosong', 0, async () => ({ error: 'batas panggilan (429) — coba lagi sebentar' }));
    assert.match(r.error, /429/);
  });

  await uji('permintaan yang sama dalam jendela cache cuma satu panggilan ke luar', async () => {
    const { mk, calls } = palsu();
    await Promise.all([mk.candles(POOL, '1h'), mk.candles(POOL, '1h'), mk.pair(POOL), mk.pair(POOL)]);
    await mk.candles(POOL, '1h');
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 1);
    assert.strictEqual(calls.filter((u) => u.includes('dexscreener')).length, 1);
  });

  await uji('rentang waktu dan token dasar diteruskan ke GeckoTerminal', async () => {
    const { mk, calls } = palsu();
    await mk.candles(POOL, '4h', { limit: 50, token: '0xabc' });
    const u = new URL(calls[0]);
    assert.ok(u.pathname.endsWith('/ohlcv/hour'));
    assert.strictEqual(u.searchParams.get('aggregate'), '4');
    assert.strictEqual(u.searchParams.get('limit'), '50');
    assert.strictEqual(u.searchParams.get('token'), '0xabc');
    assert.strictEqual(u.searchParams.get('currency'), 'token');
  });

  await uji('batas akhir dibulatkan ke lilin supaya cache-nya kena', async () => {
    const { mk, calls } = palsu();
    await mk.candles(POOL, '1h', { before: 3_600_000 * 10 + 1000 });
    await mk.candles(POOL, '1h', { before: 3_600_000 * 10 + 900_000 });
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(new URL(calls[0]).searchParams.get('before_timestamp'), String(3600 * 11));
  });

  await uji('batas panggilan (429) jadi pesan galat, bukan lemparan; dicoba lagi setelah jeda', async () => {
    const { mk, calls } = palsu({ status: 429 });
    const r = await mk.pair(POOL);
    assert.match(r.error, /429/);
    await mk.pair(POOL);
    assert.strictEqual(calls.length, 1, 'galat disimpan sebentar');
  });

  await uji('429 dari GeckoTerminal menahan semua panggilan ke sana 20 detik; DexScreener tidak ikut', async () => {
    const calls = [];
    const mk = new Market({ fetch: async (url) => {
      calls.push(url);
      if (url.startsWith('https://api.geckoterminal.com/')) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ pairs: [{ baseToken: {}, quoteToken: {} }] }) };
    } });
    assert.match((await mk.candles(POOL, '1h')).error, /429/);
    assert.match((await mk.trades(POOL)).error, /429/, 'pool lain/endpoint lain ikut ditahan');
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 1, 'hanya satu tembakan yang lolos');
    assert.ok(!(await mk.pair(POOL)).error, 'DexScreener tetap dipanggil');
    mk.gtCooldown = 0;
    await mk.trades('0x' + 'cd'.repeat(32));
    assert.strictEqual(calls.filter((u) => u.includes('geckoterminal')).length, 2, 'setelah jeda dicoba lagi');
  });

  await uji('lilin GMGN: X-APIKEY + chain + rentang ms, harga USD, amount jadi volume; tanpa key -> galat', async () => {
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
    assert.strictEqual(Number(u.searchParams.get('to')) - Number(u.searchParams.get('from')), 100 * 300 * 1000, 'rentang = limit lilin, dalam ms');
    assert.strictEqual(calls[0].headers['X-APIKEY'], 'kunci123');
    assert.ok(!mk.gmgnEnabled.call(new Market({ fetch: fetchImpl })), 'tanpa key = nonaktif');
    assert.match((await new Market({ fetch: fetchImpl }).candlesGmgn('0xabc', '5m')).error, /API key/);
  });

  await uji('limit GMGN (RATE_LIMIT_*) menahan panggilan 10 detik dan memakai cadangan; key ditolak dijelaskan', async () => {
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
    assert.ok(cad.stale && cad.candles.length === 1, 'cadangan dipakai saat limit');
    const n = calls.length;
    await mk.memo('b', 0, () => mk.candlesGmgn('0xdef', '1h'));
    assert.strictEqual(calls.length, n, 'selama jeda tidak ada panggilan keluar');
    mk.gmgnCooldown = 0; mode = 'auth';
    assert.match((await mk.candlesGmgn('0x999', '1h')).error, /menolak API key/);
  });

  await uji('pool yang belum terindeks (404) dijelaskan', async () => {
    const { mk } = palsu({ status: 404 });
    const r = await mk.candles(POOL, '1h');
    assert.match(r.error, /GeckoTerminal/);
  });

  console.log('harga masuk posisi lama');

  await uji('diturunkan balik dari jumlah setoran, sama dengan harga saat mint', () => {
    const lo = 343200, hi = 356000, tick = 349600;
    const s = m.getSqrtRatioAtTick(tick);
    const L = 25346118802953558n;
    const amt = m.amountsForLiquidity(s, m.getSqrtRatioAtTick(lo), m.getSqrtRatioAtTick(hi), L);
    const got = BigInt(Positions.entrySqrtOf({ liquidity: L.toString(), cost0: amt.amount0.toString(), cost1: amt.amount1.toString(), tick_lower: lo, tick_upper: hi }));
    const selisih = Number((got - s) * 10n ** 9n / s) / 1e9;
    assert.ok(Math.abs(selisih) < 1e-9, `selisih ${selisih}`);
  });

  await uji('satu sisi = harga di tepi rentang; kolom tersimpan menang', () => {
    const lo = 100, hi = 200;
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '10', cost0: '5', cost1: '0', tick_lower: lo, tick_upper: hi }), m.getSqrtRatioAtTick(lo).toString());
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '10', cost0: '0', cost1: '5', tick_lower: lo, tick_upper: hi }), m.getSqrtRatioAtTick(hi).toString());
    assert.strictEqual(Positions.entrySqrtOf({ entry_sqrt: '123', liquidity: '10', cost0: '5', cost1: '5', tick_lower: lo, tick_upper: hi }), '123');
    assert.strictEqual(Positions.entrySqrtOf({ liquidity: '0', cost0: '5', cost1: '5', tick_lower: lo, tick_upper: hi }), null);
  });

  console.log(`\n${lulus} lulus, ${gagal} gagal`);
  process.exit(gagal ? 1 : 0);
})();
