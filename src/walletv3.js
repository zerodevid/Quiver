'use strict';
const { ensureChain } = require('./networks');
// Wallet research for Uniswap v3.
//
// wallet.js reconstructs v4 history: there the token amounts must be dug out of receipts
// and principal separated from fees via liquidity math, because v4 events do not
// carry the amounts. v3 is cheaper: the NonfungiblePositionManager emits the amounts
// directly, and separates principal from fees by itself —
//   IncreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)  -> capital in
//   DecreaseLiquidity(tokenId indexed, liquidity, amount0, amount1)  -> PRINCIPAL withdrawn
//   Collect(tokenId indexed, recipient, amount0, amount1)            -> what was actually received
// so fee = Collect − Decrease. All three index tokenId, so a wallet's entire
// history can be fetched with one query per batch of tokenIds.
//
// The value of each event is computed at the pool price AT THAT BLOCK (archive if available, otherwise
// from the nearest Swap event) — the same as the v4 path. Using the current price
// for capital deposited a week ago would produce a misleading PnL.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { getLogsSafe } = require('./scout');
const { unclaimedV3 } = require('./fees');
const m = require('./v3math');

const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_POOL = new ethers.Interface(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)']);
const hex = (n) => '0x' + n.toString(16);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const idTopic = (id) => '0x' + BigInt(id).toString(16).padStart(64, '0');
const w32 = (b, i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));

class WalletV3 {
  // venue: the v3 venue key on this chain ('v3' Uniswap, 'pancakev3' PancakeSwap on BSC) —
  // one instance per venue, each scanning its own NPM.
  constructor({ rpc, store, chain, log, venue = 'v3' }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
    this.venue = venue; this.npm = chain.npmFor(venue); this.network = chain.network;
    this.priceCache = new Map();
  }

  // The v3 pool price at a block.
  //
  // The main source is the Swap event, NOT an archive node — the opposite of the v4 path. The reason is
  // measured: on one real position, the archive answered 4.26e32 for the exit block
  // while three consecutive Swaps after it (9, 13, and 92 blocks apart) agreed
  // on ~2.0e33, and not a single Swap in between could explain the
  // 4.7x difference — withdrawing liquidity does not move the price in Uniswap v3.
  // A few minutes later the same node rejected that block ("missing trie node"),
  // so its earlier answer came from a state that is no longer intact. The difference is not
  // cosmetic: the same wallet's PnL swung from −$19k to +$231k depending on the source.
  //
  // An event log cannot be wrong — it is part of its own block. The archive is still used,
  // but only if no Swap can be found at all.
  //
  // Returns { sqrt, distance } — `distance` (in blocks) is used by the caller to
  // mark positions whose price is only an estimate.
  async priceAt(poolAddr, block) {
    const key = `${poolAddr}:${block}`;
    if (this.priceCache.has(key)) return this.priceCache.get(key);
    const row = this.store.get('SELECT sqrt_price, src_block FROM wprices WHERE chain=? AND pool_ref=? AND block=?', this.network, poolAddr, block);
    if (row) {
      const v = { sqrt: BigInt(row.sqrt_price), jarak: Math.abs((row.src_block ?? block) - block) };
      this.priceCache.set(key, v); return v;
    }
    const save = (sqrt, src) => {
      this.store.run('INSERT OR REPLACE INTO wprices(chain,pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?,?)',
        this.network, poolAddr, block, sqrt.toString(), src);
      const v = { sqrt, jarak: Math.abs(src - block) };
      this.priceCache.set(key, v);
      return v;
    };

    let best = null;
    for (const win of [400, 4000, 40_000, 400_000]) {
      let logs = [];
      try {
        logs = await this.rpc.getLogs({
          address: poolAddr, topics: [TOPIC.swapV3],
          fromBlock: hex(Math.max(0, block - win)), toBlock: hex(block + win),
        });
      } catch { /* rentang ditolak: coba jendela berikutnya */ }
      for (const l of logs) {
        const bn = parseInt(l.blockNumber, 16);
        // Tie: what happened BEFORE the event is more correct than after.
        const better = !best || Math.abs(bn - block) < Math.abs(best.bn - block)
          || (Math.abs(bn - block) === Math.abs(best.bn - block) && bn <= block);
        if (better) best = { bn, sqrt: w32(ethers.getBytes(l.data), 2) };
      }
      if (best) break;
    }
    if (best) return save(best.sqrt, best.bn);

    // No Swap at all within ±400k blocks: only then is the archive tried.
    if (this.rpc.hasArchive()) {
      try {
        const w = await this.rpc.callAt(poolAddr, IF_POOL.encodeFunctionData('slot0'), block - 1);
        if (w && w !== '0x') {
          const sqrt = BigInt(IF_POOL.decodeFunctionResult('slot0', w)[0]);
          if (sqrt > 0n) return save(sqrt, block - 1);
        }
      } catch (e) { this.log(`harga arsip v3 ${poolAddr.slice(0, 10)} @${block}: ${e.message}`); }
    }
    this.priceCache.set(key, null);
    return null;
  }

