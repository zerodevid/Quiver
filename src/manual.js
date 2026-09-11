'use strict';
// LP manual dan swap manual.
//
// Keduanya memakai jalur eksekusi yang SAMA dengan penyalinan otomatis:
// `engine.executeEntry` untuk membuka posisi (termasuk jembatan kas, zap, izin,
// penguncian ulang nominal di harga terkini, dan pencatatan posisi) dan
// `engine.kyber.swap` untuk menukar aset. Modul ini hanya menyiapkan rencananya —
// tidak ada jalur pengiriman transaksi kedua yang harus ikut dirawat.
//
// Posisi yang dibuka di sini disimpan dengan target NULL. Konsekuensinya sengaja:
// `reconcileExits` melewatinya (tidak ada target untuk diikuti keluar), tetapi
// aturan keluar mandiri (stop loss / take profit / umur / di luar rentang) TETAP
// berlaku kalau disetel — itu memang aturan atas posisi kita sendiri.
const { ethers } = require('ethers');
const m = require('./v3math');
const { ADDR, QUOTES, TOPIC } = require('./chain');
const { planRange, valueOfLiquidity, usdToQuote, quoteToUsd } = require('./policy');

const isNative = (t) => String(t).toLowerCase() === ADDR.native;
const lc = (t) => String(t || '').toLowerCase();

// Uniswap v4 memakai bit tertinggi uint24 sebagai penanda FEE DINAMIS, bukan angka
// fee. Tanpa ini pool bertanda dinamis terbaca "838,86%" — angka yang tidak pernah
// ada dan bikin daftar hasil pindai tampak penuh jebakan.
const DYNAMIC_FEE = 0x800000;
const feeDinamis = (f) => f != null && (Number(f) & DYNAMIC_FEE) !== 0;
const feePctOf = (f) => (f == null || feeDinamis(f) ? null : Number(f) / 10000);

class Manual {
  constructor({ engine, store, chain, rpc, log }) {
    this.engine = engine; this.store = store; this.chain = chain; this.rpc = rpc;
    this.log = log || (() => {});
  }

  // ---- daftar pool yang dikenal -------------------------------------------
  // Sumbernya pool yang sudah pernah terlihat saat memantau target, jadi user tidak
  // perlu mencari poolId sendiri. Diurutkan dari yang paling baru beraksi.
  async pools({ q = '', limit = 40, withPrice = false } = {}) {
    const rows = this.store.all(`
      SELECT p.*, t0.symbol s0, t0.decimals d0, t1.symbol s1, t1.decimals d1,
             (SELECT MAX(ts) FROM actions a WHERE a.pool_ref = p.pool_ref) last_ts
      FROM pools p
      LEFT JOIN tokens t0 ON t0.address = p.token0
      LEFT JOIN tokens t1 ON t1.address = p.token1
      ORDER BY COALESCE(last_ts, 0) DESC, p.first_block DESC`);
    const cari = String(q).trim().toLowerCase();
    const out = [];
    for (const r of rows) {
      const pair = `${r.s0 || '?'}/${r.s1 || '?'}`;
      if (cari && !pair.toLowerCase().includes(cari) && !lc(r.pool_ref).includes(cari)) continue;
      const qs = this.chain.quoteSideOf(r.token0, r.token1);
      out.push({
        poolRef: r.pool_ref, venue: r.venue, pair, symbol0: r.s0 || '?', symbol1: r.s1 || '?',
        dec0: r.d0 ?? 18, dec1: r.d1 ?? 18,
        token0: r.token0, token1: r.token1, fee: r.fee, feePct: feePctOf(r.fee), dynamicFee: feeDinamis(r.fee),
        tickSpacing: r.tick_spacing, hooks: r.hooks,
        hasHooks: !!(r.hooks && !/^0x0+$/i.test(r.hooks)),
        quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null,
        lastTs: r.last_ts || null,
      });
      if (out.length >= limit) break;
    }
    if (withPrice) await this.addPrices(out);
    return out;
  }

