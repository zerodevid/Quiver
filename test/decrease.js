'use strict';
// Test recording a partial withdrawal (decrease) of a bot position.
//
// Real case: position #25 (FOMOBRAIN/USDG, capital $129.19) partially withdrawn when the target
// withdrew partially -> 54.75 USDG + 51,564 FOMOBRAIN entered the wallet, the FOMOBRAIN sold for
// $13.77. It used to only reduce the liquidity; that $68.52 vanished from the records and the
// position read as a $64.20 loss at close, when it was actually a ~$4 profit.
//
// Run: node test/decrease.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Positions } = require('../src/positions');
const { ADDR } = require('../src/chain');

const MEME = '0x' + 'f0'.repeat(20);
const POOL = '0x' + 'ab'.repeat(32);
const E18 = 10n ** 18n;
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);

function world() {
  const store = new Store(':memory:');
  const chain = {
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' }
      : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
  };
  const positions = new Positions({ rpc: { ethCallMany: async (c) => c.map(() => '0x') }, store, chain, log: () => {} });
  // MEME(18)/USDG(6), capital 129.19 USDG, liquidity 1000
  const r = store.run(`INSERT INTO positions(venue,pool_ref,token0,token1,status,opened_ts,cost_quote,cost1,liquidity,quote_symbol)
    VALUES('v4',?,?,?,'open',?,129.19,'129190000','1000','USDG')`, POOL, MEME, ADDR.usdg, Date.now());
  store.run("INSERT INTO txs(hash,detail) VALUES('0xdec','{}'),('0xburn','{}'),('0xsale','{}')");
  return { store, positions, id: Number(r.lastInsertRowid) };
}
const row = (d) => d.store.get('SELECT * FROM positions WHERE id=?', d.id);
// partial withdrawal: 54.75 USDG + 51,564 MEME (valued 11.62 at the price then)
const decrease = (d) => d.positions.markDecreased(d.id, {
  liquidity: '400', out0: 51_564n * E18, out1: 54_748_687n, outQuote: 54.748687 + 11.62, txHash: '0xdec',
  left: { token: MEME, amount: 51_564n * E18, quote: 11.62 },
});

(async () => {
  await t('partial withdrawal: proceeds go into out_quote, liquidity remains, the position stays open', () => {
    const d = world();
    decrease(d);
    const r = row(d);
    assert.strictEqual(r.status, 'open');
    assert.strictEqual(r.liquidity, '400');
    assert.strictEqual(r.out0, (51_564n * E18).toString());
    assert.strictEqual(r.out1, '54748687');
    near(r.out_quote, 66.368687, 'out_quote');
    assert.strictEqual(r.left_token, MEME);
    assert.strictEqual(r.left_amount, (51_564n * E18).toString());
    const detail = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0xdec'").detail);
    assert.strictEqual(detail.decreaseProceeds.amount1, '54748687');
    assert.ok(!detail.closeProceeds, 'not a close');
  });

  await t('memecoin from the partial withdrawal sold: the estimate is replaced by the real result (13.77)', () => {
    const d = world();
    decrease(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, usdOut: 13.9, ethUsd: 2500, txHash: '0xsale' });
    const r = row(d);
    near(r.out_quote, 54.748687 + 13.771173, 'out_quote');
    assert.strictEqual(r.left_amount, '0');
    assert.strictEqual(r.status, 'open');
  });

  await t('close after a partial withdrawal: PnL = everything that came out − capital (a profit, not a $64 loss)', () => {
    const d = world();
    decrease(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, ethUsd: 2500 });
    // close: 49.11 USDG + 76,782 MEME (estimated 15.9), then MEME sold for 15.88
    d.positions.markClosed(d.id, { out0: 76_782n * E18, out1: 49_113_513n, outQuote: 49.113513 + 15.9, txHash: '0xburn', exitSqrt: null,
      left: { token: MEME, amount: 76_782n * E18, quote: 15.9 } });
    let r = row(d);
    assert.strictEqual(r.status, 'closed');
    assert.strictEqual(r.out0, ((51_564n + 76_782n) * E18).toString(), 'out0 akumulasi');
    assert.strictEqual(r.out1, String(54_748_687 + 49_113_513), 'out1 akumulasi');
    assert.strictEqual(r.left_amount, (76_782n * E18).toString(), 'leftover is only what is not yet sold');
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 76_782n * E18, quoteToken: ADDR.usdg,
      amountOut: 15_878_260n, ethUsd: 2500 });
    r = row(d);
    near(r.out_quote, 54.748687 + 13.771173 + 49.113513 + 15.87826, 'out_quote total');
    near(r.out_quote - r.cost_quote, 4.321633, 'pnl');
    const detail = JSON.parse(d.store.get("SELECT detail FROM txs WHERE hash='0xburn'").detail);
    assert.strictEqual(detail.closeProceeds.amount1, '49113513', 'closeProceeds only counts the close tx');
  });

  await t('close without a partial withdrawal: old behaviour unchanged (claimed included, out not doubled)', () => {
    const d = world();
    d.store.run('UPDATE positions SET claimed_quote=2.5 WHERE id=?', d.id);
    d.positions.markClosed(d.id, { out0: 0n, out1: 140_000_000n, outQuote: 140, txHash: '0xburn', exitSqrt: null });
    const r = row(d);
    near(r.out_quote, 142.5, 'out_quote = tutup + fee terklaim');
    assert.strictEqual(r.out1, '140000000');
    assert.strictEqual(r.left_token, null);
  });

  await t('summary: an open position that was partially withdrawn does not read as a loss equal to the withdrawal', () => {
    const d = world();
    decrease(d);
    d.positions.recordLeftoverSale({ posId: d.id, token: MEME, amount: 51_564n * E18, quoteToken: ADDR.usdg,
      amountOut: 13_771_173n, ethUsd: 2500 });
    // last sync: the remaining position worth 62, fee 1
    d.positions.live = [{ id: d.id, valueUsd: 62, feeUsd: 1, empty: false }];
    const s = d.positions.summary(2500);
    near(s.unrealizedUsd, 62 + 1 + 54.748687 + 13.771173 - 129.19, 'unrealized memuat hasil tarikan');
    near(s.exposureUsd, 62, 'eksposur = nilai yang masih di pool');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
