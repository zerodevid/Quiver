'use strict';
// On-chain history of positions adopted from the wallet (opened outside the bot).
//
// The bot's own transactions live in `txs`; an adopted position has none there, so its history
// drawer only showed a made-up "open" row with the adoption time. This reads what really happened
// to each adopted NFT, ONCE, and keeps it in `chain_history`:
//   1. the mint: the NFT's Transfer from 0x0 (tokenId is indexed, so one getLogs per 1M blocks
//      covers every pending position of a position manager), searched backwards from the head;
//   2. the liquidity events since the mint —
//      v3: IncreaseLiquidity / DecreaseLiquidity / Collect on the NPM (they carry the amounts;
//          fee = Collect − Decrease in the same tx),
//      v4: ModifyLiquidity on the PoolManager, amounts from the receipts (WalletResearch);
//   3. each event valued at the pool price IN ITS OWN BLOCK, its block time and gas.
// What happened before the adoption also fixes the position's books: capital = what was really
// deposited (not the value at adoption), withdrawals and claimed fees count toward its PnL, and
// the open time / open tx become the mint's. Transactions the bot sent itself are skipped — they
// are already in `txs`.
const { ethers } = require('ethers');
const { TOPIC } = require('./chain');
const { getLogsSafe } = require('./scout');
const m = require('./v3math');

const ZERO32 = '0x' + '0'.repeat(64);
const CHUNK = 1_000_000;
const word = (id) => BigInt(id).toString(16).padStart(64, '0');
const idTopic = (id) => '0x' + word(id);
const w32 = (b, i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
const hex = (n) => '0x' + n.toString(16);

// v3 NPM logs -> events per (tx, tokenId): IncreaseLiquidity = mint (in the mint tx) or add,
// DecreaseLiquidity = principal withdrawn, Collect − Decrease of the same tx = fee collected.
function v3Events(logs, mintTx = null) {
  const byKey = new Map();
  for (const l of logs) {
    const tx = l.transactionHash.toLowerCase();
    const tokenId = BigInt(l.topics[1]).toString();
    const key = `${tx}:${tokenId}`;
    const e = byKey.get(key) || { tx, tokenId, block: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), inc: null, dec: null, col: null };
    const b = ethers.getBytes(l.data);
    const a = { amount0: w32(b, 1), amount1: w32(b, 2) };
    if (l.topics[0] === TOPIC.increaseLiq) e.inc = a;
    else if (l.topics[0] === TOPIC.decreaseLiq) e.dec = a;
    else e.col = a;
    byKey.set(key, e);
  }
  const out = [];
  for (const e of byKey.values()) {
    const base = { tx: e.tx, tokenId: e.tokenId, block: e.block, logIndex: e.logIndex };
    if (e.inc) out.push({ ...base, kind: e.tx === mintTx ? 'mint' : 'increase', amount0: e.inc.amount0, amount1: e.inc.amount1 });
    if (e.dec) out.push({ ...base, logIndex: base.logIndex + 1, kind: 'decrease', amount0: e.dec.amount0, amount1: e.dec.amount1 });
    if (e.col) {
      const f0 = e.col.amount0 - (e.dec?.amount0 ?? 0n), f1 = e.col.amount1 - (e.dec?.amount1 ?? 0n);
      if (f0 > 0n || f1 > 0n) out.push({ ...base, logIndex: base.logIndex + 2, kind: 'claim_fees', amount0: f0 > 0n ? f0 : 0n, amount1: f1 > 0n ? f1 : 0n });
    }
  }
  return out;
}

class ChainHistory {
  // research: the engine's WalletResearch (v4 receipts + pool price at a block; .v3s for v3).
  constructor({ rpc, store, chain, log, research, maxDays = 30 }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || (() => {});
    this.research = research; this.network = chain.network; this.maxDays = maxDays;
  }

  doneKey(id) { return `chain_hist:${this.network}:${id}`; }

