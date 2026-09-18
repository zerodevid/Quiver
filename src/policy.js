'use strict';
// Mesin aturan: mengubah satu aksi target menjadi rencana posisi kita.
// Semua yang bisa disetel user ada di sini — ukuran, rentang, sisi tunggal, filter.
const m = require('./v3math');
const { NETWORKS } = require('./networks');

// Kunci venue yang sah = gabungan venue semua chain yang dikenal (v3, v4, pancakev3, …).
// Aturan disimpan lepas dari chain tertentu, jadi validasinya tidak boleh menolak venue
// yang sah di salah satu chain hanya karena tidak dipakai di chain yang lain.
const KNOWN_VENUES = ['v4', ...new Set(Object.values(NETWORKS).flatMap((n) => n.venues.map((v) => v.key)))];

// Ruang untuk selisih kurs jembatan USDG<->ETH terhadap harga ETH yang kita pakai
// (diperbarui tiap 30 detik). Terukur ~0,05% di kondisi normal; 1% untuk pasar bergerak.
const BRIDGE_MARGIN_BPS = 100;

const DEFAULTS = {
  sizing: {
    mode: 'pct',              // mirror | pct | multiplier | fixed_quote
    pct: 25,
    multiplier: 1,
    fixed_quote_usd: 50,
    fixed_quote_eth: 0.02,
    min_quote_usd: 10,
    force_min: false,         // di bawah minimum: lewati (false) atau naikkan ke force_min_usd (true)
    force_min_usd: 25,
    max_quote_per_position_usd: 250,
    max_total_exposure_usd: 1500,
    daily_budget_usd: 750,
  },
  range: {
    mode: 'exact',            // exact | recenter | scale | width_pct | full
    scale: 1.0,
    width_pct: 25,
    align: 'nearest',         // nearest | down | up
    min_width_ticks: 0,
  },
  onesided: {
    policy: 'copy',           // copy | skip | recenter
    max_quote_usd: 150,
  },
  swap: {
    enabled: true,
    max_slippage_bps: 150,
    max_price_impact_bps: 500,
  },
  exit: {
    follow_target: true,      // ikut keluar kalau target keluar
    follow_partial: true,     // decrease proporsional
    out_of_range_minutes: 0,  // 0 = mati
    stop_loss_pct: 0,
    take_profit_pct: 0,
    max_age_hours: 0,
    sell_leftover: true,      // jual memecoin yang diterima saat keluar, balik ke aset kuotasi
    sell_max_loss_bps: 1500,  // tolak jual kalau rute rugi > 15% (fee pool + dampak harga)
    leftover_retry_sec: 5,    // sisa yang ditolak dicek ulang tiap N detik (kutipan saja; swap hanya kalau lolos)
  },
  filters: {
    allow_hooks: false,
    // Kosong = semua aset kuotasi yang dikenal chain itu (chain.QUOTES: stablecoin +
    // native + wrapped-native). Daftar simbol tetap seperti ['USDG','ETH','WETH'] tidak
    // dijadikan bawaan lagi karena simbolnya beda per chain (BSC: USDT/BNB/WBNB).
    quote_whitelist: [],
    token_blacklist: [],
    token_whitelist: [],
    min_pool_age_minutes: 0,
    min_target_quote_usd: 25,
    max_open_positions: 25,
    cooldown_seconds: 20,
    venues: ['v4', 'v3'],
    max_fee_bps: 100000,
  },
};

