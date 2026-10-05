'use strict';
// Mesin copy-LP Solana. Antarmuka luarnya sama dengan Engine EVM (index.js, dasbor, dan
// bot Telegram memanggil tick/syncPositions/snapshotEquity/retryLeftovers, dryRun,
// paused, positions.*, exec.address, ethUsd, …) dan ia menulis tabel yang sama
// (actions, decisions, positions, txs, equity) — jadi dasbor dan Telegram menampilkan
// posisi Solana tanpa cabang khusus.
//
// Bagian yang tidak bergantung pada chain (keputusan, jeda, breaker drawdown, antrean
// masuk/keluar, anggaran harian, antrean token sisa, ekuitas, kabar) DIPINJAM langsung
// dari Engine.prototype — satu sumber kebenaran untuk aturan yang sama. Yang ditulis
// ulang di sini: pemindaian (watcher Solana), eksekusi masuk/keluar lewat adapter
// venue + Jupiter, dan kas (SOL/wSOL/USDC/USDT).
const { Engine } = require('../engine');
const { rulesFor, planExit, quoteToUsd, usdPerQuote } = require('../policy');
const m = require('../v3math');
const { SolanaWatcher } = require('./watcher');
const { SolanaPositions } = require('./positions');
const { SolanaExecutor } = require('./executor');
const { planEntrySol } = require('./planner');
const { WSOL } = require('../networks');

