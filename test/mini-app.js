'use strict';
// Uji mini app Telegram:
//  - tanda tangan initData: yang sah lolos, yang diubah/ditandatangani token lain/basi ditolak
//  - /api/tg/auth cuma melayani chat yang ada di telegram.chat_ids
//  - tiket yang dikembalikannya membuka /api/* sebagai Bearer; tiket asal ditolak
//  - halaman /mini dan potongannya lolos gerbang token, dasbor tetap terkunci
//  - halaman mini boleh dibingkai Telegram (frame-ancestors), halaman lain tidak
//
// Jalankan: node test/mini-app.js
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer, checkInitData } = require('../src/server');

const TOKEN = 'rahasia-akses-uji';
const BOT = '123456:uji-token-bot';
const CHAT = 4242;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// initData seperti yang dikirim Telegram: kolom apa adanya + hash HMAC-nya.
// `signature`: 'ikut' = seperti Telegram sejak Bot API 8.0 (ikut dihitung dalam hash),
// 'luar' = konvensi sebagian pustaka (dikirim tapi tidak dihitung), null = klien lama.
function initData({ id = CHAT, botToken = BOT, authDate = Math.floor(Date.now() / 1000), signature = 'ikut', extra = {} } = {}) {
  const q = new URLSearchParams({
    user: JSON.stringify({ id, first_name: 'Uji', username: 'uji' }),
    auth_date: String(authDate),
    query_id: 'AAE',
    ...(signature ? { signature: 'x9_tanda-tangan-ed25519' } : {}),
    ...extra,
  });
  const ikut = [...q.entries()].filter(([k]) => signature === 'ikut' || k !== 'signature');
  const data = ikut.map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  q.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return q.toString();
}

function serve({ chats = [CHAT] } = {}) {
  const store = new Store(':memory:');
  const cfg = {
    mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] },
    server: { auth_token: TOKEN }, notify: {}, wallet: {},
    telegram: { bot_token: BOT, chat_ids: chats },
  };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-mini-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0, resync: async () => {}, summary: () => ({ openCount: 0, inRange: 0, exposureUsd: 0, feeUsd: 0, costUsd: 0, realizedUsd: 0, unrealizedUsd: 0, leftoverUsd: 0 }) },
    watcher: { unsupported: new Map() }, exec: { address: () => null, balances: async () => new Map() },
    leftovers: () => [], dryRun: () => true, paused: () => false, freshCash: async () => null,
    stats: { startedAt: Date.now() }, head: 0, cursor: 0, drawdownStatus: () => null,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      cfg, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    }));
  });
}

