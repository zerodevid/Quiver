'use strict';
// Telegram bot test.
//
// Only two outer boundaries are faked: the Telegram API (outgoing fetch) and the chain.
// The rest is real code — the very same server.js route table the browser uses, so
// this test also proves the main claim of the telegram.js module: the bot uses the
// dashboard's logic, not a copy of it.
//
// The core test is the EXPLORER: it presses every button reachable from the main
// menu, one by one, and demands that none throws an error
// or produces an empty screen. Buttons that move funds / delete something
// are deliberately not pressed, but their existence is still checked.
//
// Run: node test/telegram.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store } = require('../src/db');
const { rulesFor } = require('../src/policy');
const mm = require('../src/v3math');
const { createServer } = require('../src/server');
const { Telegram, parseVal, showVal, RULE_GROUPS } = require('../src/telegram');
const { ADDR, TOPIC } = require('../src/chain');

const CHAT = '12345';
const FOREIGN = '99999';
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

// ---- fake world ----------------------------------------------------------
// One v4 Initialize log as the PoolManager really emits it:
// three indexed topics (poolId, currency0, currency1) + fee/tickSpacing/hooks/price in data.
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const initLog = ({ id, c0, c1, fee, ts, hooks = ADDR.native, block = 500 }) => ({
  address: ADDR.poolManager,
  topics: [TOPIC.initializeV4, id, pad32(c0), pad32(c1)],
  data: '0x' + word(fee) + word(ts) + pad32(hooks).slice(2) + word(0) + word(0),
  blockNumber: '0x' + block.toString(16),
});

// v3 PoolCreated at the factory: token0, token1, fee in topics; tickSpacing & pool address in data.
const FACTORY = '0x' + 'fa'.repeat(20);
const createdLog = ({ pool, t0, t1, fee, ts, block = 600 }) => ({
  address: FACTORY,
  topics: [TOPIC.poolCreatedV3, pad32(t0), pad32(t1), '0x' + word(fee)],
  data: '0x' + word(ts) + pad32(pool).slice(2),
  blockNumber: '0x' + block.toString(16),
});

// "Traded elsewhere" calls GeckoTerminal — in the test replaced with fixed data.
const { Manual: ManualClass } = require('../src/manual');
let OTHER_MARKET = null;
ManualClass.prototype.otherMarket = async () => OTHER_MARKET;

function build({ chats = [CHAT], dryRun = true, initLogs = [], kosong: blank = [], rejectFullRange = false, otherMarket = null } = {}) {
  OTHER_MARKET = otherMarket;
  const store = new Store(':memory:');
  const now = Date.now();
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'Bang GE', now);
  for (const [a, sym, dec] of [[ADDR.usdg, 'USDG', 6], [ADDR.native, 'ETH', 18], [MEME, 'MEME', 18]]) {
    store.run('INSERT INTO tokens(address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?)', a, sym, sym, dec, now);
  }
  store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,value_quote,quote_symbol)
    VALUES(1,?,100,'0xaa',0,?,'v4','increase','777','0xpool',?,?,3000,-600,600,'1000',200,'USDG')`, now, TARGET, ADDR.usdg, MEME);
  store.run("INSERT INTO decisions(action_id,ts,verdict,reason,tx_hash) VALUES(1,?,'copy','mirror → $200','0xbb')", now);
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,tick_lower,tick_upper,liquidity,target,mirror_of,status,opened_ts,cost_quote,quote_symbol,tx_open)
    VALUES(1,'v4','888','0xpool',?,?,3000,60,-600,600,'5000',?,'777','open',?,200,'USDG','0xcc')`, ADDR.usdg, MEME, TARGET, now - 3600_000);
  store.run(`INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,status,closed_ts,cost_quote,out_quote,quote_symbol)
    VALUES(2,'v4','889','0xpool',?,?,'closed',?,100,112,'USDG')`, ADDR.usdg, MEME, now - 7200_000);
  store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block,first_ts)
    VALUES('0xpool','v4',?,?,3000,60,?,1,?)`, ADDR.usdg, MEME, ADDR.native, now - 86400_000);
  store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block,first_ts)
    VALUES('0xhook','v4',?,?,10000,200,'0x00000000000000000000000000000000000000ff',1,?)`, ADDR.usdg, MEME, now - 86400_000);
  store.log('info', 'uji: baris log');
  store.run("INSERT INTO txs(hash,ts,kind,status,gas_quote) VALUES('0xdd',?,'mint','ok',0.01)", now);
  store.run('INSERT INTO wallets(address,label,first_block,scanned_to,last_scan_ts,positions_n,stats) VALUES(?,?,1,100,?,2,?)',
    TARGET, 'Bang GE', now, JSON.stringify({ pnlUsd: 42.5, winRatePct: 66 }));

  const live = [{
    id: 1, venue: 'v4', token_id: '888', pool_ref: '0xpool', token0: ADDR.usdg, token1: MEME,
    fee: 3000, tick_lower: -600, tick_upper: 600, curTick: 0, liquidity: '5000',
    symbol0: 'USDG', symbol1: 'MEME', dec0: 6, dec1: 18, quoteSide: 0, target: TARGET, mirror_of: '777', tx_open: '0xcc',
    valueUsd: 205, feeUsd: 1.5, costUsd: 200, pnlUsd: 6.5, pnlPct: 3.25, ilUsd: -1.2,
    inRange: true, ageHours: 1, empty: false,
  }];

  const cfg = {
    mode: { dry_run: dryRun }, rules: {}, gas: {}, loop: {}, prices: {},
    chain: { endpoints: [{ url: 'https://rpc.contoh.test', max_batch: 40 }] },
    wallet: { key_file: path.join(os.tmpdir(), 'lpcopy-uji-key') },
    server: {}, notify: {},
    telegram: { bot_token: '123456:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', chat_ids: [...chats] },
  };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-tg-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));

  const engine = {
    cfg, store,
    ethUsd: 2500, head: 1000, cursor: 998, headSpread: 0, lastError: null,
    stats: { startedAt: Date.now() - 60_000, ticks: 12 },
    dryRun: () => cfg.mode.dry_run !== false,
    paused: () => store.getState('paused', '0') === '1',
    drawdownStatus: () => ({ enabled: false, pct: 0, peakUsd: null, tripped: false }),
    positions: { live, lastSync: Date.now(), summary: () => ({ openCount: 1, exposureUsd: 205, costUsd: 200, feeUsd: 1.5, unrealizedUsd: 6.5, realizedUsd: 12, inRange: 1 }) },
    watcher: { unsupported: new Map() },
    exec: {
      address: () => ME, keyPath: () => cfg.wallet.key_file, resetWallet: () => {},
      balances: async () => new Map([[ADDR.native, 10n ** 17n], [ADDR.usdg, 150_000_000n], [ADDR.weth, 0n]]),
    },
    leftovers: () => [{ posId: 1, target: TARGET, token: MEME, quote: ADDR.usdg, amount: '1000', tries: 2, next: Date.now() + 5000, since: Date.now() - 90_000, why: 'rute rugi 18%' }],
    saveLeftovers: () => {}, dropLeftover: () => {}, sellToken: async () => 'terjual',
    executeExit: async () => ({ txHash: '0xee' }),
    rulesFrom: () => rulesFor(cfg.rules, null),
    freshCash() { return this.cash || null; }, refreshCash: async () => null,
    notify(msg, detail) { if (this.onNotify) this.onNotify(msg, detail); },
    opened: [], swapped: [],
    executeEntry: async function (plan, act) { this.opened.push({ plan, act }); return { txHash: '0xmint', positionId: 9, note: 'USDG/MEME $50,00' }; },
    kyber: {
      quote: async (a, b, amt) => ({ amountOut: BigInt(amt) * 2n, usdIn: 50, usdOut: 49.5, dex: 'uji-dex', routeSummary: {} }),
      scan: async function (a, b, amt) { const q = await this.quote(a, b, amt); return [{ id: 'kyber', label: 'Kyber', state: q ? 'ok' : 'noroute', q, ms: 1 }]; },
      swap: async function (a, b, amt) { return { hash: '0xswap', amountOut: BigInt(amt) * 2n, quote: { dex: 'uji-dex', usdIn: 50, usdOut: 49.5 } }; },
    },
  };
  const query = [];
  const rpc = {
    stats: () => [{ url: 'https://rpc.contoh.test', calls: 10, errors: 0, lastMs: 90 }], reconfigure: () => {},
    blockNumber: async () => 1_000_000,
    // Pasted addresses: MEME = token, CONTRACT = smart wallet, the rest an ordinary wallet.
    call: async (method, params) => {
      if (method !== 'eth_getCode') throw new Error('tidak didukung: ' + method);
      const a = String(params[0]).toLowerCase();
      return a === MEME || a === KONTRAK ? '0x6080604052' : '0x';
    },
    ethCallMany: async (items) => items.map((it) => {
      if (it.data === '0x1a686502') return '0x' + word(blank.includes(String(it.to).toLowerCase()) ? 0 : 10n ** 20n);   // v3 liquidity()
      if (String(it.to).toLowerCase() !== MEME) return null;
      const abi = require('ethers').AbiCoder.defaultAbiCoder();
      return it.data === '0x95d89b41' ? abi.encode(['string'], ['MEME']) : abi.encode(['uint8'], [18]);
    }),
    getLogs: async (f) => {
      query.push(f);
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      if (rejectFullRange && to - from > 500_000) throw new Error('query returned more than 10000 results');
      return initLogs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        if (f.address && String(l.address).toLowerCase() !== String(f.address).toLowerCase()) return false;
        for (let i = 0; i < f.topics.length; i++) if (f.topics[i] && l.topics[i] !== f.topics[i]) return false;
        return true;
      });
    },
  };

  // A fake chain complete enough for manual LP: pool price, token metadata, and
  // position valuation use the real v3 math.
  const SQRT = mm.getSqrtRatioAtTick(0);
  const meta = {
    [ADDR.usdg]: { address: ADDR.usdg, symbol: 'USDG', decimals: 6 },
    [ADDR.native]: { address: ADDR.native, symbol: 'ETH', decimals: 18 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const chain = {
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: SQRT, tick: 0 })),
    slot0V4: async () => ({ sqrtPriceX96: SQRT, tick: 0 }),
    slot0V3: async () => ({ sqrtPriceX96: SQRT, tick: 0 }),
    factoryV3: async () => FACTORY,
    poolLiquidity: async (id) => (blank.includes(id) ? 0n : 10n ** 20n),
    tokens: async (list) => list.map((a) => meta[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    token: async (a) => meta[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 },
    quoteSideOf(t0, t1) {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
  };

  let server;
  const sent = [];
  const bot = new Telegram({
    cfg: (cfg.telegram.language = 'id', cfg), cfgPath, store, engine, log: () => {},
    api: (m, p, b, q) => server.api(m, p, b, q),
    shareCard: (o) => server.shareCard(o),
    chartCard: (o) => server.chartCard(o),
    portfolioCard: (o) => server.portfolioCard(o),
  });
  // The share card is sent as a photo via multipart, not this.tg(): recorded
  // separately so it does not touch the network.
  bot.sendPhoto = async (chatId, png, caption, keyboard = null) => {
    sent.push({ method: 'sendPhoto', params: { chat_id: chatId, caption, bytes: png.length, reply_markup: keyboard } });
    return true;
  };
  // An edited photo message (chart button) is also recorded; false = the message is not a photo.
  bot.editPhoto = async (chatId, msgId, png, caption, keyboard = null) => {
    sent.push({ method: 'editMessageMedia', params: { chat_id: chatId, message_id: msgId, caption, bytes: png.length, reply_markup: keyboard } });
    return bot.photoMsgs?.has?.(msgId) || false;
  };
  bot.photoMsgs = new Set();
  // A fake Telegram API: records what goes out, replies like the real one.
  let msgId = 100;
  bot.tg = async (method, params) => {
    sent.push({ method, params });
    if (method === 'sendMessage') return { message_id: ++msgId, chat: { id: params.chat_id }, text: params.text };
    if (method === 'editMessageText') return { message_id: params.message_id, text: params.text };
    if (method === 'getMe') return { username: 'lpcopy_uji_bot' };
    return true;
  };
  // The real polling loop is replaced by a recorder: a test must not leave a loop spinning.
  // The generation received by poll() is still recorded, because that is what proves
  // the old loop stops when the token is replaced.
  bot.polls = [];
  bot.poll = async (gen = bot.gen) => { bot.polls.push(gen); };
  // The third outer boundary: GeckoTerminal/DexScreener (price candles for the Chart button).
  // Installed BEFORE the server is created — Market records its fetch when built.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('geckoterminal')) {
      const list = [];
      for (let i = 0; i < 80; i++) {
        const base = 1 + i / 200;
        list.push([Math.floor((Date.now() - (80 - i) * 3600_000) / 1000), base, base * 1.01, base * 0.99, base, 1000 + i]);
      }
      return { ok: true, status: 200, json: async () => ({ data: { attributes: { ohlcv_list: list.reverse() } } }) };
    }
    return { ok: true, status: 200, json: async () => ({ pairs: [] }) };
  };
  server = createServer({ engine, store, cfg, cfgPath, chain, rpc, log: () => {}, telegram: bot });
  return { bot, store, cfg, cfgPath, sent, engine, chainStub: chain, query, api: (m, p, b, q) => server.api(m, p, b, q), last: () => sent[sent.length - 1] };
}

const msg = (text, chat = CHAT) => ({ message: { chat: { id: Number(chat) }, text } });
const KONTRAK = '0x' + 'c0'.repeat(20);
const cbq = (data, chat = CHAT) => ({ callback_query: { id: 'q1', data, message: { chat: { id: Number(chat) }, message_id: 100 } } });
const outs = (sent) => sent.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
const lastOut = (sent) => outs(sent).slice(-1)[0];
// URL buttons (GMGN/Based/fomo/Uniswap) have no callback_data — not a screen that can be explored.
const buttons = (o) => (o?.params?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data).filter(Boolean);

