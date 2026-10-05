'use strict';
// Test tracking the proceeds of closing a position (proceeds.js): realized vs not yet.
//
// Only the chain & RPC are faked; Proceeds is real. The scenarios are built from the real
// case of Bang GE's wallet: a USDG/MEME position closed, the wallet received USDG + MEME,
// then the MEME was sold a few blocks later (to USDG or to native ETH).
//
// Run: node test/proceeds.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { Proceeds } = require('../src/proceeds');
const { ADDR, TOPIC } = require('../src/chain');
const mm = require('../src/v3math');

const W = '0x54e29aac8ed96c56463b18027c676d09b5c0be98';
const MEME = '0x7a492b0a2d630b94791af846c1842db9e623420c';
const POOL = '0x' + 'ab'.repeat(32);
const HEAD = 1_000_000;
const ETH = 2000;

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAILED ${name}\n       ${e.message}`); }
}
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const w = (n) => '0x' + BigInt.asUintN(256, BigInt(n)).toString(16).padStart(64, '0');
const hexb = (n) => '0x' + n.toString(16);
const txh = (n) => '0x' + n.toString(16).padStart(64, '0');
const xfer = (token, from, to, amt, block, tx) => ({
  address: token, blockNumber: hexb(block), logIndex: '0x0', transactionHash: tx,
  topics: [TOPIC.transfer, pad32(from), pad32(to)], data: w(amt),
});
// pool "1 MEME = 0.001 USDG": token0 USDG(6), token1 MEME(18) -> 1000 MEME per USDG.
// A tick is a 0.01% step, so the price from a tick is slightly off — tolerance 0.01%.
const SQRT = mm.getSqrtRatioAtTick(mm.priceToTick(1000, 6, 18));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-4 + 1e-6, `${msg}: ${a} vs ${b}`);

// Closed position: capital 1000 USDG, exits 200 USDG + 800,000 MEME (close value 200 + 800 = 1000).
function world({ logs = [], receipts = {}, txs = {}, balances = {}, archived = true, sqrtNow = SQRT, pre = 0n } = {}) {
  const store = new Store(':memory:');
  const rpc = {
    hasArchive: () => archived,
    blockNumber: async () => HEAD,
    callAt: async (to, data) => {
      if (to === MEME && data.startsWith('0x70a08231')) return w(pre);     // balanceOf
      throw new Error('missing trie node');
    },
    getLogs: async (f) => {
      const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
      return logs.filter((l) => l.address === f.address && (f.topics || []).every((s, i) => s == null || s === l.topics[i])
        && parseInt(l.blockNumber, 16) >= from && parseInt(l.blockNumber, 16) <= to);
    },
    batch: async (calls) => calls.map((c) => {
      if (c.method === 'eth_getTransactionReceipt') return { result: receipts[c.params[0]] || null };
      if (c.method === 'eth_getTransactionByHash') return { result: txs[c.params[0]] || { from: W, value: '0x0', gasPrice: '0x1' } };
      if (c.method === 'eth_getBalance') {
        const b = balances[parseInt(c.params[1], 16)];
        return b == null ? { error: { message: 'missing trie node' } } : { result: w(b) };
      }
      return { result: null };
    }),
  };
  const chain = {
    tokens: async (l) => l.map((a) => (a === ADDR.usdg ? { address: a, symbol: 'USDG', decimals: 6 } : { address: a, symbol: 'MEME', decimals: 18 })),
    slot0V4: async () => (sqrtNow ? { sqrtPriceX96: sqrtNow, tick: 0 } : null),
    blockTs: async (b) => b * 101,
    ethUsdAt: async () => ETH,
    quoteSideOf: (t0, t1) => (t0 === ADDR.usdg ? { side: 0, symbol: 'USDG', decimals: 6, kind: 'usd' } : t1 === ADDR.usdg ? { side: 1, symbol: 'USDG', decimals: 6, kind: 'usd' } : null),
    valueInQuote({ sqrtPriceX96, amount0, amount1, dec0, dec1, token0, token1 }) {
      const q = this.quoteSideOf(token0, token1);
      const p = mm.priceFromSqrt(sqrtPriceX96, dec0, dec1);
      const a0 = Number(amount0) / 10 ** dec0, a1 = Number(amount1) / 10 ** dec1;
      return { value: q.side === 0 ? a0 + a1 / p : a1 + a0 * p, kind: 'usd' };
    },
  };
  const research = { priceAt: async () => SQRT };
  const proceeds = new Proceeds({ rpc, store, chain, research, log: () => {} });
  return { store, proceeds };
}

const CLOSE_TX = txh(500);
function position(store, { id = '1', closeBlock = 500, out0 = 200_000_000, out1 = 800_000n * 10n ** 18n, tx = CLOSE_TX } = {}) {
  store.run(`INSERT INTO wpositions(wallet,venue,token_id,pool_ref,token0,token1,out0,out1,invested_q,returned_q,fees_q,pnl_q,quote_symbol,
    opened_block,closed_block,status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  W, 'v4', id, POOL, ADDR.usdg, MEME, String(out0), out1.toString(), 1000, 1000, 0, 0, 'USDG', closeBlock - 100, closeBlock, 'closed');
  store.run(`INSERT INTO wevents(wallet,token_id,block,tx_hash,log_index,kind,liq_delta,amount0,amount1) VALUES(?,?,?,?,?,?,?,?,?)`,
    W, id, closeBlock, tx, 5, 'decrease', '-1', String(out0), out1.toString());
}
const closeReceipt = (out1 = 800_000n * 10n ** 18n, to = W, tx = CLOSE_TX) => ({
  blockNumber: hexb(500), gasUsed: '0x0', effectiveGasPrice: '0x0',
  logs: [xfer(ADDR.usdg, ADDR.poolManager, W, 200_000_000, 500, tx), xfer(MEME, ADDR.poolManager, to, out1, 500, tx)],
});
const row = (store, id = '1') => store.get('SELECT * FROM wpositions WHERE token_id=?', id);

