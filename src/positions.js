'use strict';
const { ensureChain } = require('./networks');
// Sync of our own positions: current value, collected fees, PnL, and
// standalone exit triggers (out of range, stop loss, take profit, age).
const { ethers } = require('ethers');
const { ABI } = require('./chain');
const { computePoolId, priceUsable } = require('./pools');
const { unclaimedV4, unclaimedV3 } = require('./fees');
const m = require('./v3math');
const { usdPerQuote } = require('./policy');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const IF_POOL3 = new ethers.Interface(ABI.poolV3);

class Positions {
  constructor({ rpc, store, chain, log }) {
    chain = ensureChain(chain);
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.live = [];      // last sync result, used by the dashboard
    this.farStreak = new Map();   // position id -> how many consecutive syncs its price was too far from the range
    this.lastSync = 0;
    this.syncing = null; // the sync currently running, shared
    this.markWarned = new Set();   // positions whose pool price has already been reported as absurd
  }

  open() {
    return this.store.all("SELECT * FROM positions WHERE chain=? AND status='open'", this.chain.network);
  }

  // Record a new position resulting from our mint
  // entrySqrt: the pool price at mint — used by the detail page to mark the entry point.
  record(plan, { tokenId, txHash, target, cost0, cost1, costQuote, openedTs, entrySqrt }) {
    const r = this.store.run(
      `INSERT INTO positions
       (chain,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
        target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open,entry_sqrt,last_sync)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.chain.network, plan.venue, tokenId ?? null, plan.poolRef, plan.token0, plan.token1, plan.fee ?? null,
      plan.tickSpacing ?? null, plan.poolKey?.hooks ?? null, plan.tickLower, plan.tickUpper,
      plan.liquidity, target ?? null, plan.mirrorOf ?? null, 'open', openedTs ?? Date.now(),
      String(cost0 ?? plan.amount0), String(cost1 ?? plan.amount1), costQuote ?? plan.valueQuote,
      plan.quoteSymbol, txHash ?? null, entrySqrt != null ? String(entrySqrt) : null, Date.now());
    return Number(r.lastInsertRowid);
  }

  // The withdrawal result is ADDED to the record: out0/out1/out_quote hold everything
  // that ever came out of the position (partial withdrawal + close), and the leftover memecoin not yet
  // sold also accumulates — so PnL = out_quote − cost_quote stays correct however many
  // times the position is partially withdrawn before it closes.
  // `left`: memecoin that also came out and is not yet sold — {token, amount, quote}; its
  // quote value (at the close price) is already included in outQuote.
  #addProceeds(id, { out0, out1, outQuote, left }) {
    const prev = this.store.get('SELECT out0, out1, left_token, left_amount FROM positions WHERE id=?', id) || {};
    const sum = (a, b) => (BigInt(a || '0') + BigInt(b ?? 0)).toString();
    const sameLeft = left && (!prev.left_token || prev.left_token === left.token);
    this.store.run(
      `UPDATE positions SET out0=?, out1=?, out_quote=COALESCE(out_quote,0)+?,
         left_token=COALESCE(?, left_token), left_amount=?, left_quote=COALESCE(left_quote,0)+? WHERE id=?`,
      sum(prev.out0, out0), sum(prev.out1, out1), outQuote ?? 0,
      sameLeft ? left.token : null, sameLeft ? sum(prev.left_amount, left.amount) : (prev.left_amount || '0'),
      sameLeft ? (left.quote || 0) : 0, id);
  }

  #noteProceeds(txHash, key, { out0, out1, outQuote }) {
    if (!txHash) return;
    const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
    const detail = JSON.parse(tx?.detail || '{}');
    detail[key] = { amount0: String(out0 ?? 0), amount1: String(out1 ?? 0), quote: outQuote ?? 0 };
    this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
  }

  markClosed(id, { out0, out1, outQuote, txHash, exitSqrt, left = null }) {
    // The last fence: results are SUMMED, so closing an already-closed position =
    // doubled proceeds (lp3 #220, $150 → $300). A racing caller must fail here.
    const st = this.store.get('SELECT status FROM positions WHERE id=?', id)?.status;
    if (st !== 'open') throw new Error(`posisi #${id} sudah ${st ?? 'tidak ada'} — hasil tutup tidak dibukukan ulang`);
    this.#addProceeds(id, { out0, out1, outQuote, left });
    this.store.run(
      `UPDATE positions SET status='closed', closed_ts=?, out_quote=out_quote + COALESCE(claimed_quote,0), tx_close=?, exit_sqrt=?, liquidity='0' WHERE id=?`,
      Date.now(), txHash ?? null, exitSqrt != null ? String(exitSqrt) : null, id);
    this.#noteProceeds(txHash, 'closeProceeds', { out0, out1, outQuote });
  }

  // Partial withdrawal: the position stays open with the remaining liquidity, the proceeds are recorded
  // like close proceeds. While still open, its PnL = current value + fee + what was already
  // withdrawn − capital (see sync/summary).
  markDecreased(id, { liquidity, out0, out1, outQuote, txHash, left = null }) {
    this.#addProceeds(id, { out0, out1, outQuote, left });
    this.store.run('UPDATE positions SET liquidity=? WHERE id=?', String(liquidity), id);
    this.#noteProceeds(txHash, 'decreaseProceeds', { out0, out1, outQuote });
  }

