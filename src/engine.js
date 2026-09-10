'use strict';
// Mesin utama: deteksi -> keputusan -> (swap) -> eksekusi -> pencatatan.
const { ethers } = require('ethers');
const { ADDR, TOPIC, ABI } = require('./chain');
const { Watcher } = require('./watcher');
const { Positions } = require('./positions');
const { Executor, isNative } = require('./executor');
const { rulesFor, planEntry, planExit } = require('./policy');
const { enumerateV4, livePositions } = require('./scout');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();

class Engine {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    this.log = log || console.log;
    this.watcher = new Watcher({ rpc, store, chain, log: this.log, cfg });
    this.positions = new Positions({ rpc, store, chain, log: this.log });
    this.exec = new Executor({ rpc, store, chain, cfg, log: this.log });
    this.ethUsd = cfg.prices?.eth_usd || 2500;
    this.cursor = 0;
    this.head = 0;
    this.busy = false;
    this.lastCopyAt = new Map();   // poolRef -> ts (cooldown)
    this.stats = { scanned: 0, actions: 0, copied: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    this.lastError = null;
    // Rentang pindai menyusut saat RPC mengeluh dan tumbuh lagi saat lancar.
    // Tanpa ini, mengejar ketertinggalan besar memicu 429 beruntun.
    this.span = cfg.loop?.max_block_span || 1500;
    this.failStreak = 0;
    this.headSpread = 0;
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
    if (addr) await this.adoptOwnPositions(addr);
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

  // Rekonsiliasi dengan chain: kalau ada posisi v4 milik kita yang belum tercatat
  // (mis. proses mati setelah mint terkirim tapi sebelum sempat dicatat), adopsi.
  async adoptOwnPositions(addr) {
    try {
      const blocks = this.cfg.loop?.adopt_blocks ?? 600_000;
      const { held } = await enumerateV4(this.rpc, addr, this.head, blocks);
      const ids = [...held.keys()];
      if (!ids.length) return;
      const known = new Set(this.store.all("SELECT token_id FROM positions WHERE venue='v4' AND token_id IS NOT NULL").map((r) => r.token_id));
      const missing = ids.filter((id) => !known.has(id));
      if (!missing.length) return;
      const rows = await livePositions(this.rpc, this.chain, missing);
      let n = 0;
      for (const r of rows) {
        if (r.liquidity <= 0n) continue;
        this.positions.record({
          venue: 'v4', poolRef: r.poolId, poolKey: r.poolKey,
          token0: r.poolKey.currency0, token1: r.poolKey.currency1, fee: r.poolKey.fee,
          tickSpacing: r.poolKey.tickSpacing, tickLower: r.tickLower, tickUpper: r.tickUpper,
          liquidity: r.liquidity.toString(), amount0: (r.amount0 ?? 0n).toString(), amount1: (r.amount1 ?? 0n).toString(),
          valueQuote: r.valueQuote, quoteSymbol: r.quoteSymbol, mirrorOf: null, target: null,
        }, { tokenId: r.tokenId, txHash: null, target: null, costQuote: r.valueQuote });
        n++;
      }
      if (n) this.log(`mengadopsi ${n} posisi v4 milik wallet yang belum tercatat`);
    } catch (e) { this.store.log('error', `adopsi posisi: ${e.message}`); }
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
      this.failStreak = 0;
      if (this.span < maxSpan) this.span = Math.min(maxSpan, Math.ceil(this.span * 1.5));
    } catch (e) {
      this.stats.errors++;
      this.failStreak++;
      this.span = Math.max(150, Math.floor(this.span / 2));
      this.lastError = `${String(e.message).slice(0, 250)} (rentang dikecilkan ke ${this.span} blok)`;
      this.store.log('error', `tick: ${e.message} — rentang -> ${this.span}`);
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
    const ctx = {
      chain: this.chain, rules, slot0: act.slot0, dec0: toks[0].decimals, dec1: toks[1].decimals,
      ethUsd: this.ethUsd, openExposureUsd: sum.exposureUsd, spentTodayUsd: spent, openCount: sum.openCount,
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
      this.notify(`LP disalin: ${r.note}`);
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
      pos = this.store.get(
        "SELECT * FROM positions WHERE status='open' AND pool_ref=? AND target=? AND tick_lower=? AND tick_upper=?",
        act.poolRef, act.target, act.tickLower, act.tickUpper);
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
      this.notify(`LP ditutup: ${r.note}`);
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
    }
  }

  async poolKeyOf(pos) {
    if (pos.venue !== 'v4') return null;
    if (!pos.token_id) return null;
    const [w] = await this.rpc.ethCallMany([{ to: ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(pos.token_id)]) }]);
    if (!w || w === '0x') return null;
    const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', w);
    return {
      currency0: d[0].currency0, currency1: d[0].currency1,
      fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks,
    };
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
    const payHave = await balOf(payTok);
    if (payHave <= 0n) {
      throw new Error(`saldo ${wantEth ? 'USDG' : 'ETH'} kosong — tidak ada kas untuk dijembatani`);
    }
    const br = await this.chain.bestEthUsdgPool();
    if (!br) throw new Error('pool jembatan ETH/USDG tidak ditemukan');

