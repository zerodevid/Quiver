'use strict';
// Multi-user Telegram: one bot (the superadmin's "hub") serves every account. A pairing code made
// by an account links the chat to that account; afterwards the hub hands that chat's updates to the
// account's bot, and the account's config — not the superadmin's — records the chat.
//
// Run: node test/telegram-hub.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { Telegram } = require('../src/telegram');
const { loadUserCfg, userCfgView } = require('../src/tenants');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-tghub-'));
const fakeEngine = () => ({ network: 'robinhood', label: 'Robinhood Chain', chain: {}, paused: () => false, dryRun: () => true });

function world() {
  const dir = tmp();
  const gcfg = {
    server: {}, telegram: { bot_token: '123456:' + 'A'.repeat(30), chat_ids: ['100'], timezone: 'Asia/Jakarta', notify: { info: true } },
    chains: { robinhood: { enabled: true, chain: { endpoints: [] }, targets: [], rules: {}, mode: {}, gas: {}, prices: {}, loop: {}, scout: {}, risk: {}, swap: {} } },
  };
  const gPath = path.join(dir, 'config.json');
  fs.writeFileSync(gPath, JSON.stringify(gcfg));
  const handled = [];
  const tenants = [];
  const hub = new Telegram({
    cfg: gcfg, cfgPath: gPath, store: new Store(':memory:'), engine: fakeEngine(), log: () => {}, api: async () => ({}),
    routeChat: (chatId) => tenants.find((x) => x.chats().includes(chatId)) || null,
    pairOwner: (code) => tenants.find((x) => x.pairCode && x.pairCode.code === String(code).toUpperCase()) || null,
  });
  hub.tg = async () => ({});
  hub.screen = async (chatId) => { handled.push(['hub', chatId]); };
  const mkTenant = (id) => {
    const udir = path.join(dir, 'users', String(id));
    fs.mkdirSync(udir, { recursive: true });
    const ucfgPath = path.join(udir, 'config.json');
    const view = userCfgView(gcfg, loadUserCfg(ucfgPath, gcfg, udir), { dbPath: path.join(udir, 'lpcopy.db') });
    const eng = fakeEngine();
    const bot = new Telegram({
      cfg: view, cfgPath: ucfgPath, store: new Store(':memory:'), engine: null, log: () => {}, api: async () => ({}),
      nets: { robinhood: { key: 'robinhood', label: 'Robinhood Chain', engine: eng, chain: {} } }, primaryKey: 'robinhood', hub,
    });
    bot.tg = async () => ({});
    bot.syncMenuButton = async () => {};
    bot.screen = async (chatId) => { handled.push([`u${id}`, chatId]); };
    tenants.push(bot);
    return { bot, view, ucfgPath };
  };
  return { gcfg, gPath, hub, mkTenant, handled };
}
const msg = (chatId, text) => ({ message: { chat: { id: Number(chatId), type: 'private' }, text } });

(async () => {
  console.log('telegram hub');

  await t("an account's bot uses the hub's token and never its own", async () => {
    const w = world();
    const a = w.mkTenant(2);
    assert.equal(a.bot.token(), w.gcfg.telegram.bot_token);
    w.hub.me = { username: 'quiver_bot' };
    assert.equal(a.bot.me.username, 'quiver_bot');
    assert.equal(a.view.telegram.bot_token, undefined, 'the bot token is not part of the account view');
    assert.equal(a.view.telegram.timezone, 'Asia/Jakarta', 'shared fields are readable');
    assert.deepEqual(Object.keys(a.view.telegram).sort(), ['chat_ids', 'notify'], 'and not enumerable');
    assert.deepEqual(a.bot.notifCfg(), { penting: true, error: true, warn: true, info: false }, 'the hub notification switches do not leak');
  });

  await t("a code made by an account links the chat to that account only", async () => {
    const w = world();
    const a = w.mkTenant(2);
    const b = w.mkTenant(3);
    const code = a.bot.newPairCode();
    await w.hub.handle(msg(42, `/start ${code}`));
    assert.deepEqual(a.bot.chats(), ['42']);
    assert.deepEqual(b.bot.chats(), []);
    assert.deepEqual(w.gcfg.telegram.chat_ids, ['100'], 'the superadmin keeps its own chats');
    const saved = JSON.parse(fs.readFileSync(a.ucfgPath, 'utf8'));
    assert.deepEqual(saved.telegram.chat_ids, ['42']);
    assert.ok(!JSON.stringify(saved).includes(w.gcfg.telegram.bot_token), 'no bot token in the account file');
    assert.deepEqual(w.handled.at(-1), ['u2', '42'], 'the welcome screen comes from the account');
  });

  await t('after pairing, the hub hands that chat to the account; other chats stay with the hub', async () => {
    const w = world();
    const a = w.mkTenant(2);
    await w.hub.handle(msg(42, `/start ${a.bot.newPairCode()}`));
    await w.hub.handle(msg(42, '/menu'));
    assert.deepEqual(w.handled.at(-1), ['u2', '42']);
    await w.hub.handle(msg(100, '/menu'));
    assert.deepEqual(w.handled.at(-1), ['hub', '100']);
    // an unknown chat is told how to link once, and reaches no screen
    const before = w.handled.length;
    await w.hub.handle(msg(77, 'halo'));
    assert.equal(w.handled.length, before);
  });

  await t("an account cannot change the bot token through its view", async () => {
    const w = world();
    const a = w.mkTenant(2);
    a.view.telegram = { bot_token: '999:evil', chat_ids: ['5'], notify: { info: true } };
    assert.equal(a.view.telegram.bot_token, undefined);
    assert.deepEqual(a.view.telegram.chat_ids, ['5']);
    assert.equal(w.gcfg.telegram.bot_token.startsWith('123456:'), true);
    assert.equal((await a.bot.restart()).ok, true, 'restart is a no-op for an account');
  });

  await t('the hub handles /start login_<code> by authorizing it against the Telegram user', async () => {
    const { hub } = world();
    const calls = [];
    hub.loginBroker = { authorize: (code, from) => { calls.push([code, from.id, from.username]); return { ok: true, name: 'alice', created: true }; } };
    const seen = [];
    hub.send = async (chatId, text) => { seen.push(text); return {}; };
    await hub.onMessage({ chat: { id: 55, type: 'private' }, from: { id: 55, username: 'Alice' }, text: '/start login_a1b2c3d4' });
    assert.deepEqual(calls, [['a1b2c3d4', 55, 'Alice']], 'broker.authorize called with the code and Telegram user');
    assert.match(seen.join(''), /Masuk|Signed in/i, 'a confirmation is sent back');
  });

  await t('an account bot hides copy screens behind a "coming soon" notice', async () => {
    const { mkTenant } = world();
    const { bot } = mkTenant(7);
    delete bot.screen;                       // use the real screen(), not the harness stub
    const seen = [];
    bot.send = async (chatId, text) => { seen.push(text); return {}; };
    // Target, activity and copy-rule screens all resolve to the coming-soon notice.
    for (const code of ['t', 'a', 'r']) { seen.length = 0; await bot.screen(100, null, code); assert.match(seen.join(''), /Copy|segera|coming/i, `copy screen ${code}`); }
    // A non-copy screen is not swallowed by the gate: the home menu renders normally.
    bot.home = async () => ['HOME-OK', { inline_keyboard: [] }];
    seen.length = 0; await bot.screen(100, null, 'h'); assert.match(seen.join(''), /HOME-OK/);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