  // All v3 NPM tokenIds the wallet has ever held, with their live windows.
  async enumerate(wallet, fromBlock, toBlock) {
    const p = pad32(wallet);
    const [entry, exit] = await Promise.all([
      getLogsSafe(this.rpc, { address: this.npm, topics: [TOPIC.transfer, null, p] }, fromBlock, toBlock),
      getLogsSafe(this.rpc, { address: this.npm, topics: [TOPIC.transfer, p] }, fromBlock, toBlock),
    ]);
    const held = new Map();
    for (const l of [...entry, ...exit]) {
      if (!l.topics[3]) continue;
      const id = BigInt(l.topics[3]).toString();
      const bn = parseInt(l.blockNumber, 16);
      const li = parseInt(l.logIndex, 16);
      const e = held.get(id) || { first: bn, last: bn, heldNow: false, lastPos: -1 };
      e.first = Math.min(e.first, bn); e.last = Math.max(e.last, bn);
      // Ownership is determined by the LAST Transfer, not merely the presence of one —
      // a single tokenId can go in and out many times.
      const pos = bn * 1e5 + li;
      if (pos > e.lastPos) { e.lastPos = pos; e.heldNow = asAddr(l.topics[2]) === wallet; }
      held.set(id, e);
    }
    return held;
  }

  async scan(wallet, { from, head, ethUsd = 2500, onProgress } = {}) {
    wallet = wallet.toLowerCase();
    const held = await this.enumerate(wallet, from, head);
    const ids = [...held.keys()];
    if (!ids.length) return [];

    // 1. position shape: token pair, fee, range, current liquidity
    const info = new Map();
    for (let i = 0; i < ids.length; i += 40) {
      const part = ids.slice(i, i + 40);
      const res = await this.rpc.ethCallMany(part.map((id) => ({
        to: this.npm, data: IF_NPM.encodeFunctionData('positions', [BigInt(id)]),
      })));
      part.forEach((id, k) => {
        const w = res[k];
        if (!w || w === '0x') return;
        try {
          const d = IF_NPM.decodeFunctionResult('positions', w);
          info.set(id, {
            token0: String(d[2]).toLowerCase(), token1: String(d[3]).toLowerCase(), fee: Number(d[4]),
            tickLower: Number(d[5]), tickUpper: Number(d[6]), liquidity: BigInt(d[7]),
          });
        } catch { /* NFT already burned: unreadable now, skipped */ }
      });
      if (onProgress) onProgress({ phase: 'posisi v3', scanned: i + part.length, total: ids.length * 2 });
    }
    // 2. all events, one query per batch of tokenIds (tokenId is indexed).
    // Collected for ALL tokenIds, including those whose positions() no longer
    // answers: an NFT burned after closing still has valuable history.
    const event = new Map(ids.map((id) => [id, []]));
    for (let i = 0; i < ids.length; i += 25) {
      const part = ids.slice(i, i + 25);
      const span = part.reduce((a, id) => ({
        lo: Math.min(a.lo, held.get(id).first),
        hi: Math.max(a.hi, held.get(id).heldNow ? head : Math.min(head, held.get(id).last + 5)),
      }), { lo: head, hi: 0 });
      let logs = [];
      try {
        logs = await getLogsSafe(this.rpc, {
          address: this.npm,
          topics: [[TOPIC.increaseLiq, TOPIC.decreaseLiq, TOPIC.collectV3], part.map(idTopic)],
        }, span.lo, span.hi);
      } catch (e) { this.log(`kejadian v3: ${e.message}`); }
      for (const l of logs) {
        const id = BigInt(l.topics[1]).toString();
        if (!event.has(id)) continue;
        const b = ethers.getBytes(l.data);
        const t0 = l.topics[0];
        // Increase/Decrease: [liquidity, amount0, amount1]. Collect: [recipient, amount0, amount1].
        event.get(id).push({
          block: parseInt(l.blockNumber, 16), tx: l.transactionHash, logIndex: parseInt(l.logIndex, 16),
          kind: t0 === TOPIC.increaseLiq ? 'increase' : t0 === TOPIC.decreaseLiq ? 'decrease' : 'collect',
          liq: t0 === TOPIC.collectV3 ? 0n : w32(b, 0),
          amount0: w32(b, 1), amount1: w32(b, 2),
        });
      }
      if (onProgress) onProgress({ phase: 'kejadian v3', scanned: ids.length + i + part.length, total: ids.length * 2 });
    }

    // 2b. Positions whose NFT has been burned: positions() no longer answers, but the
    // opening transaction is still there. The POOL contract emits Mint there —
    // the log address IS the pool address, and the tick is in its topics. Without this,
    // more than half the history of a wallet that diligently burns its NFTs is lost, and what
    // remains skews toward positions that happen not to have been burned.
    const lost = ids.filter((id) => !info.has(id) && (event.get(id) || []).some((e) => e.kind === 'increase'));
    for (const id of lost) {
      const open = event.get(id).find((e) => e.kind === 'increase');
      try {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [open.tx]);
        const l = (rc?.logs || []).find((x) => x.topics?.[0] === TOPIC.mintV3Pool
          && asAddr(x.topics[1] || '') === this.npm);
        if (!l) continue;
        const pool = String(l.address).toLowerCase();
        const [t0, t1, fee] = await this.rpc.ethCallMany([
          { to: pool, data: '0x0dfe1681' },   // token0()
          { to: pool, data: '0xd21220a7' },   // token1()
          { to: pool, data: '0xddca3f43' },   // fee()
        ]);
        if (!t0 || t0 === '0x' || !t1 || t1 === '0x') continue;
        info.set(id, {
          token0: asAddr(t0), token1: asAddr(t1), fee: fee && fee !== '0x' ? Number(BigInt(fee)) : null,
          tickLower: Number(BigInt.asIntN(24, BigInt(l.topics[2]))),
          tickUpper: Number(BigInt.asIntN(24, BigInt(l.topics[3]))),
          liquidity: 0n, poolAddr: pool, burned: true,
        });
      } catch (e) { this.log(`pulihkan posisi v3 ${id}: ${e.message}`); }
    }
    const alive = [...info.keys()];
    if (!alive.length) return [];