    // Butuh berapa? quoteTok WETH tetap dibeli sebagai ETH native lalu dibungkus.
    const shortEthLike = needQuoteRaw - have;
    const price = m.priceFromSqrt(br.slot0.sqrtPriceX96, 18, 6); // USDG per ETH
    const slip = 1 + rules.swap.max_slippage_bps / 10000;
    let payRaw;
    if (wantEth) payRaw = BigInt(Math.ceil((Number(shortEthLike) / 1e18) * price * 1e6 * slip));
    else payRaw = BigInt(Math.ceil((Number(shortEthLike) / 1e6 / price) * 1e18 * slip));
    if (payRaw <= 0n) return notes;
    if (payRaw > payHave) {
      throw new Error(`kas kurang untuk jembatan: butuh ${payRaw} unit ${wantEth ? 'USDG' : 'ETH'}, punya ${payHave}`);
    }
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
    const minOut = (shortEthLike * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;
    const tx = this.exec.buildSwapV4(br.poolKey, zeroForOne, payRaw, minOut, this.exec.deadline());
    const h = await this.exec.send(tx, { kind: 'bridge_swap', detail: { pool: br.poolId, wantEth } });
    if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`swap jembatan gagal (${h})`);
    notes.push(wantEth ? 'jembatan USDG→ETH' : 'jembatan ETH→USDG');

    // kalau yang dibutuhkan WETH, bungkus hasil ETH-nya
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

    let bal = await this.exec.balances([plan.token0, plan.token1]);
    const avail = (t) => {
      let b = bal.get(t.toLowerCase()) || 0n;
      if (isNative(t)) b = b > gasReserve ? b - gasReserve : 0n;
      return b;
    };
    const notes = [];

