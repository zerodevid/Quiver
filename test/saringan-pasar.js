'use strict';
// Uji: saringan likuiditas & volume pool (filters.min_liquidity_usd, min_volume24h_usd).
// Pool sepi tidak membayar fee, jadi modal yang masuk ke sana hanya menanggung risiko
// tokennya. Yang dijaga di sini: ambangnya benar-benar menolak, pool yang BELUM
// terindeks DexScreener tetap lewat (bukan ditolak diam-diam), saringan yang mati tidak
// memanggil DexScreener sama sekali, dan DexScreener yang lambat tidak menahan entry.
// Jalankan: node test/saringan-pasar.js
const assert = require('node:assert');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const USDG = ADDR.usdg, MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const TARGET = '0x3c926ee5e990b3999f1f656a9b18ff678ce82976';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

function harness({ rules = {}, pair = undefined } = {}) {
  const store = new Store(':memory:');
  store.run('INSERT INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', TARGET, 'uji', Date.now());
  const tokens = {
    [USDG]: { address: USDG, symbol: 'USDG', decimals: 6 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const slot0 = () => ({ sqrtPriceX96: m.getSqrtRatioAtTick(0), tick: 0 });
  const chain = {
    tokens: async (list) => list.map((a) => tokens[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    slot0V4: async () => slot0(), slot0V3: async () => slot0(),
    poolAgeMinutes: async () => 10_000, ethUsd: async () => 2500,
    quoteSideOf(t0, t1) {
      const q = { [USDG]: { symbol: 'USDG', decimals: 6, kind: 'usd' } };
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
  };
  const cfg = { mode: { dry_run: false, paused: false }, rules, gas: {}, loop: {} };
  const rpc = { ethCallMany: async (c) => c.map(() => null), call: async () => null, blockNumber: async () => 1e6 };
  const eng = new Engine({ rpc, store, chain, cfg, log: () => {} });
  eng.ethUsd = 2500;
  eng.exec.address = () => ME;
  eng.notify = () => {};
  eng.spendableCash = async () => null;
  eng.targetLiquidity = async () => ({ liquidity: 10n ** 20n, atBlock: false });
  // DexScreener palsu: `pair` undefined = tidak dipasang sama sekali (saringan mati
  // tidak boleh memanggilnya); fungsi = jawabannya; objek = jawaban tetap.
  const calls = [];
  eng.market = {
    pair: async (ref) => { calls.push(ref); return typeof pair === 'function' ? pair(ref) : pair; },
  };
  const entries = [];
  eng.executeEntry = async (plan, act) => {
    entries.push({ plan, act });
    return { txHash: '0x1', positionId: 1, note: 'uji', pair: 'USDG/MEME' };
  };
  return { eng, store, entries, calls };
}

function action(store) {
  const a = {
    ts: Date.now(), block: 1000, txHash: '0x' + Math.random().toString(16).slice(2), logIndex: 1,
    target: TARGET, venue: 'v4', kind: 'increase', tokenId: '999',
    poolRef: POOL, poolKey: { currency0: USDG, currency1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native },
    token0: USDG, token1: MEME, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    tickLower: -600, tickUpper: 600, liquidity: (10n ** 20n).toString(), amount0: '0', amount1: '0',
    valueQuote: null, quoteSymbol: 'USDG', slot0: null,
  };
  a.id = Number(store.run(
    `INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,quote_symbol)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId, a.poolRef, a.token0, a.token1, a.fee, a.tickSpacing, a.hooks,
    a.tickLower, a.tickUpper, a.liquidity, a.quoteSymbol).lastInsertRowid);
  return a;
}
const lastDecision = (store) => store.get('SELECT verdict, reason FROM decisions ORDER BY id DESC LIMIT 1');
const RULES = (f) => ({
  exit: {}, sizing: { mode: 'fixed_quote', fixed_quote_usd: 10, min_quote_usd: 0 },
  filters: { min_target_quote_usd: 0, cooldown_seconds: 0, ...f },
});

(async () => {
  console.log('Saringan likuiditas & volume pool:\n');

  await t('likuiditas di bawah ambang → dilewati, alasannya menyebut angka pool dan ambangnya', async () => {
    const { eng, store, entries } = harness({
      rules: RULES({ min_liquidity_usd: 50_000 }),
      pair: { liquidityUsd: 12_300, volume: { h24: 900_000 } },
    });
    await eng.handle(action(store));
    const d = lastDecision(store);
    assert.strictEqual(d.verdict, 'skip');
    assert.match(d.reason, /likuiditas pool \$12\.3rb \(< \$50\.0rb\)/);
    assert.strictEqual(entries.length, 0);
  });

  await t('volume 24 jam di bawah ambang → dilewati meski likuiditasnya tebal', async () => {
    const { eng, store, entries } = harness({
      rules: RULES({ min_volume24h_usd: 25_000 }),
      pair: { liquidityUsd: 2_000_000, volume: { h24: 912 } },
    });
    await eng.handle(action(store));
    const d = lastDecision(store);
    assert.strictEqual(d.verdict, 'skip');
    assert.match(d.reason, /volume 24 jam \$912\.00 \(< \$25\.0rb\)/);
    assert.strictEqual(entries.length, 0);
  });

  await t('keduanya di atas ambang → disalin seperti biasa', async () => {
    const { eng, store, entries } = harness({
      rules: RULES({ min_liquidity_usd: 50_000, min_volume24h_usd: 25_000 }),
      pair: { liquidityUsd: 340_000, volume: { h24: 4_310_000 } },
    });
    await eng.handle(action(store));
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(entries.length, 1);
  });

  await t('pool belum terindeks DexScreener → TIDAK dihalangi (menolak yang terbukti sepi, bukan yang belum dikenal)', async () => {
    for (const jawab of [{ error: 'pool ini belum terindeks di DexScreener' }, null, { liquidityUsd: null, volume: {} }]) {
      const { eng, store, entries } = harness({
        rules: RULES({ min_liquidity_usd: 50_000, min_volume24h_usd: 25_000 }), pair: jawab,
      });
      await eng.handle(action(store));
      assert.strictEqual(lastDecision(store).verdict, 'copy', `jawaban ${JSON.stringify(jawab)}`);
      assert.strictEqual(entries.length, 1);
    }
  });

  await t('DexScreener melempar → entry jalan terus, bukan gagal', async () => {
    const { eng, store, entries } = harness({
      rules: RULES({ min_liquidity_usd: 50_000 }),
      pair: () => { throw new Error('HTTP 502'); },
    });
    await eng.handle(action(store));
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(entries.length, 1);
  });

  await t('kedua ambang 0 → DexScreener tidak dipanggil sama sekali', async () => {
    const { eng, store, entries, calls } = harness({
      rules: RULES({ min_liquidity_usd: 0, min_volume24h_usd: 0 }),
      pair: { liquidityUsd: 1, volume: { h24: 1 } },
    });
    await eng.handle(action(store));
    assert.strictEqual(calls.length, 0, 'saringan mati tidak boleh menarik data pasar');
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(entries.length, 1);
  });

  await t('DexScreener menggantung → entry tidak ikut tergantung (batas 4 detik)', async () => {
    const { eng, store, entries } = harness({
      rules: RULES({ min_liquidity_usd: 50_000 }),
      pair: () => new Promise(() => {}),
    });
    const t0 = Date.now();
    await eng.handle(action(store));
    const ms = Date.now() - t0;
    assert.ok(ms >= 3500 && ms < 8000, `menunggu ${ms} ms`);
    assert.strictEqual(lastDecision(store).verdict, 'copy');
    assert.strictEqual(entries.length, 1);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