  async addPrices(list) {
    const v4 = list.filter((p) => p.venue === 'v4');
    if (!v4.length) return list;
    try {
      const slots = await this.chain.slot0V4Many(v4.map((p) => p.poolRef));
      v4.forEach((p, i) => { p.curTick = slots[i]?.tick ?? null; });
    } catch { /* harga tidak wajib untuk memilih pool */ }
    return list;
  }

  async poolByRef(poolRef) {
    const r = this.store.get('SELECT * FROM pools WHERE pool_ref=?', poolRef);
    if (!r) return null;
    const [t0, t1] = await this.chain.tokens([r.token0, r.token1]);
    const qs = this.chain.quoteSideOf(r.token0, r.token1);
    return {
      poolRef: r.pool_ref, venue: r.venue, token0: r.token0, token1: r.token1,
      fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks, poolAddr: r.pool_addr,
      symbol0: t0.symbol, symbol1: t1.symbol, dec0: t0.decimals, dec1: t1.decimals,
      pair: `${t0.symbol}/${t1.symbol}`, feePct: feePctOf(r.fee), dynamicFee: feeDinamis(r.fee),
      hasHooks: !!(r.hooks && !/^0x0+$/i.test(r.hooks)),
      quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null, quoteKind: qs?.kind || null,
    };
  }

