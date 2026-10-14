'use strict';
// Sign-in and sign-up pages: the first account needs the server token, later ones an invite code
// (prefilled from the link), errors land on the right field, and the sign-in form switches from
// the access token to username + password once accounts exist.
//
// Run: node test/auth-pages.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { Auth } = require('../src/auth');
const { createServer } = require('../src/server');

const TOKEN = 'server-token-uji';
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

function serve() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-authpg-'));
  const store = new Store(path.join(dir, 'main.db'));
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: { auth_token: TOKEN }, notify: {}, wallet: {} };
  const cfgPath = path.join(dir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = { cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0, resync: async () => {} }, watcher: { unsupported: new Map() }, exec: { address: () => null }, leftovers: () => [], dryRun: () => true, paused: () => false };
  const started = [];
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null,
    tenantControl: { canAdd: () => true, start: (id) => started.push(id), has: () => true, max: () => 20, ownerOfChat: () => null } });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    store, auth: new Auth(store), started, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
  })));
}
const form = (base, p, fields) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

(async () => {
  console.log('auth pages');
  const s = await serve();
  try {
    await t('before any account: token sign-in, and sign-up asks for the server token', async () => {
      const login = await (await fetch(`${s.base}/`)).text();
      assert.match(login, /name="token"/);
      assert.doesNotMatch(login, /name="username"/);
      assert.match(login, /Buat akun superadmin/);
      const reg = await (await fetch(`${s.base}/register?code=deadbeef`)).text();
      assert.match(reg, /Token akses server/);
      assert.doesNotMatch(reg, /deadbeef/, 'an invite code is meaningless for the first account');
    });

    await t('mismatched passwords and a wrong server token are reported on their field, the username is kept', async () => {
      let r = await form(s.base, '/register', { username: 'Root', password: 'password1', password2: 'password2', invite: TOKEN });
      assert.equal(r.status, 400);
      let html = await r.text();
      assert.match(html, /id="password2"[^>]*aria-invalid="true"/);
      assert.match(html, /Kata sandi tidak sama/);
      assert.match(html, /value="root"/);
      r = await form(s.base, '/register', { username: 'root', password: 'password1', password2: 'password1', invite: 'wrong' });
      html = await r.text();
      assert.equal(r.status, 401);
      assert.match(html, /id="invite"[^>]*aria-invalid="true"/);
      assert.doesNotMatch(html, /value="wrong"/, 'the server token is never echoed back');
      assert.equal(s.auth.userCount(), 0);
    });

    await t('the first account becomes superadmin and is signed in', async () => {
      const r = await form(s.base, '/register', { username: 'root', password: 'password1', password2: 'password1', invite: TOKEN });
      assert.equal(r.status, 302);
      assert.match(r.headers.get('set-cookie'), /lpcopy_session=[0-9a-f]{64}/);
      assert.equal(s.auth.userById(1).role, 'superadmin');
      assert.deepEqual(s.started, [], 'the superadmin has no tenant to start');
    });

    await t('later sign-ups need an invite; the link prefills it and a bad one is flagged on its field', async () => {
      const code = s.auth.createInvite(1);
      const page = await (await fetch(`${s.base}/register?code=${code}`)).text();
      assert.match(page, /Kode undangan/);
      assert.match(page, new RegExp(`value="${code}"`));
      const bad = await form(s.base, '/register', { username: 'budi', password: 'password1', password2: 'password1', invite: 'ffff' });
      const html = await bad.text();
      assert.match(html, /id="invite"[^>]*aria-invalid="true"/);
      assert.match(html, /Kode undangan tidak berlaku/);
      const taken = await form(s.base, '/register', { username: 'root', password: 'password1', password2: 'password1', invite: code });
      assert.match(await taken.text(), /sudah dipakai\. Pilih yang lain/);
      const ok = await form(s.base, '/register', { username: 'budi', password: 'password1', password2: 'password1', invite: code });
      assert.equal(ok.status, 302);
      assert.deepEqual(s.started, [2], "the new account's engines are started");
    });

    await t('with accounts: username + password sign-in, token kept as an alternative', async () => {
      const login = await (await fetch(`${s.base}/`)).text();
      assert.match(login, /name="username"/);
      assert.match(login, /name="password"/);
      assert.match(login, /Masuk dengan token akses server/);
      const bad = await form(s.base, '/login', { username: 'budi', password: 'nope' });
      const html = await bad.text();
      assert.equal(bad.status, 401);
      assert.match(html, /Nama pengguna atau kata sandi salah/);
      assert.match(html, /value="budi"/);
      const ok = await form(s.base, '/login', { username: 'budi', password: 'password1' });
      assert.equal(ok.status, 302);
      const tok = await form(s.base, '/login', { token: TOKEN });
      assert.equal(tok.status, 302);
      const badTok = await form(s.base, '/login', { token: 'x' });
      assert.match(await badTok.text(), /<details class="alt" open>/, 'a wrong token reopens the token section');
    });
  } finally { await s.close(); }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
