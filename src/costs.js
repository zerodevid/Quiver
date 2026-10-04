'use strict';
// Running cost of a position: gas burned and swap slippage ("slippage"),
// split between OPENING and CLOSING.
//
// Why it is needed: a position's PnL only compares capital with proceeds. What is not
// visible there is the cost of getting there — several gas transactions
// (approve, zap, mint, burn, leftover sale) and each swap's difference between the value
// going in and coming out. On this chain the gas of one position is ~$0.3 and the swap difference can be
// $0.4–1 per position: on a $100 position that is about 1%, enough to flip a
// "thin profit" position into a loss. The figures are split open/close so it reads
// which part is expensive.
//
// All of it is derived from the existing `txs` table — no new columns:
//   gas   = gas_used × gas_price (including REVERTED transactions: the gas is still burned)
//   slip  = usdIn − usdOut from the Kyber quote stored in each swap's detail
//           (pool fee + price impact + price shift at execution)
//
// Transactions are linked to a position via the detail the engine already writes
// (position / recorded / plan.positionId / positionSales), via the position's tx_open & tx_close,
// and via decisions that link to a position. Helper transactions — approve,
// wrap/unwrap, zap, gas top-up — do not mention any position number, so each is attached
// to the first OWNED transaction after it (an approve always precedes the swap/mint that
// needs it, in the same flow). That is an estimate, not proof: the cost
// shown is marked as approximate.
//
// Failed copy attempts: an entry that never became a position (a mint that reverted after its
// zap, or a zap whose entry died) still burned gas and paid swap slippage. That cost has no
// position to live on, so it is booked per TARGET under `failed` (key `fail:<target>` while
// anchoring) — this is what makes net PnL reconcile with position PnL and shows which target
// is expensive to copy.

// Phase by transaction type. Those not listed here (approve, wrap, gas top-up)
// inherit the phase of the first owned transaction after them.
const OPEN_KIND = new Set(['mint', 'increase']);
const CLOSE_KIND = new Set(['burn', 'decrease', 'sell_leftover']);
// Helper transactions: never become an anchor, always follow what comes after.
const HELPER_KIND = new Set(['approve_erc20', 'approve_permit2', 'approve_kyber', 'approve_router',
  'wrap_eth', 'unwrap_weth', 'gas_topup', 'zap_swap', 'bridge_swap']);
// Time limit within which a helper may be attached to the transaction after it. A single entry flow
// (approve → zap → approve → mint) finishes within seconds to minutes;
// an orphan approve from a cancelled flow must not be charged to another position.
const HELPER_GAP_MS = 15 * 60_000;

const parse = (d) => { try { return JSON.parse(d || '{}') || {}; } catch { return {}; } };
const empty = () => ({ gasUsd: 0, slipUsd: 0, routeUsd: 0, execUsd: 0, txN: 0 });
const FAIL_PREFIX = 'fail:';
const failId = (target) => `${FAIL_PREFIX}${target ? String(target).toLowerCase() : ''}`;
const emptyFailed = () => ({ gasUsd: 0, slipUsd: 0, totalUsd: 0, attempts: 0, txN: 0, lastTs: 0 });
const emptyCost = () => ({
  open: empty(), close: empty(), lain: empty(),
  gasUsd: 0, slipUsd: 0, routeUsd: 0, execUsd: 0, totalUsd: 0, txN: 0, hashes: [],
});

const gasEthOf = (t) => (t.gas_used && t.gas_price ? Number(BigInt(t.gas_used) * BigInt(t.gas_price)) / 1e18 : 0);
// Gas in USD: the one booked at the receipt (the ETH price then) if present,
// otherwise computed with the current ETH price — old txs did not store it.
const gasUsdOf = (t, ethUsd) => (t.gas_quote != null ? Number(t.gas_quote) : gasEthOf(t) * ethUsd);

// Swap cost in USD, two parts of different origin:
//   route = quote in − quote out (pool fee + route price impact)
//   exec  = quote out − what was actually received (price shift at execution)
// A negative (received more than estimated) is left as it is — zeroing it
// would make the total cost always look more expensive than reality.
function swapCostOf(d) {
  const num = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : 0);
  // A quote whose input is worth (almost) nothing against what came out is a token that had no price
  // at the time (a leftover sale), not a swap that paid us $50: it is unmeasured, not a gain.
  const priced = d.usdIn != null && d.usdOut != null && num(d.usdOut) <= num(d.usdIn) * 1.5 + 0.5;
  const route = priced ? num(d.usdIn) - num(d.usdOut) : 0;
  return { route, exec: num(d.execSlipUsd) };
}

class Costs {
  constructor(store, network = 'robinhood') { this.store = store; this.network = network; this.cache = null; }

