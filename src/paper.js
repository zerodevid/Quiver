'use strict';
// Paper trading for simulation mode: a virtual balance, mirrored opens and closes, and a
// virtual profit.
//
// Switched on by `mode.sim_balance_usd > 0` while `mode.dry_run` is true. Nothing is sent to
// the chain: the engine's entry/exit decisions are booked in the same `positions` table as real
// ones (so the dashboard, Telegram and equity curve work unchanged), marked by a `sim:` token id.
//
//  - Cash is derived, not stored: balance − cost of every simulated position + what came back.
//  - The position is a plain concentrated-liquidity position (liquidity L over the tick range)
//    valued at the live pool price. For Meteora DLMM this treats the bins as one uniform range,
//    a good approximation for the spot shape and a rougher one for curve / bid-ask.
//  - Fees follow the target: our share of the fees the target's mirrored position earned since
//    we opened (its `wpositions.live_fee_q` growth × our value / its value), only while we are
//    in range. Without target data nothing accrues.
//  - Every entry and exit pays `mode.sim_friction_pct` (default 0.3) for the swaps, slippage and
//    fees a real zap in/out would cost.
const m = require('./v3math');
const { usdPerQuote } = require('./policy');

const SIM_PREFIX = 'sim:';
const DEFAULT_FRICTION_PCT = 0.3;
const RESEARCH_ASK_MS = 10 * 60_000;

const isSim = (r) => typeof r?.token_id === 'string' && r.token_id.startsWith(SIM_PREFIX);

const extOf = (r) => { try { return JSON.parse(r?.ext || '{}') || {}; } catch { return {}; } };

// The fee accrued so far as raw token amounts, in the shape the sync code reads from the chain:
// all of it in the quote asset's token (valued 1:1 by valueInQuote, whatever the pool price).
function simFee(chain, row) {
  const fq = Number(extOf(row).sim?.fq) || 0;
  const q = chain.quoteSideOf(row.token0, row.token1);
  if (!q || !(fq > 0)) return { fee0: 0n, fee1: 0n };
  const raw = BigInt(Math.floor(fq * 10 ** q.decimals));
  return q.side === 0 ? { fee0: raw, fee1: 0n } : { fee0: 0n, fee1: raw };
}

class PaperBook {
  constructor(engine) {
    this.e = engine;
    this.askedAt = new Map();      // target -> last time its research was requested
    this.warned = new Set();
  }

  get store() { return this.e.store; }
  get net() { return this.e.network; }

  startUsd() {
    const v = Number(this.e.cfg.mode?.sim_balance_usd);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }
  frictionPct() {
    const v = Number(this.e.cfg.mode?.sim_friction_pct);
    return Number.isFinite(v) && v >= 0 ? v : DEFAULT_FRICTION_PCT;
  }
  on() { return this.e.dryRun() && this.startUsd() > 0; }

  rate(symbol) { return usdPerQuote(symbol, this.e.ethUsd, this.e.chain); }

  // ---- books -------------------------------------------------------------------------
  rows(status) {
    return this.store.all(`SELECT * FROM positions WHERE chain=? AND token_id LIKE 'sim:%'${status ? ' AND status=?' : " AND status IN ('open','closed')"}`,
      ...[this.net, ...(status ? [status] : [])]);
  }

  // Virtual cash in USD: the starting balance, minus what every simulated position cost, plus
  // everything that came back (closes and partial withdrawals).
  cashUsd() {
    let cash = this.startUsd();
    for (const r of this.rows()) cash += ((r.out_quote || 0) - (r.cost_quote || 0)) * this.rate(r.quote_symbol);
    return Math.max(0, cash);
  }

  // Same shape as Engine.refreshCash, so the dashboard and equity snapshots need no special case.
  cashObj() {
    const usd = this.cashUsd();
    return { usdg: usd, eth: 0, weth: 0, usd, ts: Date.now() };
  }

  // The virtual balance as "wallet capital", in the shape of Capital.summary(): the dashboard's
  // net PnL (total − capital) is then the simulated profit.
  capital() {
    const start = this.startUsd();
    return { baselineUsd: start, baselineTs: Number(this.store.getState(this.e.sk('sim_since'), 0)) || Date.now(),
      depositsUsd: 0, withdrawalsUsd: 0, count: 0, capitalUsd: start, syncedAt: Date.now() };
  }

