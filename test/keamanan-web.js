'use strict';
// Uji pengerasan keamanan server dasbor:
//  - cookie sesi hanya `Secure` di koneksi HTTPS (di balik proxy: X-Forwarded-Proto)
//  - halaman/dokumen membawa header anti-clickjacking + nosniff
//  - kesalahan tak terduga membalas pesan generik, bukan detail internal
//  - /login direm setelah tebakan token beruntun
//  - URL RPC yang mengarah ke link-local / metadata cloud ditolak (SSRF)
//
// Jalankan: node test/keamanan-web.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');
const { probeRpc } = require('../src/settings');

const TOKEN = 'rahasia-akses-uji';
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// Server nyata yang mendengar di port acak. `throws` menanam rute yang meledak
// supaya jalur penanganan galat 500 bisa diuji.
function serve({ throws = false } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: { auth_token: TOKEN }, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-sec-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const pos = { live: [], lastSync: 0, resync: async () => {} };
  const engine = {
    cfg, store, ethUsd: 2500, positions: pos, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true, paused: () => store.getState('paused', '0') === '1',
    // status() melempar pesan yang memuat "rahasia" -> harus tidak bocor ke klien.
    compound: throws ? { status: () => { throw new Error('detail internal /etc/rahasia'); }, configure: () => {} } : undefined,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ store, server, base: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

(async () => {
  console.log('keamanan web');

  await t('halaman masuk membawa header anti-clickjacking + nosniff', async () => {
    const s = await serve();
    try {
      const r = await fetch(`${s.base}/`, { redirect: 'manual' });
      assert.equal(r.status, 401, 'tanpa token -> halaman masuk');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    } finally { await s.close(); }
  });

  await t('CSRF: POST /api dari Origin lain atau Sec-Fetch-Site cross-site ditolak; asal sendiri & tanpa Origin lewat', async () => {
    const s = await serve();
    try {
      const hdr = (extra) => ({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...extra });
      const host = s.base.replace('http://', '');
      const bad = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ origin: 'https://jahat.example' }), body: '{"paused":true}' });
      assert.equal(bad.status, 403);
      const bad2 = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ 'sec-fetch-site': 'cross-site' }), body: '{"paused":true}' });
      assert.equal(bad2.status, 403);
      assert.equal(s.store.getState('paused', '0'), '0', 'tidak ada yang berubah');
      const ok = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), body: '{"paused":true}' });
      assert.equal(ok.status, 200);
      const ok2 = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({}), body: '{"paused":false}' });
      assert.equal(ok2.status, 200);
    } finally { await s.close(); }
  });

  await t('cookie sesi ditandai Secure saat X-Forwarded-Proto https', async () => {
    const s = await serve();
    try {
      const r = await fetch(`${s.base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-proto': 'https' },
        body: `token=${encodeURIComponent(TOKEN)}`,
      });
      assert.equal(r.status, 302);
      const c = r.headers.get('set-cookie') || '';
      assert.match(c, /lpcopy_token=/);
      assert.match(c, /;\s*Secure/i, 'harus Secure di HTTPS');
      assert.match(c, /HttpOnly/i);
    } finally { await s.close(); }
  });

  await t('cookie sesi TANPA Secure di koneksi HTTP polos', async () => {
    const s = await serve();
    try {
      const r = await fetch(`${s.base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(TOKEN)}`,
      });
      assert.equal(r.status, 302);
      const c = r.headers.get('set-cookie') || '';
      assert.doesNotMatch(c, /Secure/i, 'jangan tandai Secure di HTTP (nanti cookie tak pernah terkirim)');
    } finally { await s.close(); }
  });

  await t('kesalahan tak terduga -> pesan generik, detail tak bocor', async () => {
    const s = await serve({ throws: true });
    try {
      s.store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,quote_symbol)
        VALUES(1,'v4','9','0xpool','0xa','0xb',3000,-60,60,'1','open',0,100,'USDG')`);
      const r = await fetch(`${s.base}/api/positions/compound?id=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 500);
      const body = await r.json();
      assert.equal(body.error, 'kesalahan server');
      assert.doesNotMatch(JSON.stringify(body), /rahasia|etc/, 'detail internal tidak boleh sampai ke klien');
    } finally { await s.close(); }
  });

  await t('/login direm setelah 10 tebakan token gagal', async () => {
    const s = await serve();
    try {
      const attempt = (tok) => fetch(`${s.base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(tok)}`,
      });
      for (let i = 0; i < 10; i++) assert.equal((await attempt('salah')).status, 401, `tebakan ke-${i + 1} harus 401`);
      const blocked = await attempt('salah');
      assert.equal(blocked.status, 429, 'sesudah 10 gagal harus 429');
      assert.ok(blocked.headers.get('retry-after'), 'sertakan Retry-After');
    } finally { await s.close(); }
  });

  await t('URL RPC ke link-local/metadata cloud ditolak (SSRF)', async () => {
    const a = await probeRpc({ url: 'https://169.254.169.254/', headers: null });
    assert.equal(a.usable, false);
    assert.match(a.summary, /link-local/i);
    const b = await probeRpc({ url: 'https://metadata.google.internal/computeMetadata/v1/', headers: null });
    assert.equal(b.usable, false);
    assert.match(b.summary, /tidak diizinkan/i);
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
