'use strict';
// Test the wallet capital tracker (capital.js): baseline, deposit/withdrawal classification,
// and net PnL = value − capital.
//
// Real case: capital deposited 0.1552 ETH (~$381) + starting wallet ~$20 → ~$401; the dashboard
// said "capital $447" because capital was derived from per-position PnL (value − PnL), which
// does not include zap/gas/swap costs. The owner counts "400 → 520 = profit 120".
//
// The data source is public RPC: Transfer logs for USDG/WETH, balance differences for plain
// ETH (no logs). It used to be alchemy_getAssetTransfers — it stopped when the quota ran out.
//
// Run: node test/capital.js
const assert = require('node:assert');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { Capital } = require('../src/capital');
const { ADDR } = require('../src/chain');

const W = '0x' + '11'.repeat(20);
const EOA = '0x' + '22'.repeat(20);
const CONTRACT = '0x' + '33'.repeat(20);
const KYBER = '0x' + '44'.repeat(20);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-3 + 1e-6, `${msg}: ${a} vs ${b}`);
const hex = (n) => '0x' + BigInt(n).toString(16);
const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const topic = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const TRANSFER = ethers.id('Transfer(address,address,uint256)');

// Fake world: block 1000 = ts 1,000,000 s; starting wallet 0.002 ETH + 12 USDG; ETH $2500.
// `logs`: token transfers; `eth`: ETH balance per block (a block without an entry = the previous
// block's balance); `ourBlocks`: blocks where the bot's txs landed; `blockTxs`: block contents (wallet
// txs that are not bot txs) — without it, the leftover difference is treated as an internal transfer.
function world({ logs = [], senders = {}, code = {}, eth = {}, ourBlocks = {}, blockTxs = {}, batchEth = null, flatEquity = false } = {}) {
  const store = new Store(':memory:');
  store.run("INSERT INTO txs(hash,ts,kind,status) VALUES('0xown',1,'burn','sukses')");
  for (const [h, b] of Object.entries(ourBlocks)) store.run("INSERT INTO txs(hash,ts,kind,status) VALUES(?,?,'mint','sukses')", h, b * 1000 * 1000);
  store.run('INSERT INTO equity(ts,total_quote) VALUES(?,0)', 1000 * 1000 * 1000);   // the bot starts recording at block 1000
  const balAt = (n) => { let v = 2n * 10n ** 15n; for (const b of Object.keys(eth).map(Number).sort((a, c) => a - c)) if (b <= n) v = BigInt(eth[b]); return v; };
  // Equity snapshots as the bot takes them from the live balance: a step at every real balance change
  // (`flatEquity`: the wallet value does not move at all, whatever the archive reads claim).
  const eqUsd = (n) => Number(balAt(flatEquity ? 1000 : n)) / 1e18 * 2500;
  for (const b of Object.keys(eth).map(Number)) {
    store.run('INSERT OR IGNORE INTO equity(ts,total_quote) VALUES(?,?)', b * 1000 * 1000 - 1, eqUsd(b - 1));
    store.run('INSERT OR IGNORE INTO equity(ts,total_quote) VALUES(?,?)', b * 1000 * 1000 + 1, eqUsd(b));
  }
  store.run('INSERT OR IGNORE INTO equity(ts,total_quote) VALUES(?,?)', 2000 * 1000 * 1000, eqUsd(2000));
  const one = async (method, params) => {
    if (method === 'eth_getBlockByNumber') return { timestamp: hex(parseInt(params[0], 16) * 1000), transactions: params[1] ? (blockTxs[parseInt(params[0], 16)] || []).map((t) => ({ ...t, value: hex(t.value || 0) })) : [] };
    if (method === 'eth_getTransactionByHash') return { from: senders[params[0]] || EOA };
    if (method === 'eth_getTransactionReceipt') return ourBlocks[params[0]] ? { blockNumber: hex(ourBlocks[params[0]]) } : null;
    if (method === 'eth_getCode') return code[params[0]] ? '0x6080' : '0x';
    if (method === 'eth_getBalance') return hex(balAt(parseInt(params[1], 16)));
    throw new Error('rpc ' + method);
  };
  // `batchEth`: balance override that only the batched reads see (an archive node answering inconsistently).
  const rpc = {
    blockNumber: async () => 2005,
    hasArchive: () => true,
    call: one,
    batch: async (calls) => Promise.all(calls.map(async (c) => { try {
      if (batchEth && c.method === 'eth_getBalance') return { result: hex(batchEth(parseInt(c.params[1], 16), balAt(parseInt(c.params[1], 16)))) };
      return { result: await one(c.method, c.params) }; } catch (e) { return { error: { message: e.message } }; } })),
    callAt: async (to) => word(to === ADDR.usdg ? 12_000_000 : 0),
    getLogs: async (f) => logs.filter((l) => f.address.includes(l.address) && (f.topics[1] == null || l.topics[1] === f.topics[1]) && (f.topics[2] == null || l.topics[2] === f.topics[2])
      && parseInt(l.blockNumber, 16) >= parseInt(f.fromBlock, 16) && parseInt(l.blockNumber, 16) <= parseInt(f.toBlock, 16)),
  };
  const chain = { ethUsdAt: async () => 2500 };
  const cap = new Capital({ rpc, store, chain, cfg: {}, log: () => {} });
  return { store, cap };
}
let li = 0;
const tr = ({ dir, asset = ADDR.usdg, value, block = 1500, hash, cp = EOA }) => ({
  address: asset, transactionHash: hash, blockNumber: hex(block), logIndex: hex(li++), data: word(value),
  topics: [TRANSFER, topic(dir === 'in' ? cp : W), topic(dir === 'in' ? W : cp)],
});

