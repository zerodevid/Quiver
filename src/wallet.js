'use strict';
const { ensureChain } = require('./networks');
// Wallet research: reconstruct a wallet's entire LP position history from the chain,
// with capital, fees, and PnL — for positions still alive AND those
// already closed.
//
// Why from the chain, not a third-party API: api.lpagent.io is guarded by Cloudflare
// (403 even for a real browser), and our server cannot get through to
// Blockscout either. The on-chain path is actually more accurate — see the note on separating fees.
//
// How it works, four stages:
//   1. PositionManager NFT Transfers (from/to indexed) -> list of tokenIds + their live windows
//   2. poolId of each tokenId: from getPoolAndPositionInfo (still alive) or from the mint receipt
//   3. ModifyLiquidity filtered per poolId (poolId is indexed, so cheap) -> all events
//   4. receipt of each tx -> the EXACT token amounts moved between the wallet and the PoolManager
//
// Separating principal vs fee: a withdrawal returns principal + fee mixed in a single
// Transfer. Principal is computed from (L, range, pool price at that time); the rest is fee.
// Deriving the price from token amounts CANNOT be used on a withdrawal because the amounts
// are already contaminated with fees — the price must be taken from the Swap event (which carries sqrtPriceX96,
// and whose tick matched 100% when cross-verified).
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { computePoolId, priceUsable, sqrtClampedToRange } = require('./pools');
const { getLogsSafe } = require('./scout');
const { unclaimedV4, unclaimedV3, feesAtBlock } = require('./fees');
const { WalletV3 } = require('./walletv3');
const { Proceeds } = require('./proceeds');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const ZERO = '0x0000000000000000000000000000000000000000';
const hex = (n) => '0x' + n.toString(16);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const pad32 = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const w32 = (bytes, i) => BigInt(ethers.hexlify(bytes.slice(i * 32, i * 32 + 32)));
const big = (v) => BigInt(v || 0);
const rowKey = (r) => `${r.wallet}:${r.venue}:${r.token_id}`;

class WalletResearch {
  constructor({ rpc, store, chain, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
    this.network = chain.network;
    this.priceCache = new Map();
    // Uniswap v3 has its own path: its NPM events carry the token amounts directly,
    // so its reconstruction differs from v4. A wallet that LPs on v3 used to
    // show EMPTY on the research page because this module only read v4.
    // One scanner per v3 venue (BSC: Uniswap v3 and PancakeSwap v3).
    this.v3s = chain.venues.map((v) => new WalletV3({ rpc, store, chain, log, venue: v.key }));
    this.v3 = this.v3s[0];
    // Follows the non-quote tokens from closing a position until they are really sold.
    this.proceeds = new Proceeds({ rpc, store, chain, research: this, log });
    // The value of an open position just read, per row — see refreshOpen().
    this.liveCache = new Map();
  }

  // ---- pool price at a given block --------------------------------------
  // Main path: read the pool's Slot0 DIRECTLY at the block before the event via an archive node.
  // This is exact — verified by computing the fee two independent ways (from
  // feeGrowthInside in storage vs from "out minus principal"): the result is identical
  // down to the last digit.
  //
  // Fallback: the price from the nearest Swap event. For a memecoin this can be far off —
  // the price moves several percent within a few blocks, and the computed principal can
  // exceed the tokens actually received (impossible), so the result is clamped to a
  // range consistent with the amount received.
  async priceAt(poolId, block) {
    const key = `${poolId}:${block}`;
    if (this.priceCache.has(key)) return this.priceCache.get(key);
    const row = this.store.get('SELECT sqrt_price FROM wprices WHERE chain=? AND pool_ref=? AND block=?', this.network, poolId, block);
    if (row) { const v = BigInt(row.sqrt_price); this.priceCache.set(key, v); return v; }

    if (this.rpc.hasArchive()) {
      try {
        const slot = '0x' + BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder()
          .encode(['bytes32', 'uint256'], [poolId, 6n]))).toString(16).padStart(64, '0');
        const IF_EXT = new ethers.Interface(['function extsload(bytes32) view returns (bytes32)']);
        const w = await this.rpc.callAt(this.chain.ADDR.poolManager, IF_EXT.encodeFunctionData('extsload', [slot]), block - 1);
        const sqrt = BigInt(w) & ((1n << 160n) - 1n);
        if (sqrt > 0n) {
          this.store.run('INSERT OR REPLACE INTO wprices(chain,pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?,?)',
            this.network, poolId, block, sqrt.toString(), block - 1);
          this.priceCache.set(key, sqrt);
          return sqrt;
        }
      } catch (e) { this.log(`harga arsip ${poolId.slice(0, 10)} @${block} gagal: ${e.message}`); }
    }