  // Totals for the dashboard: start, cash, equity (cash + open positions + their fees), profit.
  status() {
    if (!this.on()) return null;
    const s = this.e.positions.summary(this.e.ethUsd);
    const cash = this.cashUsd();
    const equity = cash + s.exposureUsd + s.feeUsd;
    const closed = this.rows('closed');
    const wins = closed.filter((r) => (r.out_quote || 0) > (r.cost_quote || 0)).length;
    return {
      startUsd: this.startUsd(), cashUsd: cash, equityUsd: equity, pnlUsd: equity - this.startUsd(),
      pnlPct: (equity / this.startUsd() - 1) * 100, openCount: this.rows('open').length,
      closedCount: closed.length, wins, frictionPct: this.frictionPct(),
    };
  }

  // ---- entry -------------------------------------------------------------------------
  // Book a copied entry (or an addition to a mirror) at the plan's size and the pool price `sqrt`.
  async open(plan, act, { sqrt }) {
    const e = this.e;
    const [t0, t1] = await e.chain.tokens([plan.token0, plan.token1]);
    const a0 = BigInt(plan.amount0), a1 = BigInt(plan.amount1);
    const sa = m.getSqrtRatioAtTick(plan.tickLower), sb = m.getSqrtRatioAtTick(plan.tickUpper);
    const val = (x0, x1) => e.chain.valueInQuote({ sqrtPriceX96: BigInt(sqrt), amount0: x0, amount1: x1, dec0: t0.decimals, dec1: t1.decimals, token0: plan.token0, token1: plan.token1 });
    const valueQuote = val(a0, a1)?.value ?? plan.valueQuote;
    let L = plan.liquidity != null ? BigInt(plan.liquidity) : m.liquidityForAmounts(BigInt(sqrt), sa, sb, a0, a1);
    if (plan.liquidity == null && L > 0n) {
      // A plan without liquidity (Solana: the token split follows the venue's shape, e.g. a
      // DLMM curve) is rescaled so the uniform-range position starts at exactly the planned value.
      const at = m.amountsForLiquidity(BigInt(sqrt), sa, sb, L);
      const v1 = val(at.amount0, at.amount1)?.value;
      if (v1 > 0 && valueQuote > 0) L = (L * BigInt(Math.round((valueQuote / v1) * 1e9))) / 1_000_000_000n;
    }
    if (L <= 0n) throw new Error('ukuran posisi simulasi nol');
    const costQuote = valueQuote * (1 + this.frictionPct() / 100);
    const costUsd = costQuote * this.rate(plan.quoteSymbol);
    if (costUsd > this.cashUsd() + 0.01) throw new Error(`saldo simulasi tidak cukup ($${this.cashUsd().toFixed(2)} < $${costUsd.toFixed(2)})`);

    const adding = plan.action === 'increase' && plan.positionId;
    let id;
    if (adding) {
      const prev = this.store.get('SELECT liquidity, cost0, cost1 FROM positions WHERE id=?', plan.positionId) || { liquidity: '0', cost0: '0', cost1: '0' };
      this.store.run('UPDATE positions SET liquidity=?, cost0=?, cost1=?, cost_quote=COALESCE(cost_quote,0)+? WHERE id=?',
        (L + BigInt(prev.liquidity || '0')).toString(), (a0 + BigInt(prev.cost0 || '0')).toString(), (a1 + BigInt(prev.cost1 || '0')).toString(),
        costQuote, plan.positionId);
      id = plan.positionId;
    } else {
      const tokenId = `${SIM_PREFIX}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
      id = e.positions.record({ ...plan, liquidity: L.toString() }, {
        tokenId, target: plan.target, cost0: a0.toString(), cost1: a1.toString(), costQuote, entrySqrt: BigInt(sqrt),
      });
      this.patchSim(id, { fq: 0, tf: null, range: plan.targetRange ?? null });
    }
    const usd = valueQuote * this.rate(plan.quoteSymbol);
    const pair = `${t0.symbol}/${t1.symbol}`;
    return { positionId: id, adding: !!adding, pair, valueUsd: usd, curTick: plan.curTick ?? null,
      note: `${adding ? 'tambah ' : ''}${pair} $${usd.toFixed(2)} (simulasi, #${id})` };
  }

  // The whole entry decision for a simulated entry: book it, record the decision, notify.
  async copyEntry(d, act, { sqrt }) {
    const e = this.e;
    try {
      const r = await this.open(d.plan, act, { sqrt });
      e.lastCopyAt.set(act.poolRef, Date.now());
      e.decide(act.id, 'copy', `[simulasi] ${d.reason} — ${r.note}`, d.plan, null, r.positionId);
      e.notify(`LP disalin (simulasi): ${r.note}`, {
        kind: 'entry', positionId: r.positionId, adding: r.adding, reentry: act.kind === 'reentry', simulated: true,
        pair: r.pair, valueUsd: r.valueUsd, curTick: r.curTick, steps: [],
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
        targetUsd: d.plan.targetValueUsd ?? null, targetTs: act.ts ?? null, targetRange: d.plan.targetRange ?? null,
      });
    } catch (err) {
      e.stats.errors++;
      e.decide(act.id, 'error', String(err.message).slice(0, 300), d.plan);
      e.store.log('error', `simulasi masuk: ${err.message}`);
    }
  }

  // ---- exit --------------------------------------------------------------------------
  // Close (or partly withdraw) a simulated position at the current price. plan: {full, liquidity}.
  async close(pos, plan) {
    const e = this.e;
    const row = this.store.get('SELECT * FROM positions WHERE id=?', pos.id);
    if (!row || row.status !== 'open') throw new Error(`posisi #${pos.id} sudah ${row?.status ?? 'tidak ada'}`);
    const L = BigInt(row.liquidity || '0');
    const want = plan.liquidity != null ? BigInt(plan.liquidity) : L;
    const takeL = plan.full || want >= L ? L : want;
    const full = plan.full || takeL >= L;
    const s = await e.positions.markSlotFor(row);
    if (!s) throw new Error('harga pool tidak terbaca');
    const [t0, t1] = await e.chain.tokens([row.token0, row.token1]);
    const sa = m.getSqrtRatioAtTick(row.tick_lower), sb = m.getSqrtRatioAtTick(row.tick_upper);
    const comp = s.poolSqrt ?? s.sqrtPriceX96;            // composition follows the pool's own price
    const amt = m.amountsForLiquidity(comp, sa, sb, takeL);
    const v = e.chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1, dec0: t0.decimals, dec1: t1.decimals, token0: row.token0, token1: row.token1 });
    if (!v) throw new Error('posisi tidak bisa dinilai');
    const sim = extOf(row).sim || {};
    const feeQuote = (Number(sim.fq) || 0) * (full ? 1 : Number(takeL) / Number(L));
    const outQuote = (v.value + feeQuote) * (1 - this.frictionPct() / 100);
    const feeRaw = simFee(e.chain, { ...row, ext: JSON.stringify({ sim: { fq: feeQuote } }) });
    const out0 = amt.amount0 + feeRaw.fee0, out1 = amt.amount1 + feeRaw.fee1;
    if (full) {
      e.positions.markClosed(row.id, { out0, out1, outQuote, txHash: null, exitSqrt: s.poolSqrt ?? null, left: null });
    } else {
      this.patchSim(row.id, { fq: (Number(sim.fq) || 0) - feeQuote });
      e.positions.markDecreased(row.id, { liquidity: (L - takeL).toString(), out0, out1, outQuote, txHash: null, left: null });
    }
    const k = this.rate(row.quote_symbol);
    const pair = `${t0.symbol}/${t1.symbol}`;
    return { full, pair, outUsd: outQuote * k, costUsd: (row.cost_quote || 0) * k,
      note: `${full ? 'tutup penuh' : 'kurangi'} posisi #${row.id} ${pair} → $${(outQuote * k).toFixed(2)} (simulasi)` };
  }

