'use strict';
// Uji edge case mesin copy-LP.
//
// Semua uji di sini memakai KODE ASLI (policy/engine/watcher). Yang dipalsukan hanya
// batas luar: chain dan pengiriman transaksi. Tujuannya menjawab satu pertanyaan —
// "kalau target melakukan X, apakah bot mengambil keputusan yang benar?" — untuk
// bentuk-bentuk aksi yang jarang terjadi tetapi mahal kalau salah.
//
// Jalankan: node test/edge.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, ETH = ADDR.native;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';

// Harga pool dipatok di tengah rentang uji supaya posisi butuh kedua token.
const TICK = 0;
const SQRT = m.getSqrtRatioAtTick(TICK);

function harness({ balances = {}, rules = {}, positions = [], targetLiquidityAfter = null } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const tokens = {
    [USDG]: { address: USDG, symbol: 'USDG', decimals: 6 },
    [ETH]: { address: ETH, symbol: 'ETH', decimals: 18 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const chain = {
    tokens: async (list) => list.map((a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    token: async (a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 },
    slot0V4: async () => ({ sqrtPriceX96: SQRT, tick: TICK }),
    slot0V3: async () => ({ sqrtPriceX96: SQRT, tick: TICK }),
    poolLiquidity: async () => 10n ** 24n,
    poolAgeMinutes: async () => 10_000,
    ethUsd: async () => 2500,
    quoteSideOf(t0, t1) {
      const q = { [USDG]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ETH]: { symbol: 'ETH', decimals: 18, kind: 'eth' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = m.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
    blockTs: async (b) => b * 101,
  };
  const cfg = { mode: { dry_run: false, paused: false }, rules, gas: {}, loop: {} };
  // getPositionLiquidity dipakai handleExit untuk menghitung L target SEBELUM aksi.
  const rpc = {
    ethCallMany: async (c) => c.map(() => (targetLiquidityAfter == null ? '0x' : '0x' + targetLiquidityAfter.toString(16).padStart(64, '0'))),
    batch: async (c) => c.map(() => ({ result: null })), blockNumber: async () => 1e6, call: async () => null,
  };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  eng.ethUsd = 2500;
  const sent = [];
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((t) => [String(t).toLowerCase(), BigInt(balances[String(t).toLowerCase()] ?? 0)]));
  eng.exec.send = async (tx, meta) => { sent.push({ kind: meta?.kind, tx }); return '0x' + (sent.length + '').padStart(64, '0'); };
  eng.exec.waitReceipt = async () => ({ ok: true, receipt: { logs: [], gasUsed: '0x0', effectiveGasPrice: '0x0' } });
  eng.exec.ensureAllowance = async () => [];
  eng.exec.ensureRouterAllowance = async () => [];
  eng.exec.deadline = () => 9e9;
  eng.kyber.swap = async () => ({ hash: '0xswap', amountOut: 10n ** 24n, quote: { dex: 'uji', usdIn: 1, usdOut: 1 } });
  eng.notify = () => {};
  for (const p of positions) store.run(
    `INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
      target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,last_sync)
     VALUES('v4',?,?,?,?,?,?,?,?,?,?,?,?,'open',?,'0','0',?,?,?)`,
    p.tokenId, POOL, p.token0 || USDG, p.token1 || MEME, 3000, 60, ADDR.native,
    p.tickLower ?? -600, p.tickUpper ?? 600, p.liquidity, TARGET, p.mirrorOf, Date.now(), p.cost ?? 100, 'USDG', Date.now());
  return { eng, store, sent };
}

// Aksi target berbentuk seperti yang dihasilkan watcher.
function action(over = {}) {
  const liq = 10n ** 20n;
  return {
    id: null, ts: Date.now(), block: 1000, txHash: '0xtx', logIndex: 1,
    target: TARGET, venue: 'v4', kind: 'increase', tokenId: '999',
    poolRef: POOL, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
    token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    tickLower: -600, tickUpper: 600, liquidity: liq.toString(),
    amount0: '0', amount1: '0', valueQuote: 400, quoteSymbol: 'USDG',
    slot0: { sqrtPriceX96: SQRT, tick: TICK },
    ...over,
  };
}
const rec = (store, act) => {
  const r = store.run(
    `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
      tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    act.ts, act.block, act.txHash + Math.random(), act.logIndex, act.target, act.venue, act.kind, act.tokenId,
    act.poolRef, act.token0, act.token1, act.fee, act.tickSpacing, act.hooks, act.tickLower, act.tickUpper,
    act.liquidity, act.amount0, act.amount1, act.valueQuote, act.quoteSymbol);
  act.id = Number(r.lastInsertRowid);
  return act;
};
const verdictOf = (store) => store.get('SELECT verdict, reason FROM decisions ORDER BY id DESC LIMIT 1');

const RICH = { [USDG]: 10n ** 12n, [MEME]: 10n ** 30n, [ETH]: 10n ** 19n };
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  OK   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + e.message.split('\n')[0]); fail++; }
}

(async () => {
  console.log('uji edge case mesin copy-LP\n');

  await t('target menambah ke posisi yang sudah kita cermin -> menambah, bukan buka posisi baru', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 19n).toString() }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.match(v.reason, /menambah posisi/, v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'increase').length, 1, 'harus mengirim increase');
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1, 'tidak boleh ada posisi kedua');
  });

  await t('target menarik SEBAGIAN -> kita menarik proporsional, posisi tetap terbuka', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,   // target menarik 40%, menyisakan 60%
    });
    const a = action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() });
    await eng.handle(rec(store, a));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'decrease').length, 1, 'harus decrease, bukan burn');
    const p = store.get('SELECT status, liquidity FROM positions');
    assert.strictEqual(p.status, 'open', 'posisi harus tetap terbuka');
    assert.strictEqual(p.liquidity, (6n * 10n ** 19n).toString(), 'sisa L salah: ' + p.liquidity);
  });

  // ---- retry keluar ------------------------------------------------------
  // Sinyal keluar hanya diputuskan sekali; kalau siarannya gagal, posisi kita
  // tertinggal terbuka. Diulang — tapi hanya selama tx keluarnya belum terkirim.
  const exitHarness = (sendFn) => {
    const h = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
      targetLiquidityAfter: 6n * 10n ** 19n,
    });
    h.eng.exitRetryWaits = [1, 1, 1];
    h.eng.chainLiquidity = async () => 10n ** 20n;   // posisi kita di chain belum berubah
    h.eng.exec.txLanded = async () => false;
    let n = 0;
    h.eng.exec.send = async (tx, meta) => sendFn(++n, meta, h);
    h.tries = () => n;
    return h;
  };
  const decreaseAct = () => action({ kind: 'decrease', liquidity: (-4n * 10n ** 19n).toString() });

  await t('siaran keluar ditolak RPC sekali -> diulang dan berhasil', async () => {
    const h = exitHarness((n, meta) => {
      if (n === 1) throw Object.assign(new Error('eth_sendRawTransaction: Method not found'), { txHash: '0xaa' });
      h.sent.push({ kind: meta?.kind });
      return '0x' + 'bb'.repeat(32);
    });
    await h.eng.handle(rec(h.store, decreaseAct()));
    const v = verdictOf(h.store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(h.tries(), 2);
    assert.strictEqual(h.store.get('SELECT liquidity FROM positions').liquidity, (6n * 10n ** 19n).toString());
  });

  await t('siaran keluar gagal terus -> menyerah setelah 4 percobaan, dicatat galat', async () => {
    const h = exitHarness(() => { throw new Error('eth_sendRawTransaction: Method not found'); });
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.strictEqual(verdictOf(h.store).verdict, 'error');
    assert.strictEqual(h.tries(), 4);
  });

  await t('tx keluar yang dianggap gagal ternyata masuk -> TIDAK dikirim ulang', async () => {
    const h = exitHarness(() => { throw Object.assign(new Error('timeout'), { txHash: '0xaa' }); });
    h.eng.exec.txLanded = async () => true;
    await h.eng.handle(rec(h.store, decreaseAct()));
    const v = verdictOf(h.store);
    assert.strictEqual(v.verdict, 'error');
    assert.match(v.reason, /ternyata masuk/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('likuiditas kita di chain sudah berkurang -> TIDAK dikirim ulang', async () => {
    const h = exitHarness(() => { throw new Error('timeout'); });
    h.eng.chainLiquidity = async () => 6n * 10n ** 19n;
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.match(verdictOf(h.store).reason, /sudah berubah/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('tx keluar terkirim tapi revert -> TIDAK diulang', async () => {
    const h = exitHarness(() => '0x' + 'cc'.repeat(32));
    h.eng.exec.waitReceipt = async () => ({ ok: false, receipt: {} });
    await h.eng.handle(rec(h.store, decreaseAct()));
    assert.match(verdictOf(h.store).reason, /revert/);
    assert.strictEqual(h.tries(), 1);
  });

  await t('RpcPool.sendRaw: satu endpoint "Method not found" -> endpoint lain menyiarkan', async () => {
    const { RpcPool } = require('../src/rpc');
    const pool = new RpcPool([{ url: 'https://baca.example' }, { url: 'https://kirim.example' }], () => {});
    pool.resolve = async () => [];
    pool.post = async (url) => (url.includes('baca')
      ? { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }
      : { jsonrpc: '2.0', id: 1, result: '0xhash' });
    assert.strictEqual(await pool.sendRaw('0x02'), '0xhash');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(pool.eps[0].noSend, true, 'endpoint baca-saja harus ditandai');
    pool.post = async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'insufficient funds' } });
    await assert.rejects(() => pool.sendRaw('0x02'), /insufficient funds/);
  });

  await t('target memindahkan NFT ke dompet lain -> kita tutup penuh', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
    });
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'burn').length, 1, 'harus burn');
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('penitipan ke kontrak otomasi -> TIDAK dianggap keluar', async () => {
    const { eng, store, sent } = harness({ balances: RICH, positions: [{ tokenId: '5', mirrorOf: '999', liquidity: '1' }] });
    await eng.handle(rec(store, action({ kind: 'custody_out' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0, 'tidak boleh mengirim apa pun');
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'open');
  });

  await t('pool dengan hook ditolak selama allow_hooks mati', async () => {
    const { eng, store } = harness({ balances: RICH });
    const hook = '0x1111111111111111111111111111111111111111';
    await eng.handle(rec(store, action({ hooks: hook, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: hook } })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /hook/i, v.reason);
  });

  await t('batas jumlah posisi terbuka dihormati', async () => {
    const { eng, store } = harness({
      balances: RICH, rules: { filters: { max_open_positions: 1 } },
      positions: [{ tokenId: '7', mirrorOf: 'lain', liquidity: '1' }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /posisi terbuka/i, v.reason);
  });

  await t('jeda antar-salinan di pool yang sama dihormati', async () => {
    const { eng, store } = harness({ balances: RICH, rules: { filters: { cooldown_seconds: 60 } } });
    eng.lastCopyAt.set(POOL, Date.now());
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /cooldown/i, v.reason);
  });

  await t('batas eksposur total habis -> dilewati, bukan dipaksakan', async () => {
    const { eng, store } = harness({
      balances: RICH,
      rules: { sizing: { mode: 'mirror', max_total_exposure_usd: 50, max_quote_per_position_usd: 200 } },
      positions: [{ tokenId: '7', mirrorOf: 'lain', liquidity: (10n ** 20n).toString(), cost: 50 }],
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /eksposur|minimum/i, v.reason);
  });

  await t('aksi keluar tanpa cermin -> dilewati diam-diam, tidak menutup posisi lain', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '9', mirrorOf: 'posisi-lain', liquidity: (10n ** 20n).toString(), tickLower: -1200, tickUpper: 1200 }],
    });
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: '-1' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'open');
  });

  await t('pasangan dua aset kuotasi (ETH/USDG) -> tidak ada memecoin untuk dijual', async () => {
    const { eng } = harness({ balances: RICH });
    const r = await eng.sellLeftover(
      { id: 1, target: TARGET, token0: ETH, token1: USDG, pool_ref: POOL },
      { logs: [{ address: USDG, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x'.padEnd(66, '0'), '0x' + ME.slice(2).padStart(64, '0')], data: '0x' + (10n ** 6n).toString(16).padStart(64, '0') }] },
    );
    assert.strictEqual(r, null, 'tidak boleh menjual aset kuotasi');
  });

  await t('sisa memecoin yang gagal dijual masuk antrean coba-ulang', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    eng.kyber.swap = async () => { throw new Error('rute tidak ada'); };
    await assert.rejects(() => eng.sellToken({ posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0 }));
    const q = JSON.parse(store.getState('leftovers', '[]'));
    assert.strictEqual(q.length, 1, 'harus tersimpan untuk dicoba lagi');
    assert.strictEqual(q[0].tries, 1);
    assert.ok(q[0].next > Date.now(), 'harus dijadwalkan ulang');
  });

  await t('antrean jual tidak pernah menyerah: item tetap ada, dijadwalkan ulang tiap beberapa detik', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    eng.kyber.swap = async () => { throw new Error('rute tidak ada'); };
    for (let i = 0; i < 20; i++) {
      const q = JSON.parse(store.getState('leftovers', '[]'));
      const item = q[0] || { posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0 };
      await eng.sellToken(item).catch(() => {});
    }
    const q = JSON.parse(store.getState('leftovers', '[]'));
    assert.strictEqual(q.length, 1, 'item harus tetap tersimpan — uangnya masih tersangkut');
    assert.strictEqual(q[0].tries, 20);
    assert.ok(q[0].since > 0, 'waktu mulai tersangkut dicatat');
    assert.ok(q[0].next - Date.now() <= 5000 + 50 && q[0].next > Date.now(), 'dijadwalkan tiap 5 detik (bawaan), bukan menit');
  });

  await t('pemburu sisa: tiap tick cuma MENGUTIP; swap sungguhan hanya saat rugi sudah di bawah batas', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    let usdOut = 40, quotes = 0, swaps = 0;
    eng.kyber.quote = async () => { quotes++; return { usdIn: 100, usdOut, amountOut: 1n, dex: 'uji', routeSummary: {} }; };
    eng.kyber.swap = async () => { swaps++; return { hash: '0xjual', amountOut: 1n, quote: { usdIn: 100, usdOut, dex: 'uji' } }; };
    eng.saveLeftovers([{ posId: 1, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0, next: 0 }]);
    await eng.retryLeftovers();
    assert.strictEqual(quotes, 1, 'satu kutipan');
    assert.strictEqual(swaps, 0, 'rugi 60% > 15%: jangan swap');
    let q = JSON.parse(store.getState('leftovers', '[]'));
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].lastLossBps, 6000, 'kutipan terakhir disimpan untuk dasbor');
    assert.match(q[0].why, /rugi 60\.0%/);
    // Jadwal belum tiba -> tick berikutnya tidak mengutip lagi.
    await eng.retryLeftovers();
    assert.strictEqual(quotes, 1, 'belum jadwalnya: tidak ada kutipan baru');
    // Likuiditas membaik: rugi 10% -> langsung dijual dan antrean kosong.
    usdOut = 90;
    eng.saveLeftovers(q.map((x) => ({ ...x, next: 0 })));
    await eng.retryLeftovers();
    assert.strictEqual(swaps, 1, 'rugi sudah di bawah batas: swap dikirim');
    assert.strictEqual(JSON.parse(store.getState('leftovers', '[]')).length, 0, 'terjual: keluar dari antrean');
  });

  await t('sisa yang ditolak dijual dikabarkan KERAS sekali di awal, lalu diingatkan tiap 6 jam — bukan tiap tick', async () => {
    const { eng, store } = harness({ balances: { ...RICH } });
    const kabar = [];
    eng.notify = (msg, d) => kabar.push(d);
    eng.kyber.quote = async () => ({ usdIn: 229.44, usdOut: 90.01, amountOut: 1n, dex: 'uji', routeSummary: {} });
    eng.saveLeftovers([{ posId: 9, target: TARGET, token: MEME, quote: USDG, amount: (10n ** 20n).toString(), tries: 0, next: 0 }]);
    for (let i = 0; i < 30; i++) {
      eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0 })));
      await eng.retryLeftovers();
    }
    let macet = kabar.filter((d) => d?.kind === 'leftover_stuck');
    assert.strictEqual(macet.length, 1, 'hanya satu kabar untuk 30 kegagalan beruntun');
    assert.strictEqual(macet[0].tries, 1);
    assert.ok(Math.abs(macet[0].lossBps - 6077) < 1, String(macet[0].lossBps));
    assert.strictEqual(macet[0].maxLossBps, 1500);
    assert.strictEqual(macet[0].retrySec, 5);
    assert.ok(/60\.8%/.test(macet[0].why), macet[0].why);
    // Enam jam kemudian masih tersangkut -> pengingat.
    eng.saveLeftovers(eng.leftovers().map((x) => ({ ...x, next: 0, alertedAt: Date.now() - 7 * 3600_000 })));
    await eng.retryLeftovers();
    macet = kabar.filter((d) => d?.kind === 'leftover_stuck');
    assert.strictEqual(macet.length, 2, 'pengingat setelah 6 jam');
    assert.strictEqual(macet[1].reminder, true);
  });

  await t('posisi satu sisi (rentang di atas harga) tetap disalin sebagai limit order', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    // rentang seluruhnya DI ATAS harga kini -> hanya butuh satu token
    await eng.handle(rec(store, action({ tickLower: 6000, tickUpper: 12000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.strictEqual(sent.filter((x) => x.kind === 'mint').length, 1);
  });

  await t('posisi satu sisi dilewati kalau aturannya begitu', async () => {
    const { eng, store, sent } = harness({ balances: RICH, rules: { onesided: { policy: 'skip' } } });
    await eng.handle(rec(store, action({ tickLower: 6000, tickUpper: 12000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /satu sisi/i, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('target sedang dimatikan -> tidak menyalin apa pun', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    store.run('UPDATE targets SET enabled=0 WHERE address=?', TARGET);
    await eng.handle(rec(store, action()));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
  });

  await t('bot dijeda -> tidak menyalin apa pun', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    store.setState('paused', '1');
    await eng.handle(rec(store, action()));
    assert.match(verdictOf(store).reason, /dijeda/i);
    assert.strictEqual(sent.length, 0);
  });

  // Kyber tanpa rute -> cadangan swap langsung ke pool. Yang dipakai BUKAN pool posisi
  // apa adanya, melainkan pool terbaik untuk pasangan itu (lihat test/zap-pool.js untuk
  // pemilihnya). Hanya di jalur buka posisi: jual sisa & tutup posisi tetap Kyber saja.
  await t('zap tanpa rute Kyber -> swap lewat pool berfee paling murah, bukan pool posisi', async () => {
    const { eng, store, sent } = harness({ balances: { ...RICH, [MEME]: 0n } });
    eng.kyber.swap = async () => null;
    // Pool lain untuk pasangan yang sama, jauh lebih murah dari pool posisi (0,3%).
    store.run(`INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block)
      VALUES(?,'v4',?,?,500,10,?,1)`, '0x' + 'be'.repeat(32), USDG, MEME, '0x' + '0'.repeat(40));
    eng.chain.slot0V4Many = async (ids) => ids.map(() => ({ sqrtPriceX96: SQRT, tick: TICK, lpFee: 0 }));
    eng.chain.poolLiquidityMany = async (ids) => ids.map(() => 10n ** 24n);
    // Tiap kandidat yang disimulasikan dibangunkan transaksinya; yang menentukan
    // adalah transaksi mana yang akhirnya DIKIRIM.
    const dibangun = new Map();
    const asli = eng.exec.buildSwapV4.bind(eng.exec);
    eng.exec.buildSwapV4 = (key, ...rest) => {
      const tx = asli(key, ...rest);
      dibangun.set(key.fee, { key, tx });
      return tx;
    };
    // MEME baru ada di wallet SESUDAH zap terkirim — tanpa ini putaran zap mengira
    // harga bergerak dan membatalkan pembukaan.
    let meme = 0n;
    const kirim = eng.exec.send;
    eng.exec.send = async (tx, meta) => {
      if (meta?.kind === 'zap_swap') meme = 10n ** 30n;
      return kirim(tx, meta);
    };
    eng.exec.balances = async (list) => new Map(list.map((a) => {
      const k = String(a).toLowerCase();
      return [k, k === MEME ? meme : BigInt(RICH[k] ?? 0)];
    }));
    await eng.handle(rec(store, action()));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    const zap = sent.find((s) => s.kind === 'zap_swap');
    assert.ok(zap, 'zap harus terkirim lewat pool langsung');
    assert.ok(dibangun.has(500) && dibangun.has(3000), 'kedua pool harus ikut dinilai');
    assert.strictEqual(zap.tx.data, dibangun.get(500).tx.data, 'pool 0,05% harus menang dari pool posisi 0,3%');
    assert.strictEqual(dibangun.get(500).key.tickSpacing, 10, 'poolKey diambil dari pool terpilih, bukan pool posisi');
  });

  await t('jembatan gagal di tengah eksekusi -> galat jelas, tidak ada posisi tercatat', async () => {
    const { eng, store } = harness({ balances: { ...RICH, [MEME]: 0n } });
    eng.kyber.swap = async () => null;               // tidak ada rute penambal
    eng.ensureQuoteAsset = async () => { throw new Error('kas kurang untuk jembatan: butuh 0.07 ETH untuk 170.00 USDG, punya 0.01 ETH'); };
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'error', v.reason);
    assert.strictEqual(store.all("SELECT id FROM positions").length, 0, 'tidak boleh mencatat posisi yang gagal dibuka');
  });

  // Wallet persis seperti di server saat Bang GE masuk $1.000 (batas $200): kas
  // sebagian besar berupa WETH, ETH native di bawah cadangan gas. Dulu: "saldo ETH
  // kosong — tidak ada kas untuk dijembatani" padahal ada ~$173 WETH.
  const e18 = (x) => BigInt(Math.round(x * 1e18));
  const WALLET_SERVER = { [USDG]: 36_107_783n, [ADDR.weth]: e18(0.069436618), [ETH]: e18(0.000861055) };
  // Saldo yang ikut berubah oleh unwrap dan swap Kyber — tanpa ini langkah sesudah
  // jembatan (zap, mint) membaca saldo lama dan hasilnya tidak bermakna.
  // `kurs` = harga ETH di Kyber (USDG per ETH); bot sendiri menilai ETH di 2500.
  function dompetHidup(eng, sent, awal, kurs = 2500n) {
    const bal = new Map(Object.entries(awal).map(([k, v]) => [k.toLowerCase(), BigInt(v)]));
    const get = (a) => bal.get(String(a).toLowerCase()) || 0n;
    const add = (a, x) => bal.set(String(a).toLowerCase(), get(a) + x);
    // USDG<->MEME 1:1 dalam unit mentah (harga pool di tick 0).
    const conv = (a, b, x) => {
      a = String(a).toLowerCase(); b = String(b).toLowerCase();
      if (a === ETH && b === USDG) return (x * kurs) / 10n ** 12n;
      if (a === USDG && b === ETH) return (x * 10n ** 12n) / kurs;
      return x;
    };
    eng.exec.balances = async (list) => new Map(list.map((a) => [String(a).toLowerCase(), get(a)]));
    eng.exec.send = async (tx, meta) => {
      if (meta?.kind === 'unwrap_weth') { const amt = BigInt('0x' + tx.data.slice(10)); add(ADDR.weth, -amt); add(ETH, amt); }
      sent.push({ kind: meta?.kind, tx });
      return '0x' + (sent.length + '').padStart(64, '0');
    };
    eng.kyber.quote = async (a, b, x) => ({ amountOut: conv(a, b, x) });
    eng.kyber.swap = async (a, b, x, o) => {
      if (get(a) < x) throw new Error(`swap melebihi saldo ${a}`);
      const out = conv(a, b, x);
      add(a, -x); add(b, out);
      sent.push({ kind: o?.kind || 'swap', from: a, to: b, amountIn: x });
      return { hash: '0xswap', amountOut: out, quote: { dex: 'uji', usdIn: 1, usdOut: 1 } };
    };
    return { get };
  }

  await t('kas berupa WETH + ETH native di bawah cadangan -> WETH dipakai, posisi terbuka', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 200, max_total_exposure_usd: 400 } } });
    const w = dompetHidup(eng, sent, WALLET_SERVER);
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    assert.match(v.reason, /kas tersedia/, 'kas ~$206 tidak cukup untuk $200 + cadangan — ukurannya harus dipotong ke kas');
    const kinds = sent.map((x) => x.kind);
    assert.ok(kinds.includes('unwrap_weth'), kinds.join(','));
    assert.ok(sent.some((x) => x.kind === 'bridge_swap' && x.from === ETH), 'jembatan ETH -> USDG harus jalan');
    assert.ok(w.get(ETH) >= 1_900_000_000_000_000n, `cadangan gas harus terisi lagi, tersisa ${w.get(ETH)}`);
    const plan = JSON.parse(store.get('SELECT plan FROM decisions ORDER BY id DESC LIMIT 1').plan);
    assert.ok(plan.valueUsd > 150 && plan.valueUsd < 200, `ukuran ${plan.valueUsd}`);
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1);
  });

  await t('kurs Kyber 0,8% lebih buruk dari harga ETH bot -> ukuran pas-pasan tetap terbayar', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 200, max_total_exposure_usd: 400 } } });
    dompetHidup(eng, sent, WALLET_SERVER, 2480n);
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
  });

  await t('kas di aset kuotasi pool sendiri tidak dipotong ruang jembatan', async () => {
    const { eng, store, sent } = harness({ rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 500, max_total_exposure_usd: 1000 } } });
    dompetHidup(eng, sent, { [USDG]: 210_000_000n, [ETH]: e18(0.002) });
    await eng.handle(rec(store, action({ valueQuote: 1000 })));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'copy', v.reason);
    const plan = JSON.parse(store.get('SELECT plan FROM decisions ORDER BY id DESC LIMIT 1').plan);
    assert.ok(Math.abs(plan.valueUsd - 200) < 0.5, `210 USDG / 1,05 = $200, dapat ${plan.valueUsd}`);
    assert.ok(!sent.some((x) => x.kind === 'bridge_swap'), 'tidak perlu jembatan');
  });

  await t('kas sedikit -> alasan "di bawah minimum" menyebut kas sebagai penyebabnya', async () => {
    const { eng, store, sent } = harness({ balances: { [USDG]: 3_000_000n } });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /minimum.*kas tersedia/, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('debu WETH tidak memicu unwrap isi gas', async () => {
    const { eng, sent } = harness({});
    dompetHidup(eng, sent, { [ADDR.weth]: 10_000_000_000n, [ETH]: e18(0.0005) });
    const notes = [];
    await eng.topUpGas(notes);
    assert.strictEqual(sent.length, 0, sent.map((x) => x.kind).join(','));
  });

  await t('keluar dengan ETH native di bawah cadangan -> gas diisi dari WETH dulu, lalu burn', async () => {
    const { eng, store, sent } = harness({ positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }] });
    dompetHidup(eng, sent, { ...RICH, [ETH]: e18(0.0005), [ADDR.weth]: e18(0.05) });
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.deepStrictEqual(sent.map((x) => x.kind).slice(0, 2), ['unwrap_weth', 'burn']);
  });

  await t('isi gas gagal (RPC mati) -> keluar TETAP jalan', async () => {
    const { eng, store, sent } = harness({ balances: RICH, positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }] });
    const bal0 = eng.exec.balances;
    let first = true;
    eng.exec.balances = async (list) => {
      if (first && list.includes(ADDR.weth)) { first = false; throw new Error('RPC 429'); }
      return bal0(list);
    };
    await eng.handle(rec(store, action({ kind: 'transfer_out', poolRef: null, token0: null, token1: null })));
    assert.strictEqual(verdictOf(store).verdict, 'copy', verdictOf(store).reason);
    assert.strictEqual(sent.filter((s) => s.kind === 'burn').length, 1);
    assert.strictEqual(store.get('SELECT status FROM positions').status, 'closed');
  });

  await t('kas kosong -> dilewati dengan alasan jelas, tanpa transaksi', async () => {
    const { eng, store, sent } = harness({ balances: { [ETH]: e18(0.0015) } });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /kas tersedia/, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('mode simulasi tidak dibatasi kas (wallet uji boleh kosong)', async () => {
    const { eng, store } = harness({ balances: {} });
    eng.cfg.mode.dry_run = true;
    eng.exec.simulate = async () => ({ ok: true, gas: 1 });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'dry', v.reason);
    assert.doesNotMatch(v.reason, /kas tersedia/, v.reason);
  });

  await t('jembatan kurang kas -> pesan dalam satuan manusia, bukan wei', async () => {
    const { eng, sent } = harness({});
    dompetHidup(eng, sent, { [ADDR.weth]: e18(0.01), [ETH]: e18(0.001) });
    const plan = { quoteSide: 0, token0: USDG, token1: MEME };
    const rules = { swap: { enabled: true, max_slippage_bps: 100, max_price_impact_bps: 500 } };
    await assert.rejects(() => eng.ensureQuoteAsset(plan, rules, 200_000_000n), (e) => {
      assert.match(e.message, /butuh 0\.0808 ETH untuk 200\.00 USDG, punya 0\.01 ETH/, e.message);
      assert.match(e.message, /ETH\+WETH di atas cadangan gas 0\.002 ETH/, e.message);
      assert.doesNotMatch(e.message, /\d{10,}/, 'tidak boleh ada angka mentah');
      return true;
    });
    assert.strictEqual(sent.length, 0, 'tidak ada yang dikirim kalau kasnya memang kurang');
  });

  await t('hasil setelah dipotong batas di bawah minimum -> dilewati', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      rules: { sizing: { mode: 'mirror', max_quote_per_position_usd: 3, min_quote_usd: 10 } },
    });
    await eng.handle(rec(store, action()));
    const v = verdictOf(store);
    assert.strictEqual(v.verdict, 'skip', v.reason);
    assert.match(v.reason, /minimum/i, v.reason);
    assert.strictEqual(sent.length, 0);
  });

  await t('aksi yang sama diproses dua kali -> tidak membuka posisi ganda', async () => {
    const { eng, store, sent } = harness({ balances: RICH });
    const a = rec(store, action());
    await eng.handle(a);
    await eng.handle(a);   // ulangi aksi yang sama persis
    assert.strictEqual(store.all("SELECT id FROM positions WHERE status='open'").length, 1, 'harus tetap satu posisi');
    assert.strictEqual(sent.filter((x) => x.kind === 'mint').length, 1, 'mint hanya sekali');
    assert.strictEqual(sent.filter((x) => x.kind === 'increase').length, 0, 'tidak boleh menambah modal untuk aksi yang sama');
    assert.strictEqual(store.all('SELECT id FROM decisions').length, 1, 'hanya satu keputusan per aksi');
  });

  await t('menutup posisi yang sudah tertutup -> dilewati, tidak mengirim tx', async () => {
    const { eng, store, sent } = harness({
      balances: RICH,
      positions: [{ tokenId: '5', mirrorOf: '999', liquidity: (10n ** 20n).toString() }],
    });
    store.run("UPDATE positions SET status='closed'");
    await eng.handle(rec(store, action({ kind: 'decrease', liquidity: '-1' })));
    assert.strictEqual(verdictOf(store).verdict, 'skip');
    assert.strictEqual(sent.length, 0);
  });

  await t('receipt keluar tanpa log token -> tidak ada yang dijual, bukan galat', async () => {
    const { eng } = harness({ balances: RICH });
    const r = await eng.sellLeftover({ id: 1, target: TARGET, token0: USDG, token1: MEME, pool_ref: POOL }, { logs: [] });
    assert.strictEqual(r, null);
  });

  await t('mint berhasil di chain tapi jawaban RPC hilang -> tidak dianggap gagal', async () => {
    const { eng } = harness({ balances: RICH });
    const { ethers } = require('ethers');
    // pakai send() yang ASLI (harness menggantinya dengan pengirim palsu)
    eng.exec.send = Object.getPrototypeOf(eng.exec).send.bind(eng.exec);
    // wallet uji: cukup untuk menandatangani, kuncinya tidak pernah dipakai di mana pun
    const w = ethers.Wallet.createRandom();
    eng.exec.loadWallet = () => w;
    eng.exec.gasFees = async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    eng.exec.estimateGas = async () => 21000n;
    let asked = 0;
    eng.exec.rpc = {
      call: async (method) => {
        if (method === 'eth_getTransactionCount') return '0x1';
        if (method === 'eth_sendRawTransaction') throw new Error('nonce too low: address x, tx: 1 state: 2');
        if (method === 'eth_getTransactionByHash') { asked++; return { hash: '0xada' }; }   // ternyata sudah masuk
        return null;
      },
    };
    const h = await eng.exec.send({ to: ME, data: '0x', value: '0' }, { kind: 'uji' });
    assert.ok(h && h.startsWith('0x'), 'harus mengembalikan hash, bukan melempar');
    assert.ok(asked > 0, 'harus memeriksa chain sebelum menyerah');
  });

  await t('mint yang benar-benar gagal tetap dilaporkan gagal', async () => {
    const { eng } = harness({ balances: RICH });
    const { ethers } = require('ethers');
    eng.exec.send = Object.getPrototypeOf(eng.exec).send.bind(eng.exec);
    eng.exec.txLanded = async () => false;   // percepat: tidak menunggu 6 kali
    const w = ethers.Wallet.createRandom();
    eng.exec.loadWallet = () => w;
    eng.exec.gasFees = async () => ({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n });
    eng.exec.estimateGas = async () => 21000n;
    eng.exec.rpc = {
      call: async (method) => {
        if (method === 'eth_getTransactionCount') return '0x1';
        if (method === 'eth_sendRawTransaction') throw new Error('insufficient funds');
        if (method === 'eth_getTransactionByHash') return null;   // memang tidak masuk
        return null;
      },
    };
    await assert.rejects(() => eng.exec.send({ to: ME, data: '0x', value: '0' }, { kind: 'uji' }), /insufficient funds/);
  });

  // ---- yang TIDAK boleh memicu apa pun -----------------------------------
  // Kekhawatiran wajar: kalau target mengirim ETH/token, bridge, atau swap, apakah
  // bot ikut? Tidak — bot hanya membaca event likuiditas dari PoolManager dan
  // perpindahan NFT posisi. Uji ini mengunci perilaku itu.
  const { Watcher } = require('../src/watcher');
  const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const TOPIC_SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
  const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const LAIN = '0x1234567890123456789012345678901234567890';

  function watcherWith(range) {
    const store = new Store(':memory:');
    store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
    const rpc = { ethCallMany: async (c) => c.map(() => '0x'), batch: async (c) => c.map(() => ({ result: null })), getLogs: async () => [] };
    const chain = { blockTs: async (b) => b * 101, tokens: async (l) => l.map((a) => ({ address: a, symbol: '?', decimals: 18 })), slot0V4Many: async (ids) => ids.map(() => null), quoteSideOf: () => null, valueInQuote: () => null, poolKeyOfId: async () => null };
    const w = new Watcher({ rpc, store, chain, cfg: {}, log: () => {} });
    w.fetchRange = async () => range;
    w.contractCheck = async () => {};
    return w;
  }
  const log = (address, topics, data = '0x' + '0'.repeat(64)) => ({ address, topics, data, blockNumber: '0x1', transactionHash: '0xdead', logIndex: '0x1' });

  await t('target mengirim USDG ke alamat lain -> bot diam', async () => {
    const w = watcherWith({
      modLiq: [], npm: [], xferV4: [],   // transfer ERC20 ada di kontrak USDG, bukan di POSM
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('token ERC20 apa pun yang menyentuh target -> bot diam walau lognya ikut terbawa', async () => {
    // pertahanan berlapis: seandainya log ERC20 sampai masuk hasil query, bentuknya
    // 3 topik (bukan NFT 4 topik) dan harus diabaikan.
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(USDG, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN)])],
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('target melakukan swap (bukan LP) -> bot diam', async () => {
    const w = watcherWith({
      modLiq: [log(ADDR.poolManager, [TOPIC_SWAP_V4, '0x' + 'aa'.repeat(32), pad32(TARGET)])],
      xferV4: [], npm: [],
    });
    assert.strictEqual((await w.scan(1, 1)).length, 0);
  });

  await t('target mengirim NFT koleksi lain -> bot diam', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(LAIN, [TOPIC_TRANSFER, pad32(TARGET), pad32(ME), pad32('0x01')])],
    });
    const acts = await w.scan(1, 1);
    // hanya NFT dari PositionManager yang berarti; koleksi lain tidak dianggap posisi
    assert.strictEqual(acts.filter((a) => a.venue === 'v4' && a.kind !== 'transfer_out').length, 0);
  });

  await t('kontrol positif: NFT POSISI yang berpindah TETAP terdeteksi', async () => {
    const w = watcherWith({
      modLiq: [], npm: [],
      xferV4: [log(ADDR.posmV4, [TOPIC_TRANSFER, pad32(TARGET), pad32(LAIN), pad32('0x7b')])],
    });
    const acts = await w.scan(1, 1);
    assert.strictEqual(acts.length, 1, 'perpindahan NFT posisi harus terdeteksi');
    assert.strictEqual(acts[0].kind, 'transfer_out');
    assert.strictEqual(acts[0].tokenId, '123');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
