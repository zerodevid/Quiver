'use strict';
// Test the running cost of a position: gas burned + swap slippage, split between OPENING
// and CLOSING (src/costs.js, then the shape sent by /api/position).
//
// What is guarded here:
//   - gas is computed from gas_used × gas_price, and uses gas_quote (the ETH price at the
//     time of the transaction) if already booked — not today's ETH price;
//   - a transaction that REVERTED is still counted: its gas was really burned;
//   - an approve that does not mention a position number goes to the owned transaction after it;
//   - a zap from a CANCELLED entry attempt is not charged to the next position;
//   - one leftover sale that closes two positions is split evenly;
//   - swap difference = (entry quote − exit quote) + price shift at execution.
//
// Run: node test/costs.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { Costs, swapCostOf } = require('../src/costs');
const { createServer } = require('../src/server');
const { ADDR } = require('../src/chain');

const MEME = '0xa51afede7e27f4a38147aa378c7179de03cb5594';
const POOL = '0x' + 'ab'.repeat(32);
const POOL2 = '0x' + 'cd'.repeat(32);
const T0 = 1_700_000_000_000;
const ETH_USD = 2500;
// 100,000 gas × 1 gwei = 0.0001 ETH = $0.25 at $2500/ETH
const GAS = { used: 100_000, price: '1000000000', usd: 0.25 };

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function world() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-ongkos-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: ETH_USD, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', ADDR.usdg, 'USDG', 6);
  store.run('INSERT INTO tokens(address,symbol,decimals) VALUES(?,?,?)', MEME, 'MEME', 18);
  return { store, api: server.api };
}

const pos = (store, id, { pool = POOL, status = 'closed', cost = 200, out = 210, txOpen, txClose } = {}) => store.run(
  `INSERT INTO positions(id,venue,token_id,pool_ref,token0,token1,fee,status,opened_ts,closed_ts,
     cost_quote,out_quote,quote_symbol,tx_open,tx_close)
   VALUES(?,'v4',?,?,?,?,3000,?,?,?,?,?,'USDG',?,?)`,
  id, String(1000 + id), pool, ADDR.usdg, MEME, status, T0, status === 'closed' ? T0 + 300_000 : null,
  cost, status === 'closed' ? out : 0, txOpen ?? `0xmint${id}`, txClose ?? (status === 'closed' ? `0xburn${id}` : null));

const tx = (store, hash, ts, kind, detail, { gas = true, status = 'sukses', gasQuote = null } = {}) => store.run(
  'INSERT INTO txs(hash,ts,kind,status,gas_used,gas_price,gas_quote,detail) VALUES(?,?,?,?,?,?,?,?)',
  hash, ts, kind, status, gas ? GAS.used : null, gas ? GAS.price : null, gasQuote, detail ? JSON.stringify(detail) : null);