  // ---- leftover memecoin: from "valued at the close price" to "actual sale proceeds" ----
  // Positions holding leftover memecoin from their close, oldest first (FIFO).
  leftoverRows(token = null) {
    return this.store.all(`SELECT id, token0, token1, pool_ref, venue, quote_symbol, left_token, left_amount, left_quote, out_quote,
        entry_sqrt, exit_sqrt, liquidity, cost0, cost1, tick_lower, tick_upper
      FROM positions WHERE chain=? AND left_token IS NOT NULL AND left_amount != '0'${token ? ' AND left_token=?' : ''} ORDER BY closed_ts, id`,
    this.chain.network, ...(token ? [String(token).toLowerCase()] : []));
  }

  // Called after leftover tokens are sold (automatically or from the Swap page): the sale
  // proceeds are allocated FIFO to the positions holding them, and each
  // position's out_quote is corrected — the close price estimate replaced by what was actually received.
  // `posId` limits it to one position (an automatic sale knows its origin).
  recordLeftoverSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const rows = this.leftoverRows(token).filter((r) => posId == null || r.id === posId);
    if (!rows.length) return [];
    const sold = BigInt(amount);
    if (sold <= 0n) return [];
    // Proceeds in USD: from the quote asset amount received if known, otherwise
    // from Kyber's USD estimate.
    const qt = String(quoteToken || '').toLowerCase();
    const q = this.chain.quoteSideOf(qt, qt);
    const gotUsd = q && amountOut != null
      ? (Number(BigInt(amountOut)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1)
      : (usdOut || 0);
    let rem = sold;
    const done = [];
    for (const r of rows) {
      if (rem <= 0n) break;
      const left = BigInt(r.left_amount || '0');
      const take = left < rem ? left : rem;
      rem -= take;
      const frac = Number(take) / Number(left);
      const share = gotUsd * (Number(take) / Number(sold));
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const gotQuote = share / k;
      const closeQuote = (r.left_quote || 0) * frac;
      this.store.run('UPDATE positions SET out_quote = out_quote - ? + ?, left_quote = left_quote - ?, left_amount=? WHERE id=?',
        closeQuote, gotQuote, closeQuote, (left - take).toString(), r.id);
      done.push({ id: r.id, take, closeQuote, gotQuote });
      this.log(`posisi #${r.id}: sisa terjual, hasil ${r.quote_symbol} ${gotQuote.toFixed(2)} menggantikan taksiran tutup ${closeQuote.toFixed(2)}`);
    }
    if (txHash && done.length) {
      const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
      const detail = JSON.parse(tx?.detail || '{}');
      detail.positionSales = done.map((r) => ({ position: r.id, amount: r.take.toString(),
        closeQuote: r.closeQuote, gotQuote: r.gotQuote }));
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
    }
    return done;
  }

  // ---- memecoin from fees that were already claimed -------------------------------
  // A fee claim returns TWO tokens: a quote asset (money right away) and a memecoin
  // (not necessarily). recordFeeClaim books both into claimed_quote at the pool price
  // at claim time; the memecoin side is recorded here until it is really sold, then
  // that estimate is replaced by the actual sale proceeds. Without this ledger, a $40 fee that only
  // sold for $9 after price impact would stay recorded as $40 forever.
  noteFeeLeftover({ posId, token, amount, estQuote, txHash = null }) {
    if (!(BigInt(amount) > 0n)) return null;
    const r = this.store.run('INSERT INTO fee_leftovers(chain,position_id,ts,token,amount,est_quote,tx_hash) VALUES(?,?,?,?,?,?,?)',
      this.chain.network, posId, Date.now(), String(token).toLowerCase(), String(amount), estQuote || 0, txHash);
    return Number(r.lastInsertRowid);
  }

  // Fee rows not yet sold, in the SAME shape as leftoverRows (left_token/
  // left_amount/left_quote) so valueLeftover and leftoverQuote can be used
  // as they are to value them. Oldest first (FIFO).
  feeLeftoverRows(token = null, posId = null) {
    return this.store.all(`SELECT f.id AS fee_id, f.position_id AS id, f.ts AS fee_ts, f.est_quote AS left_quote,
        f.token AS left_token, f.amount AS left_amount,
        p.token0, p.token1, p.pool_ref, p.venue, p.quote_symbol, p.status, p.out_quote, p.claimed_quote,
        p.entry_sqrt, p.exit_sqrt, p.liquidity, p.cost0, p.cost1, p.tick_lower, p.tick_upper
      FROM fee_leftovers f JOIN positions p ON p.id=f.position_id
      WHERE f.chain=? AND f.amount != '0'${token ? ' AND f.token=?' : ''}${posId != null ? ' AND f.position_id=?' : ''}
      ORDER BY f.ts, f.id`,
    this.chain.network, ...(token ? [String(token).toLowerCase()] : []), ...(posId != null ? [posId] : []));
  }