  // ---- pindai pool dari alamat token ---------------------------------------
  /**
   * Mencari semua pool v4 yang memuat sebuah token, langsung dari chain.
   *
   * Event Initialize v4 mengindeks KEDUA currency-nya, jadi pool bisa dicari dari
   * sisi tokennya tanpa perlu tahu fee/tickSpacing/hooks-nya lebih dulu:
   *   Initialize(PoolId indexed id, Currency indexed c0, Currency indexed c1,
   *              uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtP, int24 tick)
   * Sisanya ada di data, dengan layout yang sama seperti yang sudah dipakai pools.js.
   *
   * Rentang penuh dicoba sekali dulu — kueri sudah tersaring topik, jadi hasilnya
   * sedikit dan endpoint resmi sanggup. Kalau ditolak, mundur per potongan.
   */
  async scanPools(token, { onProgress = () => {} } = {}) {
    const t = lc(token);
    if (!/^0x[0-9a-f]{40}$/.test(t)) throw new Error('alamat token harus 0x diikuti 40 karakter hex');
    const head = await this.rpc.blockNumber();
    const pad = (a) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
    const hex = (n) => '0x' + Math.max(0, n).toString(16);
    const found = new Map();

    const serap = (logs) => {
      for (const l of logs) {
        const b = ethers.getBytes(l.data);
        const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
        found.set(l.topics[1], {
          poolRef: l.topics[1], venue: 'v4',
          token0: ('0x' + l.topics[2].slice(-40)).toLowerCase(),
          token1: ('0x' + l.topics[3].slice(-40)).toLowerCase(),
          fee: Number(w(0)),
          tickSpacing: Number(BigInt.asIntN(24, w(1))),
          hooks: '0x' + ethers.hexlify(b.slice(2 * 32 + 12, 3 * 32)).slice(2),
          firstBlock: parseInt(l.blockNumber, 16),
        });
      }
    };

    // Dua kueri: token sebagai currency0, lalu sebagai currency1. Urutan currency
    // di v4 ditentukan nilai alamatnya, jadi keduanya harus dicoba.
    const sisi = [[pad(t), null], [null, pad(t)]];
    const CHUNK = 400_000;
    const potong = Math.ceil(head / CHUNK);
    let langkah = 0;
    for (const [c0, c1] of sisi) {
      const topics = [TOPIC.initializeV4, null, c0, c1];
      try {
        serap(await this.rpc.getLogs({ address: ADDR.poolManager, topics, fromBlock: '0x0', toBlock: hex(head) }));
        langkah += potong;
        onProgress({ done: langkah, total: potong * 2 });
        continue;
      } catch { /* endpoint menolak rentang sebesar itu — mundur per potongan */ }
      for (let hi = head; hi > 0;) {
        const lo = Math.max(0, hi - CHUNK);
        try {
          serap(await this.rpc.getLogs({ address: ADDR.poolManager, topics, fromBlock: hex(lo), toBlock: hex(hi) }));
        } catch { /* satu potongan gagal: jangan menggagalkan seluruh pemindaian */ }
        langkah++;
        onProgress({ done: langkah, total: potong * 2 });
        if (lo === 0) break;
        hi = lo - 1;
      }
    }

    const list = [...found.values()];
    if (!list.length) return [];

    // Simpan supaya pool ini ikut muncul di daftar biasa seterusnya, dan ambil
    // metadata tokennya (nama dipakai di mana-mana).
    for (const p of list) {
      this.store.run(
        `INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,first_block)
         VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(pool_ref) DO UPDATE SET
           token0=excluded.token0, token1=excluded.token1, fee=excluded.fee,
           tick_spacing=excluded.tick_spacing, hooks=excluded.hooks,
           first_block=COALESCE(pools.first_block, excluded.first_block)`,
        p.poolRef, 'v4', p.token0, p.token1, p.fee, p.tickSpacing, p.hooks, p.firstBlock);
    }
    const metas = await this.chain.tokens([...new Set(list.flatMap((p) => [p.token0, p.token1]))]);
    const byAddr = new Map(metas.map((m) => [lc(m.address), m]));

    // Likuiditas dibaca supaya pool kosong bisa ditandai — pool yang pernah dibuat
    // lalu ditinggalkan tidak jarang, dan masuk ke sana sama saja membuang gas.
    let liq = [];
    try { liq = await Promise.all(list.map((p) => this.chain.poolLiquidity(p.poolRef).catch(() => null))); }
    catch { liq = []; }

    return list.map((p, i) => {
      const qs = this.chain.quoteSideOf(p.token0, p.token1);
      const s0 = byAddr.get(p.token0)?.symbol || '?';
      const s1 = byAddr.get(p.token1)?.symbol || '?';
      return {
        ...p, pair: `${s0}/${s1}`, symbol0: s0, symbol1: s1,
        dec0: byAddr.get(p.token0)?.decimals ?? 18, dec1: byAddr.get(p.token1)?.decimals ?? 18,
        feePct: feePctOf(p.fee), dynamicFee: feeDinamis(p.fee),
        hasHooks: !!(p.hooks && !/^0x0+$/i.test(p.hooks)),
        quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null,
        liquidity: liq[i] != null ? String(liq[i]) : null,
        kosong: liq[i] != null ? BigInt(liq[i]) === 0n : null,
      };
    }).sort((a, b) => (b.quoteSide != null) - (a.quoteSide != null)
      || (a.kosong === true) - (b.kosong === true)
      || b.firstBlock - a.firstBlock);
  }

