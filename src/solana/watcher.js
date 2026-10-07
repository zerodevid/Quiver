'use strict';
// Target watcher on Solana. There are no event logs to scan per block like on EVM, so the
// target's moves are derived from STATE DIFFERENCES:
//
//   1. every round, the target wallet's new signatures are checked (1 cheap call);
//   2. when there is something new (or it has not been fully checked for a while), all the
//      target's positions on the three venues are listed again and compared with the previous
//      snapshot:
//        new position           -> 'increase' (liquidityBefore 0 = mint)
//        L up                   -> 'increase'
//        L down                 -> 'decrease' (liquidityBefore = old L → proportional share)
//        position gone          -> full 'decrease'
//        fees harvested, L same -> 'claim' (see claimed())
//        bins moved, same id    -> 'rebalance' (Meteora rebalance_liquidity: the liquidity is
//                                  re-laid over a new bin range in the same position)
//
// Snapshots are stored per target in state (they survive restarts). A target's first scan only
// takes a snapshot — positions that ALREADY existed before the target was added are not
// copied (same as EVM: only actions after the cursor are copied).
//
// Guard: a venue that FAILED to read must never read as "all its positions are gone" — that
// venue's old snapshot is kept as is and no action is produced for it.
const { PublicKey } = require('@solana/web3.js');

const FULL_RESCAN_MS = 10 * 60_000;
// After a new signature is seen, the snapshot is re-read every round during this window even
// without further signatures: the signature may already be visible on one endpoint while the
// position account is not yet updated on the endpoint answering the position read — without
// this window the change would only be caught by the 10-minute rescan.
const HOT_MS = 30_000;
// Share changes below 1/NOISE_DIV (0.1%) on a position that stays are not a signal: a target
// bot compounding fees, or program rounding, nudges DLMM shares very slightly in almost every
// transaction (measured on mainnet: ~1e-14 relative). Copying them = one paid transaction per
// trivial move. The old value is kept in the snapshot, so small nudges that add up are still
// caught once they cross the threshold.
const NOISE_DIV = 1000n;

