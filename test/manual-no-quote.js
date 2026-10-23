'use strict';
// Manual LP on a pair with no quote asset (memecoin/memecoin, e.g. HOOD/CUCK): planned in USD
// through the DexScreener anchor, booked as USDG, both tokens bought from USDG cash.
// Run: node test/manual-no-quote.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/db');
const { Engine } = require('../src/engine');
const { Manual } = require('../src/manual');
const { ADDR } = require('../src/chain');
const { setAnchor, valueAnchoredUsd } = require('../src/usd-anchor');
const m = require('../src/v3math');

const ME = '0x' + '11'.repeat(20), A = '0x' + '22'.repeat(20), B = '0x' + '44'.repeat(20), POOL = '0x' + '33'.repeat(32);
const lc = (x) => x.toLowerCase();

function fixture({ tick = 0, usdA = 2, usdg = 1_000_000_000n } = {}) {
  const store = new Store(':memory:');
  const pool = { poolRef: POOL, venue: 'v4', token0: A, token1: B, fee: 3000, tickSpacing: 60, hooks: ADDR.native,
    symbol0: 'HOOD', symbol1: 'CUCK', dec0: 18, dec1: 18, pair: 'HOOD/CUCK', quoteSide: null, quoteKind: null, quoteSymbol: null };
  const slot = { tick, sqrtPriceX96: m.getSqrtRatioAtTick(tick) + 1n };
  const chain = {
    ADDR, QUOTES: { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' }, [ADDR.native]: { symbol: 'ETH', decimals: 18, kind: 'eth' } },
    usdgDecimals: 6, network: 'robinhood',
    slot0V4: async () => slot, slot0V3: async () => slot,
    tokens: async (list) => list.map((address) => ({ address, symbol: '?', decimals: 18 })),
    quoteSideOf: (t0, t1) => chain.QUOTES[lc(t0)] ? { side: 0, ...chain.QUOTES[lc(t0)] } : chain.QUOTES[lc(t1)] ? { side: 1, ...chain.QUOTES[lc(t1)] } : null,
    valueInQuote(x) {
      const usd = valueAnchoredUsd(chain, x);
      return usd == null ? null : { value: usd, symbol: 'USDG', side: null, kind: 'usd', anchored: true };
    },
  };
  if (usdA != null) setAnchor(chain, A, usdA);
  const eng = new Engine({ rpc: {}, store, chain, cfg: { mode: { dry_run: false }, rules: {}, gas: {} }, log: () => {} });
  eng.ethUsd = 2500;
  eng.exec.address = () => ME;
  const balances = new Map([[lc(ADDR.usdg), usdg], [lc(ADDR.native), 10n ** 17n]]);
  eng.exec.balances = async () => balances;
  const manual = new Manual({ engine: eng, store, chain, rpc: {} });
  manual.poolByRef = async () => pool;
  return { eng, store, manual, balances };
}

test('a pair without a quote asset is planned in USD and booked as USDG', async () => {
  const f = fixture();
  try {
    const r = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 25 });
    assert.ok(!r.error, r.error);
    assert.equal(r.plan.noQuote, true);
    assert.equal(r.plan.quoteSide, null);
    assert.equal(r.plan.quoteSymbol, 'USDG');
    assert.equal(r.plan.quoteKind, 'usd');
    assert.ok(Math.abs(r.plan.valueUsd - 50) < 0.5, `valueUsd ${r.plan.valueUsd}`);
    assert.ok(BigInt(r.plan.amount0) > 0n && BigInt(r.plan.amount1) > 0n);
    // token0 priced in token1: −25% … +25% around the price
    assert.ok(Math.abs(r.preview.lowerPct - 25) < 1 && Math.abs(r.preview.upperPct - 25) < 1, `${r.preview.lowerPct}/${r.preview.upperPct}`);
    assert.ok(r.warnings.some((w) => /tanpa aset kuotasi/.test(w)));
  } finally { f.store.db.close(); }
});

test('the swap preview buys both tokens from USDG', async () => {
  const f = fixture();
  try {
    const r = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 25 });
    const buys = r.preview.swaps.filter((s) => s.jenis === 'zap');
    assert.deepEqual(buys.map((s) => s.dari.token), [lc(ADDR.usdg), lc(ADDR.usdg)]);
    assert.deepEqual(buys.map((s) => s.ke.token).sort(), [lc(A), lc(B)].sort());
    const paid = buys.reduce((a, s) => a + s.dari.usd, 0);
    assert.ok(paid > 50 && paid < 53, `paid ${paid}`);
    assert.ok(!r.preview.swaps.some((s) => s.jenis === 'jembatan'), 'enough USDG: no bridge');
  } finally { f.store.db.close(); }
});

test('short USDG is bridged from ETH first', async () => {
  const f = fixture({ usdg: 0n });
  try {
    const r = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 25 });
    assert.ok(!r.error, r.error);
    assert.equal(r.preview.swaps[0].jenis, 'jembatan');
    assert.equal(r.preview.swaps[0].ke.token, lc(ADDR.usdg));
  } finally { f.store.db.close(); }
});

test('a one-sided range follows the token0-in-token1 orientation', async () => {
  const f = fixture();
  try {
    const above = await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 0, upperPct: 25 });
    assert.ok(!above.error, above.error);
    assert.equal(above.plan.amount1, '0');   // above the price: token0 only
    assert.equal(above.preview.swaps.filter((s) => s.jenis === 'zap').length, 1);
  } finally { f.store.db.close(); }
});

test('no USD price or auto-swap off is refused before anything is sent', async () => {
  const f = fixture({ usdA: null });
  try {
    assert.match((await f.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 25 })).error, /harga dolar token belum terbaca/);
  } finally { f.store.db.close(); }
  const g = fixture();
  try {
    g.eng.cfg.rules.swap = { enabled: false };
    assert.match((await g.manual.planLp({ poolRef: POOL, usd: 50, lowerPct: 25, upperPct: 25 })).error, /butuh auto-swap/);
  } finally { g.store.db.close(); }
});