  // Called after fee memecoin is sold. Returns how much of `amount`
  // really came from the fee ledger — the rest belongs to the close-leftover ledger and
  // is handed to recordLeftoverSale by the caller. Fees are allocated first
  // because a claim always precedes the close of the same position.
  recordFeeSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const rows = this.feeLeftoverRows(token, posId);
    let rem = BigInt(amount);
    if (!rows.length || rem <= 0n) return { consumed: 0n, done: [] };
    const qt = String(quoteToken || '').toLowerCase();
    const q = this.chain.quoteSideOf(qt, qt);
    const gotUsd = q && amountOut != null
      ? (Number(BigInt(amountOut)) / 10 ** q.decimals) * (q.kind === 'eth' ? ethUsd : 1)
      : (usdOut || 0);
    const total = BigInt(amount);
    const done = [];
    for (const r of rows) {
      if (rem <= 0n) break;
      const left = BigInt(r.left_amount || '0');
      if (left <= 0n) continue;
      const take = left < rem ? left : rem;
      rem -= take;
      const frac = Number(take) / Number(left);
      const share = gotUsd * (Number(take) / Number(total));
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const gotQuote = share / k;
      const estQuote = (r.left_quote || 0) * frac;
      // A position that is already closed: markClosed has already folded claimed_quote into out_quote,
      // so the correction must hit both — otherwise a closed position's PnL
      // keeps using the claim price estimate.
      this.store.run(`UPDATE positions SET claimed_quote = COALESCE(claimed_quote,0) - ? + ?,
          out_quote = out_quote + CASE WHEN status='closed' THEN ? ELSE 0 END WHERE id=?`,
      estQuote, gotQuote, gotQuote - estQuote, r.id);
      this.store.run('UPDATE fee_leftovers SET amount=?, est_quote=? WHERE id=?',
        (left - take).toString(), (r.left_quote || 0) - estQuote, r.fee_id);
      done.push({ id: r.id, take, estQuote, gotQuote });
      this.log(`posisi #${r.id}: fee terjual, hasil ${r.quote_symbol} ${gotQuote.toFixed(2)} menggantikan taksiran klaim ${estQuote.toFixed(2)}`);
    }
    if (txHash && done.length) {
      const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
      const detail = JSON.parse(tx?.detail || '{}');
      detail.feeSales = done.map((r) => ({ position: r.id, amount: r.take.toString(),
        estQuote: r.estQuote, gotQuote: r.gotQuote }));
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
    }
    return { consumed: BigInt(amount) - rem, done };
  }