class SolanaWatcher {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.unsupported = new Map();
    this.lastScan = new Map();   // target -> ts of the last full scan
    this.venueErr = new Map();   // `${target}:${venue}` -> last error message
    this.hotUntil = new Map();   // target -> ts the re-read window ends
  }

  enabledSet() {
    return new Set(this.store.all('SELECT address FROM targets WHERE chain=? AND enabled=1', this.chain.network).map((r) => r.address));
  }
  allTargets() {
    return this.store.all('SELECT address FROM targets WHERE chain=?', this.chain.network).map((r) => r.address);
  }

  snapKey(t) { return `sol_snap:${this.chain.network}:${t}`; }
  loadSnap(t) {
    try { return JSON.parse(this.store.getState(this.snapKey(t)) || 'null'); } catch { return null; }
  }
  saveSnap(t, s) { this.store.setState(this.snapKey(t), JSON.stringify(s)); }

  venuesOn() {
    const want = this.cfg.rules?.filters?.venues;
    const all = Object.keys(this.chain.adapters);
    return Array.isArray(want) && want.length ? all.filter((v) => want.includes(v)) : all;
  }

  // New signatures since the last one seen. null = failed to read. Only recent history is needed:
  // a target's new moves are seconds old, so a day-of-history endpoint (publicnode) is tried first
  // and the rate-limited full-history endpoint is only a fallback. An empty answer there for a
  // quiet wallet is correct here ("nothing new"); a cursor it no longer knows is handled below.
  async newSignatures(target, last) {
    const get = (until) => this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(target), { limit: 25, ...(until ? { until } : {}) }), { recentHistory: true });
    try {
      return await get(last);
    } catch (e) {
      // An endpoint that does not keep the history of signature `last` answers "Transaction …
      // not found" — EVERY round, so the target would never be scanned again. Fetch
      // without `until`: if the newest is not `last`, something is new.
      if (last && /not found/i.test(String(e.message))) {
        try {
          const all = await get(null);
          const i = all.findIndex((x) => x.signature === last);
          return i >= 0 ? all.slice(0, i) : all;
        } catch (e2) { e = e2; }
      }
      this.log(`tanda tangan ${target.slice(0, 6)}…: ${e.message}`);
      return null;
    }
  }

  // The target's positions per venue. A failed venue: { ok:false } (the old snapshot is used).
  async enumerate(target) {
    const out = {};
    await Promise.all(this.venuesOn().map(async (v) => {
      try {
        const list = await this.chain.adapter(v).listPositions(target, (m) => this.chain.decimalsMap(m));
        out[v] = { ok: true, list };
        this.venueErr.delete(`${target}:${v}`);
      } catch (e) {
        out[v] = { ok: false, error: e.message };
        const k = `${target}:${v}`;
        if (this.venueErr.get(k) !== e.message) this.log(`posisi ${v} ${target.slice(0, 6)}… tidak terbaca: ${e.message}`);
        this.venueErr.set(k, e.message);
      }
    }));
    return out;
  }

  static slim(p) {
    return {
      venue: p.venue, pool: p.pool, token0: p.token0, token1: p.token1,
      lower: p.lower, upper: p.upper, tickLower: p.tickLower, tickUpper: p.tickUpper,
      liquidity: String(p.liquidity), amount0: String(p.amount0 ?? 0), amount1: String(p.amount1 ?? 0),
      fee0: String(p.fee0 ?? 0), fee1: String(p.fee1 ?? 0), feeMark: p.feeMark ?? null,
      ext: p.ext || null,
    };
  }

  // Did the owner harvest this position's fees between two reads (liquidity unchanged)?
  //   Orca/Raydium: the fee growth checkpoint moved AND the owed fees are back to zero —
  //     the permissionless update_fees_and_rewards also moves the checkpoint but leaves
  //     the fees owed, so it does not count.
  //   Meteora: the claimable fees (computed by the SDK) fell to a fifth or less on both
  //     sides, from something non-zero.
  static claimed(o, p) {
    if (!o || o.fee0 == null || o.fee1 == null) return false;
    const f0 = BigInt(p.fee0 || '0'), f1 = BigInt(p.fee1 || '0'), o0 = BigInt(o.fee0 || '0'), o1 = BigInt(o.fee1 || '0');
    if (p.feeMark != null && o.feeMark != null) return p.feeMark !== o.feeMark && f0 === 0n && f1 === 0n;
    if (o0 === 0n && o1 === 0n) return false;
    return f0 * 5n <= o0 && f1 * 5n <= o1;
  }

  // Compare the old snapshot and the new list -> raw actions (not yet valued).
  static tiny(L0, L) {
    const d = L > L0 ? L - L0 : L0 - L;
    return L0 > 0n && L > 0n && d * NOISE_DIV < L0;
  }

  static diff(target, prev, now) {
    const acts = [];
    for (const [id, p] of Object.entries(now)) {
      const o = prev[id];
      const L = BigInt(p.liquidity), L0 = o ? BigInt(o.liquidity) : 0n;
      // Same position, new bin range: a move, not capital in or out — the share count changes
      // with the re-layout, so no increase/decrease is derived from it. Fees claimed in the same
      // transaction still count as a claim.
      if (o && L > 0n && L0 > 0n && o.lower != null && p.lower != null && (Number(o.lower) !== Number(p.lower) || Number(o.upper) !== Number(p.upper))) {
        acts.push({ target, id, kind: 'rebalance', delta: 0n, before: L0, pos: p, prev: o });
        if (SolanaWatcher.claimed(o, p)) acts.push({ target, id, kind: 'claim', delta: 0n, before: L0, pos: p, prev: o });
        continue;
      }
      if (o && L > 0n && (L === L0 || SolanaWatcher.tiny(L0, L)) && SolanaWatcher.claimed(o, p)) {
        acts.push({ target, id, kind: 'claim', delta: 0n, before: L0, pos: p, prev: o });
        continue;
      }
      if (o && SolanaWatcher.tiny(L0, L)) continue;
      if (!o || L > L0) {
        if (L === 0n) continue;   // a freshly created empty position account: no liquidity yet
        acts.push({ target, id, kind: 'increase', delta: L - L0, before: L0, pos: p, prev: o || null });
      } else if (L < L0) {
        acts.push({ target, id, kind: 'decrease', delta: L - L0, before: L0, pos: p, prev: o });
      }
    }
    for (const [id, o] of Object.entries(prev)) {
      if (now[id]) continue;
      const L0 = BigInt(o.liquidity);
      if (L0 > 0n) acts.push({ target, id, kind: 'decrease', delta: -L0, before: L0, pos: { ...o, liquidity: '0', amount0: '0', amount1: '0' }, prev: o, gone: true });
    }
    return acts;
  }

  async scanTarget(target, { force = false } = {}) {
    const snap = this.loadSnap(target);
    const sigs = await this.newSignatures(target, snap?.sig || null);
    if (sigs == null) return [];
    const stale = Date.now() - (this.lastScan.get(target) || 0) > FULL_RESCAN_MS;
    if (sigs.length) this.hotUntil.set(target, Date.now() + HOT_MS);
    const hot = Date.now() < (this.hotUntil.get(target) || 0);
    if (snap && !sigs.length && !stale && !hot && !force) return [];

    const got = await this.enumerate(target);
    this.lastScan.set(target, Date.now());
    const prevAll = snap?.positions || {};
    const nowAll = {};
    let anyOk = false;
    // Venues already read for this target. A venue read for the FIRST time (failed during the
    // first snapshot, or just enabled in the filter) only becomes snapshot — its old positions
    // must not read as new positions and get copied en masse.
    const seen = new Set(snap ? (snap.venues || Object.keys(this.chain.adapters)) : []);
    const fresh = new Set();
    for (const v of Object.keys(this.chain.adapters)) {
      const r = got[v];
      if (r?.ok) {
        anyOk = true;
        if (!seen.has(v)) fresh.add(v);
        seen.add(v);
        for (const p of r.list) nowAll[p.id] = SolanaWatcher.slim(p);
      } else {
        // failed / disabled venue: its old snapshot is carried over as is
        for (const [id, p] of Object.entries(prevAll)) if (p.venue === v) nowAll[id] = p;
      }
    }
    if (!anyOk) return [];
    // Trivial nudges do not enter the snapshot (see NOISE_DIV): the old share is kept.
    for (const [id, p] of Object.entries(nowAll)) {
      const o = prevAll[id];
      if (o && SolanaWatcher.tiny(BigInt(o.liquidity), BigInt(p.liquidity))) nowAll[id] = { ...p, liquidity: o.liquidity };
    }
    const newest = sigs[0]?.signature || snap?.sig || null;
    const slot = sigs[0]?.slot || snap?.slot || 0;
    this.saveSnap(target, { sig: newest, slot, ts: Date.now(), positions: nowAll, venues: [...seen] });
    if (!snap) {
      this.log(`target ${target.slice(0, 6)}…: potret awal ${Object.keys(nowAll).length} posisi (tidak disalin — hanya gerakan sesudah ini)`);
      return [];
    }
    if (fresh.size && snap) this.log(`target ${target.slice(0, 6)}…: venue ${[...fresh].join(', ')} baru terbaca — dijadikan potret, tidak disalin`);
    return SolanaWatcher.diff(target, prevAll, nowAll)
      .filter((a) => !fresh.has(a.pos.venue))
      .map((a) => ({ ...a, sig: newest, slot }));
  }

  // One round over all enabled targets. One target's error does not stop the others.
  async scan() {
    const out = [];
    for (const t of this.enabledSet()) {
      try { out.push(...await this.scanTarget(t)); }
      catch (e) { this.log(`pindai ${t.slice(0, 6)}…: ${e.message}`); }
    }
    return out;
  }

  // Raw actions -> actions rows (valued) + action objects for the engine. Unique key
  // (tx_hash, log_index): the newest signature + order, so a repeated round never records
  // the same action twice.
  async persist(raw) {
    const fresh = [];
    let i = 0;
    for (const a of raw) {
      const p = a.pos;
      const st = await this.chain.pool(p.venue, p.pool).catch(() => null);
      const dm = await this.chain.decimalsMap([p.token0, p.token1]).catch(() => new Map());
      const dec0 = st?.dec0 ?? dm.get(p.token0), dec1 = st?.dec1 ?? dm.get(p.token1);
      // Value = the value of the share that moved (addition / withdrawal).
      let amt0 = BigInt(p.amount0 || '0'), amt1 = BigInt(p.amount1 || '0');
      // The amount that MOVED = the share of contents that moved at the CURRENT price
      // composition: contents × |ΔL| / L. Not the before/after difference — that shifts with the
      // price too (one side can read negative and get clipped to zero). New position: all of
      // it; gone position: its last contents.
      const dL = a.delta < 0n ? -a.delta : a.delta;
      const Lnow = BigInt(p.liquidity || '0');
      if (a.kind === 'claim') { amt0 = BigInt(a.prev.fee0 || '0'); amt1 = BigInt(a.prev.fee1 || '0'); }
      else if (a.kind === 'rebalance') { /* the whole position, as now laid over its new range */ }
      else if (a.gone && a.prev) { amt0 = BigInt(a.prev.amount0 || '0'); amt1 = BigInt(a.prev.amount1 || '0'); }
      else if (a.before > 0n && Lnow > 0n) { amt0 = (amt0 * dL) / Lnow; amt1 = (amt1 * dL) / Lnow; }
      const v = st && dec0 != null && dec1 != null
        ? this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: amt0, amount1: amt1, dec0, dec1, token0: p.token0, token1: p.token1 })
        : null;
      // Unique key per move: the same signature can carry more than one move on the same
      // position (read within the re-read window).
      const hash = a.kind === 'claim'
        ? `${a.sig || 'snap'}:${a.id}:claim:${a.prev.fee0}:${a.prev.fee1}:${a.prev.feeMark || ''}`
        : a.kind === 'rebalance'
          ? `${a.sig || 'snap'}:${a.id}:rebalance:${a.prev.lower}:${a.prev.upper}:${p.lower}:${p.upper}`
          : `${a.sig || 'snap'}:${a.id}:${a.kind}:${a.delta}`;
      const ext = { lower: p.lower, upper: p.upper, liquidityBefore: a.before.toString(), ...(p.ext || {}), gone: !!a.gone,
        ...(a.kind === 'rebalance' ? { prevLower: a.prev.lower, prevUpper: a.prev.upper } : {}) };
      const r = this.store.run(`INSERT OR IGNORE INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,
          tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.chain.network, Date.now(), a.slot || 0, hash, i++, a.target, p.venue, a.kind, a.id, p.pool, p.token0, p.token1,
      st?.fee ?? null, st?.tickSpacing ?? null, p.tickLower, p.tickUpper, a.delta.toString(), String(amt0), String(amt1),
      v?.value ?? null, v?.symbol ?? null, JSON.stringify(ext));
      if (!r.changes) continue;
      fresh.push(SolanaWatcher.actFromRow(this.store.get('SELECT * FROM actions WHERE id=?', Number(r.lastInsertRowid))));
    }
    return fresh;
  }

  static actFromRow(r) {
    let ext = {};
    try { ext = JSON.parse(r.ext || '{}') || {}; } catch { ext = {}; }
    return {
      id: r.id, ts: r.ts, block: r.block, txHash: r.tx_hash, logIndex: r.log_index,
      target: r.target, venue: r.venue, kind: r.kind, tokenId: r.token_id, poolRef: r.pool_ref,
      token0: r.token0, token1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing,
      tickLower: r.tick_lower, tickUpper: r.tick_upper, liquidity: r.liquidity,
      liquidityBefore: ext.liquidityBefore ?? '0',
      amount0: r.amount0, amount1: r.amount1, valueQuote: r.value_quote, quoteSymbol: r.quote_symbol,
      lower: ext.lower, upper: ext.upper, binStep: ext.binStep ?? null, gone: !!ext.gone, ext,
    };
  }
}

module.exports = { SolanaWatcher };
