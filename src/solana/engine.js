'use strict';
// The Solana copy-LP engine. Its outer interface is the same as the EVM Engine (index.js, the
// dashboard and the Telegram bot call tick/syncPositions/snapshotEquity/retryLeftovers, dryRun,
// paused, positions.*, exec.address, ethUsd, …) and it writes the same tables
// (actions, decisions, positions, txs, equity) — so the dashboard and Telegram show
// Solana positions without a special branch.
//
// The chain-independent parts (decisions, pause, drawdown breaker, entry/exit queues, daily
// budget, leftover token queue, equity, news) are BORROWED straight from Engine.prototype —
// one source of truth for the same rules. Rewritten here: scanning (the Solana watcher),
// entry/exit execution through the venue adapters + Jupiter, and cash (SOL/wSOL/USDC/USDT).
const { Engine } = require('../engine');
const { rulesFor, planExit, quoteToUsd, usdPerQuote } = require('../policy');
const m = require('../v3math');
const { SolanaWatcher } = require('./watcher');
const { SolanaPositions } = require('./positions');
const { SolanaExecutor } = require('./executor');
const { planEntrySol } = require('./planner');
const { WSOL } = require('../networks');
const { SolanaHoldings } = require('./holdings');
const { SolanaWalletResearch } = require('./research');
const { PaperBook } = require('../paper');

// A target's wallet research older than this is refreshed in the background for equity sizing
// (the same limit as the EVM engine).
const TARGET_RESEARCH_STALE_MS = 5 * 60_000;

