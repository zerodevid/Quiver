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

  await t('a plain /start from a new chat onboards the Telegram user and welcomes them', async () => {
    const { hub } = world();
    const calls = [];
    hub.loginBroker = { onboard: (from, chatId) => { calls.push(['onboard', from.id, chatId]); return { ok: true, created: true, name: 'alice', address: '0x' + '1'.repeat(40), user: { role: 'user' } }; } };
    const seen = [];
    hub.send = async (chatId, text) => { seen.push(text); return {}; };
    await hub.onMessage({ chat: { id: 55, type: 'private' }, from: { id: 55, username: 'Alice' }, text: '/start' });
    assert.deepEqual(calls, [['onboard', 55, '55']], 'broker.onboard called with the Telegram user and chat');
    assert.match(seen.join(''), /Selamat datang|Welcome/i, 'a welcome is sent');
    assert.match(seen.join(''), /0x1111/, 'the new wallet address is shown');
  });

  // A broker double: describe() binds the code to the first Telegram user, authorize()/deny() need it.
  const fakeBroker = (calls) => {
    const owner = new Map();
    return {
      describe: (code, from) => { calls.push(['describe', code, from.id]); if (owner.has(code) && owner.get(code) !== from.id) return { error: 'milik akun lain' }; owner.set(code, from.id); return { device: 'Chrome · macOS', ip: '203.0.113.7', match: '47' }; },
      authorize: (code, from, chatId) => { calls.push(['authorize', code, from.id, chatId]); return owner.get(code) === from.id ? { ok: true, name: 'alice', created: false, address: '0x' + '2'.repeat(40), user: { role: 'user' } } : { error: 'milik akun lain' }; },
      deny: (code, from) => { calls.push(['deny', code, from.id]); return { ok: true }; },
    };
  };
  const cb = (chatId, fromId, data) => ({ callback_query: { id: 'q1', data, from: { id: fromId }, message: { message_id: 9, chat: { id: chatId, type: 'private' } } } });

  await t('/start login_<code> asks for confirmation first, and only "Yes, it\'s me" signs the dashboard in', async () => {
    const { hub } = world();
    const calls = [];
    hub.loginBroker = fakeBroker(calls);
    const sent = [], edited = [];
    hub.send = async (chatId, text, keyboard) => { sent.push({ text, keyboard }); return {}; };
    hub.edit = async (chatId, msgId, text) => { edited.push(text); return {}; };
    await hub.handle({ message: { chat: { id: 55, type: 'private' }, from: { id: 55, username: 'Alice' }, text: '/start login_a1b2c3d4' } });
    assert.deepEqual(calls, [['describe', 'a1b2c3d4', 55]], 'nothing is authorized by the link alone');
    assert.match(sent[0].text, /Chrome · macOS/); assert.match(sent[0].text, /47/);
    const datas = sent[0].keyboard.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(datas, ['lgok:a1b2c3d4', 'lgno:a1b2c3d4']);
    await hub.handle(cb(55, 55, 'lgok:a1b2c3d4'));
    assert.deepEqual(calls.at(-1), ['authorize', 'a1b2c3d4', 55, '55']);
    assert.match(edited.join(''), /disetujui|approved/i);
    assert.match(sent.map((x) => x.text).join(''), /dasbor|dashboard/i, 'the welcome says the dashboard is signed in');
  });

  await t('"Not me" denies the login, and a forwarded code cannot be confirmed by someone else', async () => {
    const { hub } = world();
    const calls = [];
    hub.loginBroker = fakeBroker(calls);
    const edited = [];
    hub.send = async () => ({});
    hub.edit = async (chatId, msgId, text) => { edited.push(text); return {}; };
    await hub.handle({ message: { chat: { id: 55, type: 'private' }, from: { id: 55 }, text: '/start login_a1b2c3d4' } });
    await hub.handle(cb(55, 55, 'lgno:a1b2c3d4'));
    assert.deepEqual(calls.at(-1), ['deny', 'a1b2c3d4', 55]);
    assert.match(edited.at(-1), /ditolak|denied/i);
    await hub.handle({ message: { chat: { id: 56, type: 'private' }, from: { id: 56 }, text: '/start login_ffff0000' } });
    await hub.handle(cb(77, 77, 'lgok:ffff0000'));
    assert.match(edited.at(-1), /akun lain/, 'another Telegram user pressing Yes is refused');
  });

  await t('a login from a chat already linked to an account is handled by the hub, then shows the account menu', async () => {
    const w = world();
    const a = w.mkTenant(2);
    await w.hub.handle(msg(42, `/start ${a.bot.newPairCode()}`));
    const calls = [];
    w.hub.loginBroker = fakeBroker(calls);
    w.hub.send = async () => ({});
    w.hub.edit = async () => ({});
    await w.hub.handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42, username: 'Alice' }, text: '/start login_a1b2c3d4' } });
    await w.hub.handle(cb(42, 42, 'lgok:a1b2c3d4'));
    assert.deepEqual(calls.map((c) => c[0]), ['describe', 'authorize'], 'the account bot does not swallow it');
    assert.deepEqual(w.handled.at(-1), ['u2', '42'], 'then the account menu is shown');
    // A plain /start from that chat still belongs to the account.
    await w.hub.handle({ message: { chat: { id: 42, type: 'private' }, from: { id: 42 }, text: '/start' } });
    assert.equal(calls.length, 2);
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
