'use strict';
const { ensureChain } = require('./networks');
// Realized vs not yet, for positions that have been closed.
//
// Closing a USDG/MEME position returns two things: USDG (money right away) and MEME
// (not necessarily money — its price can fall another 80% before it gets sold). Both used to
// be valued at the pool price at close and considered done, although the MEME
// still sat in the wallet. This module follows that token until it is really swapped:
//   - quote assets (USDG/ETH/WETH) received = realized right then
//   - other tokens: each Transfer out of the wallet has its receipt read; if in the same
//     tx a quote asset came in, that is a sale and its proceeds are used
//     (not the pool price — selling 1 million tokens incurs price impact & router fee);
//     if not (sent to another wallet / swapped for another memecoin), valued at the
//     pool price at that block. What has not left = still held, valued at the
//     current pool price as unrealized.
//
// One wallet can receive the same token from several positions, may already hold it
// before the first position, and adds stock by buying on the market. Sales
// are allocated FIFO over all those inflows by block — the opening balance (balanceOf at
// that block), each LP withdrawal, then tokens arriving from outside — and a
// sale may only consume stock that came in at that block or before.
const { ethers } = require('ethers');
const { TOPIC } = require('./chain');
const { getLogsSafe } = require('./scout');

const IF_ERC20 = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
const IF_POOL3 = new ethers.Interface(['function slot0() view returns (uint160 sqrtPriceX96, int24 tick)']);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const big = (v) => BigInt(v || 0);
// The block window already scanned for this token, both directions at once. This key
// was renamed when the "in" direction was added so old wallets rescan once
// and fill wflows — without that the queue stays lopsided forever.
const spanKeyOf = (chain, wallet, token) => `wflow_span:${chain}:${wallet}:${token}`;

class Proceeds {
  constructor({ rpc, store, chain, research, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.research = research;
    this.network = chain.network;
    this.log = log || (() => {});
  }

  // Quote and non-quote sides of a wpositions row.
  sides(r) {
    const q = this.chain.quoteSideOf(r.token0, r.token1);
    if (!q) return null;
    return { q, tok: q.side === 0 ? r.token1 : r.token0, side: q.side === 0 ? 1 : 0 };
  }

  // USD value of an amount of a non-quote token at this row's pool sqrt price.
  usdOf(r, sqrt, amount, ethUsd) {
    if (!sqrt || amount <= 0n) return 0;
    const s = this.sides(r);
    const v = this.chain.valueInQuote({
      sqrtPriceX96: sqrt, amount0: s.side === 0 ? amount : 0n, amount1: s.side === 1 ? amount : 0n,
      dec0: r.dec0, dec1: r.dec1, token0: r.token0, token1: r.token1,
    });
    return v ? v.value * (s.q.kind === 'eth' ? ethUsd : 1) : 0;
  }

  async sqrtNow(r) {
    try {
      const s = this.chain.isV3Venue(r.venue) ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref);
      return s?.sqrtPriceX96 || null;
    } catch { return null; }
  }

  async sqrtAt(r, block) {
    try {
      if (!this.chain.isV3Venue(r.venue)) return await this.research.priceAt(r.pool_ref, block);
      if (!this.rpc.hasArchive()) return null;
      const w = await this.rpc.callAt(r.pool_ref, IF_POOL3.encodeFunctionData('slot0'), block);
      return BigInt(IF_POOL3.decodeFunctionResult('slot0', w)[0]);
    } catch { return null; }
  }

