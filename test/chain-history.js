'use strict';
// On-chain history of adopted positions (src/chainhistory.js): the mint search, v3 event
// classification (fee = Collect − Decrease), and correcting the books with what happened before
// the adoption.
//
// Run: node test/chain-history.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { TOPIC } = require('../src/chain');
const { ChainHistory } = require('../src/chainhistory');
const m = require('../src/v3math');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${String(e.stack || e.message).split('\n').slice(0, 3).join('\n       ')}`); }
}

const NPM = '0x' + 'aa'.repeat(20);
const POOL = '0x' + 'bb'.repeat(20);
const USDG = '0x' + 'cc'.repeat(20);
const MEME = '0x' + 'dd'.repeat(20);
const ME = '0x' + 'ee'.repeat(20);
const ID = 77n;
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const idT = '0x' + word(ID);
const hx = (n) => '0x' + n.toString(16);
const log = (topic, block, tx, li, words) => ({ topics: [topic, idT], data: '0x' + words.map(word).join(''), blockNumber: hx(block), transactionHash: tx, logIndex: hx(li) });
const TX = { mint: '0x' + '1'.repeat(64), inc: '0x' + '2'.repeat(64), dec: '0x' + '3'.repeat(64), late: '0x' + '4'.repeat(64) };
const BLOCK_TS = (b) => 1_000_000 + b;      // seconds

function setup({ ownTx = null } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    blockNumber: async () => 5000,
    getLogs: async (f) => {
      if (f.topics[0] === TOPIC.transfer) {
        return Number(f.fromBlock) <= 100 && Number(f.toBlock) >= 100
          ? [{ topics: [TOPIC.transfer, '0x' + '0'.repeat(64), '0x' + word(ME), idT], blockNumber: hx(100), transactionHash: TX.mint, logIndex: '0x1' }] : [];
      }
      const all = [
        log(TOPIC.increaseLiq, 100, TX.mint, 2, [1000, 0, 50_000_000]),            // mint: 50 USDG
        log(TOPIC.increaseLiq, 200, TX.inc, 2, [500, 0, 25_000_000]),              // add: 25 USDG
        log(TOPIC.decreaseLiq, 300, TX.dec, 2, [300, 0, 10_000_000]),              // withdraw 10 USDG principal
        log(TOPIC.collectV3, 300, TX.dec, 3, [ME, 0, 12_000_000]),                 // collected 12 → 2 USDG fee
        log(TOPIC.collectV3, 4000, TX.late, 3, [ME, 0, 1_000_000]),                // after the adoption: 1 USDG fee
      ];
      return all.filter((l) => parseInt(l.blockNumber, 16) >= Number(f.fromBlock) && parseInt(l.blockNumber, 16) <= Number(f.toBlock));
    },
    batch: async (calls) => calls.map((c) => (c.method === 'eth_getBlockByNumber'
      ? { result: { timestamp: hx(BLOCK_TS(Number(c.params[0]))) } }
      : { result: { gasUsed: '0x5', effectiveGasPrice: '0x2' } })),
  };
  const chain = {
    network: 'robinhood', blockMs: 1000, ADDR: { posmV4: '0x' + '9'.repeat(40) },
    venues: [{ key: 'v3' }], isV3Venue: (v) => v === 'v3', npmFor: () => NPM,
    tokens: async (l) => l.map((a) => ({ address: a, decimals: a === USDG ? 6 : 18 })),
    // USDG side only, 1:1
    valueInQuote: ({ amount1 }) => ({ value: Number(amount1) / 1e6, symbol: 'USDG' }),
  };
  const research = { v3s: [{ venue: 'v3', priceAt: async () => ({ sqrt: m.getSqrtRatioAtTick(0) }) }] };
  // Adopted at block 1000 (in ms: BLOCK_TS(1000) * 1000), capital = value at adoption.
  store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,status,opened_ts,cost0,cost1,cost_quote,quote_symbol)
    VALUES('robinhood','v3',?,?,?,?,10000,-200,200,'1200','open',?,'0','60000000',60,'USDG')`, String(ID), POOL, MEME, USDG, BLOCK_TS(1000) * 1000);
  if (ownTx) store.run("INSERT INTO txs(chain,hash,ts,kind,status,detail) VALUES('robinhood',?,?,'claim_fees','sukses','{}')", ownTx, Date.now());
  const h = new ChainHistory({ rpc, store, chain, research, log: () => {} });
  return { store, h };
}

