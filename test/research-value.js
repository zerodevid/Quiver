'use strict';
// Test re-valuing still-open wallet positions (WalletResearch.refreshOpen).
//
// The bug guarded here: the wpositions row was only rewritten when the wallet was
// scanned, and scanning was only triggered by the Wallet/Target page or the target's new action.
// A target that stayed quiet for hours therefore showed a value from a few seconds
// after its mint — on the Pool page that figure sat next to the bot position, which
// is recomputed every 30 seconds, so the SAME pool with the SAME range
// read +1.6% in one table and −2.2% in the neighbouring table.
//
// Run: node test/research-value.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Chain } = require('../src/pools');
const { WalletResearch } = require('../src/wallet');
const { ADDR } = require('../src/chain');
const m = require('../src/v3math');

const W = '0xe1d742e039aea02402b2d864b70ea55b5e0f3e79';
const MEME = '0xe2324ff2a59f8ecba8c321c6466e59121c00e795';
const POOL = '0x' + '11'.repeat(32);
// The real range from the event that surfaced the bug: USDG/MEME, minted OUTSIDE the range
// (entirely USDG) then the price dropped into it.
const LO = 321574, HI = 340856, ENTRY = 321420;
const L = 6196195902088646n;
const CAPITAL = 399.054643;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const w256 = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');

// Fake world: only the pool price and the PoolManager storage are faked; valuation
// (valueInQuote/quoteSideOf) and the tick math use the real code.
function world({ tick = ENTRY, onchainLiquidity = L, tokensTable = true } = {}) {
  const store = new Store(':memory:');
  const hit = { slot0: 0, fee: 0 };
  const rpc = {
    // unclaimedV4 reads 9 slots per position; what matters here is slot 7 (L).
    // The rest are zero -> running fees zero, enough to test the principal value.
    ethCallMany: async (calls) => {
      hit.fee++;
      return calls.map((_, i) => (i % 9 === 6 ? w256(onchainLiquidity) : w256(0)));
    },
  };
  const chain = new Chain(rpc, store, () => {});
  chain.slot0V4Many = async (ids) => {
    hit.slot0++;
    return ids.map(() => ({ sqrtPriceX96: m.getSqrtRatioAtTick(tick), tick, protocolFee: 0, lpFee: 0 }));
  };
  if (tokensTable) {
    store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
    store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  }
  store.run(
    `INSERT INTO wpositions (wallet,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,
       invested_q,returned_q,fees_q,pnl_q,live_value_q,live_fee_q,in_range,quote_symbol,status,opened_ts)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    W, 'v4', '2449473', POOL, ADDR.usdg, MEME, 31100, LO, HI, L.toString(),
    CAPITAL, 0, 0, 0, CAPITAL, 0, 0, 'USDG', 'open', Date.now());
  const research = new WalletResearch({ rpc, store, chain, log: () => {} });
  const row = () => store.all('SELECT * FROM wpositions WHERE wallet=?', W)
    .map((r) => ({ ...r, dec0: 6, dec1: 18 }));
  return { store, research, row, hit };
}

(async () => {
  console.log('\nRe-valuation of open wallet positions');

  await t('REGRESSION: the value no longer lags in a photo at scan time', async () => {
    // The price dropped far into the range: some of its USDG has already become MEME, so
    // its value in USDG cannot equal the capital.
    const { research, row } = world({ tick: (LO + HI) / 2 | 0 });
    const rows = row();
    assert.strictEqual(rows[0].pnl_q, 0, 'precondition: the stored row is still the old photo');
    await research.refreshOpen(rows, 2500);
    assert.ok(rows[0].liveTs, 'the row is marked as already valued at the current price');
    assert.ok(rows[0].live_value_q < CAPITAL, `value fell after the price dropped (got ${rows[0].live_value_q})`);
    assert.ok(rows[0].pnl_q < -1, `PnL ikut negatif (dapat ${rows[0].pnl_q})`);
    assert.strictEqual(rows[0].in_range, 1, 'current price inside the range');
  });

  await t('the result is written to the DB, so the wallet summary does not differ from its table', async () => {
    const { research, row, store } = world({ tick: (LO + HI) / 2 | 0 });
    await research.refreshOpen(row(), 2500);
    const r = store.get('SELECT live_value_q, pnl_q FROM wpositions WHERE wallet=?', W);
    assert.ok(r.live_value_q < CAPITAL && r.pnl_q < -1, 'stored value & PnL are also fresh');
  });

  await t('price still outside the range: the position is still entirely USDG, its value does not change', async () => {
    const { research, row } = world({ tick: ENTRY });
    const rows = row();
    await research.refreshOpen(rows, 2500);
    assert.ok(Math.abs(rows[0].live_value_q - CAPITAL) < 0.01, `value stays at capital (got ${rows[0].live_value_q})`);
    assert.strictEqual(rows[0].in_range, 0);
  });

  await t('token decimals are looked up itself if the caller does not decorate the row', async () => {
    const { research, store } = world({ tick: (LO + HI) / 2 | 0 });
    const polos = store.all('SELECT * FROM wpositions WHERE wallet=?', W);   // without dec0/dec1
    await research.refreshOpen(polos, 2500);
    const { research: r2, row } = world({ tick: (LO + HI) / 2 | 0 });
    const dihias = row();
    await r2.refreshOpen(dihias, 2500);
    assert.ok(Math.abs(polos[0].live_value_q - dihias[0].live_value_q) < 1e-9,
      'its value equals that of the row that already carries decimals');
  });

  await t('on-chain liquidity is already zero: the old figure is kept, not stamped fresh', async () => {
    // The position was closed after the last scan — its close result has not been read yet, so
    // writing a value of 0 now would show it as if the whole capital was lost.
    const { research, row } = world({ tick: (LO + HI) / 2 | 0, onchainLiquidity: 0n });
    const rows = row();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(rows[0].liveTs, undefined, 'not marked fresh; the UI calls it "stored"');
    assert.strictEqual(rows[0].pnl_q, 0, 'the stored figure is not touched');
  });

  await t('pool price unreadable: the row is left as it is, not zeroed', async () => {
    const { research, row, store } = world({ tick: (LO + HI) / 2 | 0 });
    research.chain.slot0V4Many = async () => { throw new Error('RPC 429'); };
    const rows = row();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(rows[0].liveTs, undefined);
    assert.strictEqual(store.get('SELECT live_value_q v FROM wpositions WHERE wallet=?', W).v, CAPITAL);
  });

  await t('short cache: a page polled every few seconds does not flood the RPC', async () => {
    const { research, row, hit } = world({ tick: (LO + HI) / 2 | 0 });
    await research.refreshOpen(row(), 2500);
    const slot0 = hit.slot0, fee = hit.fee;
    const rows = row();
    await research.refreshOpen(rows, 2500);
    assert.strictEqual(hit.slot0, slot0, 'price is not re-read within the TTL');
    assert.strictEqual(hit.fee, fee, 'fee is not re-read within the TTL');
    assert.ok(rows[0].liveTs, 'the second row still uses the fresh figure from the cache');
    await research.refreshOpen(row(), 2500, { ttlMs: 0 });
    assert.strictEqual(hit.slot0, slot0 + 1, 'TTL expired -> read again');
  });

  await t('a closed position is not re-valued', async () => {
    const { research, store, hit } = world({ tick: (LO + HI) / 2 | 0 });
    store.run("UPDATE wpositions SET status='closed' WHERE wallet=?", W);
    await research.refreshOpen(store.all('SELECT * FROM wpositions WHERE wallet=?', W), 2500);
    assert.strictEqual(hit.slot0, 0, 'no chain call at all');
  });

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