const fmtUnits = (raw, dec) => {
  const n = Number(raw) / 10 ** dec;
  return n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)));
};
const fmtPct = (x) => (x >= 1000 ? '999+' : x.toFixed(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minB = (a, b) => (a < b ? a : b);

// Metode Engine yang murni aturan/pembukuan — dipakai apa adanya.
const BORROWED = [
  'sk', 'rulesFrom', 'trouble', 'cleared', 'dryRun', 'paused', 'setPaused',
  'maxDailyDrawdownPct', 'dayKey', 'updateDrawdown', 'drawdownTripped', 'drawdownStatus',
  'idle', 'drain', 'enqueue', 'settled', 'pump', 'queued', 'decide', 'handle',
  'spentTodayUsd', 'increasesUsdSince', 'leftoverRetrySec', 'leftovers', 'saveLeftovers', 'sameLeftover',
  'keepLeftover', 'dropLeftover', 'snapshotEquity', 'backfillEquityPnl', 'notify', 'freshCash',
  'reentryNearPct', 'reentryKey', 'watchReentry', 'reentryWatches', 'alertLeftover',
];

class SolanaEngine {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    this.log = log || console.log;
    this.exec = new SolanaExecutor({ rpc, store, chain, cfg, log: this.log });
    this.exec.ethUsd = () => this.ethUsd;
    this.watcher = new SolanaWatcher({ rpc, store, chain, cfg, log: this.log });
    this.positions = new SolanaPositions({ rpc, store, chain, log: this.log, balances: () => this.exec.balances() });
    this.ethUsd = cfg.prices?.eth_usd || 150;
    this.cursor = 0; this.head = 0; this.headSpread = 0;
    this.busy = false;
    this.exiting = new Set();
    this.selling = new Set();
    this.troubles = new Map();
    this.lastCopyAt = new Map();
    this.stats = { scanned: 0, actions: 0, copied: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    this.lastError = null;
    this.cash = null; this.cashSeq = -1;
    // Setoran/penarikan → modal wallet & PnL bersih (tabel dan rumus sama dengan EVM).
    this.capital = new (require('./capital').SolanaCapital)({ engine: this, rpc, store, chain, cfg, log: this.log });
    // Panen fee otomatis: pengaturan & jadwal sama dengan EVM (src/compound.js),
    // transaksinya lewat adapter venue (src/solana/compound.js).
    this.compound = new (require('./compound').SolanaCompound)(this);
  }

  get network() { return this.chain.network; }
  get label() { return this.chain.label; }
  static isExitKind(kind) { return Engine.isExitKind(kind); }

  // ---- mulai ------------------------------------------------------------------
  async init() {
    const addr = this.exec.address();
    if (addr) this.store.setState(this.sk('wallet_address'), addr);
    this.head = await this.rpc.slot();
    this.cursor = this.head;
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    this.log(`mulai di slot ${this.head}; wallet ${addr || '(belum diisi — mode simulasi)'}; SOL $${this.ethUsd.toFixed(2)}`);
    if (addr) await this.adoptOwnPositions(addr).catch((e) => this.log(`adopsi posisi sendiri: ${e.message}`));
    await this.backfillDecisions();
  }

  // Aksi tercatat tanpa keputusan (proses mati di tengah). LIVE: yang basi dilewati.
  async backfillDecisions() {
    const stale = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const rows = this.store.all(`SELECT a.* FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE d.id IS NULL AND a.chain=? ORDER BY a.ts ASC LIMIT 500`, this.network);
    for (const r of rows) {
      if (Date.now() - r.ts > stale && !this.dryRun()) { this.decide(r.id, 'skip', 'aksi lampau — mesin sedang mati saat itu'); continue; }
      try { await this.handle(SolanaWatcher.actFromRow(r)); } catch (e) { this.decide(r.id, 'error', String(e.message).slice(0, 200)); }
    }
  }

  // Posisi LP milik wallet kita yang belum tercatat (dibuka manual / proses mati sebelum
  // sempat mencatat) diadopsi: modal = nilai sekarang (tidak diketahui berapa awalnya).
  async adoptOwnPositions(addr) {
    const known = new Set(this.store.all('SELECT token_id FROM positions WHERE chain=? AND token_id IS NOT NULL', this.network).map((r) => r.token_id));
    for (const [venue, a] of Object.entries(this.chain.adapters)) {
      let list;
      try { list = await a.listPositions(addr, (mm) => this.chain.decimalsMap(mm)); } catch (e) { this.log(`adopsi ${venue}: ${e.message}`); continue; }
      for (const p of list) {
        if (known.has(p.id) || BigInt(p.liquidity) === 0n) continue;
        const st = await this.chain.pool(venue, p.pool).catch(() => null);
        if (!st) continue;
        const v = this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: p.amount0, amount1: p.amount1, dec0: st.dec0, dec1: st.dec1, token0: st.token0, token1: st.token1 });
        const q = this.chain.quoteSideOf(st.token0, st.token1);
        // Posisi yang dibuka bot tapi belum sempat dibukukan (proses mati di tengah):
        // ditautkan lagi ke target & aksi asalnya, modalnya isi posisi sebenarnya.
        const pkey = this.sk(`sol_pending_entry:${p.id}`);
        let pend = null;
        try { pend = JSON.parse(this.store.getState(pkey) || 'null'); } catch { pend = null; }
        // Entry yang masih berjalan membukukan posisinya sendiri — jangan diadopsi dobel.
        if (pend && (this.activeEntries || 0) > 0) continue;
        if (pend) {
          const id = this.positions.record({ ...pend.plan, liquidity: String(p.liquidity), amount0: String(p.amount0), amount1: String(p.amount1), tickLower: p.tickLower, tickUpper: p.tickUpper, lower: p.lower, upper: p.upper },
            { tokenId: p.id, target: pend.target, cost0: p.amount0, cost1: p.amount1, costQuote: v?.value ?? pend.plan.valueQuote, entrySqrt: st.sqrtX96, ext: p.ext, openedTs: pend.ts });
          this.store.run('DELETE FROM state WHERE k=?', pkey);
          this.store.log('warn', `posisi ${venue} ${p.id.slice(0, 8)}… dari entry yang terputus dibukukan sebagai #${id} (cermin target ${String(pend.target || '').slice(0, 8)}…)`);
          continue;
        }
        const id = this.positions.record({
          venue, poolRef: p.pool, token0: st.token0, token1: st.token1, fee: st.fee, tickSpacing: st.tickSpacing,
          tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: p.liquidity, amount0: String(p.amount0), amount1: String(p.amount1),
          valueQuote: v?.value ?? 0, quoteSymbol: q?.symbol ?? null, lower: p.lower, upper: p.upper, binStep: st.binStep ?? null,
        }, { tokenId: p.id, entrySqrt: st.sqrtX96, ext: p.ext });
        this.log(`posisi ${venue} ${p.id.slice(0, 8)}… milik wallet diadopsi sebagai #${id} (modal = nilai sekarang)`);
      }
    }
  }

  // ---- satu putaran pemindaian ---------------------------------------------------
  async tick() {
    if (this.stopping || this.busy) return;
    if (this.rpc.allCooling()) return;
    this.busy = true;
    try {
      this.head = await this.rpc.slot();
      this.cursor = this.head;
      const raw = await this.watcher.scan();
      const fresh = await this.watcher.persist(raw);
      this.stats.actions += fresh.length;
      this.enqueue(fresh);
      if (fresh.length && this.onFreshActions) {
        try { this.onFreshActions(fresh); } catch (e) { this.store.log('error', `onFreshActions: ${e.message}`); }
      }
      this.cleared('tick', `pemindaian target: kembali normal di slot ${this.head}`);
    } catch (e) {
      this.stats.errors++;
      this.lastError = String(e.message).slice(0, 250);
      this.trouble('tick', `tick: ${e.message}`, { after: 5, afterMs: 3 * 60_000 });
    } finally { this.busy = false; }
  }

  async noteTargetClaim(act) { return this.decide(act.id, 'skip', 'klaim fee target tidak dicermin'); }

  async staleEntry(act) {
    if (this.dryRun()) return null;
    const max = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const age = Date.now() - (act.ts || Date.now());
    return age > max ? `sinyal masuk sudah ${Math.round(age / 60000)} menit — terlalu basi untuk disalin` : null;
  }

  // ---- masuk ------------------------------------------------------------------
  async handleEntry(act, rules) {
    const stale = await this.staleEntry(act);
    if (stale) return this.decide(act.id, 'skip', stale);
    if (!act.poolRef || !act.token0 || !act.token1) return this.decide(act.id, 'skip', 'data pool posisi target tidak terbaca');
    const cd = rules.filters.cooldown_seconds * 1000;
    const last = this.lastCopyAt.get(act.poolRef) || 0;
    if (cd && Date.now() - last < cd) return this.decide(act.id, 'skip', `cooldown pool ${Math.round((cd - (Date.now() - last)) / 1000)}s`);

    if (rules.filters.min_pool_age_minutes > 0) {
      try {
        const age = await this.chain.poolAgeMinutes(act.poolRef);
        if (age < rules.filters.min_pool_age_minutes) return this.decide(act.id, 'skip', `pool baru ${age.toFixed(0)} menit (< ${rules.filters.min_pool_age_minutes})`);
      } catch { /* kalau tidak terbaca, jangan halangi — sama dengan EVM */ }
    }
    const pool = await this.chain.pool(act.venue, act.poolRef, { maxAgeMs: 0 });
    const sum = this.positions.summary(this.ethUsd);
    const live = !this.dryRun() && this.exec.address();
    const cash = live ? await this.spendableCash().catch(() => null) : null;
    const mirrors = this.store.all("SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? AND token_id IS NOT NULL ORDER BY id",
      this.network, act.tokenId ?? '', act.target);
    const held = mirrors.find((mp) => mp.takeover_ts != null);
    if (held) return this.decide(act.id, 'skip', `posisi #${held.id} dalam kendali manual — tambahan target tidak diikuti`);
    const usdOf = (mp) => {
      const lv = this.positions.live.find((p) => p.id === mp.id);
      return lv?.valueUsd ?? Math.max(0, (mp.cost_quote || 0) - (mp.out_quote || 0)) * usdPerQuote(mp.quote_symbol, this.ethUsd, this.chain);
    };
    const mirror = mirrors[0] || null;
    const d = planEntrySol(act, {
      chain: this.chain, rules, pool, ethUsd: this.ethUsd,
      openExposureUsd: sum.exposureUsd, spentTodayUsd: this.spentTodayUsd(), openCount: sum.openCount,
      cash, existingUsd: mirror ? usdOf(mirror) : null,
    });
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);

    const far = rules.exit.out_of_range_pct > 0 ? m.distanceFromRangePct(pool.tick, d.plan.tickLower, d.plan.tickUpper) : 0;
    if (far > rules.exit.out_of_range_pct) {
      // Sama dengan EVM: kalau buka-lagi menyala, posisi target dipantau dan cermin dibuka
      // begitu harga mendekat.
      const watch = this.watchReentry(act, rules, { why: 'ditunda', actionId: act.id });
      return this.decide(act.id, 'skip', `rentang ${fmtPct(far)}% dari harga (batas ${rules.exit.out_of_range_pct}%) — ${
        watch ? `ditunda; dibuka begitu harga ≤ ${watch.nearPct}% dari rentang dan target masih di dalam` : 'tidak disalin'}`);
    }
    if (mirror) {
      d.plan.action = 'increase'; d.plan.tokenId = mirror.token_id; d.plan.positionId = mirror.id;
      d.reason = `${d.reason} (menambah posisi #${mirror.id})`;
    }
    if (this.dryRun() || !this.exec.address()) {
      // Ada wallet: transaksi entry disimulasikan di mainnet (tanpa dikirim), seperti EVM.
      const sim = this.exec.address() ? await this.simulateEntry(d.plan).catch((e) => ({ ok: false, error: e.message })) : null;
      const note = sim ? (sim.ok ? `simulasi OK (${sim.cu} CU)` : `simulasi GAGAL: ${String(sim.error).slice(0, 160)}`) : 'tanpa wallet';
      return this.decide(act.id, 'dry', `${d.reason} — ${note}`, d.plan);
    }
    this.activeEntries = (this.activeEntries || 0) + 1;
    try {
      const r = await this.executeEntry(d.plan, act);
      this.lastCopyAt.set(act.poolRef, Date.now());
      this.decide(act.id, 'copy', `${d.reason} — ${r.note}`, d.plan, r.txHash, r.positionId);
      this.notify(`LP disalin: ${r.note}`, {
        kind: 'entry', positionId: r.positionId, txHash: r.txHash, adding: !!r.adding,
        pair: r.pair, valueUsd: r.valueUsd, curTick: pool.tick, steps: r.steps,
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
      });
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
      this.store.log('error', `eksekusi masuk: ${e.message}`);
    } finally { this.activeEntries--; }
  }

  // Simulasi transaksi entry (mode simulasi dengan wallet): susun lewat adapter dengan
  // jumlah rencana, lalu simulateTransaction — tidak ada yang dikirim.
  async simulateEntry(plan) {
    const ad = this.chain.adapter(plan.venue);
    const owner = this.exec.address();
    const built = plan.action === 'increase'
      ? await ad.buildIncrease({ pool: plan.poolRef, position: plan.tokenId, amount0: BigInt(plan.amount0), amount1: BigInt(plan.amount1), slippageBps: plan.slippageBps ?? 150, owner, strategy: plan.strategy || null })
      : await ad.buildOpen({ pool: plan.poolRef, lower: plan.lower, upper: plan.upper, amount0: BigInt(plan.amount0), amount1: BigInt(plan.amount1), slippageBps: plan.slippageBps ?? 150, owner, strategy: plan.strategy || 'spot' });
    return this.exec.simulateGroups(built.groups);
  }

  // Catatan entry tertunda yang posisinya tidak pernah muncul (tx tidak masuk) dibuang
  // sesudah 30 menit.
  prunePendingEntries() {
    for (const r of this.store.all("SELECT k, v FROM state WHERE k LIKE 'sol_pending_entry:%' AND k LIKE ?", `%:${this.network}`)) {
      let pend; try { pend = JSON.parse(r.v); } catch { pend = null; }
      if (!pend || Date.now() - pend.ts > 30 * 60_000) this.store.run('DELETE FROM state WHERE k=?', r.k);
    }
  }

  // Kas yang boleh dipakai: stablecoin (USDC+USDT) dan SOL (native + wSOL) di atas cadangan.
  async spendableCash() {
    const b = await this.exec.balances();
    const reserve = this.exec.gasReserveCached();
    const solAll = (b.get('SOL') || 0n) + (b.get(WSOL) || 0n);
    const sol = solAll > reserve ? solAll - reserve : 0n;
    const usd = Number(b.get(this.chain.ADDR.usdg) || 0n) / 1e6 + Number(b.get(this.chain.ADDR.usdt) || 0n) / 1e6;
    return { usd, sol: Number(sol) / 1e9 };
  }

  // Tersedia untuk sebuah mint: wSOL dihitung bersama SOL native di atas cadangan (SDK
  // venue membungkus SOL sendiri); mint lain = saldo akun token.
  availOf(bal, mint) {
    if (mint === WSOL) {
      const all = (bal.get('SOL') || 0n) + (bal.get(WSOL) || 0n);
      const r = this.exec.gasReserveCached();
      return all > r ? all - r : 0n;
    }
    return bal.get(mint) || 0n;
  }

  // Sumber dana untuk membeli kekurangan senilai `usd`: aset kuotasi pool dulu, lalu kas
  // lain (USDC/USDT/SOL). Balikan [mint, jumlah mentah] atau null.
  fundSource(bal, usd, prefer) {
    const order = [prefer, this.chain.ADDR.usdg, this.chain.ADDR.usdt, WSOL].filter((x, i, a) => x && a.indexOf(x) === i);
    for (const mint of order) {
      const have = this.availOf(bal, mint);
      const px = mint === WSOL ? this.ethUsd : 1;
      const dec = mint === WSOL ? 9 : 6;
      const needRaw = BigInt(Math.ceil((usd / px) * 10 ** dec));
      if (this.chain.QUOTES[mint] && have >= needRaw) return [mint, needRaw];
    }
    return null;
  }

  async executeEntry(plan, act) {
    const owner = this.exec.address();
    const rules = this.rulesFrom(act?.target ?? null);
    const steps = [];
    await this.topUpGas(steps);
    const toks = await this.chain.tokens([plan.token0, plan.token1]);
    const [t0, t1] = toks;
    let bal = await this.exec.balances();
    const balStart = new Map(bal);
    const bought = new Map();   // mint -> jumlah yang dibeli entry ini (batas jual-kembali)
    const want0 = BigInt(plan.amount0), want1 = BigInt(plan.amount1);
    const q = this.chain.quoteSideOf(plan.token0, plan.token1);
    const quoteMint = q.side === 0 ? plan.token0 : plan.token1;

    // 1) beli kekurangan tiap sisi lewat Jupiter (tepat-masuk, dilebihkan slippage)
    const slip = rules.swap.max_slippage_bps;
    const ad = this.chain.adapter(plan.venue);
    let built, sent, pre = null, a0 = 0n, a1 = 0n;
    try {
    for (const [mint, want, t] of [[plan.token0, want0, t0], [plan.token1, want1, t1]]) {
      const have = this.availOf(bal, mint);
      if (want <= have) continue;
      if (!rules.swap.enabled) throw new Error(`kurang ${t.symbol} dan tukar otomatis dimatikan`);
      const short = want - have;
      const px = (await this.chain.jup.prices([mint])).get(mint);
      if (!px) throw new Error(`harga ${t.symbol} tidak diketahui Jupiter`);
      const usd = (Number(short) / 10 ** t.decimals) * px * (1 + (slip + 50) / 10_000);
      const src = this.fundSource(bal, usd, mint === quoteMint ? null : quoteMint);
      if (!src) throw new Error(`kas tidak cukup untuk membeli ${fmtUnits(short, t.decimals)} ${t.symbol} (~$${usd.toFixed(2)})`);
      const r = await this.swap(src[0], mint, src[1], { slippageBps: slip, maxLossBps: rules.swap.max_price_impact_bps, kind: 'entry_swap' });
      steps.push(`tukar → ${fmtUnits(r.out, t.decimals)} ${t.symbol}`);
      bought.set(mint, (bought.get(mint) || 0n) + r.out);
      bal = await this.balancesAfter(bal, mint, r.out);
    }

    // 2) jumlah akhir: sebanding rencana, dibatasi yang benar-benar ada di wallet
    const h0 = this.availOf(bal, plan.token0), h1 = this.availOf(bal, plan.token1);
    const f0 = want0 > 0n ? (h0 * 1_000_000n) / want0 : 1_000_000n, f1 = want1 > 0n ? (h1 * 1_000_000n) / want1 : 1_000_000n;
    const f = minB(1_000_000n, minB(f0, f1));
    a0 = (want0 * f) / 1_000_000n; a1 = (want1 * f) / 1_000_000n;
    if (a0 === 0n && a1 === 0n) throw new Error('jumlah token untuk posisi nol');

    // 3) buka / tambah. Tambah: isi posisi dibaca TEPAT sebelum kirim — modal tambahan =
    // isi sesudah − isi sebelum (potret sinkron bisa berumur 30 detik).
    if (plan.action === 'increase') {
      pre = (await ad.getPositions([{ id: plan.tokenId, pool: plan.poolRef }], (mm) => this.chain.decimalsMap(mm))).get(plan.tokenId);
      if (!pre) throw new Error(`posisi #${plan.positionId} tidak terbaca dari chain`);
    }
    // Galat di SIMULASI (belum ada yang terkirim) — biasanya harga bergeser melewati pita
    // slippage di antara susun & eksekusi (Raydium PriceSlippageCheck, dst): susun ulang
    // sekali di harga terbaru. Galat sesudah terkirim tidak diulang di sini.
    for (let attempt = 1; ; attempt++) {
      try {
        built = plan.action === 'increase'
          ? await ad.buildIncrease({ pool: plan.poolRef, position: plan.tokenId, amount0: a0, amount1: a1, slippageBps: slip, owner, strategy: plan.strategy || null })
          : await ad.buildOpen({ pool: plan.poolRef, lower: plan.lower, upper: plan.upper, amount0: a0, amount1: a1, slippageBps: slip, owner, strategy: plan.strategy || 'spot' });
        // Posisi baru dicatat "tertunda" sebelum dikirim: kalau proses mati sesudah tx
        // masuk tapi sebelum dibukukan, adopsi berikutnya menautkannya lagi ke target.
        if (plan.action !== 'increase') {
          this.store.setState(this.sk(`sol_pending_entry:${built.position}`), JSON.stringify({ ts: Date.now(), target: act?.target ?? null, mirrorOf: plan.mirrorOf ?? null, plan: { ...plan, lower: built.native?.lower ?? plan.lower, upper: built.native?.upper ?? plan.upper } }));
        }
        sent = await this.exec.sendGroups(built.groups, { kind: plan.action === 'increase' ? 'increase' : 'mint', detail: { venue: plan.venue, pool: plan.poolRef } });
        break;
      } catch (e) {
        if (attempt >= 2 || !/^simulasi /.test(String(e.message))) throw e;
        this.store.log('warn', `${plan.venue}: ${String(e.message).slice(0, 160)} — disusun ulang di harga terbaru`, { quiet: true });
        await sleep(800);
      }
    }
    } catch (e) {
      // Galat di tengah (swap kedua, susun/kirim transaksi): token yang sudah terbeli
      // untuk entry ini tidak boleh telantar.
      await this.rescueTokens(bought, balStart, `entry gagal (${String(e.message).slice(0, 80)})`).catch(() => {});
      throw e;
    }
    const hash = sent.hashes[sent.hashes.length - 1] || null;
    if (!sent.ok) {
      // Token yang sudah terbeli untuk posisi ini tidak boleh telantar: dijual lagi.
      await this.rescueTokens(bought, balStart, `entry gagal (${hash || 'tx tidak masuk'})`);
      throw new Error(`transaksi ${plan.action} gagal${hash ? ` (${hash})` : ''}`);
    }

    // 4) catat: modal = isi posisi sesungguhnya (dibaca ulang dari chain)
    const posId = plan.action === 'increase' ? plan.tokenId : built.position;
    let got = null;
    for (let i = 0; i < 5 && !got; i++) {
      try { got = (await ad.getPositions([{ id: posId, pool: plan.poolRef }], (mm) => this.chain.decimalsMap(mm))).get(posId); } catch { got = null; }
      if (!got) await sleep(1500);
    }
    const pool = await this.chain.pool(plan.venue, plan.poolRef, { maxAgeMs: 0 }).catch(() => null);
    const sqrt = pool?.sqrtX96 ?? null;
    // Modal dibukukan dalam satuan kuotasi baris: posisi baru = kuotasi rencana, tambah =
    // kuotasi baris lama (lihat SolanaChain.valueAs).
    const rowSym = plan.action === 'increase' ? this.store.get('SELECT quote_symbol FROM positions WHERE id=?', plan.positionId)?.quote_symbol : plan.quoteSymbol;
    const val = (x0, x1) => (sqrt ? this.chain.valueAs({ sqrtPriceX96: sqrt, amount0: x0, amount1: x1, dec0: t0.decimals, dec1: t1.decimals, token0: plan.token0, token1: plan.token1 }, rowSym, this.ethUsd) : null);
    let positionId, cost0, cost1;
    if (plan.action === 'increase') {
      const row = this.store.get('SELECT * FROM positions WHERE id=?', plan.positionId);
      const prevL = BigInt(row.liquidity || '0');
      cost0 = got ? BigInt(got.amount0) - BigInt(pre.amount0) : a0;
      cost1 = got ? BigInt(got.amount1) - BigInt(pre.amount1) : a1;
      if (cost0 < 0n || cost1 < 0n) { cost0 = a0; cost1 = a1; }
      const add = val(cost0, cost1) ?? plan.valueQuote;
      this.store.run('UPDATE positions SET liquidity=?, cost0=?, cost1=?, cost_quote=COALESCE(cost_quote,0)+? WHERE id=?',
        got ? String(got.liquidity) : String(prevL), (BigInt(row.cost0 || '0') + cost0).toString(), (BigInt(row.cost1 || '0') + cost1).toString(), add, row.id);
      positionId = row.id;
    } else {
      cost0 = got ? BigInt(got.amount0) : a0; cost1 = got ? BigInt(got.amount1) : a1;
      const lo = built.native?.lower ?? plan.lower, hi = built.native?.upper ?? plan.upper;
      const tk = got ? { tickLower: got.tickLower, tickUpper: got.tickUpper } : (pool ? ad.ticksOf(pool, lo, hi) : { tickLower: plan.tickLower, tickUpper: plan.tickUpper });
      positionId = this.positions.record({ ...plan, ...tk, liquidity: got ? String(got.liquidity) : '0', amount0: String(cost0), amount1: String(cost1), lower: lo, upper: hi },
        { tokenId: posId, txHash: hash, target: act?.target ?? null, cost0, cost1, costQuote: val(cost0, cost1) ?? plan.valueQuote, entrySqrt: sqrt, ext: { ...(got?.ext || {}), ...(plan.strategy ? { strategy: plan.strategy } : {}) } });
    }
    if (plan.action !== 'increase') this.store.run('DELETE FROM state WHERE k=?', this.sk(`sol_pending_entry:${posId}`));
    // Sisa token hasil tukar yang tidak masuk posisi (slippage / pembulatan) dijual lagi.
    await this.rescueTokens(bought, balStart, null, { minUsd: 0.5 });
    const valueUsd = quoteToUsd(val(cost0, cost1) ?? plan.valueQuote, plan.quoteKind, this.ethUsd);
    const pair = `${t0.symbol}/${t1.symbol}`;
    return {
      txHash: hash, positionId, adding: plan.action === 'increase', pair, valueUsd, steps,
      note: `${plan.action === 'increase' ? 'tambah' : 'buka'} ${plan.venue} ${pair} $${valueUsd.toFixed(2)} (#${positionId})${steps.length ? ` · ${steps.join(' · ')}` : ''}`,
    };
  }

  // Saldo sesudah swap. Endpoint lain bisa belum melihat tx yang baru terkonfirmasi:
  // dibaca ulang sampai saldo mint yang dibeli benar-benar naik (≥ 90% hasil swap), maks
  // ~6 detik. Dua bacaan basi yang SAMA bukan tanda sudah terbaru.
  async balancesAfter(before, mint, gained) {
    const need = this.availOf(before, mint) + (gained * 9n) / 10n;
    let b = null;
    for (let i = 0; i < 10; i++) {
      b = await this.exec.balances();
      if (this.availOf(b, mint) >= need) return b;
      await sleep(600);
    }
    return b;
  }

  // ---- tukar (Jupiter) ---------------------------------------------------------------
  // Dengan pagar rugi: nilai USD yang masuk vs keluar menurut harga Jupiter tidak boleh
  // selisih lebih dari maxLossBps (dampak harga + fee rute). Balikan {hash, out}.
  async swap(inMint, outMint, amount, { slippageBps = 100, maxLossBps = 500, kind = 'swap' } = {}) {
    const q = await this.chain.jup.quote(inMint, outMint, amount, { slippageBps });
    const [ti, to] = await this.chain.tokens([inMint, outMint]);
    const px = await this.chain.jup.prices([inMint, outMint]).catch(() => new Map());
    const usdIn = px.get(inMint) ? (Number(amount) / 10 ** ti.decimals) * px.get(inMint) : null;
    const usdOut = px.get(outMint) ? (Number(q.outAmount) / 10 ** to.decimals) * px.get(outMint) : null;
    if (usdIn && usdOut) {
      const lossBps = Math.round(((usdIn - usdOut) / usdIn) * 10_000);
      if (lossBps > maxLossBps) {
        const e = new Error(`rute ${ti.symbol}→${to.symbol} rugi ${(lossBps / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%)`);
        e.loss = { usdIn, usdOut, lossBps, maxLossBps };
        throw e;
      }
    }
    const { tx, lastValidBlockHeight } = await this.chain.jup.swapTx(q, this.exec.address(), { maxPriorityLamports: Number(this.cfg.gas?.jupiter_max_priority_lamports ?? 2_000_000) });
    const r = await this.exec.sendVersioned(tx, { kind, lastValidBlockHeight, detail: { in: inMint, out: outMint, amountIn: String(amount), quoteOut: q.outAmount, usdIn, usdOut } });
    if (!r.ok) throw new Error(`swap ${ti.symbol}→${to.symbol} gagal (${r.hash})`);
    // hasil sesungguhnya dari meta tx (bukan kutipan)
    // Meta tx tidak terbaca (node tertinggal): pakai kutipan. Tanpa pagar ini keluaran
    // ke SOL terbaca "0 + biaya" = 5000 lamport (ditemukan lewat simulasi mainnet).
    let out = BigInt(q.outAmount);
    if (r.meta) {
      const dl = this.exec.deltas(r.meta);
      const got = outMint === WSOL ? (dl.get(WSOL) ?? 0n) + (dl.get('SOL') ?? 0n) + BigInt(r.fee || 0) : (dl.get(outMint) ?? 0n);
      if (got > 0n) out = got;
    }
    this.exec.noteTx(r.hash, { actualOut: out.toString() });
    return { hash: r.hash, out, quoteOut: BigInt(q.outAmount), usdIn, usdOut };
  }

  // Jual kembali token non-kuotasi yang DIBELI entry ini tapi tidak masuk posisi (entry
  // gagal / kelebihan tukar). Yang dijual paling banyak min(dibeli, saldo kini − saldo
  // sebelum entry) — token yang memang dipegang wallet sebelumnya tidak pernah disentuh.
  async rescueTokens(bought, balStart, why, { minUsd = 0 } = {}) {
    if (!bought.size) return;
    const rules = this.rulesFrom(null);
    const bal = await this.exec.balances().catch(() => null);
    if (!bal) return;
    for (const [mint, got] of bought) {
      if (this.chain.QUOTES[mint]) continue;
      const extra = (bal.get(mint) || 0n) - (balStart.get(mint) || 0n);
      const amt = minB(got, extra);
      if (amt <= 0n) continue;
      const t = await this.chain.token(mint);
      const px = (await this.chain.jup.prices([mint]).catch(() => new Map())).get(mint);
      const usd = px ? (Number(amt) / 10 ** t.decimals) * px : 0;
      if (usd < minUsd) continue;
      try {
        await this.swap(mint, this.chain.ADDR.usdg, amt, { slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps, kind: 'rescue_sell' });
        if (why) this.store.log('warn', `${why}: ${fmtUnits(amt, t.decimals)} ${t.symbol} dijual kembali`);
      } catch (e) {
        this.keepLeftover({ posId: null, token: mint, amount: amt.toString(), label: t.symbol, rescue: true }, e.message);
        this.store.log('warn', `${t.symbol} sisa entry belum terjual: ${e.message}`);
      }
    }
  }

  // ---- keluar -----------------------------------------------------------------------
  async handleExit(act, rules) {
    const pos = this.store.get("SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? ORDER BY id LIMIT 1",
      this.network, act.tokenId ?? '', act.target);
    if (pos?.takeover_ts != null) return this.decide(act.id, 'skip', `posisi #${pos.id} dalam kendali manual — keluar target tidak diikuti`);
    const d = planExit(act, pos, { rules });
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);
    // Porsi yang bulat ke 0 bps tidak dikirim: dulu dipaksa 1 bps (0,01%) — lebih besar
    // dari gerakan target yang remeh, dan tetap membayar biaya transaksi.
    if (!d.plan.full && (BigInt(d.plan.liquidity) * 10_000n) / BigInt(pos.liquidity || '1') === 0n) {
      return this.decide(act.id, 'skip', 'porsi tarik < 0,01% — terlalu kecil untuk dicermin');
    }
    if (this.dryRun() || !this.exec.address()) return this.decide(act.id, 'dry', d.reason, d.plan);
    try {
      const r = await this.executeExitRetry(d.plan, pos);
      this.decide(act.id, 'copy', `${d.reason} — ${r.note}`, d.plan, r.txHash, pos.id);
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
      this.store.log('error', `eksekusi keluar #${pos.id}: ${e.message}`);
    }
  }

  pendingExitKey(id) { return this.sk(`sol_pending_exit:${id}`); }

  // plan: {full, liquidity (L yang ditarik)}. `force` (tutup paksa dasbor) diterima demi
  // antarmuka yang sama; di Solana tidak ada compound tertunda yang bisa menghalangi.
  async executeExit(plan, pos, { force = false } = {}) {
    void force;
    if (this.exiting.has(pos.id)) throw new Error(`posisi #${pos.id} sedang ditutup`);
    this.exiting.add(pos.id);
    try {
      const owner = this.exec.address();
      const ad = this.chain.adapter(pos.venue);
      const rules = this.rulesFrom(pos.target);
      await this.topUpGas([]);
      const before = (await ad.getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(pos.token_id);
      if (before === undefined) { const e = new Error('posisi tidak terbaca dari chain'); e.notSent = true; throw e; }
      if (before === null) { await this.closeEmptyPosition(pos); return { note: 'akun posisi sudah tidak ada', txHash: null }; }
      const ourL = BigInt(before.liquidity);
      const takeL = plan.full ? ourL : minB(ourL, BigInt(plan.liquidity));
      const full = plan.full || takeL >= ourL;
      const bps = ourL > 0n ? Number((takeL * 10_000n) / ourL) : 10_000;
      const built = await ad.buildDecrease({
        pool: pos.pool_ref, position: pos.token_id, liquidity: takeL, bps: Math.max(1, bps), close: full,
        slippageBps: rules.swap.max_slippage_bps, owner,
      });
      // Isi posisi sebelum keluar dicatat SEBELUM mengirim: kalau proses mati atau
      // konfirmasi tak terbaca, sinkron berikutnya membukukan hasilnya dari catatan ini.
      const pend = { ts: Date.now(), full, bps, ourL: ourL.toString(), before: SolanaEngine.slimPos(before) };
      this.store.setState(this.pendingExitKey(pos.id), JSON.stringify(pend));
      let sent;
      try { sent = await this.exec.sendGroups(built.groups, { kind: full ? 'burn' : 'decrease', detail: { venue: pos.venue, position: pos.id } }); }
      catch (e) {
        // Gagal di simulasi / ditolak semua endpoint: belum ada yang terkirim.
        this.store.run('DELETE FROM state WHERE k=?', this.pendingExitKey(pos.id));
        if (/^simulasi |ditolak semua endpoint/.test(String(e.message))) e.notSent = true;
        throw e;
      }
      const hash = sent.hashes[sent.hashes.length - 1] || null;
      if (!sent.ok) {
        const e = new Error(`transaksi keluar ${sent.last?.expired ? 'tidak masuk (blockhash kedaluwarsa)' : 'gagal'}${hash ? ` (${hash})` : ''}`);
        // Kedaluwarsa = pasti tidak masuk → boleh dicoba lagi. Batas tunggu habis = belum
        // pasti → catatan tertunda dibiarkan, sinkron yang memutuskan.
        if (sent.last?.expired || sent.last?.error) { this.store.run('DELETE FROM state WHERE k=?', this.pendingExitKey(pos.id)); e.notSent = !!sent.last?.expired; }
        throw e;
      }
      const r = await this.bookExit(pos, pend, hash, rules);
      this.store.run('DELETE FROM state WHERE k=?', this.pendingExitKey(pos.id));
      return r;
    } finally { this.exiting.delete(pos.id); }
  }

  static slimPos(p) {
    return { liquidity: String(p.liquidity), amount0: String(p.amount0), amount1: String(p.amount1), fee0: String(p.fee0), fee1: String(p.fee1) };
  }

  // Bukukan hasil keluar dari isi posisi yang dibaca tepat sebelum transaksi.
  async bookExit(pos, pend, hash, rules) {
    const b = pend.before;
    const full = pend.full, bps = pend.bps, ourL = BigInt(pend.ourL);
    const takeL = full ? ourL : (ourL * BigInt(bps)) / 10_000n;
    // Hasil = porsi isi posisi + fee yang ikut terkirim. Tutup penuh: seluruh fee.
    // Tarik sebagian: Raydium (DecreaseLiquidityV2) ikut mengirim SEMUA fee yang
    // terkumpul; DLMM (removeLiquidity tanpa klaim) dan Orca (decreaseLiquidity) tidak.
    const feesOut = full || pos.venue === 'raydium';
    const frac = (x) => (full ? BigInt(x) : (BigInt(x) * BigInt(bps)) / 10_000n);
    const out0 = frac(b.amount0) + (feesOut ? BigInt(b.fee0) : 0n);
    const out1 = frac(b.amount1) + (feesOut ? BigInt(b.fee1) : 0n);
    const st = await this.chain.pool(pos.venue, pos.pool_ref, { maxAgeMs: 0 }).catch(() => null);
    const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
    const sqrt = st?.sqrtX96 ?? null;
    const val = (x0, x1) => (sqrt ? this.chain.valueAs({ sqrtPriceX96: sqrt, amount0: x0, amount1: x1, dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 }, pos.quote_symbol, this.ethUsd) ?? 0 : 0);
    const outQuote = val(out0, out1);
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    const memeMint = q.side === 0 ? pos.token1 : pos.token0;
    const memeAmt = q.side === 0 ? out1 : out0;
    const memeQuote = q.side === 0 ? val(0n, out1) : val(out0, 0n);
    // Sisi "memecoin" yang ternyata aset kuotasi juga (SOL di pool SOL/USDC) adalah kas,
    // bukan sisa yang harus dijual.
    const left = memeAmt > 0n && !this.chain.QUOTES[memeMint] ? { token: memeMint, amount: memeAmt.toString(), quote: memeQuote } : null;
    if (full) this.positions.markClosed(pos.id, { out0, out1, outQuote, txHash: hash, exitSqrt: sqrt, left });
    else this.positions.markDecreased(pos.id, { liquidity: (ourL - takeL).toString(), out0, out1, outQuote, txHash: hash, left });
    const k = usdPerQuote(pos.quote_symbol, this.ethUsd, this.chain);
    const note = `${full ? 'tutup' : `tarik ${(bps / 100).toFixed(1)}%`} #${pos.id} ${t0.symbol}/${t1.symbol} → $${(outQuote * k).toFixed(2)}`;
    this.notify(`LP ${full ? 'ditutup' : 'dikurangi'}: ${note}`, {
      kind: 'exit', positionId: pos.id, txHash: hash, full, pair: `${t0.symbol}/${t1.symbol}`,
      outUsd: outQuote * k, costUsd: (pos.cost_quote || 0) * k, target: pos.target,
    });
    if (left && rules.exit.sell_leftover) await this.sellLeftover({ posId: pos.id, token: memeMint, amount: memeAmt.toString(), label: q.side === 0 ? t1.symbol : t0.symbol, target: pos.target, quote: q.side === 0 ? pos.token0 : pos.token1 });
    this.positions.resync(this.ethUsd).catch(() => {});
    return { note, txHash: hash };
  }

  // Keluar yang BELUM terkirim (simulasi gagal, ditolak endpoint, blockhash kedaluwarsa)
  // dicoba lagi 3/10/30 dtk kemudian — asal posisi di chain masih sama persis. Yang
  // sudah mungkin terkirim tidak pernah dikirim ulang: menarik dua kali.
  async executeExitRetry(plan, pos, { waits = this.exitRetryWaits || [3000, 10_000, 30_000] } = {}) {
    for (let i = 0; ; i++) {
      if (i > 0 && this.store.get('SELECT takeover_ts FROM positions WHERE id=?', pos.id)?.takeover_ts != null) {
        throw new Error(`posisi #${pos.id} diambil alih manual — keluar otomatis dibatalkan`);
      }
      try { return await this.executeExit(plan, pos); }
      catch (e) {
        if (!e.notSent || i >= waits.length) throw e;
        this.store.log('warn', `keluar #${pos.id} belum terkirim (${String(e.message).slice(0, 160)}) — coba lagi dalam ${waits[i] / 1000} dtk (${i + 2}/${waits.length + 1})`, { quiet: true });
        await sleep(waits[i]);
        const L = await this.chainLiquidity(pos).catch(() => null);
        if (L != null && L < BigInt(pos.liquidity)) throw new Error(`likuiditas posisi #${pos.id} di chain sudah berubah — tidak dikirim ulang`);
      }
    }
  }

  // Keluar yang terkirim tapi belum dibukukan (proses mati / konfirmasi tak terbaca):
  // posisi di chain dibandingkan dengan isi yang dicatat sebelum kirim. Hilang atau L
  // turun sebanyak yang ditarik = transaksinya masuk → dibukukan; tidak berubah dan
  // sudah > 3 menit = tidak masuk → catatan dibuang.
  async bookPendingExits() {
    for (const r of this.store.all("SELECT k, v FROM state WHERE k LIKE 'sol_pending_exit:%' AND k LIKE ?", `%:${this.network}`)) {
      const id = Number(r.k.split(':')[1]);
      if (this.exiting.has(id)) continue;
      let pend; try { pend = JSON.parse(r.v); } catch { this.store.run('DELETE FROM state WHERE k=?', r.k); continue; }
      const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", id);
      if (!pos) { this.store.run('DELETE FROM state WHERE k=?', r.k); continue; }
      const got = (await this.chain.adapter(pos.venue).getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(pos.token_id);
      if (got === undefined) continue;
      const Lnow = got ? BigInt(got.liquidity) : 0n, L0 = BigInt(pend.ourL);
      const landed = got === null || (pend.full ? Lnow === 0n : Lnow < L0);
      if (landed) {
        this.exiting.add(id);
        try {
          const tx = this.store.get("SELECT hash FROM txs WHERE chain=? AND kind IN ('burn','decrease') AND json_extract(detail,'$.position')=? ORDER BY ts DESC LIMIT 1", this.network, id);
          await this.bookExit(pos, pend, tx?.hash || null, this.rulesFrom(pos.target));
          this.store.log('warn', `keluar #${id} yang tertunda ternyata masuk — dibukukan sekarang`);
        } finally { this.exiting.delete(id); this.store.run('DELETE FROM state WHERE k=?', r.k); }
      } else if (Date.now() - pend.ts > 3 * 60_000) {
        this.store.run('DELETE FROM state WHERE k=?', r.k);
        this.store.log('warn', `keluar #${id} tidak pernah masuk — catatan tertunda dibuang, pemicu keluar akan menilai ulang`);
      }
    }
  }

  // Cermin yang posisi targetnya sudah hilang dari chain tapi sinyal keluarnya terlewat
  // (pengamat melewatkan / keluar gagal): ditutup. Dua pembacaan berturut-turut, dan
  // hanya untuk cermin > 10 menit (node tertinggal bisa belum melihat posisi baru).
  async reconcileExits() {
    if (this.dryRun() || !this.exec.address()) return;
    const rows = this.store.all("SELECT * FROM positions WHERE chain=? AND status='open' AND target IS NOT NULL AND mirror_of IS NOT NULL AND token_id IS NOT NULL AND takeover_ts IS NULL", this.network);
    this.goneStreak ??= new Map();
    if (!rows.length) { this.goneStreak.clear(); return; }
    const byVenue = new Map();
    for (const r of rows) {
      const act = this.store.get('SELECT pool_ref FROM actions WHERE chain=? AND token_id=? AND pool_ref IS NOT NULL ORDER BY id DESC LIMIT 1', this.network, r.mirror_of);
      (byVenue.get(r.venue) || byVenue.set(r.venue, []).get(r.venue)).push({ r, pool: act?.pool_ref || r.pool_ref });
    }
    for (const [venue, list] of byVenue) {
      let got;
      try { got = await this.chain.adapter(venue).getPositions(list.map((x) => ({ id: x.r.mirror_of, pool: x.pool })), (mm) => this.chain.decimalsMap(mm)); }
      catch (e) { this.trouble('rekon-baca', `rekonsiliasi keluar: ${e.message}`, { after: 5, afterMs: 5 * 60_000, level: 'warn' }); continue; }
      for (const { r } of list) {
        const t = got.get(r.mirror_of);
        const gone = t === null || (t && BigInt(t.liquidity) === 0n);
        if (!gone || Date.now() - (r.opened_ts || 0) < 10 * 60_000) { this.goneStreak.delete(r.id); continue; }
        const n = (this.goneStreak.get(r.id) || 0) + 1;
        this.goneStreak.set(r.id, n);
        if (n < 2 || this.exiting.has(r.id)) continue;
        this.goneStreak.delete(r.id);
        const msg = `posisi target ${r.mirror_of.slice(0, 8)}… sudah kosong tetapi cermin kita #${r.id} masih terbuka — menutup (sinyal keluar terlewat)`;
        this.store.log('warn', msg);
        try {
          const out = await this.executeExitRetry({ full: true, liquidity: r.liquidity }, r);
          this.notify(`${msg} · ${out.note}`, { kind: 'exit', positionId: r.id, txHash: out.txHash, full: true, auto: true, target: r.target, mirrorOf: r.mirror_of, reason: 'sinyal keluar terlewat — posisi target sudah kosong' });
          this.cleared(`rekon:${r.id}`, null);
        } catch (e) { this.trouble(`rekon:${r.id}`, `rekonsiliasi tutup #${r.id} gagal: ${e.message}`, { after: 2 }); }
      }
    }
  }

  // Akun posisi sudah tidak ada tanpa tx keluar dari bot (ditutup di luar bot): ditutup di
  // pembukuan pada nilai terakhir yang diketahui — BUKAN $0, yang akan membukukan rugi palsu.
  async closeEmptyPosition(pos) {
    if (this.store.getState(this.pendingExitKey(pos.id))) return this.bookPendingExits();
    if (!(await this.positions.confirmEmpty(pos))) throw new Error(`posisi #${pos.id} belum pasti kosong`);
    const lv = this.positions.live.find((p) => p.id === pos.id);
    const k = usdPerQuote(pos.quote_symbol, this.ethUsd, this.chain) || 1;
    const outQuote = lv && !lv.valueStale ? ((lv.valueUsd || 0) + (lv.feeUsd || 0)) / k : 0;
    this.positions.markClosed(pos.id, { out0: 0n, out1: 0n, outQuote, txHash: null, exitSqrt: lv?.curSqrt ?? null });
    this.store.log('warn', `posisi #${pos.id} sudah tidak ada di chain (ditutup di luar bot) — dibukukan pada nilai terakhir $${(outQuote * k).toFixed(2)}`);
  }

  async chainLiquidity(pos) {
    const got = (await this.chain.adapter(pos.venue).getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(pos.token_id);
    return got ? BigInt(got.liquidity) : 0n;
  }

  // Likuiditas posisi target sekarang (dipakai buka-lagi & dasbor LP manual).
  async targetLiquidity(venue, tokenId) {
    const act = this.store.get('SELECT pool_ref FROM actions WHERE chain=? AND token_id=? AND pool_ref IS NOT NULL ORDER BY id DESC LIMIT 1', this.network, String(tokenId));
    const got = (await this.chain.adapter(venue).getPositions([{ id: String(tokenId), pool: act?.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(String(tokenId));
    if (got === undefined) return null;
    return got ? { liquidity: BigInt(got.liquidity), position: got } : { liquidity: 0n, position: null };
  }

  // ---- klaim fee ----------------------------------------------------------------------
  // Klaim di Solana dibukukan langsung sesudah konfirmasi (tidak ada receipt tertunda).
  pendingFeeClaim() { return null; }
  sellFeeWanted(id, override = null) { return Engine.prototype.sellFeeWanted.call(this, id, override); }

  // `sell`: jual sisi memecoin fee ke aset kuotasi pool sesudah klaim (null = ikut
  // pengaturan panen otomatis posisi). Sama dengan EVM.
  async claimFees(id, opts = {}) {
    if (this.dryRun() || !this.exec.address()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (this.exiting.has(id)) throw new Error('posisi ini sedang diproses');
    const pos = this.store.get("SELECT * FROM positions WHERE chain=? AND id=? AND status='open'", this.network, id);
    if (!pos) throw new Error('posisi tidak ditemukan');
    this.exiting.add(id);
    try {
      const ad = this.chain.adapter(pos.venue);
      await this.topUpGas([]);
      const before = (await ad.getPositions([{ id: pos.token_id, pool: pos.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(pos.token_id);
      if (!before) throw new Error('posisi tidak terbaca');
      const built = await ad.buildClaim({ pool: pos.pool_ref, position: pos.token_id, owner: this.exec.address() });
      const sent = await this.exec.sendGroups(built.groups, { kind: 'claim_fees', detail: { position: pos.id } });
      const hash = sent.hashes[sent.hashes.length - 1] || null;
      if (!sent.ok) throw new Error(`klaim gagal${hash ? ` (${hash})` : ''}`);
      const claim = await this.bookFeeClaim(pos, before.fee0, before.fee1, hash);
      this.positions.resync(this.ethUsd).catch(() => {});
      let sold = null;
      if (this.sellFeeWanted(id, opts.sell) && claim.meme) {
        this.positions.noteFeeLeftover({ posId: pos.id, token: claim.meme.token, amount: claim.meme.amount, estQuote: claim.meme.quoteValue, txHash: hash });
        const r = await this.sellLeftover({ posId: pos.id, target: pos.target, token: claim.meme.token, quote: claim.meme.quote, amount: claim.meme.amount, kind: 'fee', label: claim.meme.symbol });
        sold = r ? `${claim.meme.symbol} terjual` : null;
      }
      return { ok: true, tx: hash, txHash: hash, claimedUsd: claim.usd, valueUsd: claim.usd, sold };
    } finally { this.exiting.delete(id); }
  }

  async bookFeeClaim(pos, fee0, fee1, hash) {
    const st = await this.chain.pool(pos.venue, pos.pool_ref, { maxAgeMs: 0 });
    const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
    const args = (a0, a1) => ({ sqrtPriceX96: st.sqrtX96, amount0: a0, amount1: a1, dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 });
    const v = this.chain.valueAs(args(fee0, fee1), pos.quote_symbol, this.ethUsd) ?? 0;
    this.store.run('INSERT OR IGNORE INTO fee_claims(tx_hash,position_id,ts,amount0,amount1,value_quote) VALUES(?,?,?,?,?,?)',
      hash, pos.id, Date.now(), String(fee0), String(fee1), v);
    this.store.run('UPDATE positions SET claimed_quote=COALESCE(claimed_quote,0)+?, fees_quote=0 WHERE id=?', v, pos.id);
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    const memeSide = q.side === 0 ? 1 : 0;
    const memeMint = memeSide === 0 ? pos.token0 : pos.token1;
    const memeAmt = BigInt(memeSide === 0 ? fee0 : fee1);
    const meme = memeAmt > 0n && !this.chain.QUOTES[memeMint] ? {
      token: memeMint, quote: memeSide === 0 ? pos.token1 : pos.token0, amount: memeAmt.toString(),
      symbol: memeSide === 0 ? t0.symbol : t1.symbol,
      quoteValue: this.chain.valueAs(args(memeSide === 0 ? memeAmt : 0n, memeSide === 1 ? memeAmt : 0n), pos.quote_symbol, this.ethUsd) ?? 0,
    } : null;
    return { value: v, usd: v * usdPerQuote(pos.quote_symbol, this.ethUsd, this.chain), meme };
  }

  // ---- token sisa ----------------------------------------------------------------------
  async sellLeftover(item) {
    this.selling.add(item.token);
    try {
      const rules = this.rulesFrom(item.target ?? null);
      // Kembali ke aset kuotasi pool asalnya (SOL/USDC/USDT), sama dengan EVM; sisa entry
      // dan sapuan tanpa pool asal ke USDC.
      const out = item.quote && this.chain.QUOTES[item.quote] ? item.quote : this.chain.ADDR.usdg;
      const r = await this.swap(item.token, out, BigInt(item.amount), { slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps, kind: 'sell_leftover' });
      const qm = this.chain.QUOTES[out];
      const usdOut = (Number(r.out) / 10 ** qm.decimals) * (qm.kind === 'eth' ? this.ethUsd : 1);
      // Buku fee dulu lalu buku sisa (recordTokenSale), seperti EVM. Sisa entry yang gagal
      // (rescue) bukan milik posisi mana pun — tidak dibukukan ke posisi lain.
      if (!item.rescue) this.positions.recordTokenSale({ posId: item.posId ?? null, token: item.token, amount: item.amount, quoteToken: null, amountOut: null, usdOut, ethUsd: this.ethUsd, txHash: r.hash });
      this.dropLeftover(item);
      return r;
    } catch (e) {
      const k = this.keepLeftover(item, e.message);
      this.store.log('warn', `${item.label || item.token.slice(0, 6)} dari posisi #${item.posId ?? '?'} belum terjual: ${e.message} (coba lagi, percobaan ${k.tries})`, { quiet: true });
      this.alertLeftover(item, item.label || item.token.slice(0, 6), e);
      return null;
    } finally { this.selling.delete(item.token); }
  }
  async sellToken(item) { return this.sellLeftover(item); }

  async retryLeftovers() {
    if (this.stopping || this.dryRun() || !this.exec.address() || this.leftoverBusy) return;
    this.leftoverBusy = true;
    try {
      for (const item of this.leftovers()) {
        if (Date.now() < (item.next || 0) || this.selling.has(item.token)) continue;
        await this.sellLeftover(item);
      }
    } finally { this.leftoverBusy = false; }
  }

  // Sapu wallet: semua token non-kuotasi bernilai ≥ minUsd dijual ke `quote` (Jupiter).
  // Token milik posisi terbuka (masih di LP, bukan di wallet) tidak ikut — yang dibaca
  // hanya saldo wallet.
  async sweepWallet({ minUsd = 0.5, quote = this.chain.ADDR.usdg } = {}) {
    if (this.dryRun() || !this.exec.address()) throw new Error('mode simulasi: tidak mengirim transaksi');
    const bal = await this.exec.balances();
    const mints = [...bal.keys()].filter((mm) => mm !== 'SOL' && !this.chain.QUOTES[mm] && bal.get(mm) > 0n);
    const px = await this.chain.jup.prices(mints).catch(() => new Map());
    const toks = new Map((await this.chain.tokens(mints).catch(() => [])).filter(Boolean).map((t) => [t.address, t]));
    const out = [];
    for (const mint of mints) {
      const t = toks.get(mint); const p = px.get(mint);
      if (!t || p == null) { out.push({ token: mint, skipped: 'harga tidak diketahui' }); continue; }
      const usd = (Number(bal.get(mint)) / 10 ** t.decimals) * p;
      if (usd < minUsd) continue;
      const r = await this.sellLeftover({ posId: null, token: mint, amount: bal.get(mint).toString(), label: t.symbol, quote });
      out.push({ token: mint, symbol: t.symbol, usd, sold: !!r, tx: r?.hash || null });
    }
    return { swept: out.filter((x) => x.sold).length, items: out };
  }

  // ---- buka lagi posisi yang ditunda/ditutup karena jauh dari rentang --------------
  // Pantauan disimpan sama dengan EVM (watchReentry); di Solana harga & likuiditas
  // target dibaca lewat adapter, dan aksi sintetis 'reentry' membawa isi posisi target
  // sekarang supaya rencana exact menskala komposisinya.
  async reentryTick() {
    const watches = this.reentryWatches();
    if (!watches.length) return;
    const drop = (w, why) => { this.store.run('DELETE FROM state WHERE k=?', w.key); if (why) this.store.log('info', `berhenti memantau ${String(w.tokenId).slice(0, 8)}… target ${w.target.slice(0, 8)}…: ${why}`, { quiet: true }); };
    for (const w of watches) {
      if (this.stopping) return;
      const t = this.store.get('SELECT enabled FROM targets WHERE chain=? AND address=?', this.network, w.target);
      if (!t) { drop(w, 'target dihapus'); continue; }
      const rules = this.rulesFrom(w.target);
      const near = this.reentryNearPct(rules);
      if (!near) { drop(w, 'aturan buka-lagi dimatikan'); continue; }
      if (this.store.get("SELECT 1 FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=?", this.network, w.tokenId, w.target)) { drop(w, 'cermin sudah terbuka'); continue; }
      if (!t.enabled || this.paused() || this.drawdownTripped()) continue;
      if (w.retryAfter && Date.now() < w.retryAfter) continue;
      let tl = null;
      try { tl = await this.targetLiquidity(w.venue, w.tokenId); } catch { tl = null; }
      if (!tl) continue;
      if (tl.liquidity <= 0n) { drop(w, 'target sudah keluar dari posisinya'); continue; }
      const tp = tl.position;
      const st = await this.chain.pool(w.venue, tp.pool, { maxAgeMs: 0 }).catch(() => null);
      if (!st) continue;
      if (m.distanceFromRangePct(st.tick, tp.tickLower, tp.tickUpper) > near) continue;
      const v = this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: tp.amount0, amount1: tp.amount1, dec0: st.dec0, dec1: st.dec1, token0: st.token0, token1: st.token1 });
      const id = Number(this.store.run(`INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,
          tick_lower,tick_upper,liquidity,amount0,amount1,value_quote,quote_symbol,ext) VALUES(?,?,?,?,0,?,?,'reentry',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.network, Date.now(), this.head || 0, `reentry:${w.tokenId}:${Date.now()}`, w.target, w.venue, w.tokenId, tp.pool, st.token0, st.token1,
      st.fee ?? null, st.tickSpacing ?? null, tp.tickLower, tp.tickUpper, String(tp.liquidity), String(tp.amount0), String(tp.amount1),
      v?.value ?? null, v?.symbol ?? null, JSON.stringify({ lower: tp.lower, upper: tp.upper, liquidityBefore: '0', ...(tp.ext || {}) })).lastInsertRowid);
      const act = SolanaWatcher.actFromRow(this.store.get('SELECT * FROM actions WHERE id=?', id));
      drop(w, null);
      try { await this.handleEntry(act, rules); }
      catch (e) { this.decide(id, 'error', String(e.message).slice(0, 300)); this.store.log('error', `buka lagi ${String(w.tokenId).slice(0, 8)}…: ${e.message}`); }
      const d = this.store.get('SELECT verdict, reason FROM decisions WHERE action_id=? ORDER BY id DESC LIMIT 1', id);
      if (d && d.verdict !== 'copy' && d.verdict !== 'dry' && !/dari harga \(batas/.test(d.reason || '')) {
        const tries = (w.tries || 0) + 1;
        if (tries < 8) this.store.setState(w.key, JSON.stringify({ ...w, key: undefined, tries, retryAfter: Date.now() + 15 * 60_000 }));
        else this.store.log('warn', `buka lagi ${String(w.tokenId).slice(0, 8)}… menyerah setelah ${tries} percobaan: ${d.reason}`);
      }
    }
  }

  // ---- sinkron posisi & keluar mandiri -------------------------------------------------
  // Urutan sama dengan EVM: adopsi/penautan posisi yatim, rekonsiliasi keluar, sinkron,
  // pembukuan keluar tertunda, kas, sisa, pemicu keluar mandiri, panen fee, buka lagi.
  async syncPositions() {
    if (this.syncBusy) return;
    this.syncBusy = true;
    try {
      if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
      const addr = this.exec.address();
      const sekali = (key, label, p) => p.then(() => this.cleared(key, `${label}: berhasil lagi`))
        .catch((e) => this.trouble(key, `${label}: ${e.message}`, { after: 5, afterMs: 5 * 60_000 }));
      if (addr && Date.now() - (this.lastAdopt || 0) > 10 * 60_000) {
        this.lastAdopt = Date.now();
        await sekali('adopsi', 'adopsi posisi wallet', this.adoptOwnPositions(addr).then(() => this.prunePendingEntries()));
      }
      if (addr && this.capital?.available?.() && Date.now() - (this.capital.lastSync || 0) > (this.capital.backlog ? 60_000 : 5 * 60_000)) {
        await sekali('modal', 'pelacakan setoran', this.capital.sync(addr));
      }
      await sekali('rekon', 'rekonsiliasi keluar', this.reconcileExits());
      await this.positions.sync(this.ethUsd);
      await sekali('buku-keluar', 'pembukuan keluar tertunda', this.bookPendingExits());
      await sekali('kas', 'saldo kas', this.refreshCash());
      await sekali('sisa', 'nilai token sisa', this.positions.refreshLeftovers(this.ethUsd));
      const outs = this.positions.exitTriggers((p) => this.rulesFrom(p.target));
      for (const t of outs) {
        const { pos, reason } = t;
        if (this.stopping) break;
        if (this.exiting.has(pos.id)) continue;
        if (!pos.empty && this.store.get('SELECT takeover_ts FROM positions WHERE id=?', pos.id)?.takeover_ts != null) continue;
        if (pos.empty) { await this.closeEmptyPosition(pos).catch((e) => this.store.log('warn', `tutup #${pos.id} yang kosong: ${e.message}`, { quiet: true })); continue; }
        if (this.dryRun() || !addr) { this.store.log('info', `[simulasi] keluar #${pos.id}: ${reason}`, { quiet: true }); continue; }
        try {
          const r = await this.executeExitRetry({ full: true, liquidity: pos.liquidity }, pos);
          this.notify(`keluar mandiri #${pos.id}: ${reason}`, { kind: 'exit', positionId: pos.id, txHash: r.txHash, full: true, auto: true, target: pos.target, mirrorOf: pos.mirror_of, reason });
          this.cleared(`keluar:${pos.id}`, null);
          if (t.kind === 'oor' && pos.mirror_of && pos.target) {
            this.watchReentry({ target: pos.target, venue: pos.venue, tokenId: pos.mirror_of }, this.rulesFrom(pos.target), { why: 'ditutup', posId: pos.id });
          }
        } catch (e) { this.trouble(`keluar:${pos.id}`, `keluar mandiri gagal #${pos.id}: ${e.message}`, { after: 2 }); }
      }
      if (!this.stopping) await this.compound.tick(Date.now(), new Set(outs.map((t) => t.pos.id)));
      if (!this.stopping) await sekali('masuk-lagi', 'buka lagi posisi yang ditunda', this.reentryTick());
    } finally { this.syncBusy = false; }
  }

  // ---- kas -----------------------------------------------------------------------------
  // Bentuk sama dengan EVM: usdg = stablecoin, eth = SOL native, weth = wSOL.
  async refreshCash() {
    if (!this.exec.address()) { this.cash = null; return null; }
    const seq = this.exec.txSeq;
    const b = await this.exec.balances();
    const usdg = Number(b.get(this.chain.ADDR.usdg) || 0n) / 1e6 + Number(b.get(this.chain.ADDR.usdt) || 0n) / 1e6;
    const eth = Number(b.get('SOL') || 0n) / 1e9, weth = Number(b.get(WSOL) || 0n) / 1e9;
    this.cash = { usdg, eth, weth, usd: usdg + (eth + weth) * this.ethUsd, ts: Date.now() };
    this.cashSeq = seq;
    return this.cash;
  }

  copyRoom(cash) {
    const { sizing: s, filters: f } = rulesFor(this.cfg.rules);
    const sum = this.positions.summary(this.ethUsd);
    const spent = this.spentTodayUsd();
    const reserve = Number(this.exec.gasReserveCached()) / 1e9;
    const cashUsd = cash ? cash.usdg + Math.max(0, cash.eth + cash.weth - reserve) * this.ethUsd : null;
    return {
      daily: { limit: s.daily_budget_usd, used: spent, left: Math.max(0, s.daily_budget_usd - spent) },
      exposure: { limit: s.max_total_exposure_usd, used: sum.exposureUsd, left: Math.max(0, s.max_total_exposure_usd - sum.exposureUsd) },
      slots: { limit: f.max_open_positions, used: sum.openCount, left: Math.max(0, f.max_open_positions - sum.openCount) },
      perPositionUsd: s.max_quote_per_position_usd,
      cashUsd,
    };
  }

  // SOL native di bawah separuh cadangan: beli SOL dari USDC (maks gas.topup_max_usd),
  // supaya menutup posisi dan menjual sisa tidak gagal kehabisan biaya transaksi.
  async topUpGas(notes = []) {
    if (Date.now() - (this.gasTopupFailedAt || 0) < 10 * 60_000) return;
    try {
      const b = await this.exec.balances();
      const reserve = this.exec.gasReserveCached();
      const sol = b.get('SOL') || 0n;
      if (sol * 2n >= reserve) return;
      const usdc = b.get(this.chain.ADDR.usdg) || 0n;
      const wantUsd = Math.min(Number(this.cfg.gas?.topup_max_usd ?? 25), (Number(reserve - sol) / 1e9) * this.ethUsd * 1.03);
      const pay = BigInt(Math.ceil(wantUsd * 1e6));
      if (pay < 1_000_000n || usdc < pay) return;
      const r = await this.swap(this.chain.ADDR.usdg, WSOL, pay, { slippageBps: 100, maxLossBps: 300, kind: 'gas_topup' });
      notes.push(`isi gas: beli ${fmtUnits(r.out, 9)} SOL dari ${fmtUnits(pay, 6)} USDC`);
    } catch (e) {
      this.gasTopupFailedAt = Date.now();
      this.store.log('warn', `isi gas SOL gagal: ${e.message}`, { quiet: true });
    }
  }
  async gasReserve() { return this.exec.gasReserveCached(); }
}

for (const k of BORROWED) {
  if (typeof Engine.prototype[k] !== 'function') throw new Error(`Engine.prototype.${k} tidak ada — SolanaEngine perlu disesuaikan`);
  if (!Object.prototype.hasOwnProperty.call(SolanaEngine.prototype, k)) SolanaEngine.prototype[k] = Engine.prototype[k];
}

module.exports = { SolanaEngine };
