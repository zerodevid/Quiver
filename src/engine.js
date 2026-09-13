'use strict';
// Mesin utama: deteksi -> keputusan -> (swap) -> eksekusi -> pencatatan.
const { ethers } = require('ethers');
const { ADDR, QUOTES, TOPIC, ABI } = require('./chain');
const { Watcher } = require('./watcher');
const { Positions } = require('./positions');
const { Executor, isNative } = require('./executor');
const { Kyber } = require('./kyber');
const { pickSwapPool } = require('./swappool');
const { Compound } = require('./compound');
const { Capital } = require('./capital');
const { rulesFor, planEntry, planExit, quoteToUsd, usdPerQuote } = require('./policy');
const { enumerateV4, livePositions } = require('./scout');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
// Jumlah mentah -> teks untuk pesan: 2 desimal di atas 1, 3 angka penting di bawahnya.
const fmtUnits = (raw, dec) => {
  const n = Number(raw) / 10 ** dec;
  return n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)));
};
// Asal sebuah sisa, untuk pesan. Antrean jual sekarang juga menampung token yang
// disapu dari wallet (posId null) — bukan cuma yang keluar dari posisi.
const asalSisa = (item) => (item.posId == null ? 'sisa di wallet' : `posisi #${item.posId}`);

// Durasi singkat untuk kabar: "45 dtk", "3 mnt", "1 jam 20 mnt".
function lamanya(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  const j = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${j} jam ${m} mnt` : `${j} jam`;
}

class Engine {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    this.log = log || console.log;
    this.watcher = new Watcher({ rpc, store, chain, log: this.log, cfg });
    this.positions = new Positions({ rpc, store, chain, log: this.log });
    this.exec = new Executor({ rpc, store, chain, cfg, log: this.log });
    this.kyber = new Kyber({ exec: this.exec, rpc, cfg, log: this.log });
    this.ethUsd = cfg.prices?.eth_usd || 2500;
    this.cursor = 0;
    this.head = 0;
    this.busy = false;
    this.exiting = new Set();      // id posisi yang transaksi keluarnya sedang berjalan
    this.compound = new Compound(this);
    this.capital = new Capital({ rpc, store, chain, cfg, log: this.log });
    this.troubles = new Map();     // kunci -> galat beruntun yang sedang ditangani cadangan
    this.lastCopyAt = new Map();   // poolRef -> ts (cooldown)
    this.stats = { scanned: 0, actions: 0, copied: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    this.lastError = null;
    // Rentang pindai menyusut saat RPC mengeluh dan tumbuh lagi saat lancar.
    // Tanpa ini, mengejar ketertinggalan besar memicu 429 beruntun.
    this.span = cfg.loop?.max_block_span || 1500;
    this.failStreak = 0;
    this.headSpread = 0;
    this.cash = null;              // saldo kas terakhir, lihat refreshCash()
  }

  rulesFrom(targetAddr) {
    const t = this.store.get('SELECT rules FROM targets WHERE address=?', targetAddr);
    return rulesFor(this.cfg.rules, t?.rules);
  }

  async init() {
    const addr = this.exec.address();
    if (addr) this.store.setState('wallet_address', addr);
    this.head = await this.rpc.blockNumber();
    const saved = Number(this.store.getState('cursor', 0));
    this.cursor = saved || this.head - 1;
    if (this.cfg.prices?.auto_eth_price !== false) {
      this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    }
    this.log(`mulai di blok ${this.cursor}; wallet ${addr || '(belum diisi — mode simulasi)'}; ETH $${this.ethUsd.toFixed(2)}`);
    if (addr) { this.lastAdopt = Date.now(); await this.adoptOwnPositions(addr); }
    await this.backfillDecisions();
  }

  // Aksi yang sempat tercatat tapi belum diputuskan (mis. proses mati di tengah jalan).
  // Aturannya: di mode LIVE aksi lampau TIDAK BOLEH dieksekusi — sinyal LP yang sudah
  // basah beberapa jam bukan lagi sinyal. Di mode simulasi tetap dievaluasi supaya
  // terlihat "seandainya" -nya (entry yang basi tetap dilewati di handleEntry, sama
  // seperti LIVE).
  async backfillDecisions() {
    const stale = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const rows = this.store.all(`
      SELECT a.* FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE d.id IS NULL ORDER BY a.ts ASC LIMIT 500`);
    if (!rows.length) return;
    let done = 0;
    for (const r of rows) {
      const old = Date.now() - r.ts > stale;
      if (old && !this.dryRun()) {
        this.decide(r.id, 'skip', 'aksi lampau — mesin sedang mati saat itu');
        continue;
      }
      const act = {
        id: r.id, ts: r.ts, block: r.block, txHash: r.tx_hash, logIndex: r.log_index,
        target: r.target, venue: r.venue, kind: r.kind, tokenId: r.token_id, poolRef: r.pool_ref,
        token0: r.token0, token1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
        tickLower: r.tick_lower, tickUpper: r.tick_upper, liquidity: r.liquidity,
        amount0: r.amount0, amount1: r.amount1, valueQuote: r.value_quote, quoteSymbol: r.quote_symbol,
        // poolKey tidak disimpan di tabel actions, tapi semua bagiannya ada. Tanpa ini setiap
        // entry v4 yang dinilai ulang (proses mati / berhenti di tengah daftar aksi) dilewati
        // "data pool posisi target tidak terbaca".
        poolKey: r.venue === 'v4' && r.token0 && r.token1 && r.fee != null && r.tick_spacing != null
          ? { currency0: r.token0, currency1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks || ADDR.native }
          : null,
      };
      try {
        if (act.venue === 'v4' && act.poolRef) act.slot0 = await this.chain.slot0V4(act.poolRef);
        else if (act.poolRef) act.slot0 = await this.chain.slot0V3(act.poolRef);
        await this.handle(act);
        done++;
      } catch (e) { this.decide(r.id, 'error', String(e.message).slice(0, 200)); }
    }
    if (done) this.log(`menilai ulang ${done} aksi yang belum diputuskan`);
  }

  // Rekonsiliasi dengan chain: posisi v4 milik wallet yang belum tercatat diadopsi —
  // baik yang dibuka di luar bot (manual, bot lain di wallet yang sama) maupun yang
  // mint-nya terkirim tapi proses mati sebelum sempat dicatat.
  //
  // Pemindaian pertama mencakup SELURUH riwayat: Transfer NFT yang disaring alamat
  // wallet itu murah (potongan 1 juta blok). Dulu jendelanya 600rb blok (~17 jam) dan
  // hanya dijalankan saat start, sehingga posisi yang lebih tua tidak pernah tampil.
  // Setelah itu cukup blok baru sejak pemindaian terakhir, dipanggil berkala.
  async adoptOwnPositions(addr) {
    try {
      const me = addr.toLowerCase();
      const head = await this.rpc.blockNumber();
      const last = Number(this.store.getState('adopt_scanned_to', 0));
      const blocks = last ? head - last + 2000 : (this.cfg.loop?.adopt_blocks ?? head);
      const { held } = await enumerateV4(this.rpc, me, head, blocks, 1_000_000);
      // Penanda jendela pindai baru dimajukan kalau SEMUA kandidat terbaca. Dulu dimajukan
      // sebelum posisinya dibaca: satu pembacaan RPC yang gagal membuat posisi wallet itu
      // tidak diadopsi, dan pemindaian berikutnya tidak lagi mencakup bloknya — hilang.
      const done = () => this.store.setState('adopt_scanned_to', head);
      const known = new Set(this.store.all("SELECT token_id FROM positions WHERE venue='v4' AND token_id IS NOT NULL").map((r) => r.token_id));
      let missing = [...held.keys()].filter((id) => !known.has(id));
      if (!missing.length) return done();
      // Transfer bisa menipu (urutan dalam satu blok); pastikan pemiliknya sekarang kita.
      // strict: tidak terbaca melempar (dicoba lagi 10 menit lagi); revert = NFT dibakar.
      const owners = await this.rpc.ethCallMany(missing.map((id) => ({
        to: ADDR.posmV4, data: new ethers.Interface(ABI.posmV4).encodeFunctionData('ownerOf', [BigInt(id)]),
      })), 'latest', { strict: true });
      missing = missing.filter((id, i) => owners[i] && owners[i] !== '0x' && ('0x' + owners[i].slice(-40)).toLowerCase() === me);
      if (!missing.length) return done();
      const rows = await livePositions(this.rpc, this.chain, missing);
      let incomplete = rows.length < missing.length;
      let n = 0;
      for (const r of rows) {
        if (r.liqKnown === false) { incomplete = true; continue; }
        if (r.liquidity <= 0n) continue;
        // Modal & waktu buka asli dari riset wallet (menu Wallet) kalau pernah dipindai;
        // tanpa itu modal = nilai sekarang, sehingga PnL mulai dari nol saat diadopsi.
        const w = this.store.get('SELECT invested_q, opened_ts FROM wpositions WHERE wallet=? AND token_id=?', me, r.tokenId);
        // Harga pool saat posisi itu dibuka, kalau riset wallet sempat mencatat kejadiannya.
        const ev0 = this.store.get('SELECT sqrt_price FROM wevents WHERE wallet=? AND token_id=? AND sqrt_price IS NOT NULL ORDER BY block LIMIT 1', me, r.tokenId);
        const isEth = r.quoteSymbol === 'ETH' || r.quoteSymbol === 'WETH';
        const cost = w?.invested_q > 0 ? (isEth ? w.invested_q / this.ethUsd : w.invested_q) : r.valueQuote;
        // Posisi yatim: mint yang BERHASIL di chain tetapi gagal tercatat (jawaban RPC
        // hilang, proses mati). Kalau ada rencana salinan yang gagal dengan pool dan
        // rentang yang sama persis, posisi ini hampir pasti hasil rencana itu — pasangkan
        // kembali ke targetnya supaya sinyal keluarnya tetap dicermin. Tanpa ini posisi
        // menggantung sebagai "di luar bot" dan tidak pernah ditutup.
        const link = this.linkOrphan(r);
        this.positions.record({
          venue: 'v4', poolRef: r.poolId, poolKey: r.poolKey,
          token0: r.poolKey.currency0, token1: r.poolKey.currency1, fee: r.poolKey.fee,
          tickSpacing: r.poolKey.tickSpacing, tickLower: r.tickLower, tickUpper: r.tickUpper,
          liquidity: r.liquidity.toString(), amount0: (r.amount0 ?? 0n).toString(), amount1: (r.amount1 ?? 0n).toString(),
          valueQuote: r.valueQuote, quoteSymbol: r.quoteSymbol,
          mirrorOf: link?.mirrorOf ?? null, target: link?.target ?? null,
        }, { tokenId: r.tokenId, txHash: null, target: link?.target ?? null, costQuote: cost, openedTs: w?.opened_ts || null, entrySqrt: ev0?.sqrt_price || null });
        if (link) this.store.log('warn', `posisi #${r.tokenId} dipasangkan kembali ke target ${link.target.slice(0, 10)}… (cermin #${link.mirrorOf}) — mint berhasil tapi sempat tercatat gagal`);
        n++;
      }
      if (n) this.log(`mengadopsi ${n} posisi v4 milik wallet yang belum tercatat`);
      if (incomplete) throw new Error('sebagian posisi wallet belum terbaca dari RPC — dipindai ulang nanti');
      done();
      this.cleared('adopsi', 'adopsi posisi: berhasil lagi');
    } catch (e) { this.trouble('adopsi', `adopsi posisi: ${e.message}`, { after: 3 }); }   // diulang tiap 10 menit
  }

  // Cari rencana salinan yang gagal yang cocok dengan posisi ini (pool + rentang).
  // Hanya keputusan 24 jam terakhir yang dilihat, dan hanya yang belum punya posisi.
  linkOrphan(r) {
    const rows = this.store.all(
      "SELECT d.id, d.plan, a.target FROM decisions d JOIN actions a ON a.id = d.action_id WHERE d.verdict='error' AND d.plan IS NOT NULL AND d.ts > ? ORDER BY d.id DESC LIMIT 50",
      Date.now() - 86_400_000);
    for (const row of rows) {
      let plan = null;
      try { plan = JSON.parse(row.plan); } catch { continue; }
      if (!plan || plan.action === 'burn') continue;
      if (String(plan.poolRef).toLowerCase() !== String(r.poolId).toLowerCase()) continue;
      if (plan.tickLower !== r.tickLower || plan.tickUpper !== r.tickUpper) continue;
      if (this.store.get("SELECT 1 FROM positions WHERE mirror_of=? AND target=? AND status='open'", plan.mirrorOf ?? '', row.target)) continue;
      return { target: row.target, mirrorOf: plan.mirrorOf ?? null };
    }
    return null;
  }

  // ---- galat yang punya jalan cadangan -------------------------------------
  // Banyak galat di sini sudah ditangani sendiri: tick yang gagal mengulang rentang
  // blok yang sama (lebih kecil) di tick berikutnya, sinkron diulang tiap 30 detik,
  // sisa memecoin masuk antrean coba-ulang. Galat seperti itu tetap dicatat, tetapi
  // `quiet` — tidak didorong ke chat. Baru kalau cadangannya terus gagal (`after` kali
  // berturut-turut DAN selama `afterMs`) satu peringatan dikirim, lalu satu kabar
  // pulih begitu berhasil lagi.
  trouble(key, msg, { after = 3, afterMs = 0, level = 'error' } = {}) {
    const now = Date.now();
    let t = this.troubles.get(key);
    // Galat lama yang tidak pernah "pulih" (mis. pemicu keluar yang hilang sendiri)
    // tidak boleh ikut dihitung: jeda 15 menit tanpa galat = hitungan mulai dari nol.
    if (!t || now - t.last > 15 * 60_000) t = { n: 0, since: now, alerted: false };
    t.n++; t.last = now;
    this.troubles.set(key, t);
    if (!t.alerted && t.n >= after && now - t.since >= afterMs) {
      t.alerted = true;
      this.store.log(level, `${msg} — sudah gagal ${t.n}× berturut-turut selama ${lamanya(now - t.since)}, jalan cadangan belum berhasil`);
    } else {
      this.store.log(level, msg, { quiet: true });
    }
  }
  // Panggil setelah langkah yang sama berhasil. `okMsg` null = pulih tanpa kabar
  // (mis. keluar mandiri: kartu penutupan posisi sudah jadi kabarnya).
  cleared(key, okMsg) {
    const t = this.troubles.get(key);
    if (!t) return;
    this.troubles.delete(key);
    if (t.alerted && okMsg) this.store.log('info', `${okMsg} — pulih setelah ${t.n}× gagal (${lamanya(Date.now() - t.since)})`, { recovered: true });
  }

  dryRun() { return this.cfg.mode?.dry_run !== false; }
  paused() { return this.store.getState('paused', this.cfg.mode?.paused ? '1' : '0') === '1'; }

  // ---- satu siklus --------------------------------------------------------
  // Proses sedang berhenti? Tunggu sampai tidak ada transaksi yang berjalan: entry di
  // tengah zap, tx keluar yang belum dibukukan, penjualan sisa, compound. Dulu SIGINT
  // langsung process.exit — token zap yang sudah terbeli tertinggal tanpa LP.
  idle() {
    return !this.busy && !(this.activeEntries > 0) && !(this.exiting?.size > 0) && !this.leftoverBusy
      && !this.compound?.running && !(this.selling?.size > 0) && !this.syncBusy;
  }
  async drain(timeoutMs = 100_000) {
    this.stopping = true;
    const t0 = Date.now();
    while (!this.idle() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 250));
    return this.idle();
  }

  async tick() {
    if (this.stopping || this.busy || this.compound?.running) return;
    // Semua endpoint sedang istirahat: jangan menambah beban, tunggu saja.
    if (this.rpc.allCooling()) return;
    this.busy = true;
    try {
      // Pakai kepala TERENDAH di antara semua endpoint. Kalau kursor dimajukan ke
      // kepala endpoint tercepat sementara getLogs dilayani endpoint yang tertinggal,
      // blok di antaranya tidak akan pernah dipindai ulang.
      const h = await this.rpc.safeHead();
      this.head = h.min;
      this.headSpread = h.spread;
      if (this.head <= this.cursor) return;
      const maxSpan = this.cfg.loop?.max_block_span || 1500;
      const to = Math.min(this.head, this.cursor + this.span);
      const acts = await this.watcher.scan(this.cursor + 1, to);
      this.stats.scanned += to - this.cursor;
      this.cursor = to;
      this.store.setState('cursor', this.cursor);
      const fresh = this.watcher.persist(acts);
      this.stats.actions += fresh.length;
      // Sedang berhenti (deploy/restart): aksi yang belum ditangani TIDAK dieksekusi
      // setengah jalan — sudah tersimpan tanpa keputusan, backfillDecisions menilainya
      // saat proses hidup lagi (kalau masih segar).
      for (const a of fresh) {
        if (this.stopping) break;
        // Galat satu aksi tidak boleh memutus aksi lain di rentang yang sama: kursor sudah
        // maju, jadi aksi yang tidak sempat ditangani baru dinilai saat restart — dan saat
        // itu sudah "lampau". Dicatat sebagai keputusan galat supaya terlihat.
        try { await this.handle(a); }
        catch (e) {
          this.stats.errors++;
          if (a.id != null && !this.store.get('SELECT 1 FROM decisions WHERE action_id=?', a.id)) this.decide(a.id, 'error', String(e.message).slice(0, 300));
          this.store.log('error', `aksi ${a.kind} #${a.tokenId ?? '?'}: ${e.message}`);
        }
      }
      // Pendengar luar (dasbor) diberi tahu aksi baru — mis. untuk memperbarui riset
      // wallet target. Galat pendengar tidak boleh mengganggu siklus copy.
      if (fresh.length && this.onFreshActions) {
        try { this.onFreshActions(fresh); } catch (e) { this.store.log('error', `onFreshActions: ${e.message}`); }
      }
      this.failStreak = 0;
      this.cleared('tick', `pemindaian blok: kembali normal, kursor di blok ${this.cursor}`);
      if (this.span < maxSpan) this.span = Math.min(maxSpan, Math.ceil(this.span * 1.5));
    } catch (e) {
      this.stats.errors++;
      this.failStreak++;
      this.span = Math.max(150, Math.floor(this.span / 2));
      this.lastError = `${String(e.message).slice(0, 250)} (rentang dikecilkan ke ${this.span} blok)`;
      // Cadangan: kursor tidak maju, jadi rentang yang sama diulang (dikecilkan) di tick
      // berikutnya dan RPC berpindah endpoint — tidak ada blok yang terlewat. Kabari
      // hanya kalau pemindaian macet ≥ 5 kali dan ≥ 3 menit berturut-turut.
      this.trouble('tick', `tick: ${e.message} — rentang -> ${this.span}`, { after: 5, afterMs: 3 * 60_000 });
      // beri jeda tambahan supaya tidak menghajar endpoint yang sedang marah
      if (this.failStreak > 2) await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * this.failStreak)));
    } finally { this.busy = false; }
  }

  decide(actionId, verdict, reason, plan = null, txHash = null, positionId = null) {
    this.store.run('INSERT INTO decisions(action_id,ts,verdict,reason,plan,tx_hash,position_id) VALUES(?,?,?,?,?,?,?)',
      actionId, Date.now(), verdict, reason, plan ? JSON.stringify(plan) : null, txHash, positionId);
    if (verdict === 'copy') this.stats.copied++; else if (verdict === 'skip') this.stats.skipped++;
  }

  async handle(act) {
    // Satu aksi hanya boleh diputuskan SEKALI. Tanpa ini, aksi yang sempat diproses
    // lalu diproses lagi (mis. backfill setelah proses mati di tengah jalan) akan
    // menambah modal untuk kedua kalinya ke posisi yang sama.
    if (act.id != null && this.store.get('SELECT 1 FROM decisions WHERE action_id=?', act.id)) return;
    const t = this.store.get('SELECT * FROM targets WHERE address=?', act.target);
    if (!t) return;
    // Jeda dan target yang dimatikan hanya menghentikan MASUK. Sinyal keluar target
    // untuk posisi yang sudah kita pegang tetap diikuti: dulu keduanya diputuskan "skip"
    // selamanya — keluar penuh baru tertolong rekonsiliasi, tarik sebagian hilang.
    const exit = act.kind === 'decrease' || act.kind === 'transfer_out';
    if (!exit && !t.enabled) return this.decide(act.id, 'skip', 'target sedang dimatikan');
    if (!exit && this.paused()) return this.decide(act.id, 'skip', 'bot sedang dijeda');
    const rules = this.rulesFrom(act.target);

    if (act.kind === 'increase') return this.handleEntry(act, rules);
    if (act.kind === 'decrease' || act.kind === 'transfer_out') return this.handleExit(act, rules);
    if (act.kind === 'custody_out') return this.decide(act.id, 'skip', 'posisi dititipkan ke kontrak otomasi — bukan sinyal keluar');
    if (act.kind === 'custody_in') return this.decide(act.id, 'skip', 'posisi dikembalikan dari kontrak otomasi');
    if (act.kind === 'transfer_in') return this.decide(act.id, 'skip', 'target menerima posisi dari wallet lain — tidak dicermin');
    return this.decide(act.id, 'skip', `jenis aksi ${act.kind} tidak dicermin`);
  }

  async handleEntry(act, rules) {
    // Sinyal masuk yang sudah basi tidak disalin. Kursor dilanjutkan dari blok tersimpan,
    // jadi setelah VPS/RPC mati sejam pemindaian mengejar dan menemukan entry target dari
    // sejam lalu — dulu langsung dibuka di harga sekarang, lalu ditutup lagi beberapa tick
    // kemudian begitu sinyal keluarnya (yang juga sudah lama) terbaca: zap, fee pool, dan
    // gas dibayar dua kali untuk posisi yang tidak ada gunanya. Sinyal KELUAR tetap diikuti
    // berapa pun umurnya — itu melindungi dana.
    const stale = await this.staleEntry(act);
    if (stale) return this.decide(act.id, 'skip', stale);
    if (!act.token0 || !act.token1 || (act.venue === 'v4' && !act.poolKey)) {
      return this.decide(act.id, 'skip', 'data pool posisi target tidak terbaca (NFT sudah dibakar?)');
    }
    // Harga pool / nilai posisi target yang gagal dibaca saat pemindaian (RPC sesaat) dulu
    // berujung "state pool tidak terbaca" atau "posisi target cuma $0.00" — sinyal masuk
    // hilang. Dibaca ulang di sini sebelum menilai.
    if ((!act.slot0 || act.valueQuote == null) && act.poolRef) await this.refreshActionState(act);
    // sudah punya cermin posisi ini? berarti ini penambahan; ikut tambah lewat mint baru
    const cd = rules.filters.cooldown_seconds * 1000;
    const last = this.lastCopyAt.get(act.poolRef) || 0;
    if (cd && Date.now() - last < cd) {
      return this.decide(act.id, 'skip', `cooldown pool ${Math.round((cd - (Date.now() - last)) / 1000)}s`);
    }
    const sum = this.positions.summary(this.ethUsd);
    const since = Date.now() - 86400_000;
    const spent = this.store.get(
      "SELECT COALESCE(SUM(cost_quote * CASE WHEN quote_symbol IN ('ETH','WETH') THEN ? ELSE 1 END),0) AS s FROM positions WHERE opened_ts > ?",
      this.ethUsd, since)?.s || 0;

    if (rules.filters.min_pool_age_minutes > 0 && act.venue === 'v4' && act.poolRef) {
      try {
        const age = await this.chain.poolAgeMinutes(act.poolRef);
        if (age < rules.filters.min_pool_age_minutes) {
          return this.decide(act.id, 'skip', `pool baru ${age.toFixed(0)} menit (< ${rules.filters.min_pool_age_minutes})`);
        }
      } catch { /* kalau tidak terbaca, jangan halangi */ }
    }
    // Metadata token yang belum dikenal dibaca dari RPC; galat sementara diulang sebentar
    // (sinyal masuk target tidak menunggu lama).
    let toks;
    for (let i = 0; ; i++) {
      try { toks = await this.chain.tokens([act.token0, act.token1]); break; }
      catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
    // Mode live: ukuran juga dibatasi kas nyata, supaya posisi yang sedikit kelebihan
    // dari saldo dibuka lebih kecil alih-alih gagal di tengah jembatan. Mode simulasi
    // sengaja tidak — wallet uji sering kosong, dan simulasinya jadi tidak berguna.
    const live = !this.dryRun() && this.exec.address();
    const cash = live ? await this.spendableCash().catch(() => null) : null;
    // Kalau kita sudah punya cermin posisi ini, target sedang MENAMBAH — jadi kita
    // menambah juga, bukan membuka posisi kedua. Dicari SEBELUM menilai: batas jumlah
    // posisi tidak berlaku (tidak ada posisi baru) dan batas per posisi dihitung dari total.
    // Bisa lebih dari satu cermin (mode rentang selain "exact"): yang menentukan adalah
    // cermin dengan rentang yang SAMA dengan rencana; itu yang ditambah.
    const mirrors = this.store.all("SELECT * FROM positions WHERE status='open' AND mirror_of=? AND target=? AND token_id IS NOT NULL ORDER BY id",
      act.tokenId ?? '', act.target);
    const usdOfMirror = (mp) => {
      const lv = this.positions.live.find((p) => p.id === mp.id);
      return lv?.valueUsd ?? Math.max(0, (mp.cost_quote || 0) - (mp.out_quote || 0)) * usdPerQuote(mp.quote_symbol, this.ethUsd);
    };
    let mirror = mirrors[0] || null;
    const ctx = {
      chain: this.chain, rules, slot0: act.slot0, dec0: toks[0].decimals, dec1: toks[1].decimals,
      ethUsd: this.ethUsd, openExposureUsd: sum.exposureUsd, spentTodayUsd: spent, openCount: sum.openCount,
      cash, existingUsd: mirror ? usdOfMirror(mirror) : null,
    };
    let d = planEntry(act, ctx);
    // Rentang hasil aturan (recenter/scale/…) tidak sama dengan cermin pertama: cari cermin
    // lain yang rentangnya sama; kalau tidak ada, ini posisi BARU dengan batas posisi baru.
    if (mirror && d.verdict === 'copy' && !(mirror.tick_lower === d.plan.tickLower && mirror.tick_upper === d.plan.tickUpper)) {
      const same = mirrors.find((mp) => mp.tick_lower === d.plan.tickLower && mp.tick_upper === d.plan.tickUpper) || null;
      mirror = same;
      d = planEntry(act, { ...ctx, existingUsd: same ? usdOfMirror(same) : null });
    }
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);

    const existing = mirror && mirror.tick_lower === d.plan.tickLower && mirror.tick_upper === d.plan.tickUpper ? mirror : null;
    if (existing && existing.token_id) {
      d.plan.action = 'increase';
      d.plan.tokenId = existing.token_id;
      d.plan.positionId = existing.id;
      d.reason = `${d.reason} (menambah posisi #${existing.id})`;
    }

    if (this.dryRun() || !this.exec.address()) {
      const sim = this.exec.address() ? await this.simulateEntry(d.plan) : null;
      const note = sim ? (sim.ok ? `simulasi OK (gas ${sim.gas})` : `simulasi GAGAL: ${sim.error}`) : 'tanpa wallet';
      return this.decide(act.id, 'dry', `${d.reason} — ${note}`, d.plan);
    }
    try {
      const r = await this.executeEntry(d.plan, act);
      this.lastCopyAt.set(act.poolRef, Date.now());
      this.decide(act.id, 'copy', `${d.reason} — ${r.note}`, d.plan, r.txHash, r.positionId);
      this.notify(`LP disalin: ${r.note}`, {
        kind: 'entry', positionId: r.positionId, txHash: r.txHash, adding: !!r.adding,
        pair: r.pair, valueUsd: r.valueUsd, curTick: r.curTick, steps: r.steps,
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
      });
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
      this.store.log('error', `eksekusi masuk: ${e.message}`);
    }
  }

  async handleExit(act, rules) {
    // SEMUA cermin posisi ini. Dengan mode rentang selain "exact" satu posisi target bisa
    // punya dua cermin (target menambah di rentang yang dihitung ulang berbeda); dulu hanya
    // satu yang ikut ditarik/ditutup.
    let mirrors = this.store.all(
      "SELECT * FROM positions WHERE status='open' AND mirror_of=? AND target=? ORDER BY id", act.tokenId ?? '', act.target);
    if (!mirrors.length && act.poolRef && act.tickLower != null && act.tickUpper != null) {
      // Cadangan pool + rentang HANYA untuk posisi yang asal tokenId-nya tidak tercatat
      // (mirror_of kosong). Dulu semua posisi ikut: target yang punya posisi A dan B
      // identik — kita cuma mencermin A — menutup B, lalu cermin A ikut ditutup.
      // (Aksi transfer_out tidak membawa info pool; mengikat undefined ke SQLite melempar.)
      const pos = this.store.get(
        "SELECT * FROM positions WHERE status='open' AND pool_ref=? AND target=? AND tick_lower=? AND tick_upper=? AND mirror_of IS NULL ORDER BY id ASC LIMIT 1",
        act.poolRef, act.target, act.tickLower, act.tickUpper);
      if (pos) {
        this.store.log('warn', `cermin posisi dicocokkan lewat pool+rentang (bukan tokenId) untuk aksi #${act.tokenId} -> posisi #${pos.id}`);
        mirrors = [pos];
      }
    }
    if (!mirrors.length) return this.decide(act.id, 'skip', 'tidak ada cermin posisi yang cocok');

    // berapa L target sebelum menarik? = L sesudah aksi + yang ditarik
    //
    // Gagal baca TIDAK boleh dianggap nol: nol berarti "target tutup penuh" dan cermin
    // kita di-burn seluruhnya — padahal target mungkin cuma menarik 10%. Dicoba beberapa
    // kali; kalau tetap tidak terbaca, aksi ini dilewati: kalau target memang keluar
    // penuh, rekonsiliasi keluar (tiap sinkron) yang menutupnya.
    //
    // Dibaca DI BLOK AKSI itu (state sesudah blok), bukan `latest`: saat bot tertinggal,
    // `latest` sudah memuat aksi target sesudahnya (tarik 50% lalu 50% lagi → aksi pertama
    // terbaca tutup penuh), dan node yang tertinggal menjawab likuiditas SEBELUM aksi.
    // Aksi lain pada NFT yang sama di blok yang sama (sesudah aksi ini) dikembalikan dulu.
    let before = null;
    if (act.kind === 'decrease') {
      for (let i = 0; i < 3 && before == null; i++) {
        if (i) await new Promise((r) => setTimeout(r, 1500));
        try {
          const got = await this.targetLiquidity(act.venue, act.tokenId, act.block);
          if (got != null) {
            const after = got.atBlock ? got.liquidity - this.laterDeltasInBlock(act) : got.liquidity;
            before = after + (-BigInt(act.liquidity));
          }
        } catch { /* coba lagi */ }
      }
      if (before == null) {
        this.store.log('warn', `likuiditas target #${act.tokenId} tidak terbaca dari RPC — aksi keluar dilewati (rekonsiliasi menutup kalau target memang keluar penuh)`);
        return this.decide(act.id, 'skip', 'likuiditas target tidak terbaca dari RPC');
      }
    }

    const outs = [];
    for (const pos of mirrors) outs.push(await this.exitMirror(act, rules, pos, before));
    if (outs.length === 1) {
      const o = outs[0];
      return this.decide(act.id, o.verdict, o.reason, o.plan, o.txHash ?? null, o.positionId ?? null);
    }
    // Beberapa cermin, satu keputusan per aksi.
    const pick = outs.find((o) => o.verdict === 'copy') || outs.find((o) => o.verdict === 'error')
      || outs.find((o) => o.verdict === 'dry') || outs[0];
    const reason = outs.map((o) => `#${o.posId}: ${o.reason}`).join(' · ');
    return this.decide(act.id, pick.verdict, reason.slice(0, 600), pick.plan, pick.txHash ?? null, pick.positionId ?? null);
  }

  // Satu cermin untuk satu aksi keluar target. Tidak menulis keputusan — hasilnya
  // dikembalikan ke handleExit: {verdict, reason, plan, txHash, positionId, posId}.
  async exitMirror(act, rules, pos, before) {
    const out = (verdict, reason, plan = null, extra = {}) => ({ verdict, reason, plan, posId: pos.id, ...extra });
    // Target memindahkan/menjual NFT posisinya: buat kita itu sinyal keluar penuh.
    if (act.kind === 'transfer_out') {
      const poolKeyT = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
      const planT = {
        venue: pos.venue, action: 'burn', full: true, positionId: pos.id, tokenId: pos.token_id,
        liquidity: pos.liquidity, poolKey: poolKeyT, poolRef: pos.pool_ref,
        mirrorOf: act.tokenId, target: act.target,
      };
      if (!rules.exit.follow_target) return out('skip', 'ikut-keluar dimatikan');
      if (this.dryRun() || !this.exec.address()) return out('dry', 'target memindahkan posisinya', planT);
      try {
        const r = await this.executeExitRetry(planT, pos);
        this.notify(`LP ditutup: target memindahkan posisinya — ${r.note}`, {
          kind: 'exit', positionId: pos.id, txHash: r.txHash, full: true, sold: r.sold,
          target: act.target, mirrorOf: act.tokenId, reason: 'target memindahkan posisinya',
        });
        return out('copy', `target memindahkan posisinya — ${r.note}`, planT, { txHash: r.txHash, positionId: pos.id });
      } catch (e) {
        this.stats.errors++;
        return out('error', String(e.message).slice(0, 300), planT);
      }
    }

    const poolKey = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
    const d = planExit({ ...act, liquidityBefore: before }, { ...pos, poolKey }, { rules });
    if (d.verdict !== 'copy') return out('skip', d.reason);
    if (this.dryRun() || !this.exec.address()) return out('dry', d.reason, d.plan);
    try {
      const r = await this.executeExitRetry(d.plan, pos);
      this.notify(`LP ditutup: ${r.note}`, {
        kind: 'exit', positionId: pos.id, txHash: r.txHash, full: !!d.plan.full, sold: r.sold,
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
      });
      return out('copy', `${d.reason} — ${r.note}`, d.plan, { txHash: r.txHash, positionId: pos.id });
    } catch (e) {
      this.stats.errors++;
      return out('error', String(e.message).slice(0, 300), d.plan);
    }
  }

  // Alasan lewati kalau aksi masuk ini lebih tua dari loop.stale_action_seconds (bawaan
  // 300; 0 = mati), selain itu null. act.ts hanya taksiran (nomor blok × ~101 ms dari
  // blok acuan), jadi sebelum sinyal dibuang umurnya dipastikan dari timestamp blok asli.
  // Blok tidak terbaca: taksirannya dipakai — ia cenderung MENGECILKAN umur saat blok
  // melambat, bukan membesarkannya.
  async staleEntry(act) {
    const limitMs = Number(this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    if (!(limitMs > 0) || act.ts == null) return null;
    let ts = Number(act.ts);
    if (Date.now() - ts <= limitMs) return null;
    if (act.block != null) {
      try {
        const b = await this.rpc.call('eth_getBlockByNumber', ['0x' + Number(act.block).toString(16), false]);
        if (b?.timestamp) ts = parseInt(b.timestamp, 16) * 1000;
      } catch { /* pakai taksiran */ }
    }
    const age = Date.now() - ts;
    if (age <= limitMs) return null;
    return `sinyal masuk basi — target masuk ${lamanya(age)} lalu (batas ${lamanya(limitMs)}); harga & pool sudah berubah, tidak disalin`;
  }

  async refreshActionState(act) {
    for (let i = 0; i < 3 && (!act.slot0 || act.valueQuote == null); i++) {
      if (i) await new Promise((r) => setTimeout(r, 1000 * i));
      try {
        if (!act.slot0) act.slot0 = act.venue === 'v3' ? await this.chain.slot0V3(act.poolRef) : await this.chain.slot0V4(act.poolRef);
        if (act.slot0 && act.valueQuote == null && act.tickLower != null && act.tickUpper != null && act.liquidity != null) {
          const L = BigInt(act.liquidity) < 0n ? -BigInt(act.liquidity) : BigInt(act.liquidity);
          const amt = m.amountsForLiquidity(act.slot0.sqrtPriceX96, m.getSqrtRatioAtTick(act.tickLower), m.getSqrtRatioAtTick(act.tickUpper), L);
          const [t0, t1] = await this.chain.tokens([act.token0, act.token1]);
          const v = this.chain.valueInQuote({ sqrtPriceX96: act.slot0.sqrtPriceX96, ...amt, dec0: t0.decimals, dec1: t1.decimals, token0: act.token0, token1: act.token1 });
          if (v) { act.valueQuote = v.value; act.quoteSymbol = v.symbol; }
        }
      } catch { /* dicoba lagi */ }
    }
  }

  // Likuiditas sebuah posisi (milik target) di chain, sesuai venue-nya. null = tidak
  // terbaca (galat RPC sementara) — pemanggil TIDAK boleh menganggapnya nol.
  //
  // v3: dulu ikut dibaca dari PositionManager v4 dengan tokenId v3 — angka posisi v4 lain
  // (atau nol) — sehingga tarik sebagian 10% oleh target bisa jadi tutup penuh cermin
  // kita. NPM v3 me-revert positions() untuk NFT yang sudah dibakar (decrease+collect+burn
  // dalam satu multicall, pola keluar paling umum); revert sah itu = likuiditas nol.
  async targetLiquidity(venue, tokenId, block = null) {
    const read = async (tag) => {
      if (venue === 'v3') {
        const [w] = await this.rpc.ethCallMany([{ to: ADDR.npmV3, data: IF_NPM.encodeFunctionData('positions', [BigInt(tokenId)]) }], tag, { strict: true });
        if (w == null) return 0n;   // revert sah (strict melempar untuk galat lain): NFT dibakar
        if (w === '0x') return null;
        try { return BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { return null; }
      }
      const [w] = await this.rpc.ethCallMany([{ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(tokenId)]) }], tag, { strict: true });
      return w && w !== '0x' ? BigInt(w) : null;
    };
    // Blok aksi dulu; node yang belum/tidak lagi punya state blok itu melempar → `latest`.
    if (block != null && Number.isSafeInteger(Number(block)) && Number(block) > 0) {
      try {
        const L = await read('0x' + Number(block).toString(16));
        if (L != null) return { liquidity: L, atBlock: true };
      } catch { /* pakai latest */ }
    }
    const L = await read('latest');
    return L == null ? null : { liquidity: L, atBlock: false };
  }

  // Jumlah delta likuiditas aksi target lain pada NFT yang sama, di blok yang sama,
  // SESUDAH aksi ini (urutan log). State "di blok" sudah memuat semuanya.
  laterDeltasInBlock(act) {
    if (act.block == null || act.logIndex == null || act.tokenId == null) return 0n;
    const rows = this.store.all(
      "SELECT liquidity FROM actions WHERE target=? AND venue=? AND token_id=? AND block=? AND log_index>? AND kind IN ('increase','decrease') AND liquidity IS NOT NULL",
      act.target, act.venue, String(act.tokenId), act.block, act.logIndex);
    return rows.reduce((a, r) => { try { return a + BigInt(r.liquidity); } catch { return a; } }, 0n);
  }

  // poolKey posisi kita. Sumber utamanya baris DB sendiri — itu dicatat saat mint dan
  // tidak bisa hilang. Chain hanya cadangan, dan hasilnya WAJIB diperiksa: untuk NFT
  // yang sudah dibakar atau belum ada, getPoolAndPositionInfo TIDAK revert melainkan
  // mengembalikan poolKey serba nol. Nol itu lolos diam-diam ke TAKE_PAIR dan membuat
  // burn gagal dengan CurrencyNotSettled() — pesan yang sama sekali tidak menunjuk
  // ke sebabnya. Terlihat saat dry-run mencerminkan Bang GE.
  async poolKeyOf(pos) {
    if (pos.venue !== 'v4') return null;
    const ok = (pk) => pk && pk.currency1 && !/^0x0+$/i.test(pk.currency1);
    const stored = {
      currency0: pos.token0, currency1: pos.token1,
      fee: pos.fee, tickSpacing: pos.tick_spacing, hooks: pos.hooks,
    };
    if (ok(stored) && stored.fee != null && stored.tickSpacing != null) return stored;
    if (!pos.token_id) return null;
    const [w] = await this.rpc.ethCallMany([{ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(pos.token_id)]) }]);
    if (!w || w === '0x') return null;
    const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', w);
    const pk = {
      currency0: d[0].currency0, currency1: d[0].currency1,
      fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks,
    };
    return ok(pk) ? pk : null;
  }

  // ---- eksekusi -----------------------------------------------------------
  async simulateEntry(plan) {
    const tx = plan.venue === 'v3'
      ? this.exec.buildV3Mint(plan, this.exec.deadline())
      : this.exec.buildV4Mint(plan, this.exec.deadline());
    return this.exec.simulate(tx);
  }

  /**
   * Pastikan kita memegang cukup ASET KUOTASI pool ini.
   *
   * Ini yang membuat bot bisa mengikuti target ke pool berkuotasi apa pun. Di chain
   * ini 50% pool berkuotasi ETH native dan hanya 27% USDG, jadi kas yang cuma ada di
   * satu aset akan memblokir separuh peluang. Urutan yang dicoba:
   *   1. ETH native <-> WETH  : bungkus/buka bungkus, 1:1, tanpa slippage
   *   2. USDG <-> ETH         : swap lewat pool ETH/USDG terdalam
   *
   * Catatan soal hook: SEMUA pool ETH/USDG di chain ini memakai hook (dynamic fee).
   * Untuk swap itu jauh lebih aman daripada untuk LP — swap bersifat atomik dan
   * dilindungi amountOutMinimum, jadi hook tidak bisa menahan dana kita; hook pada
   * pool LP-lah yang berbahaya karena bisa memblokir penarikan. Karena itu saringan
   * "tolak hook" sengaja TIDAK diterapkan di sini.
   */
  async ensureQuoteAsset(plan, rules, needQuoteRaw) {
    const gasReserve = await this.gasReserve();
    const quoteTok = (plan.quoteSide === 0 ? plan.token0 : plan.token1).toLowerCase();
    const notes = [];
    const balOf = async (t) => {
      const b = await this.exec.balances([t]);
      let v = b.get(t.toLowerCase()) || 0n;
      if (isNative(t)) v = v > gasReserve ? v - gasReserve : 0n;
      return v;
    };

    let have = await balOf(quoteTok);
    if (have >= needQuoteRaw) return notes;

    // 1. native <-> WETH (gratis, 1:1)
    if (quoteTok === ADDR.weth) {
      const nat = await balOf(ADDR.native);
      const want = needQuoteRaw - have;
      if (nat > 0n) {
        const amt = nat < want ? nat : want;
        const h = await this.exec.send(this.exec.buildWrapEth(amt), { kind: 'wrap_eth' });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error('bungkus ETH gagal');
        notes.push(`bungkus ${(Number(amt) / 1e18).toFixed(5)} ETH`);
        have = await balOf(quoteTok);
      }
    } else if (quoteTok === ADDR.native) {
      const wr = await balOf(ADDR.weth);
      const want = needQuoteRaw - have;
      if (wr > 0n) {
        const amt = wr < want ? wr : want;
        const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth' });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error('buka bungkus WETH gagal');
        notes.push(`buka bungkus ${(Number(amt) / 1e18).toFixed(5)} WETH`);
        have = await balOf(quoteTok);
      }
    }
    if (have >= needQuoteRaw) return notes;

    // 2. jembatan USDG <-> ETH
    if (!rules.swap.enabled) throw new Error('kas ada di aset kuotasi lain dan auto-swap dimatikan');
    const wantEth = quoteTok === ADDR.native || quoteTok === ADDR.weth;
    const payTok = wantEth ? ADDR.usdg : ADDR.native;
    // Kas ETH = ETH native di atas cadangan gas + WETH. WETH baru dibuka bungkusnya
    // tepat sebelum swap (lihat unwrapFor). Dulu hanya ETH native yang dihitung, jadi
    // wallet berisi 0,07 WETH dan ETH native di bawah cadangan gagal dengan
    // "saldo ETH kosong" padahal kasnya ada.
    const payHave = wantEth ? await balOf(ADDR.usdg) : (await balOf(ADDR.native)) + (await balOf(ADDR.weth));
    const qSym = QUOTES[quoteTok]?.symbol || '?';
    const qAmt = (raw) => fmtUnits(raw, QUOTES[quoteTok]?.decimals ?? 18);
    const payName = wantEth ? 'USDG' : 'ETH+WETH';
    const payAmt = (raw) => `${fmtUnits(raw, wantEth ? 6 : 18)} ${wantEth ? 'USDG' : 'ETH'}`;
    const reserveNote = wantEth ? '' : ` di atas cadangan gas ${fmtUnits(gasReserve, 18)} ETH`;
    if (payHave <= 0n) {
      throw new Error(`kas kurang: butuh ${qAmt(needQuoteRaw)} ${qSym}, punya ${qAmt(have)} ${qSym} — saldo ${payName}${reserveNote} kosong, tidak ada kas untuk dijembatani`);
    }
    const tooShort = (pay) => new Error(
      `kas kurang untuk jembatan: butuh ${payAmt(pay)} untuk ${qAmt(needQuoteRaw - have)} ${qSym}, punya ${payAmt(payHave)}${wantEth ? '' : ` (ETH+WETH${reserveNote})`}`);
    const unwrapFor = async (pay) => {
      if (wantEth) return;
      const nat = await balOf(ADDR.native);
      if (nat >= pay) return;
      const amt = pay - nat;
      const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth' });
      if (!(await this.exec.waitReceipt(h)).ok) throw new Error('buka bungkus WETH gagal');
      notes.push(`buka bungkus ${fmtUnits(amt, 18)} WETH`);
    };
    // Butuh berapa? quoteTok WETH tetap dibeli sebagai ETH native lalu dibungkus.
    const shortEthLike = needQuoteRaw - have;
    const slipBps = rules.swap.max_slippage_bps;

    // Jalur utama: agregator Kyber. Kutipan arah BALIK (yang dibutuhkan -> yang dibayar)
    // memberi taksiran berapa yang harus dibayar untuk mendapat shortEthLike.
    const outTok = wantEth ? ADDR.native : ADDR.usdg;
    const rev = await this.kyber.quote(outTok, payTok, shortEthLike);
    if (rev && rev.amountOut > 0n) {
      let payK = (rev.amountOut * BigInt(10_000 + slipBps)) / 10_000n;
      if (payK > payHave) throw tooShort(payK);
      await unwrapFor(payK);
      const r = await this.kyber.swap(payTok, outTok, payK, {
        slippageBps: slipBps, maxLossBps: rules.swap.max_price_impact_bps, kind: 'bridge_swap', detail: { via: 'kyber', wantEth },
      });
      if (r) {
        notes.push(`${wantEth ? 'jembatan USDG→ETH' : 'jembatan ETH→USDG'} via Kyber (${r.quote.dex})`);
        return this.wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes);
      }
      this.store.log('warn', 'Kyber tidak bisa merutekan jembatan — mencoba pool langsung', { quiet: true });
    }

    // Cadangan: satu pool ETH/USDG langsung. Banyak pool ETH/USDG di chain ini menolak
    // swap lewat hook-nya, jadi jalur ini hanya dipakai kalau Kyber tidak tersedia.
    const br = await this.chain.bestEthUsdgPool();
    if (!br) throw new Error('pool jembatan ETH/USDG tidak ditemukan');
    const price = m.priceFromSqrt(br.slot0.sqrtPriceX96, 18, 6); // USDG per ETH
    const slip = 1 + rules.swap.max_slippage_bps / 10000;
    let payRaw;
    if (wantEth) payRaw = BigInt(Math.ceil((Number(shortEthLike) / 1e18) * price * 1e6 * slip));
    else payRaw = BigInt(Math.ceil((Number(shortEthLike) / 1e6 / price) * 1e18 * slip));
    if (payRaw <= 0n) return notes;
    if (payRaw > payHave) throw tooShort(payRaw);
    const zeroForOne = !wantEth;   // jual ETH(currency0) -> beli USDG
    if (rules.swap.max_price_impact_bps > 0) {
      const impact = m.priceImpactBps(br.slot0.sqrtPriceX96, br.liquidity, payRaw, zeroForOne);
      if (impact != null && impact > rules.swap.max_price_impact_bps) {
        throw new Error(`jembatan menggeser harga ${impact.toFixed(0)} bps (batas ${rules.swap.max_price_impact_bps})`);
      }
    }
    if (!zeroForOne) {
      for (const a of await this.exec.ensureRouterAllowance(ADDR.usdg)) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
    }
    await unwrapFor(payRaw);
    const minOut = (shortEthLike * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;
    const tx = this.exec.buildSwapV4(br.poolKey, zeroForOne, payRaw, minOut, this.exec.deadline());
    const h = await this.exec.send(tx, { kind: 'bridge_swap', detail: { pool: br.poolId, wantEth } });
    if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`swap jembatan gagal (${h})`);
    notes.push(wantEth ? 'jembatan USDG→ETH' : 'jembatan ETH→USDG');
    return this.wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes);
  }

  // Kalau yang dibutuhkan WETH, bungkus hasil ETH jembatan.
  async wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes) {
    if (quoteTok === ADDR.weth) {
      const nat = await balOf(ADDR.native);
      const want = needQuoteRaw - (await balOf(quoteTok));
      const amt = nat < want ? nat : want;
      if (amt > 0n) {
        const hw = await this.exec.send(this.exec.buildWrapEth(amt), { kind: 'wrap_eth' });
        if (!(await this.exec.waitReceipt(hw)).ok) throw new Error('bungkus ETH gagal');
        notes.push('bungkus ke WETH');
      }
    }
    return notes;
  }

  // Sediakan token yang kurang dengan swap dari sisi kuotasi, lalu mint.
  async executeEntry(plan, act) {
    if (this.stopping) throw new Error('bot sedang berhenti (restart) — coba lagi sebentar');
    if (this.compound?.running) throw new Error('auto-compound sedang diproses — coba lagi sebentar');
    if (plan.positionId && (this.exiting?.has(plan.positionId) || this.compound?.pending(plan.positionId))) {
      throw new Error('posisi sedang diproses — tunggu konfirmasi transaksi');
    }
    this.activeEntries = (this.activeEntries || 0) + 1;
    const trace = {};
    const waits = this.entryRetryWaits || [3000, 8000];
    try {
      // Galat sementara (RPC tumbang, node tertinggal, kutipan basi, mint revert karena
      // harga bergerak) dulu langsung membatalkan entry — dan kalau zap sudah jadi, token
      // yang baru dibeli dijual balik: kena fee pool dua kali untuk posisi yang tidak
      // pernah dibuka. Sekarang diulang dari saldo nyata. Setelah zap, langkah jembatan
      // dilewati (kas kuotasi sudah sengaja dibelanjakan) dan jumlah zap dibatasi total.
      for (let i = 0; ; i++) {
        try { return await this.sendEntry(plan, act, trace, { resume: !!(trace.zapped || trace.bridged) }); }
        catch (e) {
          if (e.pendingMint || e.priorLanded || trace.minted || i >= waits.length || this.stopping || !Engine.retryableEntry(e)) throw e;
          // Tx yang tadi dianggap tidak masuk ternyata masuk: jangan kirim ulang apa pun.
          if (e.txHash && this.exec.txLanded && await this.exec.txLanded(e.txHash, 2)) throw e;
          this.store?.log?.('warn', `entry ${plan.poolRef ? String(plan.poolRef).slice(0, 10) + '…' : ''} gagal (${String(e.message).slice(0, 160)}) — coba lagi dalam ${waits[i] / 1000} dtk (${i + 2}/${waits.length + 1})`, { quiet: true });
          await new Promise((r) => setTimeout(r, waits[i]));
        }
      }
    } catch (e) {
      // Zap sudah jadi tapi LP-nya tetap gagal: token yang terbeli jangan ditinggal
      // telanjang di wallet — masuk antrean jual, seperti sisa posisi. Rescue gagal tidak
      // boleh menutupi galat aslinya. Mint yang mungkin masih masuk (pendingMint) atau tx
      // lama yang ternyata masuk (priorLanded): tokennya mungkin sudah di dalam posisi.
      if (trace.zapped && !e.pendingMint && !e.priorLanded && !trace.minted) await this.rescueZap(plan, trace.zapped, e).catch((x) => this.store?.log?.('warn', `antrekan token zap gagal: ${x.message}`, { quiet: true }));
      throw e;
    }
    finally { this.activeEntries--; }
  }

  // Galat entry yang TIDAK layak diulang: keputusan/batas pengguna, kas yang memang
  // kurang, pengaman Kyber, dan tx yang mungkin masih masuk. Selain itu (RPC, revert
  // estimasi/mint, kutipan basi, harga bergerak) diulang.
  static retryableEntry(e) {
    return !/dimatikan|kas kurang|saldo kurang|satu sisi|rugi|dampak harga|menggeser harga|sedang diproses|auto-compound|insufficient funds|tidak ditemukan|tidak cocok|janggal|menyimpang|simulasi|kunci privat|dibatalkan|belum terkonfirmasi|tidak cukup untuk membuka/i.test(String(e?.message || ''));
  }

  async rescueZap(plan, z, err) {
    const token = String(z.token).toLowerCase();
    // Aset kuotasi (USDG/ETH/WETH) itu kas, bukan sisa — dan menjualnya "ke" memecoin
    // pembayar zap justru membeli memecoin lagi.
    if (QUOTES[token] || isNative(token)) return;
    const bal = (await this.exec.balances([token])).get(token) || 0n;
    const gained = bal > BigInt(z.before ?? 0) ? bal - BigInt(z.before ?? 0) : 0n;
    if (gained === 0n) return;
    const meta = await this.chain.token(token).catch(() => null);
    // Item sapuan/zap lain untuk token yang sama (posId null) DITAMBAH, bukan ditimpa:
    // dua entry gagal berturut-turut di token yang sama dulu menyisakan separuhnya.
    // `before` sudah memuat saldo item lama, jadi yang ditambahkan hanya hasil zap ini.
    const old = this.leftovers().find((x) => (x.posId ?? null) === null && x.token === token);
    const amount = gained + (old ? BigInt(old.amount || '0') : 0n);
    this.keepLeftover({ posId: null, target: plan.target ?? null, token, quote: z.quote, amount: amount.toString(), tries: 0,
      since: Date.now(), source: 'zap' }, `LP gagal setelah zap: ${err.message}`);
    this.markZapsRescued(z.hashes);
    this.store.log('warn', `LP gagal setelah zap — ${fmtUnits(gained, meta?.decimals ?? 18)} ${meta?.symbol || token.slice(0, 8)} masuk antrean jual`);
  }

  // Tandai tx zap sudah ditangani supaya pemulihan zap yatim (recoverStrandedZaps) tidak
  // mengantrekannya lagi.
  markZapsRescued(hashes) {
    for (const h of hashes || []) {
      const row = this.store?.get?.('SELECT detail FROM txs WHERE hash=?', h);
      if (!row) continue;
      let d = {}; try { d = JSON.parse(row.detail || '{}'); } catch { /* detail lama */ }
      d.handled = true;
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(d), h);
    }
  }

  // Zap yatim: token sudah dibeli untuk sebuah entry, tapi entry-nya tidak pernah sampai
  // mint DAN tidak pernah diselamatkan — proses di-restart/mati di tengah (pm2 restart
  // saat deploy memberi 1,6 detik sebelum SIGKILL), atau receipt zap baru terbaca setelah
  // entry menyerah. Tanpa ini tokennya duduk di wallet selamanya. Dicek tiap sinkron.
  async recoverStrandedZaps({ minAgeMs = 5 * 60_000 } = {}) {
    if (!this.exec.address() || (this.activeEntries || 0) > 0) return 0;
    const me = this.exec.address().toLowerCase();
    const rows = this.store.all("SELECT hash, ts, status, detail FROM txs WHERE kind='zap_swap' AND status != 'gagal' AND ts > ? AND ts < ? ORDER BY ts",
      Date.now() - 24 * 3600_000, Date.now() - minAgeMs);
    let n = 0;
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail || '{}'); } catch { continue; }
      if (d.handled || !d.buy || !d.pool) continue;
      const buy = String(d.buy).toLowerCase();
      if (QUOTES[buy] || isNative(buy)) { this.markZapsRescued([r.hash]); continue; }
      // Entry-nya sampai mint/increase di pool yang sama sesudah zap ini (yang revert tidak
      // dihitung: token zap-nya diselamatkan alur masuk atau bookPendingMints — keduanya
      // menandai zap ini `handled`; kalau prosesnya mati sebelum itu, di sinilah diurus).
      const minted = this.store.all("SELECT detail FROM txs WHERE kind IN ('mint','increase') AND status != 'gagal' AND ts >= ?", r.ts)
        .some((x) => { try { return String(JSON.parse(x.detail || '{}').pool).toLowerCase() === String(d.pool).toLowerCase(); } catch { return false; } });
      if (minted) { this.markZapsRescued([r.hash]); continue; }
      let rc = null;
      try { rc = await this.rpc.call('eth_getTransactionReceipt', [r.hash]); } catch { continue; }
      if (!rc) {
        if (Date.now() - r.ts > 30 * 60_000) { this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", r.hash); }
        continue;
      }
      if (BigInt(rc.status) !== 1n) { this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", r.hash); continue; }
      const bought = await this.receivedIn(rc, buy, me).catch(() => 0n);
      if (bought > 0n) {
        const bal = (await this.exec.balances([buy])).get(buy) || 0n;
        const amt = bal < bought ? bal : bought;
        if (amt > 0n) {
          const old = this.leftovers().find((x) => (x.posId ?? null) === null && x.token === buy);
          const total = amt + (old ? BigInt(old.amount || '0') : 0n);
          this.keepLeftover({ posId: null, target: d.target ?? null, token: buy, quote: String(d.pay || ADDR.usdg).toLowerCase(), amount: total.toString(), tries: 0,
            since: Date.now(), source: 'zap' }, 'zap tanpa LP (entry terputus) — dijual balik');
          const meta = await this.chain.token(buy).catch(() => null);
          this.store.log('warn', `zap ${r.hash.slice(0, 12)}… tidak pernah jadi LP — ${fmtUnits(amt, meta?.decimals ?? 18)} ${meta?.symbol || buy.slice(0, 8)} masuk antrean jual`);
          n++;
        }
      }
      this.markZapsRescued([r.hash]);
    }
    return n;
  }

  async sendEntry(plan, act, trace = {}, { resume = false } = {}) {
    const rules = this.rulesFrom(act.target);
    const pk = plan.poolKey;
    const need0 = BigInt(plan.amount0Max), need1 = BigInt(plan.amount1Max);
    const gasReserve = await this.gasReserve();
    const notes = [];
    await this.topUpGas(notes);

    let bal = await this.exec.balances([plan.token0, plan.token1]);
    const avail = (t) => {
      let b = bal.get(t.toLowerCase()) || 0n;
      if (isNative(t)) b = b > gasReserve ? b - gasReserve : 0n;
      return b;
    };

    // 0. Pastikan kas sudah ada di aset kuotasi pool INI (bisa beda dari kas kita).
    //    Dilewati saat mengulang SETELAH zap: kas kuotasi sudah sengaja dibelanjakan untuk
    //    token pasangan, dan menjembatani lagi berarti menukar kas yang tidak dibutuhkan.
    if (!resume && plan.quoteSide != null && !(avail(plan.token0) >= need0 && avail(plan.token1) >= need1)) {
      const qTok = plan.quoteSide === 0 ? plan.token0 : plan.token1;
      const qMeta = await this.chain.token(qTok);
      const needQuoteRaw = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** (qMeta?.decimals ?? 18)));
      if (needQuoteRaw > 0n) {
        const bridged = await this.ensureQuoteAsset(plan, rules, needQuoteRaw);
        // Jembatan hanya SEKALI per entry. Kalau percobaan ini gagal sesudahnya, percobaan
        // ulang memakai kas yang sudah ada — tanpa ini, kas yang "hilang" ke dalam cadangan
        // gas (cadangan dinamis melonjak) membuat setiap percobaan menukar USDG lagi.
        if (bridged.length) trace.bridged = true;
        notes.push(...bridged);
        bal = await this.exec.balances([plan.token0, plan.token1]);
      }
    }

    const sa = m.getSqrtRatioAtTick(plan.tickLower), sb = m.getSqrtRatioAtTick(plan.tickUpper);
    const toksNow = await this.chain.tokens([plan.token0, plan.token1]);
    let s2, desiredL = BigInt(plan.liquidity);
    const refreshNeeds = async () => {
      s2 = plan.venue === 'v3'
        ? await this.chain.slot0V3(plan.poolRef)
        : await this.chain.slot0V4(plan.poolRef);
      if (!s2 || s2.sqrtPriceX96 <= 0n) throw new Error('gagal membaca harga pool dari RPC');
      if (plan.singleSide && ((plan.singleSide === 'token0' && s2.sqrtPriceX96 > sa)
        || (plan.singleSide === 'token1' && s2.sqrtPriceX96 < sb))) {
        throw new Error('harga sudah masuk rentang satu sisi — buat pratinjau baru sebelum membuka LP');
      }
      let amounts = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, desiredL);
      if (plan.valueUsd > 0) {
        const value = this.chain.valueInQuote({
          sqrtPriceX96: s2.sqrtPriceX96, ...amounts,
          dec0: toksNow[0].decimals, dec1: toksNow[1].decimals,
          token0: plan.token0, token1: plan.token1,
        });
        const usd = value ? quoteToUsd(value.value, value.kind, this.ethUsd) : 0;
        if (!(usd > 0) || !Number.isFinite(usd)) throw new Error('gagal menghitung nilai posisi pada harga terbaru');
        if (usd > plan.valueUsd) {
          desiredL = desiredL * BigInt(Math.floor(plan.valueUsd * 1e6)) / BigInt(Math.ceil(usd * 1e6));
          amounts = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, desiredL);
        }
      }
      return amounts;
    };

    // Hitung ulang setelah bridge DAN setiap zap. Maksimal dua swap per percobaan (tiga
    // sepanjang semua percobaan) agar harga bergerak tidak membuat bot terus membeli/
    // menjual bolak-balik. Kalau batas itu tercapai tapi saldo sudah cukup untuk
    // setidaknya separuh ukuran, posisinya dibuka lebih kecil — menjual balik token zap
    // berarti membayar fee pool dua kali untuk posisi yang tidak pernah ada.
    for (let swaps = 0; ; swaps++) {
      const needs = await refreshNeeds();
      const idx = avail(plan.token0) < needs.amount0 ? 0 : avail(plan.token1) < needs.amount1 ? 1 : null;
      if (idx == null) break;
      const affordableNow = m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1));
      const zapsSoFar = trace.zaps || 0;
      if ((swaps > 0 || zapsSoFar > 0) && affordableNow * 100n >= desiredL * 95n) break;
      if (swaps >= 2 || zapsSoFar >= 3) {
        if (zapsSoFar > 0 && affordableNow * 2n >= desiredL) { notes.push('harga bergerak saat zap — dibuka sebesar saldo'); break; }
        throw new Error('harga berubah setelah swap; kebutuhan token belum terpenuhi — LP belum dibuka, dana tetap di wallet');
      }
      const tok = idx === 0 ? plan.token0 : plan.token1;
      const need = idx === 0 ? needs.amount0 : needs.amount1;
      const have = avail(tok);
      const short = need - have;
      if (!rules.swap.enabled) throw new Error(`kurang ${short} unit token${idx} dan auto-swap dimatikan`);
      const payTok = idx === 0 ? plan.token1 : plan.token0;
      const payHave = avail(payTok);
      // taksir berapa yang harus dibayar, pakai harga pool + slippage
      const s = s2;
      const price1per0 = Number(s.sqrtPriceX96) ** 2 / Number(m.Q96) ** 2; // mentah, tanpa desimal
      const payRaw = idx === 0
        ? BigInt(Math.ceil(Number(short) * price1per0 * (1 + rules.swap.max_slippage_bps / 10000)))
        : BigInt(Math.ceil((Number(short) / price1per0) * (1 + rules.swap.max_slippage_bps / 10000)));
      if (payRaw <= 0n) continue;
      if (payHave < payRaw) {
        // Sesudah zap: sisa token pembayar habis karena fee/slippage zap sebelumnya. Kalau
        // yang ada sudah cukup untuk separuh ukuran, buka sebesar itu (ukuran dipangkas di
        // bawah) daripada membatalkan dan menjual balik.
        if (zapsSoFar > 0 && affordableNow * 2n >= desiredL) { notes.push('saldo pas-pasan setelah zap — dibuka sebesar saldo'); break; }
        throw new Error(`saldo kurang untuk zap: butuh ~${payRaw} unit ${payTok.slice(0, 8)}…, punya ${payHave}`);
      }
      // Jalur utama: Kyber (rute terbaik lintas pool; banyak pool menolak swap langsung).
      const buyTok = idx === 0 ? plan.token0 : plan.token1;
      // Batas rugi zap ikut memperhitungkan FEE POOL-nya sendiri. Pool memecoin di chain
      // ini berfee 4–10%, jadi membeli tokennya memang tidak mungkin lebih murah dari
      // fee itu; batas kaku 5% membuat pool berfee 4,2% selalu ditolak padahal wajar.
      // Untuk pool fee dinamis (bendera 0x800000) besarannya tidak diketahui di muka,
      // jadi tetap memakai batas yang disetel pengguna.
      const feeBps = plan.fee != null && plan.fee < 1_000_000 ? plan.fee / 100 : null;
      const zapLossBps = feeBps != null
        ? Math.max(rules.swap.max_price_impact_bps, Math.round(feeBps) + 200)
        : rules.swap.max_price_impact_bps;
      // Saldo token beli SEBELUM zap: kalau LP-nya gagal sesudah ini, hanya yang
      // terbeli di sini yang diantrekan untuk dijual (rescueZap), bukan saldo lama.
      const boughtBefore = bal.get(buyTok.toLowerCase()) || 0n;
      // Jurnal zap di tabel txs: kalau proses mati sebelum mint, recoverStrandedZaps
      // tahu token apa yang dibeli, dibayar dengan apa, dan untuk pool mana.
      const zapDetail = { pool: plan.poolRef, buy: buyTok.toLowerCase(), pay: payTok.toLowerCase(), target: plan.target ?? null };
      const noteZap = (hash) => {
        trace.zaps = (trace.zaps || 0) + 1;
        const z = trace.zapped || { token: buyTok.toLowerCase(), quote: payTok, before: boughtBefore, hashes: [] };
        if (hash) z.hashes = [...(z.hashes || []), hash];
        trace.zapped = z;
      };
      let kz;
      try {
        kz = await this.kyber.swap(payTok, buyTok, payRaw, {
          slippageBps: rules.swap.max_slippage_bps, maxLossBps: zapLossBps,
          kind: 'zap_swap', detail: { via: 'kyber', ...zapDetail },
        });
      } catch (e) {
        // Receipt zap belum terbaca: tokennya mungkin tetap masuk — jangan zap lagi di
        // percobaan berikutnya tanpa tahu; pemulihan zap yatim yang mengurusnya.
        if (e.pending) e.message = `${e.message} — entry dihentikan, zap diurus belakangan`;
        throw e;
      }
      if (kz) {
        notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'} via Kyber`);
        noteZap(kz.hash);
        bal = await this.exec.balances([plan.token0, plan.token1]);
        continue;
      }
      for (const a of await this.exec.ensureRouterAllowance(payTok)) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
      // Cadangan: swap langsung ke pool. Pool posisi ini belum tentu tempat terbaik
      // menukar — pemilihnya menilai semua pool berpasangan sama (fee + dampak harga)
      // lalu menyimulasikannya, jadi pool tipis dan pool yang menolak swap tersingkir
      // sebelum gas keluar. Batas dampak harga yang berlaku tetap yang di Aturan:
      // itu yang menjaga "auto-swap" tidak berubah jadi menabrak pool tipis.
      const minOut = (short * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;
      const info = {};
      const pick = await pickSwapPool({ store: this.store, chain: this.chain, rpc: this.rpc, exec: this.exec, log: this.log }, {
        tokenIn: payTok, tokenOut: buyTok, amountIn: payRaw, minOut,
        maxImpactBps: rules.swap.max_price_impact_bps, deadlineSec: this.exec.deadline(), info,
        extra: [{
          pool_ref: plan.poolRef, venue: plan.venue, token0: plan.token0, token1: plan.token1,
          fee: plan.fee, tick_spacing: plan.tickSpacing ?? pk?.tickSpacing ?? null,
          hooks: plan.poolKey?.hooks ?? pk?.hooks ?? null, pool_addr: plan.venue === 'v3' ? plan.poolRef : null,
        }],
      });
      if (!pick) throw new Error(`zap lewat pool langsung tidak bisa: ${info.reason}`);
      if (pick.pool.pool_ref !== plan.poolRef) {
        this.log(`zap lewat pool lain ${pick.pool.pool_ref.slice(0, 10)}… (fee ${(pick.feePpm / 10000).toFixed(2)}%`
          + `${pick.impactBps != null ? `, dampak ~${Math.round(pick.impactBps)} bps` : ''}) — terbaik dari ${info.scored} pool berpasangan sama`);
      }
      const h = await this.exec.send(pick.tx, { kind: 'zap_swap', detail: { ...zapDetail, via: pick.pool.pool_ref, payRaw: payRaw.toString() } });
      const rc = await this.exec.waitReceipt(h, 90_000);
      if (rc.timeout) throw new Error(`swap zap ${h} belum terkonfirmasi setelah 90 detik — entry dihentikan, zap diurus belakangan`);
      if (!rc.ok) throw new Error(`swap zap gagal (${h})`);
      notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'}`);
      noteZap(h);
      bal = await this.exec.balances([plan.token0, plan.token1]);
    }

    // 2. sesuaikan L dengan saldo nyata setelah swap (lebih aman dari slippage)
    const affordable = m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1));
    let L = desiredL;
    if (affordable < L) { L = (affordable * 99n) / 100n; notes.push('ukuran dipangkas ke saldo nyata'); }
    if (L <= 0n) throw new Error('saldo token pool tidak mencukupi pada harga terbaru — LP belum dibuka, dana tetap di wallet');
    let amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);

    // Batas per posisi dikunci ULANG di harga terkini. Harga bergerak antara saat
    // rencana dibuat dan saat mint — termasuk karena zap kita sendiri — sehingga
    // likuiditas yang sama bisa bernilai lebih dari batas yang diminta (terlihat
    // $204,96 untuk batas $200 saat dry-run). Batas nominal harus ditepati.
    if (plan.valueUsd > 0) {
      const toksNow = await this.chain.tokens([plan.token0, plan.token1]);
      const vNow = this.chain.valueInQuote({
        sqrtPriceX96: s2.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1,
        dec0: toksNow[0].decimals, dec1: toksNow[1].decimals, token0: plan.token0, token1: plan.token1,
      });
      const usdNow = vNow ? quoteToUsd(vNow.value, vNow.kind, this.ethUsd) : 0;
      if (usdNow > plan.valueUsd * 1.005) {
        L = (L * BigInt(Math.round(plan.valueUsd * 1e6))) / BigInt(Math.round(usdNow * 1e6));
        amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);
        notes.push(`disesuaikan ulang ke batas $${plan.valueUsd.toFixed(0)}`);
      }
    }
    const slip = BigInt(rules.swap.max_slippage_bps);
    const finalPlan = {
      ...plan, liquidity: L.toString(),
      amount0Max: ((amt.amount0 * (10000n + slip)) / 10000n).toString(),
      amount1Max: ((amt.amount1 * (10000n + slip)) / 10000n).toString(),
    };

    // 3. izin + mint
    for (const tok of [plan.token0, plan.token1]) {
      if (BigInt(tok === plan.token0 ? finalPlan.amount0Max : finalPlan.amount1Max) === 0n) continue;
      for (const a of await this.exec.ensureAllowance(tok, { forV4: plan.venue !== 'v3' })) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
    }
    // Approval bisa memakan beberapa blok. Jangan kirim mint dengan kebutuhan
    // token lama setelah harga berubah selama menunggu receipt approval.
    await refreshNeeds();
    bal = await this.exec.balances([plan.token0, plan.token1]);
    // Harga bergerak selama menunggu approval (termasuk akibat zap kita sendiri).
    // Dulu ini MEMBATALKAN mint — padahal token hasil zap sudah di wallet dan dibiarkan
    // telanjang (lpcopy2: $26 PAIREX ditinggal, terpaksa dijual manual). Ukurannya
    // disesuaikan ulang ke saldo nyata dan batas nilai pada harga saat mint (approval
    // tak terbatas, jadi aman); batal hanya kalau memang tidak tersisa apa-apa.
    const fitL = (m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1)) * 99n) / 100n;
    if (fitL < L || desiredL < L) {
      L = fitL < desiredL ? fitL : desiredL;
      notes.push('ukuran disesuaikan ke harga saat mint');
    }
    if (L <= 0n) throw new Error('saldo token pool tidak mencukupi pada harga saat mint — LP belum dibuka, token hasil zap tetap di wallet');
    amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);
    finalPlan.liquidity = L.toString();
    // Batas atas token TIDAK BOLEH melebihi saldo nyata. Di Uniswap v3 amountDesired
    // bukan batas melainkan jumlah yang DISETOR: NPM menghitung likuiditas dari angka itu
    // lalu menarik sebanyak itu. Dengan ukuran 99% saldo dan ruang slippage 1,5%, mint v3
    // menarik 100,5% saldo → revert "STF" (empat entry v3 11–12 Sep, semuanya sesudah zap).
    // Di v4 ini cuma batas, jadi mengapitnya ke saldo tidak mengubah apa pun selain
    // menolak lebih awal kalau memang kurang.
    const capBal = (x, t) => { const a = avail(t); return x > a ? a : x; };
    finalPlan.amount0Max = capBal((amt.amount0 * (10000n + slip)) / 10000n, plan.token0).toString();
    finalPlan.amount1Max = capBal((amt.amount1 * (10000n + slip)) / 10000n, plan.token1).toString();
    const adding = plan.action === 'increase' && plan.tokenId;
    const tx = adding
      ? (plan.venue === 'v3'
        ? this.exec.buildV3Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline())
        : this.exec.buildV4Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline()))
      : (plan.venue === 'v3'
        ? this.exec.buildV3Mint({ ...finalPlan, amount0Min: 0, amount1Min: 0 }, this.exec.deadline())
        : this.exec.buildV4Mint(finalPlan, this.exec.deadline()));
    // Rencana ikut disimpan di tabel txs: kalau receipt-nya gagal dibaca (RPC tumbang,
    // lewat batas tunggu), bookPendingMints membukukan posisinya belakangan dari receipt —
    // lengkap dengan tautan ke target, bukan cuma "diadopsi" tanpa asal-usul.
    const hash = await this.exec.send(tx, { kind: adding ? 'increase' : 'mint', detail: {
      pool: plan.poolRef, target: plan.target, venue: plan.venue,
      plan: Engine.planForBooking(finalPlan), zapped: trace.zapped ? { ...trace.zapped, before: String(trace.zapped.before) } : null,
    } });
    trace.mintSent = hash;
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) {
      const e = new Error(`mint ${hash} belum terkonfirmasi setelah 90 detik — posisinya dibukukan otomatis begitu receipt terbaca`);
      e.pendingMint = true;   // jangan jual token zap: mint-nya mungkin sedang masuk
      throw e;
    }
    if (!rc.ok) throw new Error(`mint gagal (${hash})`);
    // Mint SUDAH jadi di chain: galat apa pun sesudah ini (pembukuan) tidak boleh memicu
    // mint kedua atau penjualan token zap — bookPendingMints membukukannya belakangan.
    trace.minted = hash;
    try { return await this.recordEntry(finalPlan, hash, rc.receipt, { amt, sqrt: s2, notes }); }
    catch (e) { e.pendingMint = true; e.message = `mint ${hash} berhasil tetapi pembukuan tertunda: ${e.message}`; throw e; }
  }

  // Bagian rencana yang cukup untuk membukukan posisi belakangan (JSON polos, tanpa BigInt).
  static planForBooking(p) {
    const keep = ['venue', 'action', 'poolRef', 'poolKey', 'token0', 'token1', 'fee', 'tickSpacing', 'hooks', 'tickLower', 'tickUpper',
      'liquidity', 'amount0Max', 'amount1Max', 'valueQuote', 'valueUsd', 'quoteSymbol', 'quoteKind', 'quoteSide', 'target', 'mirrorOf', 'tokenId', 'positionId', 'singleSide'];
    const out = {};
    for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
    return JSON.parse(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  // Pembukuan sesudah mint/increase terkonfirmasi. `amt`/`sqrt` dari alur masuk kalau
  // ada; kalau dibukukan belakangan (bookPendingMints) modalnya dibaca dari receipt —
  // token yang benar-benar keluar dari wallet — dan harga masuknya dari pool saat ini.
  async recordEntry(plan, hash, receipt, { amt = null, sqrt = null, notes = [] } = {}) {
    const adding = plan.action === 'increase' && plan.tokenId;
    const L = BigInt(plan.liquidity);
    const me = this.exec.address().toLowerCase();
    if (!amt) {
      const spent = async (tok, max) => {
        try { return await this.spentIn(receipt, tok, me); }
        catch { return BigInt(max || '0'); }   // ETH native tak terisolasi: taksiran batas rencana
      };
      amt = { amount0: await spent(plan.token0, plan.amount0Max), amount1: await spent(plan.token1, plan.amount1Max) };
    }
    if (!sqrt) sqrt = plan.venue === 'v3' ? await this.chain.slot0V3(plan.poolRef) : await this.chain.slot0V4(plan.poolRef);
    const s2 = sqrt;

    // 4. tokenId dari log Transfer (0x0 -> kita)
    let tokenId = null;
    for (const l of receipt.logs || []) {
      const mgr = plan.venue === 'v3' ? ADDR.npmV3 : ADDR.posmV4;
      if (l.address.toLowerCase() === mgr && l.topics[0] === TOPIC.transfer
        && asAddr(l.topics[1]) === '0x0000000000000000000000000000000000000000'
        && asAddr(l.topics[2]) === me) tokenId = BigInt(l.topics[3]).toString();
    }
    const toks = await this.chain.tokens([plan.token0, plan.token1]);
    const v = s2 && this.chain.valueInQuote({
      sqrtPriceX96: s2.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1,
      dec0: toks[0].decimals, dec1: toks[1].decimals, token0: plan.token0, token1: plan.token1,
    });
    // Idempoten: posisi dengan tokenId ini sudah tercatat (diadopsi lebih dulu, atau
    // pembukuan sebelumnya terputus setelah menulis baris) — jangan buat baris kedua.
    const dup = !adding && tokenId && this.store?.get?.('SELECT id FROM positions WHERE venue=? AND token_id=?', plan.venue, tokenId);
    if (dup) {
      const trow0 = this.store.get('SELECT detail FROM txs WHERE hash=?', hash);
      if (trow0) { let d = {}; try { d = JSON.parse(trow0.detail || '{}'); } catch { /* detail lama */ } d.recorded = dup.id; this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(d), hash); }
      if (plan.target) this.store.run('UPDATE positions SET target=COALESCE(target,?), mirror_of=COALESCE(mirror_of,?), tx_open=COALESCE(tx_open,?) WHERE id=?', plan.target, plan.mirrorOf ?? null, hash, dup.id);
      const pairD = `${toks[0].symbol}/${toks[1].symbol}`;
      const usdD = quoteToUsd(v?.value ?? 0, v?.kind || 'usd', this.ethUsd);
      return { txHash: hash, positionId: dup.id, adding: false, pair: pairD, valueUsd: usdD, curTick: s2?.tick ?? null, steps: notes,
        note: `${pairD} $${usdD.toFixed(2)} (sudah tercatat #${dup.id})` };
    }
    if (adding) {
      // Modal DITAMBAHKAN, bukan ditimpa: kalau tidak, tambahan modal terbaca
      // sebagai keuntungan gratis dan baseline IL ikut ter-reset.
      const prev = this.store.get('SELECT liquidity, cost0, cost1 FROM positions WHERE id=?', plan.positionId)
        || { liquidity: '0', cost0: '0', cost1: '0' };
      this.store.run(
        'UPDATE positions SET liquidity=?, cost0=?, cost1=?, cost_quote=COALESCE(cost_quote,0)+? WHERE id=?',
        (L + BigInt(prev.liquidity || '0')).toString(),
        (amt.amount0 + BigInt(prev.cost0 || '0')).toString(),
        (amt.amount1 + BigInt(prev.cost1 || '0')).toString(),
        v?.value ?? 0, plan.positionId);
    }
    const positionId = adding ? plan.positionId : this.positions.record(plan, {
      tokenId, txHash: hash, target: plan.target,
      cost0: amt.amount0.toString(), cost1: amt.amount1.toString(), costQuote: v?.value ?? plan.valueQuote,
      entrySqrt: s2?.sqrtPriceX96 ?? null,
    });
    // Penanda "sudah dibukukan" di tabel txs — bookPendingMints tidak mengulanginya.
    const trow = this.store?.get?.('SELECT detail FROM txs WHERE hash=?', hash);
    if (trow) { let d = {}; try { d = JSON.parse(trow.detail || '{}'); } catch { /* detail lama */ } d.recorded = positionId; this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(d), hash); }
    const pair = `${toks[0].symbol}/${toks[1].symbol}`;
    // v.value dinyatakan dalam aset kuotasi pool (bisa ETH), BUKAN dolar — dulu dicetak
    // langsung dengan "$" sehingga posisi 0,079 ETH terbaca "$0,08" alih-alih ~$195.
    const usdVal = quoteToUsd(v?.value ?? 0, v?.kind || 'usd', this.ethUsd);
    return {
      txHash: hash, positionId, adding: !!adding, pair, valueUsd: usdVal, curTick: s2?.tick ?? null, steps: notes,
      note: `${adding ? 'tambah ' : ''}${pair} $${usdVal.toFixed(2)}${notes.length ? ' (' + notes.join(', ') + ')' : ''}`,
    };
  }

  pendingFeeClaim(id) {
    return this.store.get(`SELECT t.* FROM txs t LEFT JOIN fee_claims f ON f.tx_hash=t.hash
      WHERE t.kind='claim_fees' AND t.status!='gagal' AND f.tx_hash IS NULL
      AND json_extract(t.detail,'$.position')=? ORDER BY t.ts LIMIT 1`, id);
  }

  async claimFees(id) {
    if (this.dryRun() || !this.exec.address()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (this.exiting.has(id)) throw new Error('posisi ini sedang diproses');
    if (this.compound?.pending(id)) throw new Error('compound sebelumnya belum selesai — tunggu konfirmasi');
    const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", id);
    if (!pos || pos.token_id == null) throw new Error('posisi tidak ditemukan');
    if (!['v3', 'v4'].includes(pos.venue)) throw new Error('venue posisi tidak didukung');
    this.exiting.add(id);
    try {
      // Sesudah timeout/restart, selesaikan transaksi lama dahulu. Jangan kirim ulang.
      const pending = this.pendingFeeClaim(id);
      let hash = pending?.hash;
      if (!hash) {
        const iface = new ethers.Interface(pos.venue === 'v3' ? ABI.npmV3 : ABI.posmV4);
        const [ownerData] = await this.rpc.ethCallMany([{ to: pos.venue === 'v3' ? ADDR.npmV3 : ADDR.posmV4,
          data: iface.encodeFunctionData('ownerOf', [pos.token_id]) }]);
        const owner = iface.decodeFunctionResult('ownerOf', ownerData)[0].toLowerCase();
        if (owner !== this.exec.address().toLowerCase()) throw new Error('NFT posisi bukan milik wallet bot');
        await this.topUpGas([]);
        const poolKey = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
        if (pos.venue === 'v4' && !poolKey) throw new Error('poolKey posisi tidak terbaca');
        const plan = { tokenId: pos.token_id, poolKey };
        const tx = pos.venue === 'v4' ? this.exec.buildV4Collect(plan, this.exec.deadline()) : this.exec.buildV3Collect(plan);
        hash = await this.exec.send(tx, { kind: 'claim_fees', detail: { position: id, wallet: owner } });
      }
      const rc = await this.exec.waitReceipt(hash, 90_000);
      if (rc.timeout) return { ok: false, pending: true, tx: hash };
      if (!rc.ok) throw new Error(`claim fee revert (${hash})`);
      let result;
      try { result = await this.recordFeeClaim(pos, hash, rc.receipt); }
      catch (e) {
        this.store.log('warn', `claim fee ${hash} berhasil, pencatatan menunggu: ${e.message}`, { quiet: true });
        return { ok: true, tx: hash, accountingPending: true };
      }
      try { await this.positions.sync(this.ethUsd); } catch { /* sinkron berikutnya mencoba lagi */ }
      return { ok: true, tx: hash, ...result };
    } finally { this.exiting.delete(id); }
  }

  // Berapa `token` yang BERSIH masuk ke `owner` pada transaksi ini, dibaca dari
  // receipt-nya — bukan dari selisih saldo "sebelum/sesudah", yang bisa nol kalau RPC
  // yang dibaca masih tertinggal satu blok, atau tercemar tx lain di antaranya.
  async receivedIn(receipt, token, owner) {
    const v = await this.netFlow(receipt, token, owner);
    return v > 0n ? v : 0n;
  }

  // Berapa `token` yang BERSIH keluar dari `owner` pada transaksi ini (modal mint).
  async spentIn(receipt, token, owner) {
    const v = await this.netFlow(receipt, token, owner);
    return v < 0n ? -v : 0n;
  }

  // Arus bersih `token` ke `owner` di transaksi ini: positif = masuk, negatif = keluar.
  async netFlow(receipt, token, owner) {
    if (!isNative(token)) {
      let value = 0n;
      for (const l of receipt.logs || []) {
        if (l.address.toLowerCase() !== token.toLowerCase() || l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
        if (asAddr(l.topics[2]) === owner) value += BigInt(l.data);
        if (asAddr(l.topics[1]) === owner) value -= BigInt(l.data);
      }
      return value;
    }
    // ETH native tidak punya Transfer. Baca saldo historis di blok receipt
    // agar retry setelah timeout tidak menghitung aktivitas wallet di blok lain.
    const hash = receipt.transactionHash || receipt.hash;
    const bn = BigInt(receipt.blockNumber);
    const before = BigInt(await this.rpc.call('eth_getBalance', [owner, ethers.toQuantity(bn - 1n)]));
    const after = BigInt(await this.rpc.call('eth_getBalance', [owner, ethers.toQuantity(bn)]));
    const block = await this.rpc.call('eth_getBlockByNumber', [ethers.toQuantity(bn), true]);
    const others = (block?.transactions || []).filter((t) => t.hash !== hash
      && (String(t.from).toLowerCase() === owner || String(t.to).toLowerCase() === owner));
    if (!block || others.length) throw new Error('saldo ETH pada blok transaksi tidak dapat diisolasi');
    return after - before + BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
  }

  async recordFeeClaim(pos, hash, receipt) {
    if (this.store.get('SELECT tx_hash FROM fee_claims WHERE tx_hash=?', hash)) return {};
    const detail = JSON.parse(this.store.get('SELECT detail FROM txs WHERE hash=?', hash)?.detail || '{}');
    const owner = String(detail.wallet || this.exec.address()).toLowerCase();
    const amount = (token) => this.receivedIn(receipt, token, owner);
    const amount0 = await amount(pos.token0), amount1 = await amount(pos.token1);
    // harga penilai, bukan harga pool mentah: pool yang disapu kosong menaruh harga di batas
    const slot = await this.positions.markSlotFor(pos);
    const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
    const value = slot && this.chain.valueInQuote({ sqrtPriceX96: slot.sqrtPriceX96, amount0, amount1,
      dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 });
    if (!value) throw new Error('nilai fee belum terbaca');
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.store.run('INSERT OR IGNORE INTO fee_claims(tx_hash,position_id,ts,amount0,amount1,value_quote) VALUES(?,?,?,?,?,?)',
        hash, pos.id, Date.now(), String(amount0), String(amount1), value.value);
      if (Number(r.changes)) this.store.run(`UPDATE positions SET claimed_quote=COALESCE(claimed_quote,0)+?,
        out_quote=out_quote+CASE WHEN status='closed' THEN ? ELSE 0 END, fees_quote=0 WHERE id=?`, value.value, value.value, pos.id);
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    return { amount0: String(amount0), amount1: String(amount1), claimedUsd: quoteToUsd(value.value, value.kind, this.ethUsd) };
  }

  async reconcileFeeClaims() {
    const rows = this.store.all(`SELECT t.* FROM txs t LEFT JOIN fee_claims f ON f.tx_hash=t.hash
      WHERE t.kind IN ('claim_fees','compound') AND t.status!='gagal' AND f.tx_hash IS NULL ORDER BY t.ts LIMIT 20`);
    for (const row of rows) {
      const id = JSON.parse(row.detail || '{}').position;
      if (this.exiting.has(id)) continue;
      const pos = this.store.get('SELECT * FROM positions WHERE id=?', id);
      if (!pos) continue;
      this.exiting.add(id);
      try {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [row.hash]);
        if (!rc) {
          // Tidak pernah masuk: jangan biarkan "pending" selamanya — executeExit menolak
          // menutup posisi selama claim-nya belum selesai (lihat Compound.reconcile).
          if (Date.now() - row.ts > 30 * 60_000) {
            const known = await this.rpc.call('eth_getTransactionByHash', [row.hash]).catch(() => 'tak terbaca');
            if (!known) this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", row.hash);
          }
          continue;
        }
        const ok = BigInt(rc.status) === 1n;
        this.store.run('UPDATE txs SET status=? WHERE hash=?', ok ? 'sukses' : 'gagal', row.hash);
        if (ok) await this.recordFeeClaim(pos, row.hash, rc);
      } catch (e) {
        this.store.log('warn', `pencatatan claim fee ${row.hash}: ${e.message}`, { quiet: true });
      } finally { this.exiting.delete(id); }
    }
  }

  // Satu posisi hanya boleh punya satu transaksi keluar yang sedang berjalan. Tutup
  // manual (dasbor/Telegram) menunggu receipt sampai 90 detik; tanpa penjaga ini
  // pemicu keluar mandiri, rekonsiliasi, atau klik kedua di selang itu mengirim tx
  // kedua yang pasti revert setelah tx pertama membakar NFT-nya — gas terbuang.
  async executeExit(plan, pos) {
    if (this.stopping) throw new Error('bot sedang berhenti (restart) — keluar dilanjutkan saat hidup lagi');
    if (this.exiting.has(pos.id)) throw new Error('posisi ini sedang dalam proses ditutup');
    const comp = this.compound?.pending(pos.id);
    if (comp && comp.status !== 'sukses') throw new Error('compound sebelumnya belum selesai — tunggu konfirmasi');
    const claim = this.pendingFeeClaim(pos.id);
    if (claim && claim.status !== 'sukses') throw new Error('claim fee sebelumnya belum selesai — tunggu konfirmasi dan sinkronisasi');
    const cur = this.store.get('SELECT status FROM positions WHERE id=?', pos.id);
    if (cur && cur.status !== 'open') throw new Error('posisi sudah tertutup');
    this.exiting.add(pos.id);
    try { return await this.sendExit(plan, pos); }
    finally { this.exiting.delete(pos.id); }
  }

  // Sinyal keluar target hanya diputuskan SEKALI (lihat handle), jadi gangguan RPC
  // sesaat dulu berarti posisi kita tertinggal terbuka selamanya. Diulang di sini —
  // tetapi HANYA kalau transaksi keluarnya belum pernah terkirim (`notSent`). Galat
  // setelah terkirim (revert, receipt telat) tidak diulang: posisinya mungkin sudah
  // berubah, dan rekonsiliasi yang mengurusnya.
  async executeExitRetry(plan, pos, { waits = this.exitRetryWaits || [3000, 10_000, 30_000] } = {}) {
    for (let i = 0; ; i++) {
      try { return await this.executeExit(plan, pos); }
      catch (e) {
        if (!e.notSent || i >= waits.length) throw e;
        this.store.log('warn', `keluar #${pos.id} belum terkirim (${String(e.message).slice(0, 160)}) — coba lagi dalam ${waits[i] / 1000} dtk (${i + 2}/${waits.length + 1})`, { quiet: true });
        await new Promise((r) => setTimeout(r, waits[i]));
        // Penjaga terakhir sebelum mengirim ulang: tx yang tadi dianggap tidak masuk
        // mungkin baru terlihat sekarang, dan likuiditas kita di chain tidak boleh lebih
        // kecil dari catatan (lebih besar boleh: compound menambahnya).
        // Kalau salah satu meleset, mengirim lagi bisa menarik dua kali.
        if (e.txHash && await this.exec.txLanded(e.txHash, 2)) {
          throw new Error(`transaksi keluar ${e.txHash} ternyata masuk — tidak dikirim ulang, rekonsiliasi yang mencatat`);
        }
        const L = await this.chainLiquidity(pos);
        if (L != null && L < BigInt(pos.liquidity)) {
          throw new Error(`likuiditas posisi #${pos.id} di chain sudah berubah — tidak dikirim ulang`);
        }
      }
    }
  }

  // Posisi yang likuiditasnya sudah NOL di chain tanpa tercatat tutup. Tiga sebab:
  // tx keluar bot yang receipt-nya gagal dibaca (RPC tumbang), tarikan manual di
  // luar bot (#45: $110 ditarik lewat Uniswap, dulu tercatat hasil $0 = rugi total),
  // atau tx bot yang baru masuk setelah batas tunggu. Hasilnya dicari dulu — dari
  // receipt tx bot di tabel txs, kalau tidak ada dari log ModifyLiquidity terakhir —
  // baru dicatat lewat recordExit seperti keluar biasa. Ditutup dengan $0 hanya kalau
  // semuanya gagal, dan pemilik dikabari supaya bisa memperbaikinya manual.
  async closeEmptyPosition(pos) {
    const plan = { full: true, liquidity: pos.liquidity };
    let hash = null;
    for (const r of this.store.all("SELECT hash, detail FROM txs WHERE kind IN ('burn','decrease') AND ts >= ? ORDER BY ts DESC", pos.opened_ts || 0)) {
      try {
        const d = JSON.parse(r.detail || '{}');
        if (d.position !== pos.id) continue;
        // Sudah dibukukan (tarik sebagian sebelumnya) — bukan tx yang mengosongkannya.
        if (d.closeProceeds || d.decreaseProceeds) break;
        hash = r.hash; break;
      } catch { /* detail lama tanpa JSON */ }
    }
    let source = 'tx bot';
    if (!hash && pos.venue === 'v4' && pos.pool_ref && pos.token_id) {
      source = 'log ModifyLiquidity';
      hash = await this.lastWithdrawTx(pos).catch((e) => { this.store.log('warn', `cari tx tarik #${pos.id}: ${e.message}`, { quiet: true }); return null; });
    }
    if (hash) {
      let receipt = null;
      try { receipt = await this.rpc.call('eth_getTransactionReceipt', [hash]); } catch { /* dicoba lagi sinkron berikutnya */ }
      if (!receipt) {
        this.store.log('warn', `#${pos.id} kosong di chain; receipt ${hash.slice(0, 12)}… belum terbaca — penutupan ditunda`, { quiet: true });
        return null;
      }
      if (BigInt(receipt.status) === 1n) {
        const r = await this.recordExit(plan, pos, hash, receipt);
        const msg = `#${pos.id} ditutup di luar alur bot — hasil dicatat dari ${source} ${hash.slice(0, 12)}… (${r.note})`;
        this.notify(msg, { kind: 'exit', positionId: pos.id, txHash: hash, full: true, sold: r.sold, auto: true, target: pos.target, mirrorOf: pos.mirror_of, reason: 'likuiditas sudah nol di chain' });
        return r;
      }
    }
    this.positions.markClosed(pos.id, { outQuote: 0, txHash: null });
    this.notify(`#${pos.id} likuiditasnya sudah nol di chain tetapi transaksi keluarnya tidak ditemukan — dicatat hasil $0; perbaiki manual kalau dananya memang masuk wallet`, {
      kind: 'exit', positionId: pos.id, txHash: null, full: true, auto: true, target: pos.target, mirrorOf: pos.mirror_of, reason: 'likuiditas sudah nol di chain, hasil tidak ditemukan',
    });
    return null;
  }

  // Tx mint/increase bot yang sudah terkirim tapi posisinya belum dibukukan (receipt
  // gagal dibaca / lewat batas tunggu). Sukses → dibukukan dari receipt lengkap dengan
  // tautan target; revert → ditandai gagal dan token hasil zap-nya diantrekan dijual;
  // tidak pernah masuk (30 menit tanpa receipt) → sama seperti revert.
  async bookPendingMints() {
    if (!this.exec.address()) return;
    const rows = this.store.all("SELECT hash, ts, kind, detail FROM txs WHERE kind IN ('mint','increase') AND status != 'gagal' AND ts > ? ORDER BY ts", Date.now() - 24 * 3600_000);
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail || '{}'); } catch { continue; }
      if (!d.plan || d.recorded) continue;
      if (Date.now() - r.ts < 120_000) continue;   // alur masuknya sendiri masih menunggu (90 dtk)
      if (d.plan.action === 'increase' && d.plan.positionId && this.exiting.has(d.plan.positionId)) continue;
      let receipt = null;
      try { receipt = await this.rpc.call('eth_getTransactionReceipt', [r.hash]); } catch { continue; }
      const failed = receipt ? BigInt(receipt.status) !== 1n : Date.now() - r.ts > 30 * 60_000;
      if (!receipt && !failed) continue;
      if (failed) {
        this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", r.hash);
        this.store.log('warn', `mint ${r.hash.slice(0, 12)}… ${receipt ? 'revert' : 'tidak pernah masuk'} — ${d.zapped ? 'token zap diantrekan dijual' : 'dana tetap di wallet'}`);
        if (d.zapped) await this.rescueZap({ target: d.target }, { ...d.zapped, before: BigInt(d.zapped.before) }, new Error('mint gagal')).catch(() => {});
        continue;
      }
      const res = await this.recordEntry(d.plan, r.hash, receipt);
      const msg = `posisi #${res.positionId} dibukukan belakangan dari receipt ${r.hash.slice(0, 12)}… — ${res.note}`;
      this.notify(msg, { kind: 'entry', positionId: res.positionId, txHash: r.hash, target: d.target, mirrorOf: d.plan.mirrorOf, valueUsd: res.valueUsd, pair: res.pair });
    }
  }

  // Tx keluar bot (burn/decrease) yang sudah terkirim tapi hasilnya belum dibukukan —
  // receipt-nya gagal dibaca saat itu (RPC tumbang / lewat batas tunggu). Dicoba lagi
  // tiap sinkron sampai receipt terbaca: sukses → dibukukan (tutup penuh kalau
  // likuiditasnya kini nol, kalau tidak sebagai tarik sebagian); revert → ditandai.
  async bookPendingExits() {
    if (!this.exec.address()) return;
    const rows = this.store.all("SELECT hash, kind, detail FROM txs WHERE kind IN ('burn','decrease') AND status != 'gagal' AND ts > ? ORDER BY ts", Date.now() - 24 * 3600_000);
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail || '{}'); } catch { continue; }
      if (!d.position || d.closeProceeds || d.decreaseProceeds) continue;
      const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", d.position);
      if (!pos || this.exiting.has(pos.id)) continue;
      let receipt = null;
      try { receipt = await this.rpc.call('eth_getTransactionReceipt', [r.hash]); } catch { continue; }
      if (!receipt) continue;
      if (BigInt(receipt.status) !== 1n) {
        this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", r.hash);
        continue;
      }
      const live = this.positions.live.find((p) => p.id === pos.id);
      const full = live ? live.empty : r.kind === 'burn';
      const res = await this.recordExit({ full, liquidity: '0' }, pos, r.hash, receipt);
      this.store.log('info', `hasil tx keluar ${r.hash.slice(0, 12)}… #${pos.id} dibukukan belakangan (${res.note})`);
    }
  }

  // Tx terakhir yang MENARIK likuiditas posisi v4 ini (ModifyLiquidity dengan salt ==
  // tokenId dan delta negatif), dicari mundur dari blok terbaru dalam jendela terbatas.
  // Dipanggil jarang (posisi kosong tak tercatat), jadi biaya getLogs-nya wajar.
  async lastWithdrawTx(pos, { span = this.cfg.loop?.empty_scan_blocks ?? 3000, step = 500 } = {}) {
    const head = parseInt(await this.rpc.call('eth_blockNumber', []), 16);
    const salt = BigInt(pos.token_id).toString(16).padStart(64, '0');
    for (let to = head; to > head - span; to -= step) {
      const from = Math.max(0, to - step + 1);
      const logs = await this.rpc.getLogs({
        address: ADDR.poolManager, topics: [TOPIC.modifyLiquidity, pos.pool_ref],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      });
      // data = tickLower, tickUpper, liquidityDelta (int256), salt — masing-masing 32 byte
      const mine = logs.filter((l) => l.data.length === 2 + 4 * 64 && l.data.slice(-64) === salt
        && BigInt.asIntN(256, BigInt('0x' + l.data.slice(2 + 2 * 64, 2 + 3 * 64))) < 0n);
      if (mine.length) return mine[mine.length - 1].transactionHash;
    }
    return null;
  }

  // Likuiditas posisi kita menurut chain; null kalau tidak terbaca.
  async chainLiquidity(pos) {
    try {
      if (pos.venue === 'v3') {
        const [w] = await this.rpc.ethCallMany([{ to: ADDR.npmV3, data: IF_NPM.encodeFunctionData('positions', [BigInt(pos.token_id)]) }]);
        return w && w !== '0x' ? BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]) : null;
      }
      const [w] = await this.rpc.ethCallMany([{ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(pos.token_id)]) }]);
      return w && w !== '0x' ? BigInt(w) : null;
    } catch { return null; }
  }

  async sendExit(plan, pos) {
    let tx, before, hash;
    try {
      // Keluar juga butuh gas. Diisi SEBELUM saldo "sebelum" dibaca, supaya unwrap-nya
      // tidak terhitung sebagai hasil penutupan posisi berpasangan ETH.
      const gasNotes = [];
      await this.topUpGas(gasNotes);
      if (gasNotes.length) this.store.log('info', `sebelum tutup #${pos.id}: ${gasNotes.join(', ')}`);
      if (pos.venue === 'v3') {
        tx = this.exec.buildV3Decrease({ ...plan, tokenId: pos.token_id }, this.exec.deadline());
      } else {
        const poolKey = await this.poolKeyOf(pos);
        if (!poolKey) throw new Error('poolKey posisi tidak terbaca');
        tx = this.exec.buildV4Decrease({ ...plan, poolKey, tokenId: pos.token_id }, this.exec.deadline());
      }
      // Saldo SEBELUM keluar: hasil penutupan diukur dari selisihnya, bukan dari data
      // sinkronisasi berkala. Posisi yang dibuka lalu ditutup di antara dua sinkronisasi
      // (30 detik) dulu tercatat hasil $0 — PnL-nya jadi seolah rugi total.
      before = await this.exec.balances([pos.token0, pos.token1]);
      hash = await this.exec.send(tx, { kind: plan.full ? 'burn' : 'decrease', detail: { position: pos.id } });
    } catch (e) { e.notSent = true; throw e; }   // belum ada tx keluar di chain: aman diulang
    const rc = await this.exec.waitReceipt(hash, 90_000);
    // Tx sudah di chain tapi receipt belum terbaca: JANGAN ditutup dengan $0 oleh sinkron
    // berikutnya — closeEmptyPosition menemukan tx ini di tabel txs dan mencatat hasilnya
    // dari receipt begitu terbaca.
    if (rc.timeout) throw new Error(`belum terkonfirmasi setelah 90 detik — tx ${hash} mungkin masih diproses; hasilnya dicatat otomatis begitu receipt terbaca`);
    if (!rc.ok) throw new Error(`transaksi keluar revert (${hash})`);
    return this.recordExit(plan, pos, hash, rc.receipt, before);
  }

  // Pembukuan sesudah tx keluar terkonfirmasi: hasil dari receipt, sisa memecoin, lalu
  // penjualan sisanya. Dipakai sendExit dan closeEmptyPosition (tx yang receipt-nya
  // baru terbaca belakangan, atau tarikan di luar bot).
  async recordExit(plan, pos, hash, receipt, before = null) {
    const proceeds = await this.exitProceeds(pos, before, receipt);
    // Posisi dicatat tertutup DULU — lengkap dengan memecoin sisa yang diterima dan
    // nilainya di harga tutup — baru sisanya dijual. Kalau penjualan berhasil,
    // recordLeftoverSale mengganti taksiran itu dengan hasil sesungguhnya; kalau
    // tersangkut, ekuitas tetap menilainya di harga kini, bukan menghilangkannya.
    const live = this.positions.live.find((p) => p.id === pos.id);
    let left = null;
    // sisa memecoin dinilai di harga penilai (markSqrt), bukan harga pool yang bisa di batas
    try { left = await this.leftoverOf(pos, receipt, proceeds?.markSqrt ?? live?.markSqrt ?? live?.curSqrt ?? null); }
    catch (e) { this.store.log('warn', `sisa #${pos.id} tidak terukur: ${e.message}`, { quiet: true }); }
    if (plan.full) {
      this.positions.markClosed(pos.id, {
        out0: proceeds?.amount0 ?? live?.amount0, out1: proceeds?.amount1 ?? live?.amount1,
        outQuote: proceeds?.valueQuote ?? ((live?.valueUsd || 0) + (live?.feeUsd || 0)), txHash: hash,
        exitSqrt: proceeds?.sqrt ?? live?.curSqrt ?? null, left,
      });
    } else {
      // Tarik sebagian: hasilnya SUDAH di wallet, jadi harus masuk out_quote sekarang.
      // Dulu hanya likuiditasnya yang dikurangi — posisi #25 kehilangan $68,52 dari
      // catatan (54,75 USDG + memecoin yang terjual $13,77) dan terbaca rugi $64
      // padahal untung $4.
      this.positions.markDecreased(pos.id, {
        liquidity: (BigInt(pos.liquidity) - BigInt(plan.liquidity)).toString(),
        out0: proceeds?.amount0 ?? 0n, out1: proceeds?.amount1 ?? 0n,
        outQuote: proceeds?.valueQuote ?? 0, txHash: hash, left,
      });
    }
    // Jual memecoin yang BARU diterima dari transaksi keluar ini. Galatnya tidak boleh
    // membatalkan pencatatan keluar — posisinya sudah benar-benar tertutup di chain.
    let sold = null;
    try { sold = await this.sellLeftover(pos, receipt, { quiet: true }); }
    // Gagal jual masuk antrean coba-ulang (keepLeftover); yang dikabarkan hanya kalau
    // antrean menyerah.
    catch (e) { this.store.log('error', `jual sisa #${pos.id}: ${e.message}`, { quiet: true }); }
    return { txHash: hash, sold, note: `${plan.full ? 'tutup penuh' : 'kurangi'} posisi #${pos.id}${sold ? ` · ${sold}` : ''}` };
  }

  // Berapa yang benar-benar masuk wallet dari transaksi keluar, dibaca dari log
  // Transfer di receipt (ETH native: saldo historis di blok itu, gas dikembalikan —
  // gas mengurangi saldo tapi bukan bagian dari hasil posisi). Selisih saldo
  // "sebelum/sesudah" hanya cadangan: RPC yang tertinggal satu blok pernah membuatnya
  // nol, sehingga posisi #27 tercatat dari cache sinkron yang sudah basi.
  // Nilainya dihitung di harga pool saat itu.
  async exitProceeds(pos, before, receipt) {
    try {
      const me = this.exec.address().toLowerCase();
      let amount0, amount1;
      try {
        amount0 = await this.receivedIn(receipt, pos.token0, me);
        amount1 = await this.receivedIn(receipt, pos.token1, me);
      } catch (e) {
        if (!before) throw e;   // tanpa saldo "sebelum" tidak ada cadangan
        this.store.log('warn', `hasil keluar #${pos.id} dari receipt tidak terbaca (${e.message}) — pakai selisih saldo`, { quiet: true });
        const after = await this.exec.balances([pos.token0, pos.token1]);
        const d = (t) => {
          let v = (after.get(String(t).toLowerCase()) || 0n) - (before.get(String(t).toLowerCase()) || 0n);
          if (isNative(t) && receipt?.gasUsed && receipt?.effectiveGasPrice) {
            v += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
          }
          return v > 0n ? v : 0n;
        };
        amount0 = d(pos.token0); amount1 = d(pos.token1);
      }
      if (amount0 === 0n && amount1 === 0n) return null;
      // harga penilai (pool sendiri kalau layak); exit_sqrt tetap harga pool apa adanya
      const s = await this.positions.markSlotFor(pos);
      const toks = await this.chain.tokens([pos.token0, pos.token1]);
      const v = s && this.chain.valueInQuote({
        sqrtPriceX96: s.sqrtPriceX96, amount0, amount1,
        dec0: toks[0].decimals, dec1: toks[1].decimals, token0: pos.token0, token1: pos.token1,
      });
      return { amount0: amount0.toString(), amount1: amount1.toString(), valueQuote: v ? v.value : null, sqrt: s?.poolSqrt ?? null, markSqrt: s?.sqrtPriceX96 ?? null };
    } catch (e) { this.store.log('warn', `hasil keluar #${pos.id} tidak terukur: ${e.message}`, { quiet: true }); return null; }   // cadangan: angka sinkron terakhir
  }

  // Memecoin yang masuk wallet dari transaksi keluar ini + nilainya di harga tutup
  // (satuan aset kuotasi posisi). Jumlahnya dari log Transfer di receipt — sama
  // dengan yang akan dijual sellLeftover — bukan dari selisih saldo.
  async leftoverOf(pos, receipt, sqrt) {
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    if (!q) return null;
    const meme = String(q.side === 0 ? pos.token1 : pos.token0).toLowerCase();
    if (this.chain.quoteSideOf(meme, meme)) return null;
    const me = this.exec.address().toLowerCase();
    let got = 0n;
    for (const l of receipt?.logs || []) {
      if (l.address.toLowerCase() !== meme || l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
      if (('0x' + l.topics[2].slice(-40)).toLowerCase() === me) got += BigInt(l.data);
    }
    if (got === 0n) return null;
    let quote = 0;
    if (sqrt) {
      const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
      const v = this.chain.valueInQuote({
        sqrtPriceX96: BigInt(sqrt), amount0: q.side === 0 ? 0n : got, amount1: q.side === 0 ? got : 0n,
        dec0: t0?.decimals ?? 18, dec1: t1?.decimals ?? 18, token0: pos.token0, token1: pos.token1,
      });
      quote = v ? v.value : 0;
    }
    return { token: meme, amount: got, quote };
  }

  // ---- jual sisa memecoin -------------------------------------------------
  // Keluar dari posisi LP mengembalikan campuran aset kuotasi + memecoin, tergantung di
  // mana harga berada. Memecoin itu bukan tujuan copy — dijual balik ke aset kuotasi
  // pool yang sama. Yang dijual HANYA jumlah yang diterima dari tx keluar ini (dibaca dari
  // log Transfer di receipt), bukan seluruh saldo: wallet ini bisa dipakai program lain
  // yang memegang token yang sama.
  async sellLeftover(pos, receipt, opts = {}) {
    const rules = this.rulesFrom(pos.target);
    if (!rules.exit.sell_leftover) return null;
    // quoteSideOf mengembalikan objek {side, symbol, kind}, bukan angka.
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    if (!q) return null;                            // pasangan tanpa aset kuotasi
    const meme = String(q.side === 0 ? pos.token1 : pos.token0).toLowerCase();
    const quote = String(q.side === 0 ? pos.token0 : pos.token1).toLowerCase();
    // ETH/USDG, WETH/USDG, dst.: dua-duanya "uang" — tidak ada memecoin untuk dijual.
    if (this.chain.quoteSideOf(meme, meme)) return null;
    const me = this.exec.address().toLowerCase();
    let got = 0n;
    for (const l of receipt?.logs || []) {
      if (l.address.toLowerCase() !== meme || l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
      if (('0x' + l.topics[2].slice(-40)).toLowerCase() === me) got += BigInt(l.data);
    }
    if (got === 0n) return null;
    return this.sellToken({ posId: pos.id, target: pos.target, token: meme, quote, amount: got, tries: 0 }, opts);
  }

  // Jual `amount` token ke `quote` lewat Kyber. Gagal -> dicatat untuk dicoba ulang.
  // `quiet`: penjualan yang terjadi di dalam transaksi keluar sudah dilaporkan oleh
  // kabar penutupan posisi — jangan kirim kabar kedua untuk hal yang sama.
  async sellToken(item, { quiet = false } = {}) {
    const rules = this.rulesFrom(item.target);
    // Satu penjualan per token pada satu waktu. Antrean otomatis (tiap detik), tombol
    // "jual sekarang", dan sisa dari tx keluar bisa menyentuh token yang sama bersamaan —
    // penjualan kedua membangun swap dari saldo yang sedang dijual yang pertama dan
    // revert (gas hangus), atau ikut menjual jatah item lain. Yang tertahan tetap antre.
    this.selling = this.selling || new Set();
    const lockKey = String(item.token).toLowerCase();
    if (this.selling.has(lockKey)) {
      this.keepLeftover({ ...item, amount: String(item.amount), next: 0 }, 'menunggu penjualan token yang sama selesai');
      return null;
    }
    this.selling.add(lockKey);
    try { return await this.sellTokenLocked(item, rules, { quiet }); }
    finally { this.selling.delete(lockKey); }
  }

  async sellTokenLocked(item, rules, { quiet }) {
    // Penjualan butuh gas: ETH native di bawah cadangan diisi dulu (dari WETH/USDG).
    await this.topUpGas([]).catch(() => {});
    let amount = BigInt(item.amount), label = String(item.token).slice(0, 10);
    try {
      const bal = (await this.exec.balances([item.token])).get(item.token) || 0n;
      amount = bal < BigInt(item.amount) ? bal : BigInt(item.amount);
      if (amount === 0n) { this.dropLeftover(item); return null; }
      const meta = await this.chain.token(item.token).catch(() => null);
      label = `${(Number(amount) / 10 ** (meta?.decimals ?? 18)).toPrecision(4)} ${meta?.symbol || item.token.slice(0, 8)}`;
    } catch (e) {
      // Saldo tidak terbaca (RPC). Dulu galat ini lolos SEBELUM item diantrekan: sisa
      // dari tx keluar tidak pernah masuk antrean dan tidak pernah dijual siapa pun.
      // Tetap antre (tanpa peringatan keras — ini galat RPC sementara).
      this.keepLeftover({ ...item, amount: String(item.amount) }, `saldo belum terbaca: ${e.message}`);
      throw new Error(`${label} belum terjual: ${e.message}`);
    }
    try {
      let r = await this.kyber.swap(item.token, item.quote, amount, {
        slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps,
        kind: 'sell_leftover', detail: { position: item.posId },
      });
      // Kyber belum mengenal rutenya (pool token baru sering belum terindeks): coba jual
      // langsung ke pool yang kita kenal — pool posisinya sendiri dan pool berpasangan sama.
      if (!r) r = await this.sellViaPool(item, amount, rules);
      if (!r) throw new Error('Kyber tidak menemukan rute (pool langsung juga tidak bisa)');
      this.dropLeftover(item);
      try {
        this.positions.recordLeftoverSale({ posId: item.posId, token: item.token, amount, quoteToken: item.quote,
          txHash: r.hash, amountOut: r.amountOut, usdOut: r.quote?.usdOut, ethUsd: this.ethUsd });
      } catch (e) { this.store.log('warn', `catat hasil jual ${asalSisa(item)}: ${e.message}`, { quiet: true }); }
      const msg = `jual ${label} → $${(r.quote.usdOut || 0).toFixed(2)} (${r.quote.dex})`;
      if (!quiet) {
        this.notify(`${asalSisa(item)}: ${msg}`, {
          kind: 'leftover', positionId: item.posId, txHash: r.hash, label, usdIn: r.quote.usdIn,
          usdOut: r.quote.usdOut, dex: r.quote.dex, tries: item.tries || 0,
        });
      }
      return msg;
    } catch (e) {
      this.keepLeftover({ ...item, amount: amount.toString() }, e.message);
      this.alertLeftover({ ...item, amount: amount.toString() }, label, e);
      throw new Error(`${label} belum terjual: ${e.message}`);
    }
  }

  // Jual lewat satu pool langsung (UniversalRouter), cadangan kalau Kyber tidak punya rute.
  // Pengaman yang sama dengan jual lewat Kyber: batas rugi (fee pool + dampak harga) dari
  // aturan sell_max_loss_bps, minOut dari taksiran pool dikurangi slippage, dan tx hanya
  // dikirim kalau simulasinya lolos. Debu (< $0,50) tidak dijual: gasnya lebih mahal.
  async sellViaPool(item, amount, rules) {
    const token = String(item.token).toLowerCase(), quote = String(item.quote).toLowerCase();
    const ctx = { store: this.store, chain: this.chain, rpc: this.rpc, exec: this.exec, log: this.log };
    const extra = [];
    if (item.posId != null) {
      const p = this.store.get('SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks FROM positions WHERE id=?', item.posId);
      if (p && [p.token0, p.token1].map((x) => String(x).toLowerCase()).sort().join() === [token, quote].sort().join()) {
        extra.push({ ...p, pool_addr: p.venue === 'v3' ? p.pool_ref : null });
      }
    }
    const known = extra.length || this.store.get('SELECT 1 FROM pools WHERE (token0=? AND token1=?) OR (token0=? AND token1=?)', token, quote, quote, token);
    if (!known) return null;
    const maxLoss = Number(rules.exit.sell_max_loss_bps) || 1500;
    const usdOf = (out) => {
      const q = QUOTES[quote];
      return q ? (Number(out) / 10 ** q.decimals) * (q.kind === 'eth' ? this.ethUsd : 1) : null;
    };
    // Taksiran dulu tanpa izin/simulasi yang berarti (minOut 1): kalau debu atau terlalu
    // rugi, berhenti sebelum approval yang memakan gas.
    for (const a of await this.exec.ensureRouterAllowance(token)) {
      const usdGuess = item.lastUsdOut ?? null;
      if (usdGuess != null && usdGuess < 0.5) return null;
      const h = await this.exec.send(a, { kind: a.kind });
      await this.exec.waitReceipt(h);
    }
    const probeInfo = {};
    const probe = await pickSwapPool(ctx, { tokenIn: token, tokenOut: quote, amountIn: amount, minOut: 1n,
      maxImpactBps: maxLoss, deadlineSec: this.exec.deadline(), extra, info: probeInfo });
    if (!probe) return null;
    const lossBps = (probe.impactBps ?? 0) + (probe.feePpm ?? 0) / 100;
    if (lossBps > maxLoss) {
      const e = new Error(`jual lewat pool rugi ${(lossBps / 100).toFixed(1)}% (batas ${(maxLoss / 100).toFixed(1)}%)`);
      e.loss = { lossBps, maxLossBps: maxLoss, usdIn: null, usdOut: usdOf(probe.outEst), dex: 'pool langsung' };
      throw e;
    }
    const usdOut = usdOf(probe.outEst);
    if (usdOut != null && usdOut < 0.5) return null;
    const minOut = (probe.outEst * BigInt(10_000 - Number(rules.swap.max_slippage_bps))) / 10_000n;
    const pick = await pickSwapPool(ctx, { tokenIn: token, tokenOut: quote, amountIn: amount, minOut,
      maxImpactBps: maxLoss, deadlineSec: this.exec.deadline(), extra, info: {} });
    if (!pick) return null;
    const h = await this.exec.send(pick.tx, { kind: 'sell_leftover', detail: { position: item.posId, via: pick.pool.pool_ref, dex: `pool ${pick.pool.venue}`, usdOut } });
    const rc = await this.exec.waitReceipt(h, 90_000);
    if (rc.timeout) throw new Error(`jual lewat pool ${h} belum terkonfirmasi setelah 90 detik`);
    if (!rc.ok) throw new Error(`jual lewat pool gagal (${h})`);
    const me = this.exec.address().toLowerCase();
    const got = isNative(quote) ? null : await this.receivedIn(rc.receipt, quote, me).catch(() => null);
    return { hash: h, amountOut: got ?? pick.outEst, quote: { dex: `pool ${pick.pool.venue} ${String(pick.pool.pool_ref).slice(0, 10)}…`, usdIn: null, usdOut: got != null ? usdOf(got) : usdOut } };
  }

  // Token yang tidak bisa dijual = uang yang tersangkut. Dikabarkan KERAS pada
  // kegagalan pertama, lalu diingatkan tiap 6 jam selama masih tersangkut — bukan
  // tiap percobaan: antrean mengecek tiap beberapa detik, dan kabar yang sama
  // ribuan kali hanya membuat orang kebal.
  alertLeftover(item, label, e) {
    const cur = this.leftovers().find((x) => this.sameLeftover(x, item));
    if (!cur) return;
    const first = (cur.tries || 0) <= 1;
    const due = Date.now() - (cur.alertedAt || 0) > 6 * 3600_000;
    if (!first && !due) return;
    this.saveLeftovers(this.leftovers().map((x) => (this.sameLeftover(x, item) ? { ...x, alertedAt: Date.now() } : x)));
    this.notify(`SISA BELUM TERJUAL: ${label} dari ${asalSisa(item)} — ${e.message}`, {
      kind: 'leftover_stuck', positionId: item.posId, target: item.target, token: item.token,
      label, amount: item.amount, why: e.message, tries: cur.tries, next: cur.next, retrySec: this.leftoverRetrySec(),
      since: cur.since || null, reminder: !first,
      usdIn: e.loss?.usdIn ?? null, usdOut: e.loss?.usdOut ?? null, lossBps: e.loss?.lossBps ?? null, maxLossBps: e.loss?.maxLossBps ?? null,
    });
  }
  leftoverRetrySec() {
    const n = Number(this.rulesFrom(null).exit.leftover_retry_sec);
    return Number.isFinite(n) && n >= 1 ? n : 5;
  }

  leftovers() {
    try { return JSON.parse(this.store.getState('leftovers', '[]') || '[]'); }
    catch { return []; }
  }
  saveLeftovers(list) { this.store.setState('leftovers', JSON.stringify(list)); }
  // Satu item dikenali dari pasangan (posisi, token). posId null = disapu dari wallet,
  // bukan dari posisi — `?? null` menyamakan null dan undefined supaya item lama
  // (yang belum punya field ini) tidak pernah tertukar dengan item sapuan.
  sameLeftover(a, b) { return (a.posId ?? null) === (b.posId ?? null) && a.token === b.token; }
  // Item TIDAK pernah dibuang sendiri: uangnya masih tersangkut di wallet, jadi
  // peringatan dasbor dan daftar token swap harus terus melihatnya sampai terjual
  // atau dikeluarkan manual. `tries` cuma penghitung; jadwalnya tiap beberapa detik.
  keepLeftover(item, why) {
    const old = this.leftovers().find((x) => this.sameLeftover(x, item));
    const list = this.leftovers().filter((x) => !this.sameLeftover(x, item));
    const tries = (item.tries || 0) + 1;
    const next = Date.now() + this.leftoverRetrySec() * 1000;
    list.push({ ...old, ...item, tries, next, why, since: old?.since || item.since || Date.now() });
    this.saveLeftovers(list);
    return { tries, next };
  }
  dropLeftover(item) {
    this.saveLeftovers(this.leftovers().filter((x) => !this.sameLeftover(x, item)));
  }

  // Dipanggil tiap detik (index.js). Tiap item dicek dengan SATU kutipan Kyber
  // (bukan build + kirim): kalau ruginya masih di atas batas, cukup catat dan
  // tunggu tick berikutnya. Baru kalau lolos, penjualan sungguhan dijalankan —
  // dengan pengaman yang sama seperti biasa. Jadi memburu likuiditas yang
  // sesaat membaik itu murah: satu HTTP ke Kyber per item per interval.
  async retryLeftovers() {
    if (this.stopping || this.dryRun() || !this.exec.address() || this.leftoverBusy) return;
    this.leftoverBusy = true;
    try {
      for (const item of this.leftovers()) {
        if (Date.now() < (item.next || 0)) continue;
        const rules = this.rulesFrom(item.target);
        try {
          const bal = (await this.exec.balances([item.token])).get(item.token) || 0n;
          const amount = bal < BigInt(item.amount) ? bal : BigInt(item.amount);
          if (amount === 0n) { this.dropLeftover(item); continue; }
          const q = await this.kyber.quote(item.token, item.quote, amount);
          const { Kyber } = require('./kyber');
          const loss = q ? Kyber.lossBps(q) : null;
          // Tanpa rute Kyber: jalur pool langsung dicoba (sellToken → sellViaPool), paling
          // sering tiap 60 detik per item — tiap percobaan membaca & menyimulasikan pool.
          if (!q && Date.now() - (item.poolTriedAt || 0) > 60_000) {
            this.saveLeftovers(this.leftovers().map((x) => (this.sameLeftover(x, item) ? { ...x, poolTriedAt: Date.now() } : x)));
            await this.sellToken({ ...item, poolTriedAt: Date.now() });
            continue;
          }
          if (!q || (loss != null && loss > rules.exit.sell_max_loss_bps)) {
            const why = !q ? 'Kyber tidak menemukan rute'
              : `rute Kyber rugi ${(loss / 100).toFixed(1)}% (batas ${(rules.exit.sell_max_loss_bps / 100).toFixed(1)}%) — $${q.usdIn?.toFixed(2)} → $${q.usdOut?.toFixed(2)}`;
            const e = new Error(why);
            if (q) e.loss = { lossBps: loss, maxLossBps: rules.exit.sell_max_loss_bps, usdIn: q.usdIn, usdOut: q.usdOut, dex: q.dex };
            // Kutipan terbaru disimpan supaya pita di dasbor menunjukkan angka kini.
            this.keepLeftover({ ...item, amount: amount.toString(), lastLossBps: loss, lastUsdOut: q?.usdOut ?? null, lastUsdIn: q?.usdIn ?? null }, why);
            const meta = await this.chain.token(item.token).catch(() => null);
            this.alertLeftover(item, `${(Number(amount) / 10 ** (meta?.decimals ?? 18)).toPrecision(4)} ${meta?.symbol || item.token.slice(0, 8)}`, e);
            continue;
          }
          await this.sellToken(item);
        } catch (e) { this.store.log('warn', `coba ulang jual sisa #${item.posId}: ${e.message}`, { quiet: true }); }   // masih di antrean
      }
    } finally { this.leftoverBusy = false; }
  }

  // Sapu memecoin yang sudah telanjur duduk di wallet.
  //
  // sellLeftover hanya menangkap apa yang keluar dari tx keluar bot itu sendiri (dibaca
  // dari log Transfer di receipt-nya), jadi token yang sudah ada lebih dulu — sisa run
  // lama, LP manual, kiriman langsung — tidak pernah masuk antrean dan tidak pernah
  // dijual siapa pun. Di sini isi wallet dibaca, tiap token non-kuotasi dikutip ke Kyber
  // SEKALI, dan yang nilainya di atas ambang dimasukkan ke antrean yang sama seperti
  // sisa posisi (posId null). Debu di bawah ambang sengaja dilewat: rutenya tidak akan
  // pernah lolos batas rugi, dan item yang gagal selamanya cuma membuat pita peringatan
  // kebal dibaca. Tidak ada transaksi yang dikirim di sini — hanya mengisi antrean;
  // penjualannya tetap lewat retryLeftovers dengan pengaman yang sama.
  async sweepWallet({ minUsd = 0.5, quote = ADDR.usdg } = {}) {
    const me = this.exec.address();
    if (!me) throw new Error('wallet bot belum diatur');
    const q = String(quote).toLowerCase();
    // Kandidat: semua token yang pernah dikenal bot + yang pernah masuk ke wallet
    // (daftar yang sama dipakai halaman Swap, disegarkan oleh Manual.seenTokens).
    const set = new Set();
    for (const r of this.store.all('SELECT address FROM tokens')) if (r.address) set.add(String(r.address).toLowerCase());
    try {
      const st = JSON.parse(this.store.getState('swap_seen', '{}') || '{}');
      if (st.wallet === me) for (const a of st.tokens || []) set.add(String(a).toLowerCase());
    } catch { /* daftar tabel tokens saja sudah cukup */ }
    // Token yang ditambahkan manual di halaman Swap ikut: justru yang begini yang
    // paling sering nyangkut — belum pernah jadi posisi, jadi tidak ada di tabel
    // tokens, dan sudah lewat jendela pindai Transfer kalau masuknya lama.
    try {
      const c = JSON.parse(this.store.getState('swap_tokens', '[]') || '[]');
      if (Array.isArray(c)) for (const a of c) if (/^0x[0-9a-f]{40}$/i.test(a)) set.add(String(a).toLowerCase());
    } catch { /* daftar manual boleh kosong */ }
    // Aset kuotasi itu tujuan, bukan sisa. Token posisi yang masih terbuka juga tidak
    // disentuh: itu bahan kerja (zap, tambah likuiditas), bukan sampah.
    for (const a of Object.keys(QUOTES)) set.delete(a);
    set.delete(ADDR.native);
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE status='open'")) {
      for (const t of [r.token0, r.token1]) if (t) set.delete(String(t).toLowerCase());
    }
    for (const it of this.leftovers()) set.delete(String(it.token).toLowerCase());
    const list = [...set];
    if (!list.length) return { scanned: 0, queued: [], skipped: [] };

    const bal = await this.exec.balances(list);
    const punya = list.filter((a) => (bal.get(a) || 0n) > 0n);
    const metas = await this.chain.tokens(punya);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [String(t.address).toLowerCase(), t]));

    const queued = [], skipped = [];
    for (const token of punya) {
      const amount = bal.get(token);
      const meta = byAddr.get(token) || {};
      const label = `${fmtUnits(amount, meta.decimals ?? 18)} ${meta.symbol || token.slice(0, 8)}`;
      // Satu kutipan per token: yang menentukan layak dijual atau tidak adalah berapa
      // yang benar-benar bisa ditarik, bukan harga pool.
      const k = await this.kyber.quote(token, q, amount).catch(() => null);
      const usd = k?.usdOut ?? null;
      if (usd == null || usd < minUsd) {
        skipped.push({ token, label, usd,
          why: !k ? 'Kyber tidak menemukan rute' : `cuma $${(usd || 0).toFixed(2)} (< $${minUsd})` });
        continue;
      }
      this.keepLeftover({ posId: null, target: null, token, quote: q, amount: amount.toString(), tries: 0,
        since: Date.now(), source: 'wallet', lastUsdOut: usd, lastUsdIn: k.usdIn ?? null }, 'baru disapu dari wallet, menunggu giliran');
      queued.push({ token, label, usd });
    }
    if (queued.length) {
      this.store.log('info', `sapu wallet: ${queued.length} token masuk antrean jual — ${queued.map((x) => `${x.label} (~$${x.usd.toFixed(2)})`).join(', ')}`);
    }
    return { scanned: punya.length, queued, skipped };
  }

  // Jaring pengaman terakhir untuk sinyal keluar.
  //
  // Semua jalur deteksi bisa gagal: RPC melewatkan satu rentang, proses mati saat
  // aksi datang, atau target keluar sebelum mint kita sempat tercatat. Kalau itu
  // terjadi, posisi cermin kita menggantung selamanya sementara targetnya sudah
  // pergi. Di sini kondisinya diperiksa dari sumber yang paling tidak bisa salah:
  // likuiditas posisi TARGET di chain. Kalau sudah nol sementara punya kita masih
  // terbuka, kita keluar.
  //
  // Butuh DUA pengamatan nol berturut-turut supaya pembacaan yang gagal sesaat atau
  // rebalance tutup-lalu-buka dalam satu transaksi tidak memicu penutupan.
  async reconcileExits() {
    if (this.dryRun() || !this.exec.address()) return;
    // v3 ikut diperiksa: dulu hanya v4, jadi cermin v3 yang sinyal keluarnya terlewat
    // menggantung selamanya.
    const rows = this.store.all(
      "SELECT * FROM positions WHERE status='open' AND venue IN ('v4','v3') AND target IS NOT NULL AND mirror_of IS NOT NULL AND token_id IS NOT NULL");
    if (!rows.length) { this.goneStreak = new Map(); return; }
    this.goneStreak = this.goneStreak || new Map();
    let res;
    try {
      // strict: galat sementara melempar (tidak dianggap nol). Hasil null dari v3 = revert
      // sah positions() untuk NFT yang sudah dibakar = target keluar penuh.
      const out = await this.rpc.ethCallMany(rows.map((r) => (r.venue === 'v3'
        ? { to: ADDR.npmV3, data: IF_NPM.encodeFunctionData('positions', [BigInt(r.mirror_of)]) }
        : { to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.mirror_of)]) })), 'latest', { strict: true });
      res = out.map((w, i) => {
        if (rows[i].venue !== 'v3') {
          if (!w || w === '0x') return null;
          const L = BigInt(w);
          // NFT yang belum dikenal node TIDAK revert di v4 — getPositionLiquidity menjawab 0.
          // Node yang tertinggal (ordofi ~2rb blok) karena itu melihat posisi target yang baru
          // dimint sebagai "kosong", dan cermin kita yang baru dibuka ditutup. Nol hanya
          // dipercaya untuk cermin yang sudah >10 menit, sama seperti revert di v3.
          if (L === 0n && Date.now() - (rows[i].opened_ts || 0) <= 10 * 60_000) return null;
          return L;
        }
        // Revert dipercaya sebagai "dibakar" hanya untuk cermin yang sudah >10 menit: node
        // yang tertinggal juga me-revert NFT target yang baru saja dimint.
        if (w == null) return Date.now() - (rows[i].opened_ts || 0) > 10 * 60_000 ? 0n : null;
        if (w === '0x') return null;
        try { return BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { return null; }
      });
    } catch (e) { this.trouble('rekon-baca', `rekonsiliasi keluar: ${e.message}`, { after: 5, afterMs: 5 * 60_000, level: 'warn' }); return; }
    this.cleared('rekon-baca', 'rekonsiliasi keluar: RPC terbaca lagi');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const liq = res[i];
      if (liq == null) { this.goneStreak.delete(r.id); continue; }   // tak terbaca: jangan bertindak
      if (liq > 0n) { this.goneStreak.delete(r.id); continue; }     // target masih di dalam
      const n = (this.goneStreak.get(r.id) || 0) + 1;
      this.goneStreak.set(r.id, n);
      if (n < 2 || this.exiting.has(r.id)) continue;
      this.goneStreak.delete(r.id);
      const msg = `posisi target #${r.mirror_of} sudah kosong tetapi cermin kita #${r.id} masih terbuka — menutup (sinyal keluar terlewat)`;
      this.store.log('warn', msg);
      try {
        const out = await this.executeExit({ venue: r.venue, action: 'burn', full: true, liquidity: r.liquidity, tokenId: r.token_id }, r);
        this.notify(`${msg} · ${out.note}`, {
          kind: 'exit', positionId: r.id, txHash: out.txHash, full: true, sold: out.sold, auto: true,
          target: r.target, mirrorOf: r.mirror_of, reason: 'sinyal keluar terlewat — posisi target sudah kosong',
        });
        this.cleared(`rekon:${r.id}`, null);
      } catch (e) { this.trouble(`rekon:${r.id}`, `rekonsiliasi tutup #${r.id} gagal: ${e.message}`, { after: 2 }); }
    }
  }

  // ---- pemeliharaan berkala ----------------------------------------------
  // Sinkron dipanggil tiap 30 detik oleh setInterval. Saat RPC lambat satu putaran bisa
  // lebih lama dari itu, dan putaran kedua yang jalan bersamaan membukukan hal yang sama
  // dua kali: closeEmptyPosition/bookPendingExits (hasil keluar dan penjualan sisa ganda),
  // bookPendingMints (baris posisi ganda). Satu putaran pada satu waktu.
  async syncPositions() {
    if (this.syncBusy || this.stopping) return;
    this.syncBusy = true;
    try { return await this.syncPositionsOnce(); }
    finally { this.syncBusy = false; }
  }

  async syncPositionsOnce() {
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    // Posisi yang dibuka di luar bot muncul tanpa perlu restart (tiap 10 menit).
    const addr = this.exec.address();
    if (addr && Date.now() - (this.lastAdopt || 0) > 10 * 60_000) {
      this.lastAdopt = Date.now();
      await this.adoptOwnPositions(addr);
    }
    // Setoran/penarikan eksternal → modal wallet (PnL bersih). Tiap 5 menit; galat
    // beruntun (Alchemy/arsip) ditangani seperti langkah lain, tidak menghentikan tick.
    if (addr && this.capital.available() && Date.now() - (this.capital.lastSync || 0) > 5 * 60_000) {
      await this.capital.sync(addr).then(() => this.cleared('modal', 'pelacakan setoran: berhasil lagi'))
        .catch((e) => this.trouble('modal', `pelacakan setoran: ${e.message}`, { after: 3, afterMs: 30 * 60_000 }));
    }
    // Semua langkah ini diulang tiap sinkron (30 detik) — galat sesaat tidak dikabarkan.
    const sekali = (key, label, p) => p.then(() => this.cleared(key, `${label}: berhasil lagi`))
      .catch((e) => this.trouble(key, `${label}: ${e.message}`, { after: 5, afterMs: 5 * 60_000 }));
    await sekali('compound', 'pencatatan compound', this.compound.reconcile());
    await sekali('claim', 'pencatatan claim fee', this.reconcileFeeClaims());
    await sekali('rekon', 'rekonsiliasi keluar', this.reconcileExits());
    await this.positions.sync(this.ethUsd);
    await sekali('buku-masuk', 'pembukuan mint tertunda', this.bookPendingMints());
    await sekali('buku-keluar', 'pembukuan tx keluar tertunda', this.bookPendingExits());
    await sekali('zap-yatim', 'pemulihan zap tanpa LP', this.recoverStrandedZaps());
    await sekali('kas', 'saldo kas', this.refreshCash());
    await sekali('sisa', 'nilai token sisa', this.positions.refreshLeftovers(this.ethUsd, this.exec.address()));
    // Aturan target posisinya sendiri (posisi manual/adopsi tanpa target: aturan global).
    const triggers = this.positions.exitTriggers((p) => this.rulesFrom(p.target));
    for (const t of triggers) {
      if (this.stopping) break;
      if (this.exiting.has(t.pos.id)) continue;
      if (t.pos.empty) {
        // Menutup di database tanpa transaksi = hasil $0 tercatat selamanya. Dibaca
        // ulang dulu; kalau ternyata masih ada, biarkan sinkron berikutnya yang menilai.
        if (await this.positions.confirmEmpty(t.pos)) await this.closeEmptyPosition(t.pos).catch((e) => this.store.log('warn', `tutup #${t.pos.id} yang kosong: ${e.message}`, { quiet: true }));
        else this.store.log('warn', `#${t.pos.id} terbaca kosong tapi tidak terkonfirmasi — tidak ditutup`, { quiet: true });
        continue;
      }
      if (this.dryRun() || !this.exec.address()) { this.store.log('info', `[simulasi] keluar #${t.pos.id}: ${t.reason}`); continue; }
      try {
        const out = await this.executeExit({ venue: t.pos.venue, action: 'burn', full: true, liquidity: t.pos.liquidity, tokenId: t.pos.token_id }, t.pos);
        this.notify(`keluar mandiri #${t.pos.id}: ${t.reason}`, {
          kind: 'exit', positionId: t.pos.id, txHash: out.txHash, full: true, sold: out.sold, auto: true,
          target: t.pos.target, mirrorOf: t.pos.mirror_of, reason: t.reason,
        });
        this.cleared(`keluar:${t.pos.id}`, null);                   // kartu penutupan = kabarnya
      } catch (e) {
        // Pemicunya masih berlaku, jadi diulang di sinkron berikutnya. Dua kali gagal
        // (~1 menit) sudah dikabarkan: dana sedang tidak terlindungi stop-loss.
        this.trouble(`keluar:${t.pos.id}`, `keluar mandiri gagal #${t.pos.id}: ${e.message}`, { after: 2 });
      }
    }
    if (!this.stopping) await this.compound.tick(Date.now(), new Set(triggers.map((t) => t.pos.id)));
  }

  // Cadangan ETH native untuk gas: tetap dari config, atau biaya satu transaksi terberat
  // saat harga gas tinggi (Executor.gasReserve). Exec tiruan di uji tidak punya: tetap.
  async gasReserve() {
    const fixed = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    if (!this.exec?.gasReserve) return fixed;
    try { return await this.exec.gasReserve(); } catch { return fixed; }
  }

  // ETH native di bawah cadangan gas tapi ada WETH: buka bungkus sampai cadangannya
  // penuh lagi. Tanpa ini wallet yang kasnya berupa WETH pelan-pelan kehabisan gas —
  // padahal yang paling butuh gas justru transaksi keluar. Gagal di sini tidak
  // menghentikan entry maupun keluar: sisa ETH native mungkin masih cukup.
  async topUpGas(notes) {
    const reserve = await this.gasReserve();
    let nat;
    try {
      const b = await this.exec.balances([ADDR.native, ADDR.weth]);
      nat = b.get(ADDR.native) || 0n;
      const weth = b.get(ADDR.weth) || 0n;
      if (nat >= reserve) return;
      if (weth > 0n) {
        const amt = weth < reserve - nat ? weth : reserve - nat;
        // Di bawah 1/10 cadangan tidak sepadan dengan gas unwrap-nya sendiri — tanpa batas
        // ini debu WETH memicu satu transaksi sia-sia di setiap entry dan exit.
        if (amt * 10n >= reserve) {
          const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth' });
          if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`tx ${h} gagal`);
          notes.push(`isi gas: buka bungkus ${fmtUnits(amt, 18)} WETH`);
          nat += amt;
        }
      }
    } catch (e) {
      this.store.log('warn', `isi gas dari WETH gagal: ${e.message}`, { quiet: true });   // dicoba lagi di transaksi berikutnya
      return;
    }
    // Tanpa WETH, kas USDG saja: ETH native habis = SEMUA transaksi gagal "insufficient
    // funds for gas" — termasuk menutup posisi dan menjual sisa (12 Sep 14:39–14:42:
    // tiga entry dan penjualan 18,86 FRONTIER gagal berturut-turut). Beli ETH secukupnya
    // dari USDG selagi masih ada gas untuk swap-nya. Hanya kalau sudah di bawah separuh
    // cadangan, supaya tidak menukar sedikit-sedikit di setiap transaksi.
    if (nat == null || nat * 2n >= reserve || !this.kyber?.swap) return;
    // Gagal (mis. ETH-nya bahkan tidak cukup untuk swap ini): jangan diulang di setiap
    // penjualan sisa tiap 5 detik — beri jeda 10 menit.
    if (Date.now() - (this.gasTopupFailedAt || 0) < 10 * 60_000) return;
    try {
      const rules = this.rulesFrom(null);
      if (rules?.swap?.enabled === false || !(this.ethUsd > 0)) return;
      const usdg = (await this.exec.balances([ADDR.usdg])).get(ADDR.usdg) || 0n;
      const want = Engine.gasTopupWei(reserve, nat, this.cfg);
      const pay = Engine.gasTopupUsdg(want, this.ethUsd, this.cfg);
      if (pay < 1_000_000n || usdg < pay) return;   // < $1 atau USDG tidak cukup
      const r = await this.kyber.swap(ADDR.usdg, ADDR.native, pay, { slippageBps: 100, maxLossBps: 300, kind: 'gas_topup' });
      if (r) notes.push(`isi gas: beli ${fmtUnits(want, 18)} ETH dari ${fmtUnits(pay, 6)} USDG`);
      else this.gasTopupFailedAt = Date.now();
    } catch (e) {
      this.gasTopupFailedAt = Date.now();
      this.store.log('warn', `isi gas dari USDG gagal: ${e.message}`, { quiet: true });
    }
  }

  // Berapa ETH yang dibeli isi gas. Cadangan dinamis = batas gas × maxFee, jadi lonjakan
  // harga gas — atau satu endpoint yang melaporkan eth_gasPrice ngawur — bisa membuatnya
  // 0,2+ ETH; tanpa batas, isi gas akan menukar ratusan dolar USDG ke ETH. Target
  // pembelian dibatasi 4× cadangan tetap, dan nilainya dibatasi gas.topup_max_usd ($25).
  static gasTopupWei(reserve, have, cfg) {
    const fixed = BigInt(cfg?.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    const target = reserve < fixed * 4n ? reserve : fixed * 4n;
    return target > have ? target - have : 0n;
  }
  static gasTopupUsdg(wei, ethUsd, cfg) {
    if (!(wei > 0n) || !(ethUsd > 0)) return 0n;
    const maxUsd = Number(cfg?.gas?.topup_max_usd ?? 25);
    const usd = Math.min((Number(wei) / 1e18) * ethUsd * 1.03, Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 25);
    return BigInt(Math.ceil(usd * 1e6));
  }

  // Kas yang bisa dipakai membuka posisi: USDG, dan ETH/WETH di atas cadangan gas (dalam
  // ETH). Dipisah per aset karena kas di aset kuotasi LAIN harus dijembatani dulu —
  // policy memotongnya lebih dalam. Sengaja dibaca segar (bukan this.cash yang bisa
  // berumur dua menit) karena hasilnya menentukan ukuran transaksi.
  async spendableCash() {
    const reserve = await this.gasReserve();
    const b = await this.exec.balances([ADDR.native, ADDR.usdg, ADDR.weth]);
    const ethLike = (b.get(ADDR.native) || 0n) + (b.get(ADDR.weth) || 0n);
    const eth = ethLike > reserve ? ethLike - reserve : 0n;
    let usdg = b.get(ADDR.usdg) || 0n;
    // ETH+WETH di bawah separuh cadangan: topUpGas akan membeli ETH dari USDG sebelum
    // entry. Tanpa dikurangi di sini, posisi diukur dari USDG yang sebagiannya habis
    // untuk gas, lalu gagal "kas kurang".
    if (ethLike * 2n < reserve && this.ethUsd > 0) {
      const gasUsdg = Engine.gasTopupUsdg(Engine.gasTopupWei(reserve, ethLike, this.cfg), this.ethUsd, this.cfg);
      // syarat yang sama dengan topUpGas: hanya kalau pembelian itu memang akan terjadi
      if (gasUsdg >= 1_000_000n && usdg >= gasUsdg) usdg -= gasUsdg;
    }
    return { usdg: Number(usdg) / 1e6, eth: Number(eth) / 1e18 };
  }

  // Kas di wallet (USDG + ETH + WETH) dalam USD. Dibaca ulang tiap sinkron posisi,
  // di detik yang sama dengan nilai posisi: kalau kas basi sementara posisi segar,
  // total portofolio menghitung dana dua kali sesaat setelah posisi dibuka.
  async refreshCash() {
    if (!this.exec.address()) { this.cash = null; return null; }
    const b = await this.exec.balances([ADDR.native, ADDR.usdg, ADDR.weth]);
    const eth = Number(b.get(ADDR.native) || 0n) / 1e18;
    const weth = Number(b.get(ADDR.weth) || 0n) / 1e18;
    const usdg = Number(b.get(ADDR.usdg) || 0n) / 1e6;
    this.cash = { usdg, eth, weth, usd: usdg + (eth + weth) * this.ethUsd, ts: Date.now() };
    return this.cash;
  }

  async snapshotEquity() {
    // Di tengah transaksi masuk/keluar kas sudah berpindah tapi posisinya belum
    // tercatat (atau sebaliknya): titiknya pasti salah. Lewati; 5 menit lagi ada lagi.
    if ((this.activeEntries || 0) > 0 || this.exiting.size > 0) return;
    // Kas SELALU dibaca ulang di sini, bukan dari cache tick. Cache itu diisi di awal
    // tick, SEBELUM posisi dibuka/ditutup di tick yang sama — snapshot yang memakainya
    // mencatat kas lama + posisi baru: total anjlok $139 saat #38 tutup, dan kurva PnL
    // bersih ikut menukik lalu melonjak. Tidak terbaca = NULL (titik dilewati grafik).
    const cash = this.exec.address() ? await this.refreshCash().catch(() => null) : null;
    const s = this.positions.summary(this.ethUsd);
    const w = cash ? cash.usd : null;   // tidak terbaca = NULL, bukan 0
    // Memecoin sisa yang belum terjual ikut dihitung sebagai "posisi": tanpa ini
    // kurva total anjlok saat posisi tutup dan melonjak lagi saat sisanya terjual.
    const lo = s.leftoverUsd || 0;
    this.store.run(
      'INSERT OR REPLACE INTO equity(ts,wallet_quote,positions_quote,total_quote,realized_quote,fees_quote,open_positions,pnl_quote) VALUES(?,?,?,?,?,?,?,?)',
      Date.now(), w, s.exposureUsd + lo, (w || 0) + s.exposureUsd + lo + s.feeUsd, s.realizedUsd, s.feeUsd, s.openCount,
      s.realizedUsd + s.unrealizedUsd);
  }

  // Titik ekuitas dari sebelum kolom pnl_quote ada. PnL-nya bisa direkonstruksi dari
  // yang sudah tercatat: terealisasi + nilai posisi + fee − modal posisi yang sedang
  // terbuka saat itu (diturunkan dari waktu buka/tutup tiap posisi).
  //
  // Posisi ADOPSI membawa opened_ts dari chain, jauh sebelum ia masuk database — di
  // titik-titik sebelum diadopsi ia belum ikut dinilai, jadi modalnya juga tidak boleh
  // dikurangkan. Jumlah posisi terbuka yang tercatat di titik itu (open_positions)
  // yang menentukan: kelebihan kandidat dibuang dari yang id-nya terbesar, karena
  // id mengikuti urutan masuk database.
  //
  // Versi 1 belum memperhitungkan adopsi; titik lama (kas NULL) dihitung ulang sekali.
  backfillEquityPnl() {
    const V = '2';
    const redo = this.store.getState('equity_pnl_backfill') !== V;
    const rows = this.store.all(`SELECT ts, positions_quote, fees_quote, realized_quote, open_positions FROM equity
      WHERE pnl_quote IS NULL${redo ? ' OR wallet_quote IS NULL' : ''}`);
    const pos = this.store.all("SELECT id, opened_ts, closed_ts, cost_quote, quote_symbol FROM positions WHERE status IN ('open','closed') ORDER BY id");
    for (const r of rows) {
      const cand = pos.filter((p) => p.opened_ts <= r.ts && (!p.closed_ts || p.closed_ts > r.ts))
        .slice(0, Math.max(0, r.open_positions ?? Infinity));
      const cost = cand.reduce((a, p) => a + (p.cost_quote || 0) * usdPerQuote(p.quote_symbol, this.ethUsd), 0);
      this.store.run('UPDATE equity SET pnl_quote=? WHERE ts=?',
        (r.realized_quote || 0) + (r.positions_quote || 0) + (r.fees_quote || 0) - cost, r.ts);
    }
    if (redo) this.store.setState('equity_pnl_backfill', V);
    return rows.length;
  }

  // `detail` (opsional) adalah data terstruktur kejadian itu — {kind:'entry'|'exit'|
  // 'leftover', positionId, txHash, ...}. ntfy tetap menerima teks polos; pendengar
  // yang bisa menata (bot Telegram) memakai detail untuk menyusun kartu yang rapi.
  notify(msg, detail = null) {
    const topic = this.cfg.notify?.ntfy_topic;
    // Pendengar tambahan (bot Telegram) dipasang dari luar; ia menerima kabar
    // penting yang sama dengan ntfy, tanpa perlu ikut mengintip semua baris log.
    // Sengaja dipanggil SEBELUM baris lognya ditulis: baris itu memicu store.onLog
    // dengan teks yang sama, dan pendengar hanya bisa menyaring gemanya kalau ia
    // sudah tahu kabar apa yang barusan dikirim.
    if (this.onNotify) { try { this.onNotify(msg, detail); } catch { /* abaikan */ } }
    this.store.log('info', msg);
    if (!topic) return;
    fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: `Quiver: ${msg}` }).catch(() => {});
  }
}

module.exports = { Engine };