  // ---- rencana LP manual --------------------------------------------------
  /**
   * Menyusun rencana mint dari pilihan user, memakai mesin aturan yang sama dengan
   * penyalinan otomatis untuk menghitung rentang dan menilai posisi.
   * Mengembalikan { error } atau { plan, preview, warnings }.
   */
  async planLp({ poolRef, usd, widthPct = 25, tickLower = null, tickUpper = null, full = false }) {
    const eng = this.engine;
    const p = await this.poolByRef(poolRef);
    if (!p) return { error: 'pool tidak dikenal — pilih dari daftar atau pantau dulu targetnya' };
    if (p.quoteSide == null) return { error: `pasangan ${p.pair} tidak punya aset kuotasi yang dikenal (USDG/ETH/WETH)` };

    const rules = eng.rulesFrom(null);
    if (p.hasHooks && !rules.filters.allow_hooks) {
      return { error: `pool ini memakai hook ${String(p.hooks).slice(0, 10)}… — hook bisa mengunci penarikan. Nyalakan "Izinkan pool ber-hook" di Aturan kalau memang disengaja.` };
    }
    if (feeDinamis(p.fee)) {
      return { error: `pool ini memakai fee dinamis (ditentukan hook-nya saat transaksi berjalan) — tidak bisa dinilai di muka` };
    }
    if (p.fee != null && p.fee > rules.filters.max_fee_bps) {
      return { error: `fee pool ${(p.fee / 10000).toFixed(2)}% di atas batas ${(rules.filters.max_fee_bps / 10000).toFixed(2)}%. Ubah "Batas fee pool" di Aturan kalau memang disengaja.` };
    }
    const nominal = Number(usd);
    if (!Number.isFinite(nominal) || nominal <= 0) return { error: 'nominal harus angka lebih dari nol' };

    const slot0 = p.venue === 'v3'
      ? await this.chain.slot0V3(p.poolAddr || p.poolRef)
      : await this.chain.slot0V4(p.poolRef);
    if (!slot0) return { error: 'harga pool tidak terbaca sekarang' };

    // Rentang: dihitung oleh planRange yang sama dengan jalur otomatis.
    const actLike = {
      venue: p.venue, token0: p.token0, token1: p.token1, fee: p.fee,
      tickSpacing: p.tickSpacing, hooks: p.hooks, poolRef: p.poolRef,
      tickLower: tickLower ?? slot0.tick, tickUpper: tickUpper ?? slot0.tick,
    };
    let range;
    if (tickLower != null && tickUpper != null) {
      const sp = p.tickSpacing || 60;
      range = {
        tickLower: m.alignTick(Math.min(tickLower, tickUpper), sp, 'down'),
        tickUpper: m.alignTick(Math.max(tickLower, tickUpper), sp, 'up'),
        tickSpacing: sp,
      };
      if (range.tickUpper <= range.tickLower) range.tickUpper = range.tickLower + sp;
    } else {
      range = planRange({ ...rules, range: { ...rules.range, mode: full ? 'full' : 'width_pct', width_pct: widthPct } }, actLike, slot0.tick);
    }

    // Likuiditas yang bernilai persis `nominal` dolar, diturunkan dari satu
    // pengukuran acuan — nilai posisi linear terhadap L pada rentang yang sama.
    const wantQuote = usdToQuote(nominal, p.quoteKind, eng.ethUsd);
    const Lref = 10n ** 18n;
    const ref = valueOfLiquidity(this.chain, actLike, Lref, range.tickLower, range.tickUpper, slot0, p.dec0, p.dec1);
    if (!ref.value || ref.value <= 0) return { error: 'tidak bisa menilai posisi di rentang ini' };
    const L = (Lref * BigInt(Math.round(wantQuote * 1e9))) / BigInt(Math.round(ref.value * 1e9));
    if (L <= 0n) return { error: 'nominal terlalu kecil untuk rentang ini' };

    const est = valueOfLiquidity(this.chain, actLike, L, range.tickLower, range.tickUpper, slot0, p.dec0, p.dec1);
    const valueUsd = quoteToUsd(est.value || 0, p.quoteKind, eng.ethUsd);
    const slip = BigInt(rules.swap.max_slippage_bps);
    const pad = (x) => (x * (10000n + slip)) / 10000n;
    const side = m.sideOfRange(slot0.tick, range.tickLower, range.tickUpper);

    const plan = {
      venue: p.venue, action: 'mint',
      poolRef: p.poolRef,
      poolKey: p.venue === 'v4'
        ? { currency0: p.token0, currency1: p.token1, fee: p.fee, tickSpacing: range.tickSpacing, hooks: p.hooks }
        : null,
      token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: range.tickSpacing,
      tickLower: range.tickLower, tickUpper: range.tickUpper,
      liquidity: L.toString(),
      amount0: est.amount0.toString(), amount1: est.amount1.toString(),
      amount0Max: pad(est.amount0).toString(), amount1Max: pad(est.amount1).toString(),
      valueQuote: est.value, quoteSymbol: p.quoteSymbol, quoteKind: p.quoteKind, quoteSide: p.quoteSide,
      valueUsd, side,
      mirrorOf: null, target: null, manual: true,
      curTick: slot0.tick,
    };

    // Batas yang sudah disetel user tetap dihormati: perintah manual boleh salah
    // ketik juga. Pesannya menyebut batas mana supaya jelas apa yang harus diubah.
    const warnings = [];
    const sum = eng.positions.summary(eng.ethUsd);
    const s = rules.sizing;
    if (valueUsd > s.max_quote_per_position_usd) {
      return { error: `$${valueUsd.toFixed(2)} melebihi batas per posisi ($${s.max_quote_per_position_usd}). Naikkan batasnya di Aturan kalau memang disengaja.` };
    }
    if (sum.exposureUsd + valueUsd > s.max_total_exposure_usd) {
      return { error: `total eksposur jadi $${(sum.exposureUsd + valueUsd).toFixed(2)}, melebihi batas $${s.max_total_exposure_usd}.` };
    }
    if (sum.openCount >= rules.filters.max_open_positions) {
      return { error: `sudah ada ${sum.openCount} posisi terbuka (batas ${rules.filters.max_open_positions}).` };
    }
    if (valueUsd < s.min_quote_usd) warnings.push(`di bawah minimum biasa ($${s.min_quote_usd}) — biaya gas bisa memakan porsi besar`);
    if (side !== 'both') warnings.push(`rentangnya seluruhnya di ${side === 'below' ? 'bawah' : 'atas'} harga kini — posisi berisi satu token saja (seperti limit order)`);
    if (p.fee != null && p.fee >= 30000) warnings.push(`fee pool ${(p.fee / 10000).toFixed(2)}% — tinggi, hanya sepadan kalau ramai`);

    // Kas: executeEntry bisa menjembatani ETH<->USDG, jadi yang diperiksa total nilainya.
    const bal = await eng.exec.balances([ADDR.native, ADDR.usdg, ADDR.weth]);
    const kasUsd = (Number(bal.get(ADDR.native) || 0n) / 1e18) * eng.ethUsd
      + Number(bal.get(ADDR.usdg) || 0n) / 1e6
      + (Number(bal.get(ADDR.weth) || 0n) / 1e18) * eng.ethUsd;
    if (kasUsd < valueUsd) return { error: `kas cuma $${kasUsd.toFixed(2)}, butuh ~$${valueUsd.toFixed(2)}` };
    if (kasUsd < valueUsd * 1.02) warnings.push('kas nyaris pas — sisakan sedikit untuk gas dan slippage');

    return {
      plan,
      warnings,
      preview: {
        pair: p.pair, venue: p.venue, feePct: p.feePct, dynamicFee: p.dynamicFee,
        symbol0: p.symbol0, symbol1: p.symbol1, dec0: p.dec0, dec1: p.dec1, quoteSide: p.quoteSide,
        tickLower: range.tickLower, tickUpper: range.tickUpper, curTick: slot0.tick,
        valueUsd, amount0: est.amount0.toString(), amount1: est.amount1.toString(),
        side, hasHooks: p.hasHooks, kasUsd,
      },
    };
  }