    // A pool price only changes through a Swap, so the LAST Swap before the event block
    // gives the exact price; a Swap after it is only an estimate, used if there is
    // none before within the window. It used to pick the nearest Swap in either
    // direction.
    let before = null, after = null, init;
    for (const win of [400, 4000, 40000, 400000]) {
      const lo = Math.max(0, block - win);
      let logs = null;
      try {
        logs = await this.rpc.getLogs({
          address: this.chain.ADDR.poolManager, topics: [TOPIC.swapV4, poolId],
          fromBlock: hex(lo), toBlock: hex(block + win),
        });
      } catch { continue; /* rentang terlalu besar / RPC sibuk: coba jendela berikutnya */ }
      for (const l of logs) {
        const bn = parseInt(l.blockNumber, 16);
        const sqrt = w32(ethers.getBytes(l.data), 2);
        if (bn <= block) { if (!before || bn > before.bn) before = { bn, sqrt }; }
        else if (!after || bn < after.bn) after = { bn, sqrt };
      }
      if (before) break;
      // There is no Swap before the event in this window. If the pool was BORN inside the same
      // window, it means it had never been swapped up to the event block —
      // the price is exactly the Initialize price. Real case: 5 target positions in a pool
      // it created itself (Initialize + mint in one block, without a single Swap) were recorded
      // with $0 capital and "profit" equal to their entire principal, and never healed
      // because there really is no Swap that can be found.
      if (init === undefined) init = await this.chain.poolInitOf(poolId, block);
      if (init && init.block >= lo && init.block <= block) {
        before = { bn: init.block, sqrt: init.sqrt };
        break;
      }
    }
    const best = before || after;
    // A failure is NOT cached: usually the RPC is at 429, not a pool without a Swap.
    // Its null used to be remembered for the process lifetime, so later updates for the
    // same pool:block also failed even though the RPC had recovered.
    if (!best) return null;
    this.store.run('INSERT OR REPLACE INTO wprices(chain,pool_ref,block,sqrt_price,src_block) VALUES(?,?,?,?,?)',
      this.network, poolId, block, best.sqrt.toString(), best.bn);
    this.priceCache.set(key, best.sqrt);
    return best.sqrt;
  }

  // ---- stage 1: tokenIds ever held -------------------------------
  async enumerate(wallet, fromBlock, toBlock, onProgress) {
    const p = pad32(wallet);
    const held = new Map();   // tokenId -> {first, last, mintTx, acquiredByMint}
    // A Transfer query filtered by that wallet's address is cheap: the official endpoint answers
    // 900k blocks in 0.34 seconds. Small chunks (formerly 40k) only multiply
    // calls and trigger 429; if a chunk fails, getLogsSafe splits it.
    const chunk = 1_000_000;
    for (let hi = toBlock; hi > fromBlock;) {
      const lo = Math.max(fromBlock, hi - chunk);
      // The in & out directions are scanned together — it used to be sequential and that is what made
      // enumerating 1 day take >14 minutes when the RPC was busy.
      const [logsTo, logsFrom] = await Promise.all([
        getLogsSafe(this.rpc, { address: this.chain.ADDR.posmV4, topics: [TOPIC.transfer, null, p] }, lo, hi),
        getLogsSafe(this.rpc, { address: this.chain.ADDR.posmV4, topics: [TOPIC.transfer, p] }, lo, hi),
      ]);
      for (const logs of [logsTo, logsFrom]) {
        for (const l of logs) {
          const id = BigInt(l.topics[3]).toString();
          const bn = parseInt(l.blockNumber, 16);
          const from = asAddr(l.topics[1]);
          const li = parseInt(l.logIndex, 16);
          const e = held.get(id) || { first: bn, last: bn, mintTx: null, acquiredByMint: false, heldNow: false, lastPos: -1 };
          e.first = Math.min(e.first, bn); e.last = Math.max(e.last, bn);
          // The direction of the LAST Transfer determines whether the NFT is still in this wallet's hands.
          const pos = bn * 1e5 + li;
          if (pos > e.lastPos) { e.lastPos = pos; e.heldNow = asAddr(l.topics[2]) === wallet; }
          if (from === ZERO && asAddr(l.topics[2]) === wallet) { e.mintTx = l.transactionHash; e.acquiredByMint = true; e.first = bn; }
          held.set(id, e);
        }
      }
      if (onProgress) onProgress({ phase: 'transfer', scanned: toBlock - lo, total: toBlock - fromBlock });
      hi = lo - 1;
    }
    return held;
  }

  // ---- stage 2: poolKey of each tokenId ------------------------------
  async poolKeys(ids, held) {
    const out = new Map();
    // alive: straight from the PositionManager
    const res = await this.rpc.ethCallMany(ids.map((id) => ({
      to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(id)]),
    })));
    const needMint = [];
    ids.forEach((id, i) => {
      if (!res[i] || res[i] === '0x') { needMint.push(id); return; }
      try {
        const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', res[i]);
        const pk = {
          currency0: d[0].currency0.toLowerCase(), currency1: d[0].currency1.toLowerCase(),
          fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks.toLowerCase(),
        };
        // a burned position returns a zero poolKey
        if (/^0x0+$/.test(pk.currency1) && pk.fee === 0) { needMint.push(id); return; }
        out.set(id, {
          poolKey: pk, poolId: computePoolId(d[0]),
          tickLower: Number(BigInt.asIntN(24, (d[1] >> 8n) & 0xffffffn)),
          tickUpper: Number(BigInt.asIntN(24, (d[1] >> 32n) & 0xffffffn)),
        });
      } catch { needMint.push(id); }
    });

    // already burned: take it from its mint tx receipt
    const txs = [...new Set(needMint.map((id) => held.get(id)?.mintTx).filter(Boolean))];
    if (txs.length) {
      const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
      const byTx = new Map(txs.map((h, i) => [h, rcs[i] && !rcs[i].error ? rcs[i].result : null]));
      for (const id of needMint) {
        const rc = byTx.get(held.get(id)?.mintTx);
        if (!rc) continue;
        for (const l of rc.logs || []) {
          if (l.topics[0] !== TOPIC.modifyLiquidity) continue;
          const b = ethers.getBytes(l.data);
          if (w32(b, 3).toString() !== id) continue;
          out.set(id, {
            poolId: l.topics[1], poolKey: null, hintBlock: parseInt(l.blockNumber, 16), hintTx: rc.transactionHash,
            tickLower: Number(BigInt.asIntN(24, w32(b, 0))),
            tickUpper: Number(BigInt.asIntN(24, w32(b, 1))),
          });
          break;
        }
      }
    }
    return out;
  }

  // ---- stage 3+4: events of each position --------------------------
  async positionEvents(wallet, id, info, span) {
    const logs = await getLogsSafe(this.rpc,
      { address: this.chain.ADDR.poolManager, topics: [TOPIC.modifyLiquidity, info.poolId] },
      span.first, span.last);
    const mine = [];
    for (const l of logs) {
      const b = ethers.getBytes(l.data);
      if (w32(b, 3).toString() !== id) continue;
      const delta = BigInt.asIntN(256, w32(b, 2));
      // zero delta = a fee claim without changing liquidity. It used to be skipped, although the fee
      // claimed there is part of the position's result.
      if (delta === 0n && !this.rpc.hasArchive()) continue;
      mine.push({
        block: parseInt(l.blockNumber, 16), tx: l.transactionHash,
        logIndex: parseInt(l.logIndex, 16), delta,
        tickLower: Number(BigInt.asIntN(24, w32(b, 0))), tickUpper: Number(BigInt.asIntN(24, w32(b, 1))),
      });
    }
    if (!mine.length) return [];

    // receipt per tx (one tx can contain several events)
    const txs = [...new Set(mine.map((e) => e.tx))];
    const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    const byTx = new Map(txs.map((h, i) => [h, rcs[i] && !rcs[i].error ? rcs[i].result : null]));

    for (const ev of mine) {
      const rc = byTx.get(ev.tx);
      ev.moved = { in0: 0n, in1: 0n, out0: 0n, out1: 0n };
      if (!rc) continue;
      // A single tx that opens/closes SEVERAL positions (a target that spreads capital across
      // 3 ranges at once) has only one Transfer flow for all of them. If it is
      // still used, each position looks like it had the capital of the entire tx — a 1,120 USDG position
      // recorded as 5,600 and a "loss" of 4,480 when it came back whole. For such a tx the
      // Transfers cannot be separated, so they are left empty and the fallback path
      // uses principal from L & price (the fee withdrawn along with it is unreadable there;
      // the archive path is unaffected because it does not depend on Transfers).
      const nLiq = (rc.logs || []).filter((l) => l.address.toLowerCase() === this.chain.ADDR.poolManager
        && l.topics[0] === TOPIC.modifyLiquidity && BigInt.asIntN(256, w32(ethers.getBytes(l.data), 2)) !== 0n).length;
      ev.shared = nLiq > 1;
      if (ev.shared) continue;
      const c0 = info.poolKey?.currency0, c1 = info.poolKey?.currency1;
      for (const l of rc.logs || []) {
        if (l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
        const tok = l.address.toLowerCase();
        const from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
        const amt = BigInt(l.data);
        const side = tok === c0 ? 0 : tok === c1 ? 1 : null;
        if (side === null) continue;
        // flow between the wallet (or its router) and the PoolManager
        if (to === this.chain.ADDR.poolManager) ev.moved[side === 0 ? 'in0' : 'in1'] += amt;
        else if (from === this.chain.ADDR.poolManager) ev.moved[side === 0 ? 'out0' : 'out1'] += amt;
      }
      // native ETH has no ERC20 Transfer — use the tx's value
      if (c0 === this.chain.ADDR.native) {
        const tx = await this.rpc.call('eth_getTransactionByHash', [ev.tx]).catch(() => null);
        if (tx && BigInt(tx.value || 0) > 0n && ev.delta > 0n) ev.moved.in0 += BigInt(tx.value);
      }
    }
    return mine;
  }

  // ---- combine into one position -----------------------------------
  async buildPosition(wallet, id, info, span, ethUsd) {
    // The poolKey MUST be resolved FIRST. Matching ERC20 Transfers in
    // positionEvents needs both token addresses; if the order is reversed,
    // the "out" side never matches and EVERY closed position looks like it lost
    // its entire capital — the in side stays correct because it has a fallback
    // principal computation, so the bug disguised itself as "all positions red".
    if (!info.poolKey) {
      info.poolKey = await this.chain.poolKeyOfId(info.poolId, info.hintBlock || span.first, info.hintTx);
    }
    const events = await this.positionEvents(wallet, id, info, span);
    if (!events.length) return null;

    const toks = info.poolKey
      ? await this.chain.tokens([info.poolKey.currency0, info.poolKey.currency1])
      : null;
    const d0 = toks?.[0]?.decimals ?? 18, d1 = toks?.[1]?.decimals ?? 18;
    const q = info.poolKey ? this.chain.quoteSideOf(info.poolKey.currency0, info.poolKey.currency1) : null;

    const agg = { in0: 0n, in1: 0n, out0: 0n, out1: 0n, fee0: 0n, fee1: 0n };
    let investedQ = 0, returnedQ = 0, feesQ = 0;
    const rows = [];
    let liq = 0n;
    let withoutPrice = false;   // there is an event whose price is unreadable (see the fallback path)

    for (const ev of events.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
      const abs = ev.delta < 0n ? -ev.delta : ev.delta;
      const sa = m.getSqrtRatioAtTick(ev.tickLower), sb = m.getSqrtRatioAtTick(ev.tickUpper);

      // ---- exact path: pool & position state at the block before the event (archive node) ----
      // Does not depend on Transfers, so it is immune to the flash accounting netting
      // on automatic rebalances (close + open in one transaction).
      let exact = null;
      if (this.rpc.hasArchive()) {
        try {
          exact = await feesAtBlock(this.chain, {
            poolId: info.poolId, tickLower: ev.tickLower, tickUpper: ev.tickUpper, tokenId: id, block: ev.block,
          }, this.rpc);
        } catch (e) { this.log(`fee arsip #${id} @${ev.block} gagal: ${e.message}`); }
      }
      if (exact) {
        // A pool swept empty puts the price at the min/max tick — clamped to the range
        // edge, otherwise the memecoin fee is valued at "$1e55" (a real case of 4 target positions).
        const sqrtE = sqrtClampedToRange(exact.sqrtPriceX96, sa, sb);
        const pr = m.amountsForLiquidity(sqrtE, sa, sb, abs);
        const valE = (a0, a1) => {
          if (!q) return 0;
          const v = this.chain.valueInQuote({
            sqrtPriceX96: sqrtE, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
            token0: info.poolKey.currency0, token1: info.poolKey.currency1,
          });
          return v ? v.value : 0;
        };
        const fv = valE(exact.fee0, exact.fee1);
        feesQ += fv;
        agg.fee0 += exact.fee0; agg.fee1 += exact.fee1;
        let kindE;
        if (ev.delta > 0n) {
          kindE = liq === 0n ? 'mint' : 'increase';
          agg.in0 += pr.amount0; agg.in1 += pr.amount1;
          investedQ += valE(pr.amount0, pr.amount1);
          returnedQ += fv;                    // fees owed are also paid out when adding
        } else if (ev.delta < 0n) {
          kindE = 'decrease';
          agg.out0 += pr.amount0 + exact.fee0; agg.out1 += pr.amount1 + exact.fee1;
          returnedQ += valE(pr.amount0, pr.amount1) + fv;
        } else {
          kindE = 'collect';
          agg.out0 += exact.fee0; agg.out1 += exact.fee1;
          returnedQ += fv;
        }
        liq += ev.delta;
        if (liq < 0n) liq = 0n;
        rows.push({
          block: ev.block, tx: ev.tx, logIndex: ev.logIndex, kind: kindE, delta: ev.delta,
          moved: ev.moved, princ: pr, fee0: exact.fee0, fee1: exact.fee1, sqrt: sqrtE,
          valueQ: valE(pr.amount0, pr.amount1) + (ev.delta > 0n ? 0 : fv),
          tickLower: ev.tickLower, tickUpper: ev.tickUpper,
        });
        continue;
      }
      if (ev.delta === 0n) continue;           // the fallback cannot value fee claims

      // ---- fallback path: price from the nearest Swap + amounts from Transfers ----
      let sqrt = sqrtClampedToRange(await this.priceAt(info.poolId, ev.block), sa, sb);
      // Without a price, this event cannot be valued at all. It used to be recorded as zero,
      // so a mint that happened to be read while the RPC was at 429 looked like it had $0 capital and
      // its withdrawal became "profit" equal to the entire principal. Flagged so it is not
      // included in the summary and is re-read on the next update.
      if (!sqrt) withoutPrice = true;
      let princ = { amount0: 0n, amount1: 0n };
      if (sqrt) {
        princ = m.amountsForLiquidity(sqrt, sa, sb, abs);
        // Safeguard: principal cannot exceed what really came out. If that
        // happens, the price is wrong (usually a fallback price from a distant Swap) —
        // shift to the bound price that makes principal = what was received on that side.
        if (ev.delta < 0n && (ev.moved.out0 > 0n || ev.moved.out1 > 0n)) {
          if (princ.amount0 > ev.moved.out0 && ev.moved.out0 > 0n) {
            // too much token0 -> the price is too low; raise it until a0 = out0
            const s2 = (abs * m.Q96 * sb) / (ev.moved.out0 * sb + abs * m.Q96);
            if (s2 > sa && s2 < sb) sqrt = s2;
          } else if (princ.amount1 > ev.moved.out1 && ev.moved.out1 > 0n) {
            const s2 = sa + (ev.moved.out1 * m.Q96) / abs;
            if (s2 > sa && s2 < sb) sqrt = s2;
          }
          princ = m.amountsForLiquidity(sqrt, sa, sb, abs);
        }
      }
      const val = (a0, a1) => {
        if (!sqrt || !q) return 0;
        const v = this.chain.valueInQuote({
          sqrtPriceX96: sqrt, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
          token0: info.poolKey.currency0, token1: info.poolKey.currency1,
        });
        return v ? v.value : 0;
      };

      let f0 = 0n, f1 = 0n, kind;
      if (ev.delta > 0n) {
        kind = liq === 0n ? 'mint' : 'increase';
        agg.in0 += ev.moved.in0; agg.in1 += ev.moved.in1;
        investedQ += val(ev.moved.in0 || princ.amount0, ev.moved.in1 || princ.amount1);
      } else {
        // What comes out = principal + fee. Principal is computed from L & price; the rest is fee.
        // Fallback: if Transfers are unreadable, at least the principal is known
        // from L + price — better than recording zero and showing the position
        // as a total loss.
        const got0 = ev.moved.out0 > 0n ? ev.moved.out0 : princ.amount0;
        const got1 = ev.moved.out1 > 0n ? ev.moved.out1 : princ.amount1;
        f0 = got0 > princ.amount0 ? got0 - princ.amount0 : 0n;
        f1 = got1 > princ.amount1 ? got1 - princ.amount1 : 0n;
        agg.out0 += got0; agg.out1 += got1;
        agg.fee0 += f0; agg.fee1 += f1;
        returnedQ += val(got0, got1);
        feesQ += val(f0, f1);
        kind = 'decrease';
      }
      liq += ev.delta;
      if (liq < 0n) liq = 0n;

      rows.push({
        block: ev.block, tx: ev.tx, logIndex: ev.logIndex, kind, delta: ev.delta,
        moved: ev.moved, princ, fee0: f0, fee1: f1, sqrt,
        valueQ: !sqrt ? null : val(ev.delta > 0n ? (ev.moved.in0 || princ.amount0) : (ev.moved.out0 || princ.amount0),
          ev.delta > 0n ? (ev.moved.in1 || princ.amount1) : (ev.moved.out1 || princ.amount1)),
      });
    }

    const first = rows[0], last = rows[rows.length - 1];
    const closed = liq === 0n;

    // A still-open position has not returned anything yet, so "returned" from
    // history = 0. Its PnL is not minus the entire capital — it is the position value
    // NOW plus unclaimed fees, minus capital.
    let liveValueQ = 0, liveFeeQ = 0, inRange = null, curTick = null;
    if (!closed && info.poolKey) {
      const s0 = await this.chain.slot0V4(info.poolId);
      if (s0) {
        curTick = s0.tick;
        const tl = info.tickLower ?? first.tickLower, tu = info.tickUpper ?? first.tickUpper;
        const sa0 = m.getSqrtRatioAtTick(tl), sb0 = m.getSqrtRatioAtTick(tu);
        inRange = m.sideOfRange(s0.tick, tl, tu) === 'both';
        const amt = m.amountsForLiquidity(s0.sqrtPriceX96, sa0, sb0, liq);
        // Marking price: the pool's own if its active liquidity is > 0 and not at the
        // bound; otherwise another pool of the same pair; last, the range edge.
        let mark = s0.sqrtPriceX96;
        if (!priceUsable(s0, await this.chain.poolLiquidity(info.poolId).catch(() => 0n))) {
          const alt = await this.chain.markSqrtForPair(info.poolKey.currency0, info.poolKey.currency1, info.poolId);
          mark = alt ? alt.sqrtPriceX96 : sqrtClampedToRange(s0.sqrtPriceX96, sa0, sb0);
        }
        const vq = (a0, a1) => {
          const v = this.chain.valueInQuote({
            sqrtPriceX96: mark, amount0: a0, amount1: a1, dec0: d0, dec1: d1,
            token0: info.poolKey.currency0, token1: info.poolKey.currency1,
          });
          return v ? v.value : 0;
        };
        liveValueQ = vq(amt.amount0, amt.amount1);
        try {
          const [f] = await unclaimedV4(this.chain,
            [{ poolId: info.poolId, tickLower: tl, tickUpper: tu, tokenId: id }],
            new Map([[info.poolId, s0.tick]]), this.rpc);
          if (f) liveFeeQ = vq(f.fee0, f.fee1);
        } catch { /* fee unreadable: leave 0 */ }
      }
    }
    // An open position that has already partially withdrawn: that withdrawal result (returnedQ)
    // is already in the pocket and must be counted — otherwise profit that was already
    // claimed becomes invisible while the position is still running.
    const pnlQ = closed ? (returnedQ - investedQ) : (liveValueQ + liveFeeQ + returnedQ - investedQ);
    // History can be truncated if the position existed before the scan window:
    // the first event seen is not a mint -> its initial capital is unknown (1).
    // Or the price of one of its events was not readable at scan time (2) — this one
    // heals itself: refresh() reads it again.
    const incomplete = first.kind !== 'mint' ? 1 : withoutPrice ? 2 : 0;
    // Unknown capital is not zero. It used to be counted as it was: a mint without a
    // price recorded $0 capital and its closing showed "profit" equal to the entire
    // principal ($1,000 in, $1,000 out, PnL +$1,000). Now its capital & PnL are
    // empty (NULL, shown "—") until its history is complete; the wallet summary has
    // long ignored it via `incomplete`.

    return {
      wallet, venue: 'v4', tokenId: id, poolId: info.poolId, poolKey: info.poolKey,
      tickLower: info.tickLower ?? first.tickLower ?? null,
      tickUpper: info.tickUpper ?? first.tickUpper ?? null,
      liquidity: liq, agg,
      investedQ: incomplete ? null : investedQ, returnedQ, feesQ, pnlQ: incomplete ? null : pnlQ,
      liveValueQ, liveFeeQ, inRange, curTick,
      quoteSymbol: q?.symbol || null, quoteKind: q?.kind || 'usd',
      openedBlock: first.block, closedBlock: closed ? last.block : null,
      status: closed ? 'closed' : 'open',
      events: rows,
      symbol0: toks?.[0]?.symbol || '?', symbol1: toks?.[1]?.symbol || '?',
      dec0: d0, dec1: d1,
      incomplete,
    };
  }

  // ---- full scan ---------------------------------------------------
  // A position that is already CLOSED and complete (its NFT no longer held, all
  // its events valued) will not change again — re-reading it from the chain
  // only produces the same figures at the cost of hundreds of RPC calls. A full
  // scan uses its stored row; `force` forces everything to be rebuilt
  // (used after a formula fix, via the API).
  async scan(wallet, { blocks = 900_000, ethUsd = 2500, onProgress, force = false } = {}) {
    wallet = wallet.toLowerCase();
    const head = await this.rpc.blockNumber();
    const from = Math.max(0, head - blocks);
    const held = await this.enumerate(wallet, from, head, onProgress);
    const reuse = new Set();
    if (!force) {
      for (const r of this.store.all(
        `SELECT token_id FROM wpositions WHERE chain=? AND wallet=? AND venue='v4' AND status='closed'
           AND incomplete=0 AND token0 IS NOT NULL AND events_n > 0`, this.network, wallet)) {
        const span = held.get(r.token_id);
        if (span && !span.heldNow) reuse.add(r.token_id);
      }
      if (reuse.size) this.log(`riset ${wallet.slice(0, 10)}…: ${reuse.size} posisi tertutup dipakai dari simpanan`);
    }
    const ids = [...held.keys()].filter((id) => !reuse.has(id));
    const out = [];
    // No v4 positions does NOT mean this wallet does not LP: many play
    // only v3. There used to be an early return here, so the v3 path was never
    // run and its research page was empty although the wallet was active.
    const infos = ids.length ? await this.poolKeys(ids, held) : new Map();
    let done = 0;
    for (const id of ids) {
      const info = infos.get(id);
      done++;
      if (onProgress) onProgress({ phase: 'posisi', scanned: done, total: ids.length });
      if (!info) continue;
      const span = held.get(id);
      try {
        // A position still held is read up to the head. It used to stop at the last Transfer
        // + 5 blocks, so additions, partial withdrawals, and fee claims
        // AFTER the mint were never read — Transfers only appear on mint/burn/change of
        // hands, whereas ModifyLiquidity can happen any time in between.
        const last = span.heldNow ? head : Math.min(head, span.last + 5);
        const pos = await this.buildPosition(wallet, id, info, { first: span.first, last }, ethUsd);
        if (pos) out.push(pos);
      } catch (e) { this.log(`posisi ${id} gagal: ${e.message}`); }
    }
    out.push(...await this.scanV3(wallet, { from, head, ethUsd, onProgress }));
    await this.persist(wallet, out, { from, head, ethUsd, keep: reuse });
    return { wallet, positions: out, head, from, reused: reuse.size };
  }

  // A failure in the v3 path must not bring down the v4 result already collected.
  async scanV3(wallet, opts) {
    const out = [];
    for (const v3 of this.v3s) {
      try { out.push(...await v3.scan(wallet, opts)); }
      catch (e) { this.log(`riset ${v3.venue} ${wallet.slice(0, 10)}…: ${e.message}`); }
    }
    return out;
  }

  // ---- incremental update ---------------------------------------------------
  // A full scan rebuilds ALL positions in the window — for an active wallet that is
  // hundreds of positions and a few minutes. Yet since the last scan only two kinds
  // have changed: positions touched by a Transfer since the last block (newly opened,
  // burned, changed hands) and positions still open (running value & fee,
  // or closed without a burn, which produces no Transfer). Only those are read.
  async refresh(wallet, { ethUsd = 2500, onProgress } = {}) {
    wallet = wallet.toLowerCase();
    const w = this.store.get('SELECT first_block, scanned_to FROM wallets WHERE chain=? AND address=?', this.network, wallet);
    if (!w || w.scanned_to == null) return this.scan(wallet, { ethUsd, onProgress });
    const head = await this.rpc.blockNumber();
    // Overlap of 2,000 blocks (~3 minutes): safe against blocks that were indexed late.
    const from = Math.max(w.first_block || 0, w.scanned_to - 2000);
    const held = await this.enumerate(wallet, from, head, onProgress);

    const known = new Map(this.store.all(
      'SELECT token_id, opened_block, closed_block, status, incomplete, pool_ref, token0, token1, fee, tick_spacing, hooks, tick_lower, tick_upper FROM wpositions WHERE chain=? AND wallet=?',
      this.network, wallet).map((r) => [r.token_id, r]));
    for (const [id, r] of known) {
      if (r.status === 'open' && !held.has(id)) {
        held.set(id, { first: r.opened_block ?? from, last: head, mintTx: null, acquiredByMint: false, heldNow: true });
      }
      // A position whose price was unreadable at scan time (RPC 429) is re-read
      // until its value is filled — otherwise its $0 capital would stay forever.
      if (r.incomplete === 2 && !held.has(id) && r.opened_block != null) {
        held.set(id, {
          first: r.opened_block, last: r.closed_block != null ? Math.min(head, r.closed_block + 5) : head,
          mintTx: null, acquiredByMint: true, heldNow: r.status === 'open',
        });
      }
    }
    // An old position touched again is read from its opening, not from the start of this
    // window — otherwise its capital is lost and the position becomes "incomplete".
    for (const [id, e] of held) {
      const r = known.get(id);
      if (r?.opened_block != null) e.first = Math.min(e.first, r.opened_block);
    }
    const ids = [...held.keys()];
    const infos = ids.length ? await this.poolKeys(ids, held) : new Map();
    // A burned NFT cannot be asked of the PositionManager, and its mint tx
    // may be outside this window — its poolKey was already stored from the earlier scan.
    for (const id of ids) {
      const r = known.get(id);
      if (infos.has(id) || !r?.pool_ref || !r.token0) continue;
      infos.set(id, {
        poolId: r.pool_ref, tickLower: r.tick_lower, tickUpper: r.tick_upper,
        poolKey: { currency0: r.token0, currency1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks },
      });
    }
    const out = [];
    let done = 0;
    for (const id of ids) {
      const info = infos.get(id);
      done++;
      if (onProgress) onProgress({ phase: 'posisi', scanned: done, total: ids.length });
      if (!info) continue;
      const span = held.get(id);
      try {
        const last = span.heldNow ? head : Math.min(head, span.last + 5);
        const pos = await this.buildPosition(wallet, id, info, { first: span.first, last }, ethUsd);
        if (pos) out.push(pos);
      } catch (e) { this.log(`posisi ${id} gagal: ${e.message}`); }
    }
    // v3 research is cheap (only a few queries), so even the incremental update reads it
    // from the start of history — there is no partial state to maintain there.
    out.push(...await this.scanV3(wallet, { from: w.first_block || 0, head, ethUsd, onProgress }));
    await this.persist(wallet, out, { from, head, ethUsd, partial: true });
    return { wallet, positions: out, head, from, refreshed: out.length };
  }

  // ---- value of open positions, at the current price -----------------------
  // A wpositions row is only rewritten when its wallet is scanned, and scanning is
  // only triggered by the Wallet/Target page or a new action of the target. A position
  // still open can therefore show a value from the last scan —
  // for a target that stays quiet for hours, that is a photo from a few seconds after it minted.
  // On the Pool/Token page that figure sits beside the bot position, recomputed
  // every 30 seconds, so the SAME pool with the SAME range can read
  // profit in one table and loss in the neighbouring table.
  //
  // What is stale is only the market value and the running fee; the capital and already withdrawn
  // proceeds do not change without a new on-chain event. So only those two are re-read
  // here. `rows` is mutated in place (live_value_q, live_fee_q, pnl_q,
  // in_range, curTick, liveTs) and the result is also written to the DB so the wallet
  // summary does not differ from the table contents.
  //
  // A short per-row cache keeps a page polled every few seconds
  // frugal: one read is shared by all pages until it expires.
  async refreshOpen(rows, ethUsd, { ttlMs = 15_000 } = {}) {
    const open = rows.filter((r) => r.status === 'open' && r.pool_ref && r.token0 && r.token1);
    if (!open.length) return;
    const now = Date.now();
    const fresh = open.filter((r) => now - (this.liveCache.get(rowKey(r))?.ts || 0) >= ttlMs);

    // Decimals determine the price; a row that arrives without decimals (a caller that did not
    // decorate it) would be valued with a figure wrong by a power of ten if left alone.
    const need = fresh.filter((r) => r.dec0 == null || r.dec1 == null);
    if (need.length) {
      const toks = new Map(this.store.all('SELECT address,decimals FROM tokens WHERE chain=?', this.network).map((t) => [t.address, t.decimals]));
      for (const r of need) {
        r.dec0 ??= toks.get(r.token0) ?? this.chain.QUOTES[r.token0]?.decimals ?? 18;
        r.dec1 ??= toks.get(r.token1) ?? this.chain.QUOTES[r.token1]?.decimals ?? 18;
      }
    }

    // Pool price: v4 one batch (pool_ref = poolId in PoolManager storage), v3 one by
    // one (pool_ref = its pool contract address).
    const slotBy = new Map(), poolLiqBy = new Map();
    const idV4 = [...new Set(fresh.filter((r) => !this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))];
    if (idV4.length) {
      try {
        const [s, pl] = await Promise.all([this.chain.slot0V4Many(idV4), this.chain.poolLiquidityMany(idV4).catch(() => [])]);
        idV4.forEach((id, i) => { if (s[i]) { slotBy.set(id, s[i]); poolLiqBy.set(id, pl[i] ?? 0n); } });
      } catch (e) { this.log(`nilai posisi terbuka: harga v4 gagal: ${e.message}`); }
    }
    for (const a of [...new Set(fresh.filter((r) => this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))]) {
      try {
        const s = await this.chain.slot0V3(a);
        if (s) slotBy.set(a, s);
      } catch { /* one failing pool does not take down the rest */ }
    }

    // Running fee: v4 from PoolManager storage (one batch, also carrying the current
    // L), v3 simulated via collect and must be per owner.
    const feeBy = new Map();
    const v4 = fresh.filter((r) => !this.chain.isV3Venue(r.venue) && slotBy.has(r.pool_ref));
    if (v4.length) {
      try {
        const curTick = new Map([...slotBy.entries()].map(([k, s]) => [k, s.tick]));
        const f = await unclaimedV4(this.chain,
          v4.map((r) => ({ poolId: r.pool_ref, tickLower: r.tick_lower, tickUpper: r.tick_upper, tokenId: r.token_id })),
          curTick, this.rpc);
        v4.forEach((r, i) => { if (f[i]) feeBy.set(rowKey(r), f[i]); });
      } catch (e) { this.log(`nilai posisi terbuka: fee v4 gagal: ${e.message}`); }
    }
    const byOwner = new Map();   // `${owner}|${venue}` -> row (each v3 venue has its own NPM)
    for (const r of fresh) {
      if (!this.chain.isV3Venue(r.venue) || !slotBy.has(r.pool_ref)) continue;
      const k = `${r.wallet}|${r.venue}`;
      if (!byOwner.has(k)) byOwner.set(k, []);
      byOwner.get(k).push(r);
    }
    for (const [k, list] of byOwner) {
      const [owner, venue] = k.split('|');
      try {
        const f = await unclaimedV3(this.chain, list.map((r) => BigInt(r.token_id)), owner, this.chain.npmFor(venue), this.rpc);
        list.forEach((r, i) => { if (f[i]) feeBy.set(rowKey(r), f[i]); });
      } catch { /* fee unreadable: use the stored one */ }
    }

    for (const r of fresh) {
      const s = slotBy.get(r.pool_ref);
      if (!s) continue;
      const f = feeBy.get(rowKey(r));
      // The L from storage is newer than the L from the scan. If already zero, the position was
      // closed after the last scan: its value really is 0, but its close proceeds
      // have not been read yet — writing it now makes the position look like a total loss.
      // Leave the old figure until the scanner corrects it.
      const L = f?.liquidity != null ? f.liquidity : big(r.liquidity);
      if (L <= 0n) continue;
      const sa = m.getSqrtRatioAtTick(r.tick_lower), sb = m.getSqrtRatioAtTick(r.tick_upper);
      const amt = m.amountsForLiquidity(s.sqrtPriceX96, sa, sb, L);
      // Marking price: the pool's own if fit (v3's liquidity is not read — a price
      // at the bound is still caught via the clamp); otherwise another pool of the
      // same pair; last, the position's range edge.
      let mark = s.sqrtPriceX96;
      if (!priceUsable(s, this.chain.isV3Venue(r.venue) ? 1n : (poolLiqBy.get(r.pool_ref) ?? 0n))) {
        const alt = await this.chain.markSqrtForPair(r.token0, r.token1, r.pool_ref);
        mark = alt ? alt.sqrtPriceX96 : sqrtClampedToRange(s.sqrtPriceX96, sa, sb);
      }
      // Values in wpositions are always USD (see persist), so the ETH quote side is multiplied by
      // the ETH price here too.
      const vq = (a0, a1) => {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: mark, amount0: a0, amount1: a1,
          dec0: r.dec0, dec1: r.dec1, token0: r.token0, token1: r.token1,
        });
        return v ? v.value * (v.kind === 'eth' ? ethUsd : 1) : null;
      };
      const value = vq(amt.amount0, amt.amount1);
      if (value == null) continue;                       // a pool without a quote side: cannot be valued
      const fee = f ? (vq(f.fee0, f.fee1) ?? 0) : (r.live_fee_q || 0);
      const inRange = m.sideOfRange(s.tick, r.tick_lower, r.tick_upper) === 'both';
      this.liveCache.set(rowKey(r), { ts: now, value, fee, tick: s.tick, inRange });
      this.store.run(
        'UPDATE wpositions SET live_value_q=?, live_fee_q=?, pnl_q=?, in_range=? WHERE chain=? AND wallet=? AND venue=? AND token_id=?',
        value, fee, livePnl(r, value, fee), inRange ? 1 : 0,
        this.network, r.wallet, r.venue, r.token_id);
    }

    // Rows still covered by the cache also use the same figures — including ones whose
    // read just failed, which still hold the stored value without liveTs.
    for (const r of open) {
      const c = this.liveCache.get(rowKey(r));
      if (!c) continue;
      r.live_value_q = c.value;
      r.live_fee_q = c.fee;
      r.in_range = c.inRange ? 1 : 0;
      r.curTick = c.tick;
      r.pnl_q = livePnl(r, c.value, c.fee);
      r.liveTs = c.ts;
    }
  }

  // The summary is computed from ALL stored rows, not just the positions just
  // read: after an incremental update only a handful of positions are read, and a
  // rescan with a shorter window does not delete positions outside its window.
  // This way the summary figures always equal the table contents.
  statsFromDb(wallet) {
    const rows = this.store.all(
      'SELECT status, incomplete, pnl_q, invested_q, fees_q, live_value_q, live_fee_q, held_tok, unrealized_q FROM wpositions WHERE chain=? AND wallet=?', this.network, wallet);
    // The values in the DB are already in USD when stored, so quoteKind 'usd'.
    return summarize(rows.map((r) => ({
      status: r.status, incomplete: !!r.incomplete, quoteKind: 'usd',
      pnlQ: r.pnl_q || 0, investedQ: r.invested_q || 0, feesQ: r.fees_q || 0,
      liveValueQ: r.live_value_q || 0, liveFeeQ: r.live_fee_q || 0,
      heldUnrealizedQ: r.held_tok && r.held_tok !== '0' ? (r.unrealized_q || 0) : 0,
    })));
  }

  // ---- persist ------------------------------------------------------
  async persist(wallet, positions, { from, head, ethUsd, partial = false, keep: reuse = null }) {
    // NULL = unknown (capital of a position whose history is incomplete) — not 0.
    const usd = (v, kind) => (v == null ? null : kind === 'eth' ? v * ethUsd : v);
    // Drop old scan leftovers inside this window that no longer appear (e.g. the result of a
    // scan that failed midway: positions with no token pair and all zeros).
    // Positions outside this window are left — a shorter scan must not
    // delete the result of a longer scan. `keep` = closed positions that were
    // deliberately not re-read (scan) — their rows stay.
    const keep = new Set([...positions.map((p) => p.tokenId), ...(reuse || [])]);
    // An incremental update only reads some positions — "no longer appears" there
    // does not mean stale.
    const stale = partial ? [] : this.store.all(
      'SELECT token_id FROM wpositions WHERE chain=? AND wallet=? AND (opened_block IS NULL OR opened_block >= ?)', this.network, wallet, from)
      .map((r) => r.token_id).filter((id) => !keep.has(id));
    // A row without a token pair = a scan leftover that failed midway; it cannot
    // be valued and only shows as "?/?" worth zero wherever it sits.
    const broken = this.store.all('SELECT token_id FROM wpositions WHERE chain=? AND wallet=? AND token0 IS NULL', this.network, wallet)
      .map((r) => r.token_id).filter((id) => !keep.has(id));
    for (const id of [...stale, ...broken]) {
      this.store.run('DELETE FROM wpositions WHERE chain=? AND wallet=? AND token_id=?', this.network, wallet, id);
      this.store.run('DELETE FROM wevents WHERE chain=? AND wallet=? AND token_id=?', this.network, wallet, id);
    }
    // Time estimated from the block number (RH chain blocks ~0.101 seconds) — used to
    // group profit per day in the calendar.
    const tsOf = async (b) => (b == null ? null : await this.chain.blockTs(b));
    for (const p of positions) {
      const openedTs = await tsOf(p.openedBlock);
      const closedTs = await tsOf(p.closedBlock);
      this.store.run(
        `INSERT OR REPLACE INTO wpositions
         (chain,wallet,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
          in0,in1,out0,out1,fee0,fee1,invested_q,returned_q,fees_q,pnl_q,quote_symbol,
          opened_block,opened_ts,closed_block,closed_ts,status,events_n,incomplete,
          live_value_q,live_fee_q,in_range)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.network, wallet, p.venue, p.tokenId, p.poolId,
        p.poolKey?.currency0 ?? null, p.poolKey?.currency1 ?? null, p.poolKey?.fee ?? null,
        p.poolKey?.tickSpacing ?? null, p.poolKey?.hooks ?? null,
        p.tickLower, p.tickUpper, p.liquidity.toString(),
        p.agg.in0.toString(), p.agg.in1.toString(), p.agg.out0.toString(), p.agg.out1.toString(),
        p.agg.fee0.toString(), p.agg.fee1.toString(),
        usd(p.investedQ, p.quoteKind), usd(p.returnedQ, p.quoteKind), usd(p.feesQ, p.quoteKind), usd(p.pnlQ, p.quoteKind),
        p.quoteSymbol, p.openedBlock, openedTs, p.closedBlock, closedTs, p.status, p.events.length, Number(p.incomplete) || 0,
        usd(p.liveValueQ || 0, p.quoteKind), usd(p.liveFeeQ || 0, p.quoteKind),
        p.inRange == null ? null : (p.inRange ? 1 : 0));
      p.openedTs = openedTs; p.closedTs = closedTs;

      for (const e of p.events) {
        e.ts = await tsOf(e.block);
        this.store.run(
          `INSERT OR REPLACE INTO wevents
           (chain,wallet,token_id,block,ts,tx_hash,log_index,kind,liq_delta,amount0,amount1,princ0,princ1,fee0,fee1,sqrt_price,value_q)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          this.network, wallet, p.tokenId, e.block, e.ts, e.tx, e.logIndex, e.kind, e.delta.toString(),
          (e.delta > 0n ? e.moved.in0 : e.moved.out0).toString(),
          (e.delta > 0n ? e.moved.in1 : e.moved.out1).toString(),
          e.princ.amount0.toString(), e.princ.amount1.toString(),
          e.fee0.toString(), e.fee1.toString(),
          e.sqrt ? e.sqrt.toString() : null, usd(e.valueQ, p.quoteKind));
      }
    }
    // A freshly closed position: separate what has become money from tokens still
    // held. A failure here must not cancel the scan result.
    try { await this.proceeds.track(wallet, { head, ethUsd }); }
    catch (e) { this.log(`lacak hasil ${wallet.slice(0, 10)}…: ${e.message}`); }
    const stats = this.statsFromDb(wallet);
    this.store.run(
      `INSERT INTO wallets(chain,address,first_block,scanned_to,last_scan_ts,stats,positions_n) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(chain,address) DO UPDATE SET first_block=MIN(first_block,excluded.first_block),
         scanned_to=MAX(scanned_to,excluded.scanned_to), last_scan_ts=excluded.last_scan_ts,
         stats=excluded.stats, positions_n=excluded.positions_n`,
      this.network, wallet, from, head, Date.now(), JSON.stringify(stats), stats.positionsTotal);
    return stats;
  }
}

