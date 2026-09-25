'use strict';
// Uji: baris konteks pool di kartu Telegram (LP disalin / LP ditutup).
//  - likuiditas + volume 24 jam dari DexScreener, dan bagian kita atas pool itu;
//  - skor GMGN hanya kalau API key-nya terpasang, dengan penanda bahaya yang sama
//    dengan Kesehatan pool di dasbor;
//  - dan yang paling penting: kabar TIDAK BOLEH hilang atau tertunda karena data
//    pasar gagal/lambat — barisnya yang absen, bukan kartunya.
// Jalankan: node test/kartu-pool.js
const assert = require('node:assert');
const { Telegram } = require('../src/telegram');
const { Store } = require('../src/db');

const POOL = '0x' + 'ab'.repeat(32);
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

const POSISI = {
  id: 1, venue: 'v4', token_id: '889', pool_ref: POOL, baseToken: MEME,
  symbol0: 'USDG', symbol1: 'MEME', fee: 3000, dec0: 6, dec1: 18, quoteSide: 0,
  tick_lower: -600, tick_upper: 600, curTick: 0, costUsd: 120, valueUsd: 120, outUsd: 132,
  pnlUsd: 12, pnlPct: 10, ageHours: 2, empty: true, cost: null, origin: {},
};

// api palsu: hanya tiga rute yang disentuh kartu.
function buat({ pair = undefined, gmgn = { enabled: false }, lambat = false, pasarGagal = false } = {}) {
  const store = new Store(':memory:');
  const cfg = { telegram: { language: 'id', bot_token: null, chat_ids: [] }, mode: { dry_run: false } };
  const engine = {
    network: 'robinhood', label: 'Robinhood Chain', chain: { key: 'robinhood', network: 'robinhood' },
    dryRun: () => false, paused: () => false, store,
  };
  const dilihat = [];
  const api = async (m, path, body, q) => {
    dilihat.push(path);
    if (path === '/api/position') return { position: POSISI };
    if (path === '/api/monitor/market') {
      if (pasarGagal) throw new Error('DexScreener mati');
      if (lambat) return new Promise(() => {});            // tidak pernah selesai
      return { pairs: { [POOL]: pair === undefined ? null : pair }, ts: Date.now() };
    }
    if (path === '/api/gmgn/token') return gmgn;
    return {};
  };
  const bot = new Telegram({ cfg, cfgPath: '/tmp/uji-kartu.json', store, engine, api, log: () => {} });
  return { bot, dilihat };
}

const PASAR = { liquidityUsd: 1_040_000, volume: { h24: 3_120_000, h1: 130_000 } };
const masuk = { kind: 'entry', positionId: 1, valueUsd: 120, txHash: '0xaa' };
const keluar = { kind: 'exit', positionId: 1, full: true, txHash: '0xbb' };

(async () => {
  console.log('Konteks pool di kartu Telegram:\n');

  await t('kartu masuk memuat likuiditas, volume 24 jam, dan bagian kita', async () => {
    const { bot } = buat({ pair: PASAR });
    const [teks] = await bot.kartu('LP disalin', masuk);
    assert.match(teks, /🌊/);
    assert.match(teks, /likuiditas \$1,04M/, teks);
    assert.match(teks, /volume 24j \$3,12M/, teks);
    // $120 dari pool $1,04jt = 0,01%
    assert.match(teks, /bagian kita 0,01%/, teks);
  });

  await t('kartu tutup memuat baris yang sama — pool sepi terbaca saat menutup, bukan cuma saat membuka', async () => {
    const { bot } = buat({ pair: { liquidityUsd: 1_000, volume: { h24: 1_900 } } });
    const [teks] = await bot.kartu('LP ditutup', keluar);
    assert.match(teks, /likuiditas \$1k/, teks);
    assert.match(teks, /volume 24j \$1,9k/, teks);
    // $120 dari pool $1.000 = 12% → penanda peringatan
    assert.match(teks, /bagian kita 12%\s*⚠️/, teks);
  });

  await t('tanpa API key GMGN: tidak ada baris GMGN sama sekali (bukan baris kosong)', async () => {
    const { bot } = buat({ pair: PASAR, gmgn: { enabled: false } });
    const [teks] = await bot.kartu('LP disalin', masuk);
    assert.ok(!/GMGN/.test(teks), teks);
  });

  await t('dengan GMGN: skor rug, pajak, orang dalam — penandanya ikut tingkat bahayanya', async () => {
    const aman = buat({ pair: PASAR, gmgn: { enabled: true, security: { rugPct: 4, buyTaxPct: 0, sellTaxPct: 0 } } });
    const [t1] = await aman.bot.kartu('LP disalin', masuk);
    assert.match(t1, /🧪 GMGN · skor rug 4% · pajak 0\/0%/, t1);

    const waspada = buat({ pair: PASAR, gmgn: { enabled: true, security: { rugPct: 31, buyTaxPct: 1, sellTaxPct: 5, insiderPct: 24 } } });
    const [t2] = await waspada.bot.kartu('LP disalin', masuk);
    assert.match(t2, /⚠️ GMGN · skor rug 31% · pajak 1\/5% · orang dalam 24%/, t2);

    const bahaya = buat({ pair: PASAR, gmgn: { enabled: true, security: { honeypot: true, rugPct: 88, creatorSold: true } } });
    const [t3] = await bahaya.bot.kartu('LP disalin', masuk);
    assert.match(t3, /🛑 GMGN · HONEYPOT · skor rug 88% · dev sudah jual/, t3);
  });

  await t('pool belum terindeks → kartu tetap lengkap, cuma tanpa baris pool', async () => {
    const { bot } = buat({ pair: null });
    const [teks] = await bot.kartu('LP disalin', masuk);
    assert.ok(!/🌊/.test(teks), teks);
    assert.match(teks, /USDG\/MEME/);
    assert.match(teks, /\$120,00/);
  });

  await t('DexScreener melempar → kartu tetap terkirim', async () => {
    const { bot } = buat({ pasarGagal: true });
    const [teks] = await bot.kartu('LP disalin', masuk);
    assert.ok(!/🌊/.test(teks), teks);
    assert.match(teks, /USDG\/MEME/);
  });

  await t('DexScreener menggantung → kartu keluar dalam ~4 detik, tidak menunggu selamanya', async () => {
    const { bot } = buat({ lambat: true });
    const t0 = Date.now();
    const [teks] = await bot.kartu('LP disalin', masuk);
    const ms = Date.now() - t0;
    assert.ok(ms >= 3500 && ms < 8000, `menunggu ${ms} ms`);
    assert.match(teks, /USDG\/MEME/);
  });

  await t('bahasa Inggris: barisnya ikut diterjemahkan', async () => {
    const { bot } = buat({ pair: PASAR, gmgn: { enabled: true, security: { rugPct: 62, buyTaxPct: 2, sellTaxPct: 2 } } });
    bot.store.setState('tg_language:1', 'en');
    const { localeContext } = require('../src/telegram-i18n');
    const teks = await localeContext.run('en', () => bot.kartu('LP disalin', masuk).then(([x]) => x));
    assert.match(teks, /liquidity \$1\.04M/, teks);
    assert.match(teks, /24h volume \$3\.12M/, teks);
    assert.match(teks, /our share 0\.01%/, teks);
    assert.match(teks, /rug score 62% · tax 2\/2%/, teks);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