    // 0. Pastikan kas sudah ada di aset kuotasi pool INI (bisa beda dari kas kita).
    if (plan.quoteSide != null) {
      const qTok = plan.quoteSide === 0 ? plan.token0 : plan.token1;
      const qMeta = await this.chain.token(qTok);
      const needQuoteRaw = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** (qMeta?.decimals ?? 18)));
      if (needQuoteRaw > 0n) {
        notes.push(...await this.ensureQuoteAsset(plan, rules, needQuoteRaw));
        bal = await this.exec.balances([plan.token0, plan.token1]);
      }
    }

    // 1. tutup kekurangan lewat swap
    for (const [idx, tok, need] of [[0, plan.token0, need0], [1, plan.token1, need1]]) {
      const have = avail(tok);
      if (have >= need) continue;
      const short = need - have;
      if (!rules.swap.enabled) throw new Error(`kurang ${short} unit token${idx} dan auto-swap dimatikan`);
      const payTok = idx === 0 ? plan.token1 : plan.token0;
      const payHave = avail(payTok);
      // taksir berapa yang harus dibayar, pakai harga pool + slippage
      const s = act.slot0 || await this.chain.slot0V4(plan.poolRef);
      const price1per0 = Number(s.sqrtPriceX96) ** 2 / Number(m.Q96) ** 2; // mentah, tanpa desimal
      const payRaw = idx === 0
        ? BigInt(Math.ceil(Number(short) * price1per0 * (1 + rules.swap.max_slippage_bps / 10000)))
        : BigInt(Math.ceil((Number(short) / price1per0) * (1 + rules.swap.max_slippage_bps / 10000)));
      if (payRaw <= 0n) continue;
      if (payHave < payRaw) throw new Error(`saldo kurang untuk zap: butuh ~${payRaw} unit ${payTok.slice(0, 8)}…, punya ${payHave}`);
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
    const s2 = plan.venue === 'v3'
      ? await this.chain.slot0V3(plan.poolRef)
      : await this.chain.slot0V4(plan.poolRef);
    const sa = m.getSqrtRatioAtTick(plan.tickLower), sb = m.getSqrtRatioAtTick(plan.tickUpper);
    const affordable = m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1));
    let L = BigInt(plan.liquidity);
    if (affordable < L) { L = (affordable * 99n) / 100n; notes.push('ukuran dipangkas ke saldo nyata'); }
    if (L <= 0n) throw new Error('saldo tidak cukup untuk membuka posisi apa pun');
    const amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);
    const slip = BigInt(rules.swap.max_slippage_bps);
    const finalPlan = {
      ...plan, liquidity: L.toString(),
      amount0Max: ((amt.amount0 * (10000n + slip)) / 10000n).toString(),
      amount1Max: ((amt.amount1 * (10000n + slip)) / 10000n).toString(),
    };

    // 3. izin + mint
    for (const tok of [plan.token0, plan.token1]) {
      for (const a of await this.exec.ensureAllowance(tok, { forV4: plan.venue !== 'v3' })) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
    }
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
    });
    const pair = `${toks[0].symbol}/${toks[1].symbol}`;
    return { txHash: hash, positionId, note: `${adding ? 'tambah ' : ''}${pair} $${(v?.value ?? 0).toFixed(2)}${notes.length ? ' (' + notes.join(', ') + ')' : ''}` };
  }

  async executeExit(plan, pos) {
    let tx;
    if (pos.venue === 'v3') {
      tx = this.exec.buildV3Decrease({ ...plan, tokenId: pos.token_id }, this.exec.deadline());
    } else {
      const poolKey = await this.poolKeyOf(pos);
      if (!poolKey) throw new Error('poolKey posisi tidak terbaca');
      tx = this.exec.buildV4Decrease({ ...plan, poolKey, tokenId: pos.token_id }, this.exec.deadline());
    }
    const hash = await this.exec.send(tx, { kind: plan.full ? 'burn' : 'decrease', detail: { position: pos.id } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (!rc.ok) throw new Error(`keluar gagal (${hash})`);
    if (plan.full) {
      const live = this.positions.live.find((p) => p.id === pos.id);
      this.positions.markClosed(pos.id, {
        out0: live?.amount0, out1: live?.amount1,
        outQuote: (live?.valueUsd || 0) + (live?.feeUsd || 0), txHash: hash,
      });
    } else {
      this.store.run('UPDATE positions SET liquidity=? WHERE id=?',
        (BigInt(pos.liquidity) - BigInt(plan.liquidity)).toString(), pos.id);
    }
    return { txHash: hash, note: `${plan.full ? 'tutup penuh' : 'kurangi'} posisi #${pos.id}` };
  }

  // ---- pemeliharaan berkala ----------------------------------------------
  async syncPositions() {
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    await this.positions.sync(this.ethUsd);
    const globalRules = rulesFor(this.cfg.rules);
    const triggers = this.positions.exitTriggers(globalRules);
    for (const t of triggers) {
      if (t.pos.empty) { this.positions.markClosed(t.pos.id, { outQuote: 0, txHash: null }); continue; }
      if (this.dryRun() || !this.exec.address()) { this.store.log('info', `[simulasi] keluar #${t.pos.id}: ${t.reason}`); continue; }
      try {
        await this.executeExit({ venue: t.pos.venue, action: 'burn', full: true, liquidity: t.pos.liquidity, tokenId: t.pos.token_id }, t.pos);
        this.notify(`keluar mandiri #${t.pos.id}: ${t.reason}`);
      } catch (e) { this.store.log('error', `keluar mandiri gagal #${t.pos.id}: ${e.message}`); }
    }
  }

  snapshotEquity() {
    const s = this.positions.summary(this.ethUsd);
    this.store.run(
      'INSERT OR REPLACE INTO equity(ts,wallet_quote,positions_quote,total_quote,realized_quote,fees_quote,open_positions) VALUES(?,?,?,?,?,?,?)',
      Date.now(), 0, s.exposureUsd, s.exposureUsd + s.feeUsd, s.realizedUsd, s.feeUsd, s.openCount);
  }

  notify(msg) {
    const topic = this.cfg.notify?.ntfy_topic;
    this.store.log('info', msg);
    if (!topic) return;
    fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: `lpcopy: ${msg}` }).catch(() => {});
  }
}

module.exports = { Engine };
