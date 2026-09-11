'use strict';
// Mesin utama: deteksi -> keputusan -> (swap) -> eksekusi -> pencatatan.
const { ethers } = require('ethers');
const { ADDR, QUOTES, TOPIC, ABI } = require('./chain');
const { Watcher } = require('./watcher');
const { Positions } = require('./positions');
const { Executor, isNative } = require('./executor');
const { Kyber } = require('./kyber');
const { rulesFor, planEntry, planExit, quoteToUsd } = require('./policy');
const { enumerateV4, livePositions } = require('./scout');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
// Jumlah mentah -> teks untuk pesan: 2 desimal di atas 1, 3 angka penting di bawahnya.
const fmtUnits = (raw, dec) => {
  const n = Number(raw) / 10 ** dec;
  return n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)));
};

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
  // terlihat "seandainya" -nya.
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
      this.store.setState('adopt_scanned_to', head);
      const known = new Set(this.store.all("SELECT token_id FROM positions WHERE venue='v4' AND token_id IS NOT NULL").map((r) => r.token_id));
      let missing = [...held.keys()].filter((id) => !known.has(id));
      if (!missing.length) return;
      // Transfer bisa menipu (urutan dalam satu blok); pastikan pemiliknya sekarang kita.
      const owners = await this.rpc.ethCallMany(missing.map((id) => ({
        to: ADDR.posmV4, data: new ethers.Interface(ABI.posmV4).encodeFunctionData('ownerOf', [BigInt(id)]),
      })));
      missing = missing.filter((id, i) => owners[i] && owners[i] !== '0x' && ('0x' + owners[i].slice(-40)).toLowerCase() === me);
      if (!missing.length) return;
      const rows = await livePositions(this.rpc, this.chain, missing);
      let n = 0;
      for (const r of rows) {
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
  async tick() {
    if (this.busy) return;
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
      for (const a of fresh) await this.handle(a);
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
    if (!t.enabled) return this.decide(act.id, 'skip', 'target sedang dimatikan');
    if (this.paused()) return this.decide(act.id, 'skip', 'bot sedang dijeda');
    const rules = this.rulesFrom(act.target);

    if (act.kind === 'increase') return this.handleEntry(act, rules);
    if (act.kind === 'decrease' || act.kind === 'transfer_out') return this.handleExit(act, rules);
    if (act.kind === 'custody_out') return this.decide(act.id, 'skip', 'posisi dititipkan ke kontrak otomasi — bukan sinyal keluar');
    if (act.kind === 'custody_in') return this.decide(act.id, 'skip', 'posisi dikembalikan dari kontrak otomasi');
    if (act.kind === 'transfer_in') return this.decide(act.id, 'skip', 'target menerima posisi dari wallet lain — tidak dicermin');
    return this.decide(act.id, 'skip', `jenis aksi ${act.kind} tidak dicermin`);
  }

  async handleEntry(act, rules) {
    if (!act.token0 || !act.token1 || (act.venue === 'v4' && !act.poolKey)) {
      return this.decide(act.id, 'skip', 'data pool posisi target tidak terbaca (NFT sudah dibakar?)');
    }
    // sudah punya cermin posisi ini? berarti ini penambahan; ikut tambah lewat mint baru
    const cd = rules.filters.cooldown_seconds * 1000;
    const last = this.lastCopyAt.get(act.poolRef) || 0;
    if (cd && Date.now() - last < cd) {
      return this.decide(act.id, 'skip', `cooldown pool ${Math.round((cd - (Date.now() - last)) / 1000)}s`);
    }
    const sum = this.positions.summary(this.ethUsd);
    const since = Date.now() - 86400_000;
    const spent = this.store.get(
      "SELECT COALESCE(SUM(cost_quote * CASE quote_symbol WHEN 'ETH' THEN ? ELSE 1 END),0) AS s FROM positions WHERE opened_ts > ?",
      this.ethUsd, since)?.s || 0;

    if (rules.filters.min_pool_age_minutes > 0 && act.venue === 'v4' && act.poolRef) {
      try {
        const age = await this.chain.poolAgeMinutes(act.poolRef);
        if (age < rules.filters.min_pool_age_minutes) {
          return this.decide(act.id, 'skip', `pool baru ${age.toFixed(0)} menit (< ${rules.filters.min_pool_age_minutes})`);
        }
      } catch { /* kalau tidak terbaca, jangan halangi */ }
    }
    const toks = await this.chain.tokens([act.token0, act.token1]);
    // Mode live: ukuran juga dibatasi kas nyata, supaya posisi yang sedikit kelebihan
    // dari saldo dibuka lebih kecil alih-alih gagal di tengah jembatan. Mode simulasi
    // sengaja tidak — wallet uji sering kosong, dan simulasinya jadi tidak berguna.
    const live = !this.dryRun() && this.exec.address();
    const cash = live ? await this.spendableCash().catch(() => null) : null;
    const ctx = {
      chain: this.chain, rules, slot0: act.slot0, dec0: toks[0].decimals, dec1: toks[1].decimals,
      ethUsd: this.ethUsd, openExposureUsd: sum.exposureUsd, spentTodayUsd: spent, openCount: sum.openCount,
      cash,
    };
    const d = planEntry(act, ctx);
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);

    // Kalau kita sudah punya cermin posisi ini, target sedang MENAMBAH — jadi kita
    // menambah juga, bukan membuka posisi kedua di rentang yang sama.
    const existing = this.store.get(
      "SELECT * FROM positions WHERE status='open' AND mirror_of=? AND target=? AND tick_lower=? AND tick_upper=?",
      act.tokenId ?? '', act.target, d.plan.tickLower, d.plan.tickUpper);
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
    // Cari cermin posisinya. Aksi transfer_out tidak membawa info pool sama sekali
    // (cuma tokenId), jadi query cadangan hanya dipakai kalau datanya memang ada —
    // mengikat undefined ke SQLite akan melempar.
    let pos = this.store.get(
      "SELECT * FROM positions WHERE status='open' AND mirror_of=? AND target=?", act.tokenId ?? '', act.target);
    if (!pos && act.poolRef && act.tickLower != null && act.tickUpper != null) {
      // Cadangan: cocokkan lewat pool + rentang. Target bisa punya beberapa posisi
      // identik di pool yang sama, jadi ambil yang TERTUA supaya deterministik, dan
      // catat pemakaiannya — kalau jalur ini sering terpakai, berarti mirror_of tidak
      // tercatat dengan benar saat masuk.
      pos = this.store.get(
        "SELECT * FROM positions WHERE status='open' AND pool_ref=? AND target=? AND tick_lower=? AND tick_upper=? ORDER BY id ASC LIMIT 1",
        act.poolRef, act.target, act.tickLower, act.tickUpper);
      if (pos) this.store.log('warn', `cermin posisi dicocokkan lewat pool+rentang (bukan tokenId) untuk aksi #${act.tokenId} -> posisi #${pos.id}`);
    }
    if (!pos) return this.decide(act.id, 'skip', 'tidak ada cermin posisi yang cocok');

    // Target memindahkan/menjual NFT posisinya: buat kita itu sinyal keluar penuh.
    if (act.kind === 'transfer_out') {
      const poolKeyT = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
      const planT = {
        venue: pos.venue, action: 'burn', full: true, positionId: pos.id, tokenId: pos.token_id,
        liquidity: pos.liquidity, poolKey: poolKeyT, poolRef: pos.pool_ref,
        mirrorOf: act.tokenId, target: act.target,
      };
      if (!rules.exit.follow_target) return this.decide(act.id, 'skip', 'ikut-keluar dimatikan');
      if (this.dryRun() || !this.exec.address()) return this.decide(act.id, 'dry', 'target memindahkan posisinya', planT);
      try {
        const r = await this.executeExit(planT, pos);
        this.decide(act.id, 'copy', `target memindahkan posisinya — ${r.note}`, planT, r.txHash, pos.id);
        this.notify(`LP ditutup: target memindahkan posisinya — ${r.note}`, {
          kind: 'exit', positionId: pos.id, txHash: r.txHash, full: true, sold: r.sold,
          target: act.target, mirrorOf: act.tokenId, reason: 'target memindahkan posisinya',
        });
      } catch (e) {
        this.stats.errors++;
        this.decide(act.id, 'error', String(e.message).slice(0, 300), planT);
      }
      return;
    }

    // berapa L target sebelum menarik? = L sekarang + yang ditarik
    let before = 0n;
    try {
      const [w] = await this.rpc.ethCallMany([{ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(act.tokenId)]) }]);
      const now = w && w !== '0x' ? BigInt(w) : 0n;
      before = now + (-BigInt(act.liquidity));
    } catch { /* biarkan 0 -> dianggap tutup penuh */ }
    const poolKey = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
    const d = planExit({ ...act, liquidityBefore: before }, { ...pos, poolKey }, { rules });
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);
    if (this.dryRun() || !this.exec.address()) return this.decide(act.id, 'dry', d.reason, d.plan);
    try {
      const r = await this.executeExit(d.plan, pos);
      this.decide(act.id, 'copy', `${d.reason} — ${r.note}`, d.plan, r.txHash, pos.id);
      this.notify(`LP ditutup: ${r.note}`, {
        kind: 'exit', positionId: pos.id, txHash: r.txHash, full: !!d.plan.full, sold: r.sold,
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
      });
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
    }
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
    const gasReserve = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
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
    const rules = this.rulesFrom(act.target);
    const pk = plan.poolKey;
    const need0 = BigInt(plan.amount0Max), need1 = BigInt(plan.amount1Max);
    const gasReserve = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000); // 0,002 ETH
    const notes = [];
    await this.topUpGas(notes);

    let bal = await this.exec.balances([plan.token0, plan.token1]);
    const avail = (t) => {
      let b = bal.get(t.toLowerCase()) || 0n;
      if (isNative(t)) b = b > gasReserve ? b - gasReserve : 0n;
      return b;
    };

    // 0. Pastikan kas sudah ada di aset kuotasi pool INI (bisa beda dari kas kita).
    if (plan.quoteSide != null && !(avail(plan.token0) >= need0 && avail(plan.token1) >= need1)) {
      const qTok = plan.quoteSide === 0 ? plan.token0 : plan.token1;
      const qMeta = await this.chain.token(qTok);
      const needQuoteRaw = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** (qMeta?.decimals ?? 18)));
      if (needQuoteRaw > 0n) {
        notes.push(...await this.ensureQuoteAsset(plan, rules, needQuoteRaw));
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

    // Hitung ulang setelah bridge DAN setiap zap. Maksimal dua swap agar harga
    // bergerak tidak membuat bot terus membeli/menjual bolak-balik.
    for (let swaps = 0; ; swaps++) {
      const needs = await refreshNeeds();
      const idx = avail(plan.token0) < needs.amount0 ? 0 : avail(plan.token1) < needs.amount1 ? 1 : null;
      if (idx == null) break;
      const affordableNow = m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1));
      if (swaps > 0 && affordableNow * 100n >= desiredL * 95n) break;
      if (swaps >= 2) throw new Error('harga berubah setelah swap; kebutuhan token belum terpenuhi — LP belum dibuka, dana tetap di wallet');
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
      if (payHave < payRaw) throw new Error(`saldo kurang untuk zap: butuh ~${payRaw} unit ${payTok.slice(0, 8)}…, punya ${payHave}`);
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
      const kz = await this.kyber.swap(payTok, buyTok, payRaw, {
        slippageBps: rules.swap.max_slippage_bps, maxLossBps: zapLossBps,
        kind: 'zap_swap', detail: { via: 'kyber', pool: plan.poolRef },
      });
      if (kz) {
        notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'} via Kyber`);
        bal = await this.exec.balances([plan.token0, plan.token1]);
        continue;
      }
      for (const a of await this.exec.ensureRouterAllowance(payTok)) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
      const zeroForOne = idx === 1;   // beli token1 -> jual token0
      // tolak zap yang menggeser harga pool terlalu jauh — ini yang membuat
      // "auto-swap" tidak berubah jadi menabrak pool tipis
      if (plan.venue === 'v4' && rules.swap.max_price_impact_bps > 0) {
        const poolL = await this.chain.poolLiquidity(plan.poolRef);
        const impact = m.priceImpactBps(s.sqrtPriceX96, poolL, payRaw, zeroForOne);
        if (impact != null && impact > rules.swap.max_price_impact_bps) {
          throw new Error(`zap butuh geser harga ${impact.toFixed(0)} bps (batas ${rules.swap.max_price_impact_bps})`);
        }
      }
      const minOut = (short * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;
      const swapTx = plan.venue === 'v3'
        ? this.exec.buildSwapV3(payTok, idx === 0 ? plan.token0 : plan.token1, plan.fee, payRaw, minOut, this.exec.deadline())
        : this.exec.buildSwapV4(pk, zeroForOne, payRaw, minOut, this.exec.deadline());
      const h = await this.exec.send(swapTx, { kind: 'zap_swap', detail: { pool: plan.poolRef, payRaw: payRaw.toString() } });
      const rc = await this.exec.waitReceipt(h);
      if (!rc.ok) throw new Error(`swap zap gagal (${h})`);
      notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'}`);
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
    const latestAmounts = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);
    if (L > desiredL || latestAmounts.amount0 > avail(plan.token0)
      || latestAmounts.amount1 > avail(plan.token1)
      || latestAmounts.amount0 > BigInt(finalPlan.amount0Max)
      || latestAmounts.amount1 > BigInt(finalPlan.amount1Max)) {
      throw new Error('harga berubah sebelum mint; kebutuhan token atau batas nilai berubah — LP belum dibuka, dana tetap di wallet');
    }
    amt = latestAmounts;
    const adding = plan.action === 'increase' && plan.tokenId;
    const tx = adding
      ? (plan.venue === 'v3'
        ? this.exec.buildV3Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline())
        : this.exec.buildV4Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline()))
      : (plan.venue === 'v3'
        ? this.exec.buildV3Mint({ ...finalPlan, amount0Min: 0, amount1Min: 0 }, this.exec.deadline())
        : this.exec.buildV4Mint(finalPlan, this.exec.deadline()));
    const hash = await this.exec.send(tx, { kind: adding ? 'increase' : 'mint', detail: { pool: plan.poolRef, target: plan.target, venue: plan.venue } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (!rc.ok) throw new Error(`mint gagal (${hash})`);

    // 4. tokenId dari log Transfer (0x0 -> kita)
    const me = this.exec.address();
    let tokenId = null;
    for (const l of rc.receipt.logs || []) {
      const mgr = plan.venue === 'v3' ? ADDR.npmV3 : ADDR.posmV4;
      if (l.address.toLowerCase() === mgr && l.topics[0] === TOPIC.transfer
        && asAddr(l.topics[1]) === '0x0000000000000000000000000000000000000000'
        && asAddr(l.topics[2]) === me) tokenId = BigInt(l.topics[3]).toString();
    }
    const toks = await this.chain.tokens([plan.token0, plan.token1]);
    const v = this.chain.valueInQuote({
      sqrtPriceX96: s2.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1,
      dec0: toks[0].decimals, dec1: toks[1].decimals, token0: plan.token0, token1: plan.token1,
    });
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
    const positionId = adding ? plan.positionId : this.positions.record(finalPlan, {
      tokenId, txHash: hash, target: plan.target,
      cost0: amt.amount0.toString(), cost1: amt.amount1.toString(), costQuote: v?.value ?? plan.valueQuote,
      entrySqrt: s2.sqrtPriceX96,
    });
    const pair = `${toks[0].symbol}/${toks[1].symbol}`;
    // v.value dinyatakan dalam aset kuotasi pool (bisa ETH), BUKAN dolar — dulu dicetak
    // langsung dengan "$" sehingga posisi 0,079 ETH terbaca "$0,08" alih-alih ~$195.
    const usdVal = quoteToUsd(v?.value ?? 0, v?.kind || 'usd', this.ethUsd);
    return {
      txHash: hash, positionId, adding: !!adding, pair, valueUsd: usdVal, curTick: s2.tick ?? null, steps: notes,
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

  async recordFeeClaim(pos, hash, receipt) {
    if (this.store.get('SELECT tx_hash FROM fee_claims WHERE tx_hash=?', hash)) return {};
    const detail = JSON.parse(this.store.get('SELECT detail FROM txs WHERE hash=?', hash)?.detail || '{}');
    const owner = String(detail.wallet || this.exec.address()).toLowerCase();
    const amount = async (token) => {
      if (!isNative(token)) {
        let value = 0n;
        for (const l of receipt.logs || []) {
          if (l.address.toLowerCase() !== token.toLowerCase() || l.topics[0] !== TOPIC.transfer || l.topics.length !== 3) continue;
          if (asAddr(l.topics[2]) === owner) value += BigInt(l.data);
          if (asAddr(l.topics[1]) === owner) value -= BigInt(l.data);
        }
        return value > 0n ? value : 0n;
      }
      // ETH native tidak punya Transfer. Baca saldo historis di blok receipt
      // agar retry setelah timeout tidak menghitung aktivitas wallet di blok lain.
      const bn = BigInt(receipt.blockNumber);
      const before = BigInt(await this.rpc.call('eth_getBalance', [owner, ethers.toQuantity(bn - 1n)]));
      const after = BigInt(await this.rpc.call('eth_getBalance', [owner, ethers.toQuantity(bn)]));
      const block = await this.rpc.call('eth_getBlockByNumber', [ethers.toQuantity(bn), true]);
      const others = (block?.transactions || []).filter((t) => t.hash !== hash
        && (String(t.from).toLowerCase() === owner || String(t.to).toLowerCase() === owner));
      if (!block || others.length) throw new Error('saldo ETH pada blok claim tidak dapat diisolasi');
      const value = after - before + BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
      return value > 0n ? value : 0n;
    };
    const amount0 = await amount(pos.token0), amount1 = await amount(pos.token1);
    const slot = pos.venue === 'v3' ? await this.chain.slot0V3(pos.pool_ref) : await this.chain.slot0V4(pos.pool_ref);
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
      WHERE t.kind='claim_fees' AND t.status!='gagal' AND f.tx_hash IS NULL ORDER BY t.ts LIMIT 20`);
    for (const row of rows) {
      const id = JSON.parse(row.detail || '{}').position;
      if (this.exiting.has(id)) continue;
      const pos = this.store.get('SELECT * FROM positions WHERE id=?', id);
      if (!pos) continue;
      this.exiting.add(id);
      try {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [row.hash]);
        if (!rc) continue;
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
    if (this.exiting.has(pos.id)) throw new Error('posisi ini sedang dalam proses ditutup');
    const claim = this.pendingFeeClaim(pos.id);
    if (claim && claim.status !== 'sukses') throw new Error('claim fee sebelumnya belum selesai — tunggu konfirmasi dan sinkronisasi');
    const cur = this.store.get('SELECT status FROM positions WHERE id=?', pos.id);
    if (cur && cur.status !== 'open') throw new Error('posisi sudah tertutup');
    this.exiting.add(pos.id);
    try { return await this.sendExit(plan, pos); }
    finally { this.exiting.delete(pos.id); }
  }

  async sendExit(plan, pos) {
    // Keluar juga butuh gas. Diisi SEBELUM saldo "sebelum" dibaca, supaya unwrap-nya
    // tidak terhitung sebagai hasil penutupan posisi berpasangan ETH.
    const gasNotes = [];
    await this.topUpGas(gasNotes);
    if (gasNotes.length) this.store.log('info', `sebelum tutup #${pos.id}: ${gasNotes.join(', ')}`);
    let tx;
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
    const before = await this.exec.balances([pos.token0, pos.token1]);
    const hash = await this.exec.send(tx, { kind: plan.full ? 'burn' : 'decrease', detail: { position: pos.id } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) throw new Error(`belum terkonfirmasi setelah 90 detik — tx ${hash} mungkin masih diproses, cek lagi sebentar`);
    if (!rc.ok) throw new Error(`transaksi keluar revert (${hash})`);
    const proceeds = await this.exitProceeds(pos, before, rc.receipt);
    // Posisi dicatat tertutup DULU — lengkap dengan memecoin sisa yang diterima dan
    // nilainya di harga tutup — baru sisanya dijual. Kalau penjualan berhasil,
    // recordLeftoverSale mengganti taksiran itu dengan hasil sesungguhnya; kalau
    // tersangkut, ekuitas tetap menilainya di harga kini, bukan menghilangkannya.
    if (plan.full) {
      const live = this.positions.live.find((p) => p.id === pos.id);
      let left = null;
      try { left = await this.leftoverOf(pos, rc.receipt, proceeds?.sqrt ?? live?.curSqrt ?? null); }
      catch (e) { this.store.log('warn', `sisa #${pos.id} tidak terukur: ${e.message}`, { quiet: true }); }
      this.positions.markClosed(pos.id, {
        out0: proceeds?.amount0 ?? live?.amount0, out1: proceeds?.amount1 ?? live?.amount1,
        outQuote: proceeds?.valueQuote ?? ((live?.valueUsd || 0) + (live?.feeUsd || 0)), txHash: hash,
        exitSqrt: proceeds?.sqrt ?? live?.curSqrt ?? null, left,
      });
    } else {
      this.store.run('UPDATE positions SET liquidity=? WHERE id=?',
        (BigInt(pos.liquidity) - BigInt(plan.liquidity)).toString(), pos.id);
    }
    // Jual memecoin yang BARU diterima dari transaksi keluar ini. Galatnya tidak boleh
    // membatalkan pencatatan keluar — posisinya sudah benar-benar tertutup di chain.
    let sold = null;
    try { sold = await this.sellLeftover(pos, rc.receipt, { quiet: true }); }
    // Gagal jual masuk antrean coba-ulang (keepLeftover); yang dikabarkan hanya kalau
    // antrean menyerah.
    catch (e) { this.store.log('error', `jual sisa #${pos.id}: ${e.message}`, { quiet: true }); }
    return { txHash: hash, sold, note: `${plan.full ? 'tutup penuh' : 'kurangi'} posisi #${pos.id}${sold ? ` · ${sold}` : ''}` };
  }

  // Berapa yang benar-benar masuk wallet dari transaksi keluar: selisih saldo, dengan
  // gas dikembalikan untuk sisi ETH native (gas mengurangi saldo tapi bukan bagian
  // dari hasil posisi). Nilainya dihitung di harga pool saat itu.
  async exitProceeds(pos, before, receipt) {
    try {
      const after = await this.exec.balances([pos.token0, pos.token1]);
      const d = (t) => {
        let v = (after.get(String(t).toLowerCase()) || 0n) - (before.get(String(t).toLowerCase()) || 0n);
        if (isNative(t) && receipt?.gasUsed && receipt?.effectiveGasPrice) {
          v += BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice);
        }
        return v > 0n ? v : 0n;
      };
      const amount0 = d(pos.token0), amount1 = d(pos.token1);
      if (amount0 === 0n && amount1 === 0n) return null;
      const s = pos.venue === 'v3' ? await this.chain.slot0V3(pos.pool_ref) : await this.chain.slot0V4(pos.pool_ref);
      const toks = await this.chain.tokens([pos.token0, pos.token1]);
      const v = s && this.chain.valueInQuote({
        sqrtPriceX96: s.sqrtPriceX96, amount0, amount1,
        dec0: toks[0].decimals, dec1: toks[1].decimals, token0: pos.token0, token1: pos.token1,
      });
      return { amount0: amount0.toString(), amount1: amount1.toString(), valueQuote: v ? v.value : null, sqrt: s?.sqrtPriceX96 ?? null };
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
    const bal = (await this.exec.balances([item.token])).get(item.token) || 0n;
    const amount = bal < BigInt(item.amount) ? bal : BigInt(item.amount);
    if (amount === 0n) { this.dropLeftover(item); return null; }
    const meta = await this.chain.token(item.token);
    const label = `${(Number(amount) / 10 ** (meta?.decimals ?? 18)).toPrecision(4)} ${meta?.symbol || item.token.slice(0, 8)}`;
    try {
      const r = await this.kyber.swap(item.token, item.quote, amount, {
        slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps,
        kind: 'sell_leftover', detail: { position: item.posId },
      });
      if (!r) throw new Error('Kyber tidak menemukan rute');
      this.dropLeftover(item);
      try {
        this.positions.recordLeftoverSale({ posId: item.posId, token: item.token, amount, quoteToken: item.quote,
          txHash: r.hash, amountOut: r.amountOut, usdOut: r.quote?.usdOut, ethUsd: this.ethUsd });
      } catch (e) { this.store.log('warn', `catat hasil jual sisa #${item.posId}: ${e.message}`, { quiet: true }); }
      const msg = `jual ${label} → $${(r.quote.usdOut || 0).toFixed(2)} (${r.quote.dex})`;
      if (!quiet) {
        this.notify(`posisi #${item.posId}: ${msg}`, {
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

  // Token yang tidak bisa dijual = uang yang tersangkut. Dikabarkan KERAS pada
  // kegagalan pertama, lalu diingatkan tiap 6 jam selama masih tersangkut — bukan
  // tiap percobaan: antrean mengecek tiap beberapa detik, dan kabar yang sama
  // ribuan kali hanya membuat orang kebal.
  alertLeftover(item, label, e) {
    const cur = this.leftovers().find((x) => x.posId === item.posId && x.token === item.token);
    if (!cur) return;
    const first = (cur.tries || 0) <= 1;
    const due = Date.now() - (cur.alertedAt || 0) > 6 * 3600_000;
    if (!first && !due) return;
    this.saveLeftovers(this.leftovers().map((x) => (x.posId === item.posId && x.token === item.token ? { ...x, alertedAt: Date.now() } : x)));
    this.notify(`SISA BELUM TERJUAL: ${label} dari posisi #${item.posId} — ${e.message}`, {
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
  // Item TIDAK pernah dibuang sendiri: uangnya masih tersangkut di wallet, jadi
  // peringatan dasbor dan daftar token swap harus terus melihatnya sampai terjual
  // atau dikeluarkan manual. `tries` cuma penghitung; jadwalnya tiap beberapa detik.
  keepLeftover(item, why) {
    const old = this.leftovers().find((x) => x.posId === item.posId && x.token === item.token);
    const list = this.leftovers().filter((x) => !(x.posId === item.posId && x.token === item.token));
    const tries = (item.tries || 0) + 1;
    const next = Date.now() + this.leftoverRetrySec() * 1000;
    list.push({ ...old, ...item, tries, next, why, since: old?.since || item.since || Date.now() });
    this.saveLeftovers(list);
    return { tries, next };
  }
  dropLeftover(item) {
    this.saveLeftovers(this.leftovers().filter((x) => !(x.posId === item.posId && x.token === item.token)));
  }

  // Dipanggil tiap detik (index.js). Tiap item dicek dengan SATU kutipan Kyber
  // (bukan build + kirim): kalau ruginya masih di atas batas, cukup catat dan
  // tunggu tick berikutnya. Baru kalau lolos, penjualan sungguhan dijalankan —
  // dengan pengaman yang sama seperti biasa. Jadi memburu likuiditas yang
  // sesaat membaik itu murah: satu HTTP ke Kyber per item per interval.
  async retryLeftovers() {
    if (this.dryRun() || !this.exec.address() || this.leftoverBusy) return;
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
    const rows = this.store.all(
      "SELECT * FROM positions WHERE status='open' AND venue='v4' AND target IS NOT NULL AND mirror_of IS NOT NULL AND token_id IS NOT NULL");
    if (!rows.length) { this.goneStreak = new Map(); return; }
    this.goneStreak = this.goneStreak || new Map();
    let res;
    try {
      res = await this.rpc.ethCallMany(rows.map((r) => ({
        to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.mirror_of)]),
      })));
    } catch (e) { this.trouble('rekon-baca', `rekonsiliasi keluar: ${e.message}`, { after: 5, afterMs: 5 * 60_000, level: 'warn' }); return; }
    this.cleared('rekon-baca', 'rekonsiliasi keluar: RPC terbaca lagi');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const raw = res[i];
      if (!raw || raw === '0x') { this.goneStreak.delete(r.id); continue; }   // tak terbaca: jangan bertindak
      if (BigInt(raw) > 0n) { this.goneStreak.delete(r.id); continue; }       // target masih di dalam
      const n = (this.goneStreak.get(r.id) || 0) + 1;
      this.goneStreak.set(r.id, n);
      if (n < 2 || this.exiting.has(r.id)) continue;
      this.goneStreak.delete(r.id);
      const msg = `posisi target #${r.mirror_of} sudah kosong tetapi cermin kita #${r.id} masih terbuka — menutup (sinyal keluar terlewat)`;
      this.store.log('warn', msg);
      try {
        const out = await this.executeExit({ venue: 'v4', action: 'burn', full: true, liquidity: r.liquidity, tokenId: r.token_id }, r);
        this.notify(`${msg} · ${out.note}`, {
          kind: 'exit', positionId: r.id, txHash: out.txHash, full: true, sold: out.sold, auto: true,
          target: r.target, mirrorOf: r.mirror_of, reason: 'sinyal keluar terlewat — posisi target sudah kosong',
        });
        this.cleared(`rekon:${r.id}`, null);
      } catch (e) { this.trouble(`rekon:${r.id}`, `rekonsiliasi tutup #${r.id} gagal: ${e.message}`, { after: 2 }); }
    }
  }

  // ---- pemeliharaan berkala ----------------------------------------------
  async syncPositions() {
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    // Posisi yang dibuka di luar bot muncul tanpa perlu restart (tiap 10 menit).
    const addr = this.exec.address();
    if (addr && Date.now() - (this.lastAdopt || 0) > 10 * 60_000) {
      this.lastAdopt = Date.now();
      await this.adoptOwnPositions(addr);
    }
    // Semua langkah ini diulang tiap sinkron (30 detik) — galat sesaat tidak dikabarkan.
    const sekali = (key, label, p) => p.then(() => this.cleared(key, `${label}: berhasil lagi`))
      .catch((e) => this.trouble(key, `${label}: ${e.message}`, { after: 5, afterMs: 5 * 60_000 }));
    await sekali('claim', 'pencatatan claim fee', this.reconcileFeeClaims());
    await sekali('rekon', 'rekonsiliasi keluar', this.reconcileExits());
    await this.positions.sync(this.ethUsd);
    await sekali('kas', 'saldo kas', this.refreshCash());
    await sekali('sisa', 'nilai token sisa', this.positions.refreshLeftovers(this.ethUsd, this.exec.address()));
    const globalRules = rulesFor(this.cfg.rules);
    const triggers = this.positions.exitTriggers(globalRules);
    for (const t of triggers) {
      if (this.exiting.has(t.pos.id)) continue;
      if (t.pos.empty) { this.positions.markClosed(t.pos.id, { outQuote: 0, txHash: null }); continue; }
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
  }

  // ETH native di bawah cadangan gas tapi ada WETH: buka bungkus sampai cadangannya
  // penuh lagi. Tanpa ini wallet yang kasnya berupa WETH pelan-pelan kehabisan gas —
  // padahal yang paling butuh gas justru transaksi keluar. Gagal di sini tidak
  // menghentikan entry maupun keluar: sisa ETH native mungkin masih cukup.
  async topUpGas(notes) {
    const reserve = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    try {
      const b = await this.exec.balances([ADDR.native, ADDR.weth]);
      const nat = b.get(ADDR.native) || 0n, weth = b.get(ADDR.weth) || 0n;
      if (nat >= reserve || weth <= 0n) return;
      const amt = weth < reserve - nat ? weth : reserve - nat;
      // Di bawah 1/10 cadangan tidak sepadan dengan gas unwrap-nya sendiri — tanpa batas
      // ini debu WETH memicu satu transaksi sia-sia di setiap entry dan exit.
      if (amt * 10n < reserve) return;
      const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth' });
      if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`tx ${h} gagal`);
      notes.push(`isi gas: buka bungkus ${fmtUnits(amt, 18)} WETH`);
    } catch (e) {
      this.store.log('warn', `isi gas dari WETH gagal: ${e.message}`, { quiet: true });   // dicoba lagi di transaksi berikutnya
    }
  }

  // Kas yang bisa dipakai membuka posisi: USDG, dan ETH/WETH di atas cadangan gas (dalam
  // ETH). Dipisah per aset karena kas di aset kuotasi LAIN harus dijembatani dulu —
  // policy memotongnya lebih dalam. Sengaja dibaca segar (bukan this.cash yang bisa
  // berumur dua menit) karena hasilnya menentukan ukuran transaksi.
  async spendableCash() {
    const reserve = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    const b = await this.exec.balances([ADDR.native, ADDR.usdg, ADDR.weth]);
    const ethLike = (b.get(ADDR.native) || 0n) + (b.get(ADDR.weth) || 0n);
    const eth = ethLike > reserve ? ethLike - reserve : 0n;
    return { usdg: Number(b.get(ADDR.usdg) || 0n) / 1e6, eth: Number(eth) / 1e18 };
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
    const s = this.positions.summary(this.ethUsd);
    let cash = this.cash;
    if (this.exec.address() && (!cash || Date.now() - cash.ts > 120_000)) cash = await this.refreshCash().catch(() => null);
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
      const cost = cand.reduce((a, p) => a + (p.cost_quote || 0) * (p.quote_symbol === 'ETH' ? this.ethUsd : 1), 0);
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
