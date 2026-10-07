'use strict';
// Our own positions on Solana. Bookkeeping (record/markClosed/markDecreased, leftover tokens,
// summary, exit triggers, the markFor price guard) is inherited whole from Positions — only
// how the chain is READ changes: liquidity, token amounts and fees per position through the
// venue adapter, not eth_call to the PositionManager.
const { Positions } = require('../positions');
const { usdPerQuote } = require('../policy');
const { isSim, simFee } = require('../paper');
const m = require('../v3math');

class SolanaPositions extends Positions {
  constructor(opts) {
    super(opts);
    this.balances = opts.balances || null;   // () => Map mint->BigInt (engine.exec.balances)
  }

  static extOf(r) { try { return JSON.parse(r.ext || '{}') || {}; } catch { return {}; } }

  // Positions are recorded with the venue's native data (bin/tick range, NFT mint) in the ext column.
  record(plan, info) {
    const id = super.record(plan, info);
    const ext = { lower: plan.lower, upper: plan.upper, binStep: plan.binStep ?? null, ...(info.ext || {}) };
    this.store.run('UPDATE positions SET ext=? WHERE id=?', JSON.stringify(ext), id);
    return id;
  }

  // Solana addresses are case-sensitive — not lower-cased like the EVM version.
  leftoverRows(token = null) {
    return this.store.all(`SELECT id, token0, token1, pool_ref, venue, quote_symbol, left_token, left_amount, left_quote, out_quote,
        entry_sqrt, exit_sqrt, liquidity, cost0, cost1, tick_lower, tick_upper
      FROM positions WHERE chain=? AND left_token IS NOT NULL AND left_amount != '0'${token ? ' AND left_token=?' : ''} ORDER BY closed_ts, id`,
    this.chain.network, ...(token ? [String(token)] : []));
  }

  // Read open positions through the adapters, grouped by venue.
  // Returns Map our-position-id -> normalised position | null (the account no longer exists).
  // A venue that failed to read: its positions are NOT in the map (≠ null) — the caller
  // treats them as stale, not empty.
  async readChain(rows) {
    const out = new Map();
    const byVenue = new Map();
    for (const r of rows) {
      if (!r.token_id || isSim(r) || !this.chain.isSolVenue(r.venue)) continue;
      (byVenue.get(r.venue) || byVenue.set(r.venue, []).get(r.venue)).push(r);
    }
    for (const [venue, list] of byVenue) {
      try {
        const got = await this.chain.adapter(venue).getPositions(list.map((r) => ({ id: r.token_id, pool: r.pool_ref })), (m) => this.chain.decimalsMap(m));
        for (const r of list) if (got.has(r.token_id)) out.set(r.id, got.get(r.token_id));
      } catch (e) {
        this.log(`sinkron posisi ${venue}: ${e.message}`);
      }
    }
    return out;
  }