(async () => {
  console.log('position running cost');

  // ---- one whole position: approve + zap + mint, then burn + approve + leftover sale ----
  {
    const { store, api } = world();
    pos(store, 1);
    tx(store, '0xapprove1', T0 - 40_000, 'approve_kyber', null);                                   // before the zap
    tx(store, '0xzap1', T0 - 30_000, 'zap_swap', { pool: POOL, usdIn: 100, usdOut: 99.2 });
    tx(store, '0xmint1', T0, 'mint', { pool: POOL, recorded: 1, zapped: { hashes: ['0xzap1'] } });
    tx(store, '0xburn1', T0 + 300_000, 'burn', { position: 1 });
    tx(store, '0xapprove1b', T0 + 310_000, 'approve_kyber', null);                                 // before the leftover sale
    tx(store, '0xsell1', T0 + 320_000, 'sell_leftover', { position: 1, usdIn: 73.7, usdOut: 73.1, execSlipUsd: 0.1 });
    const c = new Costs(store).of(1, ETH_USD);

    await t('open phase: approve + zap + mint (3 txs), gas 3 × $0.25', () => {
      assert.equal(c.open.txN, 3);
      assert.ok(near(c.open.gasUsd, 3 * GAS.usd), `open gas ${c.open.gasUsd}`);
      assert.ok(near(c.open.slipUsd, 0.8), `open slip ${c.open.slipUsd}`);
    });
    await t('close phase: burn + approve + leftover sale, slip = route loss + execution shift', () => {
      assert.equal(c.close.txN, 3);
      assert.ok(near(c.close.gasUsd, 3 * GAS.usd), `close gas ${c.close.gasUsd}`);
      assert.ok(near(c.close.slipUsd, 0.7), `close slip ${c.close.slipUsd}`);   // 0.6 route + 0.1 execution
    });
    await t('leftover-sale slippage is already in position PnL, so only the zap counts as an outside cost', () => {
      assert.ok(near(c.outsideSlipUsd, 0.8), `outside slip ${c.outsideSlipUsd}`);   // the 0.8 zap, not the 0.7 sale
    });
    await t('total = gas + slippage, and its share of capital', async () => {
      assert.ok(near(c.totalUsd, 6 * GAS.usd + 1.5), `total ${c.totalUsd}`);
      const r = await api('GET', '/api/position', {}, { id: '1' });
      assert.ok(near(r.position.cost.totalUsd, c.totalUsd));
      assert.ok(near(r.position.cost.pctOfCost, (c.totalUsd / 200) * 100), `pct ${r.position.cost.pctOfCost}`);
    });
  }

  // ---- gas_quote: the ETH price AT THAT TIME, not the current price ----
  {
    const { store } = world();
    pos(store, 1, { status: 'open' });
    tx(store, '0xmint1', T0, 'mint', { recorded: 1 }, { gasQuote: 0.4 });
    const c = new Costs(store).of(1, ETH_USD);
    await t('gas already booked in USD is used as it is', () => {
      assert.ok(near(c.open.gasUsd, 0.4), `gas ${c.open.gasUsd}`);
    });
  }

  // ---- a failed transaction still burns gas ----
  {
    const { store } = world();
    pos(store, 1, { status: 'open' });
    tx(store, '0xmintGagal', T0 - 1000, 'mint', { plan: { positionId: 1 } }, { status: 'gagal' });
    tx(store, '0xmint1', T0, 'mint', { recorded: 1 });
    const c = new Costs(store).of(1, ETH_USD);
    await t('a mint that reverted is also counted: its gas is still lost', () => {
      assert.equal(c.open.txN, 2);
      assert.ok(near(c.open.gasUsd, 2 * GAS.usd), `gas ${c.open.gasUsd}`);
    });
  }

  // ---- a zap from a cancelled entry attempt is not charged to the next position ----
  {
    const { store } = world();
    pos(store, 2, { status: 'open', txOpen: '0xmint2' });
    tx(store, '0xzapBatal', T0 - 60_000, 'zap_swap', { pool: POOL, usdIn: 30, usdOut: 29 });
    tx(store, '0xzap2', T0 - 30_000, 'zap_swap', { pool: POOL, usdIn: 100, usdOut: 99 });
    tx(store, '0xmint2', T0, 'mint', { pool: POOL, recorded: 2, zapped: { hashes: ['0xzap2'] } });
    const c = new Costs(store).of(2, ETH_USD);
    await t('a mint that names its own zap: the zap of a cancelled entry is not included', () => {
      assert.equal(c.open.txN, 2);
      assert.ok(near(c.open.slipUsd, 1), `slip ${c.open.slipUsd}`);
    });
  }

  // ---- a zap in another pool does not leak ----
  {
    const { store } = world();
    pos(store, 3, { status: 'open', txOpen: '0xmint3' });
    tx(store, '0xzapPoolLain', T0 - 20_000, 'zap_swap', { pool: POOL2, usdIn: 50, usdOut: 45 });
    tx(store, '0xmint3', T0, 'mint', { pool: POOL, recorded: 3 });
    const c = new Costs(store).of(3, ETH_USD);
    await t('a zap in another pool is not this position\'s cost', () => {
      assert.equal(c.open.txN, 1);
      assert.ok(near(c.open.slipUsd, 0), `slip ${c.open.slipUsd}`);
    });
  }

  // ---- one leftover sale for two positions: split evenly ----
  {
    const { store } = world();
    pos(store, 4, { txClose: '0xburn4' });
    pos(store, 5, { txClose: '0xburn5' });
    tx(store, '0xmint4', T0, 'mint', { recorded: 4 });
    tx(store, '0xmint5', T0, 'mint', { recorded: 5 });
    tx(store, '0xburn4', T0 + 300_000, 'burn', { position: 4 });
    tx(store, '0xburn5', T0 + 300_000, 'burn', { position: 5 });
    tx(store, '0xsellGabung', T0 + 320_000, 'sell_leftover',
      { usdIn: 100, usdOut: 98, positionSales: [{ position: 4 }, { position: 5 }] });
    const costs = new Costs(store);
    await t('leftover sale of two positions: gas & difference split in two', () => {
      for (const id of [4, 5]) {
        const c = costs.of(id, ETH_USD);
        assert.ok(near(c.close.gasUsd, GAS.usd + GAS.usd / 2), `gas #${id} ${c.close.gasUsd}`);
        assert.ok(near(c.close.slipUsd, 1), `slip #${id} ${c.close.slipUsd}`);
      }
    });
  }

  // ---- fee claim & compound: costs, but not open/close costs ----
  {
    const { store } = world();
    pos(store, 6, { status: 'open' });
    tx(store, '0xmint6', T0, 'mint', { recorded: 6 });
    tx(store, '0xclaim6', T0 + 100_000, 'claim_fees', { position: 6 });
    const c = new Costs(store).of(6, ETH_USD);
    await t('fee claim goes into the "other" column, not open or close', () => {
      assert.equal(c.open.txN, 1); assert.equal(c.close.txN, 0); assert.equal(c.lain.txN, 1);
      assert.ok(near(c.totalUsd, 2 * GAS.usd));
    });
  }

  // ---- an orphan approve from a flow long before is not charged ----
  {
    const { store } = world();
    pos(store, 7, { status: 'open' });
    tx(store, '0xapproveYatim', T0 - 60 * 60_000, 'approve_kyber', null);   // an hour before the mint
    tx(store, '0xmint7', T0, 'mint', { recorded: 7 });
    const c = new Costs(store).of(7, ETH_USD);
    await t('an approve one hour before the mint: outside the window, not included', () => {
      assert.equal(c.open.txN, 1);
    });
  }

  // ---- copy attempts that never became a position are booked per target ----
  {
    const { store, api } = world();
    const TA = '0x' + 'aa'.repeat(20), TB = '0x' + 'bb'.repeat(20);
    pos(store, 8, { status: 'open' });
    tx(store, '0xmint8', T0, 'mint', { recorded: 8, target: TA });
    // Target A: zap, then the mint reverted, then the zap token was sold back.
    tx(store, '0xzapA', T0 + 100_000, 'zap_swap', { pool: POOL2, target: TA, usdIn: 50, usdOut: 49 });
    tx(store, '0xmintA', T0 + 110_000, 'mint', { pool: POOL2, target: TA, zapped: { hashes: ['0xzapA'] } }, { status: 'gagal' });
    tx(store, '0xsellA', T0 + 200_000, 'sell_leftover', { position: null, source: 'zap', target: TA, usdIn: 48, usdOut: 47.5 });
    // Target B: a zap whose entry died before any mint was sent.
    tx(store, '0xzapB', T0 + 300_000, 'zap_swap', { pool: POOL2, target: TB, usdIn: 20, usdOut: 19.5 });
    const costs = new Costs(store);
    const f = costs.failed(ETH_USD);
    await t('failed mint + its zap + the unwind sale are charged to that target', () => {
      const a = f.get(TA);
      assert.equal(a.attempts, 1);
      assert.equal(a.txN, 3);
      assert.ok(near(a.gasUsd, 3 * GAS.usd), `gas ${a.gasUsd}`);
      assert.ok(near(a.slipUsd, 1.5), `slip ${a.slipUsd}`);   // 1.0 zap + 0.5 sale
      assert.ok(near(a.totalUsd, 3 * GAS.usd + 1.5));
    });
    await t('a zap with no mint at all is also a failed copy of its target', () => {
      const b = f.get(TB);
      assert.equal(b.attempts, 0);
      assert.ok(near(b.totalUsd, GAS.usd + 0.5), `total ${b.totalUsd}`);
    });
    await t('the failed attempt is not charged to the position that did open', () => {
      const c = costs.of(8, ETH_USD);
      assert.equal(c.txN, 1);
    });
    await t('the targets list carries the per-target failed-copy cost', async () => {
      for (const a of [TA, TB]) store.run('INSERT INTO targets(address,label,added_ts) VALUES(?,?,?)', a, null, T0);
      const r = await api('GET', '/api/targets', {}, {});
      const row = (x) => (r.targets || r).find((y) => y.address === x);
      assert.ok(near(row(TA).ours.failedUsd, f.get(TA).totalUsd), JSON.stringify(row(TA).ours));
      assert.equal(row(TA).ours.failedAttempts, 1);
    });
    await t('per-target net = realised + running − position costs − failed-copy cost', async () => {
      const r = await api('GET', '/api/targets', {}, {});
      for (const row of r.targets || r) {
        const o = row.ours;
        if (!o) continue;
        assert.ok(near(o.net, o.realized + o.upnl - o.costUsd - o.failedUsd), JSON.stringify(o));
      }
    });
    await t('a swap quote whose input had no price is unmeasured, not a negative slippage', async () => {
      assert.deepEqual(swapCostOf({ usdIn: 0.0001, usdOut: 50 }), { route: 0, exec: 0 });
      assert.equal(swapCostOf({ usdIn: 100, usdOut: 99 }).route, 1);
      assert.equal(swapCostOf({ usdIn: 100, usdOut: 101 }).route, -1);   // a real small gain stays
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