  // A target exit signal answered in simulation: same {verdict, reason, plan} shape as the live branch.
  async copyExit(plan, pos, why, act) {
    const r = await this.close(pos, plan);
    this.e.notify(`LP ditutup (simulasi): ${r.note}`, {
      kind: 'exit', positionId: pos.id, full: r.full, simulated: true, pair: r.pair, outUsd: r.outUsd, costUsd: r.costUsd,
      target: act?.target ?? pos.target, mirrorOf: act?.tokenId ?? pos.mirror_of, reason: why,
      targetUsd: act ? ((act.valueQuote || 0) * usdPerQuote(act.quoteSymbol, this.e.ethUsd, this.e.chain) || null) : null,
      targetTs: act?.ts ?? null,
    });
    return `${why} — ${r.note}`;
  }

  // A standalone exit trigger (stop loss, out of range, …) in simulation.
  async autoExit(t) {
    const e = this.e;
    const pos = t.pos;
    try {
      const r = await this.close(pos, { full: true, liquidity: pos.liquidity });
      e.notify(`keluar mandiri #${pos.id} (simulasi): ${t.reason}`, {
        kind: 'exit', positionId: pos.id, full: true, auto: true, simulated: true, pair: r.pair, outUsd: r.outUsd, costUsd: r.costUsd,
        target: pos.target, mirrorOf: pos.mirror_of, reason: t.reason,
      });
      if (t.kind === 'oor' && pos.mirror_of && pos.target) {
        e.watchReentry({ target: pos.target, venue: pos.venue, tokenId: pos.mirror_of }, e.rulesFrom(pos.target), { why: 'ditutup', posId: pos.id });
      }
    } catch (err) {
      e.trouble(`keluar:${pos.id}`, `keluar mandiri simulasi gagal #${pos.id}: ${err.message}`, { after: 2 });
    }
  }