    // 3. pool address & current price, once per pool
    const poolOf = new Map();
    for (const inf of info.values()) {
      if (inf.poolAddr) continue;                 // already known from the Mint log
      const key = `${inf.token0}|${inf.token1}|${inf.fee}`;
      if (!poolOf.has(key)) poolOf.set(key, await this.chain.poolV3Addr(inf.token0, inf.token1, inf.fee, this.npm).catch(() => null));
      inf.poolAddr = poolOf.get(key);
    }
    const alamat = [...new Set([...info.values()].map((i) => i.poolAddr).filter(Boolean))];
    const slot = new Map();
    for (const a of alamat) slot.set(a, await this.chain.slot0V3(a).catch(() => null));

    // 4. unclaimed fees for positions still held & with liquidity
    const owedIds = alive.filter((id) => held.get(id).heldNow && info.get(id).liquidity > 0n);
    let owed = [];
    try { owed = owedIds.length ? await unclaimedV3(this.chain, owedIds.map((x) => BigInt(x)), wallet, this.npm, this.rpc) : []; }
    catch { owed = []; }
    const owedBy = new Map(owedIds.map((id, i) => [id, owed[i] || { fee0: 0n, fee1: 0n }]));

    // 5. assemble
    const out = [];
    for (const id of alive) {
      try {
        const pos = await this.build(wallet, id, info.get(id), event.get(id) || [], held.get(id), slot, owedBy.get(id), head);
        if (pos) out.push(pos);
      } catch (e) { this.log(`posisi v3 ${id}: ${e.message}`); }
    }
    return out;
  }

  async build(wallet, id, inf, evs, span, slot, owed, head) {
    if (!inf.token0 || !inf.poolAddr) return null;
    const [t0, t1] = await this.chain.tokens([inf.token0, inf.token1]);
    const d0 = t0?.decimals ?? 18, d1 = t1?.decimals ?? 18;
    const q = this.chain.quoteSideOf(inf.token0, inf.token1);
    const s0 = slot.get(inf.poolAddr);

    // If the price at that block is unreadable (a pool with no Swap nearby, without an
    // archive node), the QUOTE side can still be valued exactly — it is the money itself.
    // Only the speculative side is missing. That is far better than valuing
    // every event at zero, which makes a position look like it had zero capital.
    let estimate = false;
    const worth = (a0, a1, sqrt) => {
      if (a0 === 0n && a1 === 0n) return 0;
      if (sqrt) {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: sqrt, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
          token0: inf.token0, token1: inf.token1,
        });
        if (v) return v.value;
      }
      if (!q) return 0;
      const lain = q.side === 0 ? a1 : a0;
      if (lain > 0n) estimate = true;
      return q.side === 0 ? Number(a0) / 10 ** d0 : Number(a1) / 10 ** d1;
    };

    evs.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const agg = { in0: 0n, in1: 0n, out0: 0n, out1: 0n, fee0: 0n, fee1: 0n };
    let investedQ = 0, returnedQ = 0, feesQ = 0;
    const rows = [];
    // Decrease puts the PRINCIPAL into "owed", Collect pays it out along with the fee.
    // Fee = what was paid out − principal waiting to be paid, computed as a running total so
    // a fee claim without a withdrawal (Collect without Decrease) is also read in full.
    let wait0 = 0n, wait1 = 0n;
    // A price taken from a Swap far from the event block is an estimate —
    // on a memecoin, a few minutes can mean multiples.
    const FAR = 2000;   // ~3.4 minutes on this chain
    for (const e of evs) {
      const h = await this.priceAt(inf.poolAddr, e.block);
      const sqrt = h?.sqrt ?? null;
      if (h && h.jarak > FAR) estimate = true;
      let princ0 = 0n, princ1 = 0n, fee0 = 0n, fee1 = 0n;
      if (e.kind === 'increase') {
        agg.in0 += e.amount0; agg.in1 += e.amount1;
        princ0 = e.amount0; princ1 = e.amount1;
        investedQ += worth(e.amount0, e.amount1, sqrt);
      } else if (e.kind === 'decrease') {
        agg.out0 += e.amount0; agg.out1 += e.amount1;
        princ0 = e.amount0; princ1 = e.amount1;
        wait0 += e.amount0; wait1 += e.amount1;
      } else {
        princ0 = e.amount0 < wait0 ? e.amount0 : wait0;
        princ1 = e.amount1 < wait1 ? e.amount1 : wait1;
        fee0 = e.amount0 - princ0; fee1 = e.amount1 - princ1;
        wait0 -= princ0; wait1 -= princ1;
        agg.fee0 += fee0; agg.fee1 += fee1;
        returnedQ += worth(e.amount0, e.amount1, sqrt);
        feesQ += worth(fee0, fee1, sqrt);
      }
      rows.push({
        block: e.block, tx: e.tx, logIndex: e.logIndex, kind: e.kind,
        delta: e.kind === 'decrease' ? -e.liq : e.liq,
        moved: {
          in0: e.kind === 'increase' ? e.amount0 : 0n, in1: e.kind === 'increase' ? e.amount1 : 0n,
          out0: e.kind === 'collect' ? e.amount0 : 0n, out1: e.kind === 'collect' ? e.amount1 : 0n,
        },
        princ: { amount0: princ0, amount1: princ1 },
        fee0, fee1, sqrt,
        valueQ: worth(e.amount0, e.amount1, sqrt),
      });
    }

    const owns = span.heldNow && inf.liquidity > 0n && !inf.burned;
    let liveValueQ = 0, liveFeeQ = 0, inRange = null;
    if (owns && s0) {
      const a = m.getSqrtRatioAtTick(inf.tickLower), b = m.getSqrtRatioAtTick(inf.tickUpper);
      const amt = m.amountsForLiquidity(s0.sqrtPriceX96, a, b, inf.liquidity);
      liveValueQ = worth(amt.amount0, amt.amount1, s0.sqrtPriceX96);
      inRange = m.sideOfRange(s0.tick, inf.tickLower, inf.tickUpper) === 'both';
      if (owed) liveFeeQ = worth(owed.fee0, owed.fee1, s0.sqrtPriceX96);
    }
    const closed = !owns;
    const pnlQ = closed ? (returnedQ - investedQ) : (liveValueQ + liveFeeQ + returnedQ - investedQ);

    return {
      wallet, venue: this.venue, tokenId: id, poolId: inf.poolAddr,
      // persist() reads the token pair from poolKey; v3 has no such structure,
      // so an equivalent is made so the storage path does not fork.
      poolKey: { currency0: inf.token0, currency1: inf.token1, fee: inf.fee, tickSpacing: null, hooks: null },
      tickLower: inf.tickLower, tickUpper: inf.tickUpper,
      liquidity: inf.liquidity, agg,
      investedQ, returnedQ, feesQ, pnlQ,
      liveValueQ, liveFeeQ, inRange, curTick: s0?.tick ?? null,
      quoteSymbol: q?.symbol || null, quoteKind: q?.kind || 'usd',
      openedBlock: evs.length ? evs[0].block : span.first,
      closedBlock: closed ? (evs.length ? evs[evs.length - 1].block : span.last) : null,
      status: closed ? 'closed' : 'open',
      events: rows,
      symbol0: t0?.symbol || '?', symbol1: t1?.symbol || '?', dec0: d0, dec1: d1,
      // "incomplete" also applies if there is an event whose price is unreadable:
      // the figure is still shown, but flagged so it is not read as certain.
      incomplete: !evs.some((e) => e.kind === 'increase') || estimate,
      head,
    };
  }
}

module.exports = { WalletV3 };