// Running PnL of an open position. NULL capital = unknown (incomplete history),
// and its PnL is also unknown — not "current value minus zero".
const livePnl = (r, value, fee) => (r.invested_q == null ? null : value + fee + (r.returned_q || 0) - r.invested_q);

// ---- summary ------------------------------------------------------
function summarize(positions, ethUsd = 2500) {
  const usd = (v, kind) => (kind === 'eth' ? v * ethUsd : v);
  const closed = positions.filter((p) => p.status === 'closed' && !p.incomplete);
  const open = positions.filter((p) => p.status === 'open');
  const pnls = closed.map((p) => usd(p.pnlQ, p.quoteKind));
  // 1 cent threshold: a PnL of -0.0000001 from float rounding is not a loss.
  const wins = pnls.filter((x) => x > 0.01).length;
  const decided = pnls.filter((x) => Math.abs(x) > 0.01).length;
  const invested = closed.reduce((s, p) => s + usd(p.investedQ, p.quoteKind), 0);
  return {
    positionsTotal: positions.length,
    openCount: open.length,
    closedCount: closed.length,
    incompleteCount: positions.filter((p) => p.incomplete).length,
    totalProfitUsd: pnls.reduce((s, x) => s + x, 0),
    // The part of total profit that is still tokens from closing a position not yet
    // sold — moves with the price until the wallet swaps them.
    heldUnrealizedUsd: closed.reduce((s, p) => s + usd(p.heldUnrealizedQ || 0, p.quoteKind), 0),
    unrealizedUsd: open.reduce((s, p) => s + usd(p.pnlQ || 0, p.quoteKind), 0),
    openValueUsd: open.reduce((s, p) => s + usd(p.liveValueQ || 0, p.quoteKind), 0),
    openFeeUsd: open.reduce((s, p) => s + usd(p.liveFeeQ || 0, p.quoteKind), 0),
    feeEarnedUsd: positions.reduce((s, p) => s + usd(p.feesQ, p.quoteKind) + usd(p.liveFeeQ || 0, p.quoteKind), 0),
    winRatePct: decided ? (wins / decided) * 100 : 0,
    avgInvestedUsd: closed.length ? invested / closed.length : 0,
    expectedValueUsd: closed.length ? pnls.reduce((s, x) => s + x, 0) / closed.length : 0,
    bestUsd: pnls.length ? Math.max(...pnls) : 0,
    worstUsd: pnls.length ? Math.min(...pnls) : 0,
  };
}

module.exports = { WalletResearch, summarize };
