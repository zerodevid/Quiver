'use strict';
// Multi-user tenants: the per-user config view, encrypted key files, the env-key guard,
// and the HTTP isolation between an account's server and everyone else.
//
// Run: node test/tenants.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Auth } = require('../src/auth');
const { createServer } = require('../src/server');
const { Executor } = require('../src/executor');
const { chainView } = require('../src/multichain');
const { writeCfg } = require('../src/env');
const { loadUserCfg, userCfgView, ReadOnlyError } = require('../src/tenants');
const keyfile = require('../src/keyfile');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-tenant-'));
const MASTER = 'm'.repeat(40);

function globalCfg() {
  return {
    server: { auth_token: 'admin-token', port: 1 },
    telegram: { bot_token: 'secret-bot', chat_ids: [1] },
    aggregators: { okx: { api_key: 'k' } },
    wallet: { key_file: '~/.lpcopy/key' },
    chains: {
      robinhood: {
        enabled: true, chain: { endpoints: [{ url: 'https://rpc.example/KEY' }] },
        targets: [{ address: '0x' + '1'.repeat(40) }], rules: { sizing: { pct: 5 } }, mode: { dry_run: false, sim_balance_usd: 500 },
        gas: { price_multiplier: 1.5 }, prices: {}, loop: { poll_ms: 1500 }, scout: {}, risk: {}, swap: {},
      },
      bsc: { enabled: false, chain: { endpoints: [] }, targets: [], rules: {}, mode: {}, gas: {}, prices: {}, loop: {}, scout: {}, risk: {}, swap: {} },
    },
  };
}
function view(dir = tmp()) {
  const g = globalCfg();
  const u = loadUserCfg(path.join(dir, 'config.json'), g, dir);
  return { g, dir, v: userCfgView(g, u, { dbPath: path.join(dir, 'lpcopy.db') }) };
}