(async () => {
  await t('baseline: cash at the starting block + existing positions (adoption)', async () => {
    const d = world();
    d.store.run(`INSERT INTO positions(venue,pool_ref,status,opened_ts,cost_quote,quote_symbol) VALUES('v4','p','closed',?,12.46,'USDG')`, 900 * 1000 * 1000);
    d.store.run(`INSERT INTO positions(venue,pool_ref,status,opened_ts,cost_quote,quote_symbol) VALUES('v4','p','open',?,200,'USDG')`, 1500 * 1000 * 1000);
    const b = await d.cap.baseline(W);
    assert.strictEqual(b.block, 1000);
    near(b.cashUsd, 12 + 0.002 * 2500, 'kas awal');
    near(b.positionsUsd, 12.46, 'hanya posisi yang sudah terbuka saat itu');
    near(d.cap.capitalAt(), b.usd, 'modal = baseline tanpa setoran');
  });

  await t('plain ETH deposit = the balance difference not explained by bot txs; own swap results & bot txs are skipped', async () => {
    const d = world({
      logs: [
        tr({ dir: 'in', value: 200_000_000, hash: '0xown', cp: ADDR.poolManager }), // position close proceeds (bot tx)
        tr({ dir: 'in', value: 17_000_000, hash: '0xswap', cp: KYBER }),           // manual swap proceeds (we are the sender)
      ],
      senders: { '0xswap': W },
      // block 1300: bot tx pays gas 0.0001 ETH; block 1500: deposit of 0.12 ETH from outside
      eth: { 1300: 19n * 10n ** 14n, 1500: 19n * 10n ** 14n + 12n * 10n ** 16n },
      ourBlocks: { '0xgas': 1300 },
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'deposit'); assert.strictEqual(rows[0].symbol, 'ETH');
    assert.strictEqual(rows[0].amount, String(12n * 10n ** 16n));
    near(rows[0].usd, 0.12 * 2500, 'usd setoran');
    const s = d.cap.summary();
    near(s.depositsUsd, 300, 'total setoran');
    near(s.capitalUsd, s.baselineUsd + 300, 'modal');
  });

  await t('ETH balance jump that a fresh read does not confirm is not recorded as a deposit', async () => {
    const d = world({
      eth: {},
      ourBlocks: { '0xgas': 1300 },
      batchEth: (n, v) => (n >= 1500 ? v + 12n * 10n ** 16n : v),   // only the batched reads show +0.12 ETH from block 1500
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 0);
    assert.strictEqual(d.cap.rows().length, 0);
  });

  await t('ETH deposit that the equity curve never shows is not recorded, even when every read agrees', async () => {
    const d = world({
      eth: { 1500: 2n * 10n ** 15n + 12n * 10n ** 16n },   // +0.12 ETH on chain reads, but the live wallet value stayed flat
      flatEquity: true,
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 0);
    assert.strictEqual(d.cap.rows().length, 0);
  });

  await t('ETH deposit waits for the first equity snapshot after its block', async () => {
    const d = world({ eth: { 1500: 2n * 10n ** 15n + 12n * 10n ** 16n } });
    d.store.run('DELETE FROM equity WHERE ts > ?', 1500 * 1000 * 1000);
    assert.strictEqual((await d.cap.sync(W)).added, 0);
    d.store.run('INSERT INTO equity(ts,total_quote) VALUES(?,?)', 1600 * 1000 * 1000, 0.1222e0 * 2500);
    assert.strictEqual((await d.cap.sync(W)).added, 1);
  });

  await t('USDG deposit from an EOA is recorded with its block & time', async () => {
    const d = world({ logs: [tr({ dir: 'in', value: 1_085_913_914, hash: '0xdep', block: 1700 })] });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.kind, 'deposit'); assert.strictEqual(row.block, 1700); assert.strictEqual(row.ts, 1700 * 1000 * 1000);
    near(row.usd, 1085.91, 'usd'); assert.strictEqual(row.counterparty, EOA);
  });

  await t('outgoing: to a contract (swap/LP) is not a withdrawal; to an EOA that we sent = withdrawal', async () => {
    const d = world({
      logs: [
        tr({ dir: 'out', value: 50_000_000, hash: '0xlp', cp: ADDR.poolManager }),
        tr({ dir: 'out', value: 30_000_000, hash: '0xsw', cp: CONTRACT }),
        tr({ dir: 'out', value: 5_000_000, hash: '0xpull', cp: EOA }),   // withdrawn by someone else (we are not the sender)
      ],
      senders: { '0xlp': W, '0xsw': W, '0xpull': CONTRACT },
      code: { [CONTRACT]: true },
      eth: { 1600: 1n * 10n ** 15n },   // 0.001 ETH sent out manually
    });
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const rows = d.cap.rows();
    assert.strictEqual(rows[0].kind, 'withdraw'); assert.strictEqual(rows[0].symbol, 'ETH'); near(rows[0].usd, 2.5, 'usd penarikan');
    near(d.cap.summary().capitalUsd, d.cap.summary().baselineUsd - 2.5, 'modal berkurang');
  });

  await t('re-sync does not double count; capital at time t only contains deposits up to t', async () => {
    const d = world({ logs: [tr({ dir: 'in', value: 250_000_000, hash: '0xa', block: 1200 }), tr({ dir: 'in', value: 250_000_000, hash: '0xb', block: 1800 })] });
    await d.cap.sync(W);
    d.store.setState('deposits_scanned_to:robinhood', '1000');  // force a rescan of the same range
    await d.cap.sync(W);
    assert.strictEqual(d.cap.rows().length, 2);
    const base = d.cap.summary().baselineUsd;
    near(d.cap.capitalAt(1500 * 1000 * 1000), base + 250, 'setelah setoran pertama saja');
    near(d.cap.capitalAt(), base + 500, 'sekarang');
  });

  await t('ETH balance difference: starting point from the old cursor (database of the Alchemy version), does not recompute the window already passed', async () => {
    const d = world({ eth: { 1200: 5n * 10n ** 17n, 1900: 6n * 10n ** 17n } });
    await d.cap.baseline(W);
    d.store.setState('deposits_scanned_to:robinhood', '1500');   // Alchemy had scanned up to 1500
    d.store.setState('capital_eth_checkpoint:robinhood', null); d.store.run("DELETE FROM state WHERE k='capital_eth_checkpoint:robinhood'");
    const r = await d.cap.sync(W);
    assert.strictEqual(r.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.amount, String(1n * 10n ** 17n), 'only the increase after block 1500');
    assert.strictEqual(row.tx_hash, 'eth:1900', 'the block where the balance changed');
    assert.strictEqual((await d.cap.sync(W)).added, 0, 'empty window: nothing new');
  });

  await t('RPC error in the middle of a window: nothing is recorded, the cursor does not advance', async () => {
    const d = world({ logs: [tr({ dir: 'in', value: 250_000_000, hash: '0xa' })], eth: { 1500: 1n * 10n ** 18n } });
    await d.cap.baseline(W);
    const { call, batch } = d.cap.rpc;
    d.cap.rpc.call = async (m, p) => { if (m === 'eth_getBalance') throw new Error('historical state unavailable'); return call(m, p); };
    d.cap.rpc.batch = async (calls) => { if (calls.some((c) => c.method === 'eth_getBalance')) throw new Error('historical state unavailable'); return batch(calls); };
    await assert.rejects(d.cap.sync(W), /historical state/);
    assert.strictEqual(d.cap.rows().length, 1, 'the token deposit is still recorded (its cursor is separate)');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 1000, 'ETH starting point is still at the baseline');
    d.cap.rpc.call = call; d.cap.rpc.batch = batch;
    assert.strictEqual((await d.cap.sync(W)).added, 1);
    assert.strictEqual(d.cap.rows().length, 2);
  });

  await t('a piled-up window is paid in instalments: at most 25 tx blocks per sync, deposits in between are still found', async () => {
    const ourBlocks = {}; const eth = {};
    let bal = 2n * 10n ** 15n;
    for (let i = 0; i < 50; i++) { const b = 1100 + i * 10; ourBlocks['0xtx' + i] = b; bal -= 10n ** 12n; eth[b] = bal; }   // 50 bot txs, each tx gas 0.000001 ETH
    // deposit of 0.3 ETH at block 1345 (between the 25th and 26th tx: outside the first instalment)
    for (let i = 0; i < 50; i++) { const b = 1100 + i * 10; if (b > 1345) eth[b] += 3n * 10n ** 17n; }
    eth[1345] = eth[1340] + 3n * 10n ** 17n;
    const d = world({ eth, ourBlocks });
    const r1 = await d.cap.sync(W);
    const ck1 = JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood'));
    assert.strictEqual(ck1.block, 1100 + 24 * 10, 'berhenti di blok tx ke-25');
    assert.strictEqual(r1.added, 0, 'the deposit has not entered the first window');
    const r2 = await d.cap.sync(W);
    assert.strictEqual(r2.added, 1);
    const [row] = d.cap.rows();
    assert.strictEqual(row.amount, String(3n * 10n ** 17n), 'the deposit is found in the second instalment, the bot tx gas is not included');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 2000);
  });

  await t('manual ETH: to the router (contract) = swap, not a withdrawal; to an EOA = withdrawal; from an EOA = deposit; unwrap WETH is not a withdrawal', async () => {
    const ROUTER = '0x' + '55'.repeat(20);
    const d = world({
      eth: { 1300: 2n * 10n ** 15n - 4n * 10n ** 14n, 1500: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n, 1700: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n + 6n * 10n ** 14n, 1800: 2n * 10n ** 15n - 4n * 10n ** 14n - 2n * 10n ** 14n + 6n * 10n ** 14n + 1n * 10n ** 14n },
      blockTxs: {
        1300: [{ hash: '0xswap', from: W, to: ROUTER, value: 4n * 10n ** 14n }],          // manual swap 0.0004 ETH via the router
        1500: [{ hash: '0xsend', from: W, to: EOA, value: 2n * 10n ** 14n }],             // send 0.0002 ETH to someone
        1700: [{ hash: '0xrecv', from: EOA, to: W, value: 6n * 10n ** 14n }],             // receive 0.0006 ETH
        1800: [{ hash: '0xunwrap', from: W, to: ADDR.weth, value: 0 }],                   // unwrap WETH: ETH increases by 0.0001
      },
      logs: [tr({ dir: 'out', asset: ADDR.weth, value: 1n * 10n ** 14n, hash: '0xunwrap', block: 1800, cp: '0x' + '0'.repeat(40) })],
      senders: { '0xunwrap': W },
      code: { [ROUTER]: true },
    });
    const r = await d.cap.sync(W);
    const rows = d.cap.rows().map((x) => [x.kind, x.symbol, x.tx_hash, x.amount]);
    assert.deepStrictEqual(rows, [['withdraw', 'ETH', '0xsend', String(2n * 10n ** 14n)], ['deposit', 'ETH', '0xrecv', String(6n * 10n ** 14n)]]);
    assert.strictEqual(r.added, 2);
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 1700, 'tiga titik per sync: berhenti di titik ketiga');
    assert.strictEqual(d.cap.backlog, true);
    assert.strictEqual((await d.cap.sync(W)).added, 0, 'unwrap: not a withdrawal, not a deposit');
    assert.strictEqual(JSON.parse(d.store.getState('capital_eth_checkpoint:robinhood')).block, 2000);
    assert.strictEqual(d.cap.backlog, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