  // Computed once for ALL positions then cached: the positions table is polled every
  // few seconds and computing per position would mean scanning txs repeatedly.
  // The cache is invalidated when a new/changed transaction appears (row count + last time).
  map(ethUsd) {
    const sig = this.store.get('SELECT COUNT(*) n, COALESCE(MAX(ts),0) last, COALESCE(SUM(gas_used),0) gas FROM txs WHERE chain=?', this.network);
    // The ETH price is rounded to a whole dollar: it is only used for old transactions that
    // have not stored gas in USD, so there is no need to recompute every cent.
    const key = `${sig?.n}:${sig?.last}:${sig?.gas}:${Math.round(ethUsd || 0)}`;
    if (this.cache?.key === key) return this.cache.map;
    const map = this.compute(ethUsd || 0);
    this.cache = { key, map };
    return map;
  }

  of(id, ethUsd) { return this.map(ethUsd).get(id) || emptyCost(); }

  // Measured swap slippage of EVERY swap since `ts`, attributed to a position or not
  // (ETH<->USDG bridge swaps and leftover sales belong to no position). Summed straight
  // from the stored quotes, so it does not depend on the attribution heuristics above.
  slipSince(ts) {
    const rows = this.store.all('SELECT detail FROM txs WHERE chain=? AND ts >= ? AND status != ? AND detail IS NOT NULL', this.network, ts, 'gagal');
    let route = 0, exec = 0;
    for (const r of rows) { const sw = swapCostOf(parse(r.detail)); route += sw.route; exec += sw.exec; }
    return { slipUsd: route + exec, swapCount: rows.length };
  }

  // Cost of copy attempts that never became a position, per target ('' = unknown target).
  failed(ethUsd) { return this.map(ethUsd).failed; }

