'use strict';
// Uji: eth_call yang GAGAL tidak boleh dibaca sebagai nol.
//
// Kasus nyata: endpoint RPC rusak sesaat (12 Sep 16:56). getPositionLiquidity #45
// gagal -> dibaca 0 -> "likuiditas sudah nol di chain" -> ditutup di DB dengan hasil
// $0, padahal di chain masih utuh $110. Di sinkron yang sama slot fee gagal -> 0 ->
// sub() membungkus mod 2^256 -> fee 5,7e47 masuk ke ekuitas.
//
// Jalankan: node test/rpc-gagal.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');
const { unclaimedV4 } = require('../src/fees');
const mm = require('../src/v3math');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const E18 = 10n ** 18n;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const sqrt = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));

// st.liq: jawaban getPositionLiquidity (null = RPC error); st.feeOk: slot fee terbaca?
function dunia(st) {
  const store = new Store(':memory:');
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4Many: async (ids) => ids.map(() => ({ sqrtPriceX96: sqrt, tick: 0 })),
    poolLiquidityMany: async (ids) => ids.map(() => 1n),
    markSqrtForPair: async () => null,
    quoteSideOf: (t0) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote: ({ amount0, amount1 }) => ({ value: Number(amount0) / 1e6 + Number(amount1) / 1e18 / 1000, kind: 'usd' }),
  };
  const rpc = {
    ethCallMany: async (calls) => calls.map((c) => {
      if (c.to === ADDR.posmV4) return st.liq == null ? null : hex(st.liq);
      if (c.to === ADDR.poolManager) return st.feeOk ? hex(0n) : null;
      return hex(0n);
    }),
  };
  const positions = new Positions({ rpc, store, chain, log: () => {} });
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,quote_symbol,liquidity,fees_quote)
    VALUES('v4',?,'77',?,?,-100,100,'open',?,110,'USDG','5000000',1.5)`, POOL, ADDR.usdg, MEME, Date.now());
  return { store, positions, id: Number(r.lastInsertRowid), st };
}

(async () => {
  console.log('rpc-gagal:');

  await t('likuiditas gagal dibaca: pakai angka tersimpan, TIDAK dianggap kosong', async () => {
    const d = dunia({ liq: null, feeOk: true });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.empty, false);
    assert.strictEqual(p.liqStale, true);
    assert.strictEqual(p.liquidity, '5000000');
    assert.strictEqual(d.positions.exitTriggers({ exit: {} }).length, 0, 'tidak boleh memicu keluar');
    assert.strictEqual(d.store.get('SELECT status, liquidity FROM positions WHERE id=?', d.id).liquidity, '5000000');
  });

  await t('likuiditas benar-benar nol dari chain: kosong', async () => {
    const d = dunia({ liq: 0n, feeOk: true });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.empty, true);
    assert.strictEqual(await d.positions.confirmEmpty(p), true);
  });

  await t('confirmEmpty: gagal baca = tidak terkonfirmasi', async () => {
    const d = dunia({ liq: 0n, feeOk: true });
    const [p] = await d.positions.sync(2500);
    d.st.liq = null;
    assert.strictEqual(await d.positions.confirmEmpty(p), false);
    d.st.liq = 5000000n;
    assert.strictEqual(await d.positions.confirmEmpty(p), false);
  });

  await t('slot fee gagal dibaca: unclaimedV4 -> unknown, bukan 10^47', async () => {
    const rpc = { ethCallMany: async (calls) => calls.map((_, i) => (i === 3 ? null : hex(7n))) };
    const [f] = await unclaimedV4(rpc, [{ poolId: POOL, tickLower: -100, tickUpper: 100, tokenId: '77' }], new Map([[POOL, 0]]));
    assert.strictEqual(f.unknown, true);
    assert.strictEqual(f.fee0, 0n); assert.strictEqual(f.fee1, 0n);
  });

  await t('fee gagal dibaca saat sinkron: fees_quote terakhir dipertahankan', async () => {
    const d = dunia({ liq: 5000000n, feeOk: false });
    const [p] = await d.positions.sync(2500);
    assert.strictEqual(p.feeUsd, 1.5);
    assert.ok(p.feeUsd < 1e6, `fee sampah: ${p.feeUsd}`);
    assert.strictEqual(d.store.get('SELECT fees_quote FROM positions WHERE id=?', d.id).fees_quote, 1.5);
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
