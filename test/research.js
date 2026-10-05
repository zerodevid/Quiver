'use strict';
// Test wallet research, specifically the Uniswap v3 path.
//
// Only the chain is faked; WalletResearch and WalletV3 are real. The most important test
// here is the cheapest: a wallet that has NO v4 positions at all must still
// be read if it LPs on v3. It used not to be — scan() exited early as soon as the
// v4 position list was empty, so the v3 wallet research page was always empty.
//
// Run: node test/research.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { WalletResearch } = require('../src/wallet');
const { WalletV3 } = require('../src/walletv3');
const { ADDR, TOPIC, ABI } = require('../src/chain');
const { ethers } = require('ethers');
const mm = require('../src/v3math');

const IF_NPM = new ethers.Interface(ABI.npmV3);
const W = '0x54e29aac8ed96c56463b18027c676d09b5c0be98';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0xdddddddddddddddddddddddddddddddddddddddd';
const HEAD = 1_000_000;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}

const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const idTopic = (id) => '0x' + BigInt(id).toString(16).padStart(64, '0');
const w = (n) => BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');

const xfer = (id, from, to, block) => ({
  address: ADDR.npmV3, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
  transactionHash: '0x' + block.toString(16).padStart(64, '0'),
  topics: [TOPIC.transfer, pad32(from), pad32(to), idTopic(id)], data: '0x',
});
const ev = (kind, id, { liq = 0, a0 = 0, a1 = 0, block }) => ({
  address: ADDR.npmV3, blockNumber: '0x' + block.toString(16), logIndex: '0x1',
  transactionHash: '0x' + (block + 1).toString(16).padStart(64, '0'),
  topics: [{ increase: TOPIC.increaseLiq, decrease: TOPIC.decreaseLiq, collect: TOPIC.collectV3 }[kind], idTopic(id)],
  data: '0x' + w(kind === 'collect' ? 0 : liq) + w(a0) + w(a1),
});

function world({ logs = [], posisi: position = {}, owed = {}, archived = null, receipts = {} } = {}) {
  const store = new Store(':memory:');
  const SQRT = mm.getSqrtRatioAtTick(0);
  const meta = {
    [ADDR.usdg]: { address: ADDR.usdg, symbol: 'USDG', decimals: 6 },
    [MEME]: { address: MEME, symbol: 'MEME', decimals: 18 },
  };
  const rpc = {
    blockNumber: async () => HEAD,
    call: async (m, p) => (m === 'eth_getTransactionReceipt' ? receipts[p[0]] || null : null),
    hasArchive: () => archived != null,
    callAt: async () => (archived == null ? '0x'
      : ethers.AbiCoder.defaultAbiCoder().encode(['uint160','int24','uint16','uint16','uint16','uint8','bool'], [archived, 0, 0, 0, 0, 0, true])),
    getLogs: async (f) => {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      const match = (worth, condition) => condition == null || (Array.isArray(condition) ? condition.includes(worth) : condition === worth);
      return logs.filter((l) => {
        if (f.address && String(f.address).toLowerCase() !== l.address.toLowerCase()) return false;
        const b = parseInt(l.blockNumber, 16);
        if (b < from || b > to) return false;
        return (f.topics || []).every((s, i) => match(l.topics[i], s));
      });
    },
    ethCallMany: async (calls) => calls.map((c) => {
      // token0() / token1() / fee() on the pool contract
      if (c.data === '0x0dfe1681') return pad32(ADDR.usdg);
      if (c.data === '0xd21220a7') return pad32(MEME);
      if (c.data === '0xddca3f43') return '0x' + w(10000);
      // positions(tokenId)
      const id = BigInt('0x' + c.data.slice(10)).toString();
      const p = position[id];
      if (!p) return '0x';
      return IF_NPM.encodeFunctionResult('positions', [
        0, ADDR.native, p.token0, p.token1, p.fee, p.tickLower, p.tickUpper, p.liquidity, 0, 0, 0, 0]);
    }),
    // collect((tokenId, recipient, max0, max1)) — a static tuple, so tokenId is in the
    // FIRST word of the calldata after the selector.
    batch: async (calls) => calls.map((c) => {
      const id = BigInt('0x' + c.params[0].data.slice(10, 10 + 64)).toString();
      const o = owed[id] || { fee0: 0n, fee1: 0n };
      return { result: '0x' + w(o.fee0) + w(o.fee1) };
    }),
  };
  const chain = {
    tokens: async (l) => l.map((a) => meta[String(a).toLowerCase()] || { address: a, symbol: '?', decimals: 18 }),
    poolV3Addr: async () => POOL,
    slot0V3: async () => ({ sqrtPriceX96: SQRT, tick: 0 }),
    blockTs: async (b) => b * 101,
    quoteSideOf(t0, t1) {
      const q = { [ADDR.usdg]: { symbol: 'USDG', decimals: 6, kind: 'usd' } };
      if (q[String(t0).toLowerCase()]) return { side: 0, ...q[String(t0).toLowerCase()] };
      if (q[String(t1).toLowerCase()]) return { side: 1, ...q[String(t1).toLowerCase()] };
      return null;
    },
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      if (!q) return null;
      const p1per0 = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p1per0 : a1 + a0 * p1per0, symbol: q.symbol, side: q.side, kind: q.kind };
    },
  };
  return { store, rpc, chain };
}

