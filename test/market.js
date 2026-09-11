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