  async openLp(plan) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    const slot0 = plan.venue === 'v3'
      ? await this.chain.slot0V3(plan.poolRef)
      : await this.chain.slot0V4(plan.poolRef);
    const r = await eng.executeEntry(plan, { target: null, slot0 });
    eng.notify(`LP manual dibuka: ${r.note}`);
    return r;
  }

  // ---- swap manual --------------------------------------------------------
  // Token yang masuk akal ditawarkan: aset kuotasi + token yang memang kita pegang
  // (dari posisi terbuka dan antrean jual sisa). Saldo dibaca sekali, satu batch.
  async held() {
    const eng = this.engine;
    const set = new Set([ADDR.native, ADDR.usdg, ADDR.weth]);
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE status='open'")) {
      if (r.token0) set.add(lc(r.token0));
      if (r.token1) set.add(lc(r.token1));
    }
    for (const it of eng.leftovers()) if (it.token) set.add(lc(it.token));
    const list = [...set];
    const [bal, metas] = await Promise.all([eng.exec.balances(list), this.chain.tokens(list)]);
    const byAddr = new Map(metas.map((t) => [lc(t.address), t]));
    return list.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = bal.get(a) || 0n;
      const dec = meta.decimals ?? (QUOTES[a]?.decimals ?? 18);
      return {
        address: a, symbol: meta.symbol || QUOTES[a]?.symbol || a.slice(0, 8), decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!QUOTES[a], native: isNative(a),
      };
    }).sort((x, y) => (y.isQuote ? 1 : 0) - (x.isQuote ? 1 : 0) || y.amount - x.amount);
  }

  // Mengubah "semua" / "50%" / angka menjadi jumlah mentah, dengan menyisakan gas
  // kalau yang dijual ETH native.
  async amountRaw(token, input) {
    const h = (await this.held()).find((x) => x.address === lc(token));
    const dec = h?.decimals ?? 18;
    const bal = BigInt(h?.raw || '0');
    const reserve = BigInt(this.engine.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    const maks = isNative(token) ? (bal > reserve ? bal - reserve : 0n) : bal;
    const t = String(input).trim().toLowerCase();
    if (t === 'semua' || t === 'all' || t === 'max') return maks;
    const persen = t.match(/^([\d.,]+)\s*%$/);
    if (persen) {
      const f = Number(persen[1].replace(',', '.'));
      if (!Number.isFinite(f) || f <= 0 || f > 100) throw new Error('persen harus antara 0 dan 100');
      return (maks * BigInt(Math.round(f * 100))) / 10000n;
    }
    const n = Number(t.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) throw new Error('jumlah harus angka, "semua", atau persen (mis. 50%)');
    const raw = ethers.parseUnits(n.toFixed(Math.min(dec, 18)), dec);
    if (raw > maks) throw new Error(`saldo cuma ${(Number(maks) / 10 ** dec).toPrecision(6)} ${h?.symbol || ''}`.trim());
    return raw;
  }

  async quoteSwap({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    if (lc(tokenIn) === lc(tokenOut)) return { error: 'token masuk dan keluar sama' };
    if (!amountRaw || BigInt(amountRaw) <= 0n) return { error: 'jumlah nol' };
    const [mi, mo] = await this.chain.tokens([tokenIn, tokenOut]);
    const q = await eng.kyber.quote(tokenIn, tokenOut, BigInt(amountRaw));
    if (!q) return { error: 'Kyber tidak menemukan rute untuk pasangan ini' };
    const { Kyber } = require('./kyber');
    const loss = Kyber.lossBps(q);
    const rules = eng.rulesFrom(null);
    return {
      symbolIn: mi.symbol, symbolOut: mo.symbol,
      amountIn: Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 18),
      amountOut: Number(q.amountOut) / 10 ** (mo.decimals ?? 18),
      usdIn: q.usdIn, usdOut: q.usdOut, lossBps: loss, dex: q.dex,
      maxLossBps: rules.exit.sell_max_loss_bps,
      tooLossy: loss != null && loss > rules.exit.sell_max_loss_bps,
    };
  }

  async doSwap({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    const rules = eng.rulesFrom(null);
    const [mi, mo] = await this.chain.tokens([tokenIn, tokenOut]);
    const r = await eng.kyber.swap(tokenIn, tokenOut, BigInt(amountRaw), {
      slippageBps: rules.swap.max_slippage_bps,
      maxLossBps: rules.exit.sell_max_loss_bps,
      kind: 'swap_manual',
    });
    if (!r) throw new Error('Kyber tidak menemukan rute');
    const keluar = Number(r.amountOut) / 10 ** (mo.decimals ?? 18);
    const masuk = Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 18);
    const note = `${masuk.toPrecision(6)} ${mi.symbol} → ${keluar.toPrecision(6)} ${mo.symbol}`;
    eng.notify(`swap manual: ${note}`);
    return { txHash: r.hash, amountOut: r.amountOut.toString(), note, dex: r.quote?.dex || null };
  }
}

module.exports = { Manual };