// One position fully closed: entered 1 USDG, withdrew principal 1 USDG, received 1.1 USDG.
// The difference (0.1) is fee. All on the quote side, so the value can be computed in your head.
const CLOSED = [
  xfer(7, '0x0', W, 100),
  ev('increase', 7, { liq: 5000, a0: 1_000_000, block: 110 }),
  ev('decrease', 7, { liq: 5000, a0: 1_000_000, block: 200 }),
  ev('collect', 7, { a0: 1_100_000, block: 201 }),
  xfer(7, W, '0x0', 210),
];
const CLOSED_POSITIONS = { 7: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 0n } };

(async () => {
  console.log('wallet research (v3)\n');

  await t('fee is separated from principal: Collect − Decrease', async () => {
    const d = world({ logs: CLOSED, posisi: CLOSED_POSITIONS });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.ok(p, 'the position must be readable');
    assert.strictEqual(p.venue, 'v3');
    assert.strictEqual(p.agg.in0, 1_000_000n);
    assert.strictEqual(p.agg.out0, 1_000_000n, 'Decrease is the principal');
    assert.strictEqual(p.agg.fee0, 100_000n, 'fee = what was received − the principal waiting');
    assert.ok(Math.abs(p.investedQ - 1) < 1e-9, `capital ${p.investedQ}`);
    assert.ok(Math.abs(p.returnedQ - 1.1) < 1e-9, `kembali ${p.returnedQ}`);
    assert.ok(Math.abs(p.feesQ - 0.1) < 1e-9, `fee ${p.feesQ}`);
    assert.ok(Math.abs(p.pnlQ - 0.1) < 1e-9, `pnl ${p.pnlQ}`);
    assert.strictEqual(p.status, 'closed');
  });

  await t('a fee claim without a withdrawal is read in full as fee', async () => {
    const logs = [
      xfer(8, '0x0', W, 100),
      ev('increase', 8, { liq: 5000, a0: 1_000_000, block: 110 }),
      ev('collect', 8, { a0: 250_000, block: 150 }),      // pure fee, no Decrease
    ];
    const d = world({ logs, posisi: { 8: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.agg.fee0, 250_000n, 'without waiting principal, the whole Collect is fee');
    assert.ok(Math.abs(p.feesQ - 0.25) < 1e-9, `fee ${p.feesQ}`);
    assert.strictEqual(p.status, 'open', 'still held and still has liquidity');
  });

  await t('a still-alive position is valued at the current price', async () => {
    const logs = [xfer(9, '0x0', W, 100), ev('increase', 9, { liq: 10n ** 12n, a0: 1_000_000, block: 110 })];
    const position = { 9: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n } };
    const d = world({ logs, posisi: position, owed: { 9: { fee0: 50_000n, fee1: 0n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.status, 'open');
    assert.strictEqual(p.inRange, true, 'price in the middle of the range');
    assert.ok(p.liveValueQ > 0, 'a live position must have a value');
    assert.ok(Math.abs(p.liveFeeQ - 0.05) < 1e-9, `fee berjalan ${p.liveFeeQ}`);
    // open position pnl = value + running fees + what was already withdrawn − capital
    assert.ok(Math.abs(p.pnlQ - (p.liveValueQ + p.liveFeeQ + p.returnedQ - p.investedQ)) < 1e-9);
  });

  await t('the price at the event block is used if available; if not, flagged as an estimate', async () => {
    const SQRT = mm.getSqrtRatioAtTick(0);
    const swap = (block) => ({
      address: POOL, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
      transactionHash: '0x' + block.toString(16).padStart(64, '0'),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(SQRT) + w(0) + w(0),
    });
    const base = [
      xfer(11, '0x0', W, 100),
      // both sides filled: the speculative side can ONLY be valued if its price is readable
      ev('increase', 11, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }),
    ];
    const position = { 11: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };

    const without = new WalletV3({ ...world({ logs: base, posisi: position }), log: () => {} });
    const [a] = await without.scan(W, { from: 0, head: HEAD });
    assert.ok(Math.abs(a.investedQ - 1) < 1e-9, `without a price, only the quote side is counted: ${a.investedQ}`);
    assert.strictEqual(a.incomplete, true, 'must be flagged as an estimate');

    const dengan = new WalletV3({ ...world({ logs: [...base, swap(111)], posisi: position }), log: () => {} });
    const [b] = await dengan.scan(W, { from: 0, head: HEAD });
    assert.ok(b.investedQ > 1, `with a price, the speculative side is counted too: ${b.investedQ}`);
    assert.strictEqual(b.incomplete, false, 'need not be flagged if the price is readable');
  });

  await t('the price from the Swap log is used even though the archive node answers differently', async () => {
    // Measured on the real chain: the archive answered 4.7x off from three Swaps that
    // agreed, then a few minutes later rejected that block altogether. The event log
    // is part of its own block — it wins.
    const SQRT = mm.getSqrtRatioAtTick(0);
    const swap = (block, sq) => ({
      address: POOL, blockNumber: '0x' + block.toString(16), logIndex: '0x0',
      transactionHash: '0x' + block.toString(16).padStart(64, '0'),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(sq) + w(0) + w(0),
    });
    const logs = [
      xfer(12, '0x0', W, 100),
      ev('increase', 12, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }),
      swap(109, SQRT),
    ];
    const position = { 12: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };
    // the archive deliberately answers a very different price
    const d = world({ logs, posisi: position, archived: SQRT * 5n });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    const stored = d.store.get('SELECT sqrt_price, src_block FROM wprices WHERE pool_ref=? AND block=?', POOL, 110);
    assert.strictEqual(stored.sqrt_price, SQRT.toString(), 'the price must come from the Swap log, not from the archive');
    assert.strictEqual(stored.src_block, 109, 'sumbernya blok Swap-nya');
    assert.strictEqual(p.incomplete, false, 'a Swap 1 block from the event is not an estimate');
  });

  await t('a price from a distant Swap is flagged as an estimate', async () => {
    const SQRT = mm.getSqrtRatioAtTick(0);
    const far = {
      address: POOL, blockNumber: '0x' + (110 + 5000).toString(16), logIndex: '0x0',
      transactionHash: '0x' + 'ab'.repeat(32),
      topics: [TOPIC.swapV3, pad32(W), pad32(W)],
      data: '0x' + w(0) + w(0) + w(SQRT) + w(0) + w(0),
    };
    const logs = [xfer(13, '0x0', W, 100), ev('increase', 13, { liq: 5000, a0: 1_000_000, a1: 10n ** 18n, block: 110 }), far];
    const position = { 13: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } };
    const v3 = new WalletV3({ ...world({ logs, posisi: position }), log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.incomplete, true, 'a Swap 5,000 blocks away (~8 minutes) must be flagged as an estimate');
  });

  await t('an NFT that changed hands then came back still counts as ours', async () => {
    const logs = [
      xfer(7, '0x0', W, 100),
      ev('increase', 7, { liq: 5000, a0: 1_000_000, block: 110 }),
      xfer(7, W, '0x00000000000000000000000000000000000000aa', 120),
      xfer(7, '0x00000000000000000000000000000000000000aa', W, 130),
    ];
    const d = world({ logs, posisi: { 7: { token0: ADDR.usdg, token1: MEME, fee: 10000, tickLower: -600, tickUpper: 600, liquidity: 5000n } } });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.strictEqual(p.status, 'open', 'the LAST Transfer determines ownership');
  });

  await t('a position whose NFT has been burned still enters the history', async () => {
    // positions() no longer answers, but its opening transaction still emits
    // Mint on the pool contract: the log address is the pool, its tick is in the topics.
    // ev() gives each event tx = hex(block + 1); use the same formula
    const txOpen = '0x' + (110 + 1).toString(16).padStart(64, '0');
    const logs = [
      xfer(21, '0x0', W, 100),
      ev('increase', 21, { liq: 5000, a0: 1_000_000, block: 110 }),
      ev('decrease', 21, { liq: 5000, a0: 1_000_000, block: 200 }),
      ev('collect', 21, { a0: 1_150_000, block: 201 }),
      xfer(21, W, '0x0', 205),                       // burned
    ];
    const receipts = {
      [txOpen]: { logs: [{
        address: POOL,
        topics: [TOPIC.mintV3Pool, pad32(ADDR.npmV3), idTopic(-600 & 0xffffff), idTopic(600)],
      }] },
    };
    // deliberately NOT in `posisi`: positions() would answer '0x'
    const d = world({ logs, posisi: {}, receipts });
    const v3 = new WalletV3({ ...d, log: () => {} });
    const [p] = await v3.scan(W, { from: 0, head: HEAD });
    assert.ok(p, 'a burned position must still be readable');
    assert.strictEqual(p.status, 'closed');
    assert.strictEqual(p.poolId, POOL, 'pool address recovered from the Mint log');
    assert.strictEqual(p.tickUpper, 600, 'tick recovered from the Mint log topic');
    assert.ok(Math.abs(p.investedQ - 1) < 1e-9, `capital ${p.investedQ}`);
    assert.ok(Math.abs(p.feesQ - 0.15) < 1e-9, `fee ${p.feesQ}`);
    assert.ok(Math.abs(p.pnlQ - 0.15) < 1e-9, `pnl ${p.pnlQ}`);
  });

  await t('REGRESSION: a wallet without any v4 positions is still read from v3', async () => {
    const d = world({ logs: CLOSED, posisi: CLOSED_POSITIONS });
    const res = new WalletResearch({ ...d, log: () => {} });
    const r = await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    assert.strictEqual(r.positions.length, 1, 'the v3 position must be included even if v4 is empty');
    assert.strictEqual(r.positions[0].venue, 'v3');
    // and really stored, not just returned
    const row = d.store.all('SELECT * FROM wpositions WHERE wallet=?', W);
    assert.strictEqual(row.length, 1);
    assert.strictEqual(row[0].venue, 'v3');
    assert.strictEqual(row[0].token0, ADDR.usdg);
    assert.strictEqual(row[0].fee, 10000);
    assert.ok(d.store.all('SELECT * FROM wevents WHERE wallet=?', W).length >= 3, 'its events are also stored');
    const stats = JSON.parse(d.store.get('SELECT stats FROM wallets WHERE address=?', W).stats);
    assert.strictEqual(stats.positionsTotal, 1);
  });

  await t('REGRESSION: the incremental update also reads v3', async () => {
    const d = world({ logs: CLOSED, posisi: CLOSED_POSITIONS });
    const res = new WalletResearch({ ...d, log: () => {} });
    await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    d.store.run('DELETE FROM wpositions WHERE wallet=?', W);   // as if lost
    const r = await res.refresh(W, { ethUsd: 2500 });
    assert.strictEqual(r.positions.filter((p) => p.venue === 'v3').length, 1, 'refresh must also read v3');
  });

  await t('a failure in the v3 path does not bring down the research', async () => {
    const d = world({ logs: CLOSED, posisi: CLOSED_POSITIONS });
    const res = new WalletResearch({ ...d, log: () => {} });
    res.v3.scan = async () => { throw new Error('RPC tumbang'); };
    const r = await res.scan(W, { blocks: HEAD, ethUsd: 2500 });
    assert.deepStrictEqual(r.positions, [], 'the result is empty, but does not throw');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
