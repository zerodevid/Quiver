'use strict';
// Followers of a wallet: who opens an LP in the same pool within seconds after it does.
//
// Input is the wallet's own research (wpositions): each recent open gives a pool and a block.
// For each one, two getLogs over [open block, open block + window]:
//   - liquidity added to that pool (v4 ModifyLiquidity filtered by poolId / v3 pool Mint)
//   - position NFTs minted on the position manager (Transfer from 0x0), which give the owner
// joined by tx hash. A copier shows up across many of the wallet's opens, always a few
// seconds behind it — the meovv rug cluster was exactly this pattern.
const { ethers } = require('ethers');
const { TOPIC } = require('./chain');
const { getLogsSafe } = require('./scout');

const ZERO32 = '0x' + '0'.repeat(64);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
const w32 = (bytes, i) => BigInt(ethers.hexlify(bytes.slice(i * 32, i * 32 + 32)));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

// Wallets that added liquidity to `poolRef` in [lo, hi], with the first block each one did it.
async function entrantsOf(rpc, chain, { venue, poolRef }, lo, hi) {
  const v4 = venue === 'v4';
  const manager = (v4 ? chain.ADDR.posmV4 : chain.npmFor(venue)).toLowerCase();
  const [adds, mints] = await Promise.all([
    v4
      ? getLogsSafe(rpc, { address: chain.ADDR.poolManager, topics: [TOPIC.modifyLiquidity, poolRef] }, lo, hi)
      : getLogsSafe(rpc, { address: poolRef, topics: [TOPIC.mintV3Pool] }, lo, hi),
    getLogsSafe(rpc, { address: manager, topics: [TOPIC.transfer, ZERO32] }, lo, hi),
  ]);
  const ownerByTx = new Map();
  for (const l of mints) if (l.topics.length === 4) ownerByTx.set(l.transactionHash, asAddr(l.topics[2]));
  const first = new Map();
  for (const l of adds) {
    // v4: data = tickLower, tickUpper, liquidityDelta, salt; a removal is not an entry
    if (v4 && BigInt.asIntN(256, w32(ethers.getBytes(l.data), 2)) <= 0n) continue;
    // A new NFT in the same tx names the owner; otherwise the caller itself (a direct pool
    // LP or an increase on a position it already has, attributed to the manager — skipped).
    const caller = asAddr(l.topics[v4 ? 2 : 1]);
    const who = ownerByTx.get(l.transactionHash) || (caller === manager ? null : caller);
    if (!who) continue;
    const block = parseInt(l.blockNumber, 16);
    if (!first.has(who) || block < first.get(who).block) first.set(who, { block, tx: l.transactionHash });
  }
  return first;
}

/**
 * Scan the `opens` most recent LP opens of `wallet` (from its stored research) and rank the
 * wallets that entered the same pool within `windowSec` after it.
 */
async function findFollowers(rpc, chain, store, wallet, { opens = 30, windowSec = 120, onProgress } = {}) {
  const rows = store.all(`SELECT venue, pool_ref, token0, token1, opened_block, opened_ts FROM wpositions
    WHERE chain=? AND wallet=? AND opened_block IS NOT NULL AND pool_ref IS NOT NULL
    ORDER BY opened_block DESC LIMIT ?`, chain.network, wallet, opens);
  // Several positions opened in one pool at once count as one entry.
  const entries = [];
  const seen = new Set();
  for (const r of rows) {
    const k = `${r.pool_ref}:${r.opened_block}`;
    if (!seen.has(k)) { seen.add(k); entries.push(r); }
  }
  const symbols = new Map();
  const symbolOf = (a) => {
    if (!a) return null;
    if (!symbols.has(a)) symbols.set(a, store.get('SELECT symbol FROM tokens WHERE chain=? AND address=?', chain.network, a)?.symbol || null);
    return symbols.get(a);
  };
  const span = Math.max(1, Math.ceil((windowSec * 1000) / (chain.blockMs || 1000)));
  const byWallet = new Map();
  let done = 0;
  let failed = 0;
  for (const e of entries) {
    let first;
    try {
      first = await entrantsOf(rpc, chain, { venue: e.venue, poolRef: e.pool_ref }, e.opened_block, e.opened_block + span);
    } catch { failed++; first = new Map(); }
    for (const [who, f] of first) {
      if (who === wallet) continue;
      const w = byWallet.get(who) || { address: who, hits: 0, delays: [], pools: new Set(), lastBlock: 0, lastTs: null, follows: [] };
      w.hits++;
      const delaySec = ((f.block - e.opened_block) * (chain.blockMs || 1000)) / 1000;
      w.delays.push(delaySec);
      // Which pools: the opens it trailed, newest first (entries are already in that order).
      w.follows.push({ poolRef: e.pool_ref, token0: e.token0, token1: e.token1, ts: e.opened_ts, delaySec, tx: f.tx });
      w.pools.add(e.pool_ref);
      if (f.block > w.lastBlock) { w.lastBlock = f.block; w.lastTs = e.opened_ts; }
      byWallet.set(who, w);
    }
    onProgress?.({ scanned: ++done, total: entries.length });
  }
  if (entries.length && failed === entries.length) throw new Error('semua pembacaan log gagal (RPC)');
  const followers = [...byWallet.values()]
    .map((w) => ({
      address: w.address, hits: w.hits, share: w.hits / entries.length,
      medianDelaySec: median(w.delays), minDelaySec: Math.min(...w.delays), pools: w.pools.size, lastTs: w.lastTs,
      follows: w.follows.map((x) => ({ ...x, symbol0: symbolOf(x.token0), symbol1: symbolOf(x.token1) })),
    }))
    // Once is chance (a busy pool); follow-the-leader shows up again and again.
    .sort((a, b) => b.hits - a.hits || a.medianDelaySec - b.medianDelaySec)
    .slice(0, 50);
  return { entries: entries.length, failed, windowSec, oldestTs: entries.at(-1)?.opened_ts ?? null, followers };
}

module.exports = { findFollowers };