const auth = (base, data) => fetch(`${base}/api/tg/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData: data }),
});

(async () => {
  console.log('\nMini app Telegram:\n');

  await t('initData yang sah dikenali, hash yang diubah ditolak', () => {
    const d = initData();
    assert.equal(checkInitData(d, BOT).user.id, CHAT);
    const rusak = d.replace(/hash=([0-9a-f])/, (m, c) => `hash=${c === 'a' ? 'b' : 'a'}`);
    assert.match(checkInitData(rusak, BOT).error, /tanda tangan/);
    // Isinya diubah tanpa menghitung ulang hash (nama lain, orang lain).
    const q = new URLSearchParams(d);
    q.set('user', JSON.stringify({ id: 999, first_name: 'Lain' }));
    assert.match(checkInitData(q.toString(), BOT).error, /tanda tangan/);
  });

  await t('initData yang ditandatangani bot lain ditolak', () => {
    const r = checkInitData(initData({ botToken: '999:bot-lain' }), BOT);
    assert.match(r.error, /tanda tangan/);
  });

  await t('initData basi ditolak, yang masih dalam jendela diterima', () => {
    const tua = initData({ authDate: Math.floor(Date.now() / 1000) - 2 * 86400 });
    assert.match(checkInitData(tua, BOT).error, /kedaluwarsa/);
    const kemarin = initData({ authDate: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal(checkInitData(kemarin, BOT).user.id, CHAT);
  });

  await t('signature: ikut dihitung (Telegram) maupun tidak, keduanya diterima', () => {
    // Bot API 8.0 menambahkan `signature`, dan Telegram MENGHITUNGNYA dalam hash.
    // Mengeluarkannya membuat semua klien baru ditolak — persis kegagalan pertama
    // mini app ini di lapangan.
    const baku = checkInitData(initData({ signature: 'ikut' }), BOT);
    assert.equal(baku.user.id, CHAT);
    assert.equal(baku.varian, 'baku');
    // Konvensi lama sebagian pustaka: dikirim tapi tidak ikut dihitung.
    const lain = checkInitData(initData({ signature: 'luar' }), BOT);
    assert.equal(lain.user.id, CHAT);
    assert.equal(lain.varian, 'tanpa signature');
    // Klien lama tidak mengirimnya sama sekali.
    assert.equal(checkInitData(initData({ signature: null }), BOT).user.id, CHAT);
    // Yang tetap harus ditolak: kolom lain diubah setelah ditandatangani.
    const q = new URLSearchParams(initData({ signature: 'ikut' }));
    q.set('query_id', 'BBB');
    assert.match(checkInitData(q.toString(), BOT).error, /tanda tangan/);
  });

  const s = await serve();

  await t('chat yang belum tersambung tidak dilayani', async () => {
    const r = await (await auth(s.base, initData({ id: 777 }))).json();
    assert.match(r.error, /belum tersambung/i);
    assert.ok(!r.token);
  });

  await t('initData palsu tidak menghasilkan tiket', async () => {
    const r = await (await auth(s.base, initData({ botToken: 'bot-lain' }))).json();
    assert.ok(r.error);
    assert.ok(!r.token);
  });

  let tiket = null;
  await t('chat tersambung mendapat tiket + cookie sesi', async () => {
    const res = await auth(s.base, initData());
    const r = await res.json();
    assert.equal(r.ok, true);
    assert.equal(r.user.id, CHAT);
    assert.match(r.token, /^[0-9a-f]{64}$/);
    assert.match(String(res.headers.get('set-cookie')), /lpcopy_token=/);
    tiket = r.token;
  });

  await t('tiket membuka /api, tiket asal-asalan tidak', async () => {
    const ok = await fetch(`${s.base}/api/logs`, { headers: { authorization: `Bearer ${tiket}` } });
    assert.equal(ok.status, 200);
    const no = await fetch(`${s.base}/api/logs`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } });
    assert.equal(no.status, 401);
    const polos = await fetch(`${s.base}/api/logs`);
    assert.equal(polos.status, 401);
  });

  await t('lambang token: tiket di query hanya membuka rute gambar', async () => {
    const addr = '0x' + 'ab'.repeat(20);
    // <img> tidak bisa membawa header, jadi tiket boleh ikut di query — untuk rute ini saja.
    assert.notEqual((await fetch(`${s.base}/api/icon?a=${addr}&t=${tiket}`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/icon?a=${addr}`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/icon?a=${addr}&t=${'0'.repeat(64)}`)).status, 401);
    // Tiket di query TIDAK membuka rute lain — kalau iya, satu URL bocor = seluruh dasbor.
    assert.equal((await fetch(`${s.base}/api/logs?t=${tiket}`)).status, 401);
    assert.equal((await fetch(`${s.base}/?t=${tiket}`)).status, 401);
  });

  await t('halaman mini lolos gerbang, dasbor tetap terkunci', async () => {
    const dist = path.join(__dirname, '..', 'web', 'dist');
    const adaBuild = fs.existsSync(path.join(dist, 'mini.html'));
    const r = await fetch(`${s.base}/mini`);
    // 401 = gerbang menutupnya — itu yang tidak boleh terjadi, dengan atau tanpa build.
    assert.notEqual(r.status, 401);
    if (adaBuild) {
      assert.equal(r.status, 200);
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors[^;]*telegram\.org/);
      assert.equal(r.headers.get('x-frame-options'), null);   // DENY mengalahkan izin di atas
      const nama = (await r.text()).match(/\/assets\/(mini-[A-Za-z0-9_.-]+\.js)/)?.[1];
      assert.ok(nama, 'mini.html harus merujuk potongan mini-*.js');
      assert.equal((await fetch(`${s.base}/assets/${nama}`)).status, 200);
    } else {
      console.log('       (web/dist belum dibangun — pemeriksaan header dilewati)');
    }
    // Dasbor sendiri tidak ikut terbuka.
    const dasbor = await fetch(`${s.base}/`);
    assert.equal(dasbor.status, 401);
    assert.equal(dasbor.headers.get('x-frame-options'), 'DENY');
    if (adaBuild) {
      const idx = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').match(/\/assets\/(index-[A-Za-z0-9_.-]+\.js)/)?.[1];
      if (idx) assert.equal((await fetch(`${s.base}/assets/${idx}`)).status, 401);
    }
  });

  await t('tanpa bot_token mini app tidak bisa dipakai', async () => {
    const s2 = await serve();
    s2.cfg.telegram.bot_token = null;
    const r = await (await auth(s2.base, initData())).json();
    assert.match(r.error, /belum disetel/);
    await s2.close();
  });

  await s.close();
  console.log(`\n${pass} lulus, ${fail} gagal\n`);
  process.exit(fail ? 1 : 0);
})();
