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
  // entrySqrt: harga pool saat mint — dipakai halaman detail untuk menandai titik masuk.
  record(plan, { tokenId, txHash, target, cost0, cost1, costQuote, openedTs, entrySqrt }) {
    const r = this.store.run(
      `INSERT INTO positions
       (venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
        target,mirror_of,status,opened_ts,cost0,cost1,cost_quote,quote_symbol,tx_open,entry_sqrt,last_sync)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      plan.venue, tokenId ?? null, plan.poolRef, plan.token0, plan.token1, plan.fee ?? null,
      plan.tickSpacing ?? null, plan.poolKey?.hooks ?? null, plan.tickLower, plan.tickUpper,
      plan.liquidity, target ?? null, plan.mirrorOf ?? null, 'open', openedTs ?? Date.now(),
      String(cost0 ?? plan.amount0), String(cost1 ?? plan.amount1), costQuote ?? plan.valueQuote,
      plan.quoteSymbol, txHash ?? null, entrySqrt != null ? String(entrySqrt) : null, Date.now());
    return Number(r.lastInsertRowid);
  }

  // `left`: memecoin yang ikut keluar dan belum dijual — {token, amount, quote}; nilai
  // quote-nya (di harga tutup) sudah termasuk dalam outQuote.
  markClosed(id, { out0, out1, outQuote, txHash, exitSqrt, left = null }) {
    this.store.run(
      `UPDATE positions SET status='closed', closed_ts=?, out0=?, out1=?, out_quote=? + COALESCE(claimed_quote,0), tx_close=?, exit_sqrt=?, liquidity='0',
         left_token=?, left_amount=?, left_quote=? WHERE id=?`,
      Date.now(), String(out0 ?? 0), String(out1 ?? 0), outQuote ?? 0, txHash ?? null,
      exitSqrt != null ? String(exitSqrt) : null,
      left?.token || null, String(left?.amount ?? 0n), left?.quote || 0, id);
    if (txHash) {
      const tx = this.store.get('SELECT detail FROM txs WHERE hash=?', txHash);
      const detail = JSON.parse(tx?.detail || '{}');
      detail.closeProceeds = { amount0: String(out0 ?? 0), amount1: String(out1 ?? 0), quote: outQuote ?? 0 };
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(detail), txHash);
    }
  }

  // ---- memecoin sisa: dari "dinilai harga tutup" ke "hasil jual sesungguhnya" ----
  // Posisi yang menyimpan memecoin sisa dari tutupnya, urut tertua (FIFO).
  leftoverRows(token = null) {
    return this.store.all(`SELECT id, token0, token1, pool_ref, venue, quote_symbol, left_token, left_amount, left_quote, out_quote
      FROM positions WHERE left_token IS NOT NULL AND left_amount != '0'${token ? ' AND left_token=?' : ''} ORDER BY closed_ts, id`,
    ...(token ? [String(token).toLowerCase()] : []));
  }

  // Dipanggil setelah token sisa terjual (otomatis maupun dari halaman Swap): hasil
  // jual dialokasikan FIFO ke posisi-posisi yang menyimpannya, dan out_quote tiap
  // posisi dikoreksi — taksiran harga tutup diganti hasil yang benar-benar diterima.
  // `posId` membatasi ke satu posisi (penjualan otomatis tahu asalnya).
  recordLeftoverSale({ posId = null, token, amount, quoteToken, amountOut, usdOut, ethUsd, txHash = null }) {
    const rows = this.leftoverRows(token).filter((r) => posId == null || r.id === posId);
    if (!rows.length) return [];
    const sold = BigInt(amount);
    if (sold <= 0n) return [];
    // Hasil dalam USD: dari jumlah aset kuotasi yang diterima kalau dikenal, kalau tidak
    // dari taksiran USD Kyber.
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
      const k = r.quote_symbol === 'ETH' ? ethUsd : 1;
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

  // Nilai memecoin sisa yang masih dipegang, di harga pool SEKARANG. Dibaca tiap
  // sinkron bersama kas; hasilnya dipakai summary() supaya total portofolio tidak
  // "anjlok" begitu posisi tutup lalu "melonjak" begitu sisanya terjual.
  async refreshLeftovers(ethUsd, wallet = null) {
    let rows = this.leftoverRows();
    let usd = 0, closeUsd = 0;
    const items = [];
    // Token yang ternyata sudah tidak ada di wallet (dijual lewat DEX lain, dikirim
    // keluar) tidak boleh terus dinilai: kekurangannya dianggap terealisasi di harga
    // kini, seperti perlakuan riset wallet terhadap transfer keluar tanpa hasil.
    if (rows.length && wallet) {
      const toksL = [...new Set(rows.map((r) => r.left_token))];
      const IF = new ethers.Interface(['function balanceOf(address) view returns (uint256)']);
      const bals = await this.rpc.ethCallMany(toksL.map((t) => ({ to: t, data: IF.encodeFunctionData('balanceOf', [wallet]) })));
      let changed = false;
      for (let i = 0; i < toksL.length; i++) {
        if (!bals[i] || bals[i] === '0x') continue;
        const bal = BigInt(bals[i]);
        const total = rows.filter((r) => r.left_token === toksL[i]).reduce((a, r) => a + BigInt(r.left_amount), 0n);
        if (bal >= total) continue;
        const gone = total - bal;
        const val = await this.valueLeftover(rows.filter((r) => r.left_token === toksL[i]), gone, ethUsd);
        this.log(`token sisa ${toksL[i].slice(0, 10)}… berkurang di luar bot (${gone} satuan) — dianggap terjual $${val.toFixed(2)}`);
        this.recordLeftoverSale({ token: toksL[i], amount: gone, quoteToken: null, usdOut: val, ethUsd });
        changed = true;
      }
      if (changed) rows = this.leftoverRows();
    }
    if (rows.length) {
      const v4 = [...new Set(rows.filter((r) => r.venue !== 'v3').map((r) => r.pool_ref))];
      const slots = new Map();
      if (v4.length) (await this.chain.slot0V4Many(v4)).forEach((s, i) => slots.set(v4[i], s));
      for (const a of new Set(rows.filter((r) => r.venue === 'v3').map((r) => r.pool_ref))) {
        try { slots.set(a, await this.chain.slot0V3(a)); } catch { /* dinilai harga tutup */ }
      }
      const toks = await this.chain.tokens([...new Set(rows.flatMap((r) => [r.token0, r.token1]))]);
      const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
      for (const r of rows) {
        const k = r.quote_symbol === 'ETH' ? ethUsd : 1;
        const v = this.leftoverQuote(r, BigInt(r.left_amount), slots.get(r.pool_ref), dec);
        // harga pool tidak terbaca: pakai nilai tutup supaya tidak hilang dari ekuitas
        const now = (v ?? (r.left_quote || 0)) * k;
        usd += now; closeUsd += (r.left_quote || 0) * k;
        items.push({ id: r.id, token: r.left_token, amount: r.left_amount, usd: now });
      }
    }
    this.leftoverVal = { usd, closeUsd, items, ts: Date.now() };
    return this.leftoverVal;
  }

  // Nilai `amt` token sisa baris r (satuan aset kuotasi) di harga slot0 `s`; null kalau tak terbaca.
  leftoverQuote(r, amt, s, dec) {
    if (!s) return null;
    const side = r.left_token === r.token0 ? 0 : 1;
    const v = this.chain.valueInQuote({
      sqrtPriceX96: s.sqrtPriceX96, amount0: side === 0 ? amt : 0n, amount1: side === 1 ? amt : 0n,
      dec0: dec.get(r.token0) ?? 18, dec1: dec.get(r.token1) ?? 18, token0: r.token0, token1: r.token1,
    });
    return v ? v.value : null;
  }

  // Nilai USD `amt` satuan token sisa, dinilai lewat pool posisi pertama yang menyimpannya.
  async valueLeftover(rows, amt, ethUsd) {
    const r = rows[0];
    let s = null;
    try { s = r.venue === 'v3' ? await this.chain.slot0V3(r.pool_ref) : await this.chain.slot0V4(r.pool_ref); } catch { s = null; }
    const toks = await this.chain.tokens([r.token0, r.token1]);
    const dec = new Map(toks.filter(Boolean).map((t) => [t.address, t.decimals]));
    const v = this.leftoverQuote(r, amt, s, dec);
    const k = r.quote_symbol === 'ETH' ? ethUsd : 1;
    if (v != null) return v * k;
    // harga tidak terbaca: proporsional dari nilai tutup
    const total = rows.reduce((a, x) => a + BigInt(x.left_amount), 0n);
    return rows.reduce((a, x) => a + (x.left_quote || 0), 0) * k * Number(amt) / Number(total);
  }

  // Harga masuk untuk posisi yang dicatat sebelum kolom entry_sqrt ada: diturunkan
  // balik dari jumlah token yang disetor. Di dalam rentang, amount1 = L·(√P − √A),
  // jadi √P = √A + amount1/L. Semua token di satu sisi = harga di luar rentang saat
  // mint; batas rentangnya yang dipakai.
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
      const claimedUsd = toUsd(r.claimed_quote) ?? 0;
      const pnlUsd = valUsd + feeUsd + claimedUsd - costUsd;

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
        curSqrt: s?.sqrtPriceX96 != null ? s.sqrtPriceX96.toString() : null,
        entrySqrt: Positions.entrySqrtOf(r),
        valueUsd: valUsd, feeUsd, claimedUsd, costUsd, pnlUsd,
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

  // Ringkasan posisi terbuka.
  //
  // Jumlah dan eksposur DIHITUNG DARI DB, bukan dari cache `live`. Cache itu hanya
  // disegarkan tiap 30 detik; kalau dipakai sebagai sumber, posisi yang baru saja
  // dibuka tidak terhitung — dan batas "maksimum posisi terbuka" serta "eksposur
  // total" bisa ditembus beberapa kali berturut-turut oleh target yang cepat,
  // persis batas yang dipasang untuk membatasi kerugian.
  summary(ethUsd) {
    const liveById = new Map(this.live.map((p) => [p.id, p]));
    const rows = this.store.all("SELECT id, cost_quote, quote_symbol, claimed_quote FROM positions WHERE status='open'")
      .filter((r) => !liveById.get(r.id)?.empty);
    let val = 0, fee = 0, cost = 0;
    for (const r of rows) {
      const k = r.quote_symbol === 'ETH' ? ethUsd : 1;
      const c = (r.cost_quote || 0) * k;
      cost += c;
      const l = liveById.get(r.id);
      if (l) { val += l.valueUsd || 0; fee += l.feeUsd || 0; }
      else val += c;   // belum tersinkron: modal dipakai sebagai taksiran nilai
    }
    const open = rows.map((r) => liveById.get(r.id)).filter(Boolean).filter((p) => !p.empty);
    const closed = this.store.all("SELECT cost_quote, out_quote, quote_symbol FROM positions WHERE status='closed'");
    let realized = rows.reduce((sum, r) => sum + (r.claimed_quote || 0) * (['ETH', 'WETH'].includes(r.quote_symbol) ? ethUsd : 1), 0);
    for (const c of closed) {
      const k = c.quote_symbol === 'ETH' ? ethUsd : 1;
      realized += ((c.out_quote || 0) - (c.cost_quote || 0)) * k;
    }
    // Memecoin sisa yang belum dijual: out_quote posisinya masih memakai harga tutup,
    // selisih ke harga kini adalah PnL yang belum terealisasi.
    const lo = this.leftoverVal || { usd: 0, closeUsd: 0 };
    return {
      openCount: rows.length, exposureUsd: val, costUsd: cost, feeUsd: fee,
      unrealizedUsd: val + fee - cost + (lo.usd - lo.closeUsd), realizedUsd: realized,
      leftoverUsd: lo.usd, leftoverCloseUsd: lo.closeUsd,
      inRange: open.filter((p) => p.inRange).length,
    };
  }
}

module.exports = { Positions };