(async () => {
  console.log('tenants');

  await t('a new account starts in simulation with no targets, but inherits the tuning', async () => {
    const { v } = view();
    const rh = chainView(v, 'robinhood');
    assert.deepEqual(rh.targets, []);
    assert.equal(rh.mode.dry_run, true);
    assert.equal(rh.mode.sim_balance_usd, 500);
    assert.deepEqual(rh.rules, { sizing: { pct: 5 } });
    assert.equal(rh.gas.price_multiplier, 1.5);
  });

  await t('user fields write to the user file, shared fields are read-only', async () => {
    const { g, v } = view();
    const rh = chainView(v, 'robinhood');
    rh.rules = { sizing: { pct: 9 } };
    rh.mode.paused = true;
    assert.equal(g.chains.robinhood.rules.sizing.pct, 5, 'the global rules are untouched');
    assert.equal(rh.chain.endpoints[0].url, 'https://rpc.example/KEY', 'RPC comes from the global config');
    assert.equal(rh.loop.poll_ms, 1500);
    assert.throws(() => { rh.chain = { endpoints: [] }; }, ReadOnlyError);
    assert.throws(() => { rh.loop = {}; }, ReadOnlyError);
    assert.throws(() => { v.server = {}; }, ReadOnlyError);
    v.telegram = { bot_token: '999:evil', chat_ids: [7] };   // only the account's own fields are kept
    assert.equal(v.telegram.bot_token, undefined);
    assert.deepEqual(v.telegram.chat_ids, ['7']);
    assert.equal(g.telegram.bot_token, 'secret-bot');
    assert.throws(() => { v.chains.robinhood = {}; }, ReadOnlyError);
    v.display = { hide_values: true };
    assert.equal(g.display, undefined);
  });

  await t('writeCfg saves only the user part — no global secrets reach the user file', async () => {
    const { dir, v } = view();
    chainView(v, 'robinhood').targets = [{ address: '0x' + '2'.repeat(40) }];
    const file = path.join(dir, 'config.json');
    writeCfg(file, v);
    const raw = fs.readFileSync(file, 'utf8');
    for (const secret of ['admin-token', 'secret-bot', 'rpc.example', 'okx', 'poll_ms']) assert.ok(!raw.includes(secret), `${secret} leaked`);
    const back = JSON.parse(raw);
    assert.equal(back.chains.robinhood.targets[0].address, '0x' + '2'.repeat(40));
    assert.equal(back.wallet.from_env, false);
    // reload keeps the edit
    const again = loadUserCfg(file, globalCfg(), dir);
    assert.equal(again.chains.robinhood.targets.length, 1);
  });

  await t('the key file paths cannot be pointed elsewhere by the user file', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ wallet: { key_file: '~/.lpcopy/key', from_env: true, encrypted: false } }));
    const u = loadUserCfg(path.join(dir, 'config.json'), globalCfg(), dir);
    assert.equal(u.wallet.key_file, path.join(dir, 'key'));
    assert.equal(u.wallet.from_env, false);
    assert.equal(u.wallet.encrypted, true);
  });

  await t('encrypted key files: round trip, wrong master key, plain passthrough, loose permissions', async () => {
    const dir = tmp();
    const p = path.join(dir, 'key');
    process.env.LPCOPY_MASTER_KEY = MASTER;
    keyfile.writeSecret(p, '0xabc', { encrypt: true });
    assert.ok(keyfile.isEncrypted(fs.readFileSync(p, 'utf8')));
    assert.ok(!fs.readFileSync(p, 'utf8').includes('abc'));
    assert.equal(keyfile.readSecret(p), '0xabc');
    process.env.LPCOPY_MASTER_KEY = 'x'.repeat(40);
    assert.throws(() => keyfile.readSecret(p), /LPCOPY_MASTER_KEY berbeda/);
    delete process.env.LPCOPY_MASTER_KEY;
    assert.throws(() => keyfile.readSecret(p), /tidak ada/);
    assert.throws(() => keyfile.writeSecret(p, 'x', { encrypt: true }), /belum diisi/);
    keyfile.writeSecret(p, 'plain-key');
    assert.equal(keyfile.readSecret(p), 'plain-key');
    fs.chmodSync(p, 0o644);
    assert.throws(() => keyfile.readSecret(p), /terlalu longgar/);
  });

  await t("an account's executor never uses the superadmin's LPCOPY_PRIVATE_KEY", async () => {
    const admin = ethers.Wallet.createRandom();
    const mine = ethers.Wallet.createRandom();
    process.env.LPCOPY_PRIVATE_KEY = admin.privateKey;
    process.env.LPCOPY_MASTER_KEY = MASTER;
    try {
      const { dir, v } = view();
      const ex = new Executor({ rpc: {}, store: new Store(':memory:'), chain: null, cfg: chainView(v, 'robinhood'), log: () => {} });
      assert.equal(ex.address(), null, 'no key file yet -> no wallet, NOT the env key');
      keyfile.writeSecret(path.join(dir, 'key'), mine.privateKey, { encrypt: true });
      ex.resetWallet();
      assert.equal(ex.address(), mine.address.toLowerCase());
      // the legacy (superadmin) config still prefers the env key
      const legacy = new Executor({ rpc: {}, store: new Store(':memory:'), chain: null, cfg: chainView(globalCfg(), 'robinhood'), log: () => {} });
      assert.equal(legacy.address(), admin.address.toLowerCase());
    } finally { delete process.env.LPCOPY_PRIVATE_KEY; delete process.env.LPCOPY_MASTER_KEY; }
  });

  // ---- HTTP isolation ----
  const authStore = new Store(':memory:');
  const auth = new Auth(authStore);
  const root = await auth.register({ username: 'root', password: 'password1' });
  const alice = await auth.register({ username: 'alice', password: 'password1', invite: auth.createInvite(root.id) });
  const bob = await auth.register({ username: 'bob', password: 'password1', invite: auth.createInvite(root.id) });
  const cookie = (u) => `lpcopy_session=${auth.createSession(u.id)}`;

  function serveTenant(userId, { telegram = null, restart = null } = {}) {
    const { dir, v } = view();
    const cfg = chainView(v, 'robinhood');
    writeCfg(path.join(dir, 'config.json'), v);              // index.js buildTenant always writes it
    const store = new Store(path.join(dir, 'lpcopy.db'));
    const exec = { address: () => null, balances: async () => new Map(), keyPath: () => path.join(dir, 'key'), resetWallet: () => {} };
    const engine = {
      cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0, resync: async () => {} }, watcher: { unsupported: new Map() },
      exec, leftovers: () => [], dryRun: () => true, paused: () => store.getState('paused', '0') === '1', drawdownStatus: () => ({}),
      freshCash: async () => null,
    };
    const server = createServer({
      engine, store, authStore, cfg, cfgPath: path.join(dir, 'config.json'), chain: {}, rpc: {}, log: () => {}, telegram,
      tenant: { userId }, tenantControl: null, restart,
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
      store, dbPath: path.join(dir, 'lpcopy.db'), cfgPath: path.join(dir, 'config.json'), base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)),
    })));
  }

  await t("an account's server answers only that account", async () => {
    const s = await serveTenant(alice.id);
    try {
      const me = await fetch(`${s.base}/api/auth/me`, { headers: { cookie: cookie(alice) } });
      assert.equal(me.status, 200);
      assert.equal((await me.json()).user.username, 'alice');
      const other = await fetch(`${s.base}/api/auth/me`, { headers: { cookie: cookie(bob) } });
      assert.equal(other.status, 403, 'bob is refused on alice\'s server');
      const token = await fetch(`${s.base}/api/auth/me`, { headers: { authorization: 'Bearer admin-token' } });
      assert.equal(token.status, 403, 'the admin token does not open an account\'s server either');
      const anon = await fetch(`${s.base}/api/auth/me`);
      assert.equal(anon.status, 401);
    } finally { await s.close(); }
  });

  await t('shared-infrastructure routes are refused for an account', async () => {
    const s = await serveTenant(alice.id);
    try {
      for (const route of ['/api/settings/rpc', '/api/settings/token/rotate', '/api/settings/chains', '/api/settings/loop', '/api/settings/aggregators']) {
        const r = await fetch(`${s.base}${route}`, { method: 'POST', headers: { cookie: cookie(alice), 'content-type': 'application/json' }, body: '{}' });
        assert.equal(r.status, 403, route);
      }
      const users = await fetch(`${s.base}/api/auth/users`, { headers: { cookie: cookie(alice) } });
      assert.match((await users.json()).error, /superadmin/);
    } finally { await s.close(); }
  });

  await t('an account can change its own simulation mode in its own database', async () => {
    const s = await serveTenant(alice.id);
    try {
      const r = await fetch(`${s.base}/api/mode`, { method: 'POST', headers: { cookie: cookie(alice), 'content-type': 'application/json' }, body: '{"paused":true}' });
      assert.equal(r.status, 200);
      assert.equal(s.store.getState('paused', '0'), '1');
    } finally { await s.close(); }
  });

  await t("an account's Telegram settings cannot set the bot token", async () => {
    const s = await serveTenant(alice.id, { telegram: { hub: {}, token: () => 'hub-token', chats: () => [] } });
    try {
      const r = await fetch(`${s.base}/api/settings/telegram`, { method: 'POST', headers: { cookie: cookie(alice), 'content-type': 'application/json' }, body: '{"bot_token":"123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAA"}' });
      assert.match((await r.json()).error, /superadmin/);
    } finally { await s.close(); }
  });

  await t("the mini app of a chat linked to an account opens that account, not the superadmin", async () => {
    const crypto = require('node:crypto');
    const BOT = '123456:' + 'B'.repeat(30);
    const sign = (user) => {
      const q = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify(user) });
      const data = [...q.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
      const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
      q.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
      return q.toString();
    };
    // the superadmin's server (tenant: null) is where /api/tg/auth lands
    const dir = tmp();
    const store = new Store(path.join(dir, 'main.db'));
    const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: { auth_token: 'admin-token' }, notify: {}, wallet: {}, telegram: { bot_token: BOT, chat_ids: ['100'] } };
    const engine = { cfg, store, ethUsd: 2500, positions: { live: [], lastSync: 0, resync: async () => {} }, watcher: { unsupported: new Map() }, exec: { address: () => null }, leftovers: () => [], dryRun: () => true, paused: () => false };
    const server = createServer({ engine, store, authStore, cfg, cfgPath: path.join(dir, 'c.json'), chain: {}, rpc: {}, log: () => {}, telegram: null,
      tenantControl: { ownerOfChat: (id) => (id === '42' ? alice.id : null), canAdd: () => true, has: () => true, max: () => 20 } });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const post = (initData) => fetch(`${base}/api/tg/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ initData }) }).then((r) => r.json());
      const r = await post(sign({ id: 42, username: 'al' }));
      assert.equal(r.ok, true);
      assert.match(r.token, /^[0-9a-f]{64}$/);
      assert.equal(auth.userBySession(r.token).id, alice.id, 'the ticket is a session of alice');
      const s = await serveTenant(alice.id);
      try {
        const me = await fetch(`${s.base}/api/auth/me`, { headers: { authorization: `Bearer ${r.token}` } }).then((x) => x.json());
        assert.equal(me.user.username, 'alice');
      } finally { await s.close(); }
      const stranger = await post(sign({ id: 77 }));
      assert.ok(stranger.error, 'an unlinked chat is refused');
    } finally { await new Promise((r) => server.close(r)); }
  });

  await t('the audit log records sign-ins and sensitive actions, never for an account to read', async () => {
    const s = await serveTenant(alice.id);
    try {
      const before = authStore.get('SELECT MAX(id) m FROM audit').m || 0;
      const bad = await fetch(`${s.base}/login`, { method: 'POST', redirect: 'manual', body: 'username=alice&token=wrong', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(bad.status, 401);
      const good = await fetch(`${s.base}/login`, { method: 'POST', redirect: 'manual', body: 'username=alice&token=password1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      assert.equal(good.status, 302);
      await fetch(`${s.base}/api/mode`, { method: 'POST', headers: { cookie: cookie(alice), 'content-type': 'application/json' }, body: '{"paused":false}' });
      const rows = authStore.all('SELECT * FROM audit WHERE id > ? ORDER BY id', before);
      assert.deepEqual(rows.map((r) => [r.action, r.ok, r.username]), [['login', 0, 'alice'], ['login', 1, 'alice'], ['api/mode', 1, 'alice']]);
      assert.ok(rows.every((r) => !String(r.detail || '').includes('password1')), 'no secrets in the log');
      const mine = await fetch(`${s.base}/api/auth/audit`, { headers: { cookie: cookie(alice) } }).then((r) => r.json());
      assert.match(mine.error, /superadmin/);
    } finally { await s.close(); }
  });

  await t('an account backs up and restores its own data with its password, restarting only itself', async () => {
    let restarted = 0;
    const s = await serveTenant(alice.id, { restart: () => { restarted++; } });
    try {
      const hdr = { cookie: cookie(alice), 'content-type': 'application/json' };
      s.store.setState('marker', 'before');
      const wrong = await fetch(`${s.base}/api/settings/backup`, { method: 'POST', headers: hdr, body: JSON.stringify({ token: 'nope', parts: { config: true, db: true } }) }).then((r) => r.json());
      assert.match(wrong.error, /Kata sandi salah/);
      const made = await fetch(`${s.base}/api/settings/backup`, { method: 'POST', headers: hdr, body: JSON.stringify({ token: 'password1', parts: { config: true, db: true } }) }).then((r) => r.json());
      assert.equal(made.ok, true, made.error);
      assert.ok(!JSON.stringify(made.backup.parts.config.json).includes('admin-token'), 'the account backup holds no global secrets');
      const back = await fetch(`${s.base}/api/settings/restore`, { method: 'POST', headers: hdr, body: JSON.stringify({ token: 'password1', parts: { config: true, db: true }, backup: made.backup }) }).then((r) => r.json());
      assert.equal(back.ok, true, back.error);
      assert.deepEqual(back.staged.sort(), ['config', 'db']);
      assert.ok(fs.existsSync(s.dbPath + '.pending-restore') || fs.readdirSync(path.dirname(s.dbPath)).some((f) => f.includes('pending')), 'staged next to the account database');
      await new Promise((r) => setTimeout(r, 1700));
      assert.equal(restarted, 1, 'the account restart hook ran (not process.kill)');
    } finally { await s.close(); }
  });

  await t('the account file keeps only account fields, whatever a restored file brings', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
      server: { auth_token: 'leak' }, aggregators: { okx: { api_key: 'leak' } }, telegram: { bot_token: 'leak', chat_ids: ['9'] },
      chains: { robinhood: { chain: { endpoints: [{ url: 'https://leak' }] }, loop: { poll_ms: 1 }, rules: { sizing: { pct: 3 } } }, nowhere: { rules: {} } },
    }));
    const u = loadUserCfg(path.join(dir, 'config.json'), globalCfg(), dir);
    assert.ok(!JSON.stringify(u).includes('leak'));
    assert.deepEqual(u.telegram.chat_ids, ['9']);
    assert.equal(u.chains.robinhood.rules.sizing.pct, 3);
    assert.equal(u.chains.nowhere, undefined);
  });

  await t('restoring a config made while LIVE comes back in simulation on every chain', async () => {
    const { mergeConfig } = require('../src/backup');
    const out = mergeConfig({ chains: { robinhood: { mode: { dry_run: false } }, bsc: { mode: { dry_run: false, paused: true } } } }, {});
    assert.equal(out.chains.robinhood.mode.dry_run, true);
    assert.deepEqual(out.chains.bsc.mode, { dry_run: true, paused: true });
  });

  await t('an account cannot claim a Telegram chat by typing its id, only drop its own', async () => {
    const tg = { hub: {}, token: () => 'hub-token', chats: () => [] };
    const s = await serveTenant(alice.id, { telegram: tg });
    try {
      const hdr = { cookie: cookie(alice), 'content-type': 'application/json' };
      const r = await fetch(`${s.base}/api/settings/telegram`, { method: 'POST', headers: hdr, body: '{"chat_ids":["555"]}' }).then((x) => x.json());
      assert.match(r.error, /kode sambung/);
      assert.deepEqual(JSON.parse(fs.readFileSync(s.cfgPath, 'utf8')).telegram.chat_ids, []);
    } finally { await s.close(); }
  });

  await t("an account's wallet location and env lock cannot be changed, even in memory", async () => {
    const { dir, v } = view();
    v.wallet = { key_file: '/home/admin/.lpcopy/key', from_env: true, encrypted: false, note: 'kept' };
    assert.equal(v.wallet.key_file, path.join(dir, 'key'));
    assert.equal(v.wallet.from_env, false);
    assert.equal(v.wallet.encrypted, true);
    assert.equal(v.wallet.note, 'kept');
    assert.throws(() => { 'use strict'; v.wallet.key_file = '/etc/x'; }, TypeError);
    assert.equal(chainView(v, 'robinhood').wallet.key_file, path.join(dir, 'key'));
  });

  await t('an account has a bounded number of targets', async () => {
    const s = await serveTenant(alice.id);
    try {
      const hdr = { cookie: cookie(alice), 'content-type': 'application/json' };
      for (let i = 0; i < 25; i++) s.store.run('INSERT INTO targets(chain,address,enabled,added_ts) VALUES(?,?,1,?)', 'robinhood', '0x' + String(i).padStart(40, '0'), Date.now());
      const r = await fetch(`${s.base}/api/targets`, { method: 'POST', headers: hdr, body: JSON.stringify({ address: '0x' + 'a'.repeat(40) }) }).then((x) => x.json());
      assert.match(r.error, /Batas 25 target/);
    } finally { await s.close(); }
  });

  await t('sign-in, sign-up and sign-out refuse cross-site form posts', async () => {
    const s = await serveTenant(alice.id);
    try {
      for (const p of ['/login', '/register', '/logout']) {
        const r = await fetch(`${s.base}${p}`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.example' }, body: 'username=alice&password=password1' });
        assert.equal(r.status, 403, p);
      }
    } finally { await s.close(); }
  });

  await t('password change through the API: wrong current password refused, other sessions end', async () => {
    const s = await serveTenant(bob.id);
    try {
      const mine = auth.createSession(bob.id);
      const other = auth.createSession(bob.id);
      const hdr = { cookie: `lpcopy_session=${mine}`, 'content-type': 'application/json' };
      const bad = await fetch(`${s.base}/api/auth/password`, { method: 'POST', headers: hdr, body: '{"current":"nope","next":"newpassword1"}' }).then((x) => x.json());
      assert.match(bad.error, /saat ini salah/);
      const ok = await fetch(`${s.base}/api/auth/password`, { method: 'POST', headers: hdr, body: '{"current":"password1","next":"newpassword1"}' }).then((x) => x.json());
      assert.equal(ok.ok, true);
      assert.ok(auth.userBySession(mine));
      assert.equal(auth.userBySession(other), null);
      const reset = await fetch(`${s.base}/api/auth/users/reset`, { method: 'POST', headers: hdr, body: JSON.stringify({ id: alice.id }) }).then((x) => x.json());
      assert.match(reset.error, /superadmin/, 'only the superadmin resets passwords');
    } finally { await s.close(); }
  });

  await t('platform fees: superadmin reads/writes the schedule, an account cannot', async () => {
    const { dir, v } = view();
    const cfg = chainView(globalCfg(), 'robinhood');
    const cfgPath = path.join(dir, 'config.json');
    writeCfg(cfgPath, globalCfg());
    const engine = {
      cfg, store: new Store(':memory:'), ethUsd: 2500, positions: { live: [], lastSync: 0, resync: async () => {} },
      watcher: { unsupported: new Map() }, exec: { address: () => null, balances: async () => new Map() },
      leftovers: () => [], dryRun: () => true, paused: () => false, drawdownStatus: () => ({}), freshCash: async () => null,
    };
    const adminServer = createServer({
      engine, store: engine.store, authStore, cfg, cfgPath, chain: {}, rpc: {}, log: () => {},
      tenant: null, tenantControl: { feeTotals: () => ({ paidUsd: 1.5, paidCount: 10, debtUsd: 0, debtCount: 0, accounts: 2 }) },
    });
    await new Promise((r) => adminServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${adminServer.address().port}`;
    try {
      const got = await (await fetch(`${base}/api/admin/fees`, { headers: { cookie: cookie(root) } })).json();
      assert.equal(got.schedule.open, 0.20, 'default open fee');
      assert.equal(got.revenue.paidCount, 10, 'revenue summary flows through');
      const save = await fetch(`${base}/api/admin/fees`, {
        method: 'POST', headers: { cookie: cookie(root), 'content-type': 'application/json' },
        body: JSON.stringify({ schedule: { open: 0.25 }, treasury: { robinhood: { address: '0x' + 'a'.repeat(40) } } }),
      });
      assert.equal(save.status, 200);
      const after = await (await fetch(`${base}/api/admin/fees`, { headers: { cookie: cookie(root) } })).json();
      assert.equal(after.schedule.open, 0.25, 'the new fee persisted');
      assert.equal(after.treasury.robinhood.address.toLowerCase(), '0x' + 'a'.repeat(40));
      const bad = await fetch(`${base}/api/admin/fees`, {
        method: 'POST', headers: { cookie: cookie(root), 'content-type': 'application/json' },
        body: JSON.stringify({ treasury: { robinhood: { address: 'not-an-address' } } }),
      });
      assert.match((await bad.json()).error, /tidak valid/, 'a bad treasury address is rejected');
    } finally { await new Promise((r) => adminServer.close(r)); }

    // A regular account is refused the route entirely.
    const s = await serveTenant(alice.id);
    try {
      const r = await fetch(`${s.base}/api/admin/fees`, { headers: { cookie: cookie(alice) } });
      assert.match((await r.json()).error, /superadmin/);
    } finally { await s.close(); }
  });

  await t('an account is open-LP only: copy is forced off and the engine skips it', async () => {
    const { v } = view();
    // A user cannot even write the copy flag, and the view always reports it off.
    assert.throws(() => { v.chains.robinhood.copy = true; }, ReadOnlyError, 'copy must not be user-settable');
    const cv = chainView(v, 'robinhood');
    assert.equal(cv.copy, false, 'tenant chain copy must be false');
    const engine = require('../src/engine');
    const eng = Object.create(engine.Engine.prototype);
    eng.cfg = cv;
    assert.equal(eng.copyEnabled(), false, 'tenant engine must not copy');
    // The superadmin (global config, no copy field) still copies.
    const admin = Object.create(engine.Engine.prototype);
    admin.cfg = chainView(globalCfg(), 'robinhood');
    assert.equal(admin.copyEnabled(), true, 'superadmin engine still copies');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