(async () => {
  console.log('chain history');

  await t('v3: mint, add, withdrawal and fee collect are read; the books get the real capital, withdrawals and fees', async () => {
    const { store, h } = setup();
    assert.strictEqual(await h.backfill(ME), 1);
    const rows = h.rowsOf(1).map((r) => [r.kind, r.hash, r.amount1, r.value_quote]);
    assert.deepStrictEqual(rows, [
      ['mint', TX.mint, '50000000', 50],
      ['increase', TX.inc, '25000000', 25],
      ['decrease', TX.dec, '10000000', 10],
      ['claim_fees', TX.dec, '2000000', 2],
      ['claim_fees', TX.late, '1000000', 1],
    ]);
    const p = store.get('SELECT * FROM positions WHERE id=1');
    assert.strictEqual(p.tx_open, TX.mint);
    assert.strictEqual(p.opened_ts, BLOCK_TS(100) * 1000, 'open time = the mint block');
    assert.strictEqual(p.cost_quote, 75, 'capital = mint + add at their prices, not the value at adoption');
    assert.strictEqual(p.cost1, '75000000');
    assert.strictEqual(p.out_quote, 10, 'the withdrawal before the adoption counts as proceeds');
    assert.strictEqual(p.claimed_quote, 2, 'only the fee collected BEFORE the adoption; the later one is the books\' own business');
    assert.strictEqual(h.rowsOf(1)[0].gas_wei, '10');
    // Read once: a second scan does nothing.
    assert.strictEqual(await h.backfill(ME), 0);
  });

  await t('a transaction the bot sent itself is not booked twice', async () => {
    const { h } = setup({ ownTx: TX.dec });
    await h.backfill(ME);
    assert.ok(!h.rowsOf(1).some((r) => r.hash === TX.dec));
  });

  await t('no mint within the window: marked, the books untouched, not searched again', async () => {
    const { store, h } = setup();
    h.maxDays = 0.0001;    // a few blocks: the mint at block 100 is out of reach
    assert.strictEqual(await h.backfill(ME), 0);
    assert.strictEqual(store.get('SELECT cost_quote, tx_open FROM positions WHERE id=1').cost_quote, 60);
    assert.deepStrictEqual(h.pending(), []);
  });

  await t('watch (v3): an add, a partial withdrawal and a fee collect outside the bot are booked once', async () => {
    const { store, h } = setup();
    // A bot-opened position: history not backfilled, only new blocks are watched.
    store.run("UPDATE positions SET tx_open=?, cost_quote=50, cost1='50000000'", TX.mint);
    store.setState('chain_watch_to:robinhood', 150);
    const liq = async () => 900n;
    assert.strictEqual(await h.watch(ME, { liquidityOf: liq }), 4);
    const p = store.get('SELECT * FROM positions WHERE id=1');
    assert.strictEqual(p.cost_quote, 75, 'the add raises the capital');
    assert.strictEqual(p.cost1, '75000000');
    assert.strictEqual(p.out_quote, 10, 'the partial withdrawal counts as proceeds');
    assert.strictEqual(p.claimed_quote, 3, 'both fee collects');
    assert.strictEqual(Number(store.getState('chain_watch_to:robinhood')), 5000);
    // The same blocks again (overlap): nothing is booked twice.
    store.setState('chain_watch_to:robinhood', 150);
    assert.strictEqual(await h.watch(ME, { liquidityOf: liq }), 0);
    assert.strictEqual(store.get('SELECT cost_quote FROM positions WHERE id=1').cost_quote, 75);
  });

  await t('watch: a position emptied on chain is left to the engine\'s close; unreadable liquidity retries the pass', async () => {
    const { store, h } = setup();
    store.run("UPDATE positions SET tx_open=?, cost_quote=50", TX.mint);
    store.setState('chain_watch_to:robinhood', 150);
    await assert.rejects(h.watch(ME, { liquidityOf: async () => null }), /tidak terbaca/);
    assert.strictEqual(Number(store.getState('chain_watch_to:robinhood')), 150, 'the window is not advanced');
    await h.watch(ME, { liquidityOf: async () => 0n });
    const p = store.get('SELECT * FROM positions WHERE id=1');
    assert.strictEqual(p.cost_quote, 50, 'nothing of the emptied position is booked here');
    assert.strictEqual(p.out_quote, 0);
  });

  await t('watch (v4): ModifyLiquidity matched by salt, amounts from the receipt; the bot\'s own tx is skipped', async () => {
    const store = new Store(':memory:');
    const PM = '0x' + '5'.repeat(40), POSM = '0x' + '6'.repeat(40), PID = '0x' + 'ab'.repeat(32);
    const TOKEN = 3855450n;
    const ml = (tx, delta, block) => ({
      address: PM, topics: [TOPIC.modifyLiquidity, PID, '0x' + word(POSM)], blockNumber: hx(block), transactionHash: tx, logIndex: '0x1',
      data: '0x' + [BigInt.asUintN(256, -200n), 200n, BigInt.asUintN(256, delta), TOKEN].map(word).join(''),
    });
    const ADD = '0x' + '7'.repeat(64), OWN = '0x' + '8'.repeat(64);
    const tr = (from, to, amt) => ({ address: USDG, topics: [TOPIC.transfer, '0x' + word(from), '0x' + word(to)], data: '0x' + word(amt) });
    const rpc = {
      blockNumber: async () => 5000,
      getLogs: async (f) => (f.address === PM ? [ml(ADD, 500n, 4000), ml(OWN, -100n, 4100)] : []),
      batch: async (calls) => calls.map((c) => {
        if (c.method === 'eth_getBlockByNumber') return { result: { timestamp: hx(BLOCK_TS(Number(c.params[0]))) } };
        if (c.params[0] === ADD) return { result: { gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [ml(ADD, 500n, 4000), tr(ME, PM, 20_000_000)] } };
        return { result: { gasUsed: '0x1', effectiveGasPrice: '0x1', logs: [] } };
      }),
    };
    const chain = {
      network: 'robinhood', blockMs: 1000, venues: [], ADDR: { poolManager: PM, posmV4: POSM, native: '0x' + '0'.repeat(40) },
      isV3Venue: () => false, tokens: async (l) => l.map((a) => ({ address: a, decimals: a === USDG ? 6 : 18 })),
      valueInQuote: ({ amount1 }) => ({ value: Number(amount1) / 1e6, symbol: 'USDG' }),
    };
    const research = { priceAt: async () => m.getSqrtRatioAtTick(0) };
    store.run(`INSERT INTO positions(chain,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,liquidity,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open)
      VALUES('robinhood','v4',?,?,?,?,10000,-200,200,'1000','open',1,'0','10000000',10,'USDG','0xmint')`, String(TOKEN), PID, MEME, USDG);
    store.run("INSERT INTO txs(chain,hash,ts,kind,status,detail) VALUES('robinhood',?,1,'decrease','sukses','{}')", OWN);
    store.setState('chain_watch_to:robinhood', 3000);
    const h = new ChainHistory({ rpc, store, chain, research, log: () => {} });
    assert.strictEqual(await h.watch(ME, { liquidityOf: async () => 1400n }), 1);
    const p = store.get('SELECT cost_quote, cost1 FROM positions WHERE id=1');
    assert.strictEqual(p.cost_quote, 30);
    assert.strictEqual(p.cost1, '30000000');
    assert.deepStrictEqual(h.rowsOf(1).map((r) => [r.kind, r.hash]), [['increase', ADD]]);
  });

  await t('a burned v3 NFT ("Invalid token ID" revert) is confirmed empty; any other failure is not', async () => {
    const { Positions } = require('../src/positions');
    let reply = { error: { message: 'execution reverted: Invalid token ID' } };
    const rpc = { batch: async (calls) => calls.map(() => reply), ethCallMany: async (c) => c.map(() => null) };
    const chain = { network: 'robinhood', npmFor: () => NPM, ADDR: {} };
    const p = new Positions({ rpc, store: new Store(':memory:'), chain, log: () => {} });
    const pos = { venue: 'v3', token_id: '77', opened_ts: 1, tx_open: '0xmint' };
    assert.strictEqual(await p.confirmEmpty(pos), true);
    reply = { error: { message: 'header not found' } };
    assert.strictEqual(await p.confirmEmpty(pos), false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