// Bentuk & batas setiap aturan. Dipakai dua kali: menolak isian yang salah di API
// (validateRules) dan merapikan aturan yang sudah tersimpan (rulesFor) — config lama atau
// isian form yang lolos dulu tidak boleh menjatuhkan eksekusi. Contoh nyata: slippage
// 150.5 dari kolom angka membuat BigInt(150.5) melempar di SETIAP entry; slippage ≥10000
// membuat minOut negatif.
//   [tipe, min, max]  tipe: num | int | bool | enum(list) | list
const RULE_SPEC = {
  sizing: {
    mode: ['enum', ['mirror', 'pct', 'multiplier', 'fixed_quote']],
    pct: ['num', 0, 100_000], multiplier: ['num', 0, 1000],
    fixed_quote_usd: ['num', 0, 1e9], fixed_quote_eth: ['num', 0, 1e6],
    min_quote_usd: ['num', 0, 1e9], force_min: ['bool'], force_min_usd: ['num', 0, 1e9],
    max_quote_per_position_usd: ['num', 0, 1e9],
    max_total_exposure_usd: ['num', 0, 1e9], daily_budget_usd: ['num', 0, 1e9],
  },
  range: {
    mode: ['enum', ['exact', 'recenter', 'scale', 'width_pct', 'full']],
    scale: ['num', 0.01, 100], width_pct: ['num', 0.01, 100_000],
    align: ['enum', ['nearest', 'down', 'up']], min_width_ticks: ['int', 0, 1_774_544],
  },
  onesided: { policy: ['enum', ['copy', 'skip', 'recenter']], max_quote_usd: ['num', 0, 1e9] },
  swap: { enabled: ['bool'], max_slippage_bps: ['int', 0, 5000], max_price_impact_bps: ['int', 0, 10_000] },
  exit: {
    follow_target: ['bool'], follow_partial: ['bool'],
    out_of_range_minutes: ['num', 0, 1e7], stop_loss_pct: ['num', 0, 100], take_profit_pct: ['num', 0, 1e6],
    max_age_hours: ['num', 0, 1e6], sell_leftover: ['bool'], sell_max_loss_bps: ['int', 0, 10_000],
    leftover_retry_sec: ['int', 1, 86_400],
  },
  filters: {
    allow_hooks: ['bool'], quote_whitelist: ['list'], token_blacklist: ['list'], token_whitelist: ['list'],
    min_pool_age_minutes: ['num', 0, 1e7], min_target_quote_usd: ['num', 0, 1e9],
    max_open_positions: ['int', 0, 100_000], cooldown_seconds: ['num', 0, 1e7],
    venues: ['list'], max_fee_bps: ['int', 0, 1_000_000],
  },
};

// Satu nilai menurut spesifikasinya: { ok, value } atau { error }.
function checkRule(spec, v, key = null) {
  const [type, a, b] = spec;
  // Stop loss sejak dulu dibaca sebagai besaran (Math.abs): "-10" = rugi 10%, bukan mati.
  if (key === 'stop_loss_pct' && Number(v) < 0) v = Math.abs(Number(v));
  if (type === 'bool') {
    if (typeof v === 'boolean') return { value: v };
    if (v === 'true' || v === 1) return { value: true };
    if (v === 'false' || v === 0) return { value: false };
    return { error: 'harus ya/tidak' };
  }
  if (type === 'enum') return a.includes(v) ? { value: v } : { error: `harus salah satu dari ${a.join(', ')}` };
  if (type === 'list') {
    const arr = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
    if (!arr) return { error: 'harus berupa daftar' };
    return { value: arr.map((x) => String(x).trim()).filter(Boolean) };
  }
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return { error: 'harus angka' };
  if (type === 'int' && !Number.isInteger(n)) return { error: 'harus bilangan bulat' };
  if (n < a || n > b) return { error: `harus di antara ${a} dan ${b}` };
  return { value: n };
}

// Periksa aturan dari API (global atau override per target — boleh sebagian). Kunci yang
// tidak dikenal dibiarkan. Balikan { rules } (sudah dirapikan) atau { error }.
function validateRules(input) {
  if (input == null) return { rules: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { error: 'aturan harus berupa objek' };
  const out = JSON.parse(JSON.stringify(input));
  for (const [g, fields] of Object.entries(RULE_SPEC)) {
    if (out[g] == null) continue;
    if (typeof out[g] !== 'object' || Array.isArray(out[g])) return { error: `${g}: harus berupa objek` };
    for (const [k, spec] of Object.entries(fields)) {
      if (!(k in out[g])) continue;
      const r = checkRule(spec, out[g][k], k);
      if (r.error) return { error: `${g}.${k} ${r.error}` };
      out[g][k] = r.value;
    }
    if (out[g].venues && out[g].venues.some((x) => !KNOWN_VENUES.includes(x))) return { error: `filters.venues hanya boleh salah satu dari ${KNOWN_VENUES.join(', ')}` };
  }
  return { rules: out };
}

// Aturan hasil gabungan yang tidak lolos spesifikasi diganti bawaan (bilangan bps yang
// cuma kurang bulat dibulatkan saja), supaya satu nilai rusak di config tidak mematikan
// semua entry/keluar.
function normalizeRules(r) {
  for (const [g, fields] of Object.entries(RULE_SPEC)) {
    r[g] = r[g] && typeof r[g] === 'object' ? r[g] : {};
    for (const [k, spec] of Object.entries(fields)) {
      if (!(k in r[g]) && !(k in (DEFAULTS[g] || {}))) continue;
      let v = r[g][k];
      if (spec[0] === 'int' && typeof v === 'number' && Number.isFinite(v)) v = Math.round(v);
      const c = checkRule(spec, v, k);
      if (!c.error) { r[g][k] = c.value; continue; }
      if (spec[0] === 'num' || spec[0] === 'int') {
        const n = k === 'stop_loss_pct' ? Math.abs(Number(v)) : Number(v);
        if (Number.isFinite(n)) { r[g][k] = Math.min(spec[2], Math.max(spec[1], spec[0] === 'int' ? Math.round(n) : n)); continue; }
      }
      r[g][k] = DEFAULTS[g][k];
    }
  }
  return r;
}

function deepMerge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base[k] || {}, v) : v;
  }
  return out;
}
function rulesFor(globalRules, targetRulesJson) {
  let per = null;
  try { per = targetRulesJson ? JSON.parse(targetRulesJson) : null; } catch { per = null; }
  return normalizeRules(deepMerge(deepMerge(DEFAULTS, globalRules || {}), per || {}));
}