  async sync(ethUsd) {
    const rows = this.open();
    if (!rows.length) { this.live = []; this.lastSync = Date.now(); return []; }
    const chainPos = await this.readChain(rows);
    // Simulated positions (paper.js) are not on chain: their contents come from the books at the pool price.
    for (const r of rows) if (isSim(r)) chainPos.set(r.id, { liquidity: BigInt(r.liquidity || '0'), ...simFee(this.chain, r), sim: true });

    // pool state per venue
    const poolBy = new Map();
    const byVenue = new Map();
    for (const r of rows) if (this.chain.isSolVenue(r.venue)) (byVenue.get(r.venue) || byVenue.set(r.venue, new Set()).get(r.venue)).add(r.pool_ref);
    for (const [venue, set] of byVenue) {
      try { for (const [a, st] of await this.chain.pools(venue, [...set])) poolBy.set(a, st); }
      catch (e) { this.log(`state pool ${venue}: ${e.message}`); }
    }

    const metas = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]).filter(Boolean))]);
    const metaBy = new Map(metas.filter(Boolean).map((t) => [t.address, t]));
    const prevLive = new Map((this.live || []).map((p) => [p.id, p]));
    const out = [];
    for (const r of rows) {
      const st = poolBy.get(r.pool_ref) || null;
      const cp = chainPos.get(r.id);
      const stale = cp === undefined;          // unreadable
      const gone = cp === null;                // the position account no longer exists
      const L = stale ? BigInt(r.liquidity || '0') : gone ? 0n : BigInt(cp.liquidity);
      const d0 = metaBy.get(r.token0)?.decimals ?? st?.dec0 ?? 9;
      const d1 = metaBy.get(r.token1)?.decimals ?? st?.dec1 ?? 9;
      let amount0 = cp ? cp.amount0 : 0n, amount1 = cp ? cp.amount1 : 0n;
      if (cp?.sim) {
        // At the pool's own price, treating the range as one uniform liquidity band (see paper.js).
        const a = st && L > 0n ? m.amountsForLiquidity(st.sqrtX96, m.getSqrtRatioAtTick(r.tick_lower), m.getSqrtRatioAtTick(r.tick_upper), L) : { amount0: 0n, amount1: 0n };
        amount0 = a.amount0; amount1 = a.amount1;
      }
      const fee0 = cp ? cp.fee0 : 0n, fee1 = cp ? cp.fee1 : 0n;
      const s = st ? { sqrtPriceX96: st.sqrtX96, tick: st.tick } : null;
      const mark = s ? await this.markFor(r, s, st.liquidity ?? 1n) : null;
      let valueQuote = null, feeQuote = null, hodl = null;
      const val = (a0, a1) => (mark ? this.chain.valueAs({ sqrtPriceX96: mark.sqrt, amount0: a0, amount1: a1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 }, r.quote_symbol, ethUsd) : null);
      if (!stale) { valueQuote = val(amount0, amount1); feeQuote = val(fee0, fee1); }
      hodl = val(BigInt(r.cost0 || '0'), BigInt(r.cost1 || '0'));
      if (feeQuote != null && (!Number.isFinite(feeQuote) || feeQuote > Math.max(r.cost_quote || 0, 1) * 10 + 100)) {
        if (!this.markWarned.has(`fee:${r.id}`)) { this.markWarned.add(`fee:${r.id}`); this.log(`fee posisi #${r.id} terbaca ${feeQuote} — tidak masuk akal, pakai angka terakhir`); }
        feeQuote = Number.isFinite(r.fees_quote) ? r.fees_quote : 0;
      }
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const toUsd = (x) => (x == null ? null : x * k);
      const costUsd = toUsd(r.cost_quote) ?? 0;
      const withdrawnUsd = toUsd(r.out_quote) ?? 0;
      const valueStale = valueQuote == null && L > 0n;
      const valUsd = valueQuote != null ? toUsd(valueQuote)
        : L > 0n ? (prevLive.get(r.id)?.valueUsd ?? Math.max(0, costUsd - withdrawnUsd)) : 0;
      const feeUsd = toUsd(feeQuote ?? (stale ? r.fees_quote : 0)) ?? 0;
      const claimedUsd = toUsd(r.claimed_quote) ?? 0;
      const pnlUsd = valUsd + feeUsd + claimedUsd + withdrawnUsd - costUsd;
      if (!stale) {
        this.store.run('UPDATE positions SET liquidity=?, fees_quote=?, last_sync=? WHERE id=?', L.toString(), feeQuote ?? 0, Date.now(), r.id);
      }
      // A position moved in place (Meteora rebalance_liquidity) has a new range on chain: the
      // books follow it even when the move itself was not booked (process died after sending).
      if (r.venue === 'meteora' && cp && !cp.sim && L > 0n && cp.tickLower != null && (cp.tickLower !== r.tick_lower || cp.tickUpper !== r.tick_upper)) {
        const own = SolanaPositions.extOf(r);
        const ext = { ...own, ...(cp.ext || {}), lower: cp.lower, upper: cp.upper, strategy: own.strategy ?? cp.ext?.strategy ?? null };
        this.store.run('UPDATE positions SET tick_lower=?, tick_upper=?, ext=? WHERE id=?', cp.tickLower, cp.tickUpper, JSON.stringify(ext), r.id);
        r.tick_lower = cp.tickLower; r.tick_upper = cp.tickUpper; r.ext = JSON.stringify(ext);
      }
      const inRange = st && L > 0n ? st.tick >= r.tick_lower && st.tick < r.tick_upper : null;
      out.push({
        ...r, liquidity: L.toString(),
        symbol0: metaBy.get(r.token0)?.symbol || '?', symbol1: metaBy.get(r.token1)?.symbol || '?',
        dec0: d0, dec1: d1, quoteSide: this.chain.quoteSideOf(r.token0, r.token1)?.side ?? null,
        amount0: amount0.toString(), amount1: amount1.toString(), fee0: fee0.toString(), fee1: fee1.toString(),
        curTick: st?.tick ?? null, inRange, curSqrt: st ? st.sqrtX96.toString() : null,
        markSqrt: mark && mark.ref ? mark.sqrt.toString() : null, markRef: mark?.ref ?? null,
        entrySqrt: Positions.entrySqrtOf(r),
        valueUsd: valUsd, feeUsd, claimedUsd, withdrawnUsd, costUsd, pnlUsd,
        pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
        ilUsd: hodl != null && valueQuote != null ? toUsd(valueQuote) - toUsd(hodl) : null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        // Empty only when the chain REALLY answered: the account is gone or L is zero.
        empty: !stale && L === 0n,
        liqStale: stale, valueStale,
        ext: SolanaPositions.extOf(r),
      });
    }
    this.live = out;
    this.lastSync = Date.now();
    return out;
  }

  // Re-read on its own before a position is closed in the database. A freshly opened position
  // (< 2 minutes) is not trusted to be empty: a lagging node may not see its account yet.
  async confirmEmpty(pos) {
    try {
      if (Date.now() - (pos.opened_ts || 0) < 120_000) return false;
      const got = await this.chain.adapter(pos.venue).getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (m) => this.chain.decimalsMap(m));
      if (!got.has(pos.token_id)) return false;
      const p = got.get(pos.token_id);
      return p === null || BigInt(p.liquidity) === 0n;
    } catch { return false; }
  }

  // Value of leftover tokens at the Jupiter price (aggregated over all pools — more robust
  // against one pool that was swept empty). Tokens that shrank outside the bot are taken as sold.
  async refreshLeftovers(ethUsd) {
    let rows = this.leftoverRows();
    let usd = 0, closeUsd = 0;
    const items = [];
    if (rows.length && this.balances) {
      try {
        const bal = await this.balances();
        const toks = [...new Set(rows.map((r) => r.left_token))];
        let changed = false;
        for (const t of toks) {
          const mine = rows.filter((r) => r.left_token === t);
          const total = mine.reduce((a, r) => a + BigInt(r.left_amount), 0n);
          const have = bal.get(t) ?? 0n;
          if (have >= total) continue;
          const gone = total - have;
          const v = await this.valueLeftover(mine, gone, ethUsd);
          this.log(`token sisa ${t.slice(0, 8)}… berkurang di luar bot (${gone} satuan) — dianggap terjual $${v.toFixed(2)}`);
          this.recordLeftoverSale({ token: t, amount: gone, quoteToken: null, usdOut: v, ethUsd });
          changed = true;
        }
        if (changed) rows = this.leftoverRows();
      } catch (e) { this.log(`saldo token sisa: ${e.message}`); }
    }
    if (rows.length) {
      const px = await this.chain.jup.prices([...new Set(rows.map((r) => r.left_token))]).catch(() => new Map());
      const dec = await this.chain.decimalsMap([...new Set(rows.map((r) => r.left_token))]).catch(() => new Map());
      for (const r of rows) {
        const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
        const p = px.get(r.left_token), d = dec.get(r.left_token);
        const now = p != null && d != null ? (Number(r.left_amount) / 10 ** d) * p : (r.left_quote || 0) * k;
        usd += now; closeUsd += (r.left_quote || 0) * k;
        items.push({ id: r.id, token: r.left_token, amount: r.left_amount, usd: now });
      }
    }
    this.leftoverVal = { usd, closeUsd, items, ts: Date.now() };
    return this.leftoverVal;
  }

  async valueLeftover(rows, amt) {
    const t = rows[0].left_token;
    const [px, dec] = await Promise.all([this.chain.jup.prices([t]).catch(() => new Map()), this.chain.decimalsMap([t]).catch(() => new Map())]);
    const p = px.get(t), d = dec.get(t);
    if (p != null && d != null) return (Number(amt) / 10 ** d) * p;
    const total = rows.reduce((a, x) => a + BigInt(x.left_amount), 0n);
    return total > 0n ? rows.reduce((a, x) => a + (x.left_quote || 0), 0) * Number(amt) / Number(total) : 0;
  }

  async markSlotFor(r) {
    const st = await this.chain.pool(r.venue, r.pool_ref).catch(() => null);
    if (!st) return null;
    const s = { sqrtPriceX96: st.sqrtX96, tick: st.tick };
    const mk = await this.markFor(r, s, st.liquidity ?? 1n);
    return mk ? { sqrtPriceX96: mk.sqrt, tick: st.tick, ref: mk.ref, poolSqrt: st.sqrtX96 } : null;
  }
  async poolLiquidityOf(venue, poolRef) {
    const st = await this.chain.pool(venue, poolRef).catch(() => null);
    return st ? (st.liquidity ?? 1n) : 0n;
  }
}

module.exports = { SolanaPositions };