  // One token sale, split across the two ledgers that may hold it: fees that were
  // claimed but not yet sold, then leftovers of a position close. Fees go first because a
  // claim always precedes the close of the same position. The sale proceeds are split
  // proportionally to the amount each ledger took — otherwise a single sale
  // corrects two columns with the same full proceeds.
  recordTokenSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const sold = BigInt(amount);
    const fee = this.recordFeeSale({ posId, token, amount: sold, quoteToken, amountOut, usdOut, ethUsd, txHash });
    const rest = sold - (fee?.consumed || 0n);
    if (rest <= 0n) return { fee, leftover: [] };
    const part = (x) => (x == null ? null : x * Number(rest) / Number(sold));
    const leftover = this.recordLeftoverSale({ posId, token, amount: rest, quoteToken, txHash,
      amountOut: amountOut != null ? (BigInt(amountOut) * rest / sold).toString() : null,
      usdOut: part(usdOut ?? null), ethUsd });
    return { fee, leftover };
  }

  // The value of leftover memecoin still held, at the CURRENT pool price. Read on every
  // sync together with cash; the result is used by summary() so the portfolio total does not
  // "plunge" when a position closes then "spike" when its leftovers are sold.
  async refreshLeftovers(ethUsd, wallet = null) {
    let rows = this.leftoverRows();
    let usd = 0, closeUsd = 0;
    const items = [];
    // A token that turns out to be no longer in the wallet (sold via another DEX, sent
    // out) must not keep being valued: the shortfall is considered realized at the current
    // price, like wallet research treats an outgoing transfer with no proceeds.
    // Fee memecoin that was already claimed is checked too: its balance is in the same wallet,
    // and if it vanishes outside the bot, its claimed_quote must also stop using the
    // claim price estimate.
    let feeRows = wallet ? this.feeLeftoverRows() : [];
    if ((rows.length || feeRows.length) && wallet) {
      const toksL = [...new Set([...rows.map((r) => r.left_token), ...feeRows.map((r) => r.left_token)])];
      const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const bals = await this.rpc.ethCallMany(toksL.map((t) => ({ to: t, data: IF.encodeFunctionData('balanceOf', [wallet]) })));
      let changed = false;
      for (let i = 0; i < toksL.length; i++) {
        if (!bals[i] || bals[i] === '0x') continue;
        const bal = BigInt(bals[i]);
        const mine = rows.filter((r) => r.left_token === toksL[i]);
        const mineFee = feeRows.filter((r) => r.left_token === toksL[i]);
        const qty = (list) => list.reduce((a, r) => a + BigInt(r.left_amount), 0n);
        const total = qty(mine) + qty(mineFee);
        if (bal >= total) continue;
        let gone = total - bal;
        // The shortfall is charged to the fee ledger first, in the same order as
        // recordTokenSale — so a token that is in two ledgers is never
        // counted twice.
        const takeFee = qty(mineFee) < gone ? qty(mineFee) : gone;
        if (takeFee > 0n) {
          const val = await this.valueLeftover(mineFee, takeFee, ethUsd);
          this.log(`fee ${toksL[i].slice(0, 10)}… berkurang di luar bot (${takeFee} satuan) — dianggap terjual $${val.toFixed(2)}`);
          this.recordFeeSale({ token: toksL[i], amount: takeFee, quoteToken: null, usdOut: val, ethUsd });
          gone -= takeFee;
          changed = true;
        }
        if (gone > 0n && mine.length) {
          const val = await this.valueLeftover(mine, gone, ethUsd);
          this.log(`token sisa ${toksL[i].slice(0, 10)}… berkurang di luar bot (${gone} satuan) — dianggap terjual $${val.toFixed(2)}`);
          this.recordLeftoverSale({ token: toksL[i], amount: gone, quoteToken: null, usdOut: val, ethUsd });
          changed = true;
        }
      }
      if (changed) { rows = this.leftoverRows(); feeRows = this.feeLeftoverRows(); }
    }
    if (rows.length) {
      const v4 = [...new Set(rows.filter((r) => !this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))];
      const slots = new Map(), liqs = new Map();
      if (v4.length) {
        const [ss, ls] = await Promise.all([this.chain.slot0V4Many(v4), this.chain.poolLiquidityMany(v4).catch(() => [])]);
        v4.forEach((id, i) => { slots.set(id, ss[i]); liqs.set(id, ls[i] ?? 0n); });
      }
      for (const a of new Set(rows.filter((r) => this.chain.isV3Venue(r.venue)).map((r) => r.pool_ref))) {
        try { slots.set(a, await this.chain.slot0V3(a)); liqs.set(a, await this.poolLiquidityOf('v3', a)); } catch { /* dinilai harga tutup */ }
      }
      const toks = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]))]);
      const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
      for (const r of rows) {
        const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
        // leftover tokens valued at the marking price, not the pool price that may already be empty
        const mk = await this.markFor(r, slots.get(r.pool_ref), liqs.get(r.pool_ref));
        const v = this.leftoverQuote(r, BigInt(r.left_amount), mk ? { sqrtPriceX96: mk.sqrt } : null, dec);
        // pool price unreadable: use the close value so it does not vanish from equity
        const now = (v ?? (r.left_quote || 0)) * k;
        usd += now; closeUsd += (r.left_quote || 0) * k;
        items.push({ id: r.id, token: r.left_token, amount: r.left_amount, usd: now });
      }
    }
    this.leftoverVal = { usd, closeUsd, items, ts: Date.now() };
    return this.leftoverVal;
  }

  // The marking price for position row r, given slot0 `s` and its pool's active liquidity:
  // the pool's own price if fit; otherwise another pool containing the same pair;
  // last, the position's own exit/entry price (stale, but finite and
  // sensible — better than 1e17× the fair price from a pool that has been swept empty).
  // Returns { sqrt, ref } — ref null = the pool's own price, 'exit'/'entry', or the reference pool_ref.
  async markFor(r, s, poolLiq) {
    if (!s) return null;
    // A pool price that passes priceUsable can also be absurd: a pool with 1 wei of liquidity after a
    // rug / one wild swap puts the price at 1e9× the fair price without touching the tick edge —
    // the dashboard once showed "billions of dollars". Bound: the marking price must not be more
    // than MARK_RATIO_MAX× (or less than 1/MARK_RATIO_MAX×) its comparator: the position's
    // entry price, or — if that is not recorded — the nearest edge of the position range.
    // A memecoin can indeed go 100× or −99%, but 1000× within a position's lifetime is not
    // something worth trusting from a single thin pool.
    const own = Positions.entrySqrtOf(r) ? BigInt(Positions.entrySqrtOf(r)) : null;
    const hasRange = r.tick_lower != null && r.tick_upper != null;
    const sa = hasRange ? m.getSqrtRatioAtTick(r.tick_lower) : null;
    const sb = hasRange ? m.getSqrtRatioAtTick(r.tick_upper) : null;
    const nearEdge = (x) => (x < sa ? sa : x > sb ? sb : x);   // inside the range: itself
    const ratioOk = (x, ref) => {
      const hi = x > ref ? x : ref, lo = x > ref ? ref : x;
      // price ratio = (sqrt_hi/sqrt_lo)^2 ; compared without floats
      return lo > 0n && hi * hi < lo * lo * BigInt(Positions.MARK_RATIO_MAX);
    };
    const sane = (x) => {
      if (x == null) return true;
      if (own) return ratioOk(x, own);
      if (hasRange) return ratioOk(x, nearEdge(x));
      return true;
    };
    if (priceUsable(s, poolLiq ?? 0n) && sane(s.sqrtPriceX96)) return { sqrt: s.sqrtPriceX96, ref: null };
    const alt = await this.chain.markSqrtForPair(r.token0, r.token1, r.pool_ref);
    if (alt && sane(alt.sqrtPriceX96)) return { sqrt: alt.sqrtPriceX96, ref: alt.poolRef };
    // The own price (exit / raw pool) can also be absurd or at the tick bound — if the
    // position range is known, clamp it to its edge: the last price this position passed through.
    const clamp = (x) => (hasRange && !sane(x) ? nearEdge(x) : x);
    if (r.exit_sqrt) {
      const ex = clamp(BigInt(r.exit_sqrt));
      if (sane(ex)) return { sqrt: ex, ref: 'exit' };
    }
    // The pool price is not trusted (absurd, or a pool without active liquidity) and the position
    // has a range: the nearest range edge, NOT the entry price. Outside the range the
    // position's composition is already frozen — entirely one side — and the edge is the last
    // price that really changed it; however far the price runs after that, its contents
    // stay the same. The entry price can be far outside the range (a ladder position placed
    // below the market), and valuing the converted token at that price = an
    // impossible state: if the price were still there, the position would not hold that token.
    // lp3 2026-09-19: WIN rugged 1e10×, 4 ladder positions with capital $310 read $1,229 and the
    // chart spiked a fake +$1,187 for two hours.
    if (hasRange) {
      const edge = nearEdge(s.sqrtPriceX96);
      if (edge !== s.sqrtPriceX96) {
        if (!sane(s.sqrtPriceX96) && !this.markWarned.has(r.id)) {
          this.markWarned.add(r.id);
          this.log(`harga pool posisi #${r.id} ${s.sqrtPriceX96 > (own ?? edge) ? '>' : '< 1/'}${Positions.MARK_RATIO_MAX}× harga masuk — dinilai di tepi rentang`);
        }
        return { sqrt: edge, ref: 'edge' };
      }
      // inside the range but the pool is unfit to read: this price is still the best
      if (sane(edge)) return { sqrt: edge, ref: null };
    }
    if (own) {
      if (!this.markWarned.has(r.id)) {
        this.markWarned.add(r.id);
        this.log(`harga pool posisi #${r.id} ${s.sqrtPriceX96 > own ? '>' : '< 1/'}${Positions.MARK_RATIO_MAX}× harga masuk — dinilai di harga masuk`);
      }
      return { sqrt: own, ref: 'entry' };
    }
    return { sqrt: s.sqrtPriceX96, ref: null };
  }

  // Read the pool price of position r then choose its marking price; shaped as slot0 so it can be
  // passed straight to valueInQuote. null if the pool price is not readable at all.
  async markSlotFor(r) {
    const s = this.chain.isV3Venue(r.venue) ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref);
    const mk = await this.markFor(r, s, await this.poolLiquidityOf(r.venue, r.pool_ref));
    return mk ? { sqrtPriceX96: mk.sqrt, tick: s.tick, ref: mk.ref, poolSqrt: s.sqrtPriceX96 } : null;
  }

  // Active liquidity of the pool (v3 via the pool contract, v4 via the PoolManager); 0n if unreadable.
  async poolLiquidityOf(venue, poolRef) {
    try {
      if (this.chain.isV3Venue(venue)) {
        const [wl] = await this.rpc.ethCallMany([{ to: poolRef, data: IF_POOL3.encodeFunctionData('liquidity') }]);
        return wl && wl !== '0x' ? BigInt(wl) : 0n;
      }
      return await this.chain.poolLiquidity(poolRef);
    } catch { return 0n; }
  }

  // Value of `amt` leftover tokens of row r (quote asset units) at slot0 price `s`; null if unreadable.
  leftoverQuote(r, amt, s, dec) {
    if (!s) return null;
    const side = r.left_token === r.token0 ? 0 : 1;
    const v = this.chain.valueInQuote({
      sqrtPriceX96: s.sqrtPriceX96, amount0: side === 0 ? amt : 0n, amount1: side === 1 ? amt : 0n,
      dec0: dec.get(r.token0) ?? 18, dec1: dec.get(r.token1) ?? 18, token0: r.token0, token1: r.token1,
    });
    return v ? v.value : null;
  }

  // USD value of `amt` leftover token units, valued via the pool of the first position holding them.
  async valueLeftover(rows, amt, ethUsd) {
    const r = rows[0];
    let s = null;
    try { s = this.chain.isV3Venue(r.venue) ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref); } catch { s = null; }
    const mk = await this.markFor(r, s, await this.poolLiquidityOf(r.venue, r.pool_ref));
    const toks = await this.chain.tokens([r.token0, r.token1]);
    const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
    const v = this.leftoverQuote(r, amt, mk ? { sqrtPriceX96: mk.sqrt } : null, dec);
    const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
    if (v != null) return v * k;
    // price unreadable: proportional to the close value
    const total = rows.reduce((a, x) => a + BigInt(x.left_amount), 0n);
    return rows.reduce((a, x) => a + (x.left_quote || 0), 0) * k * Number(amt) / Number(total);
  }

  // Entry price for a position recorded before the entry_sqrt column existed: derived
  // back from the deposited token amounts. Inside the range, amount1 = L·(√P − √A),
  // so √P = √A + amount1/L. All tokens on one side = the price outside the range at
  // mint; the range bound is what gets used.
  static get MARK_RATIO_MAX() { return 1000; }

  static entrySqrtOf(r) {
    if (r.entry_sqrt) return r.entry_sqrt;
    try {
      const L = BigInt(r.liquidity || '0'), c0 = BigInt(r.cost0 || '0'), c1 = BigInt(r.cost1 || '0');
      if (L <= 0n || r.tick_lower == null || r.tick_upper == null) return null;
      const a = m.getSqrtRatioAtTick(r.tick_lower), b = m.getSqrtRatioAtTick(r.tick_upper);
      if (c1 === 0n) return c0 > 0n ? a.toString() : null;
      if (c0 === 0n) return b.toString();
      const p = a + (c1 * m.Q96) / L;
      return (p < a ? a : p > b ? b : p).toString();
    } catch { return null; }
  }

  // ---- sync -----------------------------------------------------------
  // Sync on user request: the "Refresh" button in the dashboard table.
  //
  // If a sync is already running, this request rides on it — pressing the
  // button five times must not mean five rounds of eth_call, and the result
  // was read a few milliseconds ago anyway. What must NOT ride along is a sync
  // after a transaction lands (claim, compound): there the old figures are certainly wrong,
  // so its caller uses sync() directly and always re-reads.
  resync(ethUsd) {
    if (!this.syncing) this.syncing = this.sync(ethUsd).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  async sync(ethUsd) {
    const rows = this.open();
    if (!rows.length) { this.live = []; this.lastSync = Date.now(); return []; }

    // 1. current liquidity
    const v4 = rows.filter((r) => r.venue === 'v4' && r.token_id);
    const v3 = rows.filter((r) => this.chain.isV3Venue(r.venue) && r.token_id);
    const liqCalls = [
      ...v4.map((r) => ({ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.token_id)]) })),
      ...v3.map((r) => ({ to: this.chain.npmFor(r.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(r.token_id)]) })),
    ];
    // A call that FAILED (RPC error, empty reply) must NOT be read as zero:
    // zero means "liquidity exhausted" and the engine closes the position in the database without any
    // transaction. This happened when an endpoint was broken — #45 ($110) was recorded
    // closed with a result of $0 although on chain it was still whole. Failed = use the last
    // stored figure, and mark the position as not synced (not empty).
    const liqRes = await this.rpc.ethCallMany(liqCalls);
    const liqBy = new Map();
    const liqStale = new Set();
    const keepOld = (r) => { liqBy.set(r.id, BigInt(r.liquidity || '0')); liqStale.add(r.id); };
    v4.forEach((r, i) => {
      const w = liqRes[i];
      if (w && w !== '0x') liqBy.set(r.id, BigInt(w)); else keepOld(r);
    });
    v3.forEach((r, i) => {
      const w = liqRes[v4.length + i];
      let L = null;
      if (w && w !== '0x') { try { L = BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { L = null; } }
      if (L != null) liqBy.set(r.id, L); else keepOld(r);
    });

    // 2. pool state — price AND active liquidity. Zero liquidity means the price
    //    cannot be trusted (see markSqrtForPair), so they are read together.
    const poolIds = [...new Set(rows.filter((r) => r.venue === 'v4').map((r) => r.pool_ref))];
    // Liquidity that failed to read must not bring the sync down: treated as 0 → falls
    // to the reference pool / own price, which is safe.
    const [slots, poolLiq] = poolIds.length
      ? await Promise.all([this.chain.slot0V4Many(poolIds), this.chain.poolLiquidityMany(poolIds).catch(() => [])]) : [[], []];
    const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
    const poolLiqBy = new Map(poolIds.map((id, i) => [id, poolLiq[i] ?? 0n]));
    for (const r of rows.filter((x) => this.chain.isV3Venue(x.venue))) {
      if (slotBy.has(r.pool_ref) || !r.pool_ref) continue;
      slotBy.set(r.pool_ref, await this.chain.slot0V3(r.pool_ref));
      poolLiqBy.set(r.pool_ref, await this.poolLiquidityOf('v3', r.pool_ref));
    }

    const markBy = new Map();
    for (const r of rows) {
      const mk = await this.markFor(r, slotBy.get(r.pool_ref), poolLiqBy.get(r.pool_ref));
      if (mk) markBy.set(r.id, mk);
    }

    // 3. unclaimed fees
    const curTick = new Map([...slotBy.entries()].filter(([, s]) => s).map(([k, s]) => [k, s.tick]));
    const feeItems = v4.map((r) => ({ poolId: r.pool_ref, tickLower: r.tick_lower, tickUpper: r.tick_upper, tokenId: r.token_id }));
    const feesV4 = feeItems.length ? await unclaimedV4(this.chain, feeItems, curTick, this.rpc) : [];
    const owner = this.store.getState('wallet_address');
    const feeBy = new Map();
    v4.forEach((r, i) => feeBy.set(r.id, feesV4[i] || { fee0: 0n, fee1: 0n }));
    // v3 is grouped per venue: each venue has its own NPM (Uniswap v3 vs PancakeSwap v3).
    if (owner) {
      for (const venue of new Set(v3.map((r) => r.venue))) {
        const group = v3.filter((r) => r.venue === venue);
        const fees = await unclaimedV3(this.chain, group.map((r) => BigInt(r.token_id)), owner, this.chain.npmFor(venue), this.rpc);
        group.forEach((r, i) => feeBy.set(r.id, fees[i] || { fee0: 0n, fee1: 0n }));
      }
    }
    for (const r of v3) if (!feeBy.has(r.id)) feeBy.set(r.id, { fee0: 0n, fee1: 0n });

    // 4. token metadata
    const toks = new Set();
    for (const r of rows) { if (r.token0) toks.add(r.token0); if (r.token1) toks.add(r.token1); }
    const metas = await this.chain.tokens([...toks]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    const out = [];
    const prevLive = new Map((this.live || []).map((p) => [p.id, p]));
    for (const r of rows) {
      const s = slotBy.get(r.pool_ref);
      const L = liqBy.get(r.id) ?? BigInt(r.liquidity || '0');
      // Zero for a freshly minted position (< 15 minutes) although its mint recorded
      // liquidity: usually a lagging node that does not know the mint yet. `empty` still
      // follows the chain — confirmEmpty decides, with the mint receipt as proof — but its
      // VALUE comes from the stored liquidity. The table used to show $0 / PnL −100% until the
      // next sync fell on a healthy node.
      const stored = BigInt(r.liquidity || '0');
      const young = L === 0n && stored > 0n && Date.now() - (r.opened_ts || 0) < 15 * 60_000;
      const Lval = young ? stored : L;
      const d0 = metaBy.get(r.token0)?.decimals ?? 18;
      const d1 = metaBy.get(r.token1)?.decimals ?? 18;
      const f = feeBy.get(r.id) || { fee0: 0n, fee1: 0n };
      let amount0 = 0n, amount1 = 0n, valueQuote = null, feeQuote = null, inRange = null;
      if (s && Lval > 0n) {
        const a = m.getSqrtRatioAtTick(r.tick_lower), b = m.getSqrtRatioAtTick(r.tick_upper);
        const amt = m.amountsForLiquidity(s.sqrtPriceX96, a, b, Lval);
        amount0 = amt.amount0; amount1 = amt.amount1;
        inRange = m.sideOfRange(s.tick, r.tick_lower, r.tick_upper) === 'both';
      }
      // The token composition (amount0/1) follows the pool's own price — that is what really
      // comes out when withdrawn. But its VALUE in the quote uses the marking price.
      const mark = markBy.get(r.id);
      if (s && mark) {
        const v = this.chain.valueInQuote({ sqrtPriceX96: mark.sqrt, amount0, amount1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (v) valueQuote = v.value;
        const vf = this.chain.valueInQuote({ sqrtPriceX96: mark.sqrt, amount0: f.fee0, amount1: f.fee1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (vf) feeQuote = vf.value;
      }
      if (f.unknown) feeQuote = r.fees_quote ?? null;   // fee unreadable: the last figure, not zero
      // Nominal fence: an infinite fee or > 10× capital (+$100) is not a windfall, but a
      // broken calculation (a fee slot misread, an absurd price) — use the last figure.
      if (feeQuote != null && (!Number.isFinite(feeQuote) || feeQuote > Math.max(r.cost_quote || 0, 1) * 10 + 100)) {
        if (!this.markWarned.has(`fee:${r.id}`)) { this.markWarned.add(`fee:${r.id}`); this.log(`fee posisi #${r.id} terbaca ${feeQuote} — tidak masuk akal, pakai angka terakhir`); }
        feeQuote = Number.isFinite(r.fees_quote) ? r.fees_quote : 0;
      }
      if (valueQuote != null && !Number.isFinite(valueQuote)) valueQuote = null;
      const kind = this.chain.quoteSideOf(r.token0, r.token1)?.kind || 'usd';
      const toUsd = (x) => (x == null ? null : (kind === 'eth' ? x * ethUsd : x));
      const costUsd = toUsd(r.cost_quote) ?? 0;
      // A price not read (RPC) ≠ a position worth $0. It used to be 0 → PnL −100% →
      // stop loss (if set) closes a real position at the market price, and the equity
      // curve plunges momentarily. Use the last known value and flag it stale;
      // PnL-based triggers are not evaluated from a stale figure.
      const withdrawnUsd0 = toUsd(r.out_quote) ?? 0;
      const valueStale = valueQuote == null && Lval > 0n;
      const valUsd = valueQuote != null ? toUsd(valueQuote)
        : Lval > 0n ? (prevLive.get(r.id)?.valueUsd ?? Math.max(0, costUsd - withdrawnUsd0)) : 0;
      const feeUsd = toUsd(feeQuote) ?? 0;
      const claimedUsd = toUsd(r.claimed_quote) ?? 0;
      // out_quote of an open position = partial withdrawal proceeds already in the wallet
      const withdrawnUsd = toUsd(r.out_quote) ?? 0;
      const pnlUsd = valUsd + feeUsd + claimedUsd + withdrawnUsd - costUsd;

      // HODL: if the initial capital were left as tokens, what would it be worth now?
      // The difference = impermanent loss.
      let hodlUsd = null;
      if (s && mark) {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: mark.sqrt, amount0: BigInt(r.cost0 || '0'), amount1: BigInt(r.cost1 || '0'),
          dec0: d0, dec1: d1, token0: r.token0, token1: r.token1,
        });
        if (v) hodlUsd = toUsd(v.value);
      }

      this.store.run('UPDATE positions SET liquidity=?, fees_quote=?, last_sync=? WHERE id=?',
        Lval.toString(), feeQuote ?? 0, Date.now(), r.id);

      out.push({
        ...r, liquidity: L.toString(),
        symbol0: metaBy.get(r.token0)?.symbol || '?', symbol1: metaBy.get(r.token1)?.symbol || '?',
        dec0: d0, dec1: d1,
        // The quote side determines the direction of the price displayed in the UI.
        quoteSide: this.chain.quoteSideOf(r.token0, r.token1)?.side ?? null,
        amount0: amount0.toString(), amount1: amount1.toString(),
        fee0: f.fee0.toString(), fee1: f.fee1.toString(),
        curTick: s?.tick ?? null, inRange,
        curSqrt: s?.sqrtPriceX96 != null ? s.sqrtPriceX96.toString() : null,
        // The marking price if it differs from the pool price (the pool is unfit for valuation):
        // its sqrt and where from ('entry' or the reference pool's pool_ref).
        markSqrt: mark && mark.ref ? mark.sqrt.toString() : null,
        markRef: mark?.ref ?? null,
        entrySqrt: Positions.entrySqrtOf(r),
        valueUsd: valUsd, feeUsd, claimedUsd, withdrawnUsd, costUsd, pnlUsd,
        pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
        ilUsd: hodlUsd != null ? valUsd - hodlUsd : null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        // Empty only if the chain REALLY answers zero — not because it failed to read.
        empty: L === 0n && !liqStale.has(r.id),
        liqStale: liqStale.has(r.id),
        valueStale,
      });
    }
    this.live = out;
    this.lastSync = Date.now();
    return out;
  }

  // Make sure the position's liquidity really is zero on chain before closing it in the database.
  // Re-read via a separate call (not the last sync result): a zero
  // from the sync can come from a lagging/broken node, and closing the position
  // on that means $110 vanishes from the books without a transaction. Failing to read
  // = not certain = false.
  //
  // A FRESHLY opened position (< 15 minutes): a lagging node (ordofi can be thousands of blocks)
  // does not know its mint yet and answers liquidity 0 — twice in a row if
  // both happen to fall on that node. Closing it means a live position is recorded
  // closed at $0 and is never adopted again (its tokenId is already "known"). So the node
  // that answers must also show its mint receipt, in one batch.
  async confirmEmpty(pos) {
    try {
      const call = pos.venue === 'v4'
        ? { to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(pos.token_id)]) }
        : { to: this.chain.npmFor(pos.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(pos.token_id)]) };
      if (Date.now() - (pos.opened_ts || 0) < 15 * 60_000) {
        if (!pos.tx_open || !this.rpc.batch) return false;
        const [cr, rr] = await this.rpc.batch([
          { method: 'eth_call', params: [call, 'latest'] },
          { method: 'eth_getTransactionReceipt', params: [pos.tx_open] },
        ]);
        if (!rr || rr.error || !rr.result || !cr || cr.error || !cr.result || cr.result === '0x') return false;
        const L0 = pos.venue === 'v4' ? BigInt(cr.result) : BigInt(IF_NPM.decodeFunctionResult('positions', cr.result)[7]);
        return L0 === 0n;
      }
      const [w] = await this.rpc.ethCallMany([call]);
      if (!w || w === '0x') return false;
      const L = pos.venue === 'v4' ? BigInt(w) : BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]);
      return L === 0n;
    } catch { return false; }
  }

  // Positions that need closing because of standalone rules (not because the target exited).
  // `rules`: a rules object, or a function (position) -> rules. The engine uses a function so
  // PER-TARGET exit rules (stop loss, take profit, age, out of range) apply —
  // the per-target rules form shows them, and they used to be silently ignored.
  exitTriggers(rules) {
    const now = Date.now();
    const outs = [];
    for (const p of this.live) {
      const e = (typeof rules === 'function' ? rules(p) : rules).exit;
      if (p.empty) { outs.push({ pos: p, reason: 'likuiditas sudah nol di chain' }); continue; }
      // Stale value/liquidity (RPC failed): stop loss, take profit, and out-of-range must not
      // be evaluated from old figures — wait for a sync that reads.
      if (p.valueStale || p.liqStale) continue;
      if (e.stop_loss_pct > 0 && p.pnlPct <= -Math.abs(e.stop_loss_pct)) {
        outs.push({ pos: p, reason: `stop loss ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.take_profit_pct > 0 && p.pnlPct >= e.take_profit_pct) {
        outs.push({ pos: p, reason: `take profit ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.max_age_hours > 0 && p.ageHours >= e.max_age_hours) {
        outs.push({ pos: p, reason: `umur ${p.ageHours.toFixed(1)} jam` }); continue;
      }
      // Too far from the range: its capital sits idle (earning no fees) and
      // the price will not necessarily return. Two consecutive syncs (~1 minute) so a momentary wick
      // does not close the position; if the target is still inside, the engine opens it again
      // once the price comes near (reenter_within_pct).
      const far = e.out_of_range_pct > 0 && p.inRange === false && p.curTick != null
        ? m.distanceFromRangePct(p.curTick, p.tick_lower, p.tick_upper) : 0;
      if (far > e.out_of_range_pct) {
        const n = (this.farStreak.get(p.id) || 0) + 1;
        this.farStreak.set(p.id, n);
        if (n >= 2) {
          outs.push({ pos: p, kind: 'oor', reason: `di luar rentang ${far >= 1000 ? '999+' : far.toFixed(0)}% dari harga (batas ${e.out_of_range_pct}%)` });
          continue;
        }
      } else this.farStreak.delete(p.id);
      if (e.out_of_range_minutes > 0 && p.inRange === false) {
        const since = Number(this.store.getState(`oor:${p.id}`, 0)) || 0;
        if (!since) this.store.setState(`oor:${p.id}`, now);
        else if (now - since >= e.out_of_range_minutes * 60000) {
          outs.push({ pos: p, kind: 'oor', reason: `di luar rentang ${Math.round((now - since) / 60000)} menit` });
        }
      } else if (p.inRange) {
        this.store.setState(`oor:${p.id}`, 0);
      }
    }
    return outs;
  }

  // Summary of open positions.
  //
  // The count and exposure are COMPUTED FROM THE DB, not from the `live` cache. That cache is only
  // refreshed every 30 seconds; if used as the source, a position just
  // opened is not counted — and the "maximum open positions" and "total
  // exposure" limits can be breached several times in a row by a fast target,
  // exactly the limits put in place to cap losses.
  summary(ethUsd) {
    const liveById = new Map(this.live.map((p) => [p.id, p]));
    const rows = this.store.all("SELECT id, cost_quote, out_quote, quote_symbol, claimed_quote FROM positions WHERE chain=? AND status='open'", this.chain.network)
      .filter((r) => !liveById.get(r.id)?.empty);
    let val = 0, fee = 0, cost = 0, withdrawn = 0;
    for (const r of rows) {
      const k = usdPerQuote(r.quote_symbol, ethUsd, this.chain);
      const c = (r.cost_quote || 0) * k;
      cost += c;
      // the partial withdrawal proceeds are already in the wallet (part of cash), but its capital is still whole in
      // cost_quote — without this a partially withdrawn position reads as a loss equal to the withdrawal
      withdrawn += (r.out_quote || 0) * k;
      const l = liveById.get(r.id);
      if (l) { val += l.valueUsd || 0; fee += l.feeUsd || 0; }
      else val += Math.max(0, c - (r.out_quote || 0) * k);   // not yet synced: the remaining capital as a value estimate
    }
    const open = rows.map((r) => liveById.get(r.id)).filter(Boolean).filter((p) => !p.empty);
    const closed = this.store.all("SELECT cost_quote, out_quote, quote_symbol FROM positions WHERE chain=? AND status='closed'", this.chain.network);
    let realized = rows.reduce((sum, r) => sum + (r.claimed_quote || 0) * usdPerQuote(r.quote_symbol, ethUsd, this.chain), 0);
    for (const c of closed) {
      const k = usdPerQuote(c.quote_symbol, ethUsd, this.chain);
      realized += ((c.out_quote || 0) - (c.cost_quote || 0)) * k;
    }
    // Leftover memecoin not yet sold: the position's out_quote still uses the close price,
    // the difference to the current price is unrealized PnL.
    const lo = this.leftoverVal || { usd: 0, closeUsd: 0 };
    return {
      openCount: rows.length, exposureUsd: val, costUsd: cost, feeUsd: fee,
      unrealizedUsd: val + fee + withdrawn - cost + (lo.usd - lo.closeUsd), realizedUsd: realized,
      leftoverUsd: lo.usd, leftoverCloseUsd: lo.closeUsd,
      inRange: open.filter((p) => p.inRange).length,
    };
  }
}

module.exports = { Positions };