// ---- rentang --------------------------------------------------------------
function planRange(rules, act, curTick) {
  const sp = act.tickSpacing || tickSpacingFromFee(act.fee);
  const align = (t, mode) => m.alignTick(t, sp, mode || rules.range.align);
  const width = act.tickUpper - act.tickLower;
  const mode = rules.range.mode;
  let lo, hi;

  if (mode === 'exact') {
    lo = act.tickLower; hi = act.tickUpper;
  } else if (mode === 'recenter') {
    const half = Math.round(width / 2);
    lo = align(curTick - half, 'down'); hi = align(curTick + half, 'up');
  } else if (mode === 'scale') {
    const center = Math.round((act.tickLower + act.tickUpper) / 2);
    const half = Math.max(sp, Math.round((width * rules.range.scale) / 2));
    lo = align(center - half, 'down'); hi = align(center + half, 'up');
  } else if (mode === 'width_pct') {
    // ±X% harga -> ticks: ln(1+x)/ln(1.0001)
    const dt = Math.round(Math.log(1 + rules.range.width_pct / 100) / Math.log(1.0001));
    lo = align(curTick - dt, 'down'); hi = align(curTick + dt, 'up');
  } else if (mode === 'full') {
    lo = m.alignTick(m.MIN_TICK, sp, 'up'); hi = m.alignTick(m.MAX_TICK, sp, 'down');
  } else {
    lo = act.tickLower; hi = act.tickUpper;
  }
  if (rules.range.min_width_ticks && hi - lo < rules.range.min_width_ticks) {
    const c = Math.round((lo + hi) / 2), half = Math.round(rules.range.min_width_ticks / 2);
    lo = align(c - half, 'down'); hi = align(c + half, 'up');
  }
  if (hi <= lo) hi = lo + sp;
  return { tickLower: lo, tickUpper: hi, tickSpacing: sp };
}

// v3 di RH chain memakai fee tier standar; v4 selalu membawa tickSpacing sendiri.
function tickSpacingFromFee(fee) {
  const map = { 100: 1, 500: 10, 2500: 50, 3000: 60, 10000: 200 };
  return map[fee] || 60;
}

// ---- ukuran ---------------------------------------------------------------
// Nilai posisi (dalam aset kuotasi) untuk sebuah L pada rentang tertentu.
function valueOfLiquidity(chain, act, L, tickLower, tickUpper, slot0, dec0, dec1) {
  const a = m.getSqrtRatioAtTick(tickLower), b = m.getSqrtRatioAtTick(tickUpper);
  const { amount0, amount1 } = m.amountsForLiquidity(slot0.sqrtPriceX96, a, b, L);
  const v = chain.valueInQuote({
    sqrtPriceX96: slot0.sqrtPriceX96, amount0, amount1, dec0, dec1,
    token0: act.token0, token1: act.token1,
  });
  return { amount0, amount1, value: v ? v.value : null, symbol: v ? v.symbol : null, kind: v ? v.kind : null };
}

