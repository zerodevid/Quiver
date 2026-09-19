'use strict';
// Uji bot Telegram.
//
// Yang dipalsukan hanya dua batas luar: API Telegram (fetch keluar) dan chain.
// Sisanya kode asli — tabel rute server.js yang sama persis dipakai peramban, jadi
// uji ini sekaligus membuktikan klaim utama modul telegram.js: bot memakai logika
// dasbor, bukan salinannya.
//
// Uji intinya adalah PENJELAJAH: ia menekan setiap tombol yang bisa dicapai dari
// menu utama, satu per satu, dan menuntut tidak ada satu pun yang melempar galat
// atau menghasilkan layar kosong. Tombol yang memindahkan dana / menghapus sesuatu
// sengaja tidak ditekan, tapi keberadaannya tetap diperiksa.
//
// Jalankan: node test/telegram.js
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
const ASING = '99999';
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

// ---- dunia palsu ----------------------------------------------------------
// Satu log Initialize v4 seperti yang benar-benar dipancarkan PoolManager:
// tiga topik terindeks (poolId, currency0, currency1) + fee/tickSpacing/hooks/harga di data.
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const initLog = ({ id, c0, c1, fee, ts, hooks = ADDR.native, block = 500 }) => ({
  address: ADDR.poolManager,
  topics: [TOPIC.initializeV4, id, pad32(c0), pad32(c1)],
  data: '0x' + word(fee) + word(ts) + pad32(hooks).slice(2) + word(0) + word(0),
  blockNumber: '0x' + block.toString(16),
});

// PoolCreated v3 di factory: token0, token1, fee di topik; tickSpacing & alamat pool di data.
const FACTORY = '0x' + 'fa'.repeat(20);
const createdLog = ({ pool, t0, t1, fee, ts, block = 600 }) => ({
  address: FACTORY,
  topics: [TOPIC.poolCreatedV3, pad32(t0), pad32(t1), '0x' + word(fee)],
  data: '0x' + word(ts) + pad32(pool).slice(2),
  blockNumber: '0x' + block.toString(16),
});

// "Diperdagangkan di mana lagi" memanggil GeckoTerminal — di tes diganti isian tetap.
const { Manual: ManualKelas } = require('../src/manual');
let PASAR_LAIN = null;
ManualKelas.prototype.pasarLain = async () => PASAR_LAIN;

function build({ chats = [CHAT], dryRun = true, initLogs = [], kosong = [], tolakRentangPenuh = false, pasarLain = null } = {}) {
  PASAR_LAIN = pasarLain;
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
    dibuka: [], ditukar: [],
    executeEntry: async function (plan, act) { this.dibuka.push({ plan, act }); return { txHash: '0xmint', positionId: 9, note: 'USDG/MEME $50,00' }; },
    kyber: {
      quote: async (a, b, amt) => ({ amountOut: BigInt(amt) * 2n, usdIn: 50, usdOut: 49.5, dex: 'uji-dex', routeSummary: {} }),
      swap: async function (a, b, amt) { return { hash: '0xswap', amountOut: BigInt(amt) * 2n, quote: { dex: 'uji-dex', usdIn: 50, usdOut: 49.5 } }; },
    },
  };
  const kueri = [];
  const rpc = {
    stats: () => [{ url: 'https://rpc.contoh.test', calls: 10, errors: 0, lastMs: 90 }], reconfigure: () => {},
    blockNumber: async () => 1_000_000,
    // Alamat yang ditempel: MEME = token, KONTRAK = smart wallet, sisanya wallet biasa.
    call: async (method, params) => {
      if (method !== 'eth_getCode') throw new Error('tidak didukung: ' + method);
      const a = String(params[0]).toLowerCase();
      return a === MEME || a === KONTRAK ? '0x6080604052' : '0x';
    },
    ethCallMany: async (items) => items.map((it) => {
      if (it.data === '0x1a686502') return '0x' + word(kosong.includes(String(it.to).toLowerCase()) ? 0 : 10n ** 20n);   // liquidity() v3
      if (String(it.to).toLowerCase() !== MEME) return null;
      const abi = require('ethers').AbiCoder.defaultAbiCoder();
      return it.data === '0x95d89b41' ? abi.encode(['string'], ['MEME']) : abi.encode(['uint8'], [18]);
    }),
    getLogs: async (f) => {
      kueri.push(f);
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      if (tolakRentangPenuh && to - from > 500_000) throw new Error('query returned more than 10000 results');
      return initLogs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        if (f.address && String(l.address).toLowerCase() !== String(f.address).toLowerCase()) return false;
        for (let i = 0; i < f.topics.length; i++) if (f.topics[i] && l.topics[i] !== f.topics[i]) return false;
        return true;
      });
    },
  };

  // Chain palsu yang cukup lengkap untuk LP manual: harga pool, metadata token, dan
  // penilaian posisi memakai matematika v3 yang asli.
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
    poolLiquidity: async (id) => (kosong.includes(id) ? 0n : 10n ** 20n),
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
  // Kartu bagikan dikirim sebagai foto lewat multipart, bukan this.tg(): dicatat
  // terpisah supaya tidak menyentuh jaringan.
  bot.sendPhoto = async (chatId, png, caption, keyboard = null) => {
    sent.push({ method: 'sendPhoto', params: { chat_id: chatId, caption, bytes: png.length, reply_markup: keyboard } });
    return true;
  };
  // Pesan foto yang disunting (tombol grafik) juga dicatat; false = pesannya bukan foto.
  bot.editPhoto = async (chatId, msgId, png, caption, keyboard = null) => {
    sent.push({ method: 'editMessageMedia', params: { chat_id: chatId, message_id: msgId, caption, bytes: png.length, reply_markup: keyboard } });
    return bot.photoMsgs?.has?.(msgId) || false;
  };
  bot.photoMsgs = new Set();
  // API Telegram palsu: mencatat apa yang keluar, membalas seperti aslinya.
  let msgId = 100;
  bot.tg = async (method, params) => {
    sent.push({ method, params });
    if (method === 'sendMessage') return { message_id: ++msgId, chat: { id: params.chat_id }, text: params.text };
    if (method === 'editMessageText') return { message_id: params.message_id, text: params.text };
    if (method === 'getMe') return { username: 'lpcopy_uji_bot' };
    return true;
  };
  // Loop polling asli diganti pencatat: uji tidak boleh meninggalkan loop berputar.
  // Generasi yang diterima poll() tetap direkam, karena itulah yang membuktikan
  // loop lama berhenti saat token diganti.
  bot.polls = [];
  bot.poll = async (gen = bot.gen) => { bot.polls.push(gen); };
  // Batas luar ketiga: GeckoTerminal/DexScreener (lilin harga untuk tombol Grafik).
  // Dipasang SEBELUM server dibuat — Market mencatat fetch-nya saat dibangun.
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
  return { bot, store, cfg, cfgPath, sent, engine, chainStub: chain, kueri, api: (m, p, b, q) => server.api(m, p, b, q), last: () => sent[sent.length - 1] };
}

const msg = (text, chat = CHAT) => ({ message: { chat: { id: Number(chat) }, text } });
const KONTRAK = '0x' + 'c0'.repeat(20);
const cbq = (data, chat = CHAT) => ({ callback_query: { id: 'q1', data, message: { chat: { id: Number(chat) }, message_id: 100 } } });
const outs = (sent) => sent.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
const lastOut = (sent) => outs(sent).slice(-1)[0];
const buttons = (o) => (o?.params?.reply_markup?.inline_keyboard || []).flat().map((b) => b.callback_data);

