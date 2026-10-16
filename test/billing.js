'use strict';
// Platform billing: fee math, treasury resolution, and the ledger.
//
// Run: node test/billing.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const b = require('../src/billing');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

const ADDR = '0x' + '1'.repeat(40);
const REF = '0x' + '2'.repeat(40);

(async () => {
  console.log('billing');

  await t('default schedule is a flat $0.20 for every billable action, free the rest', () => {
    const cfg = {};
    assert.equal(b.feeUsd(cfg, 'open'), 0.20);
    assert.equal(b.feeUsd(cfg, 'close'), 0.20);
    assert.equal(b.feeUsd(cfg, 'tp_sl'), 0.20);
    assert.equal(b.feeUsd(cfg, 'rebalance'), 0.20);
    for (const free of ['collect', 'add', 'compound']) assert.equal(b.feeUsd(cfg, free), 0, free);
    assert.equal(b.feeUsd(cfg, 'something_unknown'), 0, 'unknown actions are free, never guessed');
  });

  await t('admin can override the schedule and disable billing entirely', () => {
    assert.equal(b.feeUsd({ fees: { schedule: { open: 0.5 } } }, 'open'), 0.5);
    assert.equal(b.feeUsd({ fees: { schedule: { open: 0 } } }, 'open'), 0, 'a 0 entry is free');
    assert.equal(b.feeUsd({ fees: { enabled: false, schedule: { open: 0.5 } } }, 'open'), 0, 'disabled = all free');
  });

  await t('USD converts to native wei at the native price, and refuses to guess without one', () => {
    // $0.15 at $3000/native = 0.00005 native = 5e13 wei.
    assert.equal(b.feeNativeWei(0.15, 3000), 50000000000000n);
    assert.equal(b.feeNativeWei(0.15, 0), null, 'no price -> no charge');
    assert.equal(b.feeNativeWei(0, 3000), null, 'no fee -> nothing');
  });

  await t('treasury resolves and checksums the address, null when unset or invalid', () => {
    assert.equal(b.treasuryFor({}, 'robinhood'), null);
    assert.equal(b.treasuryFor({ treasury: { robinhood: { address: 'nope' } } }, 'robinhood'), null);
    const got = b.treasuryFor({ treasury: { robinhood: { address: ADDR, referral: REF } } }, 'robinhood');
    assert.equal(got.address.toLowerCase(), ADDR);
    assert.equal(got.referral.toLowerCase(), REF);
  });

  await t('referral share defaults to 25% and clamps to [0,1]', () => {
    assert.equal(b.referralShare({}), 0.25);
    assert.equal(b.referralShare({ fees: { referral_share: 0.4 } }), 0.4);
    assert.equal(b.referralShare({ fees: { referral_share: 9 } }), 0.25, 'out of range -> default');
  });

  await t('the ledger records paid and debt rows and totals them', () => {
    const store = new Store(':memory:');
    b.recordFee(store, 'robinhood', { action: 'open', positionId: 1, usd: 0.15, native: 50000000000000n, treasury: ADDR, tx: '0xabc', status: 'paid' });
    b.recordFee(store, 'robinhood', { action: 'close', positionId: 1, usd: 0.15, status: 'debt' });
    b.recordFee(store, 'robinhood', { action: 'open', usd: 0, status: 'skip' });
    const s = b.feeSummary(store, 'robinhood');
    assert.equal(s.paidCount, 1);
    assert.ok(Math.abs(s.paidUsd - 0.15) < 1e-9, 'paid usd');
    assert.equal(s.debtCount, 1);
    assert.ok(Math.abs(s.debtUsd - 0.15) < 1e-9, 'debt usd');
    const row = store.get("SELECT native FROM platform_fee WHERE status='paid'");
    assert.equal(row.native, '50000000000000', 'native stored as decimal text, not a lossy float');
  });

  // ---- Engine#chargeFee: who pays, and paid vs debt vs exempt ----
  const { Engine } = require('../src/engine');
  const stubEngine = ({ copy = false, dry = false, bal = 10n ** 18n, cfg } = {}) => {
    let sent = null;
    const store = new Store(':memory:');
    const e = Object.create(Engine.prototype);
    Object.assign(e, {
      cfg, chain: { network: 'robinhood' }, ethUsd: 3000, store,
      copyEnabled: () => copy, dryRun: () => dry,
      exec: { address: () => ADDR, sendTransaction: async (tx) => { sent = tx; return '0xfee'; } },
      rpc: { call: async () => '0x' + bal.toString(16) },
    });
    return { e, store, sentTx: () => sent };
  };
  const feeCfg = { fees: { enabled: true }, treasury: { robinhood: { address: ADDR } } };

  await t('chargeFee: an open-LP account with native pays and records it', async () => {
    const { e, store, sentTx } = stubEngine({ cfg: feeCfg });
    await e.chargeFee('open', { positionId: 5 });
    const row = store.get("SELECT * FROM platform_fee WHERE status='paid'");
    assert.ok(row, 'a paid row exists');
    assert.equal(row.action, 'open');
    assert.equal(row.tx, '0xfee');
    assert.ok(sentTx() && sentTx().value === b.feeNativeWei(0.20, 3000), 'sent the native fee');
  });

  await t('chargeFee: no native -> recorded as debt, no tx sent', async () => {
    const { e, store, sentTx } = stubEngine({ cfg: feeCfg, bal: 1n });
    await e.chargeFee('close', { positionId: 5 });
    assert.equal(sentTx(), null, 'nothing sent');
    assert.ok(store.get("SELECT * FROM platform_fee WHERE status='debt'"), 'debt row');
  });

  await t('chargeFee: the superadmin (copy) and simulation are never charged', async () => {
    for (const opts of [{ copy: true, cfg: feeCfg }, { dry: true, cfg: feeCfg }]) {
      const { e, store, sentTx } = stubEngine(opts);
      await e.chargeFee('open', {});
      assert.equal(sentTx(), null);
      assert.equal(store.get('SELECT COUNT(*) AS n FROM platform_fee').n, 0);
    }
  });

  await t('chargeFee: no treasury configured -> free, nothing recorded', async () => {
    const { e, store, sentTx } = stubEngine({ cfg: { fees: { enabled: true } } });
    await e.chargeFee('open', {});
    assert.equal(sentTx(), null);
    assert.equal(store.get('SELECT COUNT(*) AS n FROM platform_fee').n, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