  compute(ethUsd) {
    const store = this.store;
    const out = new Map();
    out.failed = new Map();   // target ('' = unknown) -> cost of copy attempts that never became a position
    const bucket = (id) => {
      let c = out.get(id);
      if (!c) { c = emptyCost(); out.set(id, c); }
      return c;
    };
    const positions = store.all('SELECT id, token_id, venue, pool_ref, tx_open, tx_close FROM positions WHERE chain=?', this.network);
    const byOpenTx = new Map(), byCloseTx = new Map(), byToken = new Map();
    for (const p of positions) {
      if (p.tx_open) byOpenTx.set(p.tx_open, p.id);
      if (p.tx_close) byCloseTx.set(p.tx_close, p.id);
      if (p.token_id) byToken.set(`${p.venue}:${p.token_id}`, p.id);
    }
    const byDecision = new Map(store.all('SELECT tx_hash, position_id FROM decisions WHERE position_id IS NOT NULL AND tx_hash IS NOT NULL')
      .map((d) => [d.tx_hash, d.position_id]));
    const txs = store.all('SELECT hash, ts, kind, status, gas_used, gas_price, gas_quote, detail FROM txs WHERE chain=? ORDER BY ts', this.network);

    // 1) anchors: transactions clearly belonging to a specific position
    const anchor = new Array(txs.length).fill(null);   // {ids:[], phase}
    txs.forEach((t, i) => {
      if (HELPER_KIND.has(t.kind)) return;
      const d = parse(t.detail);
      const ids = [];
      if (Number.isInteger(d.position)) ids.push(d.position);
      if (Number.isInteger(d.recorded)) ids.push(d.recorded);
      if (Number.isInteger(d.plan?.positionId)) ids.push(d.plan.positionId);
      if (byOpenTx.has(t.hash)) ids.push(byOpenTx.get(t.hash));
      if (byCloseTx.has(t.hash)) ids.push(byCloseTx.get(t.hash));
      if (byDecision.has(t.hash)) ids.push(byDecision.get(t.hash));
      if (d.plan?.tokenId != null) {
        const hit = byToken.get(`${d.plan.venue || 'v4'}:${d.plan.tokenId}`);
        if (hit) ids.push(hit);
      }
      // One leftover sale can close several positions at once: the cost is split evenly.
      for (const s of d.positionSales || []) if (Number.isInteger(s.position)) ids.push(s.position);
      for (const s of d.feeSales || []) if (Number.isInteger(s.position)) ids.push(s.position);
      const uniq = [...new Set(ids)];
      if (!uniq.length) {
        // No position behind it: a mint that reverted, or the sale that unwinds a zap whose
        // LP never opened. Both belong to the target that was being copied.
        const failedMint = (t.kind === 'mint' || t.kind === 'increase') && t.status === 'gagal';
        const unwind = t.kind === 'sell_leftover' && d.source === 'zap' && d.position == null && d.target;
        if (failedMint || unwind) anchor[i] = { ids: [failId(d.target ?? d.plan?.target)], phase: 'open' };
        return;
      }
      // Fee claims, compounds, manual swaps: costs of this position too, but not
      // open or close costs — collected separately so the two main figures stay clean.
      const phase = OPEN_KIND.has(t.kind) ? 'open' : CLOSE_KIND.has(t.kind) ? 'close' : 'lain';
      anchor[i] = { ids: uniq, phase };
    });

    // 2a) zaps ALREADY named by a mint/add — proof, not an estimate.
    //     A mint that carries a `zapped.hashes` list means its zap is exactly that one; another zap
    //     in the same pool (e.g. a cancelled entry attempt) is NOT this position's cost.
    const zapOwner = new Map();
    const mintTellsZaps = new Map();
    txs.forEach((t, i) => {
      if (!anchor[i] || (t.kind !== 'mint' && t.kind !== 'increase')) return;
      const z = parse(t.detail).zapped;
      mintTellsZaps.set(t.hash, !!z);
      for (const h of z?.hashes || []) zapOwner.set(h, { ids: anchor[i].ids, phase: 'open' });
    });

    // 2b) helpers (approve/wrap/zap/gas top-up) follow the first anchor AFTER them — an approve
    //     always precedes the swap/mint that needs it, in the same flow.
    for (let i = txs.length - 1; i >= 0; i--) {
      if (anchor[i] || !HELPER_KIND.has(txs[i].kind)) continue;
      const own = zapOwner.get(txs[i].hash);
      if (own) { anchor[i] = { ...own }; continue; }
      for (let j = i + 1; j < txs.length; j++) {
        if (!anchor[j]) continue;
        if (txs[j].ts - txs[i].ts > HELPER_GAP_MS) break;
        if (txs[i].kind === 'zap_swap') {
          // A zap only attaches to a real mint/add, in the same pool,
          // and only if that mint does NOT name its own zap list (if
          // this zap is its, its name would certainly be in that list). Without all three, a zap
          // from a CANCELLED entry attempt is charged to the next position too.
          if (txs[j].kind !== 'mint' && txs[j].kind !== 'increase') continue;
          const zapPool = parse(txs[i].detail).pool;
          const anchorPool = parse(txs[j].detail).pool || parse(txs[j].detail).plan?.poolRef;
          if (zapPool && anchorPool && zapPool !== anchorPool) break;
          if (mintTellsZaps.get(txs[j].hash)) break;
        }
        anchor[i] = { ids: anchor[j].ids, phase: anchor[j].phase };
        break;
      }
    }

    // 2c) a zap still without an owner is an entry that never reached a mint: failed copy.
    txs.forEach((t, i) => {
      if (anchor[i] || t.kind !== 'zap_swap') return;
      const d = parse(t.detail);
      if (d.target) anchor[i] = { ids: [failId(d.target)], phase: 'open' };
    });

    // 3) sum up
    txs.forEach((t, i) => {
      const a = anchor[i];
      if (!a) return;
      const gasUsd = gasUsdOf(t, ethUsd);
      const d = parse(t.detail);
      const sw = swapCostOf(d);
      const share = a.ids.length;
      for (const id of a.ids) {
        if (typeof id === 'string') {
          const key = id.slice(FAIL_PREFIX.length);
          let f = out.failed.get(key);
          if (!f) { f = emptyFailed(); out.failed.set(key, f); }
          f.gasUsd += gasUsd;
          f.slipUsd += sw.route + sw.exec;
          f.txN += 1;
          if (t.kind === 'mint' || t.kind === 'increase') f.attempts += 1;
          f.lastTs = Math.max(f.lastTs, t.ts || 0);
          continue;
        }
        const c = bucket(id);
        const b = c[a.phase] || c.lain;
        b.gasUsd += gasUsd / share;
        b.routeUsd += sw.route / share;
        b.execUsd += sw.exec / share;
        b.slipUsd += (sw.route + sw.exec) / share;
        b.txN += 1 / share;
        c.hashes.push(t.hash);
      }
    });
    for (const f of out.failed.values()) f.totalUsd = f.gasUsd + f.slipUsd;
    for (const c of out.values()) {
      for (const ph of ['open', 'close', 'lain']) {
        c.gasUsd += c[ph].gasUsd; c.slipUsd += c[ph].slipUsd;
        c.routeUsd += c[ph].routeUsd; c.execUsd += c[ph].execUsd; c.txN += c[ph].txN;
        c[ph].txN = Math.round(c[ph].txN);
      }
      c.txN = Math.round(c.txN);
      c.totalUsd = c.gasUsd + c.slipUsd;
    }
    return out;
  }
}

module.exports = { Costs, swapCostOf };