(async () => {
  console.log('bot Telegram\n');

  await t('posisi: rugi merah, sumber, history USD, dan halaman tetap ringkas', async () => {
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
    assert.match(text, /Pair\s+Sumber\s+PnL/);
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

  // ---- gerbang chat -------------------------------------------------------
  await t('chat asing tidak dilayani dan tidak bocor apa pun', async () => {
    const w = build();
    await w.bot.handle(msg('/ringkasan', ASING));
    const o = lastOut(w.sent);
    assert.strictEqual(String(o.params.chat_id), ASING);
    assert.match(o.params.text, /belum tersambung/i);
    assert.ok(!/LIVE|SIMULASI|0x/.test(o.params.text), 'jawaban ke chat asing tidak boleh memuat keadaan bot');
  });

  await t('input dapat dibatalkan lewat tombol, perintah, dan navigasi', async () => {
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

  await t('input gagal bisa diisi ulang tanpa membuka menu dari awal', async () => {
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

  await t('navigasi menghapus isian ulang agar tombol lama tidak membuka input', async () => {
    const w = build();
    await w.bot.handle(cbq('mln'));
    await w.bot.handle(msg('salah'));
    await w.bot.handle(msg('/menu'));
    await w.bot.handle(cbq('inputRetry'));
    assert.strictEqual(w.bot.sess(CHAT).pending, null);
    assert.ok(buttons(lastOut(w.sent)).includes('t'));
  });

  await t('kode sambung salah ditolak, kode benar menyambungkan', async () => {
    const w = build({ chats: [] });
    const kode = w.bot.newPairCode();
    await w.bot.handle(msg('/start SALAH123', ASING));
    assert.match(lastOut(w.sent).params.text, /Kode salah/);
    assert.ok(!w.bot.chats().includes(ASING));
    await w.bot.handle(msg(`/start ${kode}`, ASING));
    assert.ok(w.bot.chats().includes(ASING), 'chat harus tersambung setelah kode benar');
    // dan tersimpan ke config, bukan cuma di memori
    assert.ok(JSON.parse(fs.readFileSync(w.cfgPath, 'utf8')).telegram.chat_ids.includes(ASING));
  });

  await t('kode sekali pakai: tidak bisa dipakai chat kedua', async () => {
    const w = build({ chats: [] });
    const kode = w.bot.newPairCode();
    await w.bot.handle(msg(`/start ${kode}`, ASING));
    await w.bot.handle(msg(`/start ${kode}`, '77777'));
    assert.ok(!w.bot.chats().includes('77777'), 'kode yang sudah dipakai tidak boleh berlaku lagi');
  });

  await t('kode kedaluwarsa ditolak', async () => {
    const w = build({ chats: [] });
    const kode = w.bot.newPairCode();
    w.bot.pairCode.exp = Date.now() - 1;
    await w.bot.handle(msg(`/start ${kode}`, ASING));
    assert.match(lastOut(w.sent).params.text, /kedaluwarsa/i);
    assert.ok(!w.bot.chats().includes(ASING));
  });

  await t('tombol dari chat asing ditolak tanpa memanggil API', async () => {
    const w = build();
    await w.bot.handle(cbq('o', ASING));
    assert.strictEqual(outs(w.sent).length, 0, 'tidak boleh ada pesan terkirim');
    assert.match(w.last().params.text, /tidak berwenang/i);
  });

  await t('bahasa Telegram tersimpan per chat dan tidak bocor antar permintaan', async () => {
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

  await t('semua layar Telegram berbahasa Inggris dan callback tetap valid', async () => {
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

  await t('notifikasi Inggris memakai copy dan angka sesuai bahasa penerima', async () => {
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

  // ---- penjelajah menu ----------------------------------------------------
  await t('tombol Grafik: gambar lilin + tombol rentang waktu & indikator; tekan lagi menyunting foto yang sama', async () => {
    const w = build();
    const before = w.sent.length;
    // Ditekan dari layar TEKS detail posisi: fotonya dikirim baru.
    await w.bot.handle(cbq('pg:1'));
    const kirim = w.sent.slice(before).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(kirim.length, 1, 'satu foto grafik');
    assert.ok(kirim[0].params.bytes > 20_000, 'PNG sungguhan');
    assert.match(kirim[0].params.caption, /USDG\/MEME · 1h/);
    const tombol = kirim[0].params.reply_markup.inline_keyboard;
    const data = tombol.flat().map((b) => b.callback_data);
    assert.ok(data.includes('pg:1:5m:10:0') && data.includes('pg:1:1d:10:0'), `rentang waktu harus ada: ${data}`);
    // Lebar jendela: auto (0) dan pilihan hari — membawa tf & indikator yang sedang aktif.
    assert.ok(data.includes('pg:1:1h:10:24') && data.includes('pg:1:1h:10:720'), `pilihan lebar jendela harus ada: ${data}`);
    // Saklar indikator membalik bitnya sendiri (bawaan EMA|VOL = 10).
    assert.ok(data.includes('pg:1:1h:8:0') && data.includes('pg:1:1h:2:0'), `saklar EMA & VOL harus membalik bit: ${data}`);
    assert.ok(data.includes('p:1'), 'ada jalan kembali ke posisi');
    assert.ok(tombol.flat().some((b) => /✅ EMA/.test(b.text)) && tombol.flat().some((b) => /▫️ MACD/.test(b.text)),
      'indikator yang menyala ditandai centang');
    // Ditekan dari pesan FOTO: gambarnya disunting, bukan menumpuk foto baru.
    const b2 = w.sent.length;
    w.bot.photoMsgs.add(777);
    const dariFoto = cbq('pg:1:4h:63:72');
    dariFoto.callback_query.message.message_id = 777;
    await w.bot.handle(dariFoto);
    const edit = w.sent.slice(b2).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'menyunting foto yang sama');
    assert.ok(!w.sent.slice(b2).some((x) => x.method === 'sendPhoto'), 'tidak mengirim foto kedua');
    assert.ok(edit[0].params.bytes > 20_000);
    const teksTombol = edit[0].params.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(teksTombol.some((x) => /· 4h ·/.test(x)), 'rentang waktu aktif ditandai');
    assert.ok(teksTombol.some((x) => /· 3 hari ·/.test(x)), `lebar jendela aktif ditandai: ${teksTombol}`);
  });

  await t('tombol Grafik portofolio: tanpa riwayat menjelaskan, dengan riwayat mengirim gambar + tombol rentang & tampilan', async () => {
    const w = build();
    // Tabel equity kosong: bukan galat, tapi penjelasan kapan grafiknya terisi.
    const b0 = w.sent.length;
    await w.bot.handle(cbq('pfg'));
    assert.match(lastOut(w.sent).params.text, /belum ada riwayat/i);
    assert.ok(!w.sent.slice(b0).some((x) => x.method === 'sendPhoto'), 'tidak ada foto tanpa riwayat');
    // Riwayat 3 hari, tiap jam: PnL naik dari 0 ke 18 dengan satu lembah di tengah.
    const now = Date.now();
    for (let i = 72; i >= 1; i--) {
      const pnl = (72 - i) * 0.25 - (i > 30 && i < 40 ? 4 : 0);
      w.store.run('INSERT INTO equity(ts,wallet_quote,positions_quote,total_quote,realized_quote,fees_quote,open_positions,pnl_quote) VALUES(?,?,?,?,?,?,?,?)',
        now - i * 3600_000, 150, 205, 355 + pnl, 12, 1.5, 1, pnl);
    }
    const b1 = w.sent.length;
    await w.bot.handle(cbq('pfg'));
    const kirim = w.sent.slice(b1).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(kirim.length, 1, 'satu foto grafik');
    assert.ok(kirim[0].params.bytes > 15_000, `PNG sungguhan: ${kirim[0].params.bytes}`);
    // Modal tidak terlacak di dunia uji → PnL bersih jatuh ke PnL kumulatif, dan tombol
    // yang aktif menunjukkan tampilan yang benar-benar digambar.
    assert.match(kirim[0].params.caption, /Portofolio · PnL kumulatif · 7 hari/);
    const tombol = kirim[0].params.reply_markup.inline_keyboard;
    const data = tombol.flat().map((b) => b.callback_data);
    for (const r of ['24h', '7d', '30d', 'all']) assert.ok(data.includes(`pfg:${r}:pnl`), `rentang ${r} harus ada: ${data}`);
    for (const v of ['net', 'pnl', 'value']) assert.ok(data.includes(`pfg:7d:${v}`), `tampilan ${v} harus ada: ${data}`);
    assert.ok(tombol.flat().some((b) => /· 7 hari ·/.test(b.text)) && tombol.flat().some((b) => /· PnL kumulatif ·/.test(b.text)), 'yang aktif ditandai');
    // Dari pesan foto: gambar disunting, tampilan Nilai & rentang 24 jam.
    const b2 = w.sent.length;
    w.bot.photoMsgs.add(778);
    const dariFoto = cbq('pfg:24h:value');
    dariFoto.callback_query.message.message_id = 778;
    await w.bot.handle(dariFoto);
    const edit = w.sent.slice(b2).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'menyunting foto yang sama');
    assert.match(edit[0].params.caption, /Portofolio · Nilai · 24 jam/);
    assert.ok(edit[0].params.reply_markup.inline_keyboard.flat().some((b) => /· 24 jam ·/.test(b.text)));
    // Bahasa Inggris ikut ke gambar dan caption.
    w.bot.setLanguage(CHAT, 'en');
    const b3 = w.sent.length;
    await w.bot.handle(cbq('pfg:30d:pnl'));
    const en = w.sent.slice(b3).find((x) => x.method === 'sendPhoto');
    assert.match(en.params.caption, /Portfolio · Cumulative PnL · 30 days/);
  });

  await t('tombol Bagikan kartu: foto PnL dikirim ke chat itu, layar tidak diganti', async () => {
    const w = build(); w.bot.setLanguage(CHAT, 'en');
    const d = await w.api('GET', '/api/positions');
    const p = d.positions[0];
    assert.ok(p, 'perlu satu posisi terbuka di data uji');
    const before = w.sent.length;
    await w.bot.handle(cbq(`ps:${p.id}`));
    const foto = w.sent.slice(before).filter((x) => x.method === 'sendPhoto');
    assert.strictEqual(foto.length, 1, 'tepat satu foto');
    assert.strictEqual(foto[0].params.chat_id, CHAT);
    assert.ok(foto[0].params.bytes > 10_000, 'PNG sungguhan, bukan kosong');
    assert.match(foto[0].params.caption, new RegExp(`^${p.symbol0} / ${p.symbol1} .*· Quiver$`));
    assert.ok(!w.sent.slice(before).some((x) => x.method === 'editMessageText'), 'layar detail tidak boleh ditimpa');
    const ack = w.sent.slice(before).find((x) => x.method === 'answerCallbackQuery');
    assert.strictEqual(ack?.params.text, 'Card sent.');
    // Total PnL dari layar ringkasan.
    const b2 = w.sent.length;
    await w.bot.handle(cbq('os'));
    const total = w.sent.slice(b2).find((x) => x.method === 'sendPhoto');
    assert.match(total?.params.caption || '', /^Total PnL .*· Quiver$/);
    // Di bawah foto ada tombol tema & ukuran; ditekan dari pesan foto → gambarnya
    // disunting di tempat dengan tema/ukuran/sembunyi yang dipilih ditandai.
    const tombol = foto[0].params.reply_markup.inline_keyboard.flat();
    assert.ok(tombol.some((b) => b.text === '· Graphite ·') && tombol.some((b) => b.text === '· Wide ·'), `bawaan ditandai: ${tombol.map((b) => b.text)}`);
    const neonStory = tombol.find((b) => b.text === 'Neon');
    assert.strictEqual(neonStory?.callback_data, `ps:${p.id}:neon:wide:0`);
    const b3 = w.sent.length;
    w.bot.photoMsgs.add(778);
    const dariFoto = cbq(`ps:${p.id}:neon:story:1`);
    dariFoto.callback_query.message.message_id = 778;
    await w.bot.handle(dariFoto);
    const edit = w.sent.slice(b3).filter((x) => x.method === 'editMessageMedia');
    assert.strictEqual(edit.length, 1, 'menyunting foto yang sama');
    assert.ok(!w.sent.slice(b3).some((x) => x.method === 'sendPhoto'), 'tidak mengirim foto kedua');
    const teks = edit[0].params.reply_markup.inline_keyboard.flat().map((b) => b.text);
    assert.ok(teks.includes('· Neon ·') && teks.includes('· Story ·') && teks.some((x) => /^✅ Hide amounts/.test(x)), `pilihan aktif ditandai: ${teks}`);
    w.bot.stop();
  });

  await t('setiap tombol yang bisa dicapai dari menu utama bekerja', async () => {
    const w = build();
    // Tidak ditekan: memindahkan dana, menghapus, atau mengganti rahasia.
    const HINDARI = ['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'];
    const antre = ['h']; const sudah = new Set(); const layar = [];
    while (antre.length) {
      const data = antre.shift();
      if (sudah.has(data)) continue;
      sudah.add(data);
      const n = w.sent.length;
      await w.bot.handle(cbq(data));
      const o = lastOut(w.sent);
      assert.ok(o && w.sent.length > n, `tombol ${data} tidak menghasilkan apa-apa`);
      assert.ok(o.params.text && o.params.text.length > 10, `layar ${data} kosong`);
      assert.ok(!/undefined|NaN|\[object/.test(o.params.text), `layar ${data} bocor nilai mentah:\n${o.params.text}`);
      layar.push(data);
      for (const b of buttons(o)) if (!HINDARI.includes(String(b).split(':')[0])) antre.push(b);
    }
    assert.ok(layar.length > 40, `penjelajah cuma sampai ${layar.length} layar — terlalu sedikit`);
    // layar penting benar-benar terlewati
    for (const wajib of ['o', 'p', 'p:1', 't', `t:${TARGET}`, 'a:0', 'r', 'r:0', 's', 'wb', 'sr', 'sf:gas', 'sf:mesin', 'sn', 'sc', 'f', 'l', 'x', 'b', 'ml', 'sw'])
      assert.ok(sudah.has(wajib), `layar ${wajib} tidak pernah tercapai`);
  });

  await t('semua perintah slash menjawab', async () => {
    const w = build();
    for (const c of ['/menu', '/summary', '/positions', '/targets', '/activity', '/rules', '/settings', '/balance', '/leftovers', '/logs', '/tx', '/help']) {
      const n = outs(w.sent).length;
      await w.bot.handle(msg(c));
      assert.ok(outs(w.sent).length > n, `${c} tidak menjawab`);
      assert.ok(lastOut(w.sent).params.text.length > 10, `${c} menjawab kosong`);
    }
  });

  await t('setiap perintah di menu Telegram benar-benar ditangani', async () => {
    const { COMMANDS } = require('../src/telegram');
    const w = build();
    for (const [c] of COMMANDS) {
      if (c === 'scout' || c === 'research') continue;   // keduanya bertanya dulu, diuji terpisah
      const n = outs(w.sent).length;
      await w.bot.handle(msg('/' + c));
      assert.ok(outs(w.sent).length > n, `/${c} ada di menu tapi tidak menjawab`);
      assert.ok(!/tidak dikenal/i.test(lastOut(w.sent).params.text), `/${c} terdaftar di menu tapi tidak punya penanganan`);
    }
  });

  await t('nama perintah semuanya Inggris', async () => {
    const { COMMANDS } = require('../src/telegram');
    const INDO = ['ringkasan', 'posisi', 'target', 'aktivitas', 'aturan', 'pengaturan', 'saldo', 'sisa', 'riset', 'jeda', 'lanjut', 'bantuan', 'mulai'];
    for (const [c, d] of COMMANDS) {
      assert.ok(/^[a-z][a-z0-9_]{0,31}$/.test(c), `nama perintah "${c}" tidak sah menurut Telegram`);
      assert.ok(!INDO.includes(c), `perintah /${c} masih berbahasa Indonesia`);
      assert.ok(d && d.length <= 256, `keterangan /${c} kosong atau kepanjangan`);
    }
    // dan daftar itulah yang benar-benar didaftarkan ke Telegram
    const w = build();
    await w.bot.start();
    const daftar = w.sent.find((x) => x.method === 'setMyCommands');
    assert.ok(daftar, 'setMyCommands harus dipanggil saat bot menyala');
    assert.deepStrictEqual(daftar.params.commands.map((x) => x.command), COMMANDS.map(([c]) => c));
    w.bot.stop();
  });

  await t('nama Indonesia yang lama tetap diterima diam-diam', async () => {
    const w = build();
    for (const [lama, baru] of [['/ringkasan', '/summary'], ['/posisi', '/positions'], ['/bantuan', '/help']]) {
      await w.bot.handle(msg(baru));
      const a = lastOut(w.sent).params.text;
      await w.bot.handle(msg(lama));
      const b = lastOut(w.sent).params.text;
      assert.strictEqual(b.slice(0, 40), a.slice(0, 40), `${lama} tidak lagi setara dengan ${baru}`);
    }
    // …tapi tidak muncul di menu yang dilihat user
    const { COMMANDS } = require('../src/telegram');
    assert.ok(!COMMANDS.some(([c]) => c === 'ringkasan'));
  });

  await t('penyambungan memakai /start, dan bentuk lamanya masih jalan', async () => {
    for (const perintah of ['/start', '/mulai']) {
      const w = build({ chats: [] });
      const kode = w.bot.newPairCode();
      await w.bot.handle(msg(`${perintah} ${kode}`, ASING));
      assert.ok(w.bot.chats().includes(ASING), `${perintah} <kode> harus menyambungkan chat`);
    }
    // petunjuk yang ditunjukkan ke user harus menyebut /start
    const w = build({ chats: [] });
    await w.bot.handle(msg('/summary', ASING));
    assert.match(lastOut(w.sent).params.text, /\/start KODE/);
  });

  await t('perintah tak dikenal dijawab ramah, bukan galat', async () => {
    const w = build();
    await w.bot.handle(msg('/entahapa'));
    assert.match(lastOut(w.sent).params.text, /tidak dikenal/i);
  });

  // ---- aksi yang mengubah keadaan ----------------------------------------
  await t('jeda & lanjut mengubah keadaan mesin sungguhan', async () => {
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

  await t('tambah target lewat percakapan', async () => {
    const w = build();
    await w.bot.handle(cbq('ta'));
    assert.match(lastOut(w.sent).params.text, /alamat wallet/i);
    await w.bot.handle(msg('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd Bang Set'));
    const row = w.store.get('SELECT * FROM targets WHERE address=?', '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    assert.ok(row, 'target baru harus tersimpan');
    assert.strictEqual(row.label, 'Bang Set');
  });

  await t('alamat ngawur ditolak dengan pesan, bukan tersimpan', async () => {
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

  // ---- penyunting aturan --------------------------------------------------
  await t('ubah angka aturan tersimpan ke config', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_quote_per_position_usd');
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    assert.match(lastOut(w.sent).params.text, /Batas per posisi/);
    await w.bot.handle(msg('250'));
    assert.strictEqual(w.cfg.rules.sizing.max_quote_per_position_usd, 250);
    assert.strictEqual(JSON.parse(fs.readFileSync(w.cfgPath, 'utf8')).rules.sizing.max_quote_per_position_usd, 250);
  });

  await t('nilai di luar batas ditolak dan aturan lama tetap', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'swap');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_slippage_bps');
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    await w.bot.handle(msg('999999999'));
    assert.match(lastOut(w.sent).params.text, /antara/i);
    assert.strictEqual(w.cfg.rules.swap, undefined, 'aturan tidak boleh berubah kalau nilainya ditolak');
  });

  await t('sakelar boolean aturan berbalik', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'exit');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'follow_target');
    await w.bot.handle(cbq(`rb:${gi}:${fi}`));
    assert.strictEqual(w.cfg.rules.exit.follow_target, false);
    await w.bot.handle(cbq(`rb:${gi}:${fi}`));
    assert.strictEqual(w.cfg.rules.exit.follow_target, true);
  });

  await t('pilihan (mode ukuran) tersimpan lewat tombol', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = 0;
    const oi = RULE_GROUPS[gi].fields[0].opts.findIndex(([k]) => k === 'mirror');
    await w.bot.handle(cbq(`rv:${gi}:${fi}:${oi}`));
    assert.strictEqual(w.cfg.rules.sizing.mode, 'mirror');
  });

  await t('aturan khusus per target tidak mengubah aturan umum', async () => {
    const w = build();
    const gi = RULE_GROUPS.findIndex((g) => g.g === 'sizing');
    const fi = RULE_GROUPS[gi].fields.findIndex((f) => f.k === 'max_quote_per_position_usd');
    await w.bot.handle(cbq(`ts:${TARGET}`));           // pindah lingkup ke target
    await w.bot.handle(cbq(`re:${gi}:${fi}`));
    await w.bot.handle(msg('75'));
    const own = JSON.parse(w.store.get('SELECT rules FROM targets WHERE address=?', TARGET).rules);
    assert.strictEqual(own.sizing.max_quote_per_position_usd, 75);
    assert.strictEqual(w.cfg.rules.sizing, undefined, 'aturan umum tidak boleh ikut berubah');
    // dan bisa dilepas lagi
    await w.bot.handle(cbq(`rx:${gi}:${fi}`));
    assert.strictEqual(w.store.get('SELECT rules FROM targets WHERE address=?', TARGET).rules, null);
  });

  await t('lingkup aturan terpisah antar chat', async () => {
    const w = build({ chats: [CHAT, ASING] });
    await w.bot.handle(cbq(`ts:${TARGET}`, CHAT));
    assert.strictEqual(w.bot.sess(CHAT).scope, TARGET);
    assert.strictEqual(w.bot.sess(ASING).scope, 'g');
  });

  // ---- pengaturan mesin ---------------------------------------------------
  await t('ubah gas lewat bot tersimpan ke config', async () => {
    const w = build();
    await w.bot.handle(cbq('sfe:gas:0'));              // pengali harga gas
    await w.bot.handle(msg('2'));
    assert.strictEqual(w.cfg.gas.price_multiplier, 2);
  });

  await t('sakelar boolean pengaturan mesin berbalik', async () => {
    const w = build();
    const fi = require('../src/telegram').FORMS.mesin.fields.findIndex((f) => f.k === 'auto_eth_price');
    // bawaannya menyala, jadi tekanan pertama mematikannya
    await w.bot.handle(cbq(`sfb:mesin:${fi}`));
    assert.strictEqual(w.cfg.prices.auto_eth_price, false);
    await w.bot.handle(cbq(`sfb:mesin:${fi}`));
    assert.strictEqual(w.cfg.prices.auto_eth_price, true);
  });

  await t('sakelar notifikasi Telegram tersimpan', async () => {
    const w = build();
    assert.strictEqual(w.bot.notifCfg().info, false);
    await w.bot.handle(cbq('snb:info'));
    assert.strictEqual(w.bot.notifCfg().info, true);
  });

  // ---- pengaman ------------------------------------------------------------
  await t('mode LIVE butuh ketikan konfirmasi', async () => {
    const w = build();
    await w.bot.handle(cbq('sl'));
    assert.match(lastOut(w.sent).params.text, /Ketik <code>LIVE<\/code>/);
    await w.bot.handle(msg('iya'));                     // konfirmasi salah
    assert.strictEqual(w.cfg.mode.dry_run, true, 'LIVE tidak boleh menyala tanpa konfirmasi tepat');
    await w.bot.handle(cbq('sl'));
    await w.bot.handle(msg('LIVE'));
    assert.strictEqual(w.cfg.mode.dry_run, false);
  });

  await t('tutup posisi lewat dua langkah, dan ditolak saat simulasi', async () => {
    const w = build();
    await w.bot.handle(cbq('pc:1'));
    assert.match(lastOut(w.sent).params.text, /Tutup posisi #1/);
    assert.ok(buttons(lastOut(w.sent)).includes('pC:1'), 'harus ada tombol konfirmasi');
    await w.bot.handle(cbq('pC:1'));
    assert.match(lastOut(w.sent).params.text, /simulasi/i, 'mode simulasi harus menolak');
  });

  await t('tutup posisi sungguhan memanggil mesin saat LIVE', async () => {
    const w = build({ dryRun: false });
    let dipanggil = null;
    w.engine.executeExit = async (plan, pos) => { dipanggil = { plan, pos }; return { txHash: '0xee' }; };
    await w.bot.handle(cbq('pC:1'));
    assert.ok(dipanggil, 'executeExit harus dipanggil');
    assert.strictEqual(dipanggil.plan.full, true);
    assert.strictEqual(dipanggil.pos.id, 1);
    assert.match(lastOut(w.sent).params.text, /ditutup/i);
  });

  await t('bot tidak pernah menyediakan jalan impor/ekspor kunci privat', async () => {
    const w = build();
    await w.bot.handle(cbq('wb'));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /sengaja tidak disediakan/i);
    for (const b of buttons(lastOut(w.sent))) assert.ok(!/import|impor|export|ekspor/i.test(b));
    // dan tidak ada rute impor yang bisa dicapai dari mana pun di bot
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    assert.ok(!src.includes('/api/settings/wallet/import'), 'telegram.js tidak boleh memanggil rute impor kunci');
  });

  await t('penggantian wallet tetap ditolak saat LIVE (aturan dasbor ikut berlaku)', async () => {
    const w = build({ dryRun: false });
    await w.bot.handle(cbq('wbG'));
    assert.match(lastOut(w.sent).params.text, /Matikan mode LIVE/i);
  });

  // ---- notifikasi ----------------------------------------------------------
  await t('kabar penting dari mesin sampai ke chat', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify = (m) => { w.engine.onNotify?.(m); };
    w.engine.notify('LP disalin: USDG/MEME $200');
    await new Promise((r) => setTimeout(r, 50));
    const o = outs(w.sent).find((x) => /Posisi disalin/.test(x.params.text));
    assert.ok(o, 'kabar penting harus terkirim');
    assert.strictEqual(String(o.params.chat_id), CHAT);
    w.bot.stop();
  });

  await t('kabar LP disalin menjadi kartu: pasangan, nilai, rentang, target, tx, tombol', async () => {
    const w = build({ dryRun: false });
    // Ongkos membuka posisi #1: zap (gas + selisih kutipan) lalu mint. Kartu masuk
    // harus menyebutnya — gas dan slippage tidak pernah muncul di PnL.
    const buka = Date.now() - 3600_000;
    w.store.run("INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES('0xzapcc',?,'zap_swap','sukses',100000,'1000000000',?)",
      buka - 10_000, JSON.stringify({ pool: '0xpool', usdIn: 100, usdOut: 99.4 }));
    w.store.run("INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,detail) VALUES('0xcc',?,'mint','sukses',200000,'1000000000',?)",
      buka, JSON.stringify({ pool: '0xpool', recorded: 1, zapped: { hashes: ['0xzapcc'] } }));
    await w.bot.start();
    w.engine.notify('LP disalin: USDG/MEME $200,00', {
      kind: 'entry', positionId: 1, txHash: '0xmint1234567890', adding: false, pair: 'USDG/MEME', valueUsd: 200,
      curTick: 0, steps: ['bungkus 0.05000 ETH', 'zap beli token1 via Kyber'],
      target: TARGET, mirrorOf: '777', reason: 'target membuka posisi baru',
    });
    await new Promise((r) => setTimeout(r, 80));
    const o = outs(w.sent).find((x) => /Posisi disalin/.test(x.params.text));
    assert.ok(o, 'kartu harus terkirim');
    const teks = o.params.text;
    assert.match(teks, /🟢 LIVE/);
    assert.match(teks, /<b>USDG\/MEME<\/b>/);
    assert.match(teks, /\$200,00/);
    assert.match(teks, /Rentang harga — MEME dalam USDG/);
    assert.match(teks, /●/, 'batang rentang harus bertitik (harga kini dari tick mint)');
    assert.match(teks, /Bang GE/, 'nama target harus tampil');
    assert.match(teks, /NFT #777/);
    assert.match(teks, /Target membuka posisi baru/);
    assert.match(teks, /bungkus 0.05000 ETH · zap beli token1 via Kyber/);
    // gas 0,0003 ETH × $2500 = $0,75 · selisih zap $0,60
    assert.match(teks, /⛽ Ongkos <b>\$1,35<\/b>/, `ongkos buka harus tercetak: ${teks}`);
    assert.match(teks, /slippage \$0,60/);
    assert.match(teks, /0xmint1234/);
    assert.ok(!/LP disalin:/.test(teks), 'teks polos lama tidak boleh ikut tercetak');
    const tombol = o.params.reply_markup.inline_keyboard.flat().map((b) => b.callback_data);
    assert.ok(tombol.includes('p:1') && tombol.includes('pc:1'), `tombol posisi/tutup harus ada: ${tombol}`);
    w.bot.stop();
  });

  await t('kabar LP ditutup menjadi kartu: hasil, modal, PnL, alasan, sisa terjual', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('LP ditutup: tutup penuh posisi #2', {
      kind: 'exit', positionId: 2, txHash: '0xburn1234567890', full: true, sold: 'jual 1234 MEME → $4,20 (kyber)',
      target: TARGET, mirrorOf: '778', reason: 'target menarik 100% likuiditas',
    });
    await new Promise((r) => setTimeout(r, 80));
    const o = outs(w.sent).find((x) => /Posisi ditutup/.test(x.params.text));
    assert.ok(o, 'kartu harus terkirim');
    const teks = o.params.text;
    assert.match(teks, /🧪 SIMULASI/);
    assert.match(teks, /<b>USDG\/MEME<\/b> · NFT #889/);
    assert.match(teks, /📈 Untung <b>\+\$12,00<\/b>\s+\+12,0%/);
    assert.match(teks, /Hasil\s+\$112,00/);
    assert.match(teks, /Modal\s+\$100,00/);
    assert.match(teks, /Target menarik 100% likuiditas/);
    assert.match(teks, /🧹 Menjual 1234 MEME → \$4,20/);
    assert.match(teks, /0xburn1234/);
    w.bot.stop();
  });

  await t('keluar mandiri dan sisa terjual punya kartunya sendiri', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('keluar mandiri #2: stop loss -12.0%', { kind: 'exit', positionId: 2, txHash: '0xee', full: true, auto: true, reason: 'stop loss -12.0%' });
    w.engine.notify('posisi #1: jual 5.000 MEME → $4.20 (uji-dex)', { kind: 'leftover', positionId: 1, txHash: '0xswap', label: '5.000 MEME', usdIn: 5, usdOut: 4.2, dex: 'uji-dex', tries: 2 });
    await new Promise((r) => setTimeout(r, 1300));
    const teks = outs(w.sent).map((x) => x.params.text);
    const keluar = teks.find((x) => /Aturan keluar terpicu/.test(x));
    assert.ok(keluar, 'kartu keluar mandiri harus terkirim');
    assert.match(keluar, /Batas kerugian tercapai: -12.0%/);
    const sisa = teks.find((x) => /Token sisa terjual/.test(x));
    assert.ok(sisa, 'kartu sisa harus terkirim');
    assert.match(sisa, /\$4,20/);
    assert.match(sisa, /Selisih\s+-16,0%/);
    assert.match(sisa, /uji-dex/);
    assert.match(sisa, /ke-3/);
    w.bot.stop();
  });

  await t('sisa yang DITOLAK dijual jadi kartu alarm: angka rugi, batas, jadwal, dan tombol jalan keluar', async () => {
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
    const kartu = outs(w.sent).filter((x) => /Penjualan sisa tertunda/.test(x.params.text));
    assert.strictEqual(kartu.length, 2, 'dua kartu alarm harus terkirim');
    const [a, b] = kartu.map((x) => x.params.text);
    assert.match(a, /⚠️/);
    assert.match(a, /6\.882e\+5 MEME/);
    assert.match(a, /60,8%/);
    assert.match(a, /15,0%/);
    assert.match(a, /\$229,44/);
    assert.match(a, /\$90,01/);
    assert.match(a, /tiap 5 dtk/);
    assert.match(a, /Jumlah percobaan\s+1×/);
    assert.match(b, /Rute tidak tersedia/);
    assert.match(b, /sejak/);
    const tombol = JSON.stringify(kartu[0].params.reply_markup || {});
    for (const cb of ['"fr"', '"sw"', '"f"', '"r"']) assert.ok(tombol.includes(cb), `tombol ${cb} harus ada`);
    w.bot.stop();
  });

  await t('kabar tanpa detail atau posisi yang tak dikenal tetap terkirim sebagai teks', async () => {
    const w = build();
    await w.bot.start();
    w.engine.notify('kabar bebas tanpa detail');
    w.engine.notify('LP ditutup: posisi #999', { kind: 'exit', positionId: 999, full: true, txHash: '0xzz' });
    await new Promise((r) => setTimeout(r, 1300));
    const teks = outs(w.sent).map((x) => x.params.text);
    assert.ok(teks.some((x) => /🔔 <b>kabar bebas tanpa detail<\/b>/.test(x)), 'teks polos harus tetap terkirim');
    assert.ok(teks.some((x) => /Posisi ditutup/.test(x) && /posisi #999/.test(x)), 'kartu tanpa data posisi tetap terkirim');
    w.bot.stop();
  });

  await t('ringkasan: portofolio, PnL, posisi, rekam jejak, sumber, penyalinan', async () => {
    const w = build();
    w.engine.cash = { usdg: 150, eth: 0.1, weth: 0, usd: 400, ts: Date.now() };
    await w.bot.handle(cbq('o'));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /✅ Sehat/);
    assert.match(teks, /💰 Portofolio <b>\$606,50<\/b>/, `nilai = kas + posisi + fee:\n${teks}`);
    assert.match(teks, /PnL <b>🟢 \+\$18,50<\/b>/);
    assert.match(teks, /Kas wallet\s+\$400,00/);
    assert.match(teks, /Posisi terbuka · 1/);
    assert.match(teks, /USDG\/MEME\s+Bang GE\s+🟢 \+\$6,50/);
    assert.match(teks, /Rekam jejak · 1 ditutup/);
    assert.match(teks, /Bang GE\s+1 buka/);
    assert.match(teks, /akan disalin \(simulasi\)/);
    assert.ok(!/24 jam \+\$0,00/.test(teks), 'tanpa riwayat, perubahan 24 jam tidak boleh tampil sebagai nol');
    assert.ok(!/0 dtk lalu/.test(teks), 'sinkron barusan ditulis "baru saja"');
  });

  await t('ringkasan: baris kesehatan menyebut masalah pertama yang ada', async () => {
    const w = build();
    w.engine.head = 1200; w.engine.cursor = 1000;
    await w.bot.handle(cbq('o'));
    assert.match(lastOut(w.sent).params.text, /⚠️ <b>Tertinggal 200 blok<\/b>/);
    w.store.setState('paused', '1');
    await w.bot.handle(cbq('h'));
    assert.match(lastOut(w.sent).params.text, /⏸ <b>Dijeda<\/b>/);
  });

  await t('galat yang ditangani cadangan tidak dikirim; macet terus = satu peringatan, lalu satu kabar pulih', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    const eng = Object.assign(Object.create(Engine.prototype), { store: w.store, troubles: new Map() });
    // empat kali gagal: ditangani cadangan -> diam
    for (let i = 0; i < 4; i++) eng.trouble('tick', `tick: eth_getLogs: historical state is not available — rentang -> 750`, { after: 5 });
    await new Promise((r) => setTimeout(r, 30));
    const kirim = () => w.bot.queue.map((x) => x.text).concat(outs(w.sent).map((x) => x.params.text)).filter((x) => /getLogs|pemindaian/.test(x));
    assert.strictEqual(kirim().length, 0, `galat sesaat tidak boleh dikirim:\n${kirim().join('\n')}`);
    assert.ok(w.store.all("SELECT 1 FROM logs WHERE msg LIKE 'tick:%'").length >= 4, 'galat tetap tercatat di log');
    // kelima: cadangan dianggap gagal -> satu peringatan, kali berikutnya diam lagi
    eng.trouble('tick', 'tick: eth_getLogs: historical state is not available — rentang -> 375', { after: 5 });
    eng.trouble('tick', 'tick: eth_getLogs: historical state is not available — rentang -> 150', { after: 5 });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(kirim().length, 1, `harus tepat satu peringatan:\n${kirim().join('\n')}`);
    assert.match(kirim()[0], /⛔ <b>Galat · tick<\/b>[\s\S]*gagal 5× berturut-turut/);
    // pulih -> satu kabar, dan hitungan mulai dari nol
    eng.cleared('tick', 'pemindaian blok: kembali normal, kursor di blok 1000');
    eng.cleared('tick', 'pemindaian blok: kembali normal');
    await new Promise((r) => setTimeout(r, 1200));
    const semua = kirim();
    assert.strictEqual(semua.length, 2, `harus ada satu kabar pulih:\n${semua.join('\n')}`);
    assert.match(semua[1], /✅ <b>Pulih · pemindaian blok<\/b>\nkembali normal, kursor di blok 1000 — pulih setelah 6× gagal/);
    // gagal sesaat tanpa pernah memperingatkan -> pulihnya juga diam
    eng.trouble('kas', 'saldo kas: RPC 429', { after: 5 });
    eng.cleared('kas', 'saldo kas: berhasil lagi');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!kirim().concat(w.bot.queue.map((x) => x.text)).some((x) => /saldo kas/.test(x)), 'pulih tanpa peringatan tidak dikabarkan');
    w.bot.stop();
  });

  await t('galat tanpa cadangan (mis. eksekusi masuk) tetap langsung dikirim', async () => {
    const w = build();
    await w.bot.start();
    w.store.log('error', 'eksekusi masuk: saldo USDG kurang');
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(w.bot.queue.concat(outs(w.sent).map((x) => ({ text: x.params.text }))).some((x) => /saldo USDG kurang/.test(x.text)));
    w.bot.stop();
  });

  await t('galat ikut terkirim, baris info tidak (setelan bawaan)', async () => {
    const w = build();
    await w.bot.start();
    w.store.log('error', 'uji: sesuatu meledak');
    w.store.log('info', 'uji: kabar biasa');
    await new Promise((r) => setTimeout(r, 50));
    const teks = outs(w.sent).map((x) => x.params.text).join('\n');
    assert.match(teks, /sesuatu meledak/);
    assert.match(teks, /⛔ <b>Galat · uji<\/b>\nsesuatu meledak/, 'konteks galat harus jadi judul');
    assert.ok(!/kabar biasa/.test(teks), 'baris info tidak boleh dikirim kalau setelannya mati');
    w.bot.stop();
  });

  await t('kabar penting tidak dikirim dua kali walau baris log dinyalakan', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    await w.bot.handle(cbq('snb:info'));                // nyalakan pengiriman baris log
    // notify() ASLI dari mesin, supaya urutan "beri tahu pendengar lalu catat log"
    // ikut teruji — kalau urutannya dibalik, gemanya lolos dan uji ini merah.
    // teks yang tidak muncul di layar mana pun, supaya hitungannya bersih
    Engine.prototype.notify.call(w.engine, 'kabar-uji-unik-9137');
    const n = w.bot.queue.filter((x) => /9137/.test(x.text)).length
      + outs(w.sent).filter((x) => /9137/.test(x.params.text)).length;
    assert.strictEqual(n, 1, `kabar yang sama masuk antrean ${n} kali`);
    // baris log biasa tetap ikut terkirim saat setelan itu menyala
    Engine.prototype.notify.call(w.engine, 'kabar lain');
    w.store.log('info', 'benar-benar baris log');
    assert.ok(w.bot.queue.some((x) => /benar-benar baris log/.test(x.text)), 'baris log biasa harus tetap terkirim');
    w.bot.stop();
  });

  await t('antrean sisa menyebut berapa kali sudah dicoba dan sejak kapan', async () => {
    const w = build();
    await w.bot.handle(cbq('f'));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /dicoba\s+2×/, `teks antrean salah:\n${teks}`);
    assert.match(teks, /sejak\s+\d+ (dtk|mnt) lalu/, `waktu mulai tersangkut harus tampil:\n${teks}`);
    assert.match(teks, /rugi rute rugi 18%|rute rugi 18%/);
  });

  await t('banjir log tidak menumpuk antrean tanpa batas', async () => {
    const w = build();
    await w.bot.start();
    for (let i = 0; i < 500; i++) w.store.log('error', `banjir ${i}`);
    assert.ok(w.bot.queue.length <= 41, `antrean membengkak jadi ${w.bot.queue.length}`);
    w.bot.stop();
  });

  // ---- memasang token tanpa restart proses --------------------------------
  await t('bot yang hidup tanpa token langsung jalan begitu tokennya disimpan', async () => {
    const w = build({ chats: [] });
    w.cfg.telegram.bot_token = null;                 // persis keadaan proses yang hidup duluan
    const r0 = await w.bot.start();
    assert.strictEqual(r0.ok, false);
    assert.strictEqual(w.bot.polls.length, 0, 'tanpa token tidak boleh ada polling');

    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.telegram.running, true, 'dasbor harus melaporkan bot sudah jalan');
    assert.strictEqual(w.bot.polls.length, 1, 'polling harus dimulai tanpa restart proses');
    assert.ok(w.bot.me, 'getMe harus sudah dipanggil');
    w.bot.stop();
  });

  await t('kode sambung yang dibuat setelah token disimpan benar-benar bisa dipakai', async () => {
    const w = build({ chats: [] });
    w.cfg.telegram.bot_token = null;
    await w.bot.start();
    await w.api('POST', '/api/settings/telegram', { bot_token: '987654321:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' });
    const r = await w.api('POST', '/api/settings/telegram/pair', {});
    assert.ok(r.code, 'kode harus terbuat');
    await w.bot.handle(msg(`/start ${r.code}`, ASING));
    assert.ok(w.bot.chats().includes(ASING), 'kode dari dasbor harus diterima bot');
    w.bot.stop();
  });

  await t('ganti token menghentikan pendengar lama (tidak ada dua loop)', async () => {
    const w = build();
    await w.bot.start();
    const gen1 = w.bot.polls.at(-1);
    await w.api('POST', '/api/settings/telegram', { bot_token: '111111111:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' });
    const gen2 = w.bot.polls.at(-1);
    assert.ok(gen2 > gen1, 'generasi harus naik supaya loop lama berhenti sendiri');
    assert.strictEqual(w.bot.gen, gen2, 'hanya generasi terakhir yang berlaku');
    w.bot.stop();
    assert.ok(w.bot.gen > gen2, 'stop() juga harus membatalkan generasi berjalan');
  });

  await t('menyalakan ulang tidak melipatgandakan kabar', async () => {
    const { Engine } = require('../src/engine');
    const w = build();
    await w.bot.start();
    await w.bot.restart();
    await w.bot.restart();
    Engine.prototype.notify.call(w.engine, 'kabar-uji-unik-4412');
    const n = w.bot.queue.filter((x) => /4412/.test(x.text)).length
      + outs(w.sent).filter((x) => /4412/.test(x.params.text)).length;
    assert.strictEqual(n, 1, `kabar terkirim ${n} kali setelah tiga kali penyalaan`);
    w.bot.stop();
  });

  await t('token yang ditolak Telegram dilaporkan, bukan didiamkan', async () => {
    const w = build();
    const asli = w.bot.tg.bind(w.bot);
    w.bot.tg = async (m, p) => { if (m === 'getMe') throw new Error('401: Unauthorized'); return asli(m, p); };
    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '222222222:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' });
    assert.match(r.error || '', /menolaknya|Unauthorized/i, 'galat dari Telegram harus sampai ke dasbor');
    assert.strictEqual(w.cfg.telegram.bot_token, '222222222:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', 'token tetap tersimpan supaya bisa diperbaiki');
    w.bot.stop();
  });

  await t('melepas token menghentikan bot', async () => {
    const w = build();
    await w.bot.start();
    const n = w.bot.polls.length;
    const r = await w.api('POST', '/api/settings/telegram', { bot_token: '' });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.telegram.hasToken, false);
    assert.strictEqual(w.bot.polls.length, n, 'tanpa token tidak boleh ada polling baru');
  });

  await t('loop polling SUNGGUHAN berhenti sendiri begitu generasinya kedaluwarsa', async () => {
    const { Telegram } = require('../src/telegram');
    const w = build();
    w.bot.poll = Telegram.prototype.poll.bind(w.bot);   // loop asli, bukan pencatat
    const panggilan = [];
    const asli = w.bot.tg.bind(w.bot);
    w.bot.tg = async (m, p) => {
      if (m !== 'getUpdates') return asli(m, p);
      panggilan.push(w.bot.gen);                        // generasi milik loop yang memanggil
      await new Promise((r) => setTimeout(r, 15));
      return [];
    };
    const tunggu = (ms) => new Promise((r) => setTimeout(r, ms));
    await w.bot.start();
    await tunggu(70);
    const genLama = w.bot.gen;
    assert.ok(panggilan.filter((g) => g === genLama).length >= 2, 'loop pertama harus benar-benar berjalan');

    const batas = panggilan.length;
    await w.bot.restart();
    await tunggu(90);
    const sesudah = panggilan.slice(batas);
    assert.ok(!sesudah.includes(genLama), `loop lama masih memanggil getUpdates ${sesudah.filter((g) => g === genLama).length}x setelah token diganti`);
    assert.ok(sesudah.includes(w.bot.gen), 'loop baru harus mengambil alih');

    w.bot.stop();
    const akhir = panggilan.length;
    await tunggu(90);
    assert.strictEqual(panggilan.length, akhir, 'stop() harus benar-benar menghentikan polling');
  });

  // ---- pembacaan & penulisan nilai ---------------------------------------
  await t('parseVal menerima bentuk manusiawi dan menolak yang ngawur', async () => {
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

  await t('showVal menampilkan bps sebagai persen, bukan angka mentah', async () => {
    assert.strictEqual(showVal({ type: 'bps' }, 150), '1,5%');
    assert.strictEqual(showVal({ type: 'bps' }, 500), '5%');
    assert.strictEqual(showVal({ type: 'bool' }, true), '✅ ya');
    assert.strictEqual(showVal({ type: 'daftar' }, []), '(kosong)');
    // pemisah ribuan Indonesia adalah titik: jangan sampai "1.000" dipangkas jadi "1."
    assert.strictEqual(showVal({ type: 'int' }, 1000), '1.000');
    assert.strictEqual(showVal({ type: 'int' }, 4000000), '4.000.000');
    assert.strictEqual(showVal({ type: 'num' }, 0.004), '0,004');
  });

  await t('setiap kolom aturan benar-benar ada di mesin aturan', async () => {
    const { DEFAULTS } = require('../src/policy');
    for (const g of RULE_GROUPS) {
      assert.ok(DEFAULTS[g.g], `kelompok ${g.g} tidak ada di policy.js`);
      for (const f of g.fields) {
        assert.ok(f.k in DEFAULTS[g.g], `aturan ${g.g}.${f.k} ada di menu tapi tidak dikenal policy.js`);
      }
    }
    // dan sebaliknya: tidak ada aturan yang terlupa dari menu
    for (const [g, obj] of Object.entries(DEFAULTS)) {
      const grp = RULE_GROUPS.find((x) => x.g === g);
      assert.ok(grp, `kelompok aturan ${g} belum punya menu di bot`);
      for (const k of Object.keys(obj)) {
        assert.ok(grp.fields.some((f) => f.k === k), `aturan ${g}.${k} belum bisa disetel dari bot`);
      }
    }
  });

  // ---- LP manual -----------------------------------------------------------
  await t('rencana LP manual: nominal dan rentang dihitung benar', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.plan.action, 'mint');
    assert.strictEqual(r.plan.target, null, 'LP manual tidak boleh mencermin siapa pun');
    assert.strictEqual(r.plan.mirrorOf, null);
    assert.ok(Math.abs(r.preview.valueUsd - 50) < 0.5, `nilai ${r.preview.valueUsd}, minta $50`);
    // ±25% pada tick 0 -> ln(1,25)/ln(1,0001) ≈ 2231 tick, dibulatkan ke kelipatan 60
    assert.ok(r.plan.tickLower <= -2220 && r.plan.tickLower >= -2280, `tickLower ${r.plan.tickLower}`);
    assert.ok(r.plan.tickUpper >= 2220 && r.plan.tickUpper <= 2280, `tickUpper ${r.plan.tickUpper}`);
    assert.strictEqual(Math.abs(r.plan.tickLower % 60), 0, 'tick harus kelipatan tickSpacing');
    assert.strictEqual(Math.abs(r.plan.tickUpper % 60), 0);
    assert.strictEqual(r.preview.side, 'both');
  });

  await t('rencana LP manual: saldo dan auto-swap yang akan dijalankan ikut dipratinjau', async () => {
    const w = build();
    // Kas USDG cukup: tidak perlu jembatan, cukup zap USDG -> MEME.
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    const sw = r.preview.swaps;
    assert.deepStrictEqual(sw.map((x) => x.jenis), ['zap']);
    assert.strictEqual(sw[0].dari.symbol, 'USDG');
    assert.strictEqual(sw[0].ke.symbol, 'MEME');
    // dibayar dengan ruang slippage 1,5% dari porsi MEME (~separuh nilai posisi)
    assert.ok(sw[0].dari.usd > 24 && sw[0].dari.usd < 27, `zap ${sw[0].dari.usd}`);
    const saldo = Object.fromEntries(r.preview.saldo.tokens.map((x) => [x.symbol, x]));
    assert.strictEqual(saldo.USDG.amount, 150);
    assert.ok(saldo.USDG.sesudah > 99 && saldo.USDG.sesudah < 101, `USDG sesudah ${saldo.USDG.sesudah}`);
    assert.ok('MEME' in saldo, 'token pasangan pool ikut ditampilkan');

    // Kas hanya ETH: jembatan ETH -> USDG dulu, baru zap.
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(), t2 === ADDR.native ? 10n ** 17n : 0n]));
    const e = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(!e.error, e.error);
    assert.deepStrictEqual(e.preview.swaps.map((x) => x.jenis), ['jembatan', 'zap']);
    assert.strictEqual(e.preview.swaps[0].dari.symbol, 'ETH');
    assert.ok(Math.abs(e.preview.swaps[0].ke.amount - 52.5) < 0.01, 'jembatan menyediakan 105% nilai posisi');
    assert.ok(!e.warnings.some((x) => /jembatan|zap/.test(x)), e.warnings.join('; '));

    // Auto-swap dimatikan: langkahnya tetap terlihat, dan diperingatkan akan berhenti.
    w.engine.rulesFrom = () => { const x = rulesFor(w.engine.cfg.rules, null); x.swap.enabled = false; return x; };
    const off = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(off.warnings.some((x) => /auto-swap dimatikan/.test(x)), off.warnings.join('; '));

    const sd = await w.api('GET', '/api/manual/saldo', {}, { poolRef: '0xpool' });
    assert.ok(!sd.error, sd.error);
    assert.ok(Math.abs(sd.kasUsd - 250) < 0.01, `kas ${sd.kasUsd}`);
  });

  await t('rentang lebih sempit menghasilkan likuiditas lebih padat', async () => {
    const w = build();
    const a = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 5 });
    const b = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 50 });
    assert.ok(BigInt(a.plan.liquidity) > BigInt(b.plan.liquidity),
      'nominal sama di rentang lebih sempit harus memberi L lebih besar');
    assert.ok(Math.abs(a.preview.valueUsd - b.preview.valueUsd) < 1, 'nilainya tetap sama-sama $50');
  });

  await t('satu sisi tersedia di LP manual dan shortcut Telegram', async () => {
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

  await t('auto-compound bisa diatur per posisi dari Telegram', async () => {
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

  await t('claim fee Telegram meminta konfirmasi lalu memakai endpoint bersama', async () => {
    const w = build({ dryRun: false });
    const calls = [];
    w.engine.claimFees = async (id) => { calls.push(id); return { ok: true, tx: '0xclaim', claimedUsd: 1.5 }; };
    await w.bot.handle(cbq('p:1'));
    assert.ok(buttons(lastOut(w.sent)).includes('pf:1'));
    await w.bot.handle(cbq('pf:1'));
    assert.deepStrictEqual(calls, []);
    assert.ok(buttons(lastOut(w.sent)).includes('pF:1'));
    await w.bot.handle(cbq('pF:1'));
    assert.deepStrictEqual(calls, [1]);
    assert.match(lastOut(w.sent).params.text, /tetap terbuka/);
    assert.ok((await w.api('POST', '/api/positions/claim', { id: -1 })).error);
  });

  await t('rentang asimetris: turun 10% / naik 30% dari harga kini', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, lowerPct: 10, upperPct: 30 });
    assert.ok(!r.error, r.error);
    // dibulatkan MELEBAR ke tick spacing: tidak pernah lebih sempit dari yang diminta
    assert.ok(r.preview.lowerPct >= 10 - 1e-9 && r.preview.lowerPct < 12, `bawah ${r.preview.lowerPct}`);
    assert.ok(r.preview.upperPct >= 30 - 1e-9 && r.preview.upperPct < 33, `atas ${r.preview.upperPct}`);
    const bad = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, lowerPct: 100, upperPct: 10 });
    assert.match(bad.error || '', /batas bawah/);
  });

  await t('rentang Telegram: "10 30", "-10 +30", "−10/+30", "25"', async () => {
    const { parseRentang, rentangTeks } = require('../src/telegram');
    for (const x of ['10 30', '-10 +30', '−10/+30', '10% 30%', '10, 30']) {
      assert.deepStrictEqual(parseRentang(x), { lowerPct: 10, upperPct: 30 }, x);
    }
    assert.deepStrictEqual(parseRentang('25'), { lowerPct: 25, upperPct: 25 });
    assert.deepStrictEqual(parseRentang('2,5 7,5'), { lowerPct: 2.5, upperPct: 7.5 });
    assert.deepStrictEqual(parseRentang('10-30'), { lowerPct: 10, upperPct: 30 }, 'strip = pemisah, bukan tanda');
    // Tanda eksplisit memindah batas ke sisi lain harga kini.
    assert.deepStrictEqual(parseRentang('-30 -10'), { lowerPct: 30, upperPct: -10 });
    assert.deepStrictEqual(parseRentang('−10 −30'), { lowerPct: 30, upperPct: -10 }, 'urutan terbalik dirapikan');
    assert.deepStrictEqual(parseRentang('+10 +30'), { lowerPct: -10, upperPct: 30 });
    assert.strictEqual(rentangTeks({ lowerPct: 30, upperPct: -10 }), '−30% / −10%');
    assert.strictEqual(rentangTeks({ lowerPct: -10, upperPct: 30 }), '+10% / +30%');
    assert.strictEqual(rentangTeks({ lowerPct: 25, upperPct: 0 }), '−25% / 0%');
    assert.ok(parseRentang('-10 -10').error);
    assert.ok(parseRentang('-100 -10').error);
    assert.ok(parseRentang('100 10').error);
    assert.ok(parseRentang('0 0').error);
    assert.ok(parseRentang('1 2 3').error);
    assert.ok(parseRentang('lebar').error);
    assert.strictEqual(rentangTeks({ lowerPct: 10, upperPct: 30 }), '−10% / +30%');
    assert.strictEqual(rentangTeks({ lowerPct: 25, upperPct: 25 }), '±25%');
    assert.strictEqual(rentangTeks({ widthPct: 25 }), '±25%', 'sesi lama');

    const w = build();
    await w.bot.handle(cbq('ml'));
    await w.bot.handle(cbq('mlC'));
    await w.bot.handle(msg('10 30'));
    assert.match(lastOut(w.sent).params.text, /−10% \/ \+30%/);
    const se = w.bot.sess(CHAT).lp;
    assert.strictEqual(se.lowerPct, 10); assert.strictEqual(se.upperPct, 30);
  });

  await t('LP manual menolak pool ber-hook selama hook belum diizinkan', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xhook', usd: 50 });
    assert.match(r.error || '', /hook/i, 'pool ber-hook harus ditolak');
    assert.ok(!r.plan);
    // …dan diizinkan kalau user memang menyalakannya
    w.cfg.rules = { filters: { allow_hooks: true } };
    const r2 = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xhook', usd: 50 });
    assert.ok(!r2.error, r2.error);
  });

  await t('LP manual menghormati batas yang sudah disetel', async () => {
    const w = build();
    w.cfg.rules = { sizing: { max_quote_per_position_usd: 30 } };
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /batas per posisi/i, r.error);
    assert.match(r.error || '', /\$30/, 'pesannya harus menyebut batas yang menghalangi');

    w.cfg.rules = { filters: { max_open_positions: 1 } };   // sudah ada 1 posisi terbuka
    const r2 = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 10 });
    assert.match(r2.error || '', /posisi terbuka/i, r2.error);
  });

  await t('LP manual menolak kalau kas tidak cukup', async () => {
    const w = build();
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(), 0n]));
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /kas cuma/i, r.error);
  });

  await t('LP manual: pool tidak dikenal ditolak, bukan melempar', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xtidakada', usd: 50 });
    assert.match(r.error || '', /tidak dikenal/i);
    for (const usd of [0, -5, NaN]) {
      const bad = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd });
      assert.ok(bad.error, `nominal ${usd} harus ditolak`);
    }
  });

  await t('LP manual ditolak di mode simulasi', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50 });
    assert.match(r.error || '', /simulasi/i);
    assert.strictEqual(w.engine.dibuka.length, 0, 'tidak boleh ada eksekusi di mode simulasi');
  });

  await t('LP manual LIVE menyusun ulang rencana sebelum mengirim', async () => {
    const w = build({ dryRun: false });
    const r = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50, widthPct: 10 });
    assert.ok(r.ok, r.error);
    assert.strictEqual(w.engine.dibuka.length, 1, 'executeEntry harus dipanggil sekali');
    const { plan, act } = w.engine.dibuka[0];
    assert.strictEqual(act.target, null, 'act manual tidak punya target');
    assert.ok(act.slot0, 'harga pool harus ikut supaya taksiran zap benar');
    assert.strictEqual(plan.venue, 'v4');
    assert.ok(Math.abs(plan.valueUsd - 50) < 0.5);
    // rencana yang dieksekusi adalah hasil hitung ulang server, bukan kiriman klien
    const palsu = await w.api('POST', '/api/manual/lp/open', { poolRef: '0xpool', usd: 50, liquidity: '999999999999', valueUsd: 1 });
    assert.ok(palsu.ok, palsu.error);
    assert.notStrictEqual(w.engine.dibuka[1].plan.liquidity, '999999999999', 'rencana kiriman klien tidak boleh dipakai');
  });

  await t('layar LP manual menuntun langkah demi langkah', async () => {
    const w = build();
    await w.bot.handle(cbq('ml'));
    assert.match(lastOut(w.sent).params.text, /belum dipilih/);
    await w.bot.handle(cbq('mlp:0'));
    assert.match(lastOut(w.sent).params.text, /Pilih pool/);
    assert.ok(buttons(lastOut(w.sent)).some((b) => b.startsWith('mlP:')), 'pool harus punya tombol');
    await w.bot.handle(cbq('mlP:0'));
    await w.bot.handle(cbq('mln'));
    await w.bot.handle(msg('50'));
    await w.bot.handle(cbq('mlw:10:10'));
    const menu = lastOut(w.sent).params.text;
    assert.match(menu, /\$50/);
    assert.match(menu, /±10%/);
    assert.ok(buttons(lastOut(w.sent)).includes('mlv'), 'tombol pratinjau harus muncul setelah lengkap');
    await w.bot.handle(cbq('mlv'));
    const pratinjau = lastOut(w.sent).params.text;
    assert.match(pratinjau, /Pratinjau/);
    assert.match(pratinjau, /Rentang harga/);
    assert.match(pratinjau, /simulasi/i, 'mode simulasi harus diberitahukan sebelum tombol buka');
  });

  // ---- pindai pool dari alamat token -----------------------------------------
  const P1 = '0x' + '11'.repeat(32), P2 = '0x' + '22'.repeat(32), P3 = '0x' + '33'.repeat(32),
    P4 = '0x' + '44'.repeat(32), P5 = '0x' + '55'.repeat(32);
  const LOGS = [
    initLog({ id: P1, c0: ADDR.usdg, c1: MEME, fee: 3000, ts: 60, block: 900 }),          // bagus
    initLog({ id: P2, c0: ADDR.native, c1: MEME, fee: 10000, ts: 200, block: 800 }),      // bagus
    initLog({ id: P3, c0: ADDR.usdg, c1: MEME, fee: 5000, ts: 100, block: 700 }),         // kosong
    initLog({ id: P4, c0: MEME, c1: '0x' + 'ab'.repeat(20), fee: 0x800000, ts: 8, hooks: '0x' + 'cd'.repeat(20), block: 600 }),
    initLog({ id: P5, c0: ADDR.usdg, c1: MEME, fee: 0x800000, ts: 8, hooks: '0x' + 'ef'.repeat(20), block: 500 }),
  ];

  await t('pindai pool: event Initialize didekode utuh', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: w.engine.rpcStub || null, log: () => {} });
    man.rpc = w.kueri && null;                              // dipakai lewat api saja
    const r = await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    assert.ok(!r.error, r.error);
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    assert.strictEqual(j.status, 'selesai', j.error);
    assert.strictEqual(j.total, 5, 'kelima pool harus ketemu');
    const p1 = j.pools.find((x) => x.poolRef === P1);
    assert.ok(p1, 'pool pertama harus ada');
    assert.strictEqual(p1.fee, 3000);
    assert.strictEqual(p1.tickSpacing, 60);
    assert.strictEqual(p1.token0, ADDR.usdg);
    assert.strictEqual(p1.token1, MEME);
    assert.strictEqual(p1.hasHooks, false);
    assert.strictEqual(p1.pair, 'USDG/MEME');
    const p4 = j.pools.find((x) => x.poolRef === P4);
    assert.strictEqual(p4.hasHooks, true, 'hooks harus terbaca dari data');
    assert.strictEqual(p4.hooks, '0x' + 'cd'.repeat(20));
  });

  await t('penanda fee dinamis tidak dibaca sebagai 838,86%', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    const p4 = j.pools.find((x) => x.poolRef === P4);
    assert.strictEqual(p4.dynamicFee, true, '0x800000 adalah penanda fee dinamis, bukan angka fee');
    assert.strictEqual(p4.feePct, null, 'fee dinamis tidak punya persentase di muka');
    const p1 = j.pools.find((x) => x.poolRef === P1);
    assert.strictEqual(p1.dynamicFee, false);
    assert.strictEqual(p1.feePct, 0.3);
  });

  await t('pool sampah disembunyikan, tapi tetap dihitung', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 40 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME });
    }
    const ref = j.pools.map((p) => p.poolRef);
    assert.ok(ref.includes(P1) && ref.includes(P2), 'pool berlikuiditas & berkuotasi harus tampil');
    assert.ok(!ref.includes(P3), 'pool tanpa likuiditas harus disembunyikan');
    assert.ok(!ref.includes(P4), 'pool tanpa aset kuotasi harus disembunyikan');
    assert.ok(!ref.includes(P5), 'pool berfee dinamis harus disembunyikan');
    assert.strictEqual(j.total, 5);
    assert.strictEqual(j.hidden, 3, 'yang disembunyikan tetap dihitung supaya user tahu ada sisanya');
    const semua = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    assert.strictEqual(semua.pools.length, 5, 'all=1 menampilkan semuanya');
  });

  await t('pool hasil pindai tersimpan dan muncul di daftar biasa', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    for (let i = 0; i < 40; i++) {
      await new Promise((x) => setTimeout(x, 25));
      if ((await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME })).status !== 'jalan') break;
    }
    const daftar = (await w.api('GET', '/api/manual/pools')).pools.map((p) => p.poolRef);
    assert.ok(daftar.includes(P1), 'pool hasil pindai harus ikut di daftar pool yang dikenal');
    // …dan bisa langsung dipakai merencanakan posisi
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: P1, usd: 50, widthPct: 25 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.preview.pair, 'USDG/MEME');
  });

  // ---- tempel alamat --------------------------------------------------------
  const tempelWorld = (opts = {}) => {
    const w = build({ initLogs: LOGS, kosong: [P3], ...opts });
    w.bot.jedaPindai = [5, 5];
    return w;
  };

  await t('tempel alamat token langsung membuka kartu pasang LP', async () => {
    const w = tempelWorld();
    await w.bot.handle(msg(MEME));
    const o = lastOut(w.sent);
    assert.match(o.params.text, /Pasang LP/);
    assert.match(o.params.text, /USDG\/MEME/);
    assert.match(o.params.text, /pilih di bawah/, 'nominal belum dipilih harus diberi tahu');
    const b = buttons(o);
    for (const x of ['qkn:25', 'qkn:50', 'qkn:100', 'qkN', 'qkw:25:25', 'qkF', 'qkC', 'qkp']) assert.ok(b.includes(x), `tombol ${x} harus ada`);
    assert.ok(!b.includes('qkY'), 'tombol buka tidak muncul sebelum nominal dipilih');
  });

  await t('kartu LP: nominal & rentang diubah di tempat, pratinjau ikut', async () => {
    const w = tempelWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkn:50'));
    let teks = lastOut(w.sent).params.text;
    assert.match(teks, /\$50/);
    assert.match(teks, /kas tersedia/, 'pratinjau muncul setelah nominal dipilih');
    assert.ok(buttons(lastOut(w.sent)).some((x) => x === 'qkn:50'), 'tombol tetap ada');
    assert.ok(lastOut(w.sent).params.reply_markup.inline_keyboard.flat().some((x) => x.text === '✓ $50'), 'pilihan aktif ditandai');
    await w.bot.handle(cbq('qkw:10:30'));
    teks = lastOut(w.sent).params.text;
    assert.match(teks, /−10% \/ \+30%/);
    assert.match(teks, /simulasi/i, 'mode simulasi diberitahukan');
    assert.ok(!buttons(lastOut(w.sent)).includes('qkY'), 'mode simulasi: tidak ada tombol buka');
  });

  await t('kartu LP: ketik nominal sendiri kembali ke kartu, bukan ke menu LP', async () => {
    const w = tempelWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkN'));
    await w.bot.handle(msg('75'));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /Pasang LP/);
    assert.match(teks, /\$75/);
  });

  await t('kartu LP mode LIVE: buka → yakin → posisi dibuka dengan rentang yang dipilih', async () => {
    const w = tempelWorld({ dryRun: false });
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkn:50'));
    await w.bot.handle(cbq('qkw:10:30'));
    assert.ok(buttons(lastOut(w.sent)).includes('qkY'), 'tombol buka harus ada di LIVE');
    await w.bot.handle(cbq('qkY'));
    assert.match(lastOut(w.sent).params.text, /sungguhan/);
    assert.strictEqual(w.engine.dibuka.length, 0, 'belum ada transaksi sebelum dikonfirmasi');
    await w.bot.handle(cbq('mlX'));
    assert.strictEqual(w.engine.dibuka.length, 1);
    const pl = w.engine.dibuka[0].plan;
    // Diukur dalam HARGA yang dilihat: pool ini berkuotasi token0 (USDG), jadi harga
    // MEME turun saat tick naik — batas atas harga ada di tickLower.
    const harga = (t) => (pl.quoteSide === 1 ? 1.0001 ** t : 1.0001 ** -t);
    const [bawah, atas] = [harga(pl.tickLower), harga(pl.tickUpper)].sort((a, b) => a - b);
    assert.ok(bawah <= 0.9 && bawah > 0.88, `batas bawah ${bawah}`);
    assert.ok(atas >= 1.3 && atas < 1.32, `batas atas ${atas}`);
  });

  await t('kartu LP: ganti pool', async () => {
    const w = tempelWorld();
    await w.bot.handle(msg(MEME));
    await w.bot.handle(cbq('qkp'));
    const b = buttons(lastOut(w.sent)).filter((x) => x.startsWith('qkP:'));
    assert.ok(b.length >= 2, 'pilihan pool harus ada');
    const sebelum = w.bot.sess(CHAT).lp.poolRef;
    await w.bot.handle(cbq('qkP:1'));
    assert.notStrictEqual(w.bot.sess(CHAT).lp.poolRef, sebelum);
    assert.match(lastOut(w.sent).params.text, /Pasang LP/);
  });

  await t('tempel alamat wallet: riset atau jadikan target, bukan LP', async () => {
    const w = tempelWorld();
    const DOMPET = '0x' + 'ab'.repeat(20);
    await w.bot.handle(msg(DOMPET));
    const o = lastOut(w.sent);
    assert.match(o.params.text, /wallet, bukan token/);
    assert.ok(buttons(o).includes('wr:' + DOMPET));
    await w.bot.handle(cbq('adT'));
    assert.ok(w.store.get('SELECT 1 x FROM targets WHERE address=?', DOMPET), 'target ditambahkan');
    await w.bot.handle(msg(KONTRAK));
    assert.match(lastOut(w.sent).params.text, /Kontrak/);
    assert.strictEqual(w.store.get("SELECT COUNT(*) n FROM tokens WHERE symbol='?'").n, 0, 'alamat bukan-token tidak masuk tabel tokens');
  });

  await t('alamat di dalam tautan terbaca; poolId 64 hex tidak dikira alamat', async () => {
    const w = tempelWorld();
    await w.bot.handle(msg(`https://dexscreener.com/robinhood/${MEME}`));
    assert.match(lastOut(w.sent).params.text, /Pasang LP/);
    const n = w.sent.length;
    await w.bot.handle(msg(P1));
    assert.doesNotMatch(lastOut(w.sent).params.text || '', /Memeriksa|Pasang LP/, 'poolId tidak boleh diperlakukan sebagai alamat');
    assert.ok(w.sent.length > n);
  });

  // ---- pool Uniswap v3 ---------------------------------------------------------
  const V3A = '0x' + 'a3'.repeat(20), V3B = '0x' + 'b3'.repeat(20);
  const pindai = async (w, token) => {
    await w.api('POST', '/api/manual/pools/scan', { token });
    let j;
    for (let i = 0; i < 60 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 20));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token });
    }
    return j;
  };

  await t('pindai pool menemukan pool Uniswap v3 juga', async () => {
    const w = build({ initLogs: [...LOGS,
      createdLog({ pool: V3A, t0: ADDR.usdg, t1: MEME, fee: 3000, ts: 60 }),
      createdLog({ pool: V3B, t0: MEME, t1: '0x' + '99'.repeat(20), fee: 500, ts: 10 }),   // tanpa kuotasi
    ], kosong: [P3] });
    const j = await pindai(w, MEME);
    assert.strictEqual(j.status, 'selesai', j.error);
    const v3 = j.pools.find((p) => p.poolRef === V3A);
    assert.ok(v3, 'pool v3 harus ketemu');
    assert.strictEqual(v3.venue, 'v3');
    assert.strictEqual(v3.fee, 3000);
    assert.strictEqual(v3.tickSpacing, 60);
    assert.strictEqual(v3.pair, 'USDG/MEME');
    assert.strictEqual(v3.kosong, false, 'likuiditas v3 dibaca dari liquidity() pool');
    assert.ok(!j.pools.some((p) => p.poolRef === V3B), 'pool v3 tanpa aset kuotasi disembunyikan');
    assert.ok(j.pools.some((p) => p.venue === 'v4'), 'pool v4 tetap ada');
    // pool v3 hasil pindai tersimpan dan bisa langsung direncanakan
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: V3A, usd: 50, lowerPct: 10, upperPct: 10 });
    assert.ok(!r.error, r.error);
    assert.strictEqual(r.plan.venue, 'v3');
    assert.strictEqual(r.plan.poolKey, null);
    assert.ok(r.plan.tickLower % 60 === 0 && r.plan.tickUpper % 60 === 0, `dibulatkan ke tick spacing v3: ${r.plan.tickLower}…${r.plan.tickUpper}`);
  });

  await t('tempel token yang cuma punya pool v3: kartu LP tetap terbuka', async () => {
    const w = build({ initLogs: [createdLog({ pool: V3A, t0: ADDR.usdg, t1: MEME, fee: 10000, ts: 200 })] });
    w.bot.jedaPindai = [5, 5];
    await w.bot.handle(msg(MEME));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /Pasang LP — USDG\/MEME/);
    assert.match(teks, /v3 · fee 1%/);
  });

  await t('token tanpa pool v3/v4: disebutkan diperdagangkan di mana', async () => {
    const w = build({ initLogs: [], pasarLain: [{ dex: 'Pons V2', dexId: 'pons-v2', name: 'MEME / USDG', address: '0xb8ca', reserveUsd: 3948.9 }] });
    w.bot.jedaPindai = [5, 5];
    await w.bot.handle(msg(MEME));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /Uniswap v3\/v4/);
    assert.match(teks, /Pons V2 — MEME \/ USDG · likuiditas \$3,9rb/);
    assert.match(teks, /gaya v2/);
    const j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME });
    assert.strictEqual(j.lainnya[0].dex, 'Pons V2', 'dasbor web mendapat data yang sama');
  });

  await t('endpoint yang menolak rentang penuh dijawab dengan memotong', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3], tolakRentangPenuh: true });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    let j;
    for (let i = 0; i < 200 && (!j || j.status === 'jalan'); i++) {
      await new Promise((x) => setTimeout(x, 25));
      j = await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME, all: '1' });
    }
    assert.strictEqual(j.status, 'selesai', j.error);
    assert.strictEqual(j.total, 5, 'hasilnya harus sama walau lewat jalur potongan');
    assert.ok(w.kueri.length > 4, `harus ada banyak kueri potongan, cuma ada ${w.kueri.length}`);
  });

  await t('LP manual menolak pool berfee dinamis dan fee di atas batas', async () => {
    const w = build({ initLogs: LOGS, kosong: [] });
    await w.api('POST', '/api/manual/pools/scan', { token: MEME });
    for (let i = 0; i < 40; i++) {
      await new Promise((x) => setTimeout(x, 25));
      if ((await w.api('GET', '/api/manual/pools/scan', {}, { token: MEME })).status !== 'jalan') break;
    }
    w.cfg.rules = { filters: { allow_hooks: true } };       // hook diizinkan, fee tetap tidak
    const dinamis = await w.api('POST', '/api/manual/lp/plan', { poolRef: P5, usd: 50 });
    assert.match(dinamis.error || '', /fee dinamis/i, dinamis.error);

    // satuan fee Uniswap: 1000 = 0,1%, sedangkan pool P1 ber-fee 3000 = 0,3%
    w.cfg.rules = { filters: { max_fee_bps: 1000 } };
    const mahal = await w.api('POST', '/api/manual/lp/plan', { poolRef: P1, usd: 50 });
    assert.match(mahal.error || '', /di atas batas/i, mahal.error);
  });

  await t('alamat token ngawur ditolak sebelum menyentuh chain', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/pools/scan', { token: 'bukan-alamat' });
    assert.match(r.error || '', /alamat token/i);
    assert.strictEqual(w.kueri.length, 0, 'tidak boleh ada kueri chain untuk alamat ngawur');
  });

  await t('layar hasil pindai di bot bisa dipilih langsung', async () => {
    const w = build({ initLogs: LOGS, kosong: [P3] });
    await w.bot.handle(cbq('mla'));
    assert.match(lastOut(w.sent).params.text, /alamat token/i);
    await w.bot.handle(msg(MEME));
    // runScanPool menunggu 2 dtk per putaran; pekerjaannya sendiri selesai seketika
    await new Promise((x) => setTimeout(x, 2300));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /USDG\/MEME/, `hasil pindai tidak tampil:\n${teks}`);
    assert.match(teks, /disembunyikan/, 'jumlah yang disembunyikan harus disebut');
    const tombol = buttons(lastOut(w.sent)).filter((b) => b.startsWith('mlP:'));
    assert.ok(tombol.length >= 2, 'tiap pool hasil pindai harus punya tombol');
    await w.bot.handle(cbq(tombol[0]));
    assert.match(lastOut(w.sent).params.text, /LP manual/, 'memilih pool harus kembali ke menu LP');
    assert.ok(/USDG\/MEME|ETH\/MEME/.test(lastOut(w.sent).params.text), 'pool terpilih harus tercatat');
  });

  // ---- swap manual -----------------------------------------------------------
  await t('"semua" menyisakan cadangan gas untuk ETH native', async () => {
    const w = build();
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: {}, log: () => {} });
    const raw = await man.amountRaw(ADDR.native, 'semua');
    const cadangan = BigInt(w.cfg.gas.native_reserve_wei ?? 2_000_000_000_000_000);
    assert.strictEqual(raw, 10n ** 17n - cadangan, 'ETH native harus menyisakan cadangan gas');
    // token biasa tidak perlu cadangan
    const usdgRaw = await man.amountRaw(ADDR.usdg, 'semua');
    assert.strictEqual(usdgRaw, 150_000_000n);
  });

  await t('jumlah swap: persen, angka, dan yang melebihi saldo', async () => {
    const w = build();
    const { Manual } = require('../src/manual');
    const man = new Manual({ engine: w.engine, store: w.store, chain: w.chainStub, rpc: {}, log: () => {} });
    assert.strictEqual(await man.amountRaw(ADDR.usdg, '50%'), 75_000_000n);
    assert.strictEqual(await man.amountRaw(ADDR.usdg, '10'), 10_000_000n);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, '9999'), /saldo cuma/);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, 'abc'), /angka/);
    await assert.rejects(() => man.amountRaw(ADDR.usdg, '150%'), /antara 0 dan 100/);
  });

  await t('kutipan swap menampilkan biaya rute dan menolak yang terlalu rugi', async () => {
    const w = build();
    const q = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.ok(!q.error, q.error);
    assert.strictEqual(q.symbolIn, 'USDG');
    assert.strictEqual(q.symbolOut, 'MEME');
    assert.ok(q.lossBps > 0, 'biaya rute harus terhitung');
    assert.strictEqual(q.tooLossy, false);

    // rute yang merugi jauh melewati batas harus ditandai, bukan diam-diam dijalankan
    w.engine.kyber.quote = async (a, b, amt) => ({ amountOut: BigInt(amt), usdIn: 50, usdOut: 20, dex: 'jelek', routeSummary: {} });
    const buruk = await w.api('POST', '/api/manual/swap/quote', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.strictEqual(buruk.tooLossy, true, `rugi ${buruk.lossBps} bps harusnya ditandai`);
  });

  await t('swap ditolak di mode simulasi, dijalankan saat LIVE', async () => {
    const w = build();
    const r = await w.api('POST', '/api/manual/swap', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.match(r.error || '', /simulasi/i);

    const w2 = build({ dryRun: false });
    let dipakai = null;
    w2.engine.kyber.swap = async (ti, to, amt, opt) => { dipakai = { ti, to, amt, opt }; return { hash: '0xswap', amountOut: 5n * 10n ** 18n, quote: { dex: 'uji' } }; };
    const r2 = await w2.api('POST', '/api/manual/swap', { tokenIn: ADDR.usdg, tokenOut: MEME, amount: '10' });
    assert.ok(r2.ok, r2.error);
    assert.strictEqual(dipakai.amt, 10_000_000n, 'jumlah harus diubah ke satuan mentah token');
    assert.strictEqual(dipakai.opt.kind, 'swap_manual');
    assert.ok(dipakai.opt.maxLossBps > 0, 'batas rugi harus ikut dipasang');
    assert.match(r2.note, /USDG/);
  });

  await t('layar swap menuntun langkah demi langkah', async () => {
    const w = build();
    await w.bot.handle(cbq('sw'));
    assert.match(lastOut(w.sent).params.text, /belum dipilih/);
    await w.bot.handle(cbq('swf'));
    assert.ok(buttons(lastOut(w.sent)).some((b) => b.startsWith('swF:')), 'harus ada pilihan token');
    await w.bot.handle(cbq('swF:0'));
    await w.bot.handle(cbq('swt'));
    await w.bot.handle(cbq('swT:1'));
    await w.bot.handle(cbq('swn'));
    await w.bot.handle(msg('10'));
    const teks = lastOut(w.sent).params.text;
    assert.match(teks, /dikirim|diterima/, `kutipan tidak muncul:\n${teks}`);
  });

  await t('sisi "dari" hanya menawarkan token yang ada saldonya', async () => {
    const w = build();
    w.engine.exec.balances = async (list) => new Map(list.map((t2) => [String(t2).toLowerCase(),
      String(t2).toLowerCase() === ADDR.usdg ? 5_000_000n : 0n]));
    await w.bot.handle(cbq('swf'));
    const tombol = buttons(lastOut(w.sent)).filter((b) => b.startsWith('swF:'));
    assert.strictEqual(tombol.length, 1, 'hanya USDG yang punya saldo');
    assert.match(lastOut(w.sent).params.text, /USDG/);
  });

  // ---- kerapian tampilan ---------------------------------------------------
  await t('kolom benar-benar lurus, termasuk saat isinya perlu di-escape', async () => {
    const { kolom } = require('../src/telegram');
    const out = kolom([['a&b', '1'], ['panjang', '22,50']], 'lr');
    const baris = out.replace(/<\/?pre>/g, '').split('\n');
    // panjang diukur setelah entitas HTML dikembalikan ke satu karakter
    const nyata = (x) => x.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    assert.strictEqual(nyata(baris[0]).length, nyata(baris[1]).length, `kolom tidak lurus:\n${baris.join('\n')}`);
    assert.match(nyata(baris[0]), /^a&b +1$/, nyata(baris[0]));
    assert.match(nyata(baris[1]), /^panjang +22,50$/, nyata(baris[1]));
    assert.strictEqual(kolom([]), null, 'tabel kosong harus null supaya bisa disaring');
  });

  await t('tabel membungkus teks panjang tanpa menghilangkan data atau merusak HTML', async () => {
    const { kolom } = require('../src/telegram');
    const label = 'Label panjang untuk nilai yang perlu dibaca seluruhnya';
    const value = '0x' + 'abcdef'.repeat(12);
    const html = kolom([[label, value], ['<token&>', '1234567890.1234567890']], 'lr');
    const lines = html.replace(/<\/?pre>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').split('\n');
    assert.ok(lines.every((line) => Array.from(line).length <= 40));
    assert.ok(html.includes('&lt;token&amp;&gt;'));
    // Two 19-character columns separated by two spaces; reconstruct wrapped data.
    assert.strictEqual(lines.slice(0, 4).map((line) => line.slice(21).trim()).join(''), value);
  });

  await t('halaman data memakai tabel dan navigasinya tetap tersedia', async () => {
    const w = build();
    for (const route of ['t', 'a:0', 'x', 's', 'sr', 'sf:gas', 'sn', 'sc', 'f', 'wl', 'r:0']) {
      await w.bot.handle(cbq(route));
      const output = lastOut(w.sent).params;
      assert.match(output.text, /<pre>/, route);
      assert.ok(output.reply_markup.inline_keyboard.length, route);
    }
    w.bot.stop();
  });

  await t('harga dari tick identik untuk kedua susunan pool', async () => {
    const { tickPrice } = require('../src/telegram');
    // Sisi kuotasi menentukan arah: kalau kuotasi ada di token0, harga token
    // spekulatif adalah KEBALIKAN tick. Dua susunan yang menggambarkan pasangan
    // yang sama harus menghasilkan angka yang sama — ini pernah jadi sumber bug.
    for (const T of [600, -600, 12345, -322900]) {
      const a = tickPrice(T, 6, 18, 0);     // USDG/MEME, kuotasi di token0
      const b = tickPrice(-T, 18, 6, 1);    // MEME/USDG, kuotasi di token1
      assert.ok(Math.abs(a / b - 1) < 1e-12, `tick ${T}: ${a} ≠ ${b}`);
    }
  });

  await t('rentang harga: posisi asli user terbaca benar', async () => {
    const { rentang } = require('../src/telegram');
    // HOOKR/USDG milik user: tick −322900…−317900, harga kini −319936.
    const r = rentang({ tick_lower: -322900, tick_upper: -317900, curTick: -319936,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.ok(r, 'rentang harus terbaca');
    assert.match(r.judul, /HOOKR dalam USDG/);
    assert.match(r.ket, /di dalam/, `seharusnya in-range: ${r.ket}`);
    assert.match(r.bar, /●/, 'penanda harga kini harus ada di batang');
    // batang harus punya panjang tetap berapa pun harganya
    const polos = r.bar.replace(/<\/?pre>/g, '');
    assert.strictEqual((polos.match(/[─●]/g) || []).length, 15);
  });

  await t('rentang harga: harga di luar rentang dinyatakan arahnya', async () => {
    const { rentang } = require('../src/telegram');
    const atas = rentang({ tick_lower: -322900, tick_upper: -317900, curTick: -300000,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.match(atas.ket, /di luar rentang, [\d.,]+% di atas/, atas.ket);
    const bawah = rentang({ tick_lower: -322900, tick_upper: -317900, curTick: -350000,
      dec0: 18, dec1: 6, quoteSide: 1, symbol0: 'HOOKR', symbol1: 'USDG' });
    assert.match(bawah.ket, /di luar rentang, [\d.,]+% di bawah/, bawah.ket);
    // data yang tidak lengkap tidak boleh melempar galat
    assert.strictEqual(rentang({ tick_lower: null, tick_upper: 1, quoteSide: 1 }), null);
    assert.strictEqual(rentang({ tick_lower: -1, tick_upper: 1, quoteSide: null }), null);
  });

  await t('detail posisi menampilkan harga, bukan tick mentah', async () => {
    const w = build();
    Object.assign(w.engine.positions.live[0], {
      symbol0: 'HOOKR', symbol1: 'USDG', dec0: 18, dec1: 6, quoteSide: 1,
      tick_lower: -322900, tick_upper: -317900, curTick: -319936,
    });
    await w.bot.handle(cbq('p:1'));
    const teks = lastOut(w.sent).params.text;
    assert.ok(!/-322\.?900|rentang tick/i.test(teks), `tick mentah masih bocor ke layar:\n${teks}`);
    assert.match(teks, /Rentang harga/);
    assert.match(teks, /harga kini/);
  });

  await t('satuan waktu tidak ambigu', async () => {
    const { dur } = require('../src/telegram');
    assert.strictEqual(dur(45), '45 detik');
    assert.strictEqual(dur(3600 * 2), '2 jam');
    assert.strictEqual(dur(3600 * 2 + 720), '2 jam 12 menit');
    assert.strictEqual(dur(86400 + 36000), '1 hari 10 jam');
    assert.strictEqual(dur(86400 * 3), '3 hari');
  });

  await t('tidak ada layar yang memakai perataan spasi di teks biasa', async () => {
    // Font obrolan Telegram proporsional: spasi ganda di luar <pre> tidak pernah lurus.
    const w = build();
    const antre = ['h']; const sudah = new Set();
    while (antre.length) {
      const d = antre.shift();
      if (sudah.has(d)) continue;
      sudah.add(d);
      if (['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'].includes(d.split(':')[0])) continue;
      await w.bot.handle(cbq(d));
      const teks = lastOut(w.sent).params.text;
      const luarPre = teks.replace(/<pre>[\s\S]*?<\/pre>/g, '');
      for (const baris of luarPre.split('\n')) {
        assert.ok(!/\S {3,}\S/.test(baris), `layar ${d} mencoba meluruskan dengan spasi di luar <pre>:\n  "${baris}"`);
      }
      for (const b of buttons(lastOut(w.sent))) antre.push(b);
    }
  });

  await t('jumlah token kecil tidak pernah tampil sebagai nol', async () => {
    const w = build();
    await w.bot.handle(cbq('ml'));
    const { Manual } = require('../src/manual');
    void Manual;
    // 2,5e-11 token: bukan nol, jadi tidak boleh dibaca "tidak punya".
    const r = await w.api('POST', '/api/manual/lp/plan', { poolRef: '0xpool', usd: 50, widthPct: 25 });
    assert.ok(BigInt(r.plan.amount1) > 0n, 'prasyarat: amount1 harus bukan nol');
    w.sess = w.bot.sess(CHAT);
    w.sess.lp = { poolRef: '0xpool', usd: 50, widthPct: 25 };
    await w.bot.handle(cbq('mlv'));
    const teks = lastOut(w.sent).params.text;
    const baris = teks.split('\n').find((x) => x.includes('MEME'));
    assert.ok(baris && !/MEME\s+0$/.test(baris), `jumlah bukan-nol tampil sebagai nol: "${baris}"`);
  });

  await t('tidak ada dua layar yang memakai kode tombol sama', async () => {
    // Dua `case` bernilai sama dalam satu switch diterima diam-diam oleh JS: yang
    // kedua tidak akan pernah jalan. Itu persis yang terjadi saat menu Swap dan
    // layar Wallet sama-sama memakai 'sw' — penjelajah tidak bisa melihatnya
    // karena keduanya menghasilkan layar yang sah.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'telegram.js'), 'utf8');
    const blok = {
      tombol: src.slice(src.indexOf('async screen('), src.indexOf('// ---- jawaban atas pertanyaan')),
      perintah: src.slice(src.indexOf('switch (cmd) {'), src.indexOf('async onCallback')),
    };
    for (const [nama, teks] of Object.entries(blok)) {
      assert.ok(teks.length > 100, `blok ${nama} tidak ketemu`);
      const label = [...teks.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
      const dobel = [...new Set(label.filter((x, i) => label.indexOf(x) !== i))];
      assert.deepStrictEqual(dobel, [], `kode ${nama} dipakai dua kali: ${dobel.join(', ')} — yang kedua tidak akan pernah jalan`);
    }
  });

  await t('data tombol muat di batas 64 byte Telegram', async () => {
    const w = build();
    const antre = ['h']; const sudah = new Set();
    while (antre.length) {
      const d = antre.shift();
      if (sudah.has(d)) continue;
      sudah.add(d);
      assert.ok(Buffer.byteLength(d) <= 64, `callback_data terlalu panjang (${Buffer.byteLength(d)}): ${d}`);
      if (['pC', 'pF', 'acT', 'tD', 'wbG', 'sK', 'srd', 'scd', 'fr', 'fd', 'tr', 'mlX', 'swX'].includes(d.split(':')[0])) continue;
      await w.bot.handle(cbq(d));
      for (const b of buttons(lastOut(w.sent))) antre.push(b);
    }
  });

  await t('setiap pesan muat di batas 4096 karakter Telegram', async () => {
    const w = build();
    for (const d of ['h', 'o', 'p', 'p:1', 't', `t:${TARGET}`, 'a:0', 'r', 'r:5', 's', 'l', 'x', 'f', 'sr', 'sn', 'sc']) {
      await w.bot.handle(cbq(d));
      assert.ok(lastOut(w.sent).params.text.length <= 4096, `layar ${d} kepanjangan`);
    }
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
