'use strict';
// Test: surplus zap tokens from an entry that SUCCEEDED go into the sell queue.
// Real case (#417, 22 Sep): the zap bought 3,394 NOSH for a $110 LP, the pool price moved
// 482 ticks within 9 seconds before the mint landed, the mint only deposited 371.62 NOSH — the remaining 3,022.38
// NOSH sat naked in the wallet (rescueZap only runs if the LP fails, the wallet
// sweep skips tokens of still-open positions).
// Run: node test/leftover-zap.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Engine } = require('../src/engine');
const { Store } = require('../src/db');
const { ADDR, TOPIC } = require('../src/chain');

const USDG = ADDR.usdg;
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const ME = '0xe9c209fd02a1562761c99700fc3d126e64b981ee';
const PM = '0x' + '99'.repeat(20);
const MINT = '0x' + 'ab'.repeat(32);
const coder = ethers.AbiCoder.defaultAbiCoder();

const PLAN = { venue: 'v4', poolRef: '0x' + '33'.repeat(32), token0: USDG, token1: MEME, target: null };
// 1 MEME = $0.0028 (18 decimals vs USDG's 6) — used by the dust gate.
const PRICE = 0.0028;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); pass++; }
  catch (e) { console.log('  GAGAL ' + name + '\n        ' + String(e.stack || e.message).split('\n').slice(0, 3).join('\n        ')); fail++; }
}

// Mint receipt: `in` MEME leaves the wallet for the PoolManager (the capital that actually
// became liquidity). spentIn reads it from the Transfer log, not from the balance difference.
function receiptMint(entry) {
  return { status: '0x1', blockNumber: '0x10', logs: [{
    address: MEME, topics: [TOPIC.transfer, ethers.zeroPadValue(ME, 32), ethers.zeroPadValue(PM, 32)],
    data: coder.encode(['uint256'], [entry]),
  }] };
}

function engineWith({ saldo: balance = null } = {}) {
  const store = new Store(':memory:');
  const eng = new Engine({
    store,
    rpc: { call: async () => null, ethCallMany: async (c) => c.map(() => null) },
    // Without ADDR/isV3Venue so ensureChain fills it in with the real robinhood chain
    // (real QUOTES: USDG is cash, MEME is not).
    chain: {
      slot0V4: async () => ({ sqrtPriceX96: 1n, tick: 0 }),
      token: async (a) => ({ address: a, symbol: 'MEME', decimals: 18 }),
      tokens: async (list) => list.map((a) => ({ address: a, symbol: a === USDG ? 'USDG' : 'MEME', decimals: a === USDG ? 6 : 18 })),
      valueInQuote: ({ amount1 }) => ({ value: (Number(amount1) / 1e18) * PRICE, kind: 'usd', symbol: 'USDG', side: 0 }),
    },
    cfg: { mode: { dry_run: false }, gas: {}, loop: {}, rules: {} }, log: () => {},
  });
  eng.exec.address = () => ME;
  eng.exec.balances = async (list) => new Map(list.map((x) => [String(x).toLowerCase(), balance == null ? 10n ** 30n : balance]));
  eng.notify = () => {};
  // The mint tx row, so the "already swept" marker has somewhere to be written.
  store.run('INSERT INTO txs(chain,hash,ts,kind,status,detail) VALUES(?,?,?,?,?,?)',
    'robinhood', MINT, Date.now(), 'mint', 'sukses', JSON.stringify({ pool: PLAN.poolRef }));
  return { eng, store };
}

const zap = (gained, extra = {}) => ({ token: MEME, quote: USDG, before: 0n, gained: String(gained), hashes: ['0x' + 'cd'.repeat(32)], ...extra });

(async () => {
  console.log('Zap surplus after the LP is opened:\n');

  await t('what was bought but not deposited goes into the sell queue', async () => {
    const { eng } = engineWith();
    const buy = 3394000000000000000000n, entry = 371617226748265173792n;
    const r = await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(entry), { hash: MINT });
    assert.strictEqual(r.amount, String(buy - entry), 'what is queued = bought - what went into the LP');
    const q = eng.leftovers();
    assert.strictEqual(q.length, 1);
    assert.strictEqual(q[0].token, MEME);
    assert.strictEqual(q[0].amount, String(buy - entry));
    assert.strictEqual(q[0].posId ?? null, null, 'not a position leftover: its sale proceeds must not be booked to the position');
    assert.strictEqual(q[0].quote, USDG);
  });

  await t('a zap fully used leaves nothing', async () => {
    const { eng } = engineWith();
    const buy = 3394000000000000000000n;
    assert.strictEqual(await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(buy), { hash: MINT }), null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('dust below $0.50 is left in the wallet', async () => {
    const { eng } = engineWith();
    const buy = 3394000000000000000000n;
    // 50 MEME left ~ $0.14: selling it would not even cover its own gas
    await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(buy - 50n * 10n ** 18n), { hash: MINT });
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('never queues more than what is really free in the wallet', async () => {
    // The real balance is only 1,000 MEME (some already used by another program / already sold):
    // what gets queued follows the balance, not the receipt figure.
    const { eng } = engineWith({ saldo: 1000n * 10n ** 18n });
    const buy = 3394000000000000000000n, entry = 371617226748265173792n;
    const r = await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(entry), { hash: MINT });
    assert.strictEqual(r.amount, String(1000n * 10n ** 18n));
  });

  await t('an unreadable zap result is not guessed from the balance', async () => {
    const { eng } = engineWith();
    const r = await eng.sweepZapSurplus(PLAN, zap(0, { gainedUnknown: true }), receiptMint(0n), { hash: MINT });
    assert.strictEqual(r, null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  await t('once per mint: the entry flow + deferred booking do not count twice', async () => {
    const { eng } = engineWith();
    const buy = 3394000000000000000000n, entry = 371617226748265173792n;
    await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(entry), { hash: MINT });
    const again = await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(entry), { hash: MINT });
    assert.strictEqual(again, null);
    assert.strictEqual(eng.leftovers().length, 1);
    assert.strictEqual(eng.leftovers()[0].amount, String(buy - entry), 'the amount does not double');
  });

  await t('an old item for the same token is added to, not overwritten', async () => {
    const { eng } = engineWith();
    eng.keepLeftover({ posId: null, target: null, token: MEME, quote: USDG, amount: '1000', tries: 0, since: Date.now() }, 'uji');
    const buy = 3394000000000000000000n, entry = 371617226748265173792n;
    await eng.sweepZapSurplus(PLAN, zap(buy), receiptMint(entry), { hash: MINT });
    assert.strictEqual(eng.leftovers().length, 1);
    assert.strictEqual(eng.leftovers()[0].amount, String(buy - entry + 1000n));
  });

  await t('a quote asset is never considered leftover', async () => {
    const { eng } = engineWith();
    const r = await eng.sweepZapSurplus({ ...PLAN, token1: USDG }, { ...zap(10n ** 18n), token: USDG }, receiptMint(0n), { hash: MINT });
    assert.strictEqual(r, null);
    assert.deepStrictEqual(eng.leftovers(), []);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
