'use strict';
// Test the Telegram mini app:
//  - initData signature: a valid one passes, one that was altered/signed by another token/stale is rejected
//  - /api/tg/auth only serves chats in telegram.chat_ids
//  - the ticket it returns opens /api/* as a Bearer; an arbitrary ticket is rejected
//  - the /mini page and its chunks pass the token gate, the dashboard stays locked
//  - the mini page may be framed by Telegram (frame-ancestors), other pages may not
//
// Run: node test/mini-app.js
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
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// initData as Telegram sends it: the fields as they are + their HMAC hash.
// `signature`: 'included' = as Telegram does since Bot API 8.0 (counted in the hash),
// 'external' = the convention of some libraries (sent but not counted), null = an old client.
function initData({ id = CHAT, botToken = BOT, authDate = Math.floor(Date.now() / 1000), signature = 'ikut', extra = {} } = {}) {
  const q = new URLSearchParams({
    user: JSON.stringify({ id, first_name: 'Uji', username: 'uji' }),
    auth_date: String(authDate),
    query_id: 'AAE',
    ...(signature ? { signature: 'x9_tanda-tangan-ed25519' } : {}),
    ...extra,
  });
  const follow = [...q.entries()].filter(([k]) => signature === 'ikut' || k !== 'signature');
  const data = follow.map(([k, v]) => `${k}=${v}`).sort().join('\n');
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

  await t('valid initData is recognised, an altered hash is rejected', () => {
    const d = initData();
    assert.equal(checkInitData(d, BOT).user.id, CHAT);
    const rusak = d.replace(/hash=([0-9a-f])/, (m, c) => `hash=${c === 'a' ? 'b' : 'a'}`);
    assert.match(checkInitData(rusak, BOT).error, /tanda tangan/);
    // The contents are altered without recomputing the hash (another name, another person).
    const q = new URLSearchParams(d);
    q.set('user', JSON.stringify({ id: 999, first_name: 'Lain' }));
    assert.match(checkInitData(q.toString(), BOT).error, /tanda tangan/);
  });

  await t('initData signed by another bot is rejected', () => {
    const r = checkInitData(initData({ botToken: '999:bot-lain' }), BOT);
    assert.match(r.error, /tanda tangan/);
  });

  await t('stale initData is rejected, one still within the window is accepted', () => {
    const tua = initData({ authDate: Math.floor(Date.now() / 1000) - 2 * 86400 });
    assert.match(checkInitData(tua, BOT).error, /kedaluwarsa/);
    const yesterday = initData({ authDate: Math.floor(Date.now() / 1000) - 3600 });
    assert.equal(checkInitData(yesterday, BOT).user.id, CHAT);
  });

  await t('signature: counted (Telegram) or not, both are accepted', () => {
    // Bot API 8.0 added `signature`, and Telegram COUNTS IT in the hash.
    // Leaving it out made every new client get rejected — exactly this mini app's
    // first failure in the field.
    const baku = checkInitData(initData({ signature: 'ikut' }), BOT);
    assert.equal(baku.user.id, CHAT);
    assert.equal(baku.look, 'baku');
    // The old convention of some libraries: sent but not counted.
    const lain = checkInitData(initData({ signature: 'luar' }), BOT);
    assert.equal(lain.user.id, CHAT);
    assert.equal(lain.look, 'tanpa signature');
    // An old client does not send it at all.
    assert.equal(checkInitData(initData({ signature: null }), BOT).user.id, CHAT);
    // What must still be rejected: another field altered after signing.
    const q = new URLSearchParams(initData({ signature: 'ikut' }));
    q.set('query_id', 'BBB');
    assert.match(checkInitData(q.toString(), BOT).error, /tanda tangan/);
  });

  const s = await serve();

  await t('a chat that is not yet connected is not served', async () => {
    const r = await (await auth(s.base, initData({ id: 777 }))).json();
    assert.match(r.error, /belum tersambung/i);
    assert.ok(!r.token);
  });

  await t('fake initData produces no ticket', async () => {
    const r = await (await auth(s.base, initData({ botToken: 'bot-lain' }))).json();
    assert.ok(r.error);
    assert.ok(!r.token);
  });

  let ticket = null;
  await t('chat tersambung mendapat tiket + cookie sesi', async () => {
    const res = await auth(s.base, initData());
    const r = await res.json();
    assert.equal(r.ok, true);
    assert.equal(r.user.id, CHAT);
    assert.match(r.token, /^[0-9a-f]{64}$/);
    assert.match(String(res.headers.get('set-cookie')), /lpcopy_token=/);
    ticket = r.token;
  });

  await t('a ticket opens /api, a made-up ticket does not', async () => {
    const ok = await fetch(`${s.base}/api/logs`, { headers: { authorization: `Bearer ${ticket}` } });
    assert.equal(ok.status, 200);
    const no = await fetch(`${s.base}/api/logs`, { headers: { authorization: `Bearer ${'0'.repeat(64)}` } });
    assert.equal(no.status, 401);
    const polos = await fetch(`${s.base}/api/logs`);
    assert.equal(polos.status, 401);
  });

  await t('token icon: a ticket in the query only opens the image route', async () => {
    const addr = '0x' + 'ab'.repeat(20);
    // <img> cannot carry headers, so the ticket may ride in the query — for this route only.
    assert.notEqual((await fetch(`${s.base}/api/icon?a=${addr}&t=${ticket}`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/icon?a=${addr}`)).status, 401);
    assert.equal((await fetch(`${s.base}/api/icon?a=${addr}&t=${'0'.repeat(64)}`)).status, 401);
    // A ticket in the query does NOT open other routes — if it did, one leaked URL = the whole dashboard.
    assert.equal((await fetch(`${s.base}/api/logs?t=${ticket}`)).status, 401);
    assert.equal((await fetch(`${s.base}/?t=${ticket}`)).status, 401);
  });

  await t('mini page passes the gate, the dashboard stays locked', async () => {
    const dist = path.join(__dirname, '..', 'web', 'dist');
    const hasBuild = fs.existsSync(path.join(dist, 'mini.html'));
    const r = await fetch(`${s.base}/mini`);
    // 401 = the gate closed it — that must not happen, with or without a build.
    assert.notEqual(r.status, 401);
    if (hasBuild) {
      assert.equal(r.status, 200);
      const csp = r.headers.get('content-security-policy') || '';
      assert.match(csp, /frame-ancestors[^;]*telegram\.org/);
      assert.equal(r.headers.get('x-frame-options'), null);   // DENY overrides the permissions above
      const label = (await r.text()).match(/\/assets\/(mini-[A-Za-z0-9_.-]+\.js)/)?.[1];
      assert.ok(label, 'mini.html must reference the mini-*.js chunks');
      assert.equal((await fetch(`${s.base}/assets/${label}`)).status, 200);
    } else {
      console.log('       (web/dist has not been built — header check skipped)');
    }
    // The dashboard itself does not open up.
    const dasbor = await fetch(`${s.base}/`);
    assert.equal(dasbor.status, 401);
    assert.equal(dasbor.headers.get('x-frame-options'), 'DENY');
    if (hasBuild) {
      const idx = fs.readFileSync(path.join(dist, 'index.html'), 'utf8').match(/\/assets\/(index-[A-Za-z0-9_.-]+\.js)/)?.[1];
      if (idx) assert.equal((await fetch(`${s.base}/assets/${idx}`)).status, 401);
    }
  });

  await t('without bot_token the mini app cannot be used', async () => {
    const s2 = await serve();
    s2.cfg.telegram.bot_token = null;
    const r = await (await auth(s2.base, initData())).json();
    assert.match(r.error, /belum disetel/);
    await s2.close();
  });

  await s.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