(async () => {
  await t('not sold yet: USDG realized, MEME held valued at the current price', async () => {
    const d = world({ receipts: { [CLOSE_TX]: closeReceipt() } });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, (800_000n * 10n ** 18n).toString());
    assert.strictEqual(r.sold_tok, '0');
    assert.ok(Math.abs(r.realized_q - 200) < 1e-6, `realized ${r.realized_q}`);
    near(r.unrealized_q, 800, 'unrealized');
    assert.ok(Math.abs(r.pnl_q) < 0.1, `pnl ${r.pnl_q}`);
    assert.strictEqual(r.tracked_to, HEAD);
  });

  await t('MEME price halves before being sold: closed PnL falls too', async () => {
    const d = world({ receipts: { [CLOSE_TX]: closeReceipt() }, sqrtNow: mm.getSqrtRatioAtTick(mm.priceToTick(2000, 6, 18)) });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    near(r.unrealized_q, 400, 'unrealized');
    near(r.pnl_q, -400, 'pnl');
  });

  await t('sold to USDG: the actual sale proceeds are used, not the pool price', async () => {
    const SELL = txh(600);
    const d = world({
      receipts: {
        [CLOSE_TX]: closeReceipt(),
        // sold 800,000 MEME, got only 700 USDG (price impact) — not 800 at the pool price
        [SELL]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 700_000_000, 600, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
      balances: { 599: 10n ** 18n, 600: 10n ** 18n },
    });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.strictEqual(r.sold_tok, (800_000n * 10n ** 18n).toString());
    assert.ok(Math.abs(r.realized_q - 900) < 1e-6, `realized ${r.realized_q}`);
    assert.strictEqual(r.unrealized_q, 0);
    assert.ok(Math.abs(r.pnl_q - (-100)) < 1e-6, `pnl ${r.pnl_q}`);
    const s = d.store.get('SELECT * FROM wsales WHERE tx_hash=?', SELL);
    assert.strictEqual(s.kind, 'sell');
    assert.ok(Math.abs(s.quote_usd - 700) < 1e-6);
  });

  await t('sold to native ETH: read from the balance difference + gas, the ETH price of that block', async () => {
    const SELL = txh(600);
    const d = world({
      receipts: {
        [CLOSE_TX]: closeReceipt(),
        [SELL]: { blockNumber: hexb(600), gasUsed: '0x10', effectiveGasPrice: '0x2', logs: [
          xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)] },
      },
      txs: { [SELL]: { from: W, value: '0x0' } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
      // balance rose 0.3 ETH, minus 32 wei of gas
      balances: { 599: 10n ** 18n, 600: 10n ** 18n + 3n * 10n ** 17n - 32n },
    });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    // 200 USDG + 0.3 ETH × 2000 = 800
    assert.ok(Math.abs(r.realized_q - 800) < 1e-6, `realized ${r.realized_q}`);
    assert.ok(Math.abs(r.pnl_q - (-200)) < 1e-6, `pnl ${r.pnl_q}`);
  });

  await t('ETH balance temporarily fails (429): the token is skipped & retried, not recorded wrong', async () => {
    const SELL = txh(600);
    const d = world({
      receipts: { [CLOSE_TX]: closeReceipt(), [SELL]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)] } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, SELL)],
    });
    d.proceeds.rpc.batch = (async (orig) => async (calls) => {
      if (calls[0].method === 'eth_getBalance') return calls.map(() => ({ error: { message: 'HTTP 429: Too Many Requests' } }));
      return orig(calls);
    })(d.proceeds.rpc.batch);
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.tracked_to, null, 'must still be untracked');
    assert.strictEqual(d.store.get('SELECT COUNT(*) n FROM wsales').n, 0);
  });

  await t('sent out without a quote asset coming in: valued at the pool price of that block', async () => {
    const SEND = txh(600);
    const d = world({
      receipts: { [CLOSE_TX]: closeReceipt(), [SEND]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [xfer(MEME, W, '0x' + '11'.repeat(20), 800_000n * 10n ** 18n, 600, SEND)] } },
      logs: [xfer(MEME, W, '0x' + '11'.repeat(20), 800_000n * 10n ** 18n, 600, SEND)],
      balances: { 599: 0n, 600: 0n },
    });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(d.store.get('SELECT kind FROM wsales WHERE tx_hash=?', SEND).kind, 'send');
    near(r.realized_q, 1000, 'realized');
  });

  await t('FIFO: the old balance is used up first, then the oldest position; the rest is held by the youngest position', async () => {
    const SELL = txh(700);
    const CLOSE2 = txh(550);
    const d = world({
      pre: 100_000n * 10n ** 18n,
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(800_000n * 10n ** 18n, W, CLOSE2),
        // sold 1,000,000: 100,000 of the old balance + 800,000 from position #1 + 100,000 from position #2
        [SELL]: { blockNumber: hexb(700), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 1_000_000n * 10n ** 18n, 700, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 1_000_000_000, 700, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 1_000_000n * 10n ** 18n, 700, SELL)],
      balances: { 699: 0n, 700: 0n },
    });
    position(d.store, { id: '1' });
    position(d.store, { id: '2', closeBlock: 550, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r1 = row(d.store, '1'), r2 = row(d.store, '2');
    assert.strictEqual(r1.held_tok, '0');
    assert.strictEqual(r2.held_tok, (700_000n * 10n ** 18n).toString());
    // the 1000 USDG proceeds split evenly per token: #1 gets 800, #2 gets 100
    assert.ok(Math.abs(r1.realized_q - 1000) < 1e-6, `r1 ${r1.realized_q}`);
    assert.ok(Math.abs(r2.realized_q - 300) < 1e-6, `r2 ${r2.realized_q}`);
    near(r2.unrealized_q, 700, 'r2 unreal');
  });

  await t('zap-out: MEME never reached the wallet -> already realized at the close price, not held', async () => {
    const d = world({ receipts: { [CLOSE_TX]: closeReceipt(800_000n * 10n ** 18n, ADDR.universalRouter) } });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.ok(Math.abs(r.realized_q - 1000) < 1e-6, `realized ${r.realized_q}`);
  });

  await t('incremental update: a sale after the first tracking is also read', async () => {
    const SELL = txh(900);
    const logs = [];
    const d = world({
      receipts: { [CLOSE_TX]: closeReceipt(), [SELL]: { blockNumber: hexb(900), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
        xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 900, SELL), xfer(ADDR.usdg, ADDR.poolManager, W, 750_000_000, 900, SELL)] } },
      logs, balances: { 899: 0n, 900: 0n },
    });
    position(d.store);
    await d.proceeds.track(W, { head: 800, ethUsd: ETH });
    assert.strictEqual(row(d.store).held_tok, (800_000n * 10n ** 18n).toString());
    logs.push(xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 900, SELL));
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.held_tok, '0');
    assert.ok(Math.abs(r.realized_q - 950) < 1e-6, `realized ${r.realized_q}`);
    assert.strictEqual(r.tracked_to, HEAD);
  });

  await t('a sale before the position closed is not charged to that position', async () => {
    // Real bug on lp3: the wallet sold cheaply, then the next day opened & closed another
    // position. A queue that does not know about time covers the stock shortfall with a lot
    // that did not yet exist at that moment, so a position that was actually profitable showed a big loss.
    const SELL = txh(520), CLOSE2 = txh(600);
    const lot = 800_000n * 10n ** 18n;
    const d = world({
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(lot, W, CLOSE2),
        // 1,400,000 went out although the lots that exist are only 800,000 — the rest is from outside the scan window
        [SELL]: { blockNumber: hexb(520), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
          xfer(MEME, W, ADDR.poolManager, 1_400_000n * 10n ** 18n, 520, SELL),
          xfer(ADDR.usdg, ADDR.poolManager, W, 140_000_000, 520, SELL)] },
      },
      logs: [xfer(MEME, W, ADDR.poolManager, 1_400_000n * 10n ** 18n, 520, SELL)],
      balances: { 519: 0n, 520: 0n },
    });
    position(d.store, { id: '1' });
    position(d.store, { id: '2', closeBlock: 600, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r2 = row(d.store, '2');
    assert.strictEqual(r2.sold_tok, '0', 'position #2 did not exist yet at that sale');
    assert.strictEqual(r2.held_tok, lot.toString());
    assert.ok(Math.abs(r2.realized_q - 200) < 1e-6, `r2 realized ${r2.realized_q}`);
    near(r2.unrealized_q, 800, 'r2 unrealized');
  });

  await t('a token bought on the market also queues: its sale is not charged to the LP lot', async () => {
    // The target recycles capital: close position -> sell, buy again on the market -> sell again.
    // Market purchases never enter the queue, so the second sale consumes
    // the next position's lot and that position appears to sell cheaply although its token
    // is still fully in the wallet.
    const SELL1 = txh(520), BUY = txh(550), CLOSE2 = txh(600), SELL2 = txh(620);
    const lot = 800_000n * 10n ** 18n, buy = 900_000n * 10n ** 18n;
    const sell = (tok, usdg, block, tx) => ({ blockNumber: hexb(block), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
      xfer(MEME, W, ADDR.poolManager, tok, block, tx), xfer(ADDR.usdg, ADDR.poolManager, W, usdg, block, tx)] });
    const d = world({
      receipts: {
        [CLOSE_TX]: closeReceipt(), [CLOSE2]: closeReceipt(lot, W, CLOSE2),
        [SELL1]: sell(lot, 800_000_000, 520, SELL1), [SELL2]: sell(buy, 90_000_000, 620, SELL2),
      },
      logs: [
        xfer(MEME, W, ADDR.poolManager, lot, 520, SELL1),
        xfer(MEME, ADDR.poolManager, W, buy, 550, BUY),
        xfer(MEME, W, ADDR.poolManager, buy, 620, SELL2),
      ],
      balances: { 519: 0n, 520: 0n, 619: 0n, 620: 0n },
    });
    position(d.store, { id: '1' });
    position(d.store, { id: '2', closeBlock: 600, tx: CLOSE2 });
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    assert.strictEqual(d.store.get('SELECT tok_in FROM wflows WHERE tx_hash=?', BUY).tok_in, buy.toString());
    const r1 = row(d.store, '1'), r2 = row(d.store, '2');
    assert.strictEqual(r1.sold_tok, lot.toString());
    assert.ok(Math.abs(r1.realized_q - 1000) < 1e-6, `r1 realized ${r1.realized_q}`);
    // that cheap sale is market-bought tokens, not position #2's lot
    assert.strictEqual(r2.sold_tok, '0', 'position #2 is not counted as sold');
    assert.strictEqual(r2.held_tok, lot.toString());
    assert.ok(Math.abs(r2.realized_q - 200) < 1e-6, `r2 realized ${r2.realized_q}`);
    near(r2.unrealized_q, 800, 'r2 unrealized');
  });

  await t('leftover returned in the same tx is not counted as going out', async () => {
    const ADD = txh(600);
    const d = world({
      receipts: { [CLOSE_TX]: closeReceipt(), [ADD]: { blockNumber: hexb(600), gasUsed: '0x0', effectiveGasPrice: '0x0', logs: [
        xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, ADD),
        xfer(MEME, ADDR.poolManager, W, 100_000n * 10n ** 18n, 600, ADD)] } },
      logs: [xfer(MEME, W, ADDR.poolManager, 800_000n * 10n ** 18n, 600, ADD)],
      balances: { 599: 0n, 600: 0n },
    });
    position(d.store);
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    assert.strictEqual(d.store.get('SELECT tok_out FROM wsales WHERE tx_hash=?', ADD).tok_out, (700_000n * 10n ** 18n).toString());
    const r = row(d.store);
    assert.strictEqual(r.held_tok, (100_000n * 10n ** 18n).toString());
    near(r.realized_q, 900, 'realized');
  });

  await t('everything that came back is USDG: fully realized without a chain call', async () => {
    const d = world();
    position(d.store, { out0: 1_050_000_000, out1: 0n });
    d.store.run('UPDATE wpositions SET returned_q=1050');
    await d.proceeds.track(W, { head: HEAD, ethUsd: ETH });
    const r = row(d.store);
    assert.strictEqual(r.realized_q, 1050);
    assert.strictEqual(r.pnl_q, 50);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
