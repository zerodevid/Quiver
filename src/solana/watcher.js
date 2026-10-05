'use strict';
// Pengamat target di Solana. Tidak ada log event yang bisa dipindai per blok seperti
// di EVM, jadi gerakan target diturunkan dari SELISIH KEADAAN:
//
//   1. tiap putaran, tanda tangan baru wallet target dicek (1 panggilan murah);
//   2. kalau ada yang baru (atau sudah lama tidak dicek penuh), semua posisi target di
//      ketiga venue didaftar ulang dan dibandingkan dengan potret sebelumnya:
//        posisi baru            -> 'increase' (liquidityBefore 0 = mint)
//        L naik                 -> 'increase'
//        L turun                -> 'decrease' (liquidityBefore = L lama → porsi sebanding)
//        posisi hilang          -> 'decrease' penuh
//        fee dipanen, L tetap   -> 'claim' (lihat claimed())
//
// Potret disimpan per target di state (bertahan restart). Pemindaian pertama sebuah
// target hanya membuat potret — posisi yang SUDAH ada sebelum target ditambahkan tidak
// disalin (sama dengan EVM: yang disalin hanya aksi sesudah kursor).
//
// Pagar: venue yang GAGAL dibaca tidak boleh terbaca "semua posisinya hilang" — potret
// lama venue itu dipertahankan apa adanya dan tidak ada aksi yang dibuat untuknya.
const { PublicKey } = require('@solana/web3.js');

const FULL_RESCAN_MS = 10 * 60_000;
// Sesudah tanda tangan baru terlihat, potret dibaca ulang tiap putaran selama jendela
// ini walau tidak ada tanda tangan baru lagi: tanda tangan bisa sudah terlihat di satu
// endpoint sementara akun posisinya belum diperbarui di endpoint yang menjawab
// pembacaan posisi — tanpa jendela ini perubahannya baru tertangkap di rescan 10 menit.
const HOT_MS = 30_000;
// Perubahan saham di bawah 1/NOISE_DIV (0,1%) pada posisi yang tetap ada bukan sinyal:
// bot target yang memadatkan fee atau pembulatan program menggeser saham DLMM sangat
// sedikit di hampir tiap transaksi (terukur di mainnet: ~1e-14 relatif). Menyalinnya =
// satu transaksi berbiaya per gerakan remeh. Nilai lama dipertahankan di potret, jadi
// geseran kecil yang menumpuk tetap tertangkap begitu melewati ambang.
const NOISE_DIV = 1000n;

class SolanaWatcher {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg; this.log = log || console.log;
    this.unsupported = new Map();
    this.lastScan = new Map();   // target -> ts pemindaian penuh terakhir
    this.venueErr = new Map();   // `${target}:${venue}` -> pesan galat terakhir
    this.hotUntil = new Map();   // target -> ts akhir jendela baca-ulang
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