// Konversi ambang USD ke satuan kuotasi pool (ETH pakai kurs dari config).
function usdToQuote(usd, quoteKind, ethUsd) {
  if (quoteKind === 'usd') return usd;
  if (quoteKind === 'eth') return ethUsd > 0 ? usd / ethUsd : 0;
  return usd;
}
function quoteToUsd(q, quoteKind, ethUsd) {
  return quoteKind === 'eth' ? q * ethUsd : q;
}
// Kurs USD per satu satuan aset kuotasi yang tercatat di baris posisi (kolom quote_symbol).
// WETH sama dengan ETH — dulu banyak tempat hanya mengecek 'ETH', sehingga posisi berkuotasi
// WETH senilai 0,08 WETH (~$200) terhitung $0,08 untuk anggaran harian, eksposur, dan PnL.
function usdPerQuote(symbol, ethUsd, chain = null) {
  return (chain ? chain.isEthLike(symbol) : symbol === 'ETH' || symbol === 'WETH') ? ethUsd : 1;
}

/**
 * Bangun rencana untuk aksi TAMBAH likuiditas (mint/increase).
 * ctx: { chain, store, rules, slot0, dec0, dec1, ethUsd, openExposureUsd, spentTodayUsd, openCount }
 */
function planEntry(act, ctx) {
  const { rules, chain, slot0, dec0, dec1, ethUsd } = ctx;
  const skip = (reason) => ({ verdict: 'skip', reason });

  if (!slot0) return skip('state pool tidak terbaca');
  if (!rules.filters.venues.includes(act.venue)) return skip(`venue ${act.venue} dimatikan`);
  if (act.venue === 'v4' && act.hooks && !/^0x0+$/.test(act.hooks) && !rules.filters.allow_hooks) {
    return skip(`pool memakai hook ${act.hooks.slice(0, 10)}… (hook bisa mengunci penarikan)`);
  }
  if (act.fee != null && act.fee > rules.filters.max_fee_bps) return skip(`fee tier ${act.fee} di atas batas`);

  const q = chain.quoteSideOf(act.token0, act.token1);
  if (!q) return skip(`pool tanpa aset kuotasi yang dikenal (${Object.values(chain.QUOTES).map((x) => x.symbol).join('/')})`);
  if (rules.filters.quote_whitelist.length && !rules.filters.quote_whitelist.includes(q.symbol)) {
    return skip(`kuotasi ${q.symbol} tidak diizinkan`);
  }
  const other = (q.side === 0 ? act.token1 : act.token0).toLowerCase();
  const bl = rules.filters.token_blacklist.map((x) => x.toLowerCase());
  const wl = rules.filters.token_whitelist.map((x) => x.toLowerCase());
  if (bl.includes(other)) return skip('token masuk daftar hitam');
  if (wl.length && !wl.includes(other)) return skip('token di luar daftar putih');

  const targetUsd = quoteToUsd(act.valueQuote || 0, q.kind, ethUsd);
  if (targetUsd < rules.filters.min_target_quote_usd) {
    return skip(`posisi target cuma $${targetUsd.toFixed(2)} (< $${rules.filters.min_target_quote_usd})`);
  }
  // Menambah ke posisi yang sudah kita cermin tidak membuka posisi baru.
  const adding = ctx.existingUsd != null;
  if (!adding && ctx.openCount >= rules.filters.max_open_positions) return skip('jumlah posisi terbuka sudah mentok');

  const range = planRange(rules, act, slot0.tick);
  const side = m.sideOfRange(slot0.tick, range.tickLower, range.tickUpper);
  if (side !== 'both') {
    if (rules.onesided.policy === 'skip') return skip(`posisi satu sisi (${side}) dan aturannya lewati`);
    if (rules.onesided.policy === 'recenter') {
      const half = Math.round((range.tickUpper - range.tickLower) / 2);
      range.tickLower = m.alignTick(slot0.tick - half, range.tickSpacing, 'down');
      range.tickUpper = m.alignTick(slot0.tick + half, range.tickSpacing, 'up');
    }
  }
  const sideNow = m.sideOfRange(slot0.tick, range.tickLower, range.tickUpper);

  // ukuran
  const Ltarget = BigInt(act.liquidity) < 0n ? -BigInt(act.liquidity) : BigInt(act.liquidity);
  let L;
  const s = rules.sizing;
  if (s.mode === 'mirror') L = Ltarget;
  else if (s.mode === 'pct') L = (Ltarget * BigInt(Math.round(s.pct * 1e6))) / 100000000n;
  else if (s.mode === 'multiplier') L = (Ltarget * BigInt(Math.round(s.multiplier * 1e6))) / 1000000n;
  else if (s.mode === 'fixed_quote') {
    const wantQuote = q.kind === 'eth' ? s.fixed_quote_eth : s.fixed_quote_usd;
    const ref = valueOfLiquidity(chain, act, Ltarget, range.tickLower, range.tickUpper, slot0, dec0, dec1);
    if (!ref.value || ref.value <= 0) return skip('nilai referensi nol, tidak bisa menskala ke nominal tetap');
    L = (Ltarget * BigInt(Math.round(wantQuote * 1e9))) / BigInt(Math.round(ref.value * 1e9));
  } else L = Ltarget;
  if (L <= 0n) return skip('ukuran hasil hitung nol');

  let est = valueOfLiquidity(chain, act, L, range.tickLower, range.tickUpper, slot0, dec0, dec1);
  if (est.value == null) return skip('tidak bisa menilai posisi');
  let usd = quoteToUsd(est.value, q.kind, ethUsd);

  // batas atas: semua plafon dikumpulkan dulu (bukan cuma yang terlampaui), karena
  // "paksa minimum" di bawah butuh tahu berapa ruang yang tersisa sebelum menaikkan ukuran.
  const limits = [];
  // Posisi satu sisi punya batasnya sendiri (onesided.max_quote_usd). Dicatat terpisah
  // supaya alasannya menyebut batas yang benar-benar mengikat — dulu keduanya digabung
  // lalu selalu disebut "batas per posisi", padahal yang memotong sering batas satu sisi.
  let capPer = s.max_quote_per_position_usd;
  let capSide = sideNow !== 'both' ? rules.onesided.max_quote_usd : Infinity;
  // Tambahan ke posisi yang sudah ada: batas per posisi berlaku untuk TOTALNYA. Dulu yang
  // dibatasi hanya tambahannya, jadi posisi $200 dengan batas $200 bisa tumbuh jadi $400.
  if (adding) {
    capPer = Math.max(0, capPer - Math.max(0, ctx.existingUsd));
    capSide = Math.max(0, capSide - Math.max(0, ctx.existingUsd));
  }
  limits.push(['batas per posisi', capPer]);
  if (sideNow !== 'both') limits.push(['batas satu sisi', capSide]);
  limits.push(['sisa jatah eksposur total', Math.max(0, s.max_total_exposure_usd - ctx.openExposureUsd)]);
  limits.push(['sisa anggaran harian', Math.max(0, s.daily_budget_usd - ctx.spentTodayUsd)]);
  // Kas nyata ({usdg, eth}; null = tidak dibatasi). Eksekusi menyiapkan 105% nilai
  // posisi di aset kuotasi pool. Kas di aset kuotasi LAIN harus dijembatani dulu, dan
  // jembatan itu memakan ruang slippage plus selisih kurs Kyber terhadap harga ETH kita
  // (BRIDGE_MARGIN_BPS) — tanpa ruang itu ukuran yang pas-pasan lolos di sini lalu
  // gagal "kas kurang untuk jembatan".
  if (ctx.cash) {
    const ethAsUsd = ctx.cash.eth * ethUsd;
    const [same, other] = q.kind === 'eth' ? [ethAsUsd, ctx.cash.usdg] : [ctx.cash.usdg, ethAsUsd];
    const bridge = 1 + (rules.swap.max_slippage_bps + BRIDGE_MARGIN_BPS) / 10000;
    limits.push(['kas tersedia', Math.max(0, (same + other / bridge) / 1.05)]);
  }
  const [capWhy, capUsd] = limits.sort((a, b) => a[1] - b[1])[0];

  // Nilai posisi linear terhadap L pada rentang yang sama, jadi menyetel nominal =
  // menskala L dengan perbandingan dolar.
  const resize = (wantUsd) => {
    L = (L * BigInt(Math.round(wantUsd * 1e9))) / BigInt(Math.round(usd * 1e9));
    est = valueOfLiquidity(chain, act, L, range.tickLower, range.tickUpper, slot0, dec0, dec1);
    usd = quoteToUsd(est.value || 0, q.kind, ethUsd);
  };

  let capNote = null;
  if (usd > capUsd) {
    if (capUsd <= 0) return skip(`${capWhy} habis`);
    resize(capUsd);
    capNote = `dipotong oleh ${capWhy} ($${capUsd.toFixed(2)})`;
  }
  // Di bawah minimum posisi dilewati — kecuali "paksa minimum" menyala: ukurannya
  // dinaikkan ke nominal paksa, selama nominal itu masih muat di plafon yang mengikat.
  if (usd < s.min_quote_usd) {
    const small = `hasilnya $${usd.toFixed(2)} (< minimum $${s.min_quote_usd})`;
    if (!s.force_min || s.force_min_usd <= 0) return skip(`${small}${capNote ? ` — ${capNote}` : ''}`);
    if (usd <= 0) return skip(`${small} — nilainya nol, tidak bisa dipaksa`);
    if (s.force_min_usd > capUsd) {
      return skip(`${small} dan paksa $${s.force_min_usd} tidak muat — ${capWhy} tinggal $${capUsd.toFixed(2)}`);
    }
    const before = usd;
    resize(s.force_min_usd);
    capNote = `dipaksa ke $${usd.toFixed(2)} (hitungan $${before.toFixed(2)} < minimum $${s.min_quote_usd})`;
  }

  const slipBps = BigInt(rules.swap.max_slippage_bps);
  const pad = (x) => (x * (10000n + slipBps)) / 10000n;

  return {
    verdict: 'copy',
    reason: capNote || `${s.mode} → $${usd.toFixed(2)}`,
    plan: {
      venue: act.venue,
      action: 'mint',
      poolRef: act.poolRef, poolKey: act.poolKey,
      token0: act.token0, token1: act.token1, fee: act.fee,
      tickSpacing: range.tickSpacing,
      tickLower: range.tickLower, tickUpper: range.tickUpper,
      liquidity: L.toString(),
      amount0: est.amount0.toString(), amount1: est.amount1.toString(),
      amount0Max: pad(est.amount0).toString(), amount1Max: pad(est.amount1).toString(),
      valueQuote: est.value, quoteSymbol: q.symbol, quoteKind: q.kind, quoteSide: q.side,
      valueUsd: usd,
      side: sideNow,
      mirrorOf: act.tokenId, target: act.target,
      curTick: slot0.tick,
      targetRange: [act.tickLower, act.tickUpper],
      targetValueUsd: targetUsd,
    },
  };
}