  // How many tokens really reached the wallet in the withdrawal tx — a zap-out via the
  // router sells that token in the same tx, and one like that was already valued at the
  // close price by the scanner (already realized, not held).
  async receivedIn(txs, wallet, token) {
    const out = new Map();
    if (!txs.length) return out;
    const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    txs.forEach((h, i) => {
      const rc = rcs[i] && !rcs[i].error ? rcs[i].result : null;
      let got = 0n;
      for (const l of rc?.logs || []) {
        if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3 || l.address.toLowerCase() !== token) continue;
        if (asAddr(l.topics[2]) === wallet) got += BigInt(l.data);
      }
      out.set(h, rc ? got : null);
    });
    return out;
  }

  // One tx that takes a token out of the wallet: how much left, how much USD came in.
  async analyzeSale(wallet, token, tx, ethUsd) {
    const [rcR, txR] = await this.rpc.batch([
      { method: 'eth_getTransactionReceipt', params: [tx] },
      { method: 'eth_getTransactionByHash', params: [tx] },
    ]);
    const rc = rcR?.result, t = txR?.result;
    if (!rc) return null;
    const bn = parseInt(rc.blockNumber, 16);
    // proceeds of a sale to ETH/WETH are valued at the ETH price at that block, not now
    const ethThen = await this.chain.ethUsdAt(bn, ethUsd);
    let tokOut = 0n, tokIn = 0n, usd = 0;
    for (const l of rc.logs || []) {
      if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
      const a = l.address.toLowerCase(), from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
      if (a === token && from === wallet) tokOut += BigInt(l.data);
      // The router/position manager often returns leftovers in the same tx: what really
      // left is the difference, not the gross amount that went out.
      if (a === token && to === wallet) tokIn += BigInt(l.data);
      if (to === wallet && this.chain.QUOTES[a]) {
        const q = this.chain.QUOTES[a];
        usd += (Number(BigInt(l.data)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethThen : 1);
      }
    }
    // Native ETH has no Transfer: the balance difference before-after the block, with
    // the tx's gas & value added back. Needs an archive node; without it the proceeds of a sale to ETH are unreadable
    // and the tx is valued at the pool price.
    if (this.rpc.hasArchive() && t && t.from.toLowerCase() === wallet) {
      try {
        const [b0, b1] = await this.rpc.batch([
          { method: 'eth_getBalance', params: [wallet, '0x' + (bn - 1).toString(16)] },
          { method: 'eth_getBalance', params: [wallet, '0x' + bn.toString(16)] },
        ], { archive: true });
        if (!b0?.result || !b1?.result) throw new Error(b0?.error?.message || b1?.error?.message || 'saldo tidak terbaca');
        const gas = BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice || t.gasPrice || 0);
        const delta = BigInt(b1.result) - BigInt(b0.result) + gas + BigInt(t.value || 0);
        if (delta > 0n) usd += (Number(delta) / 1e18) * ethThen;
      } catch (e) {
        // Old block state has been pruned by the archive node ("missing trie node"): it will
        // never be readable — use what there is (valued at the pool price if no USDG came in).
        // Other failures (429, timeout) are temporary: better to fail now so this token
        // is retried on the next update, than be recorded wrong permanently.
        if (!/missing trie|not available|not found/i.test(e.message)) {
          throw new Error(`saldo ETH ${tx.slice(0, 10)}… tidak terbaca: ${e.message}`);
        }
      }
    }
    return { tokOut: tokOut > tokIn ? tokOut - tokIn : 0n, usd: usd > 0 ? usd : null, block: bn };
  }

  // Track all closed positions of this wallet. Called after persist writes the rows.
  async track(wallet, { head, ethUsd }) {
    const rows = this.store.all(`SELECT wallet, venue, token_id, pool_ref, token0, token1, out0, out1,
      returned_q, invested_q, quote_symbol, closed_block, held_tok, sold_tok, tracked_to
      FROM wpositions WHERE chain=? AND wallet=? AND status='closed'`, this.network, wallet);
    const toks = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]).filter(Boolean))]);
    const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
    for (const r of rows) { r.dec0 = dec.get(r.token0) ?? 18; r.dec1 = dec.get(r.token1) ?? 18; }

    // group per non-quote token
    const byTok = new Map();
    for (const r of rows) {
      const s = this.sides(r);
      if (!s) continue;
      r.outN = big(s.side === 0 ? r.out0 : r.out1);
      r.tok = s.tok; r.s = s;
      if (r.outN === 0n) {
        // everything returned is a quote asset: fully realized
        if (r.tracked_to == null) this.setRow(r, { held: 0n, sold: 0n, realized: r.returned_q || 0, unrealized: 0, head });
        continue;
      }
      if (!byTok.has(r.tok)) byTok.set(r.tok, []);
      byTok.get(r.tok).push(r);
    }

    for (const [token, lots] of byTok) {
      // Only tokens that still have business: a freshly closed position, a token still held,
      // or external supply not yet scanned (the old allocation needs recomputing).
      const backfill = this.store.getState(spanKeyOf(this.network, wallet, token)) == null;
      if (!backfill && !lots.some((r) => r.tracked_to == null || big(r.held_tok) > 0n)) continue;
      try { await this.trackToken(wallet, token, lots, { head, ethUsd }); }
      catch (e) { this.log(`lacak ${token.slice(0, 10)}…: ${e.message}`); }
    }
  }

  async trackToken(wallet, token, lots, { head, ethUsd }) {
    lots.sort((a, b) => a.closed_block - b.closed_block);
    // Lot size = tokens actually received by the wallet at withdrawal.
    const fresh = lots.filter((r) => r.tracked_to == null);
    const txOf = new Map();
    for (const r of fresh) {
      // v4: tokens out on 'decrease'/'collect'; v3: only on 'collect' (its
      // 'decrease' row is worth zero), so just sum both kinds.
      const ev = this.store.all(`SELECT tx_hash, ${r.s.side === 0 ? 'amount0' : 'amount1'} AS amt FROM wevents
        WHERE chain=? AND wallet=? AND token_id=? AND kind IN ('decrease','collect') ORDER BY block`, this.network, wallet, r.token_id);
      txOf.set(r, ev);
    }
    const allTx = [...new Set([...txOf.values()].flat().map((e) => e.tx_hash))];
    const recv = await this.receivedIn(allTx, wallet, token);
    for (const r of fresh) {
      let lot = 0n;
      const seen = new Set();
      for (const e of txOf.get(r)) {
        if (seen.has(e.tx_hash)) continue;
        seen.add(e.tx_hash);
        const got = recv.get(e.tx_hash);
        // receipt unreadable: assume everything was received (safer than zero)
        lot += got == null ? big(e.amt) : got;
      }
      if (lot > r.outN) lot = r.outN;
      r.lot = lot;
    }
    for (const r of lots) if (r.lot == null) r.lot = big(r.held_tok) + big(r.sold_tok);

    // Balance that existed before the first lot — consumed first (FIFO).
    const first = lots[0].closed_block;
    const preKey = `wpre:${this.network}:${wallet}:${token}:${first}`;
    let pre = this.store.getState(preKey);
    if (pre == null) {
      pre = (await this.preBalance(wallet, token, first)).toString();
      this.store.setState(preKey, pre);
    }

    // Transfers out: window [first lot, head], only the part not yet read.
    // A newly appearing lot can be earlier than the old window (a longer rescan),
    // so the window already covered is stored per token.
    const spanKey = spanKeyOf(this.network, wallet, token);
    let span = null;
    try { span = JSON.parse(this.store.getState(spanKey) || 'null'); } catch { span = null; }
    const parts = [];
    if (!span) parts.push([first, head]);
    else {
      if (first < span.from) parts.push([first, span.from - 1]);
      if (span.to < head) parts.push([span.to + 1, head]);
    }
    const known = this.store.all('SELECT tx_hash, block, tok_out, quote_usd FROM wsales WHERE chain=? AND wallet=? AND token=? ORDER BY block', this.network, wallet, token);
    const seenTx = new Set(known.map((k) => k.tx_hash));
    // LP withdrawal/addition txs we track: tokens that came in through there ALREADY
    // became lots, do not count them twice as outside supply.
    const lpTx = new Set(this.store.all(`SELECT DISTINCT e.tx_hash FROM wevents e
      JOIN wpositions p ON p.chain = e.chain AND p.wallet = e.wallet AND p.token_id = e.token_id
      WHERE e.chain=? AND e.wallet=? AND (p.token0=? OR p.token1=?)`, this.network, wallet, token, token).map((x) => x.tx_hash));
    for (const [lo, hi] of parts) {
      if (lo > hi) continue;
      await this.scanTransfers(wallet, token, lo, hi, { ethUsd, known, seenTx, lpTx });
    }
    this.store.setState(spanKey, JSON.stringify({ from: Math.min(first, span?.from ?? first), to: head }));
    known.sort((x, y) => x.block - y.block);
    await this.allocate(wallet, token, lots, { first, pre, known, ethUsd, head });
  }

  // Saldo token sebelum lot pertama (butuh node arsip; tanpa itu nol).
  async preBalance(wallet, token, first) {
    if (!this.rpc.hasArchive()) return 0n;
    try {
      const w = await this.rpc.callAt(token, IF_ERC20.encodeFunctionData('balanceOf', [wallet]), first - 1);
      return BigInt(w);
    } catch (e) { this.log(`saldo awal ${token.slice(0, 10)} gagal: ${e.message}`); return 0n; }
  }

  // Transfer token keluar (→ wsales) dan masuk dari luar posisi (→ wflows) di [lo, hi].
  async scanTransfers(wallet, token, lo, hi, { ethUsd, known, seenTx, lpTx }) {
    const logs = await getLogsSafe(this.rpc, { address: token, topics: [TOPIC.transfer, pad32(wallet)] }, lo, hi);
    const outOf = new Map();
    for (const l of logs) outOf.set(l.transactionHash, (outOf.get(l.transactionHash) || 0n) + BigInt(l.data));
    for (const tx of outOf.keys()) {
      if (seenTx.has(tx)) continue;
      seenTx.add(tx);
      const a = await this.analyzeSale(wallet, token, tx, ethUsd);
      if (!a || a.tokOut === 0n) continue;
      const ts = await this.chain.blockTs(a.block);
      this.store.run('INSERT OR REPLACE INTO wsales(chain,wallet,token,tx_hash,block,ts,tok_out,quote_usd,kind) VALUES(?,?,?,?,?,?,?,?,?)',
        this.network, wallet, token, tx, a.block, ts, a.tokOut.toString(), a.usd, a.usd != null ? 'sell' : 'send');
      known.push({ tx_hash: tx, block: a.block, tok_out: a.tokOut.toString(), quote_usd: a.usd });
    }
    // The reverse direction: tokens coming in from outside our positions — bought on the market or
    // sent by another wallet. Without this the queue runs out of stock and an old sale
    // spills onto a position that had not yet been opened when that sale happened.
    const inLogs = await getLogsSafe(this.rpc, { address: token, topics: [TOPIC.transfer, null, pad32(wallet)] }, lo, hi);
    const inOf = new Map();
    for (const l of inLogs) {
      const cur = inOf.get(l.transactionHash) || { block: parseInt(l.blockNumber, 16), amt: 0n };
      cur.amt += BigInt(l.data);
      inOf.set(l.transactionHash, cur);
    }
    for (const [tx, v] of inOf) {
      if (lpTx.has(tx)) continue;
      const net = v.amt - (outOf.get(tx) || 0n);
      if (net <= 0n) continue;
      const ts = await this.chain.blockTs(v.block);
      this.store.run('INSERT OR REPLACE INTO wflows(chain,wallet,token,tx_hash,block,ts,tok_in) VALUES(?,?,?,?,?,?,?)',
        this.network, wallet, token, tx, v.block, ts, net.toString());
    }
  }

  async allocate(wallet, token, lots, { first, pre, known, ethUsd, head }) {

    // Value of the non-quote side at the close price, per raw unit — a fallback if the pool price
    // at the sale block / now is unreadable (more honest than zero).
    for (const r of lots) {
      r.quoteOutUsd = (Number(big(r.s.side === 0 ? r.out1 : r.out0)) / 10 ** (r.s.side === 0 ? r.dec1 : r.dec0))
        * (r.s.q.kind === 'eth' ? ethUsd : 1);
      const nonQuoteCloseUsd = Math.max(0, (r.returned_q || 0) - r.quoteOutUsd);
      r.closeUnit = r.outN > 0n ? nonQuoteCloseUsd / Number(r.outN) : 0;
    }

    // FIFO allocation over ALL token inflows, in block order: the balance before the first lot,
    // each LP withdrawal (lot), and tokens arriving from outside.
    const extra = this.store.all('SELECT block, tok_in FROM wflows WHERE chain=? AND wallet=? AND token=? ORDER BY block', this.network, wallet, token);
    const queue = [
      { block: first - 1, left: big(pre) },
      ...lots.map((r) => ({ block: r.closed_block, r, left: r.lot, sold: 0n, usd: 0 })),
      ...extra.map((e) => ({ block: e.block, left: big(e.tok_in) })),
    ].sort((a, b) => a.block - b.block);
    for (const k of known) {
      let rem = big(k.tok_out);
      const total = rem;
      for (const q of queue) {
        if (rem === 0n) break;
        // A token cannot leave before it arrives: a sale only consumes stock that
        // had come in by that block. The rest comes from outside the scan window — leave
        // it unallocated rather than charged to a position that did not exist then.
        if (q.block > k.block) break;
        if (q.left === 0n) continue;
        const take = q.left < rem ? q.left : rem;
        q.left -= take; rem -= take;
        if (!q.r) continue;
        q.sold += take;
        if (k.quote_usd != null) { q.usd += k.quote_usd * Number(take) / Number(total); continue; }
        const sq = await this.sqrtAt(q.r, k.block);
        q.usd += sq ? this.usdOf(q.r, sq, take, ethUsd) : q.r.closeUnit * Number(take);
      }
    }

    // Write the per-position result.
    const sqrtCache = new Map();
    for (const q of queue) {
      if (!q.r) continue;
      const r = q.r;
      // the part that never reached the wallet (zap-out) was already valued at the close price
      const closeUsd = r.closeUnit * Number(r.outN - r.lot);
      const held = q.left;
      let unrealized = 0;
      if (held > 0n) {
        if (!sqrtCache.has(r.pool_ref)) sqrtCache.set(r.pool_ref, await this.sqrtNow(r));
        const sq = sqrtCache.get(r.pool_ref);
        unrealized = sq ? this.usdOf(r, sq, held, ethUsd) : r.closeUnit * Number(held);
      }
      this.setRow(r, { held, sold: q.sold, realized: r.quoteOutUsd + closeUsd + q.usd, unrealized, head });
    }
  }

  setRow(r, { held, sold, realized, unrealized, head }) {
    // NULL capital = incomplete history; its PnL is also unknown, not proceeds minus zero.
    const pnl = r.invested_q == null ? null : realized + unrealized - r.invested_q;
    this.store.run(`UPDATE wpositions SET held_tok=?, sold_tok=?, realized_q=?, unrealized_q=?, pnl_q=?, tracked_to=?
      WHERE chain=? AND wallet=? AND venue=? AND token_id=?`,
    held.toString(), sold.toString(), realized, unrealized, pnl, head, this.network, r.wallet, r.venue, r.token_id);
  }

  // A fresh "unrealized" value for display: the current pool price, without
  // writing to the DB. A row that holds nothing is returned as it is.
  async refreshHeld(rows, ethUsd) {
    const held = rows.filter((r) => r.status === 'closed' && big(r.held_tok) > 0n && r.realized_q != null);
    if (!held.length) return;
    const bySqrt = new Map();
    for (const r of held) {
      if (!bySqrt.has(r.pool_ref)) bySqrt.set(r.pool_ref, await this.sqrtNow(r));
      const u = this.usdOf(r, bySqrt.get(r.pool_ref), big(r.held_tok), ethUsd);
      r.unrealized_q = u;
      r.pnl_q = r.invested_q == null ? null : r.realized_q + u - r.invested_q;
    }
  }
}

module.exports = { Proceeds };