  // ---- fees --------------------------------------------------------------------------
  patchSim(id, patch) {
    const row = this.store.get('SELECT ext FROM positions WHERE id=?', id);
    const ext = extOf(row);
    ext.sim = { ...(ext.sim || {}), ...patch };
    this.store.run('UPDATE positions SET ext=? WHERE id=?', JSON.stringify(ext), id);
  }

  targetRow(r) {
    return this.store.get("SELECT * FROM wpositions WHERE chain=? AND lower(wallet)=lower(?) AND venue=? AND token_id=? AND status='open'",
      this.net, r.target, r.venue, r.mirror_of) || null;
  }

  // Move the fee accrual of every open simulated position forward. Called before each position sync.
  async accrue() {
    if (!this.on()) return;
    for (const r of this.rows('open')) {
      try { await this.accrueOne(r); }
      catch (err) {
        if (!this.warned.has(r.id)) { this.warned.add(r.id); this.e.log(`fee simulasi #${r.id}: ${err.message}`); }
      }
    }
  }

  async accrueOne(r) {
    if (!r.target || !r.mirror_of) return;
    const w = this.targetRow(r);
    if (!w) {
      // No research of the target's position yet: ask for one (rarely), accrue once it exists.
      if (Date.now() - (this.askedAt.get(r.target) || 0) > RESEARCH_ASK_MS) {
        this.askedAt.set(r.target, Date.now());
        this.e.onResearchNeeded?.(r.target, 'full');
      }
      return;
    }
    await this.e.paperResearch().refreshOpen([w], this.e.ethUsd).catch(() => {});
    const sim = extOf(r).sim || {};
    const tfNow = Number(w.live_fee_q) || 0, tvNow = Number(w.live_value_q) || 0;
    if (sim.tf == null) { this.patchSim(r.id, { tf: tfNow }); return; }
    // The target claimed (its pending fee fell): what is pending now is new since the claim.
    const delta = tfNow >= sim.tf ? tfNow - sim.tf : tfNow;
    if (!(delta > 0)) { if (tfNow !== sim.tf) this.patchSim(r.id, { tf: tfNow }); return; }
    let share = 0;
    const s = await this.e.positions.markSlotFor(r).catch(() => null);
    if (s && tvNow > 0 && m.sideOfRange(s.tick, r.tick_lower, r.tick_upper) === 'both') {
      const [t0, t1] = await this.e.chain.tokens([r.token0, r.token1]);
      const amt = m.amountsForLiquidity(s.poolSqrt ?? s.sqrtPriceX96, m.getSqrtRatioAtTick(r.tick_lower), m.getSqrtRatioAtTick(r.tick_upper), BigInt(r.liquidity || '0'));
      const v = this.e.chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, ...amt, dec0: t0.decimals, dec1: t1.decimals, token0: r.token0, token1: r.token1 });
      if (v) share = Math.min(1, (v.value * this.rate(r.quote_symbol)) / tvNow);
    }
    const gained = (delta * share) / this.rate(r.quote_symbol);
    this.patchSim(r.id, { tf: tfNow, fq: (Number(sim.fq) || 0) + gained });
  }

  // ---- housekeeping ------------------------------------------------------------------
  // Leaving simulation: its positions must not be counted as real ones. They are kept (status
  // 'sim') but no query that looks at open/closed sees them any more.
  retire() {
    const n = this.store.run("UPDATE positions SET status='sim' WHERE chain=? AND token_id LIKE 'sim:%' AND status IN ('open','closed')", this.net).changes;
    return Number(n || 0);
  }

  // Called on every sync and on mode changes: simulated positions of a book that is no longer
  // on (LIVE switched on, or the balance cleared) must not linger as if they were real.
  settle() {
    if (this.on()) return 0;
    const has = this.store.get("SELECT 1 AS x FROM positions WHERE chain=? AND token_id LIKE 'sim:%' AND status IN ('open','closed') LIMIT 1", this.net);
    return has ? this.retire() : 0;
  }

  // When this simulation began. Equity points before it belong to real trading and are never
  // touched by a reset.
  ensureSince() {
    const k = this.e.sk('sim_since');
    let since = Number(this.store.getState(k, 0)) || 0;
    if (!since) { since = Date.now(); this.store.setState(k, since); }
    return since;
  }

  // Start over: the simulated positions are retired and the curve restarts from the balance.
  reset() {
    const since = this.ensureSince();
    const n = this.retire();
    this.store.run('DELETE FROM equity WHERE chain=? AND ts >= ?', this.net, since);
    this.store.setState(this.e.sk('sim_since'), Date.now());
    return n;
  }
}

module.exports = { PaperBook, isSim, simFee, SIM_PREFIX };
