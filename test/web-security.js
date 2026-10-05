'use strict';
// Dashboard server security hardening test:
//  - the session cookie is only `Secure` on HTTPS connections (behind a proxy: X-Forwarded-Proto)
//  - pages/documents carry anti-clickjacking headers + nosniff
//  - unexpected errors reply with a generic message, not internal details
//  - /login is throttled after consecutive token guesses
//  - RPC URLs pointing at link-local / cloud metadata are rejected (SSRF)
//
// Run: node test/web-security.js
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
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// A real server listening on a random port. `throws` plants a route that blows up
// so the 500 error-handling path can be tested.
function serve({ throws = false, wallet = null } = {}) {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: { auth_token: TOKEN }, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-sec-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const pos = { live: [], lastSync: 0, resync: async () => {} };
  const exec = wallet
    ? { address: () => wallet.address.toLowerCase(), balances: async () => new Map(), loadWallet: () => wallet }
    : { address: () => null, balances: async () => new Map() };
  const engine = {
    cfg, store, ethUsd: 2500, positions: pos, watcher: { unsupported: new Map() },
    exec, leftovers: () => [], dryRun: () => true, paused: () => store.getState('paused', '0') === '1',
    // status() throws a message containing a "secret" -> must not leak to the client.
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

  await t('the sign-in page carries anti-clickjacking headers + nosniff', async () => {
    const s = await serve();
    try {
      const r = await fetch(`${s.base}/`, { redirect: 'manual' });
      assert.equal(r.status, 401, 'without a token -> sign-in page');
      assert.equal(r.headers.get('x-frame-options'), 'DENY');
      assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    } finally { await s.close(); }
  });

  await t('CSRF: POST /api from another Origin or Sec-Fetch-Site cross-site is rejected; own origin & without Origin pass', async () => {
    const s = await serve();
    try {
      const hdr = (extra) => ({ 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...extra });
      const host = s.base.replace('http://', '');
      const bad = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ origin: 'https://jahat.example' }), body: '{"paused":true}' });
      assert.equal(bad.status, 403);
      const bad2 = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ 'sec-fetch-site': 'cross-site' }), body: '{"paused":true}' });
      assert.equal(bad2.status, 403);
      assert.equal(s.store.getState('paused', '0'), '0', 'nothing changed');
      const ok = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({ origin: `http://${host}`, 'sec-fetch-site': 'same-origin' }), body: '{"paused":true}' });
      assert.equal(ok.status, 200);
      const ok2 = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: hdr({}), body: '{"paused":false}' });
      assert.equal(ok2.status, 200);
    } finally { await s.close(); }
  });

  await t('the session cookie is marked Secure when X-Forwarded-Proto is https', async () => {
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
      assert.match(c, /;\s*Secure/i, 'must be Secure on HTTPS');
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
      assert.doesNotMatch(c, /Secure/i, 'do not mark Secure on HTTP (the cookie would never be sent)');
    } finally { await s.close(); }
  });

  await t('an unexpected error -> generic message, details do not leak', async () => {
    const s = await serve({ throws: true });
    try {
      s.store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,status,opened_ts,cost_quote,quote_symbol)
        VALUES(1,'v4','9','0xpool','0xa','0xb',3000,-60,60,'1','open',0,100,'USDG')`);
      const r = await fetch(`${s.base}/api/positions/compound?id=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
      assert.equal(r.status, 500);
      const body = await r.json();
      assert.equal(body.error, 'kesalahan server');
      assert.doesNotMatch(JSON.stringify(body), /rahasia|etc/, 'internal details must not reach the client');
    } finally { await s.close(); }
  });

  await t('/login is throttled after 10 failed token guesses', async () => {
    const s = await serve();
    try {
      const attempt = (tok) => fetch(`${s.base}/login`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(tok)}`,
      });
      for (let i = 0; i < 10; i++) assert.equal((await attempt('salah')).status, 401, `guess number ${i + 1} must be 401`);
      const blocked = await attempt('salah');
      assert.equal(blocked.status, 429, 'after 10 failures it must be 429');
      assert.ok(blocked.headers.get('retry-after'), 'sertakan Retry-After');
    } finally { await s.close(); }
  });

  await t('/api/settings/wallet/export: a wrong token is rejected, a weak password is rejected, right token+password -> a valid V3 keystore', async () => {
    const { ethers } = require('ethers');
    const wallet = ethers.Wallet.createRandom();
    const s = await serve({ wallet });
    try {
      const hdr = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };
      const post = (b) => fetch(`${s.base}/api/settings/wallet/export`, { method: 'POST', headers: hdr, body: JSON.stringify(b) });
      const bad = await post({ token: 'salah', password: 'password123' });
      assert.equal((await bad.json()).error, 'Token salah.');
      const weak = await post({ token: TOKEN, password: '123' });
      assert.match((await weak.json()).error, /minimal 8/);
      const ok = await post({ token: TOKEN, password: 'password123' });
      const body = await ok.json();
      assert.equal(body.ok, true);
      assert.equal(body.address, wallet.address.toLowerCase());
      assert.equal(JSON.stringify(body.keystore).toLowerCase().includes(wallet.privateKey.slice(2).toLowerCase()), false, 'the raw private key must not sit in the keystore');
      const decrypted = await ethers.Wallet.fromEncryptedJson(JSON.stringify(body.keystore), 'password123');
      assert.equal(decrypted.address, wallet.address);
    } finally { await s.close(); }
  });

  await t('an RPC URL to link-local/cloud metadata is rejected (SSRF)', async () => {
    const a = await probeRpc({ url: 'https://169.254.169.254/', headers: null });
    assert.equal(a.usable, false);
    assert.match(a.summary, /link-local/i);
    const b = await probeRpc({ url: 'https://metadata.google.internal/computeMetadata/v1/', headers: null });
    assert.equal(b.usable, false);
    assert.match(b.summary, /tidak diizinkan/i);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