  // Tanda tangan baru sejak yang terakhir dilihat. null = gagal dibaca.
  async newSignatures(target, last) {
    const get = (until) => this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(target), { limit: 25, ...(until ? { until } : {}) }), { needsHistory: true });
    try {
      return await get(last);
    } catch (e) {
      // Endpoint yang tidak menyimpan riwayat tanda tangan `last` menjawab "Transaction …
      // not found" — SETIAP putaran, sehingga target tidak pernah dipindai lagi. Ambil
      // tanpa `until`: kalau yang terbaru bukan `last`, ada yang baru.
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

  // Daftar posisi target per venue. Venue yang gagal: { ok:false } (potret lama dipakai).
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

  // Bandingkan potret lama dan daftar baru -> aksi mentah (belum bernilai).
  static tiny(L0, L) {
    const d = L > L0 ? L - L0 : L0 - L;
    return L0 > 0n && L > 0n && d * NOISE_DIV < L0;
  }

  static diff(target, prev, now) {
    const acts = [];
    for (const [id, p] of Object.entries(now)) {
      const o = prev[id];
      const L = BigInt(p.liquidity), L0 = o ? BigInt(o.liquidity) : 0n;
      if (o && L > 0n && (L === L0 || SolanaWatcher.tiny(L0, L)) && SolanaWatcher.claimed(o, p)) {
        acts.push({ target, id, kind: 'claim', delta: 0n, before: L0, pos: p, prev: o });
        continue;
      }
      if (o && SolanaWatcher.tiny(L0, L)) continue;
      if (!o || L > L0) {
        if (L === 0n) continue;   // akun posisi kosong baru dibuat: belum ada likuiditas
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
    // Venue yang sudah pernah terbaca untuk target ini. Venue yang BARU pertama kali
    // terbaca (gagal saat potret awal, atau baru dinyalakan di filter) hanya menjadi
    // potret — posisi lamanya tidak boleh terbaca sebagai posisi baru lalu disalin massal.
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
        // venue gagal / dimatikan: potret lamanya dibawa apa adanya
        for (const [id, p] of Object.entries(prevAll)) if (p.venue === v) nowAll[id] = p;
      }
    }
    if (!anyOk) return [];
    // Geseran remeh tidak ikut potret (lihat NOISE_DIV): saham lama dipertahankan.
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

  // Satu putaran semua target aktif. Galat satu target tidak menghentikan yang lain.
  async scan() {
    const out = [];
    for (const t of this.enabledSet()) {
      try { out.push(...await this.scanTarget(t)); }
      catch (e) { this.log(`pindai ${t.slice(0, 6)}…: ${e.message}`); }
    }
    return out;
  }

  // Aksi mentah -> baris actions (bernilai) + objek aksi untuk mesin. Kunci unik
  // (tx_hash, log_index): tanda tangan terbaru + urutan, jadi putaran yang terulang
  // tidak mencatat aksi yang sama dua kali.
  async persist(raw) {
    const fresh = [];
    let i = 0;
    for (const a of raw) {
      const p = a.pos;
      const st = await this.chain.pool(p.venue, p.pool).catch(() => null);
      const dm = await this.chain.decimalsMap([p.token0, p.token1]).catch(() => new Map());
      const dec0 = st?.dec0 ?? dm.get(p.token0), dec1 = st?.dec1 ?? dm.get(p.token1);
      // Nilai = nilai porsi yang bergerak (tambahan / tarikan).
      let amt0 = BigInt(p.amount0 || '0'), amt1 = BigInt(p.amount1 || '0');
      // Jumlah yang BERGERAK = porsi saham yang bergerak di komposisi harga SEKARANG:
      // isi × |ΔL| / L. Bukan selisih isi sebelum/sesudah — itu ikut bergeser karena harga
      // (satu sisi bisa terbaca negatif lalu terpotong ke nol). Posisi baru: seluruh isinya;
      // posisi hilang: isi terakhirnya.
      const dL = a.delta < 0n ? -a.delta : a.delta;
      const Lnow = BigInt(p.liquidity || '0');
      if (a.kind === 'claim') { amt0 = BigInt(a.prev.fee0 || '0'); amt1 = BigInt(a.prev.fee1 || '0'); }
      else if (a.gone && a.prev) { amt0 = BigInt(a.prev.amount0 || '0'); amt1 = BigInt(a.prev.amount1 || '0'); }
      else if (a.before > 0n && Lnow > 0n) { amt0 = (amt0 * dL) / Lnow; amt1 = (amt1 * dL) / Lnow; }
      const v = st && dec0 != null && dec1 != null
        ? this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: amt0, amount1: amt1, dec0, dec1, token0: p.token0, token1: p.token1 })
        : null;
      // Kunci unik per gerakan: tanda tangan yang sama bisa membawa lebih dari satu
      // gerakan pada posisi yang sama (terbaca di jendela baca-ulang).
      const hash = a.kind === 'claim'
        ? `${a.sig || 'snap'}:${a.id}:claim:${a.prev.fee0}:${a.prev.fee1}:${a.prev.feeMark || ''}`
        : `${a.sig || 'snap'}:${a.id}:${a.kind}:${a.delta}`;
      const ext = { lower: p.lower, upper: p.upper, liquidityBefore: a.before.toString(), ...(p.ext || {}), gone: !!a.gone };
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
