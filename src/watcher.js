'use strict';
const { ensureChain } = require('./networks');
// Detect LP actions of the target wallet.
//
// Why via events, not decoding transactions: the example target (0xe1d7…3e79) uses
// V4UtilsRouter (an automation service in the AUTOMATION_OPERATOR role) for most of its
// positions, plus the PositionManager directly, plus the UniversalRouter. Decoding calldata
// means chasing every new router forever. PoolManager/NPM events are the
// same common outlet for all of them.
//
// v4 identification chain: ModifyLiquidity.salt == PositionManager tokenId,
// then tokenId -> owner via ownerOf/Transfer. Verified on chain.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { computePoolId } = require('./pools');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const asAddr = (topic) => ('0x' + topic.slice(-40)).toLowerCase();
const i24 = (v) => Number(BigInt.asIntN(24, v));
const i256 = (v) => BigInt.asIntN(256, v);

class Watcher {
  constructor({ rpc, store, chain, log, cfg }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.cfg = cfg;
    this.network = chain.network;
    // Routers that only swap tokens; a target tx to these is not an LP action.
    this.swapRouters = new Set([chain.ADDR.dexRouter, chain.ADDR.universalRouter].filter(Boolean).map((a) => a.toLowerCase()));
    // NPM address -> v3 venue key ('v3', 'pancakev3', …) — one chain can have more than one.
    this.npmVenue = new Map(chain.venues.map((v) => [String(v.npmV3).toLowerCase(), v.key]));
    this.owners = new Map();   // `${venue}:${tokenId}` -> owner
    this.v4Info = new Map();   // tokenId -> {poolKey, poolId, tickLower, tickUpper}
    this.unsupported = new Map(); // sender -> count, for transparency on the dashboard
    this.unsupportedSender = new Map(); // txHash -> ModifyLiquidity sender in this range, for the warning message
    this.isContract = new Map();  // address -> has bytecode?
  }