  // Adopted positions whose history has not been read yet.
  pending() {
    return this.store.all(`SELECT * FROM positions WHERE chain=? AND status='open' AND token_id IS NOT NULL
      AND tx_open IS NULL AND target IS NULL`, this.network)
      .filter((r) => (r.venue === 'v4' || this.chain.isV3Venue(r.venue)) && !this.store.getState(this.doneKey(r.id), null));
  }

  managerOf(venue) { return venue === 'v4' ? this.chain.ADDR.posmV4 : this.chain.npmFor(venue); }

  // Reads and books the history of every pending position. An RPC failure leaves the position
  // pending (retried on the next adoption scan); nothing is booked half-done.
  async backfill(wallet) {
    const rows = this.pending();
    if (!rows.length) return 0;
    const head = await this.rpc.blockNumber();
    const mints = await this.findMints(rows, head);
    let n = 0;
    for (const r of rows) {
      const mint = mints.get(r.id);
      if (!mint) {
        // Not minted within the search window: nothing to rebuild; do not search again every scan.
        this.store.setState(this.doneKey(r.id), 'no-mint');
        this.log(`riwayat chain posisi #${r.id}: mint tidak ditemukan dalam ${this.maxDays} hari terakhir`);
        continue;
      }
      const events = r.venue === 'v4' ? await this.eventsV4(wallet, r, mint, head) : await this.eventsV3(r, mint, head);
      await this.enrich(r, events);
      this.book(r, mint, events);
      n++;
    }
    if (n) this.log(`riwayat chain: ${n} posisi adopsi dibaca dari chain`);
    return n;
  }

  // The mint block & tx of each position, searching backwards from the head.
  async findMints(rows, head) {
    const out = new Map();
    const maxBlocks = Math.ceil((this.maxDays * 864e5) / (this.chain.blockMs || 2000));
    const groups = new Map();
    for (const r of rows) {
      const mgr = this.managerOf(r.venue);
      if (!groups.has(mgr)) groups.set(mgr, []);
      groups.get(mgr).push(r);
    }
    for (const [mgr, list] of groups) {
      const byId = new Map(list.map((r) => [String(r.token_id), r]));
      const stop = Math.max(0, head - maxBlocks);
      for (let hi = head; hi > stop && byId.size;) {
        const lo = Math.max(stop, hi - CHUNK);
        const logs = await getLogsSafe(this.rpc, { address: mgr, topics: [TOPIC.transfer, ZERO32, null, [...byId.keys()].map(idTopic)] }, lo, hi);
        for (const l of logs) {
          const id = BigInt(l.topics[3]).toString();
          const r = byId.get(id);
          if (!r) continue;
          out.set(r.id, { block: parseInt(l.blockNumber, 16), tx: l.transactionHash.toLowerCase() });
          byId.delete(id);
        }
        hi = lo - 1;
      }
    }
    return out;
  }

  // v3: the NPM's own events carry the token amounts.
  async eventsV3(r, mint, head) {
    const npm = this.managerOf(r.venue);
    const logs = [];
    for (let lo = mint.block; lo <= head; lo += CHUNK) {
      logs.push(...await getLogsSafe(this.rpc, {
        address: npm, topics: [[TOPIC.increaseLiq, TOPIC.decreaseLiq, TOPIC.collectV3], idTopic(r.token_id)],
      }, lo, Math.min(head, lo + CHUNK - 1)));
    }
    return v3Events(logs, mint.tx).filter((e) => e.tokenId === String(r.token_id));
  }

