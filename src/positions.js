'use strict';
// Sinkronisasi posisi milik kita: nilai sekarang, fee terkumpul, PnL, dan
// pemicu keluar mandiri (di luar rentang, stop loss, take profit, umur).
const { ethers } = require('ethers');
const { ADDR, ABI } = require('./chain');
const { computePoolId } = require('./pools');
const { unclaimedV4, unclaimedV3 } = require('./fees');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);

class Positions {
  constructor({ rpc, store, chain, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.live = [];      // hasil sinkron terakhir, dipakai dashboard
    this.lastSync = 0;
  }

  open() {
    return this.store.all("SELECT * FROM positions WHERE status='open'");
  }

  // Catat posisi baru hasil mint kita
  record(plan, { tokenId, txHash, target, cost0, cost1, costQuote }) {
    const r = this.store.run(
      `INSERT INTO positions
       (venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
        target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open,last_sync)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      plan.venue, tokenId ?? null, plan.poolRef, plan.token0, plan.token1, plan.fee ?? null,
      plan.tickSpacing ?? null, plan.poolKey?.hooks ?? null, plan.tickLower, plan.tickUpper,
      plan.liquidity, target ?? null, plan.mirrorOf ?? null, 'open', Date.now(),
      String(cost0 ?? plan.amount0), String(cost1 ?? plan.amount1), costQuote ?? plan.valueQuote,
      plan.quoteSymbol, txHash ?? null, Date.now());
    return Number(r.lastInsertRowid);
  }

  markClosed(id, { out0, out1, outQuote, txHash }) {
    this.store.run(
      `UPDATE positions SET status='closed', closed_ts=?, out0=?, out1=?, out_quote=?, tx_close=?, liquidity='0' WHERE id=?`,
      Date.now(), String(out0 ?? 0), String(out1 ?? 0), outQuote ?? 0, txHash ?? null, id);
  }

  // ---- sinkronisasi -------------------------------------------------------
  async sync(ethUsd) {
    const rows = this.open();
    if (!rows.length) { this.live = []; this.lastSync = Date.now(); return []; }

    // 1. likuiditas terkini
    const v4 = rows.filter((r) => r.venue === 'v4' && r.token_id);
    const v3 = rows.filter((r) => r.venue === 'v3' && r.token_id);
    const liqCalls = [
      ...v4.map((r) => ({ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.token_id)]) })),
      ...v3.map((r) => ({ to: ADDR.npmV3, data: IF_NPM.encodeFunctionData('positions', [BigInt(r.token_id)]) })),
    ];
    const liqRes = await this.rpc.ethCallMany(liqCalls);
    const liqBy = new Map();
    v4.forEach((r, i) => {
      const w = liqRes[i];
      liqBy.set(r.id, w && w !== '0x' ? BigInt(w) : 0n);
    });
    v3.forEach((r, i) => {
      const w = liqRes[v4.length + i];
      let L = 0n;
      if (w && w !== '0x') { try { L = BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { L = 0n; } }
      liqBy.set(r.id, L);
    });

    // 2. state pool
    const poolIds = [...new Set(rows.filter((r) => r.venue === 'v4').map((r) => r.pool_ref))];
    const slots = poolIds.length ? await this.chain.slot0V4Many(poolIds) : [];
    const slotBy = new Map(poolIds.map((id, i) => [id, slots[i]]));
    for (const r of rows.filter((x) => x.venue === 'v3')) {
      if (!slotBy.has(r.pool_ref) && r.pool_ref) slotBy.set(r.pool_ref, await this.chain.slot0V3(r.pool_ref));
    }

    // 3. fee belum diklaim
    const curTick = new Map([...slotBy.entries()].filter(([, s]) => s).map(([k, s]) => [k, s.tick]));
    const feeItems = v4.map((r) => ({ poolId: r.pool_ref, tickLower: r.tick_lower, tickUpper: r.tick_upper, tokenId: r.token_id }));
    const feesV4 = feeItems.length ? await unclaimedV4(this.rpc, feeItems, curTick) : [];
    const owner = this.store.getState('wallet_address');
    const feesV3 = (v3.length && owner) ? await unclaimedV3(this.rpc, v3.map((r) => BigInt(r.token_id)), owner) : [];
    const feeBy = new Map();
    v4.forEach((r, i) => feeBy.set(r.id, feesV4[i] || { fee0: 0n, fee1: 0n }));
    v3.forEach((r, i) => feeBy.set(r.id, feesV3[i] || { fee0: 0n, fee1: 0n }));

    // 4. metadata token
    const toks = new Set();
    for (const r of rows) { if (r.token0) toks.add(r.token0); if (r.token1) toks.add(r.token1); }
    const metas = await this.chain.tokens([...toks]);
    const metaBy = new Map(metas.map((t) => [t.address, t]));

    const out = [];
    for (const r of rows) {
      const s = slotBy.get(r.pool_ref);
      const L = liqBy.get(r.id) ?? BigInt(r.liquidity || '0');
      const d0 = metaBy.get(r.token0)?.decimals ?? 18;
      const d1 = metaBy.get(r.token1)?.decimals ?? 18;
      const f = feeBy.get(r.id) || { fee0: 0n, fee1: 0n };
      let amount0 = 0n, amount1 = 0n, valueQuote = null, feeQuote = null, inRange = null;
      if (s && L > 0n) {
        const a = m.getSqrtRatioAtTick(r.tick_lower), b = m.getSqrtRatioAtTick(r.tick_upper);
        const amt = m.amountsForLiquidity(s.sqrtPriceX96, a, b, L);
        amount0 = amt.amount0; amount1 = amt.amount1;
        inRange = m.sideOfRange(s.tick, r.tick_lower, r.tick_upper) === 'both';
      }
      if (s) {
        const v = this.chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, amount0, amount1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (v) valueQuote = v.value;
        const vf = this.chain.valueInQuote({ sqrtPriceX96: s.sqrtPriceX96, amount0: f.fee0, amount1: f.fee1, dec0: d0, dec1: d1, token0: r.token0, token1: r.token1 });
        if (vf) feeQuote = vf.value;
      }
      const kind = this.chain.quoteSideOf(r.token0, r.token1)?.kind || 'usd';
      const toUsd = (x) => (x == null ? null : (kind === 'eth' ? x * ethUsd : x));
      const costUsd = toUsd(r.cost_quote) ?? 0;
      const valUsd = toUsd(valueQuote) ?? 0;
      const feeUsd = toUsd(feeQuote) ?? 0;
      const pnlUsd = valUsd + feeUsd - costUsd;

      // HODL: kalau modal awal dibiarkan sebagai token, berapa nilainya sekarang?
      // Selisihnya = impermanent loss.
      let hodlUsd = null;
      if (s) {
        const v = this.chain.valueInQuote({
          sqrtPriceX96: s.sqrtPriceX96, amount0: BigInt(r.cost0 || '0'), amount1: BigInt(r.cost1 || '0'),
          dec0: d0, dec1: d1, token0: r.token0, token1: r.token1,
        });
        if (v) hodlUsd = toUsd(v.value);
      }

      this.store.run('UPDATE positions SET liquidity=?, fees_quote=?, last_sync=? WHERE id=?',
        L.toString(), feeQuote ?? 0, Date.now(), r.id);

      out.push({
        ...r, liquidity: L.toString(),
        symbol0: metaBy.get(r.token0)?.symbol || '?', symbol1: metaBy.get(r.token1)?.symbol || '?',
        dec0: d0, dec1: d1,
        // Sisi kuotasi menentukan arah harga yang ditampilkan di UI.
        quoteSide: this.chain.quoteSideOf(r.token0, r.token1)?.side ?? null,
        amount0: amount0.toString(), amount1: amount1.toString(),
        fee0: f.fee0.toString(), fee1: f.fee1.toString(),
        curTick: s?.tick ?? null, inRange,
        valueUsd: valUsd, feeUsd, costUsd, pnlUsd,
        pnlPct: costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0,
        ilUsd: hodlUsd != null ? valUsd - hodlUsd : null,
        ageHours: (Date.now() - (r.opened_ts || Date.now())) / 3600000,
        empty: L === 0n,
      });
    }
    this.live = out;
    this.lastSync = Date.now();
    return out;
  }

  // Posisi yang perlu ditutup karena aturan mandiri (bukan karena target keluar).
  exitTriggers(rules) {
    const now = Date.now();
    const outs = [];
    for (const p of this.live) {
      const e = rules.exit;
      if (p.empty) { outs.push({ pos: p, reason: 'likuiditas sudah nol di chain' }); continue; }
      if (e.stop_loss_pct > 0 && p.pnlPct <= -Math.abs(e.stop_loss_pct)) {
        outs.push({ pos: p, reason: `stop loss ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.take_profit_pct > 0 && p.pnlPct >= e.take_profit_pct) {
        outs.push({ pos: p, reason: `take profit ${p.pnlPct.toFixed(1)}%` }); continue;
      }
      if (e.max_age_hours > 0 && p.ageHours >= e.max_age_hours) {
        outs.push({ pos: p, reason: `umur ${p.ageHours.toFixed(1)} jam` }); continue;
      }
      if (e.out_of_range_minutes > 0 && p.inRange === false) {
        const since = Number(this.store.getState(`oor:${p.id}`, 0)) || 0;
        if (!since) this.store.setState(`oor:${p.id}`, now);
        else if (now - since >= e.out_of_range_minutes * 60000) {
          outs.push({ pos: p, reason: `di luar rentang ${Math.round((now - since) / 60000)} menit` });
        }
      } else if (p.inRange) {
        this.store.setState(`oor:${p.id}`, 0);
      }
    }
    return outs;
  }

  summary(ethUsd) {
    const open = this.live.filter((p) => !p.empty);
    const val = open.reduce((s, p) => s + (p.valueUsd || 0), 0);
    const fee = open.reduce((s, p) => s + (p.feeUsd || 0), 0);
    const cost = open.reduce((s, p) => s + (p.costUsd || 0), 0);
    const closed = this.store.all("SELECT cost_quote, out_quote, quote_symbol FROM positions WHERE status='closed'");
    let realized = 0;
    for (const c of closed) {
      const k = c.quote_symbol === 'ETH' ? ethUsd : 1;
      realized += ((c.out_quote || 0) - (c.cost_quote || 0)) * k;
    }
    return {
      openCount: open.length, exposureUsd: val, costUsd: cost, feeUsd: fee,
      unrealizedUsd: val + fee - cost, realizedUsd: realized,
      inRange: open.filter((p) => p.inRange).length,
    };
  }
}

module.exports = { Positions };
