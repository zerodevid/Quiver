'use strict';
// Test: the pool context line on the Telegram card (LP copied / LP closed).
//  - liquidity + 24h volume from DexScreener, and our share of that pool;
//  - GMGN score only when its API key is installed, with the same danger markers
//    as Pool health on the dashboard;
//  - and most important: the news MUST NOT be lost or delayed because market
//    data failed/is slow — the line is what goes missing, not the card.
// Run: node test/pool-card.js
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

// fake api: only three routes are touched by the card.
function make({ pair = undefined, gmgn = { enabled: false }, slow = false, marketFailed = false } = {}) {
  const store = new Store(':memory:');
  const cfg = { telegram: { language: 'id', bot_token: null, chat_ids: [] }, mode: { dry_run: false } };
  const engine = {
    network: 'robinhood', label: 'Robinhood Chain', chain: { key: 'robinhood', network: 'robinhood' },
    dryRun: () => false, paused: () => false, store,
  };
  const seen = [];
  const api = async (m, path, body, q) => {
    seen.push(path);
    if (path === '/api/position') return { position: POSISI };
    if (path === '/api/monitor/market') {
      if (marketFailed) throw new Error('DexScreener mati');
      if (slow) return new Promise(() => {});            // never finishes
      return { pairs: { [POOL]: pair === undefined ? null : pair }, ts: Date.now() };
    }
    if (path === '/api/gmgn/token') return gmgn;
    return {};
  };
  const bot = new Telegram({ cfg, cfgPath: '/tmp/uji-kartu.json', store, engine, api, log: () => {} });
  return { bot, seen };
}

const MARKET = { liquidityUsd: 1_040_000, volume: { h24: 3_120_000, h1: 130_000 } };
const entry = { kind: 'entry', positionId: 1, valueUsd: 120, txHash: '0xaa' };
const out = { kind: 'exit', positionId: 1, full: true, txHash: '0xbb' };

(async () => {
  console.log('Pool context on the Telegram card:\n');

  await t('the entry card contains liquidity, 24-hour volume, and our share', async () => {
    const { bot } = make({ pair: MARKET });
    const [text] = await bot.cardMsg('LP disalin', entry);
    assert.match(text, /🌊/);
    assert.match(text, /likuiditas \$1,04M/, text);
    assert.match(text, /volume 24j \$3,12M/, text);
    // $120 of a $1.04m pool = 0.01%
    assert.match(text, /bagian kita 0,01%/, text);
  });

  await t('the close card contains the same line — a quiet pool is seen when closing, not only when opening', async () => {
    const { bot } = make({ pair: { liquidityUsd: 1_000, volume: { h24: 1_900 } } });
    const [text] = await bot.cardMsg('LP ditutup', out);
    assert.match(text, /likuiditas \$1k/, text);
    assert.match(text, /volume 24j \$1,9k/, text);
    // $120 of a $1,000 pool = 12% → warning marker
    assert.match(text, /bagian kita 12%\s*⚠️/, text);
  });

  await t('without a GMGN API key: no GMGN line at all (not an empty line)', async () => {
    const { bot } = make({ pair: MARKET, gmgn: { enabled: false } });
    const [text] = await bot.cardMsg('LP disalin', entry);
    assert.ok(!/GMGN/.test(text), text);
  });

  await t('with GMGN: rug score, tax, insiders — the marker follows the danger level', async () => {
    const safe = make({ pair: MARKET, gmgn: { enabled: true, security: { rugPct: 4, buyTaxPct: 0, sellTaxPct: 0 } } });
    const [t1] = await safe.bot.cardMsg('LP disalin', entry);
    assert.match(t1, /🧪 GMGN · skor rug 4% · pajak 0\/0%/, t1);

    const warning = make({ pair: MARKET, gmgn: { enabled: true, security: { rugPct: 31, buyTaxPct: 1, sellTaxPct: 5, insiderPct: 24 } } });
    const [t2] = await warning.bot.cardMsg('LP disalin', entry);
    assert.match(t2, /⚠️ GMGN · skor rug 31% · pajak 1\/5% · orang dalam 24%/, t2);

    const danger = make({ pair: MARKET, gmgn: { enabled: true, security: { honeypot: true, rugPct: 88, creatorSold: true } } });
    const [t3] = await danger.bot.cardMsg('LP disalin', entry);
    assert.match(t3, /🛑 GMGN · HONEYPOT · skor rug 88% · dev sudah jual/, t3);
  });

  await t('pool not yet indexed → the card is still complete, just without the pool line', async () => {
    const { bot } = make({ pair: null });
    const [text] = await bot.cardMsg('LP disalin', entry);
    assert.ok(!/🌊/.test(text), text);
    assert.match(text, /USDG\/MEME/);
    assert.match(text, /\$120,00/);
  });

  await t('DexScreener throws → the card is still sent', async () => {
    const { bot } = make({ marketFailed: true });
    const [text] = await bot.cardMsg('LP disalin', entry);
    assert.ok(!/🌊/.test(text), text);
    assert.match(text, /USDG\/MEME/);
  });

  await t('DexScreener hangs → the card goes out within ~4 seconds, not waiting forever', async () => {
    const { bot } = make({ slow: true });
    const t0 = Date.now();
    const [text] = await bot.cardMsg('LP disalin', entry);
    const ms = Date.now() - t0;
    assert.ok(ms >= 3500 && ms < 8000, `menunggu ${ms} ms`);
    assert.match(text, /USDG\/MEME/);
  });

  await t('English: the lines are translated too', async () => {
    const { bot } = make({ pair: MARKET, gmgn: { enabled: true, security: { rugPct: 62, buyTaxPct: 2, sellTaxPct: 2 } } });
    bot.store.setState('tg_language:1', 'en');
    const { localeContext } = require('../src/telegram-i18n');
    const text = await localeContext.run('en', () => bot.cardMsg('LP disalin', entry).then(([x]) => x));
    assert.match(text, /liquidity \$1\.04M/, text);
    assert.match(text, /24h volume \$3\.12M/, text);
    assert.match(text, /our share 0\.01%/, text);
    assert.match(text, /rug score 62% · tax 2\/2%/, text);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