const fmtUnits = (raw, dec) => {
  const n = Number(raw) / 10 ** dec;
  return n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)));
};
// Large amounts for decision reasons ("$12.3rb", "$1.45jt") — same wording as the EVM engine.
const compactMoney = (v) => {
  const a = Math.abs(Number(v) || 0);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}m`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}jt`;
  if (a >= 1000) return `$${(a / 1000).toFixed(1)}rb`;
  return `$${a.toFixed(2)}`;
};
const fmtPct = (x) => (x >= 1000 ? '999+' : x.toFixed(0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const minB = (a, b) => (a < b ? a : b);

// Engine methods that are pure rules/bookkeeping — used as is.
const BORROWED = [
  'sk', 'rulesFrom', 'trouble', 'cleared', 'dryRun', 'paused', 'setPaused',
  'maxDailyDrawdownPct', 'dayKey', 'updateDrawdown', 'drawdownTripped', 'drawdownStatus',
  'idle', 'drain', 'enqueue', 'settled', 'pump', 'queued', 'decide', 'handle',
  'spentTodayUsd', 'increasesUsdSince', 'leftoverRetrySec', 'leftovers', 'saveLeftovers', 'sameLeftover',
  'keepLeftover', 'dropLeftover', 'snapshotEquity', 'backfillEquityPnl', 'notify', 'freshCash',
  'reentryNearPct', 'reentryKey', 'watchReentry', 'reentryWatches', 'alertLeftover',
  // target fee harvests: noted, and followed with a mirror claim when exit.follow_claim is on
  'noteTargetClaim', 'followTargetClaim',
  // scan watchdog: a tick hanging past loop.tick_stuck_seconds is released and reported
  'tickStuckMs', 'unwedge',
  // pool liquidity/volume for the entry filter (Market: Meteora API first on Solana)
  'poolStats',
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
    this.busySince = 0;            // when the running tick started (0 = none) — see Engine.unwedge
    this.tickGen = 0;              // tick serial number; rises when a stuck tick is force-released
    this.lastScanAt = 0;           // the LAST SUCCESSFUL scan (dashboard health, not just the last attempt)
    this.exiting = new Set();
    this.selling = new Set();
    this.troubles = new Map();
    this.lastCopyAt = new Map();
    this.stats = { scanned: 0, actions: 0, copied: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    this.lastError = null;
    this.cash = null; this.cashSeq = -1;
    this.paper = new PaperBook(this);   // simulation mode's virtual balance (paper.js)
    // Deposits/withdrawals → wallet capital & net PnL (same tables and formula as EVM).
    this.capital = new (require('./capital').SolanaCapital)({ engine: this, rpc, store, chain, cfg, log: this.log });
    // Automatic fee harvesting: settings & schedule as on EVM (src/compound.js), the
    // transactions through the venue adapters (src/solana/compound.js).
    this.compound = new (require('./compound').SolanaCompound)(this);
  }

  get network() { return this.chain.network; }
  get label() { return this.chain.label; }
  static isExitKind(kind) { return Engine.isExitKind(kind); }

  // ---- start --------------------------------------------------------------------
  async init() {
    const addr = this.exec.address();
    if (addr) this.store.setState(this.sk('wallet_address'), addr);
    this.head = await this.rpc.slot();
    this.cursor = this.head;
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    this.log(`mulai di slot ${this.head}; wallet ${addr || '(belum diisi — mode simulasi)'}; SOL $${this.ethUsd.toFixed(2)}`);
    if (addr) await this.adoptOwnPositions(addr).catch((e) => this.log(`adopsi posisi sendiri: ${e.message}`));
    if (this.paper.on()) this.paper.ensureSince();
    await this.backfillDecisions();
  }

  // Actions recorded without a decision (the process died midway). LIVE: stale ones are skipped.
  async backfillDecisions() {
    const stale = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const rows = this.store.all(`SELECT a.* FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE d.id IS NULL AND a.chain=? ORDER BY a.ts ASC LIMIT 500`, this.network);
    for (const r of rows) {
      if (Date.now() - r.ts > stale && (!this.dryRun() || this.paper.on())) { this.decide(r.id, 'skip', 'aksi lampau — mesin sedang mati saat itu'); continue; }
      try { await this.handle(SolanaWatcher.actFromRow(r)); } catch (e) { this.decide(r.id, 'error', String(e.message).slice(0, 200)); }
    }
  }

  // LP positions owned by our wallet that are not recorded (opened by hand / the process died
  // before recording) are adopted: capital = the current value (how much it started with is unknown).
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
        // A position the bot opened but did not get to book (the process died midway):
        // linked again to its target & originating action, its capital = the actual contents.
        const pkey = this.sk(`sol_pending_entry:${p.id}`);
        let pend = null;
        try { pend = JSON.parse(this.store.getState(pkey) || 'null'); } catch { pend = null; }
        // An entry still running books its own position — do not adopt it twice.
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

  // ---- one scanning round -------------------------------------------------------
  async tick() {
    if (this.stopping) return;
    // A tick still running is usually just slow; past the limit it is released (Engine.unwedge)
    // so one RPC call that never returns cannot blind the bot silently.
    if (this.busy) return this.unwedge();
    if (this.rpc.allCooling()) return;
    this.busy = true;
    this.busySince = Date.now();
    const gen = ++this.tickGen;
    const stale = () => gen !== this.tickGen;
    try {
      this.tickStage = 'baca slot';
      this.head = await this.rpc.slot();
      if (stale()) return;
      this.cursor = this.head;
      this.tickStage = 'pindai target';
      const raw = await this.watcher.scan();
      if (stale()) return;
      this.lastScanAt = Date.now();
      if (this.wedgeNotifiedAt) {
        this.wedgeNotifiedAt = 0;
        this.notify(`pemindaian pulih — target kembali terbaca di slot ${this.head}`, null, 'info');
      }
      const fresh = await this.watcher.persist(raw);
      this.stats.actions += fresh.length;
      this.enqueue(fresh);
      if (fresh.length && this.onFreshActions) {
        try { this.onFreshActions(fresh); } catch (e) { this.store.log('error', `onFreshActions: ${e.message}`); }
      }
      this.cleared('tick', `pemindaian target: kembali normal di slot ${this.head}`);
    } catch (e) {
      if (stale()) return;
      this.stats.errors++;
      this.lastError = String(e.message).slice(0, 250);
      this.trouble('tick', `tick: ${e.message}`, { after: 5, afterMs: 3 * 60_000 });
    } finally {
      // A stale tick does not release `busy`: the flag already belongs to the tick that replaced it.
      if (!stale()) { this.busy = false; this.busySince = 0; this.tickStage = null; }
    }
  }

  async staleEntry(act) {
    if (this.dryRun() && !this.paper.on()) return null;
    const max = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const age = Date.now() - (act.ts || Date.now());
    return age > max ? `sinyal masuk sudah ${Math.round(age / 60000)} menit — terlalu basi untuk disalin` : null;
  }

  // ---- entry ------------------------------------------------------------------
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
      } catch { /* unreadable: do not block — same as EVM */ }
    }
    // Market filter: a pool whose TVL or volume is thin pays no fees however much the target
    // earns there. Figures: Meteora DLMM API for DLMM pools, DexScreener for the rest. A pool
    // with no figures at all is let through — the filter rejects a pool PROVEN quiet.
    const fMin = rules.filters;
    if (fMin.min_liquidity_usd > 0 || fMin.min_volume24h_usd > 0) {
      const pair = await this.poolStats(act.poolRef);
      if (pair) {
        const liq = pair.liquidityUsd, vol = pair.volume?.h24;
        if (fMin.min_liquidity_usd > 0 && liq != null && liq < fMin.min_liquidity_usd) {
          return this.decide(act.id, 'skip', `likuiditas pool ${compactMoney(liq)} (< ${compactMoney(fMin.min_liquidity_usd)})`);
        }
        if (fMin.min_volume24h_usd > 0 && vol != null && vol < fMin.min_volume24h_usd) {
          return this.decide(act.id, 'skip', `volume 24 jam ${compactMoney(vol)} (< ${compactMoney(fMin.min_volume24h_usd)})`);
        }
      }
    }
    const pool = await this.chain.pool(act.venue, act.poolRef, { maxAgeMs: 0 });
    const sum = this.positions.summary(this.ethUsd);
    const live = !this.dryRun() && this.exec.address();
    // Simulation with a virtual balance is limited by that balance, like live is by the wallet.
    const cash = live || this.paper.on() ? await this.spendableCash().catch(() => null) : null;
    const mirrors = this.store.all("SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? AND token_id IS NOT NULL ORDER BY id",
      this.network, act.tokenId ?? '', act.target);
    const held = mirrors.find((mp) => mp.takeover_ts != null);
    if (held) return this.decide(act.id, 'skip', `posisi #${held.id} dalam kendali manual — tambahan target tidak diikuti`);
    const usdOf = (mp) => {
      const lv = this.positions.live.find((p) => p.id === mp.id);
      return lv?.valueUsd ?? Math.max(0, (mp.cost_quote || 0) - (mp.out_quote || 0)) * usdPerQuote(mp.quote_symbol, this.ethUsd, this.chain);
    };
    const mirror = mirrors[0] || null;
    const equity = rules.sizing.mode === 'equity' ? await this.sizingEquity(act, sum, cash, rules) : {};
    const d = planEntrySol(act, {
      chain: this.chain, rules, pool, ethUsd: this.ethUsd,
      openExposureUsd: sum.exposureUsd, spentTodayUsd: this.spentTodayUsd(), openCount: sum.openCount,
      cash, existingUsd: mirror ? usdOf(mirror) : null, ...equity,
    });
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);

    const far = rules.exit.out_of_range_pct > 0 ? m.distanceFromRangePct(pool.tick, d.plan.tickLower, d.plan.tickUpper) : 0;
    if (far > rules.exit.out_of_range_pct) {
      // As on EVM: when re-entry is on, the target position is watched and the mirror opened
      // once the price comes close.
      const watch = this.watchReentry(act, rules, { why: 'ditunda', actionId: act.id });
      return this.decide(act.id, 'skip', `rentang ${fmtPct(far)}% dari harga (batas ${rules.exit.out_of_range_pct}%) — ${
        watch ? `ditunda; dibuka begitu harga ≤ ${watch.nearPct}% dari rentang dan target masih di dalam` : 'tidak disalin'}`);
    }
    if (mirror) {
      d.plan.action = 'increase'; d.plan.tokenId = mirror.token_id; d.plan.positionId = mirror.id;
      d.reason = `${d.reason} (menambah posisi #${mirror.id})`;
    }
    if (this.paper.on()) return this.paper.copyEntry(d, act, { sqrt: pool.sqrtX96 });
    if (this.dryRun() || !this.exec.address()) {
      // With a wallet: the entry transaction is simulated on mainnet (not sent), as on EVM.
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

  // Inputs for sizing mode "equity" — the Solana counterpart of Engine.sizingEquity. Unknown =
  // null, which makes the planner fall back to pct (or skip, per equity_fallback). Our equity =
  // cash (the spendable read just made, else the last refreshCash) + positions + leftovers + fees.
  async sizingEquity(act, sum, cash, rules) {
    const ourCash = cash ? cash.usd + cash.sol * this.ethUsd : this.cash?.usd;
    const ourEquityUsd = ourCash == null ? null : ourCash + sum.exposureUsd + (sum.leftoverUsd || 0) + sum.feeUsd;
    const targetEquityUsd = rules.sizing.equity_target_usd > 0 ? null : await this.targetEquity(act).catch((e) => {
      this.log(`equity target ${act.target}: ${e.message}`);
      return null;
    });
    return { ourEquityUsd, ourCashUsd: ourCash ?? null, targetEquityUsd };
  }

  // Target equity = its quote cash now (SOL + wSOL, USDC, USDT) + its open LP from wallet research
  // (re-valued at the current price) + this action when the last research has not covered it.
  // Never researched → null, and the research is requested in the background for the next entry.
  // Memecoins in the wallet are not counted; sizing.equity_max_pct bounds that under-read.
  async targetEquity(act) {
    const w = String(act.target || '');
    const wallet = w && this.store.get('SELECT scanned_to, last_scan_ts FROM wallets WHERE chain=? AND address=?', this.network, w);
    if (!wallet) { this.onResearchNeeded?.(w, 'full'); return null; }
    if (Date.now() - (wallet.last_scan_ts || 0) > TARGET_RESEARCH_STALE_MS) this.onResearchNeeded?.(w, 'refresh');
    this.holdings ??= new SolanaHoldings({ rpc: this.rpc, chain: this.chain });
    const rows = await this.holdings.of(w);
    const cashUsd = rows.filter((r) => r.isQuote)
      .reduce((t, r) => t + r.amount * (this.chain.QUOTES[r.address]?.kind === 'eth' ? this.ethUsd : 1), 0);
    const open = this.store.all("SELECT * FROM wpositions WHERE chain=? AND wallet=? AND status='open'", this.network, w);
    this.research ??= new SolanaWalletResearch({ rpc: this.rpc, store: this.store, chain: this.chain, log: this.log });
    await this.research.refreshOpen(open, this.ethUsd).catch((e) => this.log(`equity target ${w}: LP re-value failed: ${e.message}`));
    const lpUsd = open.reduce((t, r) => t + (r.live_value_q || 0) + (r.live_fee_q || 0), 0);
    // Counted by the research only if it reached this action's slot AND knows the position.
    const known = open.some((r) => r.venue === act.venue && r.token_id === String(act.tokenId ?? ''));
    const covered = known && act.block != null && wallet.scanned_to != null && wallet.scanned_to >= act.block;
    const q = this.chain.quoteSideOf(act.token0, act.token1);
    const actUsd = q ? quoteToUsd(act.valueQuote || 0, q.kind, this.ethUsd) : 0;
    return cashUsd + lpUsd + (covered ? 0 : actUsd);
  }

  // Simulate the entry transaction (dry run with a wallet): built through the adapter with the
  // planned amounts, then simulateTransaction — nothing is sent.
  async simulateEntry(plan) {
    const ad = this.chain.adapter(plan.venue);
    const owner = this.exec.address();
    const built = plan.action === 'increase'
      ? await ad.buildIncrease({ pool: plan.poolRef, position: plan.tokenId, amount0: BigInt(plan.amount0), amount1: BigInt(plan.amount1), slippageBps: plan.slippageBps ?? 150, owner, strategy: plan.strategy || null })
      : await ad.buildOpen({ pool: plan.poolRef, lower: plan.lower, upper: plan.upper, amount0: BigInt(plan.amount0), amount1: BigInt(plan.amount1), slippageBps: plan.slippageBps ?? 150, owner, strategy: plan.strategy || 'spot' });
    return this.exec.simulateGroups(built.groups);
  }

  // Pending entry notes whose position never appeared (the tx did not land) are dropped
  // after 30 minutes.
  prunePendingEntries() {
    for (const r of this.store.all("SELECT k, v FROM state WHERE k LIKE 'sol_pending_entry:%' AND k LIKE ?", `%:${this.network}`)) {
      let pend; try { pend = JSON.parse(r.v); } catch { pend = null; }
      if (!pend || Date.now() - pend.ts > 30 * 60_000) this.store.run('DELETE FROM state WHERE k=?', r.k);
    }
  }

  // The wallet research instance shared by equity sizing and the simulation's fee following.
  paperResearch() {
    this.research ??= new SolanaWalletResearch({ rpc: this.rpc, store: this.store, chain: this.chain, log: this.log });
    return this.research;
  }

  // Spendable cash: stablecoins (USDC+USDT) and SOL (native + wSOL) above the reserve.
  async spendableCash() {
    if (this.paper.on()) return { usd: this.paper.cashUsd(), sol: 0 };
    const b = await this.exec.balances();
    const reserve = this.exec.gasReserveCached();
    const solAll = (b.get('SOL') || 0n) + (b.get(WSOL) || 0n);
    const sol = solAll > reserve ? solAll - reserve : 0n;
    const usd = Number(b.get(this.chain.ADDR.usdg) || 0n) / 1e6 + Number(b.get(this.chain.ADDR.usdt) || 0n) / 1e6;
    return { usd, sol: Number(sol) / 1e9 };
  }

  // Available for a mint: wSOL counted together with native SOL above the reserve (the venue
  // SDKs wrap SOL themselves); any other mint = its token account balance.
  availOf(bal, mint) {
    if (mint === WSOL) {
      const all = (bal.get('SOL') || 0n) + (bal.get(WSOL) || 0n);
      const r = this.exec.gasReserveCached();
      return all > r ? all - r : 0n;
    }
    return bal.get(mint) || 0n;
  }

  // Funding source to buy a shortfall worth `usd`: the pool's quote asset first, then other
  // cash (USDC/USDT/SOL). Returns [mint, raw amount] or null.
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
    const bought = new Map();   // mint -> amount bought by this entry (cap for selling back)
    const want0 = BigInt(plan.amount0), want1 = BigInt(plan.amount1);
    const q = this.chain.quoteSideOf(plan.token0, plan.token1);
    const quoteMint = q.side === 0 ? plan.token0 : plan.token1;

    // 1) buy each side's shortfall through Jupiter (exact-in, padded by slippage)
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

    // 2) final amounts: proportional to the plan, capped by what is really in the wallet
    const h0 = this.availOf(bal, plan.token0), h1 = this.availOf(bal, plan.token1);
    const f0 = want0 > 0n ? (h0 * 1_000_000n) / want0 : 1_000_000n, f1 = want1 > 0n ? (h1 * 1_000_000n) / want1 : 1_000_000n;
    const f = minB(1_000_000n, minB(f0, f1));
    a0 = (want0 * f) / 1_000_000n; a1 = (want1 * f) / 1_000_000n;
    if (a0 === 0n && a1 === 0n) throw new Error('jumlah token untuk posisi nol');

    // 3) open / add. Add: the position contents are read RIGHT before sending — the added capital =
    // contents after − contents before (the sync snapshot can be 30 seconds old).
    if (plan.action === 'increase') {
      pre = (await ad.getPositions([{ id: plan.tokenId, pool: plan.poolRef }], (mm) => this.chain.decimalsMap(mm))).get(plan.tokenId);
      if (!pre) throw new Error(`posisi #${plan.positionId} tidak terbaca dari chain`);
    }
    // An error in SIMULATION (nothing sent yet) — usually the price moved past the slippage
    // band between build & execution (Raydium PriceSlippageCheck, etc.): rebuild once at the
    // latest price. Errors after sending are not retried here.
    for (let attempt = 1; ; attempt++) {
      try {
        built = plan.action === 'increase'
          ? await ad.buildIncrease({ pool: plan.poolRef, position: plan.tokenId, amount0: a0, amount1: a1, slippageBps: slip, owner, strategy: plan.strategy || null })
          : await ad.buildOpen({ pool: plan.poolRef, lower: plan.lower, upper: plan.upper, amount0: a0, amount1: a1, slippageBps: slip, owner, strategy: plan.strategy || 'spot' });
        // The new position is noted "pending" before sending: if the process dies after the tx
        // lands but before booking, the next adoption links it to the target again.
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
      // An error midway (second swap, building/sending the transaction): tokens already bought
      // for this entry must not be stranded.
      await this.rescueTokens(bought, balStart, `entry gagal (${String(e.message).slice(0, 80)})`).catch(() => {});
      throw e;
    }
    const hash = sent.hashes[sent.hashes.length - 1] || null;
    if (!sent.ok) {
      // Tokens already bought for this position must not be stranded: sold back.
      await this.rescueTokens(bought, balStart, `entry gagal (${hash || 'tx tidak masuk'})`);
      throw new Error(`transaksi ${plan.action} gagal${hash ? ` (${hash})` : ''}`);
    }

    // 4) record: capital = the actual position contents (read again from the chain)
    const posId = plan.action === 'increase' ? plan.tokenId : built.position;
    let got = null;
    for (let i = 0; i < 5 && !got; i++) {
      try { got = (await ad.getPositions([{ id: posId, pool: plan.poolRef }], (mm) => this.chain.decimalsMap(mm))).get(posId); } catch { got = null; }
      if (!got) await sleep(1500);
    }
    const pool = await this.chain.pool(plan.venue, plan.poolRef, { maxAgeMs: 0 }).catch(() => null);
    const sqrt = pool?.sqrtX96 ?? null;
    // Capital is booked in the row's quote units: a new position = the plan's quote, an add =
    // the old row's quote (see SolanaChain.valueAs).
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
    // Leftover tokens from the swaps that did not go into the position (slippage / rounding) are sold back.
    await this.rescueTokens(bought, balStart, null, { minUsd: 0.5 });
    const valueUsd = quoteToUsd(val(cost0, cost1) ?? plan.valueQuote, plan.quoteKind, this.ethUsd);
    const pair = `${t0.symbol}/${t1.symbol}`;
    return {
      txHash: hash, positionId, adding: plan.action === 'increase', pair, valueUsd, steps,
      note: `${plan.action === 'increase' ? 'tambah' : 'buka'} ${plan.venue} ${pair} $${valueUsd.toFixed(2)} (#${positionId})${steps.length ? ` · ${steps.join(' · ')}` : ''}`,
    };
  }

  // Balances after a swap. Another endpoint may not see the just-confirmed tx yet: read again
  // until the bought mint's balance really rises (≥ 90% of the swap output), at most
  // ~6 seconds. Two IDENTICAL stale reads are not a sign of being up to date.
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

  // ---- swap (Jupiter) ----------------------------------------------------------------
  // With a loss guard: the USD value in vs out at Jupiter prices may not differ by more than
  // maxLossBps (price impact + route fees). Returns {hash, out}.
  async swap(inMint, outMint, amount, { slippageBps = 100, maxLossBps = 500, kind = 'swap' } = {}) {
    const q = await this.chain.router.quote(inMint, outMint, amount, { slippageBps });
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
    const built = await this.chain.router.swapTx(q, this.exec.address(), { maxPriorityLamports: Number(this.cfg.gas?.jupiter_max_priority_lamports ?? 2_000_000) });
    const { tx, lastValidBlockHeight } = built;
    // The fallback may have switched aggregator: the output expectation follows the quote used.
    const used = built.quote || q;
    const r = await this.exec.sendVersioned(tx, { kind, lastValidBlockHeight, detail: { in: inMint, out: outMint, amountIn: String(amount), quoteOut: used.outAmount, aggregator: used.aggregator || 'jupiter', usdIn, usdOut } });
    if (!r.ok) throw new Error(`swap ${ti.symbol}→${to.symbol} gagal (${r.hash})`);
    // the actual output from the tx meta (not the quote)
    // Tx meta unreadable (lagging node): use the quote. Without this guard an output
    // to SOL reads as "0 + fee" = 5000 lamports (found through a mainnet simulation).
    let out = BigInt(used.outAmount);
    if (r.meta) {
      const dl = this.exec.deltas(r.meta);
      const got = outMint === WSOL ? (dl.get(WSOL) ?? 0n) + (dl.get('SOL') ?? 0n) + BigInt(r.fee || 0) : (dl.get(outMint) ?? 0n);
      if (got > 0n) out = got;
    }
    this.exec.noteTx(r.hash, { actualOut: out.toString() });
    return { hash: r.hash, out, quoteOut: BigInt(used.outAmount), usdIn, usdOut, aggregator: used.aggregator || 'jupiter' };
  }

  // Sell back non-quote tokens this entry BOUGHT that did not go into the position (entry
  // failed / over-swapped). At most min(bought, balance now − balance before the entry) is
  // sold — tokens the wallet already held before are never touched.
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

  // ---- exit -------------------------------------------------------------------------
  async handleExit(act, rules) {
    const pos = this.store.get("SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? ORDER BY id LIMIT 1",
      this.network, act.tokenId ?? '', act.target);
    if (pos?.takeover_ts != null) return this.decide(act.id, 'skip', `posisi #${pos.id} dalam kendali manual — keluar target tidak diikuti`);
    const d = planExit(act, pos, { rules });
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);
    // A share that rounds to 0 bps is not sent: it used to be forced to 1 bps (0.01%) — larger
    // than the target's trivial move, and still paying a transaction fee.
    if (!d.plan.full && (BigInt(d.plan.liquidity) * 10_000n) / BigInt(pos.liquidity || '1') === 0n) {
      return this.decide(act.id, 'skip', 'porsi tarik < 0,01% — terlalu kecil untuk dicermin');
    }
    if (this.paper.on()) {
      try { this.decide(act.id, 'copy', await this.paper.copyExit(d.plan, pos, d.reason, act), d.plan, null, pos.id); }
      catch (e) { this.stats.errors++; this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan); this.store.log('error', `simulasi keluar #${pos.id}: ${e.message}`); }
      return;
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

  // plan: {full, liquidity (the L withdrawn)}. `force` (forced close from the dashboard) is
  // accepted for the same interface; on Solana there is no pending compound that could block.
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
      // The position contents before exiting are recorded BEFORE sending: if the process dies or
      // the confirmation is unreadable, the next sync books the result from this note.
      const pend = { ts: Date.now(), full, bps, ourL: ourL.toString(), before: SolanaEngine.slimPos(before) };
      this.store.setState(this.pendingExitKey(pos.id), JSON.stringify(pend));
      let sent;
      try { sent = await this.exec.sendGroups(built.groups, { kind: full ? 'burn' : 'decrease', detail: { venue: pos.venue, position: pos.id } }); }
      catch (e) {
        // Failed in simulation / refused by every endpoint: nothing has been sent.
        this.store.run('DELETE FROM state WHERE k=?', this.pendingExitKey(pos.id));
        if (/^simulasi |ditolak semua endpoint/.test(String(e.message))) e.notSent = true;
        throw e;
      }
      const hash = sent.hashes[sent.hashes.length - 1] || null;
      if (!sent.ok) {
        const e = new Error(`transaksi keluar ${sent.last?.expired ? 'tidak masuk (blockhash kedaluwarsa)' : 'gagal'}${hash ? ` (${hash})` : ''}`);
        // Expired = surely did not land → may be retried. Wait limit reached = not certain →
        // the pending note is left, the sync decides.
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

  // Book the exit result from the position contents read right before the transaction.
  async bookExit(pos, pend, hash, rules) {
    const b = pend.before;
    const full = pend.full, bps = pend.bps, ourL = BigInt(pend.ourL);
    const takeL = full ? ourL : (ourL * BigInt(bps)) / 10_000n;
    // Result = the share of position contents + the fees sent along. Full close: all fees.
    // Partial withdrawal: Raydium (DecreaseLiquidityV2) also sends ALL accumulated
    // fees; DLMM (removeLiquidity without claim) and Orca (decreaseLiquidity) do not.
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
    // A "memecoin" side that turns out to be a quote asset too (SOL in a SOL/USDC pool) is cash,
    // not a leftover to sell.
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

  // An exit NOT yet sent (failed simulation, refused by endpoints, expired blockhash) is
  // retried 3/10/30 s later — as long as the position on chain is exactly the same. One that
  // may already have been sent is never sent again: that would withdraw twice.
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

  // An exit that was sent but not booked (process died / confirmation unreadable): the
  // position on chain is compared with the contents recorded before sending. Gone, or L
  // down by the amount withdrawn = the transaction landed → booked; unchanged and
  // > 3 minutes old = it did not land → the note is dropped.
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

  // A mirror whose target position is gone from the chain but whose exit signal was missed
  // (the watcher skipped it / the exit failed): closed. Two consecutive reads, and
  // only for mirrors > 10 minutes old (a lagging node may not see a new position yet).
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

  // The position account is gone without an exit tx from the bot (closed outside the bot): closed
  // in the books at the last known value — NOT $0, which would book a false loss.
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

  // The target position's current liquidity (used by re-entry & the manual LP dashboard).
  async targetLiquidity(venue, tokenId) {
    const act = this.store.get('SELECT pool_ref FROM actions WHERE chain=? AND token_id=? AND pool_ref IS NOT NULL ORDER BY id DESC LIMIT 1', this.network, String(tokenId));
    const got = (await this.chain.adapter(venue).getPositions([{ id: String(tokenId), pool: act?.pool_ref }], (mm) => this.chain.decimalsMap(mm))).get(String(tokenId));
    if (got === undefined) return null;
    return got ? { liquidity: BigInt(got.liquidity), position: got } : { liquidity: 0n, position: null };
  }

  // ---- fee claims ---------------------------------------------------------------------
  // A claim on Solana is booked right after confirmation (there are no pending receipts).
  pendingFeeClaim() { return null; }
  sellFeeWanted(id, override = null) { return Engine.prototype.sellFeeWanted.call(this, id, override); }

  // `sell`: sell the memecoin side of the fees to the pool's quote asset after claiming (null =
  // follow the position's automatic harvest setting). Same as EVM.
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

  // ---- leftover tokens -----------------------------------------------------------------
  async sellLeftover(item) {
    this.selling.add(item.token);
    try {
      const rules = this.rulesFrom(item.target ?? null);
      // Back to the quote asset of its origin pool (SOL/USDC/USDT), as on EVM; entry leftovers
      // and sweeps without an origin pool go to USDC.
      const out = item.quote && this.chain.QUOTES[item.quote] ? item.quote : this.chain.ADDR.usdg;
      const r = await this.swap(item.token, out, BigInt(item.amount), { slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps, kind: 'sell_leftover' });
      const qm = this.chain.QUOTES[out];
      const usdOut = (Number(r.out) / 10 ** qm.decimals) * (qm.kind === 'eth' ? this.ethUsd : 1);
      // Fee ledger first, then the leftover ledger (recordTokenSale), as on EVM. A failed entry's
      // leftover (rescue) belongs to no position — not booked to another position.
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

  // Sweep the wallet: every non-quote token worth ≥ minUsd is sold to `quote` (Jupiter).
  // Tokens of open positions (still in the LP, not in the wallet) are not included — only the
  // wallet balance is read.
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

  // ---- re-open positions deferred/closed for being far from the range --------------
  // Watches are stored as on EVM (watchReentry); on Solana the target's price & liquidity
  // are read through the adapters, and the synthetic 'reentry' action carries the target
  // position's current contents so an exact plan scales its composition.
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

  // ---- position sync & standalone exits -------------------------------------------------
  // Same order as EVM: adopting/linking orphan positions, exit reconciliation, sync,
  // booking pending exits, cash, leftovers, standalone exit triggers, fee harvest, re-entry.
  async syncPositions() {
    if (this.syncBusy) return;
    this.syncBusy = true;
    try {
      this.paper.settle();
      if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
      const addr = this.exec.address();
      const guarded = (key, label, p) => p.then(() => this.cleared(key, `${label}: berhasil lagi`))
        .catch((e) => this.trouble(key, `${label}: ${e.message}`, { after: 5, afterMs: 5 * 60_000 }));
      if (addr && Date.now() - (this.lastAdopt || 0) > 10 * 60_000) {
        this.lastAdopt = Date.now();
        await guarded('adopsi', 'adopsi posisi wallet', this.adoptOwnPositions(addr).then(() => this.prunePendingEntries()));
      }
      if (addr && this.capital?.available?.() && Date.now() - (this.capital.lastSync || 0) > (this.capital.backlog ? 60_000 : 5 * 60_000)) {
        await guarded('modal', 'pelacakan setoran', this.capital.sync(addr));
      }
      await guarded('rekon', 'rekonsiliasi keluar', this.reconcileExits());
      await guarded('simulasi', 'fee simulasi', this.paper.accrue());
      await this.positions.sync(this.ethUsd);
      await guarded('buku-keluar', 'pembukuan keluar tertunda', this.bookPendingExits());
      await guarded('kas', 'saldo kas', this.refreshCash());
      await guarded('sisa', 'nilai token sisa', this.positions.refreshLeftovers(this.ethUsd));
      const outs = this.positions.exitTriggers((p) => this.rulesFrom(p.target));
      for (const t of outs) {
        const { pos, reason } = t;
        if (this.stopping) break;
        if (this.exiting.has(pos.id)) continue;
        if (!pos.empty && this.store.get('SELECT takeover_ts FROM positions WHERE id=?', pos.id)?.takeover_ts != null) continue;
        if (pos.empty) { await this.closeEmptyPosition(pos).catch((e) => this.store.log('warn', `tutup #${pos.id} yang kosong: ${e.message}`, { quiet: true })); continue; }
        if (this.paper.on()) { await this.paper.autoExit(t); continue; }
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
      if (!this.stopping) await guarded('masuk-lagi', 'buka lagi posisi yang ditunda', this.reentryTick());
    } finally { this.syncBusy = false; }
  }

  // ---- cash ----------------------------------------------------------------------------
  // Same shape as EVM: usdg = stablecoin, eth = native SOL, weth = wSOL.
  async refreshCash() {
    // Simulation: the virtual cash comes from the books — no RPC, always current.
    if (this.paper.on()) { this.cash = this.paper.cashObj(); return this.cash; }
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

  // Native SOL below half the reserve: buy SOL with USDC (at most gas.topup_max_usd),
  // so closing positions and selling leftovers do not fail for lack of transaction fees.
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