(async () => {
  console.log('bot Telegram\n');

  await t('mini app: the button appears only if the dashboard has an https address', async () => {
    const w = build();
    // Without server.public_url there is nothing: an instance that only listens on
    // 127.0.0.1 really has no address Telegram can open.
    const polos = (await w.bot.home())[1].inline_keyboard.flat();
    assert.ok(!polos.some((b) => b.web_app));
    assert.equal(w.bot.miniUrl(), null);

    w.cfg.server.public_url = 'http://lp.contoh.test';       // http is rejected by Telegram
    assert.equal(w.bot.miniUrl(), null);

    w.cfg.server.public_url = 'https://lp.contoh.test/';     // a trailing slash does not double up
    assert.equal(w.bot.miniUrl(), 'https://lp.contoh.test/mini');
    const button = (await w.bot.home())[1].inline_keyboard.flat().find((b) => b.web_app);
    assert.equal(button.web_app.url, 'https://lp.contoh.test/mini');
    assert.ok(!button.callback_data, 'the mini app button opens a page, not sending a callback');

    // The button beside the typing field is installed per connected chat.
    await w.bot.syncMenuButton();
    const menu = w.sent.filter((x) => x.method === 'setChatMenuButton');
    assert.equal(menu.length, w.bot.chats().length);
    assert.equal(menu[0].params.menu_button.type, 'web_app');
    assert.equal(menu[0].params.menu_button.web_app.url, 'https://lp.contoh.test/mini');
  });

  await t('positions: loss in red, source, USD history, and the page stays compact', async () => {
    const w = build();
    const base = (await w.api('GET', '/api/positions')).positions[0];
    const positions = Array.from({ length: 13 }, (_, i) => ({ ...base, id: i + 1, symbol1: '<LONG&' + 'TOKEN'.repeat(20), targetLabel: '<Trader&' + 'name '.repeat(30), pnlUsd: i === 0 ? -53.74 : i === 1 ? 0 : null, inRange: true }));
    const closed = Array.from({ length: 13 }, (_, i) => ({ token_id: 800 + i, symbol0: 'WETH', symbol1: 'MEME', target: TARGET, targetLabel: i ? null : 'Bang GE', pnlUsd: -250, cost_quote: 1, out_quote: 0.9, closed_ts: Date.now() }));
    w.bot.api = async () => ({ positions, closed });
    const [text, markup] = await w.bot.posisi();
    assert.match(text, /🔴 −\$53,74/);
    assert.match(text, /&lt;Trader&amp;/);
    assert.match(text, /WETH\/MEME/);
    assert.match(text, /Bang GE/);
    assert.match(text, /🔴 −\$250,00/);
    assert.ok(text.includes('<pre>'));
    assert.match(text, /Pasangan\s+Sumber\s+PnL/);
    for (const block of text.matchAll(/<pre>([\s\S]*?)<\/pre>/g)) {
      for (const line of block[1].split('\n')) assert.ok(Array.from(line.replace(/&(?:amp|lt|gt);/g, 'x')).length <= 42, line);
    }
    assert.ok(text.length < 4096);
    const buttons = markup.inline_keyboard.flat();
    assert.match(buttons.find((b) => b.callback_data === 'p:1').text, /^🔴/);
    assert.match(buttons.find((b) => b.callback_data === 'p:2').text, /^⚪️/);
    assert.match(buttons.find((b) => b.callback_data === 'p:3').text, /^⚪️/);
    assert.ok(buttons.some((b) => b.callback_data === 'pl:1:0'));
    assert.ok(buttons.some((b) => b.callback_data === 'pl:0:1'));
    await w.bot.handle(cbq('pl:1:1'));
    const next = lastOut(w.sent).params;
    assert.ok(next.reply_markup.inline_keyboard.flat().some((b) => b.callback_data === 'p:5'));
    assert.match(next.text, /#804/);
    assert.ok(!next.text.includes('#800'));
    const [last] = await w.bot.posisi(999, 999);
    assert.match(last, /#812/);
    w.bot.stop();
  });

  // ---- chat gate -------------------------------------------------------
  await t('a foreign chat is not served and leaks nothing', async () => {
    const w = build();
    await w.bot.handle(msg('/ringkasan', FOREIGN));
    const o = lastOut(w.sent);
    assert.strictEqual(String(o.params.chat_id), FOREIGN);
    assert.match(o.params.text, /belum tersambung/i);
    assert.ok(!/LIVE|SIMULASI|0x/.test(o.params.text), 'the reply to a foreign chat must not contain the bot\'s state');
  });

  await t('input can be cancelled via a button, a command, and navigation', async () => {
    for (const action of [msg('/cancel'), msg('/batal'), msg('/menu'), cbq('cancelInput'), cbq('h'), msg('/positions')]) {
      const w = build();
      await w.bot.handle(cbq('ta'));
      assert.ok(w.bot.sess(CHAT).pending);
      assert.ok(buttons(lastOut(w.sent)).includes('cancelInput'));
      await w.bot.handle(action);
      assert.strictEqual(w.bot.sess(CHAT).pending, null);
      await w.bot.handle(msg('bukan alamat'));
      assert.strictEqual(w.bot.sess(CHAT).pending, null);
    }
  });

  await t('a failed input can be filled in again without opening the menu from the start', async () => {
    const w = build();
    await w.bot.handle(cbq('mln'));
    await w.bot.handle(msg('bukan angka'));
    assert.ok(buttons(lastOut(w.sent)).includes('inputRetry'));
    await w.bot.handle(cbq('inputRetry'));
    assert.strictEqual(w.bot.sess(CHAT).pending.kind, 'lpUsd');
    await w.bot.handle(msg('50'));
    assert.strictEqual(w.bot.sess(CHAT).lp.usd, 50);
    assert.strictEqual(w.bot.sess(CHAT).pending, null);
  });

  await t('navigation clears the pending input so an old button does not open an input', async () => {
    const w = build();
    await w.bot.handle(cbq('mln'));
    await w.bot.handle(msg('salah'));
    await w.bot.handle(msg('/menu'));
    await w.bot.handle(cbq('inputRetry'));
    assert.strictEqual(w.bot.sess(CHAT).pending, null);
    assert.ok(buttons(lastOut(w.sent)).includes('t'));
  });

  await t('a wrong connect code is rejected, the right code connects', async () => {
    const w = build({ chats: [] });
    const passcode = w.bot.newPairCode();
    await w.bot.handle(msg('/start SALAH123', FOREIGN));
    assert.match(lastOut(w.sent).params.text, /Kode salah/);
    assert.ok(!w.bot.chats().includes(FOREIGN));
    await w.bot.handle(msg(`/start ${passcode}`, FOREIGN));
    assert.ok(w.bot.chats().includes(FOREIGN), 'the chat must be connected after the right code');
    // and stored to the config, not just in memory
    assert.ok(JSON.parse(fs.readFileSync(w.cfgPath, 'utf8')).telegram.chat_ids.includes(FOREIGN));
  });

  await t('one-time code: cannot be used by a second chat', async () => {
    const w = build({ chats: [] });
    const passcode = w.bot.newPairCode();
    await w.bot.handle(msg(`/start ${passcode}`, FOREIGN));
    await w.bot.handle(msg(`/start ${passcode}`, '77777'));
    assert.ok(!w.bot.chats().includes('77777'), 'a code that has been used must not be valid again');
  });

  await t('an expired code is rejected', async () => {
    const w = build({ chats: [] });
    const passcode = w.bot.newPairCode();
    w.bot.pairCode.exp = Date.now() - 1;
    await w.bot.handle(msg(`/start ${passcode}`, FOREIGN));
    assert.match(lastOut(w.sent).params.text, /kedaluwarsa/i);
    assert.ok(!w.bot.chats().includes(FOREIGN));
  });

  await t('a button from a foreign chat is rejected without calling the API', async () => {
    const w = build();
    await w.bot.handle(cbq('o', FOREIGN));
    assert.strictEqual(outs(w.sent).length, 0, 'no message may be sent');
    assert.match(w.last().params.text, /tidak berwenang/i);
  });

  await t('the main screen uses net PnL if capital is tracked — figure & 24-hour delta from the same curve', async () => {
    const w = build({ dryRun: false });
    const original = w.bot.api;
    const now = Date.now();
    // The position PnL computed by the engine in this test database is +$18.50; the tracked capital
    // makes its net figure +$6.50 — the $12 difference is gas & swaps outside positions.
    // Two different 24-hour curves (+$8.50 vs +$6.50) so it is noticed if the card
    // takes its figure from one curve and its delta from another.
    const pf = (net) => ({
      range: '24h', baseline: null,
      series: [
        { ts: now - 86000_000, pnl: 10, net: net ? 0 : null, total: 2062, cash: 1200 },
        { ts: now, pnl: 18.5, net: net ? 6.5 : null, total: 2132.42, cash: 1221.3 },
      ],
      now: {
        value: 2132.42, cash: { usd: 1221.3, usdg: 1216.45, eth: 0, weth: 0 },
        pnl: 18.5, realizedUsd: 12, unrealizedUsd: 6.5, positionsUsd: 205, costUsd: 200,
        capital: 2113.92, capitalNet: net ? 2125.92 : null, netPnl: net ? 6.5 : null,
        openCount: 1, inRange: 1,
      },
      capital: null, stats: {}, daily: {}, byTarget: [], closed: [],
    });
    const use = (net) => { w.bot.api = async (m, path, b, q) => (path === '/api/portfolio' ? pf(net) : original(m, path, b, q)); };

    use(true);
    const [netAmount] = await w.bot.home();
    assert.match(netAmount, /PnL bersih <b>🟢 \+\$6,50<\/b> · 24 jam \+\$6,50/, netAmount);
    // Capital not tracked (deposits not yet read from the chain): there is no net figure
    // that can be trusted, so it falls back to the cumulative position PnL — along with its own 24-hour
    // delta, not the other curve's delta.
    use(false);
    const [cumulative] = await w.bot.home();
    assert.ok(!/PnL bersih/.test(cumulative), 'without tracked capital it must not claim to be net');
    assert.match(cumulative, /PnL <b>🟢 \+\$18,50<\/b> · 24 jam \+\$8,50/, cumulative);
    // The Summary uses the same figures, and the table reconciles the two.
    use(true);
    const [compact] = await w.bot.overview();
    assert.match(compact, /PnL bersih <b>🟢 \+\$6,50<\/b>/, compact);
    assert.match(compact, /PnL posisi\s+\+\$18,50/, compact);
    assert.match(compact, /−\$12,00/, compact);
    w.bot.api = original;
    w.bot.stop();
  });

  await t('the main card writes the portfolio value in the secondary currency', async () => {
    const w = build();
    const original = w.bot.api.bind(w.bot);
    // The rate comes from /api/overview (src/fx.js), the same as on the dashboard — here
    // it is injected so the test does not touch the network.
    const use = (fx) => {
      w.bot.api = async (m, path, b, q) => {
        if (path === '/api/overview') return { ...(await original(m, path, b, q)), fx };
        if (path === '/api/portfolio') {
          return { range: '24h', baseline: null, series: [], now: { value: 2143.42, cash: { usd: 1568.74 }, netPnl: 390.07 }, stats: {}, daily: {}, byTarget: [], closed: [] };
        }
        return original(m, path, b, q);
      };
    };

    use({ currency: 'IDR', rate: 16000, at: Date.now(), stale: false });
    const [rupiah] = await w.bot.home();
    assert.match(rupiah, /💰 Portofolio <b>\$2\.143,42<\/b> · ≈ Rp\s?34,3\s?jt/, rupiah);
    const [compact] = await w.bot.overview();
    assert.match(compact, /· ≈ Rp\s?34,3\s?jt/, compact);

    // The secondary currency is switched off in Settings, or its rate has never been read:
    // the row goes back to how it was, without a dangling "·" separator left over.
    for (const fx of [null, { currency: 'IDR', rate: null }]) {
      use(fx);
      const [polos] = await w.bot.home();
      assert.match(polos, /💰 Portofolio <b>\$2\.143,42<\/b>\n/, polos);
    }
    w.bot.api = original;
    w.bot.stop();
  });

  await t('the Telegram language is stored per chat and does not leak between requests', async () => {
    const w = build({ chats: [CHAT, '777'] });
    await w.bot.handle(msg('/language'));
    assert.ok(buttons(lastOut(w.sent)).includes('langSet:en'));
    await w.bot.handle(cbq('langSet:en'));
    assert.equal(w.store.getState('tg_language:' + CHAT), 'en');
    assert.match(lastOut(w.sent).params.text, /Settings/);
    await Promise.all([w.bot.handle(msg('/summary')), w.bot.handle(msg('/summary', '777'))]);
    const english = outs(w.sent).filter(x => String(x.params.chat_id) === CHAT).at(-1).params.text;
    const indonesian = outs(w.sent).filter(x => String(x.params.chat_id) === '777').at(-1).params.text;
    assert.match(english, /Overview/); assert.match(english, /\+\$18\.50/);
    assert.match(indonesian, /Ringkasan/); assert.match(indonesian, /\+\$18,50/);
    w.bot.sessions.clear();
    const restarted = new Telegram({ cfg: w.cfg, cfgPath: w.cfgPath, store: w.store, engine: w.engine, api: w.api });
    assert.equal(restarted.language(CHAT), 'en');
    await w.bot.handle(msg('/settings'));
    assert.match(lastOut(w.sent).params.text, /Settings/);
    await w.bot.handle(cbq('langSet:id'));
    assert.match(lastOut(w.sent).params.text, /Pengaturan/);
    w.bot.stop();
  });

  await t('every Telegram screen is in English and callbacks stay valid', async () => {
    const w = build(); w.bot.setLanguage(CHAT, 'en');
    const skip = new Set(['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX', 'langSet']);
    const queue = ['h']; const seen = new Set(); const screens = [];
    while (queue.length) {
      const data = queue.shift(); if (seen.has(data)) continue; seen.add(data);
      await w.bot.handle(cbq(data)); const output = lastOut(w.sent);
      assert.ok(output?.params.text, data);
      assert.ok(!/undefined|NaN|\[object|\{\d+\}/.test(output.params.text), data);
      screens.push({data,text:output.params.text,buttons:output.params.reply_markup});
      for (const b of buttons(output)) if (!skip.has(b.split(':')[0])) queue.push(b);
    }
    fs.writeFileSync('/tmp/lpcopy-english-screens.json', JSON.stringify(screens,null,2));
    assert.ok(seen.size > 40);
    for (const screen of screens) {
      if (screen.data === 'lang') continue;
      const buttonText = (screen.buttons?.inline_keyboard || []).flat().map(b => b.text).filter(text => !text.includes('Language / Bahasa')).join(' ');
      assert.ok(!/\b(pengaturan|pilih|kirim|belum|silakan|tersimpan|posisi|saldo|aturan|menunggu|tidak|dijeda|diikuti|ukuran)\b/i.test(screen.text + " " + buttonText), `${screen.data}: ${screen.text} ${buttonText}`);
    }
    w.bot.stop();
  });

  await t('English notifications use the copy and figures of the recipient\'s language', async () => {
    const w = build({ chats: [CHAT, '777'] });
    w.bot.setLanguage(CHAT, 'en');
    await w.bot.start();
    w.engine.notify('LP ditutup: tutup penuh posisi #2', {
      kind: 'exit', positionId: 2, txHash: '0xburn123', full: true,
      sold: 'jual 1234 MEME → $4.20 (kyber)', reason: 'target menutup posisi',
    });
    await new Promise(r => setTimeout(r, 100));
    const en = outs(w.sent).find(x => String(x.params.chat_id) === CHAT).params;
    const id = outs(w.sent).find(x => String(x.params.chat_id) === '777').params;
    assert.match(en.text, /Position closed/); assert.match(en.text, /The target closed its position/);
    assert.match(en.text, /\+\$12\.00/); assert.match(en.text, /Sold 1234 MEME/);
    assert.match(id.text, /Posisi ditutup/); assert.match(id.text, /\+\$12,00/);
    assert.ok(!/LP DITUTUP|tutup penuh|jual 1234|target menutup/.test(en.text));
    assert.ok(buttons({params: en}).includes('p'));
    w.bot.stop();
  });

  // ---- menu explorer ----------------------------------------------------
  await t('Chart button: candle image + time range & indicator buttons; pressing again edits the same photo', async () => {
    const w = build();
    const before = w.sent.length;
    // Pressed from the position detail TEXT screen: the photo is sent anew.
    await w.bot.handle(cbq('pg:1'));
    const sendOrig = w.sent.slice(before).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(sendOrig.length, 1, 'satu foto grafik');
    assert.ok(sendOrig[0].params.bytes > 20_000, 'PNG sungguhan');
    assert.match(sendOrig[0].params.caption, /USDG\/MEME · 1h/);
    const button = sendOrig[0].params.reply_markup.inline_keyboard;
    const data = button.flat().map((b) => b.callback_data);
    assert.ok(data.includes('pg:1:5m:10:0') && data.includes('pg:1:1d:10:0'), `the time range must exist: ${data}`);
    // Window width: auto (0) and the day choices — carrying the active tf & indicators.
    assert.ok(data.includes('pg:1:1h:10:24') && data.includes('pg:1:1h:10:720'), `the window width choice must exist: ${data}`);
    // The indicator toggle flips its own bit (default EMA|VOL = 10).
    assert.ok(data.includes('pg:1:1h:8:0') && data.includes('pg:1:1h:2:0'), `the EMA & VOL toggle must flip the bit: ${data}`);
    assert.ok(data.includes('p:1'), 'there is a way back to the position');
    assert.ok(button.flat().some((b) => /✅ EMA/.test(b.text)) && button.flat().some((b) => /▫️ MACD/.test(b.text)),
      'an indicator that is on is marked with a tick');
    // Pressed from a PHOTO message: the image is edited, not piling up a new photo.
    const b2 = w.sent.length;
    w.bot.photoMsgs.add(777);
    const fromPhoto = cbq('pg:1:4h:63:72');
    fromPhoto.callback_query.message.message_id = 777;
    await w.bot.handle(fromPhoto);
    const edit = w.sent.slice(b2).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'edits the same photo');
    assert.ok(!w.sent.slice(b2).some((x) => x.method === 'sendPhoto'), 'does not send a second photo');
    assert.ok(edit[0].params.bytes > 20_000);
    const btnLabel = edit[0].params.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(btnLabel.some((x) => /· 4h ·/.test(x)), 'the active time range is marked');
    assert.ok(btnLabel.some((x) => /· 3 hari ·/.test(x)), `the active window width is marked: ${btnLabel}`);
  });

  await t('Portfolio chart button: without history it explains, with history it sends an image + range & view buttons', async () => {
    const w = build();
    // An empty equity table: not an error, but an explanation of when the chart fills in.
    const b0 = w.sent.length;
    await w.bot.handle(cbq('pfg'));
    assert.match(lastOut(w.sent).params.text, /belum ada riwayat/i);
    assert.ok(!w.sent.slice(b0).some((x) => x.method === 'sendPhoto'), 'no photo without history');
    // A 3-day history, hourly: PnL rises from 0 to 18 with one trough in the middle.
    const now = Date.now();
    for (let i = 72; i >= 1; i--) {
      const pnl = (72 - i) * 0.25 - (i > 30 && i < 40 ? 4 : 0);
      w.store.run('INSERT INTO equity(ts,wallet_quote,positions_quote,total_quote,realized_quote,fees_quote,open_positions,pnl_quote) VALUES(?,?,?,?,?,?,?,?)',
        now - i * 3600_000, 150, 205, 355 + pnl, 12, 1.5, 1, pnl);
    }
    const b1 = w.sent.length;
    await w.bot.handle(cbq('pfg'));
    const sendOrig = w.sent.slice(b1).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(sendOrig.length, 1, 'satu foto grafik');
    assert.ok(sendOrig[0].params.bytes > 15_000, `PNG sungguhan: ${sendOrig[0].params.bytes}`);
    // Capital not tracked in the test world → net PnL falls back to cumulative PnL, and the button
    // that is active shows the view that is really drawn.
    assert.match(sendOrig[0].params.caption, /Portofolio · PnL kumulatif · 7 hari/);
    const button = sendOrig[0].params.reply_markup.inline_keyboard;
    const data = button.flat().map((b) => b.callback_data);
    for (const r of ['24h', '7d', '30d', 'all']) assert.ok(data.includes(`pfg:${r}:pnl`), `range ${r} must exist: ${data}`);
    for (const v of ['net', 'pnl', 'value']) assert.ok(data.includes(`pfg:7d:${v}`), `view ${v} must exist: ${data}`);
    assert.ok(button.flat().some((b) => /· 7 hari ·/.test(b.text)) && button.flat().some((b) => /· PnL kumulatif ·/.test(b.text)), 'the active one is marked');
    // From a photo message: the image is edited, the Value view & a 24-hour range.
    const b2 = w.sent.length;
    w.bot.photoMsgs.add(778);
    const fromPhoto = cbq('pfg:24h:value');
    fromPhoto.callback_query.message.message_id = 778;
    await w.bot.handle(fromPhoto);
    const edit = w.sent.slice(b2).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'edits the same photo');
    assert.match(edit[0].params.caption, /Portofolio · Nilai · 24 jam/);
    assert.ok(edit[0].params.reply_markup.inline_keyboard.flat().some((b) => /· 24 jam ·/.test(b.text)));
    // English carries over to the image and the caption.
    w.bot.setLanguage(CHAT, 'en');
    const b3 = w.sent.length;
    await w.bot.handle(cbq('pfg:30d:pnl'));
    const en = w.sent.slice(b3).find((x) => x.method === 'sendPhoto');
    assert.match(en.params.caption, /Portfolio · Cumulative PnL · 30 days/);
  });

  await t('Share card button: the PnL photo is sent to that chat, the screen is not replaced', async () => {
    const w = build(); w.bot.setLanguage(CHAT, 'en');
    const d = await w.api('GET', '/api/positions');
    const p = d.positions[0];
    assert.ok(p, 'needs one open position in the test data');
    const before = w.sent.length;
    await w.bot.handle(cbq(`ps:${p.id}`));
    const photo = w.sent.slice(before).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(photo.length, 1, 'tepat satu foto');
    assert.strictEqual(photo[0].params.chat_id, CHAT);
    assert.ok(photo[0].params.bytes > 10_000, 'a real PNG, not empty');
    assert.match(photo[0].params.caption, new RegExp(`^${p.symbol0} / ${p.symbol1} .*· Quiver$`));
    assert.ok(!w.sent.slice(before).some((x) => x.method === 'editMessageText'), 'the detail screen must not be overwritten');
    const ack = w.sent.slice(before).find((x) => x.method === 'answerCallbackQuery');
    assert.strictEqual(ack?.params.text, 'Card sent.');
    // Total PnL from the summary screen.
    const b2 = w.sent.length;
    await w.bot.handle(cbq('os'));
    const total = w.sent.slice(b2).find((x) => x.method === 'sendPhoto');
    assert.match(total?.params.caption || '', /^Total PnL .*· Quiver$/);
    // Below the photo are the theme & size buttons; pressed from a photo message → the image
    // is edited in place with the chosen theme/size/hide marked.
    const button = photo[0].params.reply_markup.inline_keyboard.flat();
    assert.ok(button.some((b) => b.text === '· Graphite ·') && button.some((b) => b.text === '· Wide ·'), `bawaan ditandai: ${button.map((b) => b.text)}`);
    const neonStory = button.find((b) => b.text === 'Neon');
    assert.strictEqual(neonStory?.callback_data, `ps:${p.id}:neon:wide:0`);
    const b3 = w.sent.length;
    w.bot.photoMsgs.add(778);
    const fromPhoto = cbq(`ps:${p.id}:neon:story:1`);
    fromPhoto.callback_query.message.message_id = 778;
    await w.bot.handle(fromPhoto);
    const edit = w.sent.slice(b3).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'edits the same photo');
    assert.ok(!w.sent.slice(b3).some((x) => x.method === 'sendPhoto'), 'does not send a second photo');
    const body = edit[0].params.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(body.includes('· Neon ·') && body.includes('· Story ·') && body.some((x) => /^✅ Hide amounts/.test(x)), `pilihan aktif ditandai: ${body}`);
    w.bot.stop();
  });

  await t('every button reachable from the main menu works', async () => {
    const w = build();
    // Not pressed: moves funds, deletes, or replaces secrets.
    const AVOID = ['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'];
    const queued = ['h']; const done = new Set(); const view = [];
    while (queued.length) {
      const data = queued.shift();
      if (done.has(data)) continue;
      done.add(data);
      const n = w.sent.length;
      await w.bot.handle(cbq(data));
      const o = lastOut(w.sent);
      assert.ok(o && w.sent.length > n, `button ${data} produces nothing`);
      assert.ok(o.params.text && o.params.text.length > 10, `screen ${data} is empty`);
      assert.ok(!/undefined|NaN|\[object/.test(o.params.text), `screen ${data} leaks a raw value:\n${o.params.text}`);
      view.push(data);
      for (const b of buttons(o)) if (!AVOID.includes(String(b).split(':')[0])) queued.push(b);
    }
    assert.ok(view.length > 40, `the explorer only reached ${view.length} screens — too few`);
    // the important screens were really covered
    for (const required of ['o', 'p', 'p:1', 't', `t:${TARGET}`, 'a:0', 'r', 'r:0', 's', 'wb', 'sr', 'sf:gas', 'sf:mesin', 'sn', 'sc', 'f', 'l', 'x', 'b', 'ml', 'sw'])
      assert.ok(done.has(required), `screen ${required} was never reached`);
  });

  await t('all slash commands answer', async () => {
    const w = build();
    for (const c of ['/menu', '/summary', '/positions', '/targets', '/activity', '/rules', '/settings', '/balance', '/leftovers', '/logs', '/tx', '/help']) {
      const n = outs(w.sent).length;
      await w.bot.handle(msg(c));
      assert.ok(outs(w.sent).length > n, `${c} does not answer`);
      assert.ok(lastOut(w.sent).params.text.length > 10, `${c} answers with nothing`);
    }
  });

  await t('every command in the Telegram menu is really handled', async () => {
    const { COMMANDS } = require('../src/telegram');
    const w = build();
    for (const [c] of COMMANDS) {
      if (c === 'scout' || c === 'research') continue;   // both ask first, tested separately
      const n = outs(w.sent).length;
      await w.bot.handle(msg('/' + c));
      assert.ok(outs(w.sent).length > n, `/${c} is in the menu but does not answer`);
      assert.ok(!/tidak dikenal/i.test(lastOut(w.sent).params.text), `/${c} is registered in the menu but has no handler`);
    }
  });

  await t('nama perintah semuanya Inggris', async () => {
    const { COMMANDS } = require('../src/telegram');
    const INDO = ['ringkasan', 'posisi', 'target', 'aktivitas', 'aturan', 'pengaturan', 'saldo', 'sisa', 'riset', 'jeda', 'lanjut', 'bantuan', 'mulai'];
    for (const [c, d] of COMMANDS) {
      assert.ok(/^[a-z][a-z0-9_]{0,31}$/.test(c), `command name "${c}" is not valid per Telegram`);
      assert.ok(!INDO.includes(c), `command /${c} is still in Indonesian`);
      assert.ok(d && d.length <= 256, `the description of /${c} is empty or too long`);
    }
    // and that list is what is really registered with Telegram
    const w = build();
    await w.bot.start();
    const listing = w.sent.find((x) => x.method === 'setMyCommands');
    assert.ok(listing, 'setMyCommands must be called when the bot starts');
    assert.deepStrictEqual(listing.params.commands.map((x) => x.command), COMMANDS.map(([c]) => c));
    w.bot.stop();
  });

  await t('the old Indonesian names are still silently accepted', async () => {
    const w = build();
    for (const [old, fresh] of [['/ringkasan', '/summary'], ['/posisi', '/positions'], ['/bantuan', '/help']]) {
      await w.bot.handle(msg(fresh));
      const a = lastOut(w.sent).params.text;
      await w.bot.handle(msg(old));
      const b = lastOut(w.sent).params.text;
      assert.strictEqual(b.slice(0, 40), a.slice(0, 40), `${old} is no longer equivalent to ${fresh}`);
    }
    // …but does not appear in the menu the user sees
    const { COMMANDS } = require('../src/telegram');
    assert.ok(!COMMANDS.some(([c]) => c === 'ringkasan'));
  });

  await t('connecting uses /start, and its old form still works', async () => {
    for (const cmdName of ['/start', '/mulai']) {
      const w = build({ chats: [] });
      const passcode = w.bot.newPairCode();
      await w.bot.handle(msg(`${cmdName} ${passcode}`, FOREIGN));
      assert.ok(w.bot.chats().includes(FOREIGN), `${cmdName} <code> must connect the chat`);
    }
    // the hint shown to the user must mention /start
    const w = build({ chats: [] });
    await w.bot.handle(msg('/summary', FOREIGN));
    assert.match(lastOut(w.sent).params.text, /\/start KODE/);
  });

  await t('an unknown command is answered kindly, not with an error', async () => {
    const w = build();
    await w.bot.handle(msg('/entahapa'));
    assert.match(lastOut(w.sent).params.text, /tidak dikenal/i);
  });

  // ---- actions that change state -----------------------------------------
  await t('pause & resume change the real engine state', async () => {
    const w = build();
    await w.bot.handle(msg('/pause'));
    assert.strictEqual(w.store.getState('paused'), '1');
    assert.match(lastOut(w.sent).params.text, /dijeda/i);
    await w.bot.handle(msg('/resume'));
    assert.strictEqual(w.store.getState('paused'), '0');
  });

  await t('sakelar target menyalakan & mematikan di basis data', async () => {
    const w = build();
    await w.bot.handle(cbq(`tt:${TARGET}`));
    assert.strictEqual(w.store.get('SELECT enabled FROM targets WHERE address=?', TARGET).enabled, 0);
    await w.bot.handle(cbq(`tt:${TARGET}`));
    assert.strictEqual(w.store.get('SELECT enabled FROM targets WHERE address=?', TARGET).enabled, 1);
  });

  await t('add a target through conversation', async () => {
    const w = build();
    await w.bot.handle(cbq('ta'));
    assert.match(lastOut(w.sent).params.text, /alamat wallet/i);
    await w.bot.handle(msg('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd Bang Set'));
    const row = w.store.get('SELECT * FROM targets WHERE address=?', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    assert.ok(row, 'the new target must be stored');
    assert.strictEqual(row.label, 'Bang Set');
  });

  await t('a nonsense address is rejected with a message, not stored', async () => {
    const w = build();
    await w.bot.handle(cbq('ta'));
    await w.bot.handle(msg('bukan-alamat'));
    assert.match(lastOut(w.sent).params.text, /tidak valid/i);
    assert.strictEqual(w.store.get('SELECT COUNT(*) n FROM targets').n, 1);
  });

  await t('ganti nama target', async () => {
    const w = build();
    await w.bot.handle(cbq(`tn:${TARGET}`));
    await w.bot.handle(msg('Bang GE (utama)'));
    assert.strictEqual(w.store.get('SELECT label FROM targets WHERE address=?', TARGET).label, 'Bang GE (utama)');
  });

  // ---- rules editor --------------------------------------------------------
  await t('changing a rule figure is saved to the config', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_quote_per_position_usd');
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    assert.match(lastOut(w.sent).params.text, /Batas per posisi/);
    await w.bot.handle(msg('250'));
    assert.strictEqual(w.cfg.rules.sizing.max_quote_per_position_usd, 250);
    assert.strictEqual(JSON.parse(fs.readFileSync(w.cfgPath, 'utf8')).rules.sizing.max_quote_per_position_usd, 250);
  });

  await t('a value out of bounds is rejected and the old rule stays', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'swap');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_slippage_bps');
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    await w.bot.handle(msg('999999999'));
    assert.match(lastOut(w.sent).params.text, /antara/i);
    assert.strictEqual(w.cfg.rules.swap, undefined, 'the rule must not change if its value is rejected');
  });

  await t('a boolean rule switch flips', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'exit');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'follow_target');
    await w.bot.handle(cbq(`rb:${gi}:${fi}`));
    assert.strictEqual(w.cfg.rules.exit.follow_target, false);
    await w.bot.handle(cbq(`rb:${gi}:${fi}`));
    assert.strictEqual(w.cfg.rules.exit.follow_target, true);
  });

  await t('a choice (size mode) is saved via a button', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = 0;
    const oi = RULE_GROUPS[gi].fields[0].opts.findIndex(([k]) => k === 'mirror');
    await w.bot.handle(cbq(`rv:${gi}:${fi}:${oi}`));
    assert.strictEqual(w.cfg.rules.sizing.mode, 'mirror');
  });

  await t('a special per-target rule does not change the general rule', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_quote_per_position_usd');
    await w.bot.handle(cbq(`ts:${TARGET}`));           // switch scope to a target
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    await w.bot.handle(msg('75'));
    const own = JSON.parse(w.store.get('SELECT rules FROM targets WHERE address=?', TARGET).rules);
    assert.strictEqual(own.sizing.max_quote_per_position_usd, 75);
    assert.strictEqual(w.cfg.rules.sizing, undefined, 'the general rule must not change along with it');
    // and can be released again
    await w.bot.handle(cbq(`rx:${gi}:${fi}`));
    assert.strictEqual(w.store.get('SELECT rules FROM targets WHERE address=?', TARGET).rules, null);
  });

  await t('the rules scope is separate between chats', async () => {
    const w = build({ chats: [CHAT, FOREIGN] });
    await w.bot.handle(cbq(`ts:${TARGET}`, CHAT));
    assert.strictEqual(w.bot.sess(CHAT).scope, TARGET);
    assert.strictEqual(w.bot.sess(FOREIGN).scope, 'g');
  });

  // ---- engine settings ---------------------------------------------------
  await t('changing gas via the bot is saved to the config', async () => {
    const w = build();
    await w.bot.handle(cbq('sfe:gas:0'));              // gas price multiplier
    await w.bot.handle(msg('2'));
    assert.strictEqual(w.cfg.gas.price_multiplier, 2);
  });

  await t('an engine settings boolean switch flips', async () => {
    const w = build();
    const fi = require('../src/telegram').FORMS.mesin.fields.findIndex((f) => f.k === 'auto_eth_price');
    // on by default, so the first press turns it off
    await w.bot.handle(cbq(`sfb:mesin:${fi}`));
    assert.strictEqual(w.cfg.prices.auto_eth_price, false);
    await w.bot.handle(cbq(`sfb:mesin:${fi}`));
    assert.strictEqual(w.cfg.prices.auto_eth_price, true);
  });

  await t('the Telegram notification switch is saved', async () => {
    const w = build();
    assert.strictEqual(w.bot.notifCfg().info, false);
    await w.bot.handle(cbq('snb:info'));
    assert.strictEqual(w.bot.notifCfg().info, true);
  });

  // ---- safeguards ------------------------------------------------------------
  await t('mode LIVE butuh ketikan konfirmasi', async () => {
    const w = build();
    await w.bot.handle(cbq('sl'));
    assert.match(lastOut(w.sent).params.text, /Ketik <code>LIVE<\/code>/);
    await w.bot.handle(msg('iya'));                     // a wrong confirmation
    assert.strictEqual(w.cfg.mode.dry_run, true, 'LIVE must not turn on without the exact confirmation');
    await w.bot.handle(cbq('sl'));
    await w.bot.handle(msg('LIVE'));
    assert.strictEqual(w.cfg.mode.dry_run, false);
  });

  await t('closing a position takes two steps, and is refused in simulation', async () => {
    const w = build();
    await w.bot.handle(cbq('pc:1'));
    assert.match(lastOut(w.sent).params.text, /Tutup posisi #1/);
    assert.ok(buttons(lastOut(w.sent)).includes('pC:1'), 'there must be a confirmation button');
    await w.bot.handle(cbq('pC:1'));
    assert.match(lastOut(w.sent).params.text, /simulasi/i, 'simulation mode must refuse');
  });

  await t('a real position close calls the engine in LIVE', async () => {
    const w = build({ dryRun: false });
    let called = null;
    w.engine.executeExit = async (plan, pos) => { called = { plan, pos }; return { txHash: '0xee' }; };
    await w.bot.handle(cbq('pC:1'));
    assert.ok(called, 'executeExit must be called');
    assert.strictEqual(called.plan.full, true);
    assert.strictEqual(called.pos.id, 1);
    assert.match(lastOut(w.sent).params.text, /ditutup/i);
  });

  await t('the bot never offers a private key import/export path', async () => {
    const w = build();
    await w.bot.handle(cbq('wb'));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /sengaja tidak disediakan/i);
    for (const b of buttons(lastOut(w.sent))) assert.ok(!/import|impor|export|ekspor/i.test(b));
    // and no import route can be reached from anywhere in the bot
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    assert.ok(!src.includes('/api/settings/wallet/import'), 'telegram.js must not call the key import route');
  });

  await t('replacing the wallet is still refused in LIVE (the dashboard rule applies too)', async () => {
    const w = build({ dryRun: false });
    await w.bot.handle(cbq('wbG'));
    assert.match(lastOut(w.sent).params.text, /Matikan mode LIVE/i);
  });

  // ---- notifications ----------------------------------------------------------
  await t('important news from the engine reaches the chat', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify = (m) => { w.engine.onNotify?.(m); };
    w.engine.notify('LP disalin: USDG/MEME $200');
    await new Promise((r) => setTimeout(r, 50));
    const o = outs(w.sent).find((x) => /Posisi disalin/.test(x.params.text));
    assert.ok(o, 'important news must be sent');
    assert.strictEqual(String(o.params.chat_id), CHAT);
    w.bot.stop();
  });

  await t('news of a copied LP becomes a card: pair, value, range, target, tx, buttons', async () => {
    const w = build({ dryRun: false });
    // The cost of opening position #1: zap (gas + quote difference) then mint. The entry card
    // must mention it — gas and slippage never show up in PnL.
    const open = Date.now() - 3600_000;
    w.store.run("INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES('0xzapcc',?,'zap_swap','sukses',100000,'1000000000',?)",
      open - 10_000, JSON.stringify({ pool: '0xpool', usdIn: 100, usdOut: 99.4 }));
    w.store.run("INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES('0xcc',?,'mint','sukses',200000,'1000000000',?)",
      open, JSON.stringify({ pool: '0xpool', recorded: 1, zapped: { hashes: ['0xzapcc'] } }));
    await w.bot.start();
    w.engine.notify('LP disalin: USDG/MEME $200,00', {
      kind: 'entry', positionId: 1, txHash: '0xmint1234567890', adding: false, pair: 'USDG/MEME', valueUsd: 200,
      curTick: 0, steps: ['bungkus 0.05000 ETH', 'zap beli token1 via Kyber'],
      target: TARGET, mirrorOf: '777', reason: 'target membuka posisi baru',
    });
    await new Promise((r) => setTimeout(r, 80));
    const o = outs(w.sent).find((x) => /Posisi disalin/.test(x.params.text));
    assert.ok(o, 'the card must be sent');
    const body = o.params.text;
    assert.match(body, /🟢 LIVE/);
    assert.match(body, /<b>USDG\/MEME<\/b>/);
    assert.match(body, /\$200,00/);
    assert.match(body, /Rentang harga — MEME dalam USDG/);
    assert.match(body, /●/, 'the range bar must have a point (current price from the mint tick)');
    assert.match(body, /Bang GE/, 'the target name must show');
    assert.match(body, /NFT #777/);
    // Origin block: the target's size beside our size, from the watched action.
    assert.match(body, /Dia masuk\s+\$200,00/, `the target amount must show: ${body}`);
    assert.match(body, /Kita masuk\s+\$200,00/);
    assert.match(body, /Porsi kita\s+100%/, 'our share relative to the target must show');
    assert.match(body, /Target membuka posisi baru/);
    assert.match(body, /bungkus 0.05000 ETH · zap beli token1 via Kyber/);
    // gas 0.0003 ETH × $2500 = $0.75 · zap difference $0.60
    assert.match(body, /⛽ Ongkos <b>\$1,35<\/b>/, `the opening cost must be printed: ${body}`);
    assert.match(body, /slippage \$0,60/);
    assert.match(body, /0xmint1234/);
    assert.ok(!/LP disalin:/.test(body), 'the old plain text must not also be printed');
    const button = o.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(button.includes('p:1') && button.includes('pc:1'), `the position/close buttons must exist: ${button}`);
    // URL buttons to trading terminals point at the speculative token (MEME), not USDG.
    const url = o.params.reply_markup.inline_keyboard.flat().filter((b) => b.url).map((b) => b.url);
    assert.strictEqual(url.length, 4, `four trading buttons: ${url}`);
    assert.ok(url.every((u) => u.toLowerCase().includes(MEME.toLowerCase())), `all point at MEME: ${url}`);
    assert.ok(url.some((u) => u.startsWith('https://gmgn.ai/')) && url.some((u) => u.startsWith('https://t.me/based_eth_bot')) && url.some((u) => u.startsWith('https://fomo.family/')) && url.some((u) => u.startsWith('https://app.uniswap.org/')));
    // the fixture pool_ref ('0xpool') is not a real address/id, so Uniswap falls back to the token swap screen.
    assert.ok(url.some((u) => u.includes('/swap?chain=robinhood&outputCurrency=')), `tanpa pool valid, Uniswap = swap token: ${url}`);
    w.bot.stop();
  });

  await t('news of a closed LP becomes a card: proceeds, capital, PnL, reason, leftover sold', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('LP ditutup: tutup penuh posisi #2', {
      kind: 'exit', positionId: 2, txHash: '0xburn1234567890', full: true, sold: 'jual 1234 MEME → $4,20 (kyber)',
      target: TARGET, mirrorOf: '778', reason: 'target menarik 100% likuiditas',
    });
    await new Promise((r) => setTimeout(r, 80));
    const o = outs(w.sent).find((x) => /Posisi ditutup/.test(x.params.text));
    assert.ok(o, 'the card must be sent');
    const body = o.params.text;
    assert.match(body, /🧪 SIMULASI/);
    // The result must go on the pair line: a phone notification preview is cut at about
    // a hundred characters, and "position closed" without its figure tells nothing.
    assert.match(body, /<b>USDG\/MEME<\/b> · 📈 <b>\+\$12,00<\/b> \+12,0%/);
    assert.match(body, /\nNFT #889\n/);
    assert.ok(body.replace(/<[^>]+>/g, '').slice(0, 100).includes('+$12,00'),
      'the profit must fit in the first hundred characters (notification preview)');
    assert.match(body, /📈 Untung <b>\+\$12,00<\/b>\s+\+12,0%/);
    assert.match(body, /Hasil\s+\$112,00/);
    assert.match(body, /Modal\s+\$100,00/);
    assert.match(body, /Target menarik 100% likuiditas/);
    assert.match(body, /🧹 Menjual 1234 MEME → \$4,20/);
    assert.match(body, /0xburn1234/);
    w.bot.stop();
  });

  await t('the close card sets the target\'s result beside ours', async () => {
    const w = build();
    const now = Date.now();
    // Position #2 was made a mirror of the target's NFT #778, and two target actions on that NFT
    // are recorded: entered $500 then exited $560. The card must be able to answer "how much did
    // the one we copy make" without any wallet research at all.
    w.store.run("UPDATE positions SET target=?, mirror_of='778', opened_ts=? WHERE id=2", TARGET, now - 7500_000);
    w.store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,value_quote,quote_symbol)
      VALUES(2,?,101,'0xa2',0,?,'v4','increase','778','0xpool',?,?,3000,-600,600,'2000',500,'USDG')`, now - 7600_000, TARGET, ADDR.usdg, MEME);
    w.store.run(`INSERT INTO actions(id,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,value_quote,quote_symbol)
      VALUES(3,?,102,'0xa3',0,?,'v4','decrease','778','0xpool',?,?,3000,-600,600,'-2000',560,'USDG')`, now - 7300_000, TARGET, ADDR.usdg, MEME);
    await w.bot.start();
    w.engine.notify('LP ditutup: tutup penuh posisi #2', {
      kind: 'exit', positionId: 2, txHash: '0xburn1234567890', full: true,
      target: TARGET, mirrorOf: '778', reason: 'target menutup posisi', targetUsd: 560, targetTs: now - 7300_000,
    });
    await new Promise((r) => setTimeout(r, 80));
    const body = outs(w.sent).find((x) => /Posisi ditutup/.test(x.params.text))?.params.text;
    assert.ok(body, 'the card must be sent');
    assert.match(body, /Meniru <b>Bang GE<\/b>/, `the card must name who is copied: ${body}`);
    assert.match(body, /Posisi dia\s+NFT #778/);
    assert.match(body, /Dia masuk\s+\$500,00/);
    assert.match(body, /Dia tarik\s+\$560,00/);
    assert.match(body, /Hasil dia\s+\+\$60,00\s+\+12,0%/, `the target's result must be computed from its actions: ${body}`);
    assert.match(body, /Hasil kita\s+\+\$12,00/);
    assert.match(body, /Dia pegang\s+5 menit/);
    assert.match(body, /pokok yang terpantau/, 'the precision limit of the target figure must be stated');
    w.bot.stop();
  });

  await t('a standalone exit and a leftover sold have their own cards', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('keluar mandiri #2: stop loss -12.0%', { kind: 'exit', positionId: 2, txHash: '0xee', full: true, auto: true, reason: 'stop loss -12.0%' });
    w.engine.notify('posisi #1: jual 5.000 MEME → $4.20 (uji-dex)', { kind: 'leftover', positionId: 1, txHash: '0xswap', label: '5.000 MEME', usdIn: 5, usdOut: 4.2, dex: 'uji-dex', tries: 2 });
    await new Promise((r) => setTimeout(r, 1300));
    const body = outs(w.sent).map((x) => x.params.text);
    const outgoing = body.find((x) => /Aturan keluar terpicu/.test(x));
    assert.ok(outgoing, 'the standalone exit card must be sent');
    assert.match(outgoing, /Batas kerugian tercapai: -12.0%/);
    const leftover = body.find((x) => /Token sisa terjual/.test(x));
    assert.ok(leftover, 'the leftover card must be sent');
    assert.match(leftover, /\$4,20/);
    assert.match(leftover, /Selisih\s+−16,0%/);
    assert.match(leftover, /uji-dex/);
    assert.match(leftover, /ke-3/);
    w.bot.stop();
  });

  await t('a leftover REFUSED for sale becomes an alarm card: loss figure, limit, schedule, and way-out buttons', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('SISA BELUM TERJUAL: 6.882e+5 MEME dari posisi #1 — rute Kyber rugi 60.8% (batas 15.0%) — $229.44 → $90.01', {
      kind: 'leftover_stuck', positionId: 1, token: MEME, label: '6.882e+5 MEME', why: 'rute Kyber rugi 60.8% (batas 15.0%) — $229.44 → $90.01',
      tries: 1, next: Date.now() + 5000, retrySec: 5, usdIn: 229.44, usdOut: 90.01, lossBps: 6080, maxLossBps: 1500,
    });
    w.engine.notify('SISA BELUM TERJUAL: 6.882e+5 MEME dari posisi #1 — rute tidak ada', {
      kind: 'leftover_stuck', positionId: 1, token: MEME, label: '6.882e+5 MEME', why: 'rute tidak ada', tries: 4321, retrySec: 5,
      reminder: true, since: Date.now() - 6 * 3600_000,
    });
    await new Promise((r) => setTimeout(r, 1300));
    const cardMsg = outs(w.sent).filter((x) => /Penjualan sisa tertunda/.test(x.params.text));
    assert.strictEqual(cardMsg.length, 2, 'two alarm cards must be sent');
    const [a, b] = cardMsg.map((x) => x.params.text);
    assert.match(a, /⚠️/);
    assert.match(a, /6\.882e\+5 MEME/);
    assert.match(a, /60,8%/);
    assert.match(a, /15,0%/);
    assert.match(a, /\$229,44/);
    assert.match(a, /\$90,01/);
    assert.match(a, /tiap 5 dtk/);
    assert.match(a, /Jumlah percobaan\s+1×/);
    assert.match(b, /Rute tidak tersedia/);
    assert.match(b, /[Ss]ejak/);
    const button = JSON.stringify(cardMsg[0].params.reply_markup || {});
    for (const cb of ['"fr"', '"sw"', '"f"', '"r"']) assert.ok(button.includes(cb), `button ${cb} must exist`);
    w.bot.stop();
  });

  await t('news without detail or with an unknown position is still sent as text', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('kabar bebas tanpa detail');
    w.engine.notify('LP ditutup: posisi #999', { kind: 'exit', positionId: 999, full: true, txHash: '0xzz' });
    await new Promise((r) => setTimeout(r, 1300));
    const body = outs(w.sent).map((x) => x.params.text);
    assert.ok(body.some((x) => /🔔 <b>kabar bebas tanpa detail<\/b>/.test(x)), 'plain text must still be sent');
    assert.ok(body.some((x) => /Posisi ditutup/.test(x) && /posisi #999/.test(x)), 'a card without position data is still sent');
    w.bot.stop();
  });

  await t('summary: portfolio, PnL, positions, track record, sources, copying', async () => {
    const w = build();
    w.engine.cash = { usdg: 150, eth: 0.1, weth: 0, usd: 400, ts: Date.now() };
    await w.bot.handle(cbq('o'));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /✅ Sehat/);
    assert.match(body, /💰 Portofolio <b>\$606,50<\/b>/, `value = cash + positions + fee:\n${body}`);
    assert.match(body, /PnL <b>🟢 \+\$18,50<\/b>/);
    assert.match(body, /Kas wallet\s+\$400,00/);
    assert.match(body, /Posisi terbuka · 1/);
    assert.match(body, /USDG\/MEME\s+Bang GE\s+🟢 \+\$6,50/);
    assert.match(body, /Rekam jejak · 1 ditutup/);
    assert.match(body, /Bang GE\s+1 buka/);
    assert.match(body, /Akan disalin \(simulasi\)/);
    assert.ok(!/24 jam \+\$0,00/.test(body), 'without history, the 24-hour change must not show as zero');
    assert.ok(!/0 dtk lalu/.test(body), 'a sync just written reads "just now"');
  });

  await t('summary: the health line names the first problem that exists', async () => {
    const w = build();
    w.engine.head = 1200; w.engine.cursor = 1000;
    await w.bot.handle(cbq('o'));
    assert.match(lastOut(w.sent).params.text, /⚠️ <b>Tertinggal 200 blok<\/b>/);
    w.store.setState('paused', '1');
    await w.bot.handle(cbq('h'));
    assert.match(lastOut(w.sent).params.text, /⏸ <b>Dijeda<\/b>/);
  });

  await t('an error handled by the fallback is not sent; stuck continuously = one warning, then one recovery notice', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    const eng = Object.assign(Object.create(Engine.prototype), { store: w.store, troubles: new Map() });
    // four failures: handled by the fallback -> silent
    for (let i = 0; i < 4; i++) eng.trouble('tick', `tick: eth_getLogs: historical state is not available — rentang -> 750`, { after: 5 });
    await new Promise((r) => setTimeout(r, 30));
    const sendOrig = () => w.bot.queue.map((x) => x.text).concat(outs(w.sent).map((x) => x.params.text)).filter((x) => /getLogs|pemindaian/.test(x));
    assert.strictEqual(sendOrig().length, 0, `a momentary error must not be sent:\n${sendOrig().join('\n')}`);
    assert.ok(w.store.all("SELECT 1 FROM logs WHERE msg LIKE 'tick:%'").length >= 4, 'the error is still recorded in the log');
    // the fifth: the fallback is considered failed -> one warning, silent again next time
    eng.trouble('tick', 'tick: eth_getLogs: historical state is not available — rentang -> 375', { after: 5 });
    eng.trouble('tick', 'tick: eth_getLogs: historical state is not available — rentang -> 150', { after: 5 });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(sendOrig().length, 1, `there must be exactly one warning:\n${sendOrig().join('\n')}`);
    assert.match(sendOrig()[0], /⛔ <b>Galat · tick<\/b>[\s\S]*gagal 5× berturut-turut/);
    // recovered -> one notice, and the count starts from zero
    eng.cleared('tick', 'pemindaian blok: kembali normal, kursor di blok 1000');
    eng.cleared('tick', 'pemindaian blok: kembali normal');
    await new Promise((r) => setTimeout(r, 1200));
    const everything = sendOrig();
    assert.strictEqual(everything.length, 2, `there must be one recovery notice:\n${everything.join('\n')}`);
    assert.match(everything[1], /✅ <b>Pulih · pemindaian blok<\/b>\nkembali normal, kursor di blok 1000 — pulih setelah 6× gagal/);
    // a momentary failure that never warned -> the recovery is also silent
    eng.trouble('kas', 'saldo kas: RPC 429', { after: 5 });
    eng.cleared('kas', 'saldo kas: berhasil lagi');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!sendOrig().concat(w.bot.queue.map((x) => x.text)).some((x) => /saldo kas/.test(x)), 'a recovery without a warning is not reported');
    w.bot.stop();
  });

  await t('an error without a fallback (e.g. entry execution) is still sent right away', async () => {
    const w = build();
    await w.bot.start();
    w.store.log('error', 'eksekusi masuk: saldo USDG kurang');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(w.bot.queue.concat(outs(w.sent).map((x) => ({ text: x.params.text }))).some((x) => /saldo USDG kurang/.test(x.text)));
    w.bot.stop();
  });

  await t('an error is sent, an info line is not (default setting)', async () => {
    const w = build();
    await w.bot.start();
    w.store.log('error', 'uji: sesuatu meledak');
    w.store.log('info', 'uji: kabar biasa');
    await new Promise((r) => setTimeout(r, 50));
    const body = outs(w.sent).map((x) => x.params.text).join('\n');
    assert.match(body, /sesuatu meledak/);
    assert.match(body, /⛔ <b>Galat · uji<\/b>\nsesuatu meledak/, 'the error context must become the title');
    assert.ok(!/kabar biasa/.test(body), 'an info line must not be sent if its setting is off');
    w.bot.stop();
  });

  await t('important news is not sent twice even though log lines are switched on', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    await w.bot.handle(cbq('snb:info'));                // switch on log line delivery
    // the engine's REAL notify(), so the order "notify the listener then write the log"
    // is also tested — if the order were reversed, the echo would slip through and this test would go red.
    // text that appears on no screen, so the count is clean
    Engine.prototype.notify.call(w.engine, 'kabar-uji-unik-9137');
    const n = w.bot.queue.filter((x) => /9137/.test(x.text)).length
      + outs(w.sent).filter((x) => /9137/.test(x.params.text)).length;
    assert.strictEqual(n, 1, `the same news entered the queue ${n} times`);
    // ordinary log lines are still sent when that setting is on
    Engine.prototype.notify.call(w.engine, 'kabar lain');
    w.store.log('info', 'benar-benar baris log');
    assert.ok(w.bot.queue.some((x) => /benar-benar baris log/.test(x.text)), 'an ordinary log line must still be sent');
    w.bot.stop();
  });

  await t('the leftover queue states how many times it has been tried and since when', async () => {
    const w = build();
    await w.bot.handle(cbq('f'));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /Percobaan\s+2×/, `wrong queue text:\n${body}`);
    assert.match(body, /Sejak\s+\d+ (dtk|mnt) lalu/, `the time it started being stuck must show:\n${body}`);
    assert.match(body, /rugi rute rugi 18%|rute rugi 18%/);
  });

  await t('a log flood does not pile up the queue without bound', async () => {
    const w = build();
    await w.bot.start();
    for (let i = 0; i < 500; i++) w.store.log('error', `banjir ${i}`);
    assert.ok(w.bot.queue.length <= 41, `the queue ballooned to ${w.bot.queue.length}`);
    w.bot.stop();
  });

  // ---- installing a token without restarting the process ------------------
  await t('a bot that is alive without a token starts right away once its token is saved', async () => {
    const w = build({ chats: [] });
    w.cfg.telegram.bot_token = null;                 // exactly the state of a process that was alive first
    const r0 = await w.bot.start();
    assert.strictEqual(r0.ok, false);
    assert.strictEqual(w.bot.polls.length, 0, 'without a token there must be no polling');

    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.telegram.running, true, 'the dashboard must report that the bot is running');
    assert.strictEqual(w.bot.polls.length, 1, 'polling must start without a process restart');
    assert.ok(w.bot.me, 'getMe must already have been called');
    w.bot.stop();
  });

  await t('a connect code made after the token is saved can really be used', async () => {
    const w = build({ chats: [] });
    w.cfg.telegram.bot_token = null;
    await w.bot.start();
    await w.api('POST', '/api/settings/telegram', { bot_token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });
    const r = await w.api('POST', '/api/settings/telegram/pair', {});
    assert.ok(r.code, 'the code must be created');
    await w.bot.handle(msg(`/start ${r.code}`, FOREIGN));
    assert.ok(w.bot.chats().includes(FOREIGN), 'the code from the dashboard must be accepted by the bot');
    w.bot.stop();
  });

  await t('replacing the token stops the old listener (there are not two loops)', async () => {
    const w = build();
    await w.bot.start();
    const gen1 = w.bot.polls.at(-1);
    await w.api('POST', '/api/settings/telegram', { bot_token: '111111111:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' });
    const gen2 = w.bot.polls.at(-1);
    assert.ok(gen2 > gen1, 'the generation must rise so the old loop stops by itself');
    assert.strictEqual(w.bot.gen, gen2, 'only the last generation applies');
    w.bot.stop();
    assert.ok(w.bot.gen > gen2, 'stop() must also cancel the running generation');
  });

  await t('restarting does not multiply the news', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    await w.bot.restart();
    await w.bot.restart();
    Engine.prototype.notify.call(w.engine, 'kabar-uji-unik-4412');
    const n = w.bot.queue.filter((x) => /4412/.test(x.text)).length
      + outs(w.sent).filter((x) => /4412/.test(x.params.text)).length;
    assert.strictEqual(n, 1, `news sent ${n} times after three startups`);
    w.bot.stop();
  });

  await t('a token rejected by Telegram is reported, not silenced', async () => {
    const w = build();
    const original = w.bot.tg.bind(w.bot);
    w.bot.tg = async (m, p) => { if (m === 'getMe') throw new Error('401: Unauthorized'); return original(m, p); };
    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '222222222:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' });
    assert.match(r.error || '', /menolaknya|Unauthorized/i, 'an error from Telegram must reach the dashboard');
    assert.strictEqual(w.cfg.telegram.bot_token, '222222222:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'the token stays stored so it can be fixed');
    w.bot.stop();
  });

  await t('melepas token menghentikan bot', async () => {
    const w = build();
    await w.bot.start();
    const n = w.bot.polls.length;
    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '' });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.telegram.hasToken, false);
    assert.strictEqual(w.bot.polls.length, n, 'without a token there must be no new polling');
  });

  await t('loop polling SUNGGUHAN berhenti sendiri begitu generasinya kedaluwarsa', async () => {
    const { Telegram } = require('../src/telegram');
    const w = build();
    w.bot.poll = Telegram.prototype.poll.bind(w.bot);   // the real loop, not the recorder
    const callList = [];
    const original = w.bot.tg.bind(w.bot);
    w.bot.tg = async (m, p) => {
      if (m !== 'getUpdates') return original(m, p);
      callList.push(w.bot.gen);                        // the generation belonging to the calling loop
      await new Promise((r) => setTimeout(r, 15));
      return [];
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await w.bot.start();
    await wait(70);
    const oldGen = w.bot.gen;
    assert.ok(callList.filter((g) => g === oldGen).length >= 2, 'the first loop must really run');

    const limit = callList.length;
    await w.bot.restart();
    await wait(90);
    const after = callList.slice(limit);
    assert.ok(!after.includes(oldGen), `the old loop still calls getUpdates ${after.filter((g) => g === oldGen).length}x after the token was replaced`);
    assert.ok(after.includes(w.bot.gen), 'the new loop must take over');

    w.bot.stop();
    const end = callList.length;
    await wait(90);
    assert.strictEqual(callList.length, end, 'stop() must really stop the polling');
  });

  // ---- reading & writing values ---------------------------------------
  await t('parseVal accepts human-friendly forms and rejects nonsense', async () => {
    const bps = { type: 'bps', lo: 0, hi: 10000 };
    assert.strictEqual(parseVal(bps, '150'), 150);
    assert.strictEqual(parseVal(bps, '1,5%'), 150);
    assert.strictEqual(parseVal({ type: 'usd', lo: 0, hi: 1e9 }, '$1.5'), 1.5);
    assert.deepStrictEqual(parseVal({ type: 'daftar' }, 'USDG, ETH'), ['USDG', 'ETH']);
    assert.deepStrictEqual(parseVal({ type: 'daftar' }, '-'), []);
    assert.strictEqual(parseVal({ type: 'int', lo: 0, hi: 100 }, '7,6'), 8);
    assert.throws(() => parseVal({ type: 'num', lo: 0, hi: 10 }, 'abc'), /angka/);
    assert.throws(() => parseVal({ type: 'num', lo: 0, hi: 10 }, '99'), /antara/);
    assert.throws(() => parseVal({ type: 'pilih', opts: [['a', 'A']] }, 'z'), /pilihannya/);
  });

  await t('showVal shows bps as a percent, not a raw number', async () => {
    assert.strictEqual(showVal({ type: 'bps' }, 150), '1,5%');
    assert.strictEqual(showVal({ type: 'bps' }, 500), '5%');
    assert.strictEqual(showVal({ type: 'bool' }, true), '✅ Ya');
    assert.strictEqual(showVal({ type: 'daftar' }, []), '(kosong)');
    // the Indonesian thousands separator is a dot: "1.000" must not be trimmed to "1."
    assert.strictEqual(showVal({ type: 'int' }, 1000), '1.000');
    assert.strictEqual(showVal({ type: 'int' }, 4000000), '4.000.000');
    assert.strictEqual(showVal({ type: 'num' }, 0.004), '0,004');
  });

  await t('every rule field really exists in the rules engine', async () => {
    const { DEFAULTS } = require('../src/policy');
    for (const g of RULE_GROUPS) {
      assert.ok(DEFAULTS[g.g], `group ${g.g} is not in policy.js`);
      for (const f of g.fields) {
        assert.ok(f.k in DEFAULTS[g.g], `rule ${g.g}.${f.k} is in the menu but unknown to policy.js`);
      }
    }
    // and conversely: no rule is forgotten from the menu
    for (const [g, obj] of Object.entries(DEFAULTS)) {
      const grp = RULE_GROUPS.find((x) => x.g === g);
      assert.ok(grp, `rule group ${g} has no menu in the bot yet`);
      for (const k of Object.keys(obj)) {
        assert.ok(grp.fields.some((f) => f.k === k), `rule ${g}.${k} cannot yet be set from the bot`);
      }
    }
  });

  // ---- manual LP -----------------------------------------------------------
  await t('manual LP plan: amount and range are computed correctly', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.plan.action, 'mint');
    assert.strictEqual(r.plan.target, null, 'a manual LP must not mirror anyone');
    assert.strictEqual(r.plan.mirrorOf, null);
    assert.ok(Math.abs(r.preview.valueUsd - 50) < 0.5, `value ${r.preview.valueUsd}, asked $50`);
    // ±25% at tick 0 -> ln(1.25)/ln(1.0001) ≈ 2231 ticks, rounded to a multiple of 60
    assert.ok(r.plan.tickLower <= -2220 && r.plan.tickLower >= -2280, `tickLower ${r.plan.tickLower}`);
    assert.ok(r.plan.tickUpper >= 2220 && r.plan.tickUpper <= 2280, `tickUpper ${r.plan.tickUpper}`);
    assert.strictEqual(Math.abs(r.plan.tickLower % 60), 0, 'the tick must be a multiple of tickSpacing');
    assert.strictEqual(Math.abs(r.plan.tickUpper % 60), 0);
    assert.strictEqual(r.preview.side, 'both');
  });

  await t('manual LP plan: the balance and the auto-swap that will run are also previewed', async () => {
    const w = build();
    // Enough USDG cash: no bridge needed, just the USDG -> MEME zap.
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    const sw = r.preview.swaps;
    assert.deepStrictEqual(sw.map((x) => x.jenis), ['zap']);
    assert.strictEqual(sw[0].dari.symbol, 'USDG');
    assert.strictEqual(sw[0].ke.symbol, 'MEME');
    // paid with 1.5% slippage room on the MEME portion (~half the position value)
    assert.ok(sw[0].dari.usd > 24 && sw[0].dari.usd < 27, `zap ${sw[0].dari.usd}`);
    const balance = Object.fromEntries(r.preview.saldo.tokens.map((x) => [x.symbol, x]));
    assert.strictEqual(balance.USDG.amount, 150);
    assert.ok(balance.USDG.after > 99 && balance.USDG.after < 101, `USDG after ${balance.USDG.after}`);
    assert.ok('MEME' in balance, 'token pasangan pool ikut ditampilkan');

    // Cash only in ETH: bridge ETH -> USDG first, then the zap.
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(), t2 === ADDR.native ? 10n ** 17n : 0n]));
    const e = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!e.error, e.error);
    assert.deepStrictEqual(e.preview.swaps.map((x) => x.jenis), ['jembatan', 'zap']);
    assert.strictEqual(e.preview.swaps[0].dari.symbol, 'ETH');
    assert.ok(Math.abs(e.preview.swaps[0].ke.amount - 52.5) < 0.01, 'the bridge provides 105% of the position value');
    assert.ok(!e.warnings.some((x) => /jembatan|zap/.test(x)), e.warnings.join('; '));

    // Auto-swap switched off: the step is still visible, and a warning that it will stop.
    w.engine.rulesFrom = () => { const x = rulesFor(w.engine.cfg.rules, null); x.swap.enabled = false; return x; };
    const off = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(off.warnings.some((x) => /auto-swap dimatikan/.test(x)), off.warnings.join('; '));

    const sd = await w.api('GET', '/api/manual/saldo', {}, { poolRef: '0xpool' });
    assert.ok(!sd.error, sd.error);
    assert.ok(Math.abs(sd.walletCashUsd - 250) < 0.01, `cash ${sd.walletCashUsd}`);
  });

  await t('a narrower range produces denser liquidity', async () => {
    const w = build();
    const a = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 5 });
    const b = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 50 });
    assert.ok(BigInt(a.plan.liquidity) > BigInt(b.plan.liquidity),
      'the same amount in a narrower range must give a larger L');
    assert.ok(Math.abs(a.preview.valueUsd - b.preview.valueUsd) < 1, 'its value is still the same $50');
  });

  await t('one-sided is available in manual LP and the Telegram shortcut', async () => {
    const w = build();
    await w.bot.handle(cbq('mlr'));
    assert.ok(buttons(lastOut(w.sent)).includes('mlw:25:0'));
    assert.ok(buttons(lastOut(w.sent)).includes('mlw:0:25'));
    await w.bot.handle(cbq('mlw:25:0'));
    assert.strictEqual(w.bot.sess(CHAT).lp.upperPct, 0);
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, lowerPct: 25, upperPct: 0 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.plan.amount1, '0');
    assert.strictEqual(r.plan.singleSide, 'token0');
  });

  await t('auto-compound can be set per position from Telegram', async () => {
    const w = build();
    await w.bot.handle(cbq('p:1'));
    assert.ok(buttons(lastOut(w.sent)).includes('ac:1'));
    await w.bot.handle(cbq('ac:1'));
    assert.match(lastOut(w.sent).params.text, /OFF/);
    await w.bot.handle(cbq('acM:1'));
    await w.bot.handle(msg('2,5'));
    await w.bot.handle(cbq('acI:1'));
    await w.bot.handle(msg('60'));
    await w.bot.handle(cbq('acT:1:1'));
    let r = await w.api('GET', '/api/positions/compound', {}, { id: 1 });
    assert.equal(r.compound.enabled, true);
    assert.equal(r.compound.minUsd, 2.5);
    assert.equal(r.compound.intervalMinutes, 60);
    await w.bot.handle(cbq('acT:1:0'));
    r = await w.api('GET', '/api/positions/compound', {}, { id: 1 });
    assert.equal(r.compound.enabled, false);
    assert.ok((await w.api('POST', '/api/positions/compound', { id: 1, intervalMinutes: 0 })).error);
    assert.ok((await w.api('POST', '/api/positions/compound', { id: 2, enabled: true })).error);
  });

  await t('the Telegram fee claim asks for confirmation then uses the shared endpoint', async () => {
    const w = build({ dryRun: false });
    const calls = [];
    w.engine.claimFees = async (id, opts) => {
      calls.push([id, opts.sell]);
      return { ok: true, tx: '0xclaim', claimedUsd: 1.5, ...(opts.sell ? { sold: 'jual MEME → $1.20 (kyber)' } : {}) };
    };
    await w.bot.handle(cbq('p:1'));
    assert.ok(buttons(lastOut(w.sent)).includes('pf:1'));
    await w.bot.handle(cbq('pf:1'));
    assert.deepStrictEqual(calls, []);
    assert.ok(buttons(lastOut(w.sent)).includes('pF:1:0'));
    assert.ok(buttons(lastOut(w.sent)).includes('pF:1:1'), 'claim + sell button');
    await w.bot.handle(cbq('pF:1:0'));
    assert.deepStrictEqual(calls, [[1, false]]);
    assert.match(lastOut(w.sent).params.text, /tetap terbuka/);
    await w.bot.handle(cbq('pF:1:1'));
    assert.deepStrictEqual(calls[1], [1, true]);
    assert.match(lastOut(w.sent).params.text, /jual MEME/);
    // an old button in the chat (without :0/:1): follows the position's harvest setting
    await w.bot.handle(cbq('pF:1'));
    assert.deepStrictEqual(calls[2], [1, null]);
    assert.ok((await w.api('POST', '/api/positions/claim', { id: -1 })).error);
  });

  await t('asymmetric range: down 10% / up 30% from the current price', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, lowerPct: 10, upperPct: 30 });
    assert.ok(!r.error, r.error);
    // rounded WIDENING to the tick spacing: never narrower than requested
    assert.ok(r.preview.lowerPct >= 10 - 1e-9 && r.preview.lowerPct < 12, `lower ${r.preview.lowerPct}`);
    assert.ok(r.preview.upperPct >= 30 - 1e-9 && r.preview.upperPct < 33, `upper ${r.preview.upperPct}`);
    const bad = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, lowerPct: 100, upperPct: 10 });
    assert.match(bad.error || '', /batas bawah/);
  });

  await t('Telegram range: "10 30", "-10 +30", "−10/+30", "25"', async () => {
    const { parseRange, rangeText } = require('../src/telegram');
    for (const x of ['10 30', '-10 +30', '−10/+30', '10% 30%', '10, 30']) {
      assert.deepStrictEqual(parseRange(x), { lowerPct: 10, upperPct: 30 }, x);
    }
    assert.deepStrictEqual(parseRange('25'), { lowerPct: 25, upperPct: 25 });
    assert.deepStrictEqual(parseRange('2,5 7,5'), { lowerPct: 2.5, upperPct: 7.5 });
    assert.deepStrictEqual(parseRange('10-30'), { lowerPct: 10, upperPct: 30 }, 'a dash = separator, not a sign');
    // An explicit sign moves the bound to the other side of the current price.
    assert.deepStrictEqual(parseRange('-30 -10'), { lowerPct: 30, upperPct: -10 });
    assert.deepStrictEqual(parseRange('−10 −30'), { lowerPct: 30, upperPct: -10 }, 'urutan terbalik dirapikan');
    assert.deepStrictEqual(parseRange('+10 +30'), { lowerPct: -10, upperPct: 30 });
    assert.strictEqual(rangeText({ lowerPct: 30, upperPct: -10 }), '−30% / −10%');
    assert.strictEqual(rangeText({ lowerPct: -10, upperPct: 30 }), '+10% / +30%');
    assert.strictEqual(rangeText({ lowerPct: 25, upperPct: 0 }), '−25% / 0%');
    assert.ok(parseRange('-10 -10').error);
    assert.ok(parseRange('-100 -10').error);
    assert.ok(parseRange('100 10').error);
    assert.ok(parseRange('0 0').error);
    assert.ok(parseRange('1 2 3').error);
    assert.ok(parseRange('lebar').error);
    assert.strictEqual(rangeText({ lowerPct: 10, upperPct: 30 }), '−10% / +30%');
    assert.strictEqual(rangeText({ lowerPct: 25, upperPct: 25 }), '±25%');
    assert.strictEqual(rangeText({ widthPct: 25 }), '±25%', 'old session');

    const w = build();
    await w.bot.handle(cbq('ml'));
    await w.bot.handle(cbq('mlC'));
    await w.bot.handle(msg('10 30'));
    assert.match(lastOut(w.sent).params.text, /−10% \/ \+30%/);
    const se = w.bot.sess(CHAT).lp;
    assert.strictEqual(se.lowerPct, 10); assert.strictEqual(se.upperPct, 30);
  });

  await t('manual LP refuses a hooked pool while hooks are not allowed', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xhook', usd: 50 });
    assert.match(r.error || '', /hook/i, 'a hooked pool must be rejected');
    assert.ok(!r.plan);
    // …and allowed if the user really switched it on
    w.cfg.rules = { filters: { allow_hooks: true } };
    const r2 = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xhook', usd: 50 });
    assert.ok(!r2.error, r2.error);
  });

  await t('manual LP respects the limits already set', async () => {
    const w = build();
    w.cfg.rules = { sizing: { max_quote_per_position_usd: 30 } };
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /batas per posisi/i, r.error);
    assert.match(r.error || '', /\$30/, 'the message must name the limit that blocks it');

    w.cfg.rules = { filters: { max_open_positions: 1 } };   // there is already 1 open position
    const r2 = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 10 });
    assert.match(r2.error || '', /posisi terbuka/i, r2.error);
  });

  await t('manual LP refuses if cash is insufficient', async () => {
    const w = build();
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(), 0n]));
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /kas cuma/i, r.error);
  });

  await t('manual LP: an unknown pool is rejected, not thrown', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xtidakada', usd: 50 });
    assert.match(r.error || '', /tidak dikenal/i);
    for (const usd of [0, -5, NaN]) {
      const bad = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd });
      assert.ok(bad.error, `amount ${usd} must be rejected`);
    }
  });

  await t('manual LP is refused in simulation mode', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /simulasi/i);
    assert.strictEqual(w.engine.opened.length, 0, 'there must be no execution in simulation mode');
  });

  await t('manual LP in LIVE rebuilds the plan before sending', async () => {
    const w = build({ dryRun: false });
    const r = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50, widthPct: 10 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(w.engine.opened.length, 1, 'executeEntry must be called once');
    const { plan, act } = w.engine.opened[0];
    assert.strictEqual(act.target, null, 'a manual act has no target');
    assert.ok(act.slot0, 'the pool price must come along so the zap estimate is right');
    assert.strictEqual(plan.venue, 'v4');
    assert.ok(Math.abs(plan.valueUsd - 50) < 0.5);
    // the executed plan is the server's recomputation, not what the client sent
    const fake = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50, liquidity: '999999999999', valueUsd: 1 });
    assert.ok(fake.ok, fake.error);
    assert.notStrictEqual(w.engine.opened[1].plan.liquidity, '999999999999', 'the plan sent by the client must not be used');
  });

  await t('the manual LP screen guides step by step', async () => {
    const w = build();
    await w.bot.handle(cbq('ml'));
    assert.match(lastOut(w.sent).params.text, /belum dipilih/);
    await w.bot.handle(cbq('mlp:0'));
    assert.match(lastOut(w.sent).params.text, /Pilih pool/);
    assert.ok(buttons(lastOut(w.sent)).some((b) => b.startsWith('mlP:')), 'the pool must have a button');
    await w.bot.handle(cbq('mlP:0'));
    await w.bot.handle(cbq('mln'));
    await w.bot.handle(msg('50'));
    await w.bot.handle(cbq('mlw:10:10'));
    const menu = lastOut(w.sent).params.text;
    assert.match(menu, /\$50/);
    assert.match(menu, /±10%/);
    assert.ok(buttons(lastOut(w.sent)).includes('mlv'), 'the preview button must appear once complete');
    await w.bot.handle(cbq('mlv'));
    const preview = lastOut(w.sent).params.text;
    assert.match(preview, /Pratinjau/);
    assert.match(preview, /Rentang harga/);
    assert.match(preview, /simulasi/i, 'simulation mode must be stated before the open button');
  });

  // ---- scan pools from a token address -----------------------------------
  const P1 = '0x' + '11'.repeat(32), P2 = '0x' + '22'.repeat(32), P3 = '0x' + '33'.repeat(32),
    P4 = '0x' + '44'.repeat(32), P5 = '0x' + '55'.repeat(32);
  const LOGS = [
    initLog({ id: P1, c0: ADDR.usdg, c1: MEME, fee: 3000, ts: 60, block: 900 }),          // good
    initLog({ id: P2, c0: ADDR.native, c1: MEME, fee: 10000, ts: 200, block: 800 }),      // good
    initLog({ id: P3, c0: ADDR.usdg, c1: MEME, fee: 5000, ts: 100, block: 700 }),         // empty
    initLog({ id: P4, c0: MEME, c1: '0x' + 'ab'.repeat(20), fee: 0x800000, ts: 8, hooks: '0x' + 'cd'.repeat(20), block: 600 }),
    initLog({ id: P5, c0: ADDR.usdg, c1: MEME, fee: 0x800000, ts: 8, hooks: '0x' + 'ef'.repeat(20), block: 500 }),
  ];

  await t('pool scan: the Initialize event is decoded in full', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: w.engine.rpcStub || null, log: () => {} });
    man.rpc = w.query && null;                              // used via the api only
    const r = await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    assert.ok(!r.error, r.error);
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    assert.strictEqual(j.status, 'selesai', j.error);
    assert.strictEqual(j.total, 5, 'all five pools must be found');
    const p1 = j.pools.find((x) => x.poolRef === P1);
    assert.ok(p1, 'the first pool must exist');
    assert.strictEqual(p1.fee, 3000);
    assert.strictEqual(p1.tickSpacing, 60);
    assert.strictEqual(p1.token0, ADDR.usdg);
    assert.strictEqual(p1.token1, MEME);
    assert.strictEqual(p1.hasHooks, false);
    assert.strictEqual(p1.pair, 'USDG/MEME');
    const p4 = j.pools.find((x) => x.poolRef === P4);
    assert.strictEqual(p4.hasHooks, true, 'hooks must be read from the data');
    assert.strictEqual(p4.hooks, '0x' + 'cd'.repeat(20));
  });

  await t('the dynamic fee marker is not read as 838.86%', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    const p4 = j.pools.find((x) => x.poolRef === P4);
    assert.strictEqual(p4.dynamicFee, true, '0x800000 is the dynamic fee marker, not a fee figure');
    assert.strictEqual(p4.feePct, null, 'a dynamic fee has no percentage up front');
    const p1 = j.pools.find((x) => x.poolRef === P1);
    assert.strictEqual(p1.dynamicFee, false);
    assert.strictEqual(p1.feePct, 0.3);
  });

  await t('junk pools are hidden, but still counted', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME });
    }
    const ref = j.pools.map((p) => p.poolRef);
    assert.ok(ref.includes(P1) && ref.includes(P2), 'a pool with liquidity & a quote asset must show');
    assert.ok(!ref.includes(P3), 'a pool without liquidity must be hidden');
    assert.ok(!ref.includes(P4), 'a pool without a quote asset must be hidden');
    assert.ok(!ref.includes(P5), 'a dynamic-fee pool must be hidden');
    assert.strictEqual(j.total, 5);
    assert.strictEqual(j.hidden, 3, 'the hidden ones are still counted so the user knows there is a remainder');
    const everything = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    assert.strictEqual(everything.pools.length, 5, 'all=1 menampilkan semuanya');
  });

  await t('scanned pools are stored and appear in the ordinary list', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    for (let i = 0; i < 40; i++) {
      await new Promise((x) => setTimeout(x, 25));
      if ((await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME })).status !== 'jalan') break;
    }
    const listing = (await w.api('GET', '/api/manual/pools')).pools.map((p) => p.poolRef);
    assert.ok(listing.includes(P1), 'scanned pools must be in the list of known pools');
    // …and can be used right away to plan a position
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: P1, usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.preview.pair, 'USDG/MEME');
  });

  // ---- paste an address --------------------------------------------------------
  const pasteWorld = (opts = {}) => {
    const w = build({ initLogs: LOGS, kosong: [P3], ...opts });
    w.bot.scanPause = [5, 5];
    return w;
  };

  await t('pasting a token address opens the LP setup card directly', async () => {
    const w = pasteWorld();
    await w.bot.handle(msg(MEME));
    const o = lastOut(w.sent);
    assert.match(o.params.text, /Pasang LP/);
    assert.match(o.params.text, /USDG\/MEME/);
    assert.match(o.params.text, /pilih di bawah/, 'an amount not yet chosen must be told');
    const b = buttons(o);
    for (const x of ['qkn:25', 'qkn:50', 'qkn:100', 'qkN', 'qkw:25:25', 'qkF', 'qkC', 'qkp']) assert.ok(b.includes(x), `button ${x} must exist`);
    assert.ok(!b.includes('qkY'), 'the open button does not appear before an amount is chosen');
  });

  await t('LP card: amount & range changed in place, preview follows', async () => {
    const w = pasteWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkn:50'));
    let body = lastOut(w.sent).params.text;
    assert.match(body, /\$50/);
    assert.match(body, /Kas tersedia/, 'the preview appears after an amount is chosen');
    assert.ok(buttons(lastOut(w.sent)).some((x) => x === 'qkn:50'), 'the button is still there');
    assert.ok(lastOut(w.sent).params.reply_markup.inline_keyboard.flat().some((x) => x.text === '✓ $50'), 'pilihan aktif ditandai');
    await w.bot.handle(cbq('qkw:10:30'));
    body = lastOut(w.sent).params.text;
    assert.match(body, /−10% \/ \+30%/);
    assert.match(body, /simulasi/i, 'mode simulasi diberitahukan');
    assert.ok(!buttons(lastOut(w.sent)).includes('qkY'), 'simulation mode: there is no open button');
  });

  await t('LP card: typing your own amount goes back to the card, not to the LP menu', async () => {
    const w = pasteWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkN'));
    await w.bot.handle(msg('75'));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /Pasang LP/);
    assert.match(body, /\$75/);
  });

  await t('LP card in LIVE mode: open → sure → the position opens with the chosen range', async () => {
    const w = pasteWorld({ dryRun: false });
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkn:50'));
    await w.bot.handle(cbq('qkw:10:30'));
    assert.ok(buttons(lastOut(w.sent)).includes('qkY'), 'the open button must exist in LIVE');
    await w.bot.handle(cbq('qkY'));
    assert.match(lastOut(w.sent).params.text, /sungguhan/);
    assert.strictEqual(w.engine.opened.length, 0, 'no transaction before confirmation');
    await w.bot.handle(cbq('mlX'));
    assert.strictEqual(w.engine.opened.length, 1);
    const pl = w.engine.opened[0].plan;
    // Measured in the PRICE as seen: this pool is quoted in token0 (USDG), so the price of
    // MEME falls as the tick rises — the upper price bound is at tickLower.
    const price = (t) => (pl.quoteSide === 1 ? 1.0001 ** t : 1.0001 ** -t);
    const [lower, upper] = [price(pl.tickLower), price(pl.tickUpper)].sort((a, b) => a - b);
    assert.ok(lower <= 0.9 && lower > 0.88, `lower bound ${lower}`);
    assert.ok(upper >= 1.3 && upper < 1.32, `upper bound ${upper}`);
  });

  await t('LP card: change pool', async () => {
    const w = pasteWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkp'));
    const b = buttons(lastOut(w.sent)).filter((x) => x.startsWith('qkP:'));
    assert.ok(b.length >= 2, 'the pool choice must exist');
    const prior = w.bot.sess(CHAT).lp.poolRef;
    await w.bot.handle(cbq('qkP:1'));
    assert.notStrictEqual(w.bot.sess(CHAT).lp.poolRef, prior);
    assert.match(lastOut(w.sent).params.text, /Pasang LP/);
  });

  await t('pasting a wallet address: research or make a target, not LP', async () => {
    const w = pasteWorld();
    const WALLET = '0x' + 'ab'.repeat(20);
    await w.bot.handle(msg(WALLET));
    const o = lastOut(w.sent);
    assert.match(o.params.text, /wallet, bukan token/);
    assert.ok(buttons(o).includes('wr:' + WALLET));
    await w.bot.handle(cbq('adT'));
    assert.ok(w.store.get('SELECT 1 x FROM targets WHERE address=?', WALLET), 'target ditambahkan');
    await w.bot.handle(msg(KONTRAK));
    assert.match(lastOut(w.sent).params.text, /Kontrak/);
    assert.strictEqual(w.store.get("SELECT COUNT(*) n FROM tokens WHERE symbol='?'").n, 0, 'a non-token address does not enter the tokens table');
  });

  await t('an address inside a link is read; a 64-hex poolId is not mistaken for an address', async () => {
    const w = pasteWorld();
    await w.bot.handle(msg(`https://dexscreener.com/robinhood/${MEME}`));
    assert.match(lastOut(w.sent).params.text, /Pasang LP/);
    const n = w.sent.length;
    await w.bot.handle(msg(P1));
    assert.doesNotMatch(lastOut(w.sent).params.text || '', /Memeriksa|Pasang LP/, 'a poolId must not be treated as an address');
    assert.ok(w.sent.length > n);
  });

  // ---- Uniswap v3 pool ---------------------------------------------------------
  const V3A = '0x' + 'a3'.repeat(20), V3B = '0x' + 'b3'.repeat(20);
  const scan = async (w, token) => {
    await w.api('POST', '/api/manual/pools/scan', { token });
    let j;
    for (let i = 0; i < 60 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 20));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token });
    }
    return j;
  };

  await t('the pool scan finds Uniswap v3 pools too', async () => {
    const w = build({ initLogs: [...LOGS,
      createdLog({ pool: V3A, t0: ADDR.usdg, t1: MEME, fee: 3000, ts: 60 }),
      createdLog({ pool: V3B, t0: MEME, t1: '0x' + '99'.repeat(20), fee: 500, ts: 10 }),   // without a quote
    ], kosong: [P3] });
    const j = await scan(w, MEME);
    assert.strictEqual(j.status, 'selesai', j.error);
    const v3 = j.pools.find((p) => p.poolRef === V3A);
    assert.ok(v3, 'the v3 pool must be found');
    assert.strictEqual(v3.venue, 'v3');
    assert.strictEqual(v3.fee, 3000);
    assert.strictEqual(v3.tickSpacing, 60);
    assert.strictEqual(v3.pair, 'USDG/MEME');
    assert.strictEqual(v3.kosong, false, 'v3 liquidity is read from the pool\'s liquidity()');
    assert.ok(!j.pools.some((p) => p.poolRef === V3B), 'pool v3 tanpa aset kuotasi disembunyikan');
    assert.ok(j.pools.some((p) => p.venue === 'v4'), 'the v4 pool is still there');
    // the scanned v3 pool is stored and can be planned right away
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: V3A, usd: 50, lowerPct: 10, upperPct: 10 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.plan.venue, 'v3');
    assert.strictEqual(r.plan.poolKey, null);
    assert.ok(r.plan.tickLower % 60 === 0 && r.plan.tickUpper % 60 === 0, `dibulatkan ke tick spacing v3: ${r.plan.tickLower}…${r.plan.tickUpper}`);
  });

  await t('paste a token that only has a v3 pool: the LP card still opens', async () => {
    const w = build({ initLogs: [createdLog({ pool: V3A, t0: ADDR.usdg, t1: MEME, fee: 10000, ts: 200 })] });
    w.bot.scanPause = [5, 5];
    await w.bot.handle(msg(MEME));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /Pasang LP — USDG\/MEME/);
    assert.match(body, /v3 · fee 1%/);
  });

  await t('token tanpa pool v3/v4: disebutkan diperdagangkan di mana', async () => {
    const w = build({ initLogs: [], otherMarket: [{ dex: 'Pons V2', dexId: 'pons-v2', name: 'MEME / USDG', address: '0xb8ca', reserveUsd: 3948.9 }] });
    w.bot.scanPause = [5, 5];
    await w.bot.handle(msg(MEME));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /Uniswap v3\/v4/);
    assert.match(body, /Pons V2 — MEME \/ USDG · likuiditas \$3,9rb/);
    assert.match(body, /gaya v2/);
    const j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME });
    assert.strictEqual(j.others[0].dex, 'Pons V2', 'the web dashboard gets the same data');
  });

  await t('an endpoint that refuses the full range is answered by chunking', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3], rejectFullRange: true });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 200 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    assert.strictEqual(j.status, 'selesai', j.error);
    assert.strictEqual(j.total, 5, 'the result must be the same even via the chunk path');
    assert.ok(w.query.length > 4, `there must be many chunk queries, there are only ${w.query.length}`);
  });

  await t('manual LP refuses a dynamic-fee pool and a fee above the limit', async () => {
    const w = build({ initLogs: LOGS, kosong: [] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    for (let i = 0; i < 40; i++) {
      await new Promise((x) => setTimeout(x, 25));
      if ((await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME })).status !== 'jalan') break;
    }
    w.cfg.rules = { filters: { allow_hooks: true } };       // a hook is allowed, the fee is still not
    const dinamis = await w.api('POST', '/api/manual/lp/plan', { poolRef: P5, usd: 50 });
    assert.match(dinamis.error || '', /fee dinamis/i, dinamis.error);

    // Uniswap fee unit: 1000 = 0.1%, whereas pool P1 has fee 3000 = 0.3%
    w.cfg.rules = { filters: { max_fee_bps: 1000 } };
    const expensive = await w.api('POST', '/api/manual/lp/plan', { poolRef: P1, usd: 50 });
    assert.match(expensive.error || '', /di atas batas/i, expensive.error);
  });

  await t('a nonsense token address is rejected before touching the chain', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/pools/scan', { token: 'bukan-alamat' });
    assert.match(r.error || '', /alamat token/i);
    assert.strictEqual(w.query.length, 0, 'there must be no chain query for a nonsense address');
  });

  await t('the scan result screen in the bot can be chosen directly', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.bot.handle(cbq('mla'));
    assert.match(lastOut(w.sent).params.text, /alamat token/i);
    await w.bot.handle(msg(MEME));
    // runScanPool waits 2 s per round; its own work finishes instantly
    await new Promise((x) => setTimeout(x, 2300));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /USDG\/MEME/, `the scan result is not shown:\n${body}`);
    assert.match(body, /disembunyikan/, 'the hidden count must be stated');
    const button = buttons(lastOut(w.sent)).filter((b) => b.startsWith('mlP:'));
    assert.ok(button.length >= 2, 'every scanned pool must have a button');
    await w.bot.handle(cbq(button[0]));
    assert.match(lastOut(w.sent).params.text, /LP manual/, 'choosing a pool must go back to the LP menu');
    assert.ok(/USDG\/MEME|ETH\/MEME/.test(lastOut(w.sent).params.text), 'the chosen pool must be recorded');
  });

  // ---- manual swap -----------------------------------------------------------
  await t('"all" leaves the gas reserve for native ETH', async () => {
    const w = build();
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: {}, log: () => {} });
    const raw = await man.amountRaw(ADDR.native, 'semua');
    const backup = BigInt(w.cfg.gas.native_reserve_wei ?? 2_000_000_000_000_000);
    assert.strictEqual(raw, 10n ** 17n - backup, 'native ETH must leave the gas reserve');
    // an ordinary token needs no fallback
    const usdgRaw = await man.amountRaw(ADDR.usdg, 'semua');
    assert.strictEqual(usdgRaw, 150_000_000n);
  });

  await t('swap amount: percent, number, and one exceeding the balance', async () => {
    const w = build();
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: {}, log: () => {} });
    assert.strictEqual(await man.amountRaw(ADDR.usdg, '50%'), 75_000_000n);
    assert.strictEqual(await man.amountRaw(ADDR.usdg, '10'), 10_000_000n);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, '9999'), /saldo cuma/);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, 'abc'), /angka/);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, '150%'), /antara 0 dan 100/);
  });

  await t('the swap quote shows the route cost and refuses one that loses too much', async () => {
    const w = build();
    const q = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.ok(!q.error, q.error);
    assert.strictEqual(q.symbolIn, 'USDG');
    assert.strictEqual(q.symbolOut, 'MEME');
    assert.ok(q.lossBps > 0, 'the route cost must be computed');
    assert.strictEqual(q.tooLossy, false);

    // a route that loses far beyond the limit must be flagged, not silently run
    w.engine.kyber.quote = async (a, b, amt) => ({ amountOut: BigInt(amt), usdIn: 50, usdOut: 20, dex: 'jelek', routeSummary: {} });
    const buruk = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.strictEqual(buruk.tooLossy, true, `loss ${buruk.lossBps} bps should be flagged`);
  });

  await t('an amount above the balance is still quoted (flagged insufficient) but the swap itself is refused', async () => {
    const w = build({ dryRun: false });
    const q = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '9999' });
    assert.ok(!q.error, q.error);
    assert.ok(q.amountOut > 0, 'a quote is returned');
    assert.strictEqual(q.amountRaw, '9999000000');
    assert.deepStrictEqual(q.insufficient, { balance: 150, symbol: 'USDG' });
    const ok = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.strictEqual(ok.insufficient, null);
    let sent = false;
    w.engine.kyber.swap = async () => { sent = true; return { hash: '0x' }; };
    const r = await w.api('POST', '/api/manual/swap', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '9999' });
    assert.match(r.error || '', /saldo cuma/);
    assert.strictEqual(sent, false);
  });

  await t('a swap is refused in simulation mode, run in LIVE', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/swap', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.match(r.error || '', /simulasi/i);

    const w2 = build({ dryRun: false });
    let used = null;
    w2.engine.kyber.swap = async (ti, to, amt, opt) => { used = { ti, to, amt, opt }; return { hash: '0xswap', amountOut: 5n * 10n ** 18n, quote: { dex: 'uji' } }; };
    const r2 = await w2.api('POST', '/api/manual/swap', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.ok(r2.ok, r2.error);
    assert.strictEqual(used.amt, 10_000_000n, 'the amount must be converted to the token\'s raw unit');
    assert.strictEqual(used.opt.kind, 'swap_manual');
    assert.ok(used.opt.maxLossBps > 0, 'the loss limit must be set too');
    assert.match(r2.note, /USDG/);
  });

  await t('the swap screen guides step by step', async () => {
    const w = build();
    await w.bot.handle(cbq('sw'));
    assert.match(lastOut(w.sent).params.text, /belum dipilih/);
    await w.bot.handle(cbq('swf'));
    assert.ok(buttons(lastOut(w.sent)).some((b) => b.startsWith('swF:')), 'there must be a token choice');
    await w.bot.handle(cbq('swF:0'));
    await w.bot.handle(cbq('swt'));
    await w.bot.handle(cbq('swT:1'));
    await w.bot.handle(cbq('swn'));
    await w.bot.handle(msg('10'));
    const body = lastOut(w.sent).params.text;
    assert.match(body, /Dikirim|Diterima/, `the quote is not shown:\n${body}`);
  });

  await t('the "from" side only offers tokens that have a balance', async () => {
    const w = build();
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(),
      String(t2).toLowerCase() === ADDR.usdg ? 5_000_000n : 0n]));
    await w.bot.handle(cbq('swf'));
    const button = buttons(lastOut(w.sent)).filter((b) => b.startsWith('swF:'));
    assert.strictEqual(button.length, 1, 'only USDG has a balance');
    assert.match(lastOut(w.sent).params.text, /USDG/);
  });

  // ---- display tidiness ---------------------------------------------------
  await t('columns are really straight, including when their content needs escaping', async () => {
    const { column } = require('../src/telegram');
    const out = column([['a&b', '1'], ['panjang', '22,50']], 'lr');
    const row = out.replace(/<\/?pre>/g, '').split('\n');
    // length is measured after HTML entities are restored to a single character
    const real = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    assert.strictEqual(real(row[0]).length, real(row[1]).length, `columns are not straight:\n${row.join('\n')}`);
    assert.match(real(row[0]), /^a&b +1$/, real(row[0]));
    assert.match(real(row[1]), /^panjang +22,50$/, real(row[1]));
    assert.strictEqual(column([]), null, 'an empty table must be null so it can be filtered');
  });

  await t('the table wraps long text without losing data or breaking the HTML', async () => {
    const { column } = require('../src/telegram');
    const label = 'Label panjang untuk nilai yang perlu dibaca seluruhnya';
    const value = '0x' + 'abcdef'.repeat(12);
    const html = column([[label, value], ['<token&>', '1234567890.1234567890']], 'lr');
    const lines = html.replace(/<\/?pre>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
    assert.ok(lines.every((line) => Array.from(line).length <= 40));
    assert.ok(html.includes('&lt;token&amp;&gt;'));
    // Two 19-character columns separated by two spaces; reconstruct wrapped data.
    assert.strictEqual(lines.slice(0, 4).map((line) => line.slice(21).trim()).join(''), value);
  });

  await t('the data page uses a table and its navigation stays available', async () => {
    const w = build();
    for (const route of ['t', 'a:0', 'x', 's', 'sr', 'sf:gas', 'sn', 'sc', 'f', 'wl', 'r:0']) {
      await w.bot.handle(cbq(route));
      const output = lastOut(w.sent).params;
      assert.match(output.text, /<pre>/, route);
      assert.ok(output.reply_markup.inline_keyboard.length, route);
    }
    w.bot.stop();
  });

  await t('price from tick is identical for both pool arrangements', async () => {
    const { tickPrice } = require('../src/telegram');
    // The quote side determines the direction: if the quote is on token0, the price of the
    // speculative token is the INVERSE of the tick. Two arrangements that describe the same
    // pair must produce the same figure — this once was the source of a bug.
    for (const T of [600, -600, 12345, -322900]) {
      const a = tickPrice(T, 6, 18, 0);     // USDG/MEME, quote on token0
      const b = tickPrice(-T, 18, 6, 1);    // MEME/USDG, quote on token1
      assert.ok(Math.abs(a / b - 1) < 1e-12, `tick ${T}: ${a} ≠ ${b}`);
    }
  });

  await t('price range: the user\'s real position reads correctly', async () => {
    const { rentang: span } = require('../src/telegram');
    // The user's HOOKR/USDG: tick −322900…−317900, current price −319936.
    const r = span({ tick_lower: -322900, tick_upper: -317900, curTick: -319936,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.ok(r, 'the range must be readable');
    assert.match(r.heading, /HOOKR dalam USDG/);
    assert.match(r.ket, /di dalam/, `seharusnya in-range: ${r.ket}`);
    assert.match(r.bar, /●/, 'the current price marker must be on the bar');
    // the bar must have a fixed length whatever the price
    const polos = r.bar.replace(/<\/?pre>/g, '');
    assert.strictEqual((polos.match(/[─●]/g) || []).length, 15);
  });

  await t('price range: a price outside the range states its direction', async () => {
    const { rentang: span } = require('../src/telegram');
    const upper = span({ tick_lower: -322900, tick_upper: -317900, curTick: -300000,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.match(upper.ket, /di luar rentang, [\d.,]+% di atas/, upper.ket);
    const lower = span({ tick_lower: -322900, tick_upper: -317900, curTick: -350000,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.match(lower.ket, /di luar rentang, [\d.,]+% di bawah/, lower.ket);
    // incomplete data must not throw an error
    assert.strictEqual(span({ tick_lower: null, tick_upper: 1, quoteSide: 1 }), null);
    assert.strictEqual(span({ tick_lower: -1, tick_upper: 1, quoteSide: null }), null);
  });

  await t('the position detail shows price, not a raw tick', async () => {
    const w = build();
    Object.assign(w.engine.positions.live[0], {
      symbol0: 'HOOKR', symbol1: 'USDG', dec0: 18, dec1: 6, quoteSide: 1,
      tick_lower: -322900, tick_upper: -317900, curTick: -319936,
    });
    await w.bot.handle(cbq('p:1'));
    const body = lastOut(w.sent).params.text;
    assert.ok(!/-322\.?900|rentang tick/i.test(body), `the raw tick still leaks onto the screen:\n${body}`);
    assert.match(body, /Rentang harga/);
    assert.match(body, /harga kini/);
  });

  await t('the time unit is unambiguous', async () => {
    const { dur } = require('../src/telegram');
    assert.strictEqual(dur(45), '45 detik');
    assert.strictEqual(dur(3600 * 2), '2 jam');
    assert.strictEqual(dur(3600 * 2 + 720), '2 jam 12 menit');
    assert.strictEqual(dur(86400 + 36000), '1 hari 10 jam');
    assert.strictEqual(dur(86400 * 3), '3 hari');
  });

  await t('no screen uses space alignment in plain text', async () => {
    // The Telegram chat font is proportional: double spaces outside <pre> are never straight.
    const w = build();
    const queued = ['h']; const done = new Set();
    while (queued.length) {
      const d = queued.shift();
      if (done.has(d)) continue;
      done.add(d);
      if (['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'].includes(d.split(':')[0])) continue;
      await w.bot.handle(cbq(d));
      const body = lastOut(w.sent).params.text;
      const outsidePre = body.replace(/<pre>[\s\S]*?<\/pre>/g, '');
      for (const row of outsidePre.split('\n')) {
        assert.ok(!/\S {3,}\S/.test(row), `screen ${d} tries to align with spaces outside <pre>:\n  "${row}"`);
      }
      for (const b of buttons(lastOut(w.sent))) queued.push(b);
    }
  });

  await t('a small token amount never shows as zero', async () => {
    const w = build();
    await w.bot.handle(cbq('ml'));
    const { Manual } = require('../src/manual');
    void Manual;
    // 2.5e-11 token: not zero, so must not be read as "has none".
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(BigInt(r.plan.amount1) > 0n, 'precondition: amount1 must be non-zero');
    w.sess = w.bot.sess(CHAT);
    w.sess.lp = { poolRef: '0xpool', usd: 50, widthPct: 25 };
    await w.bot.handle(cbq('mlv'));
    const body = lastOut(w.sent).params.text;
    const row = body.split('\n').find((x) => x.includes('MEME'));
    assert.ok(row && !/MEME\s+0$/.test(row), `a non-zero amount shows as zero: "${row}"`);
  });

  await t('no two screens use the same button code', async () => {
    // Two `case`s with the same value in one switch are silently accepted by JS: the
    // second will never run. That is exactly what happened when the Swap menu and the
    // Wallet screen both used 'sw' — the explorer cannot see it
    // because both produce a legitimate screen.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    const blk = {
      button: src.slice(src.indexOf('async screen('), src.indexOf('// ---- jawaban atas pertanyaan')),
      cmdName: src.slice(src.indexOf('switch (cmd) {'), src.indexOf('async onCallback')),
    };
    for (const [nameVal, body] of Object.entries(blk)) {
      assert.ok(body.length > 100, `block ${nameVal} not found`);
      const label = [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
      const dobel = [...new Set(label.filter((x, i) => label.indexOf(x) !== i))];
      assert.deepStrictEqual(dobel, [], `code ${nameVal} used twice: ${dobel.join(', ')} — the second will never run`);
    }
  });

  await t('button data fits Telegram\'s 64-byte limit', async () => {
    const w = build();
    const queued = ['h']; const done = new Set();
    while (queued.length) {
      const d = queued.shift();
      if (done.has(d)) continue;
      done.add(d);
      assert.ok(Buffer.byteLength(d) <= 64, `callback_data too long (${Buffer.byteLength(d)}): ${d}`);
      if (['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'].includes(d.split(':')[0])) continue;
      await w.bot.handle(cbq(d));
      for (const b of buttons(lastOut(w.sent))) queued.push(b);
    }
  });

  await t('every message fits Telegram\'s 4096-character limit', async () => {
    const w = build();
    for (const d of ['h', 'o', 'p', 'p:1', 't', `t:${TARGET}`, 'a:0', 'r', 'r:5', 's', 'l', 'x', 'f', 'sr', 'sn', 'sc']) {
      await w.bot.handle(cbq(d));
      assert.ok(lastOut(w.sent).params.text.length <= 4096, `screen ${d} too long`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