  // v4: ModifyLiquidity of this tokenId (the salt) in its pool, amounts from the receipts.
  async eventsV4(wallet, r, mint, head) {
    const info = { poolId: r.pool_ref, poolKey: { currency0: r.token0, currency1: r.token1 } };
    const evs = await this.research.positionEvents(wallet, String(r.token_id), info, { first: mint.block, last: head });
    return evs.map((e) => {
      const kind = e.delta > 0n ? (e.tx.toLowerCase() === mint.tx ? 'mint' : 'increase') : e.delta < 0n ? 'decrease' : 'claim_fees';
      const moved = e.moved || {};
      const amount0 = e.delta > 0n ? (moved.in0 ?? 0n) : (moved.out0 ?? 0n);
      const amount1 = e.delta > 0n ? (moved.in1 ?? 0n) : (moved.out1 ?? 0n);
      // A tx that moved several positions has no separable Transfers: amounts from L and price.
      return { tx: e.tx.toLowerCase(), block: e.block, logIndex: e.logIndex, kind, amount0, amount1, delta: e.delta, needMath: e.shared || (e.delta !== 0n && amount0 === 0n && amount1 === 0n) };
    });
  }

  // Pool price, value, block time and gas of each event.
  async enrich(r, events) {
    if (!events.length) return;
    const toks = await this.chain.tokens([r.token0, r.token1]);
    const dec0 = toks[0]?.decimals ?? 18, dec1 = toks[1]?.decimals ?? 18;
    const v3 = this.research.v3s?.find((x) => x.venue === r.venue) || this.research.v3;
    for (const e of events) {
      let sqrt = null;
      try {
        sqrt = r.venue === 'v4' ? await this.research.priceAt(r.pool_ref, e.block) : (await v3.priceAt(r.pool_ref, e.block))?.sqrt ?? null;
      } catch { sqrt = null; }
      e.sqrt = sqrt;
      if (sqrt && e.needMath) {
        const L = e.delta < 0n ? -e.delta : e.delta;
        const amt = m.amountsForLiquidity(sqrt, m.getSqrtRatioAtTick(r.tick_lower), m.getSqrtRatioAtTick(r.tick_upper), L);
        e.amount0 = amt.amount0; e.amount1 = amt.amount1;
      }
      const v = sqrt ? this.chain.valueInQuote({ sqrtPriceX96: sqrt, amount0: e.amount0, amount1: e.amount1, dec0, dec1, token0: r.token0, token1: r.token1 }) : null;
      e.valueQuote = v?.value ?? null;
    }
    const blocks = [...new Set(events.map((e) => e.block))];
    const txs = [...new Set(events.map((e) => e.tx))];
    const [bs, rcs] = await Promise.all([
      this.rpc.batch(blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [hex(b), false] }))),
      this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] }))),
    ]);
    const tsBy = new Map(blocks.map((b, i) => [b, bs[i]?.result?.timestamp ? parseInt(bs[i].result.timestamp, 16) * 1000 : null]));
    const gasBy = new Map(txs.map((h, i) => {
      const rc = rcs[i]?.result;
      return [h, rc?.gasUsed && rc?.effectiveGasPrice ? (BigInt(rc.gasUsed) * BigInt(rc.effectiveGasPrice)).toString() : null];
    }));
    for (const e of events) { e.ts = tsBy.get(e.block); e.gasWei = gasBy.get(e.tx); }
    if (events.some((e) => e.ts == null)) throw new Error('waktu blok tidak terbaca');
  }

  // Stores the events and corrects the position's books with what happened before the adoption.
  book(r, mint, events) {
    const own = new Set(events.length ? this.store.all('SELECT hash FROM txs WHERE chain=? AND lower(hash) IN (' + events.map(() => '?').join(',') + ')',
      this.network, ...events.map((e) => e.tx)).map((t) => String(t.hash).toLowerCase()) : []);
    const outside = events.filter((e) => !own.has(e.tx)).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    const adoptedTs = r.opened_ts || Date.now();
    const before = outside.filter((e) => e.ts <= adoptedTs);
    const sum = (list, k) => list.reduce((s, e) => s + BigInt(e[k] ?? 0n), 0n);
    const val = (list) => list.reduce((s, e) => s + (e.valueQuote || 0), 0);
    const deposits = before.filter((e) => e.kind === 'mint' || e.kind === 'increase');
    const withdrawals = before.filter((e) => e.kind === 'decrease');
    const claims = before.filter((e) => e.kind === 'claim_fees');
    const mintEv = outside.find((e) => e.kind === 'mint');
    this.store.db.exec('BEGIN');
    try {
      for (const e of outside) {
        this.store.run(`INSERT OR REPLACE INTO chain_history(chain,position_id,hash,log_index,block,ts,kind,amount0,amount1,value_quote,gas_wei)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, this.network, r.id, e.tx, e.logIndex, e.block, e.ts, e.kind,
        String(e.amount0 ?? 0n), String(e.amount1 ?? 0n), e.valueQuote, e.gasWei);
      }
      // Capital is only replaced when every deposit could be valued; otherwise the adoption
      // estimate (value at adoption) stays.
      const priced = deposits.length && deposits.every((e) => e.valueQuote != null);
      this.store.run(`UPDATE positions SET tx_open=?, opened_ts=COALESCE(?, opened_ts), entry_sqrt=COALESCE(entry_sqrt, ?)
        ${priced ? ', cost0=?, cost1=?, cost_quote=?' : ''} WHERE id=?`,
      mint.tx, mintEv?.ts ?? null, mintEv?.sqrt != null ? String(mintEv.sqrt) : null,
      ...(priced ? [sum(deposits, 'amount0').toString(), sum(deposits, 'amount1').toString(), val(deposits)] : []), r.id);
      if (withdrawals.length) {
        this.store.run('UPDATE positions SET out0=?, out1=?, out_quote=COALESCE(out_quote,0)+? WHERE id=?',
          (BigInt(r.out0 || '0') + sum(withdrawals, 'amount0')).toString(), (BigInt(r.out1 || '0') + sum(withdrawals, 'amount1')).toString(), val(withdrawals), r.id);
      }
      if (claims.length) this.store.run('UPDATE positions SET claimed_quote=COALESCE(claimed_quote,0)+? WHERE id=?', val(claims), r.id);
      this.store.setState(this.doneKey(r.id), 'done');
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
  }

  // ---- watching open positions ------------------------------------------------------------
  // Every open position with an NFT (opened by the bot or adopted) is followed on chain: what
  // someone does to it OUTSIDE the bot — the same wallet in the Uniswap app, another bot on the
  // wallet — is booked so its PnL stays true: an add raises the capital, a partial withdrawal
  // counts as proceeds, a fee collect as claimed fees. Only the blocks since the last pass are
  // read: one getLogs on each v3 NPM and one on the PoolManager covers every position. A full
  // close (liquidity now zero) is left to the engine's closeEmptyPosition, which books the exit
  // from the receipt.
  async watch(wallet, { liquidityOf } = {}) {
    const rows = this.store.all("SELECT * FROM positions WHERE chain=? AND status='open' AND token_id IS NOT NULL", this.network)
      .filter((r) => r.venue === 'v4' || this.chain.isV3Venue(r.venue));
    const head = await this.rpc.blockNumber();
    const key = `chain_watch_to:${this.network}`;
    const recent = Math.ceil((10 * 60_000) / (this.chain.blockMs || 2000));
    const cap = Math.ceil((7 * 864e5) / (this.chain.blockMs || 2000));
    const last = Number(this.store.getState(key, 0));
    // First pass: the last 10 minutes (overlap is harmless: known events are skipped).
    const from = Math.max(last ? last - 20 : head - recent, head - cap);
    if (!rows.length || from > head) { this.store.setState(key, head); return 0; }
    const events = [];
    for (const { key: venue } of this.chain.venues || []) {
      const mine = rows.filter((r) => r.venue === venue);
      if (!mine.length) continue;
      const logs = await getLogsSafe(this.rpc, {
        address: this.chain.npmFor(venue), topics: [[TOPIC.increaseLiq, TOPIC.decreaseLiq, TOPIC.collectV3], mine.map((r) => idTopic(r.token_id))],
      }, from, head);
      const byId = new Map(mine.map((r) => [String(r.token_id), r]));
      for (const e of v3Events(logs)) if (byId.has(e.tokenId)) events.push({ ...e, row: byId.get(e.tokenId) });
    }
    const v4 = rows.filter((r) => r.venue === 'v4');
    if (v4.length) events.push(...await this.watchV4(v4, from, head));
    let n = 0;
    const byRow = new Map();
    for (const e of events) {
      if (!byRow.has(e.row.id)) byRow.set(e.row.id, []);
      byRow.get(e.row.id).push(e);
    }
    for (const [, list] of byRow) {
      const r = list[0].row;
      const fresh = this.unseen(r, list);
      if (!fresh.length) continue;
      // Emptied on chain: the close (with whatever came out in it) is the engine's to book.
      if (fresh.some((e) => e.kind === 'decrease') && liquidityOf) {
        const L = await liquidityOf(r);
        // Unreadable: booking it as a partial withdrawal could double a close — try the pass again.
        if (L == null) throw new Error(`likuiditas posisi #${r.id} tidak terbaca`);
        if (L === 0n) continue;
      }
      await this.enrich(r, fresh);
      n += this.bookLive(r, fresh);
    }
    this.store.setState(key, head);
    return n;
  }

  // v4: ModifyLiquidity through the position manager in the pools of our positions, matched by
  // salt (= tokenId); token amounts from the receipt's Transfers to/from the PoolManager.
  async watchV4(rows, from, head) {
    const pm = this.chain.ADDR.poolManager;
    const posm = '0x' + this.chain.ADDR.posmV4.replace(/^0x/, '').toLowerCase().padStart(64, '0');
    const logs = await getLogsSafe(this.rpc, { address: pm, topics: [TOPIC.modifyLiquidity, [...new Set(rows.map((r) => r.pool_ref))], posm] }, from, head);
    const bySalt = new Map(rows.map((r) => [word(r.token_id), r]));
    const hits = logs.filter((l) => bySalt.has(l.data.slice(-64).toLowerCase()));
    if (!hits.length) return [];
    const txs = [...new Set(hits.map((l) => l.transactionHash.toLowerCase()))];
    const rcs = await this.rpc.batch(txs.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] })));
    const rcBy = new Map(txs.map((h, i) => [h, rcs[i]?.result || null]));
    const out = [];
    for (const l of hits) {
      const r = bySalt.get(l.data.slice(-64).toLowerCase());
      const b = ethers.getBytes(l.data);
      const delta = BigInt.asIntN(256, w32(b, 2));
      const tx = l.transactionHash.toLowerCase();
      const rc = rcBy.get(tx);
      if (!rc) throw new Error(`receipt ${tx.slice(0, 12)}… belum terbaca`);
      const nLiq = (rc.logs || []).filter((x) => x.address.toLowerCase() === pm && x.topics[0] === TOPIC.modifyLiquidity).length;
      const moved = { in0: 0n, in1: 0n, out0: 0n, out1: 0n };
      for (const x of rc.logs || []) {
        if (x.topics[0] !== TOPIC.transfer || x.topics.length !== 3) continue;
        const side = x.address.toLowerCase() === r.token0 ? 0 : x.address.toLowerCase() === r.token1 ? 1 : null;
        if (side == null) continue;
        const fromA = ('0x' + x.topics[1].slice(-40)).toLowerCase(), toA = ('0x' + x.topics[2].slice(-40)).toLowerCase();
        if (toA === pm) moved[`in${side}`] += BigInt(x.data);
        else if (fromA === pm) moved[`out${side}`] += BigInt(x.data);
      }
      const kind = delta > 0n ? 'increase' : delta < 0n ? 'decrease' : 'claim_fees';
      const amount0 = delta > 0n ? moved.in0 : moved.out0, amount1 = delta > 0n ? moved.in1 : moved.out1;
      out.push({ row: r, tx, block: parseInt(l.blockNumber, 16), logIndex: parseInt(l.logIndex, 16), kind, amount0, amount1, delta,
        // Several positions in one tx share one Transfer flow; native ETH has no Transfer at all.
        needMath: delta !== 0n && (nLiq > 1 || (amount0 === 0n && amount1 === 0n) || r.token0 === this.chain.ADDR.native) });
    }
    return out;
  }

  // Events not yet booked: neither the bot's own tx nor already in chain_history.
  unseen(r, events) {
    const own = new Set(this.store.all('SELECT lower(hash) AS h FROM txs WHERE chain=? AND lower(hash) IN (' + events.map(() => '?').join(',') + ')',
      this.network, ...events.map((e) => e.tx)).map((t) => t.h));
    // The opening tx is the mint, not an add (the watcher cannot tell them apart in a new window);
    // an add seen again may already be stored as that position's mint.
    return events.filter((e) => !own.has(e.tx) && e.tx !== String(r.tx_open || '').toLowerCase()
      && !this.store.get('SELECT 1 FROM chain_history WHERE chain=? AND position_id=? AND hash=? AND kind IN (?, ?)', this.network, r.id, e.tx, e.kind,
        e.kind === 'increase' ? 'mint' : e.kind));
  }

  // Books what happened outside the bot to an open position. Returns how many events were booked.
  bookLive(r, events) {
    this.store.db.exec('BEGIN');
    try {
      for (const e of events) {
        this.store.run(`INSERT OR REPLACE INTO chain_history(chain,position_id,hash,log_index,block,ts,kind,amount0,amount1,value_quote,gas_wei)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, this.network, r.id, e.tx, e.logIndex, e.block, e.ts, e.kind,
        String(e.amount0 ?? 0n), String(e.amount1 ?? 0n), e.valueQuote, e.gasWei);
        const v = e.valueQuote || 0;
        if (e.kind === 'increase' || e.kind === 'mint') {
          this.store.run('UPDATE positions SET cost0=?, cost1=?, cost_quote=COALESCE(cost_quote,0)+? WHERE id=?',
            (BigInt(r.cost0 || '0') + BigInt(e.amount0 ?? 0n)).toString(), (BigInt(r.cost1 || '0') + BigInt(e.amount1 ?? 0n)).toString(), v, r.id);
        } else if (e.kind === 'decrease') {
          this.store.run('UPDATE positions SET out0=?, out1=?, out_quote=COALESCE(out_quote,0)+? WHERE id=?',
            (BigInt(r.out0 || '0') + BigInt(e.amount0 ?? 0n)).toString(), (BigInt(r.out1 || '0') + BigInt(e.amount1 ?? 0n)).toString(), v, r.id);
        } else if (e.kind === 'claim_fees') {
          this.store.run('UPDATE positions SET claimed_quote=COALESCE(claimed_quote,0)+? WHERE id=?', v, r.id);
        }
        Object.assign(r, this.store.get('SELECT cost0, cost1, out0, out1 FROM positions WHERE id=?', r.id));
        const what = { increase: 'tambah likuiditas', mint: 'mint', decrease: 'tarik sebagian', claim_fees: 'klaim fee' }[e.kind];
        this.log(`posisi #${r.id}: ${what} di luar bot (${e.tx.slice(0, 12)}…) — dibukukan ${v.toFixed(4)} ${r.quote_symbol || ''}`.trim());
      }
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    return events.length;
  }

  // History rows of one position for the drawer.
  rowsOf(positionId) {
    return this.store.all('SELECT * FROM chain_history WHERE chain=? AND position_id=? ORDER BY block, log_index', this.network, positionId);
  }
}

module.exports = { ChainHistory };