  // Is this address a contract? Used to distinguish "deposited to an automation router"
  // from "really released to someone else".
  async contractCheck(addrs) {
    const need = [...new Set(addrs)].filter((a) => a && !this.isContract.has(a));
    if (!need.length) return;
    const res = await this.rpc.batch(need.map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
    // Unreadable ≠ "not a contract". An RPC error used to be read as '0x' and STORED forever:
    // the target's NFT deposit into an automation router read as "target released the position", and the bot
    // closed the mirror of a position that was still alive. Throw — the block range is repeated.
    const bad = need.find((a, i) => !res[i] || res[i].error || typeof res[i].result !== 'string');
    if (bad) throw new Error(`eth_getCode ${bad} tidak terbaca dari RPC`);
    need.forEach((a, i) => this.isContract.set(a, res[i].result !== '0x'));
  }

  targets() {
    return this.store.all('SELECT address,label,enabled,rules FROM targets WHERE chain=?', this.network);
  }
  enabledSet() {
    return new Set(this.targets().filter((t) => t.enabled).map((t) => t.address.toLowerCase()));
  }

  // Warn once per (target, router): the target uses an LP router whose positions
  // are not NFTs, so they cannot be mirrored. Without this, the bot looks "healthy" while blind.
  //
  // Txs to a SWAP router are skipped: an aggregator can route a swap through a hooked v4 pool that
  // rebalances its own liquidity, and that hook's ModifyLiquidity is also
  // recorded in the target's tx. That is an ordinary swap, not the target moving to another LP router —
  // it happened on 0x2debd4c6…4bf7 (the target sold leftover tokens via dagSwapTo).
  async warnIfTargetUnsupported(txHashes, targets) {
    this.warnedUnsupported = this.warnedUnsupported || new Set();
    const ask = txHashes.slice(0, 8);   // enough of a sample; this is a rare path
    const res = await this.rpc.batch(ask.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })));
    for (const r of res) {
      const tx = r && !r.error ? r.result : null;
      const from = String(tx?.from || '').toLowerCase();
      if (!targets.has(from)) continue;
      const to = String(tx?.to || '').toLowerCase();
      if (this.swapRouters.has(to)) continue;
      const senders = [...new Set((this.unsupportedSender.get(tx.hash) || []))];
      const key = `${from}|${to}`;
      if (this.warnedUnsupported.has(key)) continue;
      this.warnedUnsupported.add(key);
      const msg = `PERHATIAN: target ${from} membuka/mengubah LP lewat router yang posisinya BUKAN NFT PositionManager — aksi seperti itu tidak bisa dicermin bot ini (tx ${tx.hash}, ke ${to}, sender ModifyLiquidity ${senders.join(', ') || '?'})`;
      this.log(msg);
      this.store.log('warn', msg, { target: from, tx: tx.hash, to, senders });
    }
  }

  ownerKey(venue, tokenId) { return `${venue}:${tokenId}`; }

  // This cache holds the owner of ALL tokenIds that appear in PositionManager logs across the
  // whole chain, not just the target's — without a bound it grows over the process lifetime toward
  // pm2's max_memory_restart (a restart in the middle of a transaction). The oldest is dropped; a dropped
  // owner is re-read via ownerOf if it appears again.
  cacheOwner(venue, tokenId, owner) {
    const k = this.ownerKey(venue, tokenId);
    this.owners.delete(k);
    this.owners.set(k, owner);
    if (this.owners.size > (this.maxOwners || 50_000)) {
      let drop = Math.ceil(this.owners.size / 5);
      for (const key of this.owners.keys()) { if (drop-- <= 0) break; this.owners.delete(key); }
    }
  }
  knownOwner(venue, tokenId) { return this.owners.get(this.ownerKey(venue, tokenId)) || null; }

  // Resolve tokenId -> owner for many ids at once (with a cache).
  async resolveOwners(venue, tokenIds) {
    const need = [...new Set(tokenIds.map(String))].filter((id) => !this.owners.has(this.ownerKey(venue, id)));
    if (!need.length) return;
    const to = venue === 'v4' ? this.chain.ADDR.posmV4 : this.chain.npmFor(venue);
    const iface = venue === 'v4' ? IF_POSM : IF_NPM;
    // strict: an unreadable ownerOf (quota) ≠ a revert (NFT burned). Without this the target's
    // liquidity action is filtered out as "not the target's" and lost forever.
    const res = await this.rpc.ethCallMany(need.map((id) => ({ to, data: iface.encodeFunctionData('ownerOf', [BigInt(id)]) })), 'latest', { strict: true });
    need.forEach((id, i) => {
      const w = res[i];
      if (w && w !== '0x' && !/^0x0*$/.test(w)) { this.cacheOwner(venue, id, asAddr(w)); return; }
      // ownerOf revert = the NFT has been burned. If the burn is in the same range, the Transfer
      // log has already filled in the owner. If the burn happens AFTER this range (the target
      // withdraws in one tx then burns in the next, before we got to read),
      // the last owner we recorded is used — without this the withdrawal is filtered out as
      // "not the target's" and our mirror is only closed later by reconciliation.
      const row = this.store.get('SELECT target FROM actions WHERE chain=? AND venue=? AND token_id=? ORDER BY id DESC LIMIT 1', this.network, venue, id);
      if (row?.target) this.cacheOwner(venue, id, String(row.target).toLowerCase());
    });
  }

  // ---- fetch all relevant logs in one block range ------------------
  async fetchRange(fromBlock, toBlock) {
    const hex = (n) => '0x' + n.toString(16);
    const range = { fromBlock: hex(fromBlock), toBlock: hex(toBlock) };
    // ONE query for all three sources (addresses & topics may be lists; the result
    // is sorted again per address+topic below). It used to be three separate queries every 1.5 seconds
    // — times two instances — exhausting the free endpoint quota (consecutive 429s).
    // Failover between endpoints still exists in rpc.getLogs, per query.
    //
    // Only the topics we need are requested. Fetching ALL NPM logs
    // also drags in Collect and Approval (>50% of the volume) and that is what triggers 429 when catching up.
    const { ADDR } = this.chain;
    const logs = await this.rpc.getLogs({
      address: [ADDR.poolManager, ADDR.posmV4, ...this.npmVenue.keys()],
      topics: [[TOPIC.modifyLiquidity, TOPIC.transfer, TOPIC.increaseLiq, TOPIC.decreaseLiq]],
      ...range,
    }, { priority: true });
    const modLiq = [], xferV4 = [], npm = [];
    for (const l of logs || []) {
      const a = String(l.address || '').toLowerCase(), t0 = String(l.topics?.[0] || '').toLowerCase();
      if (a === ADDR.poolManager && t0 === TOPIC.modifyLiquidity) modLiq.push(l);
      else if (a === ADDR.posmV4 && t0 === TOPIC.transfer) xferV4.push(l);
      else if (this.npmVenue.has(a) && (t0 === TOPIC.transfer || t0 === TOPIC.increaseLiq || t0 === TOPIC.decreaseLiq)) { l.venue = this.npmVenue.get(a); npm.push(l); }
    }
    return { modLiq: modLiq || [], xferV4: xferV4 || [], npm: npm || [] };
  }

  // ---- process one range -> list of actions ----------------------------------
  async scan(fromBlock, toBlock) {
    // Only targets that are on. Actions of a disabled target are not recorded at all —
    // they do not add to the activity list and do not trigger a dashboard warning. The bot really
    // copies nothing from a disabled target, so no signal is lost.
    //
    // One exception: a target that is disabled but still has an open mirror. Its
    // EXIT signal for that mirror is still taken (and only that, filtered below) —
    // disabling a target means stopping copying, not abandoning an already
    // opened position without following it when the target withdraws.
    const enabled = this.enabledSet();
    const exitOnly = this.disabledWithMirrors(enabled);
    const targets = new Set([...enabled, ...exitOnly.keys()]);
    if (!targets.size) return [];
    const { modLiq, xferV4, npm } = await this.fetchRange(fromBlock, toBlock);
    const actions = [];

    // 1. NFT Transfer: update the ownership map first so a mint in the same tx is read.
    const noteTransfer = (venue, l) => {
      const from = asAddr(l.topics[1]), to = asAddr(l.topics[2]);
      const tokenId = BigInt(l.topics[3]).toString();
      this.cacheOwner(venue, tokenId, to);
      if (targets.has(to) && from !== '0x0000000000000000000000000000000000000000') {
        actions.push({ kind: 'transfer_in', venue, tokenId, target: to, counterparty: from, log: l });
      } else if (targets.has(from) && to !== '0x0000000000000000000000000000000000000000') {
        actions.push({ kind: 'transfer_out', venue, tokenId, target: from, counterparty: to, log: l });
      }
      // for a burn (to = 0x0) keep the previous owner so the burn action stays linked
      if (to === '0x0000000000000000000000000000000000000000') this.cacheOwner(venue, tokenId, from);
    };
    for (const l of xferV4) if (l.topics.length === 4) noteTransfer('v4', l);
    for (const l of npm) if (l.topics[0] === TOPIC.transfer && l.topics.length === 4) noteTransfer(l.venue, l);

    // The example target uses an automation service that DEPOSITS the position NFT with its router then
    // returns it in the same transaction. If that move were read as
    // "target exits", the bot would close a position that is actually still alive.
    // The rule: a move to/from a CONTRACT = a deposit, not a release.
    if (actions.length) {
      await this.contractCheck(actions.map((a) => a.counterparty));
      for (const a of actions) {
        if (this.isContract.get(a.counterparty)) a.kind = a.kind === 'transfer_out' ? 'custody_out' : 'custody_in';
      }
    }

    // 2. v4 ModifyLiquidity
    const v4Rows = [], claimRows = [];
    const unsupportedTx = new Set();
    this.unsupportedSender.clear();
    for (const l of modLiq) {
      const sender = asAddr(l.topics[2]);
      if (sender !== this.chain.ADDR.posmV4) {
        this.unsupported.set(sender, (this.unsupported.get(sender) || 0) + 1);
        // Its ownership does not go through the PositionManager NFT, so it cannot be mirrored.
        // If the one using it turns out to be our TARGET, that must sound an alarm: it means the
        // target moved to another kind of router and the bot silently stopped copying it.
        unsupportedTx.add(l.transactionHash);
        this.unsupportedSender.set(l.transactionHash, [...(this.unsupportedSender.get(l.transactionHash) || []), sender]);
        continue;
      }
      const b = ethers.getBytes(l.data);
      const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
      const tickLower = i24(w(0)), tickUpper = i24(w(1));
      const liqDelta = i256(w(2));
      const tokenId = w(3).toString();
      if (liqDelta === 0n) {
        // Zero delta = the target is only harvesting fees. There is nothing to mirror (our position
        // has its own fees, and imitating it would only burn gas), but the PATTERN is
        // useful: a target that suddenly harvests diligently is often preparing to exit.
        // Recorded as a 'claim' action; the engine decides 'skip' and only sounds
        // if it repeats on a position whose mirror we hold.
        claimRows.push({ l, poolId: l.topics[1], tickLower, tickUpper, tokenId });
        continue;
      }
      v4Rows.push({ l, poolId: l.topics[1], tickLower, tickUpper, liqDelta, tokenId });
    }
    // 2b. Cross safety net. Transfer/deposit actions and liquidity actions come
    // from TWO separate getLogs queries over the same range. If the PoolManager query
    // partially fails while the PositionManager query succeeds, the liquidity change
    // is silently lost while the deposit is recorded — exactly what happened on
    // the close of #2339460 (block 59601918): custody_out + custody_in recorded, decrease
    // not, so our mirror position would never have been closed.
    // For every transaction we ALREADY know concerns the target, its
    // ModifyLiquidity log is taken directly from the receipt.
    const seenTx = new Set(v4Rows.map((r) => r.l.transactionHash));
    const needTx = [...new Set(actions.filter((a) => a.venue === 'v4').map((a) => a.log.transactionHash))]
      .filter((h) => !seenTx.has(h));
    if (needTx.length) {
      const rcs = await this.rpc.batch(needTx.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
      // A safety net with a hole if the receipt is unreadable: the target's liquidity action
      // is silently lost while the cursor advances. Throw — the range is repeated.
      const miss = rcs.findIndex((r) => !r || r.error || !r.result);
      if (miss >= 0) throw new Error(`receipt ${needTx[miss].slice(0, 12)}… tidak terbaca dari RPC`);
      for (const r of rcs) {
        const rc = r.result;
        for (const l of rc?.logs || []) {
          if (l.address.toLowerCase() !== this.chain.ADDR.poolManager || l.topics[0] !== TOPIC.modifyLiquidity) continue;
          if (asAddr(l.topics[2]) !== this.chain.ADDR.posmV4) continue;
          const b = ethers.getBytes(l.data);
          const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
          const liqDelta = i256(w(2));
          if (liqDelta === 0n) continue;
          v4Rows.push({ l, poolId: l.topics[1], tickLower: i24(w(0)), tickUpper: i24(w(1)), liqDelta, tokenId: w(3).toString() });
          this.log(`aksi likuiditas terselamatkan dari receipt ${l.transactionHash.slice(0, 12)}… (query log tidak memuatnya)`);
        }
      }
    }

    // Who sent that unsupported LP transaction? If the target, give a
    // loud warning — once per target, so the log does not flood.
    if (unsupportedTx.size) await this.warnIfTargetUnsupported([...unsupportedTx], enabled);

    await this.resolveOwners('v4', [...v4Rows, ...claimRows].map((r) => r.tokenId));

    // 3. v3 NPM increase/decrease
    const v3Rows = [];
    for (const l of npm) {
      const t0 = l.topics[0];
      if (t0 !== TOPIC.increaseLiq && t0 !== TOPIC.decreaseLiq) continue;
      const tokenId = BigInt(l.topics[1]).toString();
      const b = ethers.getBytes(l.data);
      const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
      const liq = w(0), a0 = w(1), a1 = w(2);
      if (liq === 0n) continue;
      v3Rows.push({ l, venue: l.venue, tokenId, liq: t0 === TOPIC.increaseLiq ? liq : -liq, a0, a1 });
    }
    for (const venue of new Set(v3Rows.map((r) => r.venue))) {
      await this.resolveOwners(venue, v3Rows.filter((r) => r.venue === venue).map((r) => r.tokenId));
    }

    // 4. filter those owned by the target then complete the details
    const mineV4 = v4Rows.filter((r) => targets.has(this.knownOwner('v4', r.tokenId) || ''));
    const mineV3 = v3Rows.filter((r) => targets.has(this.knownOwner(r.venue, r.tokenId) || ''));

    const out = [];
    if (mineV4.length) out.push(...await this.enrichV4(mineV4));
    // Target fee harvest: recorded as it is (without price/value — nothing is
    // computed from it, so no extra RPC is needed).
    for (const r of claimRows.filter((x) => targets.has(this.knownOwner('v4', x.tokenId) || ''))) {
      out.push({
        ts: await this.chain.blockTs(parseInt(r.l.blockNumber, 16)),
        block: parseInt(r.l.blockNumber, 16), txHash: r.l.transactionHash,
        logIndex: parseInt(r.l.logIndex, 16), target: this.knownOwner('v4', r.tokenId), venue: 'v4',
        kind: 'claim', tokenId: r.tokenId, poolRef: r.poolId,
        tickLower: r.tickLower, tickUpper: r.tickUpper,
      });
    }
    for (const venue of new Set(mineV3.map((r) => r.venue))) {
      out.push(...await this.enrichV3(mineV3.filter((r) => r.venue === venue), venue));
    }
    for (const a of actions) {
      out.push({
        ts: await this.chain.blockTs(parseInt(a.log.blockNumber, 16)),
        block: parseInt(a.log.blockNumber, 16), txHash: a.log.transactionHash,
        logIndex: parseInt(a.log.logIndex, 16), target: a.target, venue: a.venue,
        kind: a.kind, tokenId: a.tokenId,
      });
    }
    out.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    if (!exitOnly.size) return out;
    return out.filter((a) => {
      const ids = exitOnly.get(a.target);
      if (!ids) return true;
      return (a.kind === 'decrease' || a.kind === 'transfer_out') && ids.has(String(a.tokenId));
    });
  }

  // target disabled -> Set(tokenId of target positions we still mirror)
  disabledWithMirrors(enabled) {
    const out = new Map();
    const rows = this.store.all(`SELECT p.target, p.mirror_of FROM positions p JOIN targets t ON t.address = p.target AND t.chain = p.chain
      WHERE p.chain=? AND p.status='open' AND p.mirror_of IS NOT NULL AND t.enabled = 0`, this.network);
    for (const r of rows) {
      const a = String(r.target).toLowerCase();
      if (enabled.has(a)) continue;
      if (!out.has(a)) out.set(a, new Set());
      out.get(a).add(String(r.mirror_of));
    }
    return out;
  }

  async enrichV4(rows) {
    // fetch the poolKey per tokenId (only once, cached)
    const need = rows.filter((r) => !this.v4Info.has(r.tokenId)).map((r) => r.tokenId);
    if (need.length) {
      const res = await this.rpc.ethCallMany(need.map((id) => ({
        to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(id)]),
      })), 'latest', { strict: true });
      need.forEach((id, i) => {
        if (!res[i] || res[i] === '0x') return;
        try {
          const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', res[i]);
          const pk = {
            currency0: d[0].currency0.toLowerCase(), currency1: d[0].currency1.toLowerCase(),
            fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks.toLowerCase(),
          };
          // A burned NFT does NOT revert — it returns an all-zero poolKey.
          // Do not store it: a zero poolKey makes the action look like a 0x0/0x0 pool.
          if (/^0x0+$/.test(pk.currency1) && pk.fee === 0) return;
          this.v4Info.set(id, { poolKey: pk, poolId: computePoolId(d[0]) });
        } catch { /* unreadable: filled by the fallback path below */ }
      });
    }
    // Fallback for an NFT that was already burned when read — a target that opens-closes fast,
    // or a rebalance mint+burn in one tx. The poolId is in the ModifyLiquidity event;
    // its poolKey is looked up from the mint tx calldata or the Initialize event.
    for (const r of rows) {
      if (this.v4Info.has(r.tokenId)) continue;
      try {
        const pk = await this.chain.poolKeyOfId(r.poolId, parseInt(r.l.blockNumber, 16), r.l.transactionHash);
        if (pk && computePoolId(pk).toLowerCase() === r.poolId.toLowerCase()) {
          this.v4Info.set(r.tokenId, { poolKey: pk, poolId: r.poolId });
        }
      } catch (e) { this.log(`poolKey #${r.tokenId} tidak terbaca: ${e.message}`); }
    }
    const outs = [];
    const poolIds = [...new Set(rows.map((r) => r.poolId))];
    const slots = await this.chain.slot0V4Many(poolIds);
    const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
    const allTokens = new Set();
    for (const r of rows) {
      const info = this.v4Info.get(r.tokenId);
      if (info) { allTokens.add(info.poolKey.currency0); allTokens.add(info.poolKey.currency1); }
    }
    const metas = await this.chain.tokens([...allTokens]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    for (const r of rows) {
      const info = this.v4Info.get(r.tokenId);
      const pk = info?.poolKey;
      const s = slotBy.get(r.poolId);
      let amount0 = 0n, amount1 = 0n, valueQuote = null, quoteSymbol = null;
      if (s && pk) {
        const a = m.getSqrtRatioAtTick(r.tickLower), b = m.getSqrtRatioAtTick(r.tickUpper);
        const abs = r.liqDelta < 0n ? -r.liqDelta : r.liqDelta;
        const amt = m.amountsForLiquidity(s.sqrtPriceX96, a, b, abs);
        amount0 = amt.amount0; amount1 = amt.amount1;
        const d0 = metaBy.get(pk.currency0)?.decimals ?? 18;
        const d1 = metaBy.get(pk.currency1)?.decimals ?? 18;
        const v = this.chain.valueInQuote({
          sqrtPriceX96: s.sqrtPriceX96, amount0, amount1, dec0: d0, dec1: d1,
          token0: pk.currency0, token1: pk.currency1,
        });
        if (v) { valueQuote = v.value; quoteSymbol = v.symbol; }
      }
      outs.push({
        ts: await this.chain.blockTs(parseInt(r.l.blockNumber, 16)),
        block: parseInt(r.l.blockNumber, 16), txHash: r.l.transactionHash,
        logIndex: parseInt(r.l.logIndex, 16),
        target: this.knownOwner('v4', r.tokenId), venue: 'v4',
        kind: r.liqDelta > 0n ? 'increase' : 'decrease',
        tokenId: r.tokenId, poolRef: r.poolId, poolKey: pk,
        token0: pk?.currency0, token1: pk?.currency1, fee: pk?.fee,
        tickSpacing: pk?.tickSpacing, hooks: pk?.hooks,
        tickLower: r.tickLower, tickUpper: r.tickUpper,
        liquidity: r.liqDelta.toString(), amount0: amount0.toString(), amount1: amount1.toString(),
        valueQuote, quoteSymbol, slot0: s,
      });
    }
    return outs;
  }

  async enrichV3(rows, venue = 'v3') {
    const npm = this.chain.npmFor(venue);
    const ids = [...new Set(rows.map((r) => r.tokenId))];
    const res = await this.rpc.ethCallMany(ids.map((id) => ({
      to: npm, data: IF_NPM.encodeFunctionData('positions', [BigInt(id)]),
    })), 'latest', { strict: true });
    const posBy = new Map();
    ids.forEach((id, i) => {
      if (!res[i] || res[i] === '0x') return;
      try {
        const d = IF_NPM.decodeFunctionResult('positions', res[i]);
        posBy.set(id, {
          token0: d[2].toLowerCase(), token1: d[3].toLowerCase(), fee: Number(d[4]),
          tickLower: Number(d[5]), tickUpper: Number(d[6]), liquidity: d[7],
        });
      } catch { /* ignore */ }
    });
    const toks = new Set();
    for (const p of posBy.values()) { toks.add(p.token0); toks.add(p.token1); }
    const metas = await this.chain.tokens([...toks]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    const outs = [];
    for (const r of rows) {
      const p = posBy.get(r.tokenId);
      let poolAddr = null, s = null, valueQuote = null, quoteSymbol = null;
      if (p) {
        poolAddr = await this.chain.poolV3Addr(p.token0, p.token1, p.fee, npm);
        if (poolAddr) s = await this.chain.slot0V3(poolAddr);
        if (s) {
          const v = this.chain.valueInQuote({
            sqrtPriceX96: s.sqrtPriceX96, amount0: r.a0, amount1: r.a1,
            dec0: metaBy.get(p.token0)?.decimals ?? 18, dec1: metaBy.get(p.token1)?.decimals ?? 18,
            token0: p.token0, token1: p.token1,
          });
          if (v) { valueQuote = v.value; quoteSymbol = v.symbol; }
        }
      }
      outs.push({
        ts: await this.chain.blockTs(parseInt(r.l.blockNumber, 16)),
        block: parseInt(r.l.blockNumber, 16), txHash: r.l.transactionHash,
        logIndex: parseInt(r.l.logIndex, 16),
        target: this.knownOwner(venue, r.tokenId), venue,
        kind: r.liq > 0n ? 'increase' : 'decrease',
        tokenId: r.tokenId, poolRef: poolAddr,
        token0: p?.token0, token1: p?.token1, fee: p?.fee, tickSpacing: null, hooks: null,
        tickLower: p?.tickLower, tickUpper: p?.tickUpper,
        liquidity: r.liq.toString(), amount0: r.a0.toString(), amount1: r.a1.toString(),
        valueQuote, quoteSymbol, slot0: s,
      });
    }
    return outs;
  }

  // Save actions to the DB; return the ones that are really new (never recorded before).
  persist(actions) {
    const fresh = [];
    for (const a of actions) {
      const r = this.store.run(
        `INSERT OR IGNORE INTO actions
         (chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,
          tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.network, a.ts, a.block, a.txHash, a.logIndex, a.target, a.venue, a.kind, a.tokenId ?? null,
        a.poolRef ?? null, a.token0 ?? null, a.token1 ?? null, a.fee ?? null, a.tickSpacing ?? null,
        a.hooks ?? null, a.tickLower ?? null, a.tickUpper ?? null, a.liquidity ?? null,
        a.amount0 ?? null, a.amount1 ?? null, a.valueQuote ?? null, a.quoteSymbol ?? null);
      if (r.changes) {
        a.id = Number(r.lastInsertRowid);
        fresh.push(a);
      }
    }
    return fresh;
  }
}

module.exports = { Watcher };