/** Rencana untuk aksi KURANGI/TUTUP dari target, dipetakan ke posisi kita. */
function planExit(act, ourPos, ctx) {
  const { rules } = ctx;
  if (!rules.exit.follow_target) return { verdict: 'skip', reason: 'ikut-keluar dimatikan' };
  if (!ourPos) return { verdict: 'skip', reason: 'kita tidak punya cermin posisi ini' };
  const removed = -BigInt(act.liquidity);          // positif
  const before = BigInt(act.liquidityBefore || 0n); // L target sebelum aksi (kalau diketahui)
  const ourL = BigInt(ourPos.liquidity);
  let takeL;
  const partial = before > 0n && removed < before;
  if (partial && !rules.exit.follow_partial) {
    // "Ikut menarik sebagian" dimatikan = abaikan tarikan sebagian. Dulu justru menutup
    // cermin kita PENUH saat target cuma menarik sebagian.
    return { verdict: 'skip', reason: 'target menarik sebagian — ikut-tarik-sebagian dimatikan' };
  }
  if (partial) {
    takeL = (ourL * removed) / before;             // proporsional
  } else {
    takeL = ourL;                                   // target menutup penuh -> kita tutup penuh
  }
  if (takeL <= 0n) return { verdict: 'skip', reason: 'porsi keluar nol' };
  const full = takeL >= ourL;
  return {
    verdict: 'copy',
    reason: full ? 'target menutup posisi' : `target menarik ${(Number(removed * 10000n / (before || removed)) / 100).toFixed(1)}%`,
    plan: {
      venue: ourPos.venue, action: full ? 'burn' : 'decrease',
      positionId: ourPos.id, tokenId: ourPos.token_id,
      liquidity: takeL.toString(), full,
      poolKey: ourPos.poolKey, poolRef: ourPos.pool_ref,
      token0: ourPos.token0, token1: ourPos.token1,
      tickLower: ourPos.tick_lower, tickUpper: ourPos.tick_upper,
      mirrorOf: act.tokenId, target: act.target,
    },
  };
}

module.exports = { DEFAULTS, RULE_SPEC, validateRules, normalizeRules, rulesFor, deepMerge, planEntry, planExit, planRange, valueOfLiquidity, usdToQuote, quoteToUsd, usdPerQuote, tickSpacingFromFee };
