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

// "Turun sampai X%, naik sampai Y%" dari harga kini -> tick mentah (belum
// dibulatkan ke spacing). Persennya dalam HARGA YANG DILIHAT pengguna: token dalam
// aset kuotasi. Harga itu naik bersama tick kalau kuotasinya token1, dan TURUN
// kalau kuotasinya token0 — di situ batas bawah harga menjadi batas ATAS tick.
// Nilai negatif memindah batas ke sisi lain harga: lowerPct −10 = batas bawah 10%
// DI ATAS harga, upperPct −10 = batas atas 10% DI BAWAH harga. Dengan begitu
// rentang satu sisi tidak harus menempel di harga kini (misal −30% … −10%).
function ticksFromPct({ curTick, quoteSide, lowerPct, upperPct }) {
  const lo = Number(lowerPct ?? 0), up = Number(upperPct ?? 0);
  if (!Number.isFinite(lo) || lo >= 100) return { error: 'batas bawah harus di atas −100% — turun 100% berarti harga nol' };
  if (!Number.isFinite(up) || up <= -100 || up > 100000) return { error: 'batas atas harus di atas −100% dan maksimal +100.000%' };
  if (lo === 0 && up === 0) return { error: 'rentangnya kosong — isi batas bawah atau batas atas' };
  if (lo + up <= 0) return { error: 'batas atas harus lebih tinggi dari batas bawah' };
  const LN = Math.log(1.0001);
  const dTurun = Math.log(1 - lo / 100) / LN;   // <= 0 kecuali batas bawah di atas harga
  const dNaik = Math.log(1 + up / 100) / LN;    // >= 0 kecuali batas atas di bawah harga
  const [a, b] = quoteSide === 1 ? [curTick + dTurun, curTick + dNaik] : [curTick - dNaik, curTick - dTurun];
  return { tickLower: Math.floor(a), tickUpper: Math.ceil(b) };
}
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
   * Mencari semua pool Uniswap v4 DAN v3 yang memuat sebuah token, langsung dari chain.
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

    const word = (l, i) => BigInt(ethers.hexlify(ethers.getBytes(l.data).slice(i * 32, i * 32 + 32)));
    const addrT = (x) => ('0x' + x.slice(-40)).toLowerCase();
    const serapV4 = (logs) => {
      for (const l of logs) {
        found.set(l.topics[1], {
          poolRef: l.topics[1], venue: 'v4',
          token0: addrT(l.topics[2]), token1: addrT(l.topics[3]),
          fee: Number(word(l, 0)),
          tickSpacing: Number(BigInt.asIntN(24, word(l, 1))),
          hooks: '0x' + ethers.hexlify(ethers.getBytes(l.data).slice(2 * 32 + 12, 3 * 32)).slice(2),
          firstBlock: parseInt(l.blockNumber, 16),
        });
      }
    };
    // Uniswap v3: PoolCreated(address indexed token0, address indexed token1,
    // uint24 indexed fee, int24 tickSpacing, address pool) di kontrak factory.
    // Pool v3 dirujuk lewat ALAMAT kontraknya (poolRef = pool), sama seperti di
    // jalur penyalinan.
    const serapV3 = (logs) => {
      for (const l of logs) {
        const pool = ('0x' + word(l, 1).toString(16).padStart(40, '0')).toLowerCase();
        found.set(pool, {
          poolRef: pool, poolAddr: pool, venue: 'v3',
          token0: addrT(l.topics[1]), token1: addrT(l.topics[2]),
          fee: Number(BigInt(l.topics[3])),
          tickSpacing: Number(BigInt.asIntN(24, word(l, 0))),
          hooks: null,
          firstBlock: parseInt(l.blockNumber, 16),
        });
      }
    };

    // Token bisa di sisi mana pun (urutan ditentukan nilai alamat), jadi tiap
    // venue ditanya dua kali. v4 mengindeks kedua currency di topik 2 & 3; v3 di 1 & 2.
    let factory = null;
    try { factory = await this.chain.factoryV3(); } catch { /* v3 dilewati, v4 tetap jalan */ }
    const kueri = [
      [ADDR.poolManager, [TOPIC.initializeV4, null, pad(t), null], serapV4],
      [ADDR.poolManager, [TOPIC.initializeV4, null, null, pad(t)], serapV4],
      ...(factory ? [
        [factory, [TOPIC.poolCreatedV3, pad(t), null], serapV3],
        [factory, [TOPIC.poolCreatedV3, null, pad(t)], serapV3],
      ] : []),
    ];
    const CHUNK = 400_000;
    const potong = Math.ceil(head / CHUNK);
    const total = potong * kueri.length;
    let langkah = 0;
    for (const [address, topics, serap] of kueri) {
      try {
        serap(await this.rpc.getLogs({ address, topics, fromBlock: '0x0', toBlock: hex(head) }));
        langkah += potong;
        onProgress({ done: langkah, total });
        continue;
      } catch { /* endpoint menolak rentang sebesar itu — mundur per potongan */ }
      for (let hi = head; hi > 0;) {
        const lo = Math.max(0, hi - CHUNK);
        try {
          serap(await this.rpc.getLogs({ address, topics, fromBlock: hex(lo), toBlock: hex(hi) }));
        } catch { /* satu potongan gagal: jangan menggagalkan seluruh pemindaian */ }
        langkah++;
        onProgress({ done: langkah, total });
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
        `INSERT INTO pools(pool_ref,venue,token0,token1,fee,tick_spacing,hooks,pool_addr,first_block)
         VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(pool_ref) DO UPDATE SET
           token0=excluded.token0, token1=excluded.token1, fee=excluded.fee,
           tick_spacing=excluded.tick_spacing, hooks=excluded.hooks,
           pool_addr=COALESCE(excluded.pool_addr, pools.pool_addr),
           first_block=COALESCE(pools.first_block, excluded.first_block)`,
        p.poolRef, p.venue, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks, p.poolAddr || null, p.firstBlock);
    }
    const metas = await this.chain.tokens([...new Set(list.flatMap((p) => [p.token0, p.token1]))]);
    const byAddr = new Map(metas.map((m) => [lc(m.address), m]));

    // Likuiditas dibaca supaya pool kosong bisa ditandai — pool yang pernah dibuat
    // lalu ditinggalkan tidak jarang, dan masuk ke sana sama saja membuang gas.
    let liq = [];
    try {
      liq = await Promise.all(list.map((p) => (p.venue === 'v3'
        ? this.rpc.ethCallMany([{ to: p.poolRef, data: '0x1a686502' }])   // liquidity()
          .then(([w]) => (w && w !== '0x' ? BigInt(w) : null)).catch(() => null)
        : this.chain.poolLiquidity(p.poolRef).catch(() => null))));
    } catch { liq = []; }

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

  // Token yang tidak punya pool Uniswap v3/v4 yang bisa dimasuki biasanya tetap
  // diperdagangkan di tempat lain (mis. Pons V2 — pool gaya v2 tanpa rentang harga).
  // Daripada cuma "tidak ada pool", sebutkan di mana — datanya dari GeckoTerminal.
  async pasarLain(token, fetchImpl = globalThis.fetch) {
    try {
      const r = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${lc(token)}/pools?page=1`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const j = await r.json();
      const nama = (id) => String(id || '?').replace(/-robinhood$/, '').split('-')
        .map((w) => (/^v\d$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
      return (j.data || []).slice(0, 5).map((d) => ({
        dex: nama(d.relationships?.dex?.data?.id), dexId: d.relationships?.dex?.data?.id || null,
        name: d.attributes?.name || '?', address: d.attributes?.address || null,
        reserveUsd: Number(d.attributes?.reserve_in_usd) || 0,
      }));
    } catch { return null; }
  }

  // ---- rencana LP manual --------------------------------------------------
  /**
   * Menyusun rencana mint dari pilihan user, memakai mesin aturan yang sama dengan
   * penyalinan otomatis untuk menghitung rentang dan menilai posisi.
   * Mengembalikan { error } atau { plan, preview, warnings }.
   */
  async planLp({ poolRef, usd, widthPct = 25, lowerPct = null, upperPct = null, tickLower = null, tickUpper = null, full = false }) {
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

    let singleSide = null;
    // Batas di harga kini (0%) atau di seberangnya berarti satu sisi. Pembulatan
    // batas dekat harga harus menjauh dari harga, supaya spacing tidak
    // menyisipkan kebutuhan token kedua.
    if (!full && tickLower == null && tickUpper == null && (lowerPct != null || upperPct != null)) {
      const r = ticksFromPct({ curTick: slot0.tick, quoteSide: p.quoteSide, lowerPct, upperPct });
      if (r.error) return r;
      ({ tickLower, tickUpper } = r);
      if (Number(lowerPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token0' : 'token1';
      else if (Number(upperPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token1' : 'token0';
    }

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
      if (singleSide === 'token0') {
        range.tickLower = Math.max(range.tickLower, m.alignTick(slot0.tick + 1, sp, 'up'));
        range.tickUpper = Math.max(range.tickUpper, range.tickLower + sp);
      } else if (singleSide === 'token1') {
        range.tickUpper = Math.min(range.tickUpper, m.alignTick(slot0.tick, sp, 'down'));
        range.tickLower = Math.min(range.tickLower, range.tickUpper - sp);
      }
    } else {
      range = planRange({ ...rules, range: { ...rules.range, mode: full ? 'full' : 'width_pct', width_pct: widthPct } }, actLike, slot0.tick);
    }

    if (!Number.isInteger(range.tickLower) || !Number.isInteger(range.tickUpper)
      || range.tickLower < m.MIN_TICK || range.tickUpper > m.MAX_TICK) return { error: 'rentang melewati batas tick Uniswap' };

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
      valueUsd, side, singleSide,
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
    if (side !== 'both') warnings.push('posisi satu sisi — fee baru diperoleh saat harga masuk rentang');
    if (p.fee != null && p.fee >= 30000) warnings.push(`fee pool ${(p.fee / 10000).toFixed(2)}% — tinggi, hanya sepadan kalau ramai`);

    // Kas: executeEntry bisa menjembatani ETH<->USDG, jadi yang diperiksa total nilainya.
    // Token pasangan pool ikut dibaca: yang sudah dipegang mengecilkan zap.
    const bal = await eng.exec.balances(this.daftarSaldo(p));
    const { kasUsd } = this.saldoDari(bal, p, slot0);
    const available = (t) => {
      const raw = bal.get(lc(t)) || 0n;
      return isNative(t) ? (raw > this.gasReserve() ? raw - this.gasReserve() : 0n) : raw;
    };
    const funded = available(p.token0) >= BigInt(plan.amount0Max) && available(p.token1) >= BigInt(plan.amount1Max);
    if (!funded && kasUsd < valueUsd) return { error: `kas cuma $${kasUsd.toFixed(2)}, butuh ~$${valueUsd.toFixed(2)}` };
    if (!funded && kasUsd < valueUsd * 1.02) warnings.push('kas nyaris pas — sisakan sedikit untuk gas dan slippage');

    const sim = this.simulasiSwap({ p, plan, slot0, bal, rules });
    warnings.push(...sim.masalah);

    // Persen efektif setelah dibulatkan ke tick spacing, dalam harga yang dilihat
    // pengguna — "−10%" bisa jadi −10,4% di pool ber-spacing lebar.
    const rasio = (t) => (p.quoteSide === 1 ? 1.0001 ** (t - slot0.tick) : 1.0001 ** (slot0.tick - t));
    const [tHargaBawah, tHargaAtas] = p.quoteSide === 1 ? [range.tickLower, range.tickUpper] : [range.tickUpper, range.tickLower];
    const lowerPctEff = (1 - rasio(tHargaBawah)) * 100, upperPctEff = (rasio(tHargaAtas) - 1) * 100;

    return {
      plan,
      warnings,
      preview: {
        lowerPct: lowerPctEff, upperPct: upperPctEff,
        pair: p.pair, venue: p.venue, feePct: p.feePct, dynamicFee: p.dynamicFee,
        symbol0: p.symbol0, symbol1: p.symbol1, dec0: p.dec0, dec1: p.dec1, quoteSide: p.quoteSide,
        tickLower: range.tickLower, tickUpper: range.tickUpper, curTick: slot0.tick,
        valueUsd, amount0: est.amount0.toString(), amount1: est.amount1.toString(),
        side, hasHooks: p.hasHooks, kasUsd,
        swaps: sim.langkah,
        swapOn: !!rules.swap.enabled, slippageBps: rules.swap.max_slippage_bps,
        saldo: this.saldoDari(bal, p, slot0, sim.sesudah),
      },
    };
  }

  // ---- saldo & simulasi tukar ---------------------------------------------
  // Cadangan gas ikut harga gas terkini (lihat Executor.gasReserveCached).
  gasReserve() { return this.engine.exec?.gasReserveCached ? this.engine.exec.gasReserveCached() : BigInt(this.engine.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000); }

  daftarSaldo(p) {
    return [...new Set([ADDR.native, ADDR.usdg, ADDR.weth, ...(p ? [lc(p.token0), lc(p.token1)] : [])])];
  }

  // Dolar per SATU token (sudah disesuaikan desimal). Aset kuotasi dari harga ETH;
  // token pasangan pool dari harga pool terhadap aset kuotasinya. Selain itu: null.
  usdPer(tok, p, slot0) {
    const t = lc(tok), q = QUOTES[t];
    if (q) return q.kind === 'eth' ? this.engine.ethUsd : 1;
    if (!p || !slot0 || p.quoteSide == null) return null;
    const px = m.priceFromSqrt(slot0.sqrtPriceX96, p.dec0, p.dec1);   // token1 per token0
    const qUsd = this.usdPer(p.quoteSide === 0 ? p.token0 : p.token1);
    if (t === lc(p.token0) && p.quoteSide === 1) return px * qUsd;
    if (t === lc(p.token1) && p.quoteSide === 0) return px > 0 ? qUsd / px : null;
    return null;
  }

  // Satu baris token: jumlah manusiawi + nilai dolarnya.
  kaki(tok, raw, p, slot0) {
    const t = lc(tok);
    const dec = QUOTES[t]?.decimals ?? (p && t === lc(p.token0) ? p.dec0 : p && t === lc(p.token1) ? p.dec1 : 18);
    const symbol = QUOTES[t]?.symbol ?? (p && t === lc(p.token0) ? p.symbol0 : p && t === lc(p.token1) ? p.symbol1 : '?');
    const amount = Number(raw) / 10 ** dec;
    const u = this.usdPer(t, p, slot0);
    return { token: t, symbol, amount, usd: u != null ? amount * u : null };
  }

  /**
   * Saldo wallet yang relevan untuk membuka posisi: kas (ETH/USDG/WETH) dan token
   * pasangan pool. `sesudah` (opsional) = taksiran saldo setelah swap & mint.
   * kasUsd sengaja dihitung seperti dulu (ETH penuh, termasuk cadangan gas) supaya
   * batas "kas cuma $X" tidak bergeser; cadangannya dilaporkan terpisah.
   */
  saldoDari(bal, p, slot0, sesudah = null) {
    const tokens = this.daftarSaldo(p).map((t) => {
      const row = { ...this.kaki(t, bal.get(t) || 0n, p, slot0), isQuote: !!QUOTES[t], native: isNative(t) };
      if (sesudah) {
        const s = this.kaki(t, sesudah.get(t) ?? bal.get(t) ?? 0n, p, slot0);
        row.sesudah = s.amount; row.sesudahUsd = s.usd;
      }
      return row;
    });
    const kasUsd = tokens.filter((x) => x.isQuote).reduce((a, x) => a + (x.usd || 0), 0);
    return { tokens, kasUsd, gasReserveEth: Number(this.gasReserve()) / 1e18 };
  }

  async saldo(poolRef) {
    const eng = this.engine;
    const p = poolRef ? await this.poolByRef(poolRef) : null;
    let slot0 = null;
    if (p) {
      slot0 = await (p.venue === 'v3' ? this.chain.slot0V3(p.poolAddr || p.poolRef) : this.chain.slot0V4(p.poolRef))
        .catch(() => null);
    }
    const bal = await eng.exec.balances(this.daftarSaldo(p));
    return { ...this.saldoDari(bal, p, slot0), wallet: !!eng.exec.address() };
  }

  /**
   * Menirukan langkah tukar engine.executeEntry — bungkus/buka bungkus WETH,
   * jembatan USDG<->ETH, lalu zap — di atas saldo sekarang, TANPA mengirim apa pun.
   * Rumusnya disalin dari sana, jadi kalau executeEntry berubah, ini ikut diubah.
   *
   * Angka zap sama dengan yang akan dikirim (harga pool + ruang slippage). Jembatan
   * ditaksir dari harga ETH: kutipan Kyber yang sebenarnya baru diminta saat eksekusi.
   * `masalah` = langkah yang akan membuat eksekusi berhenti.
   */
  simulasiSwap({ p, plan, slot0, bal, rules }) {
    const eng = this.engine;
    const reserve = this.gasReserve();
    const slip = rules.swap.max_slippage_bps;
    const s = new Map(this.daftarSaldo(p).map((t) => [t, bal.get(t) || 0n]));
    const get = (t) => s.get(lc(t)) || 0n;
    const avail = (t) => { const v = get(t); return isNative(t) ? (v > reserve ? v - reserve : 0n) : v; };
    const pindah = (a, x, b, y) => { s.set(lc(a), get(a) - x); s.set(lc(b), get(b) + y); };
    const langkah = [], masalah = [];
    const catat = (jenis, a, x, b, y, extra = {}) => {
      langkah.push({ jenis, dari: this.kaki(a, x, p, slot0), ke: this.kaki(b, y, p, slot0), ...extra });
      pindah(a, x, b, y);
    };
    const fmt = (t, raw) => { const k = this.kaki(t, raw, p, slot0); return `${k.amount.toPrecision(4)} ${k.symbol}`; };

    // 0a. isi gas dari WETH kalau ETH native di bawah cadangan (engine.topUpGas)
    if (get(ADDR.native) < reserve && get(ADDR.weth) > 0n) {
      const kurang = reserve - get(ADDR.native), ada = get(ADDR.weth);
      const amt = ada < kurang ? ada : kurang;
      if (amt * 10n >= reserve) catat('buka_bungkus', ADDR.weth, amt, ADDR.native, amt, { gas: true });
    }

    // 0. kas ke aset kuotasi pool ini (engine.ensureQuoteAsset)
    const qTok = lc(plan.quoteSide === 0 ? plan.token0 : plan.token1);
    const qDec = QUOTES[qTok]?.decimals ?? 18;
    const needQ = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** qDec));
    const funded = avail(plan.token0) >= BigInt(plan.amount0Max) && avail(plan.token1) >= BigInt(plan.amount1Max);
    if (!funded && needQ > 0n && avail(qTok) < needQ) {
      if (qTok === ADDR.weth || qTok === ADDR.native) {
        const lain = qTok === ADDR.weth ? ADDR.native : ADDR.weth;
        const want = needQ - avail(qTok), ada = avail(lain);
        if (ada > 0n) catat(qTok === ADDR.weth ? 'bungkus' : 'buka_bungkus', lain, ada < want ? ada : want, qTok, ada < want ? ada : want);
      }
      if (avail(qTok) < needQ) {
        const wantEth = qTok === ADDR.native || qTok === ADDR.weth;
        const payTok = wantEth ? ADDR.usdg : ADDR.native, outTok = wantEth ? ADDR.native : ADDR.usdg;
        const short = needQ - avail(qTok);
        const k = 1 + slip / 10000;
        const pay = wantEth
          ? BigInt(Math.ceil((Number(short) / 1e18) * eng.ethUsd * 1e6 * k))
          : BigInt(Math.ceil((Number(short) / 1e6 / eng.ethUsd) * 1e18 * k));
        // Kas ETH untuk jembatan = ETH native di atas cadangan + WETH (dibuka seperlunya).
        const bisa = wantEth ? avail(payTok) : avail(ADDR.native) + get(ADDR.weth);
        if (!rules.swap.enabled) masalah.push('kas ada di aset kuotasi lain dan auto-swap dimatikan — pembukaan akan berhenti');
        else if (bisa < pay) masalah.push(`kas kurang untuk jembatan: butuh ~${fmt(payTok, pay)}, bisa dipakai ${fmt(payTok, bisa)}${wantEth ? '' : ' (ETH+WETH)'}`);
        if (!wantEth && rules.swap.enabled && avail(ADDR.native) < pay && get(ADDR.weth) > 0n) {
          const kurang = pay - avail(ADDR.native), ada = get(ADDR.weth);
          const amt = ada < kurang ? ada : kurang;
          catat('buka_bungkus', ADDR.weth, amt, ADDR.native, amt);
        }
        catat('jembatan', payTok, pay, outTok, short, { maxLossBps: rules.swap.max_price_impact_bps, taksiran: true });
        if (qTok === ADDR.weth) {
          const want = needQ - avail(qTok), ada = avail(ADDR.native);
          const amt = ada < want ? ada : want;
          if (amt > 0n) catat('bungkus', ADDR.native, amt, qTok, amt);
        }
      }
    }

    // 1. zap: tutup kekurangan tiap token dari token pasangannya
    const price1per0 = Number(slot0.sqrtPriceX96) ** 2 / Number(m.Q96) ** 2;
    const feeBps = plan.fee != null && plan.fee < 1_000_000 ? plan.fee / 100 : null;
    const zapLossBps = feeBps != null
      ? Math.max(rules.swap.max_price_impact_bps, Math.round(feeBps) + 200)
      : rules.swap.max_price_impact_bps;
    for (const [idx, tok, need] of [[0, plan.token0, BigInt(plan.amount0Max)], [1, plan.token1, BigInt(plan.amount1Max)]]) {
      const have = avail(tok);
      if (have >= need) continue;
      const short = need - have;
      const payTok = idx === 0 ? plan.token1 : plan.token0;
      const k = 1 + slip / 10000;
      const payRaw = idx === 0
        ? BigInt(Math.ceil(Number(short) * price1per0 * k))
        : BigInt(Math.ceil((Number(short) / price1per0) * k));
      if (payRaw <= 0n) continue;
      if (!rules.swap.enabled) masalah.push(`kurang ${fmt(tok, short)} dan auto-swap dimatikan — pembukaan akan berhenti`);
      else if (avail(payTok) < payRaw) masalah.push(`saldo kurang untuk zap: butuh ~${fmt(payTok, payRaw)}, ada ${fmt(payTok, avail(payTok))}`);
      catat('zap', payTok, payRaw, tok, short, { maxLossBps: zapLossBps });
    }

    // 2. mint memakai jumlah perkiraannya (bukan batas atas bersama slippage)
    s.set(lc(plan.token0), get(plan.token0) - BigInt(plan.amount0));
    s.set(lc(plan.token1), get(plan.token1) - BigInt(plan.amount1));
    for (const [t, v] of s) if (v < 0n) s.set(t, 0n);
    return { langkah, masalah, sesudah: s };
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
  // Token yang ditambahkan pengguna lewat alamat (halaman Swap). Disimpan di tabel
  // state, bukan di browser, supaya ikut muncul di bot Telegram dan perangkat lain.
  // Pemanggil wajib memastikan alamatnya memang token: daftar ini tidak memeriksa.
  customTokens() {
    try {
      const v = JSON.parse(this.store.getState('swap_tokens', '[]'));
      return Array.isArray(v) ? v.map(lc).filter((a) => /^0x[0-9a-f]{40}$/.test(a)) : [];
    } catch { return []; }
  }
  addCustomToken(a) {
    const list = this.customTokens().filter((x) => x !== lc(a));
    this.store.setState('swap_tokens', JSON.stringify([lc(a), ...list].slice(0, 50)));
  }
  removeCustomToken(a) {
    this.store.setState('swap_tokens', JSON.stringify(this.customTokens().filter((x) => x !== lc(a))));
  }

  // Token ERC-20 apa saja yang pernah MASUK ke wallet bot — dari log Transfer yang
  // `to`-nya wallet kita. Tanpa ini, token yang dikirim dari luar (bukan hasil
  // posisi bot) tidak pernah muncul di daftar swap walau saldonya ada.
  //
  // Pindainya bertahap: blok yang sudah dilihat disimpan di state, jadi setelah
  // pindai pertama (900 ribu blok, seperti riset wallet) tiap pemanggilan hanya
  // membaca blok baru. Kalau RPC sedang tumbang, yang lama tetap dipakai — daftar
  // token tidak boleh ikut hilang gara-gara satu pindai gagal.
  async seenTokens() {
    const me = this.engine.exec.address();
    if (!me) return [];
    let st = { wallet: null, block: 0, tokens: [] };
    try { st = { ...st, ...JSON.parse(this.store.getState('swap_seen', '{}')) }; } catch { /* mulai dari nol */ }
    if (st.wallet !== me) st = { wallet: me, block: 0, tokens: [] };
    // Pindai ulang paling cepat tiap 60 detik: halaman Swap dan bot Telegram
    // memanggil held() berulang, dan getLogs adalah panggilan RPC yang paling berat.
    if (st.block && Date.now() - (st.ts || 0) < 60_000) return st.tokens;
    try {
      const head = await this.rpc.blockNumber();
      const lo = st.block ? st.block + 1 : Math.max(0, head - 900_000);
      if (head >= lo) {
        const { getLogsSafe } = require('./scout');
        const logs = await getLogsSafe(this.rpc, { topics: [TOPIC.transfer, null, ethers.zeroPadValue(me, 32)] }, lo, head);
        const set = new Set(st.tokens);
        // Transfer ERC-721 punya topik yang sama tapi tokenId-nya di topics[3];
        // ERC-20 memakai data untuk jumlahnya.
        for (const l of logs) if (l.topics.length === 3 && l.address) set.add(lc(l.address));
        st = { wallet: me, block: head, ts: Date.now(), tokens: [...set].slice(-300) };
        this.store.setState('swap_seen', JSON.stringify(st));
      }
    } catch (e) { this.log(`pindai token wallet gagal: ${e.message}`); }
    return st.tokens;
  }

  // Token yang masuk akal ditawarkan: aset kuotasi + token yang memang kita pegang
  // (dari posisi terbuka, antrean jual sisa, dan semua token yang pernah masuk ke
  // wallet — hanya yang saldonya masih ada) + token yang ditambahkan manual.
  // Saldo dibaca sekali, satu batch.
  async held() {
    const eng = this.engine;
    const set = new Set([ADDR.native, ADDR.usdg, ADDR.weth]);
    const custom = new Set(this.customTokens());
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE status='open'")) {
      if (r.token0) set.add(lc(r.token0));
      if (r.token1) set.add(lc(r.token1));
    }
    for (const it of eng.leftovers()) if (it.token) set.add(lc(it.token));
    for (const a of custom) set.add(a);
    // Token yang pernah masuk ke wallet + semua token yang dikenal bot: saldonya
    // dicek sekaligus, tapi hanya yang masih bersaldo yang masuk daftar — token
    // yang sudah habis dijual tidak perlu memenuhi pemilih.
    const extra = new Set();
    for (const a of await this.seenTokens()) if (!set.has(a)) extra.add(a);
    for (const r of this.store.all('SELECT address FROM tokens')) if (r.address && !set.has(lc(r.address))) extra.add(lc(r.address));
    const list = [...set, ...extra];
    const bal = await eng.exec.balances(list);
    const keep = list.filter((a) => set.has(a) || (bal.get(a) || 0n) > 0n);
    // Metadata token yang bersaldo tapi belum dikenal dibaca dari chain (dan tersimpan).
    const metas = await this.chain.tokens(keep);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [lc(t.address), t]));
    return keep.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = bal.get(a) || 0n;
      const dec = meta.decimals ?? (QUOTES[a]?.decimals ?? 18);
      return {
        address: a, symbol: meta.symbol || QUOTES[a]?.symbol || a.slice(0, 8), decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!QUOTES[a], native: isNative(a), custom: custom.has(a) && !QUOTES[a],
      };
    }).sort((x, y) => (y.isQuote ? 1 : 0) - (x.isQuote ? 1 : 0) || y.amount - x.amount);
  }

  // Mengubah "semua" / "50%" / angka menjadi jumlah mentah, dengan menyisakan gas
  // kalau yang dijual ETH native.
  async amountRaw(token, input) {
    const h = (await this.held()).find((x) => x.address === lc(token));
    const dec = h?.decimals ?? 18;
    const bal = BigInt(h?.raw || '0');
    const reserve = this.gasReserve();
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
      maxLossBps: rules.exit.sell_max_loss_bps, slippageBps: rules.swap.max_slippage_bps,
      tooLossy: loss != null && loss > rules.exit.sell_max_loss_bps,
    };
  }

  async doSwap({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (eng.stopping) throw new Error('bot sedang berhenti (restart) — coba lagi sebentar');
    // Token yang sama sedang dijual antrean sisa otomatis: dua swap dari saldo yang sama
    // → yang kedua revert (gas hangus) atau menjual jatah yang sudah dijual.
    eng.selling = eng.selling || new Set();
    const lockKey = lc(tokenIn);
    if (eng.selling.has(lockKey)) throw new Error('token ini sedang dijual otomatis — tunggu sebentar');
    eng.selling.add(lockKey);
    try { return await this.doSwapLocked({ tokenIn, tokenOut, amountRaw }); }
    finally { eng.selling.delete(lockKey); }
  }

  async doSwapLocked({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    const rules = eng.rulesFrom(null);
    const [mi, mo] = await this.chain.tokens([tokenIn, tokenOut]);
    const masuk = Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 18);
    // Token dan jumlahnya ikut dicatat di txs supaya riwayat di halaman Swap bisa
    // menampilkan "0,5 ETH → 1.700 USDG", bukan cuma hash.
    const detail = { tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), symbolIn: mi.symbol, symbolOut: mo.symbol, amountIn: masuk };
    const r = await eng.kyber.swap(tokenIn, tokenOut, BigInt(amountRaw), {
      slippageBps: rules.swap.max_slippage_bps,
      maxLossBps: rules.exit.sell_max_loss_bps,
      kind: 'swap_manual', detail,
    });
    if (!r) throw new Error('Kyber tidak menemukan rute');
    // Hasil dari receipt; kalau tidak terbaca (ETH native + node tertinggal) pakai kutipan.
    const outRaw = r.amountOut ?? BigInt(r.quote?.amountOut ?? 0);
    const keluar = Number(outRaw) / 10 ** (mo.decimals ?? 18);
    // Yang dijual mungkin memecoin sisa dari posisi yang sudah tutup: PnL posisinya
    // dikoreksi ke hasil jual ini (FIFO kalau beberapa posisi menyimpan token yang sama).
    try {
      eng.positions.recordLeftoverSale({ token: lc(tokenIn), amount: BigInt(amountRaw), quoteToken: lc(tokenOut),
        txHash: r.hash, amountOut: r.amountOut, usdOut: r.quote?.usdOut, ethUsd: eng.ethUsd });
    } catch (e) { this.store.log('warn', `catat hasil jual sisa: ${e.message}`, { quiet: true }); }
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', r.hash);
      const d = row?.detail ? JSON.parse(row.detail) : detail;
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, amountOut: keluar }), r.hash);
    } catch { /* riwayat saja — swap-nya sudah terkirim */ }
    const note = `${masuk.toPrecision(6)} ${mi.symbol} → ${keluar.toPrecision(6)} ${mo.symbol}`;
    eng.notify(`swap manual: ${note}`);
    return { txHash: r.hash, amountOut: outRaw.toString(), note, dex: r.quote?.dex || null };
  }
}

module.exports = { ticksFromPct, Manual };
