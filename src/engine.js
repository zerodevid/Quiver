'use strict';
const { ensureChain } = require('./networks');
// The main engine: detection -> decision -> (swap) -> execution -> recording.
const { ethers } = require('ethers');
const { TOPIC, ABI } = require('./chain');
const { Watcher } = require('./watcher');
const { Positions } = require('./positions');
const { Executor, isNative } = require('./executor');
const { Kyber } = require('./kyber');
const { SwapRouter, aggLabel } = require('./swaprouter');
const { pickSwapPool } = require('./swappool');
const { Compound } = require('./compound');
const { Capital } = require('./capital');
const { rulesFor, planEntry, planExit, quoteToUsd, usdPerQuote } = require('./policy');
const { enumerateV4, livePositions } = require('./scout');
const { Market } = require('./market');
const m = require('./v3math');

const IF_POSM = new ethers.Interface(ABI.posmV4);
const IF_NPM = new ethers.Interface(ABI.npmV3);
const asAddr = (t) => ('0x' + t.slice(-40)).toLowerCase();
// Raw amount -> text for messages: 2 decimals above 1, 3 significant digits below it.
const fmtUnits = (raw, dec) => {
  const n = Number(raw) / 10 ** dec;
  return n >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(3)));
};
// The origin of a leftover, for messages. The sell queue now also holds tokens
// swept from the wallet (posId null) — not just ones that came out of a position.
const leftoverOrigin = (item) => (item.posId == null ? 'sisa di wallet' : `posisi #${item.posId}`);
// The origin of a token sold by the leftover queue, recorded in the tx detail for the Swap history:
// fee from a claim, a zap that did not become an LP (failed mint / surplus), a wallet sweep,
// or the proceeds of closing a position.
const leftoverSource = (item) => (item.kind === 'fee' ? 'fee' : item.source || (item.posId == null ? 'wallet' : 'exit'));

// A zap surplus below this value is simply left in the wallet: a single sale
// costs gas (~$0.16) and the 1.5% slippage room on a smooth zap almost always
// leaves a little — without this floor every entry would put a dust item in the queue that is never
// sold. The same as the wallet sweep default.
const MIN_ZAP_SURPLUS_USD = 0.5;

// Large amounts for decision reasons: "$12.3k", "$1.45m". Pool liquidity written
// in full ($1,234,567) is not readable at a glance in the decision list.
const compactMoney = (v) => {
  const a = Math.abs(Number(v) || 0);
  if (a >= 1e9) return `$${(a / 1e9).toFixed(2)}m`;
  if (a >= 1e6) return `$${(a / 1e6).toFixed(2)}jt`;
  if (a >= 1000) return `$${(a / 1000).toFixed(1)}rb`;
  return `$${a.toFixed(2)}`;
};

// Distance percent for news/reasons, rounded like the dashboard ("999+" for extreme ones).
const fmtPct = (x) => (x >= 1000 ? '999+' : x.toFixed(0));

// Short duration for news: "45 s", "3 min", "1 h 20 min".
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  const j = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${j} jam ${m} mnt` : `${j} jam`;
}
// Day key (YYYY-MM-DD) in a given time zone — used by the daily drawdown breaker
// so the "day" follows the same zone as the share card (telegram.timezone),
// not the server's UTC.
function dayKeyIn(ts, timeZone) {
  try { return new Date(ts).toLocaleDateString('en-CA', { timeZone }); } catch { return new Date(ts).toLocaleDateString('en-CA'); }
}

class Engine {
  constructor({ rpc, store, chain, cfg, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.cfg = cfg;
    chain = this.chain;   // already completed with a profile (see the setter below)
    this.log = log || console.log;
    this.watcher = new Watcher({ rpc, store, chain, log: this.log, cfg });
    this.positions = new Positions({ rpc, store, chain, log: this.log });
    this.exec = new Executor({ rpc, store, chain, cfg, log: this.log });
    // Each transaction's gas is booked in USD at the native (ETH/BNB) price at that time (see waitReceipt).
    this.exec.ethUsd = () => this.ethUsd;
    // `kyber` is the swap entry point for the whole engine: every enabled aggregator (Kyber,
    // OKX, LI.FI, 0x, 1inch, OpenOcean), best route or fallback order — see swaprouter.js.
    this.kyber = new SwapRouter({ exec: this.exec, rpc, cfg, chain, log: this.log });
    this.ethUsd = cfg.prices?.eth_usd || 2500;
    this.cursor = 0;
    this.head = 0;
    this.busy = false;
    this.busySince = 0;            // when the running tick started (0 = none)
    this.tickGen = 0;              // tick serial number; also rises when a stuck tick is force-released
    this.tickStage = null;         // the tick stage being waited on — shows up in the stuck message
    this.lastScanAt = 0;           // the LAST SUCCESSFUL tick, not merely the last tick
    this.wedgeNotifiedAt = 0;      // when the last stuck state was reported (0 = nothing is hanging)
    this.exiting = new Set();      // ids of positions whose exit transaction is in progress
    this.compound = new Compound(this);
    this.capital = new Capital({ rpc, store, chain, cfg, log: this.log });
    this.troubles = new Map();     // key -> consecutive errors being handled by the fallback
    this.lastCopyAt = new Map();   // poolRef -> ts (cooldown)
    // Third-party pool statistics (DexScreener) for the liquidity/volume filter.
    // The server injects its own instance (createServer) so its 30-second memo
    // is shared with the dashboard; otherwise — CLI, tests — one is made on demand.
    this.market = null;
    this.stats = { scanned: 0, actions: 0, copied: 0, skipped: 0, errors: 0, startedAt: Date.now() };
    this.lastError = null;
    // The scan range shrinks when the RPC complains and grows again when smooth.
    // Without this, catching up on a big lag triggers consecutive 429s.
    this.span = cfg.loop?.max_block_span || 1500;
    this.failStreak = 0;
    this.headSpread = 0;
    this.cash = null;              // last cash balance, see refreshCash()
    this.cashSeq = -1;             // exec.txSeq when cash was last read — different = stale
  }

  // The chain profile is always complete (ADDR, venues, isV3Venue, …) even if what is given is a
  // mock object (tests) or not set at all — the default is the Robinhood Chain profile.
  get chain() { return this._chain || (this._chain = ensureChain(null)); }
  set chain(v) { this._chain = ensureChain(v); }
  get network() { return this.chain.network; }
  get label() { return this.chain.label; }

  // State keys per chain: one DB is used by two engines (Robinhood + BSC), the cursor and
  // other markers must not overwrite each other. `wallet_address` stays global.
  sk(name) { return `${name}:${this.network}`; }

  rulesFrom(targetAddr) {
    const t = this.store.get('SELECT rules FROM targets WHERE chain=? AND address=?', this.network, targetAddr);
    return rulesFor(this.cfg.rules, t?.rules);
  }

  async init() {
    const addr = this.exec.address();
    if (addr) this.store.setState('wallet_address', addr);
    this.head = await this.rpc.blockNumber();
    const saved = Number(this.store.getState(this.sk('cursor'), 0));
    this.cursor = saved || this.head - 1;
    if (this.cfg.prices?.auto_eth_price !== false) {
      this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    }
    this.log(`mulai di blok ${this.cursor}; wallet ${addr || '(belum diisi — mode simulasi)'}; ${this.chain.nativeSymbol} $${this.ethUsd.toFixed(2)}`);
    if (addr) { this.lastAdopt = Date.now(); await this.adoptOwnPositions(addr); }
    await this.backfillDecisions();
  }

  // An actions table row -> an action object as the scanner produces it.
  actFromRow(r) {
    return {
      id: r.id, ts: r.ts, block: r.block, txHash: r.tx_hash, logIndex: r.log_index,
      target: r.target, venue: r.venue, kind: r.kind, tokenId: r.token_id, poolRef: r.pool_ref,
      token0: r.token0, token1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
      tickLower: r.tick_lower, tickUpper: r.tick_upper, liquidity: r.liquidity,
      amount0: r.amount0, amount1: r.amount1, valueQuote: r.value_quote, quoteSymbol: r.quote_symbol,
      // poolKey is not stored in the actions table, but all its parts are. Without this every
      // v4 entry that is re-evaluated (process died / stopped midway through the action list) is skipped
      // "target position pool data unreadable".
      poolKey: r.venue === 'v4' && r.token0 && r.token1 && r.fee != null && r.tick_spacing != null
        ? { currency0: r.token0, currency1: r.token1, fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks || this.chain.ADDR.native }
        : null,
    };
  }

  // Actions that were recorded but not yet decided (e.g. the process died midway).
  // The rule: in LIVE mode a past action MUST NOT be executed — an LP signal that
  // has been stale for hours is no longer a signal. In simulation mode it is still evaluated so the
  // "what if" is visible (a stale entry is still skipped in handleEntry, the same
  // as LIVE).
  async backfillDecisions() {
    const stale = (this.cfg.loop?.stale_action_seconds ?? 300) * 1000;
    const rows = this.store.all(`
      SELECT a.* FROM actions a LEFT JOIN decisions d ON d.action_id = a.id
      WHERE d.id IS NULL AND a.chain=? ORDER BY a.ts ASC LIMIT 500`, this.network);
    if (!rows.length) return;
    let done = 0;
    for (const r of rows) {
      const old = Date.now() - r.ts > stale;
      if (old && !this.dryRun()) {
        this.decide(r.id, 'skip', 'aksi lampau — mesin sedang mati saat itu');
        continue;
      }
      const act = this.actFromRow(r);
      try {
        if (act.venue === 'v4' && act.poolRef) act.slot0 = await this.chain.slot0V4(act.poolRef);
        else if (act.poolRef) act.slot0 = await this.chain.slot0V3(act.poolRef);
        await this.handle(act);
        done++;
      } catch (e) { this.decide(r.id, 'error', String(e.message).slice(0, 200)); }
    }
    if (done) this.log(`menilai ulang ${done} aksi yang belum diputuskan`);
  }

  // Reconciliation with the chain: v4 positions owned by the wallet that are not yet recorded are adopted —
  // both those opened outside the bot (manual, another bot on the same wallet) and those whose
  // mint was sent but the process died before it could be recorded.
  //
  // The first scan covers the WHOLE history: NFT Transfers filtered by that
  // wallet's address are cheap (chunks of 1 million blocks). The window used to be 600k blocks (~17 hours) and
  // only ran at start, so older positions never appeared.
  // After that only new blocks since the last scan are needed, called periodically.
  async adoptOwnPositions(addr) {
    try {
      const me = addr.toLowerCase();
      const head = await this.rpc.blockNumber();
      const last = Number(this.store.getState(this.sk('adopt_scanned_to'), 0));
      const blocks = last ? head - last + 2000 : (this.cfg.loop?.adopt_blocks ?? head);
      const { held } = await enumerateV4(this.chain, me, head, blocks, 1_000_000, undefined, this.rpc);
      // The scan window marker is only advanced if ALL candidates were read. It used to be advanced
      // before the positions were read: one failed RPC read made that wallet's position
      // not adopted, and the next scan no longer covered its block — lost.
      const done = () => this.store.setState(this.sk('adopt_scanned_to'), head);
      const known = new Set(this.store.all("SELECT token_id FROM positions WHERE chain=? AND venue='v4' AND token_id IS NOT NULL", this.network).map((r) => r.token_id));
      let missing = [...held.keys()].filter((id) => !known.has(id));
      if (!missing.length) return done();
      // A Transfer can deceive (order within one block); make sure the owner is now us.
      // strict: unreadable throws (retried in 10 minutes); revert = NFT burned.
      const owners = await this.rpc.ethCallMany(missing.map((id) => ({
        to: this.chain.ADDR.posmV4, data: new ethers.Interface(ABI.posmV4).encodeFunctionData('ownerOf', [BigInt(id)]),
      })), 'latest', { strict: true });
      missing = missing.filter((id, i) => owners[i] && owners[i] !== '0x' && ('0x' + owners[i].slice(-40)).toLowerCase() === me);
      if (!missing.length) return done();
      const rows = await livePositions(this.rpc, this.chain, missing);
      let incomplete = rows.length < missing.length;
      let n = 0;
      for (const r of rows) {
        if (r.liqKnown === false) { incomplete = true; continue; }
        if (r.liquidity <= 0n) continue;
        // The original capital & open time from wallet research (Wallet menu) if it was ever scanned;
        // without that capital = current value, so PnL starts from zero when adopted.
        const w = this.store.get('SELECT invested_q, opened_ts FROM wpositions WHERE chain=? AND wallet=? AND token_id=?', this.network, me, r.tokenId);
        // The pool price when that position opened, if wallet research ever recorded its event.
        const ev0 = this.store.get('SELECT sqrt_price FROM wevents WHERE chain=? AND wallet=? AND token_id=? AND sqrt_price IS NOT NULL ORDER BY block LIMIT 1', this.network, me, r.tokenId);
        const isEth = this.chain.isEthLike(r.quoteSymbol);
        const cost = w?.invested_q > 0 ? (isEth ? w.invested_q / this.ethUsd : w.invested_q) : r.valueQuote;
        // Orphan position: a mint that SUCCEEDED on chain but failed to be recorded (RPC answer
        // lost, process died). If there is a failed copy plan with exactly the same pool and
        // range, this position is almost certainly the result of that plan — pair it
        // back to its target so the exit signal is still mirrored. Without this the position
        // hangs as "outside the bot" and is never closed.
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
    } catch (e) { this.trouble('adopsi', `adopsi posisi: ${e.message}`, { after: 3 }); }   // repeated every 10 minutes
  }

  // Find a failed copy plan that matches this position (pool + range).
  // Only decisions from the last 24 hours are looked at, and only those without a position yet.
  linkOrphan(r) {
    const rows = this.store.all(
      "SELECT d.id, d.plan, a.target FROM decisions d JOIN actions a ON a.id = d.action_id WHERE a.chain=? AND d.verdict='error' AND d.plan IS NOT NULL AND d.ts > ? ORDER BY d.id DESC LIMIT 50",
      this.network, Date.now() - 86_400_000);
    for (const row of rows) {
      let plan = null;
      try { plan = JSON.parse(row.plan); } catch { continue; }
      if (!plan || plan.action === 'burn') continue;
      if (String(plan.poolRef).toLowerCase() !== String(r.poolId).toLowerCase()) continue;
      if (plan.tickLower !== r.tickLower || plan.tickUpper !== r.tickUpper) continue;
      if (this.store.get("SELECT 1 FROM positions WHERE chain=? AND mirror_of=? AND target=? AND status='open'", this.network, plan.mirrorOf ?? '', row.target)) continue;
      return { target: row.target, mirrorOf: plan.mirrorOf ?? null };
    }
    return null;
  }

  // ---- errors that have a fallback path -----------------------------------
  // Many errors here are already handled by themselves: a failed tick repeats the same
  // (smaller) block range at the next tick, the sync repeats every 30 seconds,
  // leftover memecoins go into the retry queue. Such errors are still recorded, but
  // `quiet` — not pushed to the chat. Only if the fallback keeps failing (`after` times
  // in a row AND for `afterMs`) is one warning sent, then one
  // recovery notice as soon as it succeeds again.
  trouble(key, msg, { after = 3, afterMs = 0, level = 'error' } = {}) {
    const now = Date.now();
    let t = this.troubles.get(key);
    // An old error that never "recovers" (e.g. an exit trigger that disappeared by itself)
    // must not be counted: a 15-minute pause without errors = the count starts from zero.
    if (!t || now - t.last > 15 * 60_000) t = { n: 0, since: now, alerted: false };
    t.n++; t.last = now;
    this.troubles.set(key, t);
    if (!t.alerted && t.n >= after && now - t.since >= afterMs) {
      t.alerted = true;
      this.store.log(level, `${msg} — sudah gagal ${t.n}× berturut-turut selama ${duration(now - t.since)}, jalan cadangan belum berhasil`);
    } else {
      this.store.log(level, msg, { quiet: true });
    }
  }
  // Call after the same step succeeds. `okMsg` null = recover without news
  // (e.g. a standalone exit: the position close card is already its news).
  cleared(key, okMsg) {
    const t = this.troubles.get(key);
    if (!t) return;
    this.troubles.delete(key);
    if (t.alerted && okMsg) this.store.log('info', `${okMsg} — pulih setelah ${t.n}× gagal (${duration(Date.now() - t.since)})`, { recovered: true });
  }

  dryRun() { return this.cfg.mode?.dry_run !== false; }
  // Pause per chain (key paused:<chain>); an old 'paused' key without a chain is still read
  // as a global switch — pausing all chains at once.
  paused() {
    const v = this.store.getState(this.sk('paused')) ?? this.store.getState('paused') ?? (this.cfg.mode?.paused ? '1' : '0');
    return v === '1';
  }
  setPaused(on) { this.store.setState(this.sk('paused'), on ? '1' : '0'); }

  // ---- daily drawdown breaker ----------------------------------------------
  // Unlike the manual pause: this is automatic, and only stops new ENTRIES — positions
  // already open are still managed and can exit (stop loss, follow target, etc.).
  // 0 = off, the same as stop_loss_pct and the like.
  maxDailyDrawdownPct() { return Number(this.cfg.risk?.max_daily_drawdown_pct) || 0; }
  dayKey(ts = Date.now()) { return dayKeyIn(ts, this.cfg.telegram?.timezone || undefined); }

  // Called from snapshotEquity (not every tick) — it needs the total equity whose cash was
  // just read from the chain. Today's peak is stored in the store so it survives a restart;
  // once touched, new entries are paused until the day key changes (not until
  // equity recovers — the trigger is a one-time event, not a state continuously watched, so
  // it will not "come alive again" a few seconds later and trip again if equity wobbles
  // slightly around the limit).
  updateDrawdown(total) {
    const today = this.dayKey();
    let peak = Number(this.store.getState(this.sk('dd_peak')));
    if (this.store.getState(this.sk('dd_day')) !== today) {
      peak = total;
      this.store.setState(this.sk('dd_day'), today);
      this.store.setState(this.sk('dd_tripped'), '0');
    } else if (!Number.isFinite(peak) || total > peak) {
      peak = total;
    }
    this.store.setState(this.sk('dd_peak'), String(peak));
    const pct = this.maxDailyDrawdownPct();
    // Off, or the portfolio is too small for the percentage to mean anything (avoid
    // "down 50%" just because the peak was $0.02 of leftover token dust).
    if (!pct || peak < 1 || this.store.getState(this.sk('dd_tripped')) === '1') return;
    const ddPct = ((peak - total) / peak) * 100;
    if (ddPct >= pct) {
      this.store.setState(this.sk('dd_tripped'), '1');
      this.notify(`Drawdown harian ${ddPct.toFixed(1)}% (puncak $${peak.toFixed(2)} → $${total.toFixed(2)}) menyentuh batas ${pct}% — entry baru dijeda sampai hari berikutnya. Posisi yang sudah ada tetap dikelola.`);
    }
  }
  drawdownTripped() {
    if (!this.maxDailyDrawdownPct()) return false;
    return this.store.getState(this.sk('dd_day')) === this.dayKey() && this.store.getState(this.sk('dd_tripped')) === '1';
  }
  // For the dashboard: the breaker status even if not yet touched.
  drawdownStatus() {
    const peak = Number(this.store.getState(this.sk('dd_peak')));
    return {
      enabled: this.maxDailyDrawdownPct() > 0,
      pct: this.maxDailyDrawdownPct(),
      peakUsd: this.store.getState(this.sk('dd_day')) === this.dayKey() && Number.isFinite(peak) ? peak : null,
      tripped: this.drawdownTripped(),
    };
  }

  // ---- one cycle -----------------------------------------------------------
  // Is the process stopping? Wait until there is no running transaction: an entry in the
  // middle of a zap, an exit tx not yet booked, a leftover sale, a compound. SIGINT used to
  // process.exit straight away — a zap token already bought was left without an LP.
  idle() {
    return !this.busy && !(this.activeEntries > 0) && !(this.exiting?.size > 0) && !this.leftoverBusy
      && !this.compound?.running && !(this.selling?.size > 0) && !this.syncBusy && !this.pumpingExit && !this.pumpingEntry;
  }
  async drain(timeoutMs = 100_000) {
    this.stopping = true;
    const t0 = Date.now();
    while (!this.idle() && Date.now() - t0 < timeoutMs) await new Promise((r) => setTimeout(r, 250));
    return this.idle();
  }

  // Age of the running tick. 0 = nothing running.
  tickStuckMs() { return this.busy && this.busySince ? Date.now() - this.busySince : 0; }

  // A tick that hangs longer than the limit is considered DEAD: its flag is released so the
  // next cycle runs again, and the old tick's result is discarded via `tickGen` (the cursor
  // must not move back to the end of a stale range).
  //
  // Why it is needed: a single `await` that never finishes — an RPC socket that died
  // silently, for example — freezes scanning FOREVER without a single error. Even worse,
  // `head` is also only updated INSIDE the tick, so the dashboard keeps showing
  // "lag 0" i.e. healthy while the bot has been blind for 15 hours (lpcopy3, 2026-09-25: 2 target
  // positions missed). The limit is loose (default 3 minutes) — far above the RPC timeout of
  // 45 seconds plus failover between endpoints — so a tick that is merely slow is not cut.
  unwedge() {
    const ms = this.tickStuckMs();
    const limit = (this.cfg.loop?.tick_stuck_seconds || 180) * 1000;
    if (ms < limit) return;
    this.tickGen++;
    this.busy = false; this.busySince = 0;
    this.stats.errors++;
    const msg = `pemindaian macet ${Math.round(ms / 1000)} dtk di tahap "${this.tickStage || '?'}" — dilepas paksa, dilanjutkan dari blok ${this.cursor}`;
    this.tickStage = null;
    this.lastError = msg;
    this.log(msg);
    // This is NEWS, not just a log line: while stuck the bot is completely blind — no
    // entry, no follow-out — and there is no other symptom visible from
    // outside. Sent to ntfy and Telegram via the same important-news path as the
    // entry/exit cards. A consecutive stuck state is reported at most once every 15 minutes
    // so the chat is not flooded; what is held back still goes into the log.
    const now = Date.now();
    if (!this.wedgeNotifiedAt || now - this.wedgeNotifiedAt > 15 * 60_000) {
      this.wedgeNotifiedAt = now;
      this.notify(msg, { cursor: this.cursor, stuckSec: Math.round(ms / 1000) }, 'warn');
    } else {
      this.store.log('warn', msg, { quiet: true, cursor: this.cursor });
    }
  }

  async tick() {
    if (this.stopping || this.compound?.running) return;
    // There is still a running tick: usually just slow — but if it has gone on too
    // long, release it by force (see unwedge) so scanning does not die silently.
    if (this.busy) return this.unwedge();
    // All endpoints are resting: do not add load, just wait.
    if (this.rpc.allCooling()) return;
    this.busy = true;
    this.busySince = Date.now();
    // This tick is stale if its serial number has been passed — it means unwedge considered it
    // dead and another tick took over. A stale one must not touch anything.
    const gen = ++this.tickGen;
    const stale = () => gen !== this.tickGen;
    try {
      // Use the LOWEST head among all endpoints. If the cursor is advanced to the
      // head of the fastest endpoint while getLogs is served by a lagging endpoint,
      // the blocks in between will never be rescanned.
      this.tickStage = 'baca kepala blok';
      const h = await this.rpc.safeHead();
      if (stale()) return;
      this.head = h.min;
      this.headSpread = h.spread;
      if (this.head <= this.cursor) return;
      const maxSpan = this.cfg.loop?.max_block_span || 1500;
      const to = Math.min(this.head, this.cursor + this.span);
      this.tickStage = `pindai blok ${this.cursor + 1}-${to}`;
      const acts = await this.watcher.scan(this.cursor + 1, to);
      if (stale()) return;
      this.lastScanAt = Date.now();
      // A stuck state that was reported must also have its report closed — otherwise a
      // warning hangs in the chat without it ever being clear whether the bot has seen
      // again.
      if (this.wedgeNotifiedAt) {
        this.wedgeNotifiedAt = 0;
        this.notify(`pemindaian pulih — blok kembali terbaca, dilanjutkan dari ${to}`, null, 'info');
      }
      this.stats.scanned += to - this.cursor;
      this.cursor = to;
      this.store.setState(this.sk('cursor'), this.cursor);
      const fresh = this.watcher.persist(acts);
      this.stats.actions += fresh.length;
      // Actions are NOT handled here: scanning keeps going while actions are processed
      // by two queues (see enqueue). The tick used to wait for each action to finish — a single
      // entry (zap, approval, 90 s receipt, retries) held up scanning for minutes,
      // and the target's exit signals in the following blocks were only read afterwards.
      this.enqueue(fresh);
      // External listeners (the dashboard) are told of new actions — e.g. to update the
      // target wallet's research. A listener error must not disturb the copy cycle.
      if (fresh.length && this.onFreshActions) {
        try { this.onFreshActions(fresh); } catch (e) { this.store.log('error', `onFreshActions: ${e.message}`); }
      }
      this.failStreak = 0;
      this.cleared('tick', `pemindaian blok: kembali normal, kursor di blok ${this.cursor}`);
      if (this.span < maxSpan) this.span = Math.min(maxSpan, Math.ceil(this.span * 1.5));
    } catch (e) {
      // A tick that was force-released must not shrink the span or overwrite the
      // lastError of the tick that is running now.
      if (stale()) return;
      this.stats.errors++;
      this.failStreak++;
      this.span = Math.max(150, Math.floor(this.span / 2));
      this.lastError = `${String(e.message).slice(0, 250)} (rentang dikecilkan ke ${this.span} blok)`;
      // Fallback: the cursor does not advance, so the same range is repeated (shrunk) at the
      // next tick and the RPC switches endpoints — no block is missed. Report
      // only if scanning is stuck ≥ 5 times and ≥ 3 minutes in a row.
      this.trouble('tick', `tick: ${e.message} — rentang -> ${this.span}`, { after: 5, afterMs: 3 * 60_000 });
      // add an extra pause so we do not pound an endpoint that is angry
      if (this.failStreak > 2) await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * this.failStreak)));
    } finally {
      // A stale one does not release `busy`: that flag already belongs to the tick that replaced it.
      if (!stale()) { this.busy = false; this.busySince = 0; this.tickStage = null; }
    }
  }

  // Two separate queues: EXIT (withdraw/close/move — protects funds, must not
  // wait) and ENTRY (one at a time, so cash is not used by two entries at once).
  // Both run alongside scanning. While stopping (deploy/restart):
  // what has not been handled is not started — it is already stored without a decision,
  // backfillDecisions evaluates it when the process is alive again (a stale entry is skipped).
  static isExitKind(kind) { return kind === 'decrease' || kind === 'transfer_out'; }
  enqueue(actions) {
    this.exitQueue = this.exitQueue || []; this.entryQueue = this.entryQueue || [];
    for (const a of actions) (Engine.isExitKind(a.kind) ? this.exitQueue : this.entryQueue).push(a);
    this.pumps = this.pumps || {};
    for (const w of ['exit', 'entry']) if (!this.pumps[w]) this.pumps[w] = this.pump(w).finally(() => { this.pumps[w] = null; });
  }
  // Wait for both queues to be empty (tests & callers that need the result).
  async settled() { while (this.pumps && (this.pumps.exit || this.pumps.entry)) await Promise.all([this.pumps.exit, this.pumps.entry].filter(Boolean)); }
  async pump(which) {
    const q = which === 'exit' ? this.exitQueue : this.entryQueue;
    const flag = which === 'exit' ? 'pumpingExit' : 'pumpingEntry';
    this[flag] = true;
    try {
      while (q.length && !this.stopping) {
        const a = q.shift();
        // One action's error must not cut off other actions: the cursor has already advanced, so an action
        // that was not handled is only evaluated at restart. Recorded as an error decision.
        try { await this.handle(a); }
        catch (e) {
          this.stats.errors++;
          if (a.id != null && !this.store.get('SELECT 1 FROM decisions WHERE action_id=?', a.id)) this.decide(a.id, 'error', String(e.message).slice(0, 300));
          this.store.log('error', `aksi ${a.kind} #${a.tokenId ?? '?'}: ${e.message}`);
        }
      }
    } finally { this[flag] = false; }
  }
  queued() { return (this.exitQueue?.length || 0) + (this.entryQueue?.length || 0); }

  decide(actionId, verdict, reason, plan = null, txHash = null, positionId = null) {
    this.store.run('INSERT INTO decisions(action_id,ts,verdict,reason,plan,tx_hash,position_id) VALUES(?,?,?,?,?,?,?)',
      actionId, Date.now(), verdict, reason, plan ? JSON.stringify(plan) : null, txHash, positionId);
    if (verdict === 'copy') this.stats.copied++; else if (verdict === 'skip') this.stats.skipped++;
  }

  async handle(act) {
    // An action may only be decided ONCE. Without this, an action that was processed
    // then processed again (e.g. backfill after the process died midway) would
    // add capital a second time to the same position.
    if (act.id != null && this.store.get('SELECT 1 FROM decisions WHERE action_id=?', act.id)) return;
    const t = this.store.get('SELECT * FROM targets WHERE chain=? AND address=?', this.network, act.target);
    if (!t) return;
    // A pause and a disabled target only stop ENTRY. The target's exit signals
    // for positions we already hold are still followed: they were both decided "skip"
    // forever — a full exit was only rescued by reconciliation, a partial withdrawal was lost.
    const exit = act.kind === 'decrease' || act.kind === 'transfer_out';
    if (!exit && !t.enabled) return this.decide(act.id, 'skip', 'target sedang dimatikan');
    if (!exit && this.paused()) return this.decide(act.id, 'skip', 'bot sedang dijeda');
    if (!exit && this.drawdownTripped()) return this.decide(act.id, 'skip', `drawdown harian menyentuh batas ${this.maxDailyDrawdownPct()}% — entry baru dijeda sampai besok`);
    const rules = this.rulesFrom(act.target);

    if (act.kind === 'increase' || act.kind === 'reentry') return this.handleEntry(act, rules);
    if (act.kind === 'decrease' || act.kind === 'transfer_out') return this.handleExit(act, rules);
    if (act.kind === 'custody_out') return this.decide(act.id, 'skip', 'posisi dititipkan ke kontrak otomasi — bukan sinyal keluar');
    if (act.kind === 'custody_in') return this.decide(act.id, 'skip', 'posisi dikembalikan dari kontrak otomasi');
    if (act.kind === 'transfer_in') return this.decide(act.id, 'skip', 'target menerima posisi dari wallet lain — tidak dicermin');
    if (act.kind === 'claim') return this.noteTargetClaim(act, rules);
    return this.decide(act.id, 'skip', `jenis aksi ${act.kind} tidak dicermin`);
  }

  // How many times a target must harvest fees within 24 hours before being reported, and how
  // long the news is silenced afterwards. Not a money rule — no transaction
  // depends on it — so it is not made a setting.
  static CLAIM_SIGNAL_MIN = 3;
  static CLAIM_SIGNAL_QUIET_MS = 6 * 3600_000;

  // The target harvests fees. By default NOT mirrored: a claim is not a market action, no
  // alpha is lost if we are late, and imitating it only pays gas following
  // someone else's habit (our position's fees are harvested by our own rules — see
  // Compound). The exit.follow_claim rule switches it on: the mirror's fees are also claimed (and
  // sold if that position's automatic harvest is claim+sell mode). Otherwise only the
  // pattern is used: repeated harvesting on a position we mirror often precedes the
  // target's exit, and that is worth reporting once.
  async noteTargetClaim(act, rules = null) {
    const sinceTs = Date.now() - 24 * 3600_000;
    const n = this.store.get(`SELECT COUNT(*) c FROM actions WHERE chain=? AND target=? AND kind='claim'
      AND token_id=? AND ts>=?`, this.network, act.target, String(act.tokenId ?? ''), sinceTs)?.c || 0;
    const mirror = this.store.get(`SELECT id, takeover_ts FROM positions WHERE chain=? AND status='open' AND target=? AND mirror_of=?`,
      this.network, act.target, String(act.tokenId ?? ''));
    const what = `target panen fee${n > 1 ? ` (ke-${n} dalam 24 jam)` : ''}`;
    if (mirror && rules?.exit?.follow_claim) await this.followTargetClaim(act, mirror, what);
    else this.decide(act.id, 'skip', `${what}${mirror ? ` — cermin posisi #${mirror.id}` : ''} — klaim tidak dicermin`);
    if (!mirror || n < Engine.CLAIM_SIGNAL_MIN) return;
    const key = this.sk(`claim_signal:${act.tokenId}`);
    const last = Number(this.store.getState(key, '0')) || 0;
    if (Date.now() - last < Engine.CLAIM_SIGNAL_QUIET_MS) return;
    this.store.setState(key, String(Date.now()));
    const p = this.store.get('SELECT * FROM positions WHERE id=?', mirror.id);
    const toks = await this.chain.tokens([p.token0, p.token1]).catch(() => []);
    const pair = toks.length === 2 ? `${toks[0]?.symbol || '?'}/${toks[1]?.symbol || '?'}` : '';
    this.notify(`target memanen fee ${n}× dalam 24 jam di ${pair || 'pool cermin'} (posisi #${mirror.id}) — sering mendahului keluarnya target`,
      { kind: 'target_claim', positionId: mirror.id, target: act.target, mirrorOf: act.tokenId, count: n, pair });
  }

  // Also claim the mirror's fees. A failed claim is not retried: the fees do not go anywhere,
  // the next automatic harvest / claim still picks them up.
  async followTargetClaim(act, mirror, what) {
    if (mirror.takeover_ts != null) return this.decide(act.id, 'skip', `${what} — posisi #${mirror.id} dalam kendali manual — klaim tidak diikuti`);
    if (this.dryRun() || !this.exec.address()) return this.decide(act.id, 'dry', `${what} — ikut klaim fee posisi #${mirror.id}`, null, null, mirror.id);
    try {
      const r = await this.claimFees(mirror.id, { quiet: true });
      const usd = r.claimedUsd != null ? ` $${r.claimedUsd.toFixed(2)}` : '';
      const note = r.pending ? ' (menunggu konfirmasi)' : r.sold ? ` · ${r.sold}` : '';
      this.decide(act.id, 'copy', `${what} — ikut klaim fee posisi #${mirror.id}${usd}${note}`, null, r.tx || null, mirror.id);
    } catch (e) {
      this.decide(act.id, 'skip', `${what} — klaim fee posisi #${mirror.id} gagal: ${String(e.message).slice(0, 200)}`, null, null, mirror.id);
    }
  }

  // Pool liquidity & volume from DexScreener for the entry filter, or null if
  // unreadable (pool not yet indexed, DexScreener down/slow). An entry
  // signal must not wait long here: past 4 seconds it is treated as unreadable.
  async poolStats(ref) {
    if (!this.market) this.market = new Market({ log: this.log, chain: this.chain });
    const pair = await Promise.race([
      this.market.pair(ref).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]).catch(() => null);
    return pair && !pair.error ? pair : null;
  }

  async handleEntry(act, rules) {
    // A stale entry signal is not copied. The cursor resumes from the stored block,
    // so after the VPS/RPC is down for an hour the scan catches up and finds the target's entry from
    // an hour ago — it used to open right away at the current price, then close again a few ticks
    // later as soon as its exit signal (also long ago) was read: zap, pool fee, and
    // gas paid twice for a position that served no purpose. An EXIT signal is still followed
    // whatever its age — that protects funds.
    const stale = await this.staleEntry(act);
    if (stale) return this.decide(act.id, 'skip', stale);
    if (!act.token0 || !act.token1 || (act.venue === 'v4' && !act.poolKey)) {
      return this.decide(act.id, 'skip', 'data pool posisi target tidak terbaca (NFT sudah dibakar?)');
    }
    // A pool price / target position value that failed to read at scan time (a momentary RPC) used to
    // end in "pool state unreadable" or "target position only $0.00" — the entry signal was
    // lost. Re-read here before evaluating.
    if ((!act.slot0 || act.valueQuote == null) && act.poolRef) await this.refreshActionState(act);
    // already have a mirror of this position? then this is an addition; follow by adding via a new mint
    const cd = rules.filters.cooldown_seconds * 1000;
    const last = this.lastCopyAt.get(act.poolRef) || 0;
    if (cd && Date.now() - last < cd) {
      return this.decide(act.id, 'skip', `cooldown pool ${Math.round((cd - (Date.now() - last)) / 1000)}s`);
    }
    const sum = this.positions.summary(this.ethUsd);
    const spent = this.spentTodayUsd();

    if (rules.filters.min_pool_age_minutes > 0 && act.venue === 'v4' && act.poolRef) {
      try {
        const age = await this.chain.poolAgeMinutes(act.poolRef);
        if (age < rules.filters.min_pool_age_minutes) {
          return this.decide(act.id, 'skip', `pool baru ${age.toFixed(0)} menit (< ${rules.filters.min_pool_age_minutes})`);
        }
      } catch { /* unreadable: do not block */ }
    }
    // Market filter: a pool whose liquidity or volume is thin does not produce fees
    // however much the target does there — the capital only bears the token's risk
    // without being paid. The figures come from DexScreener, the same source as the Volume
    // column on the dashboard, so the threshold set in Rules is comparable to what is seen.
    const fMin = rules.filters;
    if ((fMin.min_liquidity_usd > 0 || fMin.min_volume24h_usd > 0) && act.poolRef) {
      const pair = await this.poolStats(act.poolRef);
      // A pool not yet indexed by DexScreener has no figures at all. It is let
      // through — the same as the pool age that is unreadable above: this filter rejects
      // a pool PROVEN quiet, not a pool that has not yet been recognised.
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
    // The metadata of a token not yet known is read from RPC; a temporary error is retried briefly
    // (the target's entry signal does not wait long).
    let toks;
    for (let i = 0; ; i++) {
      try { toks = await this.chain.tokens([act.token0, act.token1]); break; }
      catch (e) { if (i >= 2) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
    }
    // Live mode: the size is also limited by real cash, so a position slightly over
    // the balance is opened smaller instead of failing midway through the bridge. Simulation mode
    // deliberately not — the test wallet is often empty, and the simulation would become useless.
    const live = !this.dryRun() && this.exec.address();
    const cash = live ? await this.spendableCash().catch(() => null) : null;
    // If we already have a mirror of this position, the target is ADDING — so we
    // add too, rather than opening a second position. Looked up BEFORE evaluating: the position count
    // limit does not apply (no new position) and the per-position limit is computed from the total.
    // There can be more than one mirror (range modes other than "exact"): what decides is the
    // mirror whose range is the SAME as the plan; that is the one added to.
    const mirrors = this.store.all("SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? AND token_id IS NOT NULL ORDER BY id",
      this.network, act.tokenId ?? '', act.target);
    // A mirror under manual control: the target's additions are not followed — adding
    // capital to a deliberately taken-over position is the owner's decision.
    const held = mirrors.find((mp) => mp.takeover_ts != null);
    if (held) return this.decide(act.id, 'skip', `posisi #${held.id} dalam kendali manual — tambahan target tidak diikuti`);
    const usdOfMirror = (mp) => {
      const lv = this.positions.live.find((p) => p.id === mp.id);
      return lv?.valueUsd ?? Math.max(0, (mp.cost_quote || 0) - (mp.out_quote || 0)) * usdPerQuote(mp.quote_symbol, this.ethUsd, this.chain);
    };
    let mirror = mirrors[0] || null;
    const ctx = {
      chain: this.chain, rules, slot0: act.slot0, dec0: toks[0].decimals, dec1: toks[1].decimals,
      ethUsd: this.ethUsd, openExposureUsd: sum.exposureUsd, spentTodayUsd: spent, openCount: sum.openCount,
      cash, existingUsd: mirror ? usdOfMirror(mirror) : null,
    };
    let d = planEntry(act, ctx);
    // The range from the rules (recenter/scale/…) is not the same as the first mirror: look for another mirror
    // with the same range; if none, this is a NEW position with the new-position limit.
    if (mirror && d.verdict === 'copy' && !(mirror.tick_lower === d.plan.tickLower && mirror.tick_upper === d.plan.tickUpper)) {
      const same = mirrors.find((mp) => mp.tick_lower === d.plan.tickLower && mp.tick_upper === d.plan.tickUpper) || null;
      mirror = same;
      d = planEntry(act, { ...ctx, existingUsd: same ? usdOfMirror(same) : null });
    }
    if (d.verdict !== 'copy') return this.decide(act.id, 'skip', d.reason);

    // A range too far from the price is not copied now: its capital just sits idle
    // (the same exit rule would close it again within a minute). If reopen is on,
    // the target position is watched and the mirror opened once the price comes near.
    const far = rules.exit.out_of_range_pct > 0 ? m.distanceFromRangePct(act.slot0.tick, d.plan.tickLower, d.plan.tickUpper) : 0;
    if (far > rules.exit.out_of_range_pct) {
      const watch = this.watchReentry(act, rules, { why: 'ditunda', actionId: act.id });
      return this.decide(act.id, 'skip', `rentang ${fmtPct(far)}% dari harga (batas ${rules.exit.out_of_range_pct}%) — ${
        watch ? `ditunda; dibuka begitu harga ≤ ${watch.nearPct}% dari rentang dan target masih di dalam` : 'tidak disalin'}`);
    }

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
      this.notify(`${act.kind === 'reentry' ? 'LP dibuka lagi (harga mendekati rentang, target masih di dalam)' : 'LP disalin'}: ${r.note}`, {
        kind: 'entry', positionId: r.positionId, txHash: r.txHash, adding: !!r.adding, reentry: act.kind === 'reentry',
        pair: r.pair, valueUsd: r.valueUsd, curTick: r.curTick, steps: r.steps,
        target: act.target, mirrorOf: act.tokenId, reason: d.reason,
        // The target's side of THIS event: how much it put in and when. The entry
        // card places it beside our amount so the comparison reads.
        targetUsd: d.plan.targetValueUsd ?? null, targetTs: act.ts ?? null, targetRange: d.plan.targetRange ?? null,
      });
    } catch (e) {
      this.stats.errors++;
      this.decide(act.id, 'error', String(e.message).slice(0, 300), d.plan);
      this.store.log('error', `eksekusi masuk: ${e.message}`);
    }
  }

  // Daily budget = capital of positions OPENED in the last 24 hours + ADDITIONS to positions
  // older (these were not counted before: adding to a 2-day-old position passed the budget).
  spentTodayUsd() {
    const since = Date.now() - 86400_000;
    return (this.store.get(
      "SELECT COALESCE(SUM(cost_quote * CASE WHEN quote_symbol IN (?,?) THEN ? ELSE 1 END),0) AS s FROM positions WHERE chain=? AND opened_ts > ?",
      this.chain.nativeSymbol, this.chain.wethSymbol, this.ethUsd, this.network, since)?.s || 0) + this.increasesUsdSince(since);
  }

  // Remaining copy quota for the dashboard: the room still left under each ceiling used by
  // planEntry — daily budget, total exposure, position count, cash. Computed from the GENERAL
  // rules; a target with special rules has its own ceilings, but cash and the positions
  // already open are the same for everyone. Ready-to-use cash = cash above the gas reserve, from the
  // last cash reading (not a new RPC — overview is polled every 5 seconds).
  copyRoom(cash) {
    const { sizing: s, filters: f } = rulesFor(this.cfg.rules);
    const sum = this.positions.summary(this.ethUsd);
    const spent = this.spentTodayUsd();
    let cashUsd = null;
    if (cash) {
      const reserve = Number(this.exec.gasReserveCached?.() ?? 0n) / 1e18;
      cashUsd = cash.usdg + Math.max(0, cash.eth + cash.weth - reserve) * this.ethUsd;
    }
    return {
      daily: { limit: s.daily_budget_usd, used: spent, left: Math.max(0, s.daily_budget_usd - spent) },
      exposure: { limit: s.max_total_exposure_usd, used: sum.exposureUsd, left: Math.max(0, s.max_total_exposure_usd - sum.exposureUsd) },
      slots: { limit: f.max_open_positions, used: sum.openCount, left: Math.max(0, f.max_open_positions - sum.openCount) },
      perPositionUsd: s.max_quote_per_position_usd,
      cashUsd,
    };
  }

  // Value (USD) of liquidity additions copied since `since`, to positions
  // opened BEFORE `since` (newer ones are already counted via their cost_quote).
  increasesUsdSince(since) {
    const rows = this.store.all(
      "SELECT d.plan FROM decisions d JOIN positions p ON p.id = d.position_id WHERE p.chain=? AND d.verdict='copy' AND d.ts > ? AND p.opened_ts <= ? AND d.plan IS NOT NULL",
      this.network, since, since);
    let usd = 0;
    for (const r of rows) {
      try { const pl = JSON.parse(r.plan); if (pl.action === 'increase' && Number.isFinite(pl.valueUsd)) usd += pl.valueUsd; } catch { /* rencana lama */ }
    }
    return usd;
  }

  async handleExit(act, rules) {
    // ALL mirrors of this position. With range modes other than "exact" one target position can
    // have two mirrors (the target adds in a range recomputed differently); it used to be that only
    // one was withdrawn/closed along with it.
    let mirrors = this.store.all(
      "SELECT * FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=? ORDER BY id", this.network, act.tokenId ?? '', act.target);
    if (!mirrors.length && act.poolRef && act.tickLower != null && act.tickUpper != null) {
      // Pool + range fallback ONLY for positions whose tokenId origin is not recorded
      // (mirror_of empty). It used to apply to all positions: a target with positions A and B
      // identical — we only mirror A — closes B, then our A mirror is closed too.
      // (A transfer_out action carries no pool info; binding undefined to SQLite throws.)
      const pos = this.store.get(
        "SELECT * FROM positions WHERE chain=? AND status='open' AND pool_ref=? AND target=? AND tick_lower=? AND tick_upper=? AND mirror_of IS NULL AND takeover_ts IS NULL ORDER BY id ASC LIMIT 1",
        this.network, act.poolRef, act.target, act.tickLower, act.tickUpper);
      if (pos) {
        this.store.log('warn', `cermin posisi dicocokkan lewat pool+rentang (bukan tokenId) untuk aksi #${act.tokenId} -> posisi #${pos.id}`);
        mirrors = [pos];
      }
    }
    if (!mirrors.length) return this.decide(act.id, 'skip', 'tidak ada cermin posisi yang cocok');
    // Manual control: the target's exit signal is not followed for that mirror.
    const manualHeld = mirrors.filter((mp) => mp.takeover_ts != null);
    mirrors = mirrors.filter((mp) => mp.takeover_ts == null);
    if (!mirrors.length) {
      return this.decide(act.id, 'skip', `posisi #${manualHeld.map((mp) => mp.id).join(', #')} dalam kendali manual — keluar target tidak diikuti`);
    }

    // how much was the target's L before withdrawing? = L after the action + what was withdrawn
    //
    // A failed read MUST NOT be taken as zero: zero means "target closed fully" and our mirror
    // is burned entirely — although the target may have withdrawn only 10%. Tried several
    // times; if still unreadable, this action is skipped: if the target really exited
    // fully, exit reconciliation (every sync) is what closes it.
    //
    // Read AT THAT ACTION'S BLOCK (state after the block), not `latest`: when the bot lags,
    // `latest` already contains the target's later actions (withdraw 50% then 50% again → the first action
    // reads as a full close), and a lagging node answers the liquidity BEFORE the action.
    // Other actions on the same NFT in the same block (after this one) are added back first.
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
    // Several mirrors, one decision per action.
    const pick = outs.find((o) => o.verdict === 'copy') || outs.find((o) => o.verdict === 'error')
      || outs.find((o) => o.verdict === 'dry') || outs[0];
    const reason = outs.map((o) => `#${o.posId}: ${o.reason}`).join(' · ');
    return this.decide(act.id, pick.verdict, reason.slice(0, 600), pick.plan, pick.txHash ?? null, pick.positionId ?? null);
  }

  // One mirror for one target exit action. Writes no decision — its result
  // is returned to handleExit: {verdict, reason, plan, txHash, positionId, posId}.
  async exitMirror(act, rules, pos, before) {
    const out = (verdict, reason, plan = null, extra = {}) => ({ verdict, reason, plan, posId: pos.id, ...extra });
    // The target moves/sells its position NFT: for us that is a full exit signal.
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
        // How much the TARGET withdrew in this action, and when — the close card uses it
        // to answer "how much did the one we copy exit with" without opening the dashboard.
        targetUsd: (act.valueQuote || 0) * usdPerQuote(act.quoteSymbol, this.ethUsd, this.chain) || null,
        targetTs: act.ts ?? null,
      });
      return out('copy', `${d.reason} — ${r.note}`, d.plan, { txHash: r.txHash, positionId: pos.id });
    } catch (e) {
      this.stats.errors++;
      return out('error', String(e.message).slice(0, 300), d.plan);
    }
  }

  // Skip reason if this entry action is older than loop.stale_action_seconds (default
  // 300; 0 = off), otherwise null. act.ts is only an estimate (block number × ~101 ms from a
  // reference block), so before a signal is discarded its age is confirmed from the real block timestamp.
  // Block unreadable: the estimate is used — it tends to UNDERSTATE the age when blocks
  // slow down, not overstate it.
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
    return `sinyal masuk basi — target masuk ${duration(age)} lalu (batas ${duration(limitMs)}); harga & pool sudah berubah, tidak disalin`;
  }

  async refreshActionState(act) {
    for (let i = 0; i < 3 && (!act.slot0 || act.valueQuote == null); i++) {
      if (i) await new Promise((r) => setTimeout(r, 1000 * i));
      try {
        if (!act.slot0) act.slot0 = this.chain.isV3Venue(act.venue) ? await this.chain.slot0V3(act.poolRef) : await this.chain.slot0V4(act.poolRef);
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

  // The liquidity of a position (the target's) on chain, per its venue. null = unreadable
  // (temporary RPC error) — the caller MUST NOT take it as zero.
  //
  // v3: it used to also be read from the v4 PositionManager with a v3 tokenId — the figure of another v4
  // position (or zero) — so a 10% partial withdrawal by the target could become a full close of
  // our mirror. The v3 NPM reverts positions() for a burned NFT (decrease+collect+burn
  // in one multicall, the most common exit pattern); that legitimate revert = zero liquidity.
  async targetLiquidity(venue, tokenId, block = null) {
    const read = async (tag) => {
      if (this.chain.isV3Venue(venue)) {
        const [w] = await this.rpc.ethCallMany([{ to: this.chain.npmFor(venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(tokenId)]) }], tag, { strict: true });
        if (w == null) return 0n;   // legitimate revert (strict throws for other errors): NFT burned
        if (w === '0x') return null;
        try { return BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { return null; }
      }
      const [w] = await this.rpc.ethCallMany([{ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(tokenId)]) }], tag, { strict: true });
      return w && w !== '0x' ? BigInt(w) : null;
    };
    // The action's block first; a node that does not (or no longer) have that block's state throws → `latest`.
    if (block != null && Number.isSafeInteger(Number(block)) && Number(block) > 0) {
      try {
        const L = await read('0x' + Number(block).toString(16));
        if (L != null) return { liquidity: L, atBlock: true };
      } catch { /* pakai latest */ }
    }
    const L = await read('latest');
    return L == null ? null : { liquidity: L, atBlock: false };
  }

  // The sum of liquidity deltas of the target's other actions on the same NFT, in the same block,
  // AFTER this action (log order). The state "at the block" already contains all of them.
  laterDeltasInBlock(act) {
    if (act.block == null || act.logIndex == null || act.tokenId == null) return 0n;
    const rows = this.store.all(
      "SELECT liquidity FROM actions WHERE chain=? AND target=? AND venue=? AND token_id=? AND block=? AND log_index>? AND kind IN ('increase','decrease') AND liquidity IS NOT NULL",
      this.network, act.target, act.venue, String(act.tokenId), act.block, act.logIndex);
    return rows.reduce((a, r) => { try { return a + BigInt(r.liquidity); } catch { return a; } }, 0n);
  }

  // The poolKey of our position. The main source is our own DB row — it is recorded at mint and
  // cannot be lost. The chain is only a fallback, and its result MUST be checked: for an NFT
  // that has been burned or does not exist yet, getPoolAndPositionInfo does NOT revert but
  // returns an all-zero poolKey. That zero slips silently into TAKE_PAIR and makes the
  // burn fail with CurrencyNotSettled() — a message that does not point at all
  // to the cause. Seen when a dry-run mirrored Bang GE.
  async poolKeyOf(pos) {
    if (pos.venue !== 'v4') return null;
    const ok = (pk) => pk && pk.currency1 && !/^0x0+$/i.test(pk.currency1);
    const stored = {
      currency0: pos.token0, currency1: pos.token1,
      fee: pos.fee, tickSpacing: pos.tick_spacing, hooks: pos.hooks,
    };
    if (ok(stored) && stored.fee != null && stored.tickSpacing != null) return stored;
    if (!pos.token_id) return null;
    const [w] = await this.rpc.ethCallMany([{ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPoolAndPositionInfo', [BigInt(pos.token_id)]) }]);
    if (!w || w === '0x') return null;
    const d = IF_POSM.decodeFunctionResult('getPoolAndPositionInfo', w);
    const pk = {
      currency0: d[0].currency0, currency1: d[0].currency1,
      fee: Number(d[0].fee), tickSpacing: Number(d[0].tickSpacing), hooks: d[0].hooks,
    };
    return ok(pk) ? pk : null;
  }

  // ---- execution ----------------------------------------------------------
  async simulateEntry(plan) {
    const tx = this.chain.isV3Venue(plan.venue)
      ? this.exec.buildV3Mint(plan, this.exec.deadline())
      : this.exec.buildV4Mint(plan, this.exec.deadline());
    return this.exec.simulate(tx);
  }

  /**
   * Make sure we hold enough of this pool's QUOTE ASSET.
   *
   * This is what lets the bot follow a target to a pool quoted in any asset. On this chain
   * 50% of pools are quoted in native ETH and only 27% in USDG, so cash that exists in
   * just one asset would block half the opportunities. The order tried:
   *   1. native ETH <-> WETH  : wrap/unwrap, 1:1, no slippage
   *   2. USDG <-> ETH         : swap through the deepest ETH/USDG pool
   *
   * A note on hooks: ALL ETH/USDG pools on this chain use a hook (dynamic fee).
   * For a swap that is far safer than for an LP — a swap is atomic and
   * protected by amountOutMinimum, so the hook cannot hold our funds; a hook on an
   * LP pool is what is dangerous because it can block withdrawals. So the
   * "reject hook" filter is deliberately NOT applied here.
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

    // 1. native <-> WETH (free, 1:1)
    if (quoteTok === this.chain.ADDR.weth) {
      const nat = await balOf(this.chain.ADDR.native);
      const want = needQuoteRaw - have;
      if (nat > 0n) {
        const amt = nat < want ? nat : want;
        const h = await this.exec.send(this.exec.buildWrapEth(amt), { kind: 'wrap_eth', detail: { amountInRaw: String(amt) } });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error('bungkus ETH gagal');
        notes.push(`bungkus ${(Number(amt) / 1e18).toFixed(5)} ${this.chain.nativeSymbol}`);
        have = await balOf(quoteTok);
      }
    } else if (quoteTok === this.chain.ADDR.native) {
      const wr = await balOf(this.chain.ADDR.weth);
      const want = needQuoteRaw - have;
      if (wr > 0n) {
        const amt = wr < want ? wr : want;
        const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth', detail: { amountInRaw: String(amt) } });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`buka bungkus ${this.chain.wethSymbol} gagal`);
        notes.push(`buka bungkus ${(Number(amt) / 1e18).toFixed(5)} ${this.chain.wethSymbol}`);
        have = await balOf(quoteTok);
      }
    }
    if (have >= needQuoteRaw) return notes;

    // 2. USDG <-> ETH bridge
    if (!rules.swap.enabled) throw new Error('kas ada di aset kuotasi lain dan auto-swap dimatikan');
    const wantEth = quoteTok === this.chain.ADDR.native || quoteTok === this.chain.ADDR.weth;
    const payTok = wantEth ? this.chain.ADDR.usdg : this.chain.ADDR.native;
    // ETH cash = native ETH above the gas reserve + WETH. WETH is only unwrapped
    // right before the swap (see unwrapFor). Only native ETH used to be counted, so a
    // wallet holding 0.07 WETH and native ETH below the reserve failed with
    // "ETH balance empty" although the cash existed.
    const payHave = wantEth ? await balOf(this.chain.ADDR.usdg) : (await balOf(this.chain.ADDR.native)) + (await balOf(this.chain.ADDR.weth));
    const { usdgSymbol, usdgDecimals, nativeSymbol, wethSymbol } = this.chain;
    const qSym = this.chain.QUOTES[quoteTok]?.symbol || '?';
    const qAmt = (raw) => fmtUnits(raw, this.chain.QUOTES[quoteTok]?.decimals ?? 18);
    const payName = wantEth ? usdgSymbol : `${nativeSymbol}+${wethSymbol}`;
    const payAmt = (raw) => `${fmtUnits(raw, wantEth ? usdgDecimals : 18)} ${wantEth ? usdgSymbol : nativeSymbol}`;
    const reserveNote = wantEth ? '' : ` di atas cadangan gas ${fmtUnits(gasReserve, 18)} ${nativeSymbol}`;
    if (payHave <= 0n) {
      throw new Error(`kas kurang: butuh ${qAmt(needQuoteRaw)} ${qSym}, punya ${qAmt(have)} ${qSym} — saldo ${payName}${reserveNote} kosong, tidak ada kas untuk dijembatani`);
    }
    const tooShort = (pay) => new Error(
      `kas kurang untuk jembatan: butuh ${payAmt(pay)} untuk ${qAmt(needQuoteRaw - have)} ${qSym}, punya ${payAmt(payHave)}${wantEth ? '' : ` (${nativeSymbol}+${wethSymbol}${reserveNote})`}`);
    const unwrapFor = async (pay) => {
      if (wantEth) return;
      const nat = await balOf(this.chain.ADDR.native);
      if (nat >= pay) return;
      const amt = pay - nat;
      const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth', detail: { amountInRaw: String(amt) } });
      if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`buka bungkus ${wethSymbol} gagal`);
      notes.push(`buka bungkus ${fmtUnits(amt, 18)} ${wethSymbol}`);
    };
    // How much is needed? quoteTok WETH is still bought as native ETH then wrapped.
    const shortEthLike = needQuoteRaw - have;
    const slipBps = rules.swap.max_slippage_bps;

    // Main path: the Kyber aggregator. A REVERSE-direction quote (what is needed -> what is paid)
    // gives an estimate of how much must be paid to get shortEthLike.
    const outTok = wantEth ? this.chain.ADDR.native : this.chain.ADDR.usdg;
    const direction = wantEth ? `${usdgSymbol}→${nativeSymbol}` : `${nativeSymbol}→${usdgSymbol}`;
    // Why EVERY cause of falling back is recorded, including an empty quote:
    // if Kyber gives nothing, what fails is the direct pool below — and
    // the message that reached the user used to be only that pool's revert, with no hint that
    // the trigger was Kyber. On 25 Sep 2026 an entry on lp2 was cancelled exactly like that: Kyber's
    // reverse quote null, zero log lines, then three entry attempts ran out with "gas
    // estimation failed". `kyberNote` is carried into the fallback's error message so the chain stays intact.
    const rev = await this.kyber.quoteRetry(outTok, payTok, shortEthLike);
    let kyberNote;
    if (rev && rev.amountOut > 0n) {
      let payK = (rev.amountOut * BigInt(10_000 + slipBps)) / 10_000n;
      if (payK > payHave) throw tooShort(payK);
      await unwrapFor(payK);
      let r = null, kyberFailed = false;
      try {
        r = await this.kyber.swap(payTok, outTok, payK, {
          slippageBps: slipBps, maxLossBps: rules.swap.max_price_impact_bps, kind: 'bridge_swap', detail: { via: 'kyber', wantEth },
        });
      } catch (e) {
        // The route loses too much or the tx was rejected by the chain repeatedly — a market matter, so the direct
        // pool below is still tried (its price impact is filtered by the same limit).
        // A failed safeguard and an unread receipt still stop the entry.
        if (!(e.loss || e.reverted)) throw e;
        kyberFailed = true;
        kyberNote = `Kyber tidak jadi (${e.message})`;
        this.store.log('warn', `jembatan via Kyber tidak jadi (${e.message}) — mencoba pool langsung`, { quiet: true });
      }
      if (r) {
        notes.push(`jembatan ${direction} via ${aggLabel(r.quote)} (${r.quote.dex})`);
        return this.wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes);
      }
      if (!kyberFailed) {
        kyberNote = 'Kyber tidak bisa merutekan';
        this.store.log('warn', 'Kyber tidak bisa merutekan jembatan — mencoba pool langsung', { quiet: true });
      }
    } else {
      kyberNote = 'Kyber tidak memberi kutipan';
      this.store.log('warn', `Kyber tidak memberi kutipan jembatan ${direction} — mencoba pool langsung`, { quiet: true });
    }

    // Fallback: a single direct ETH/USDG pool, only used if Kyber is unavailable.
    // This path is fragile and MUST be simulated first. Measured 25 Sep 2026 on Robinhood
    // Chain: 12 of 12 registered ETH/USDG pools are hooked, and all 12 refuse the
    // swap from the UniversalRouter with WrappedError (0x90bfb865) in beforeSwap. Sent
    // blind, all that happens is the gas estimate reverting 3x per attempt then the entry dying
    // with "gas estimation failed (probably revert)" — a message that accuses a stale node
    // when it is the pool that refuses. Simulation = a single eth_call, and the right error.
    const br = await this.chain.bestEthUsdgPool();
    if (!br) throw new Error(`pool jembatan ${nativeSymbol}/${usdgSymbol} tidak ditemukan`);
    const slip = 1 + rules.swap.max_slippage_bps / 10000;
    const zeroForOne = !wantEth;   // sell ETH(currency0) -> buy USDG
    const minOut = (shortEthLike * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;

    // Round 1 — filter by computation only, sending nothing. The cheap gates
    // (price, cash, impact) run first so the router allowance and unwrap in
    // round 2 are never sent for a bridge that is certain to be rejected anyway.
    const layak = [];
    let impactMin = null, payMin = null;
    for (const c of br.candidates || [br]) {
      const price = m.priceFromSqrt(c.slot0.sqrtPriceX96, 18, usdgDecimals); // stablecoin per native
      const payRaw = wantEth
        ? BigInt(Math.ceil((Number(shortEthLike) / 1e18) * price * 10 ** usdgDecimals * slip))
        : BigInt(Math.ceil((Number(shortEthLike) / 10 ** usdgDecimals / price) * 1e18 * slip));
      if (payRaw <= 0n) return notes;
      // Insufficient cash in this pool is not necessarily insufficient in another pool (prices differ), so
      // the candidate is skipped, not failing the whole bridge. The cheapest is kept
      // for its error message.
      if (payRaw > payHave) { if (payMin == null || payRaw < payMin) payMin = payRaw; continue; }
      if (rules.swap.max_price_impact_bps > 0) {
        const impact = m.priceImpactBps(c.slot0.sqrtPriceX96, c.liquidity, payRaw, zeroForOne);
        if (impact != null && impact > rules.swap.max_price_impact_bps) {
          if (impactMin == null || impact < impactMin) impactMin = impact;
          continue;
        }
      }
      layak.push({ pool: c, payRaw });
    }
    if (!layak.length) {
      if (impactMin != null) throw new Error(`jembatan menggeser harga ${impactMin.toFixed(0)} bps (batas ${rules.swap.max_price_impact_bps})`);
      throw tooShort(payMin ?? 0n);
    }

    // Round 2 — simulation. The router allowance is prepared first: without allowance, the USDG-side swap reverts
    // because of its transfer and that would be misread as "the pool refuses".
    if (!zeroForOne) {
      for (const a of await this.exec.ensureRouterAllowance(this.chain.ADDR.usdg)) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
    }
    // Candidates are ordered from the deepest liquidity, but the one used is the one that PASSES
    // simulation — on this chain even the deepest pool can refuse through its hook.
    let choose = null, rejected = 0, rejectError = null;
    for (const { pool, payRaw } of layak) {
      // The simulation is only honest if the funds are already in native ETH form, the same as when
      // sent. Unwrapping WETH is 1:1 with no slippage and was always done before sending
      // anyway, so it adds no risk even if the swap is cancelled.
      await unwrapFor(payRaw);
      const tx = this.exec.buildSwapV4(pool.poolKey, zeroForOne, payRaw, minOut, this.exec.deadline());
      const sim = await this.exec.simulate(tx);
      if (sim.ok) { choose = { pool, tx, payRaw }; break; }
      rejected++; rejectError = sim.error;
    }
    if (!choose) {
      throw new Error(`jembatan ${direction} gagal: ${kyberNote}, dan ${rejected} pool ${nativeSymbol}/${usdgSymbol} langsung menolak swap${rejectError ? ` (${String(rejectError).slice(0, 120)})` : ''}`);
    }
    const h = await this.exec.send(choose.tx, { kind: 'bridge_swap', detail: { pool: choose.pool.poolId, wantEth, payRaw: choose.payRaw.toString(),
      tokenIn: wantEth ? this.chain.ADDR.usdg : this.chain.ADDR.native, tokenOut: wantEth ? this.chain.ADDR.native : this.chain.ADDR.usdg } });
    if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`swap jembatan gagal (${h})`);
    notes.push(`jembatan ${direction}`);
    return this.wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes);
  }

  // If what is needed is WETH, wrap the ETH result of the bridge.
  async wrapIfWeth(quoteTok, needQuoteRaw, balOf, notes) {
    if (quoteTok === this.chain.ADDR.weth) {
      const nat = await balOf(this.chain.ADDR.native);
      const want = needQuoteRaw - (await balOf(quoteTok));
      const amt = nat < want ? nat : want;
      if (amt > 0n) {
        const hw = await this.exec.send(this.exec.buildWrapEth(amt), { kind: 'wrap_eth', detail: { amountInRaw: String(amt) } });
        if (!(await this.exec.waitReceipt(hw)).ok) throw new Error('bungkus ETH gagal');
        notes.push(`bungkus ke ${this.chain.wethSymbol}`);
      }
    }
    return notes;
  }

  // Provide the missing token by swapping from the quote side, then mint.
  async executeEntry(plan, act) {
    if (this.stopping) throw new Error('bot sedang berhenti (restart) — coba lagi sebentar');
    if (this.compound?.running) throw new Error('auto-compound sedang diproses — coba lagi sebentar');
    if (plan.positionId && (this.exiting?.has(plan.positionId) || this.compound?.pending(plan.positionId))) {
      throw new Error('posisi sedang diproses — tunggu konfirmasi transaksi');
    }
    this.activeEntries = (this.activeEntries || 0) + 1;
    // This pool's tokens are being collected for a mint: the leftover sell queue (every second), the sell
    // button, and manual swaps must not sell them midway — zap tokens used to
    // be sold before the mint, then the mint reverted/shrank and the zap was paid for in vain.
    const held = [plan.token0, plan.token1].filter(Boolean).map((x) => String(x).toLowerCase());
    this.entryTokens = this.entryTokens || new Map();
    for (const tk of held) this.entryTokens.set(tk, (this.entryTokens.get(tk) || 0) + 1);
    const trace = {};
    const waits = this.entryRetryWaits || [3000, 8000];
    try {
      // A temporary error (RPC down, lagging node, stale quote, mint reverting because the
      // price moved) used to cancel the entry straight away — and if the zap was done, the token
      // just bought was sold back: hit by the pool fee twice for a position that
      // was never opened. Now repeated from the real balance. After a zap, the bridge step
      // is skipped (the quote cash was deliberately spent) and the zap amount is capped in total.
      for (let i = 0; ; i++) {
        try { return await this.sendEntry(plan, act, trace, { resume: !!(trace.zapped || trace.bridged) }); }
        catch (e) {
          if (e.pendingMint || e.priorLanded || trace.minted || i >= waits.length || this.stopping || !Engine.retryableEntry(e)) throw e;
          // A tx that was thought not to have landed actually landed: do not resend anything.
          if (e.txHash && this.exec.txLanded && await this.exec.txLanded(e.txHash, 2)) throw e;
          this.store?.log?.('warn', `entry ${plan.poolRef ? String(plan.poolRef).slice(0, 10) + '…' : ''} gagal (${String(e.message).slice(0, 160)}) — coba lagi dalam ${waits[i] / 1000} dtk (${i + 2}/${waits.length + 1})`, { quiet: true });
          await new Promise((r) => setTimeout(r, waits[i]));
        }
      }
    } catch (e) {
      // The zap is done but the LP still failed: the token bought must not be left
      // naked in the wallet — it goes into the sell queue, like a position's leftovers. A failed rescue must not
      // mask the original error. A mint that may still land (pendingMint) or an
      // old tx that actually landed (priorLanded): the token may already be inside the position.
      if (trace.zapped && !e.pendingMint && !e.priorLanded && !trace.minted) await this.rescueZap(plan, trace.zapped, e).catch((x) => this.store?.log?.('warn', `antrekan token zap gagal: ${x.message}`, { quiet: true }));
      throw e;
    }
    finally {
      this.activeEntries--;
      for (const tk of held) {
        const n = (this.entryTokens.get(tk) || 1) - 1;
        if (n > 0) this.entryTokens.set(tk, n); else this.entryTokens.delete(tk);
      }
    }
  }

  // Is this token being used by a running entry?
  tokenInEntry(token) { return !!this.entryTokens?.has(String(token || '').toLowerCase()); }

  // Entry errors that are NOT worth retrying: user decisions/limits, cash that really
  // is insufficient, Kyber safeguards, and txs that may still land. Others (RPC, revert
  // of estimate/mint, stale quote, moving price) are retried.
  static retryableEntry(e) {
    return !/dimatikan|kas kurang|saldo kurang|satu sisi|rugi|dampak harga|menggeser harga|sedang diproses|auto-compound|insufficient funds|tidak ditemukan|tidak cocok|janggal|menyimpang|simulasi|kunci privat|dibatalkan|belum terkonfirmasi|tidak cukup untuk membuka/i.test(String(e?.message || ''));
  }

  async rescueZap(plan, z, err) {
    const token = String(z.token).toLowerCase();
    // A quote asset (USDG/ETH/WETH) is cash, not leftover — and selling it "to" the zap-paying
    // memecoin would buy the memecoin again.
    if (this.chain.QUOTES[token] || isNative(token)) return;
    const bal = (await this.exec.balances([token])).get(token) || 0n;
    const gained = bal > BigInt(z.before ?? 0) ? bal - BigInt(z.before ?? 0) : 0n;
    if (gained === 0n) return;
    const meta = await this.chain.token(token).catch(() => null);
    // Another sweep/zap item for the same token (posId null) is ADDED to, not overwritten:
    // two consecutive failed entries on the same token used to leave half of it.
    // `before` already contains the old item's balance, so only this zap's result is added.
    const old = this.leftovers().find((x) => (x.posId ?? null) === null && x.token === token);
    const amount = gained + (old ? BigInt(old.amount || '0') : 0n);
    this.keepLeftover({ posId: null, target: plan.target ?? null, token, quote: z.quote, amount: amount.toString(), tries: 0,
      since: Date.now(), source: 'zap' }, `LP gagal setelah zap: ${err.message}`);
    this.markZapsRescued(z.hashes);
    this.store.log('warn', `LP gagal setelah zap — ${fmtUnits(gained, meta?.decimals ?? 18)} ${meta?.symbol || token.slice(0, 8)} masuk antrean jual`);
  }

  // Zap surplus on an entry that SUCCEEDED. The zap buys as much as needed at the pool price
  // at that moment; the price moved before the mint landed (#417: 9 seconds, 482 ticks) and near
  // the range edge the position's composition changes drastically — the mint only deposited part
  // (371 of 3,394 NOSH) and the rest was left naked in the wallet. rescueZap only
  // runs if the LP FAILED, recoverStrandedZaps deliberately skips zaps whose mint
  // succeeded, and the wallet sweep skips tokens of still-open positions: without this the remainder
  // sits in the wallet forever.
  async sweepZapSurplus(plan, z, receipt, { sqrt = null, hash = null } = {}) {
    const token = String(z.token).toLowerCase();
    // A quote asset (USDG/ETH/WETH) is cash, not leftover.
    if (this.chain.QUOTES[token] || isNative(token)) return null;
    // Once per mint: the entry flow and bookPendingMints can both reach here
    // (a failed booking does not mark the tx `recorded`), and a queue item for the same token
    // is ADDED to — without this marker the surplus would be counted twice.
    if (hash && this.txDetail(hash).zapSwept) return null;
    // What was bought and what was deposited are read from the RECEIPT, not from the balance difference: the RPC
    // pool can switch to a lagging node (still reporting the balance before the mint),
    // and this wallet can be used by other programs that hold the same token —
    // queueing a surplus estimated from the balance could end up selling their share.
    if (z.gainedUnknown) {
      this.store.log('warn', `hasil zap ${token.slice(0, 10)}… tidak terbaca — kelebihannya (kalau ada) tidak diantrekan`, { quiet: true });
      return null;
    }
    const bought = BigInt(z.gained || 0);
    if (bought <= 0n) return null;
    const me = this.exec.address().toLowerCase();
    let used;
    try { used = await this.spentIn(receipt, token, me); }
    catch (e) { this.store.log('warn', `modal zap yang masuk LP tidak terukur: ${e.message}`, { quiet: true }); return null; }
    let surplus = bought > used ? bought - used : 0n;
    if (surplus <= 0n) return null;
    // Never queue more than what is really free (current balance minus the
    // balance before the zap). Balance unreadable: the receipt figure is already proven to be ours.
    try {
      const bal = (await this.exec.balances([token])).get(token) || 0n;
      const free = bal > BigInt(z.before ?? 0) ? bal - BigInt(z.before ?? 0) : 0n;
      if (free < surplus) surplus = free;
    } catch { /* pakai angka receipt */ }
    if (surplus <= 0n) return null;
    const meta = await this.chain.token(token).catch(() => null);
    const label = `${fmtUnits(surplus, meta?.decimals ?? 18)} ${meta?.symbol || token.slice(0, 8)}`;
    const usd = await this.valueOneSide(plan, token, surplus, sqrt);
    if (usd != null && usd < MIN_ZAP_SURPLUS_USD) {
      if (hash) this.markTxDetail(hash, { zapSwept: true });
      this.store.log('info', `kelebihan zap ${label} (~$${usd.toFixed(2)}) dibiarkan di wallet — di bawah $${MIN_ZAP_SURPLUS_USD.toFixed(2)}`, { quiet: true });
      return null;
    }
    // Marked BEFORE being queued: if the process dies between the two, the token is merely
    // left in the wallet (the same state as before this path existed) — better
    // than the same surplus entering the queue twice.
    if (hash) this.markTxDetail(hash, { zapSwept: true });
    // Another sweep/zap item for the same token (posId null) is ADDED to, not overwritten.
    // posId stays null: this token never entered a position, so its sale proceeds are not
    // that position's proceeds (if booked there, the position's profit would look large).
    const old = this.leftovers().find((x) => (x.posId ?? null) === null && x.token === token);
    const amount = surplus + (old ? BigInt(old.amount || '0') : 0n);
    this.keepLeftover({ posId: null, target: plan.target ?? null, token, quote: String(z.quote).toLowerCase(), amount: amount.toString(),
      tries: 0, since: Date.now(), source: 'zap' }, 'kelebihan zap setelah LP dibuka');
    this.store.log('info', `kelebihan zap ${label}${usd != null ? ` (~$${usd.toFixed(2)})` : ''} tidak terpakai saat mint — masuk antrean jual`);
    return { token, amount: surplus.toString(), usd };
  }

  // The value of one side of a pool (only token0 OR token1) in USD at price `sqrt`; without
  // `sqrt` the pool price is read now. null = unknown, not zero.
  async valueOneSide(plan, token, amount, sqrt = null) {
    try {
      let s = sqrt?.sqrtPriceX96 ?? sqrt;
      if (!s) {
        const slot = this.chain.isV3Venue(plan.venue) ? await this.chain.slot0V3(plan.poolRef) : await this.chain.slot0V4(plan.poolRef);
        s = slot?.sqrtPriceX96 ?? null;
      }
      if (!s) return null;
      const is0 = String(token).toLowerCase() === String(plan.token0).toLowerCase();
      const [t0, t1] = await this.chain.tokens([plan.token0, plan.token1]);
      const v = this.chain.valueInQuote({
        sqrtPriceX96: BigInt(s), amount0: is0 ? amount : 0n, amount1: is0 ? 0n : amount,
        dec0: t0?.decimals ?? 18, dec1: t1?.decimals ?? 18, token0: plan.token0, token1: plan.token1,
      });
      const usd = v ? quoteToUsd(v.value, v.kind, this.ethUsd) : null;
      return Number.isFinite(usd) ? usd : null;
    } catch { return null; }
  }

  // Mark the zap tx as handled so the orphan zap recovery (recoverStrandedZaps) does not
  // queue it again.
  markZapsRescued(hashes) {
    for (const h of hashes || []) this.markTxDetail(h, { handled: true });
  }

  // the JSON detail of one tx (empty if the row does not exist / is unreadable).
  txDetail(hash) {
    const row = this.store?.get?.('SELECT detail FROM txs WHERE hash=?', hash);
    if (!row) return {};
    try { return JSON.parse(row.detail || '{}') || {}; } catch { return {}; }
  }
  markTxDetail(hash, patch) {
    const row = this.store?.get?.('SELECT detail FROM txs WHERE hash=?', hash);
    if (!row) return;
    let d = {}; try { d = JSON.parse(row.detail || '{}') || {}; } catch { /* detail lama */ }
    this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, ...patch }), hash);
  }

  // Orphan zap: a token was bought for an entry, but the entry never reached the
  // mint AND was never rescued — the process was restarted/died midway (a pm2 restart
  // on deploy gives 1.6 seconds before SIGKILL), or the zap receipt was only read after the
  // entry gave up. Without this the token sits in the wallet forever. Checked on every sync.
  async recoverStrandedZaps({ minAgeMs = 5 * 60_000 } = {}) {
    if (!this.exec.address() || (this.activeEntries || 0) > 0) return 0;
    const me = this.exec.address().toLowerCase();
    const rows = this.store.all("SELECT hash, ts, status, detail FROM txs WHERE chain=? AND kind='zap_swap' AND status != 'gagal' AND ts > ? AND ts < ? ORDER BY ts",
      this.network, Date.now() - 24 * 3600_000, Date.now() - minAgeMs);
    let n = 0;
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail || '{}'); } catch { continue; }
      if (d.handled || !d.buy || !d.pool) continue;
      const buy = String(d.buy).toLowerCase();
      if (this.chain.QUOTES[buy] || isNative(buy)) { this.markZapsRescued([r.hash]); continue; }
      // Its entry reached a mint/increase in the same pool after this zap (a reverted one is not
      // counted: the zap token is rescued by the entry flow or bookPendingMints — both
      // mark this zap `handled`; if the process died before that, it is taken care of here).
      const minted = this.store.all("SELECT detail FROM txs WHERE chain=? AND kind IN ('mint','increase') AND status != 'gagal' AND ts >= ?", this.network, r.ts)
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
          this.keepLeftover({ posId: null, target: d.target ?? null, token: buy, quote: String(d.pay || this.chain.ADDR.usdg).toLowerCase(), amount: total.toString(), tries: 0,
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

    // 0. Make sure the cash is in THIS pool's quote asset (can differ from our cash).
    //    Skipped when retrying AFTER a zap: the quote cash was deliberately spent on the
    //    pair token, and bridging again means swapping cash that is not needed.
    if (!resume && plan.quoteSide != null && !(avail(plan.token0) >= need0 && avail(plan.token1) >= need1)) {
      const qTok = plan.quoteSide === 0 ? plan.token0 : plan.token1;
      const qMeta = await this.chain.token(qTok);
      const needQuoteRaw = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** (qMeta?.decimals ?? 18)));
      if (needQuoteRaw > 0n) {
        const bridged = await this.ensureQuoteAsset(plan, rules, needQuoteRaw);
        // The bridge happens only ONCE per entry. If this attempt fails afterwards, the retry
        // uses the cash already there — without this, cash that "vanished" into the gas reserve
        // (the dynamic reserve spikes) makes every attempt swap USDG again.
        if (bridged.length) trace.bridged = true;
        notes.push(...bridged);
        bal = await this.exec.balances([plan.token0, plan.token1]);
      }
    }

    const sa = m.getSqrtRatioAtTick(plan.tickLower), sb = m.getSqrtRatioAtTick(plan.tickUpper);
    const toksNow = await this.chain.tokens([plan.token0, plan.token1]);
    let s2, desiredL = BigInt(plan.liquidity);
    const refreshNeeds = async () => {
      s2 = this.chain.isV3Venue(plan.venue)
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

    // Recompute after the bridge AND every zap. At most two swaps per attempt (three
    // across all attempts) so a moving price does not make the bot keep buying/
    // selling back and forth. If that limit is reached but the balance is already enough for
    // at least half the size, the position is opened smaller — selling the zap token back
    // means paying the pool fee twice for a position that never exists.
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
      // estimate how much must be paid, using the pool price + slippage
      const s = s2;
      const price1per0 = Number(s.sqrtPriceX96) ** 2 / Number(m.Q96) ** 2; // raw, without decimals
      const payRaw = idx === 0
        ? BigInt(Math.ceil(Number(short) * price1per0 * (1 + rules.swap.max_slippage_bps / 10000)))
        : BigInt(Math.ceil((Number(short) / price1per0) * (1 + rules.swap.max_slippage_bps / 10000)));
      if (payRaw <= 0n) continue;
      if (payHave < payRaw) {
        // After a zap: the payer token remainder ran out because of the earlier zap's fee/slippage. If
        // what is there is enough for half the size, open at that size (the size is trimmed
        // below) rather than cancel and sell back.
        if (zapsSoFar > 0 && affordableNow * 2n >= desiredL) { notes.push('saldo pas-pasan setelah zap — dibuka sebesar saldo'); break; }
        throw new Error(`saldo kurang untuk zap: butuh ~${payRaw} unit ${payTok.slice(0, 8)}…, punya ${payHave}`);
      }
      // Main path: Kyber (the best route across pools; many pools refuse direct swaps).
      const buyTok = idx === 0 ? plan.token0 : plan.token1;
      // The zap loss limit also accounts for the pool's OWN FEE. Memecoin pools on this chain
      // have fees of 4–10%, so buying the token cannot possibly be cheaper than that
      // fee; a rigid 5% limit makes a pool with a 4.2% fee always rejected although it is reasonable.
      // For a dynamic-fee pool (flag 0x800000) the magnitude is not known up front,
      // so the limit set by the user is still used.
      const feeBps = plan.fee != null && plan.fee < 1_000_000 ? plan.fee / 100 : null;
      const zapLossBps = feeBps != null
        ? Math.max(rules.swap.max_price_impact_bps, Math.round(feeBps) + 200)
        : rules.swap.max_price_impact_bps;
      // The balance of the token bought BEFORE the zap: if the LP fails after this, only what was
      // bought here is queued for sale (rescueZap), not the old balance.
      const boughtBefore = bal.get(buyTok.toLowerCase()) || 0n;
      // Zap journal in the txs table: if the process dies before the mint, recoverStrandedZaps
      // knows which token was bought, what it was paid with, and for which pool.
      const zapDetail = { pool: plan.poolRef, buy: buyTok.toLowerCase(), pay: payTok.toLowerCase(), target: plan.target ?? null };
      // `got` = the tokens that really arrived from this zap (from the receipt/Kyber quote).
      // Used by sweepZapSurplus to know how much was BOUGHT but not deposited into the
      // LP. Stored as a string: trace.zapped is also written to the tx detail, and JSON
      // cannot write a BigInt. Unreadable -> flagged, not guessed.
      const noteZap = (hash, got = null) => {
        trace.zaps = (trace.zaps || 0) + 1;
        const z = trace.zapped || { token: buyTok.toLowerCase(), quote: payTok, before: boughtBefore, gained: '0', hashes: [] };
        if (hash) z.hashes = [...(z.hashes || []), hash];
        if (got != null) z.gained = (BigInt(z.gained || 0) + BigInt(got)).toString();
        else z.gainedUnknown = true;
        trace.zapped = z;
      };
      let kz, kyberErr = null;
      try {
        kz = await this.kyber.swap(payTok, buyTok, payRaw, {
          slippageBps: rules.swap.max_slippage_bps, maxLossBps: zapLossBps,
          kind: 'zap_swap', detail: { via: 'kyber', ...zapDetail },
        });
      } catch (e) {
        // The zap receipt is not yet readable: the token may still arrive — do not zap again in the
        // next attempt without knowing; orphan zap recovery takes care of it.
        if (e.pending) { e.message = `${e.message} — entry dihentikan, zap diurus belakangan`; throw e; }
        // The Kyber route loses too much (e.loss), or its tx was rejected by the chain through the
        // third attempt because of a stale price (e.reverted): both are MARKET matters, not a safeguard
        // failing — and a revert does not move any tokens. The direct pool below
        // may still be tried, with the same loss limit. A safeguard error (router
        // mismatch, odd calldata) still stops the entry here.
        if (!(e.loss || e.reverted)) throw e;
        kyberErr = e;
        this.log(`zap via Kyber tidak jadi (${e.message}) — coba pool langsung`);
      }
      if (kz) {
        notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'} via ${aggLabel(kz?.quote)}`);
        noteZap(kz.hash, kz.amountOut ?? null);
        bal = await this.balancesAfterSwap([plan.token0, plan.token1], buyTok, boughtBefore, kz.amountOut);
        continue;
      }
      for (const a of await this.exec.ensureRouterAllowance(payTok)) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
      // Fallback: a direct swap into a pool. This position's pool is not necessarily the best place
      // to swap — the picker evaluates all pools of the same pair (fee + price impact)
      // then simulates them, so thin pools and pools that refuse swaps are eliminated
      // before gas is spent. The price impact limit that applies is still the one in Rules:
      // that is what keeps "auto-swap" from turning into hitting a thin pool.
      const minOut = (short * (10000n - BigInt(rules.swap.max_slippage_bps))) / 10000n;
      const info = {};
      const pick = await pickSwapPool({ store: this.store, chain: this.chain, rpc: this.rpc, exec: this.exec, log: this.log }, {
        tokenIn: payTok, tokenOut: buyTok, amountIn: payRaw, minOut,
        maxImpactBps: rules.swap.max_price_impact_bps, deadlineSec: this.exec.deadline(), info,
        extra: [{
          pool_ref: plan.poolRef, venue: plan.venue, token0: plan.token0, token1: plan.token1,
          fee: plan.fee, tick_spacing: plan.tickSpacing ?? pk?.tickSpacing ?? null,
          hooks: plan.poolKey?.hooks ?? pk?.hooks ?? null, pool_addr: this.chain.isV3Venue(plan.venue) ? plan.poolRef : null,
        }],
      });
      if (!pick) throw kyberErr || new Error(`zap lewat pool langsung tidak bisa: ${info.reason}`);
      // We got here via a Kyber route rejected by the loss limit: the direct pool must
      // be measured by the SAME limit — pool fee + price impact, not price impact alone
      // (the pool picker only filters impact). Without this the fallback becomes a
      // back door that passes the loss gate by silently paying a 10% pool fee.
      if (kyberErr?.loss) {
        const lossBps = (pick.impactBps ?? 0) + (pick.feePpm ?? 0) / 100;
        if (lossBps > zapLossBps) {
          this.log(`pool langsung juga rugi ${(lossBps / 100).toFixed(1)}% (batas ${(zapLossBps / 100).toFixed(1)}%) — zap dibatalkan`);
          throw kyberErr;
        }
        this.log(`zap lewat pool langsung: rugi ${(lossBps / 100).toFixed(1)}% vs ${(kyberErr.loss.lossBps / 100).toFixed(1)}% di Kyber`);
      }
      if (pick.pool.pool_ref !== plan.poolRef) {
        this.log(`zap lewat pool lain ${pick.pool.pool_ref.slice(0, 10)}… (fee ${(pick.feePpm / 10000).toFixed(2)}%`
          + `${pick.impactBps != null ? `, dampak ~${Math.round(pick.impactBps)} bps` : ''}) — terbaik dari ${info.scored} pool berpasangan sama`);
      }
      const h = await this.exec.send(pick.tx, { kind: 'zap_swap', detail: { ...zapDetail, via: pick.pool.pool_ref, payRaw: payRaw.toString() } });
      const rc = await this.exec.waitReceipt(h, 90_000);
      if (rc.timeout) throw new Error(`swap zap ${h} belum terkonfirmasi setelah 90 detik — entry dihentikan, zap diurus belakangan`);
      if (!rc.ok) throw new Error(`swap zap gagal (${h})`);
      notes.push(`zap ${idx === 0 ? 'beli token0' : 'beli token1'}`);
      const gotDirect = await this.receivedIn(rc.receipt, buyTok, this.exec.address().toLowerCase()).catch(() => null);
      noteZap(h, gotDirect);
      bal = await this.balancesAfterSwap([plan.token0, plan.token1], buyTok, boughtBefore, gotDirect);
    }

    // 2. adjust L to the real balance after the swap (safer against slippage)
    const affordable = m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1));
    let L = desiredL;
    if (affordable < L) { L = (affordable * 99n) / 100n; notes.push('ukuran dipangkas ke saldo nyata'); }
    if (L <= 0n) throw new Error('saldo token pool tidak mencukupi pada harga terbaru — LP belum dibuka, dana tetap di wallet');
    let amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);

    // The per-position limit is RE-locked at the current price. The price moves between when the
    // plan is built and the mint — including because of our own zap — so the same
    // liquidity can be worth more than the requested limit (seen as
    // $204.96 for a $200 limit in a dry-run). The nominal limit must be honoured.
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

    // 3. allowance + mint
    for (const tok of [plan.token0, plan.token1]) {
      if (BigInt(tok === plan.token0 ? finalPlan.amount0Max : finalPlan.amount1Max) === 0n) continue;
      for (const a of await this.exec.ensureAllowance(tok, { forV4: !this.chain.isV3Venue(plan.venue), venue: plan.venue })) {
        const h = await this.exec.send(a, { kind: a.kind });
        await this.exec.waitReceipt(h);
      }
    }
    // Approval can take several blocks. Do not send a mint with the old token requirement
    // after the price changed while waiting for the approval receipt.
    await refreshNeeds();
    bal = await this.exec.balances([plan.token0, plan.token1]);
    // The price moved while waiting for approval (including because of our own zap).
    // This used to CANCEL the mint — although the zap token was already in the wallet and left
    // naked (lpcopy2: $26 of PAIREX left, had to be sold manually). The size
    // is re-adjusted to the real balance and the value limit at the price at mint (unlimited
    // approval, so it is safe); cancel only if nothing is actually left.
    const fitL = (m.liquidityForAmounts(s2.sqrtPriceX96, sa, sb, avail(plan.token0), avail(plan.token1)) * 99n) / 100n;
    if (fitL < L || desiredL < L) {
      L = fitL < desiredL ? fitL : desiredL;
      notes.push('ukuran disesuaikan ke harga saat mint');
    }
    if (L <= 0n) throw new Error('saldo token pool tidak mencukupi pada harga saat mint — LP belum dibuka, token hasil zap tetap di wallet');
    amt = m.amountsForLiquidity(s2.sqrtPriceX96, sa, sb, L);
    finalPlan.liquidity = L.toString();
    // The token upper bound MUST NOT exceed the real balance. On Uniswap v3 amountDesired
    // is not a bound but the amount DEPOSITED: the NPM computes liquidity from that figure
    // then pulls that much. With a size of 99% of the balance and 1.5% slippage room, the v3 mint
    // pulls 100.5% of the balance → revert "STF" (four v3 entries 11–12 Sep, all after a zap).
    // On v4 it is only a bound, so clamping it to the balance changes nothing except
    // rejecting earlier if there really is not enough.
    const capBal = (x, t) => { const a = avail(t); return x > a ? a : x; };
    finalPlan.amount0Max = capBal((amt.amount0 * (10000n + slip)) / 10000n, plan.token0).toString();
    finalPlan.amount1Max = capBal((amt.amount1 * (10000n + slip)) / 10000n, plan.token1).toString();
    const adding = plan.action === 'increase' && plan.tokenId;
    const tx = adding
      ? (this.chain.isV3Venue(plan.venue)
        ? this.exec.buildV3Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline())
        : this.exec.buildV4Increase({ ...finalPlan, tokenId: plan.tokenId }, this.exec.deadline()))
      : (this.chain.isV3Venue(plan.venue)
        ? this.exec.buildV3Mint({ ...finalPlan, amount0Min: 0, amount1Min: 0 }, this.exec.deadline())
        : this.exec.buildV4Mint(finalPlan, this.exec.deadline()));
    // The plan is also stored in the txs table: if its receipt fails to be read (RPC down,
    // past the wait limit), bookPendingMints books the position later from the receipt —
    // complete with its link to the target, not just "adopted" with no origin.
    const hash = await this.exec.send(tx, { kind: adding ? 'increase' : 'mint', detail: {
      pool: plan.poolRef, target: plan.target, venue: plan.venue,
      plan: Engine.planForBooking(finalPlan), zapped: trace.zapped ? { ...trace.zapped, before: String(trace.zapped.before) } : null,
    } });
    trace.mintSent = hash;
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) {
      const e = new Error(`mint ${hash} belum terkonfirmasi setelah 90 detik — posisinya dibukukan otomatis begitu receipt terbaca`);
      e.pendingMint = true;   // do not sell the zap token: its mint may be landing
      throw e;
    }
    if (!rc.ok) throw new Error(`mint gagal (${hash})`);
    // The mint HAS been created on chain: any error after this (bookkeeping) must not trigger a
    // second mint or a sale of the zap token — bookPendingMints books it later.
    trace.minted = hash;
    // A zap token that was bought but not deposited (the pool price moved between the zap and
    // the mint) must not be left naked: it goes into the sell queue, the same as a position's
    // leftovers. A failure here must not bring down the booking of the mint that is already done.
    if (trace.zapped) {
      await this.sweepZapSurplus(finalPlan, trace.zapped, rc.receipt, { sqrt: s2, hash })
        .catch((e) => this.store?.log?.('warn', `kelebihan zap tidak terantre: ${e.message}`, { quiet: true }));
    }
    try { return await this.recordEntry(finalPlan, hash, rc.receipt, { amt, sqrt: s2, notes }); }
    catch (e) { e.pendingMint = true; e.message = `mint ${hash} berhasil tetapi pembukuan tertunda: ${e.message}`; throw e; }
  }

  // The balance after a swap that is ALREADY confirmed. The RPC pool can switch to a node
  // lagging a few blocks: the balance read is still before the swap, the bot thinks the token
  // has not arrived and zaps again — the surplus token sits in the wallet. The receipt has already proven
  // `gained` tokens arrived, so a read below before+gained is rejected: retried
  // a few times, finally using the figure proven by the receipt.
  async balancesAfterSwap(tokens, token, before, gained, { tries = 5, waitMs = 700 } = {}) {
    const key = String(token).toLowerCase();
    const expect = gained != null && gained > 0n ? BigInt(before ?? 0n) + BigInt(gained) : null;
    let bal = null;
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, waitMs));
      try { bal = await this.exec.balances(tokens); } catch (e) { if (i === tries - 1) throw e; continue; }
      if (expect == null || (bal.get(key) || 0n) >= expect) return bal;
    }
    if (!bal) throw new Error('gagal membaca saldo sesudah swap');
    this.store?.log?.('warn', `saldo ${key.slice(0, 10)}… dari RPC (${bal.get(key) || 0n}) masih di bawah hasil swap yang terbukti di receipt (${expect}) — node tertinggal; memakai angka receipt`, { quiet: true });
    bal.set(key, expect);
    return bal;
  }

  // The part of the plan sufficient to book the position later (plain JSON, no BigInt).
  static planForBooking(p) {
    const keep = ['venue', 'action', 'poolRef', 'poolKey', 'token0', 'token1', 'fee', 'tickSpacing', 'hooks', 'tickLower', 'tickUpper',
      'liquidity', 'amount0Max', 'amount1Max', 'valueQuote', 'valueUsd', 'quoteSymbol', 'quoteKind', 'quoteSide', 'target', 'mirrorOf', 'tokenId', 'positionId', 'singleSide'];
    const out = {};
    for (const k of keep) if (p[k] !== undefined) out[k] = p[k];
    return JSON.parse(JSON.stringify(out, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  // Booking after a mint/increase is confirmed. `amt`/`sqrt` from the entry flow if
  // present; if booked later (bookPendingMints) the capital is read from the receipt —
  // the tokens that really left the wallet — and its entry price from the current pool.
  async recordEntry(plan, hash, receipt, { amt = null, sqrt = null, notes = [] } = {}) {
    const adding = plan.action === 'increase' && plan.tokenId;
    let L = BigInt(plan.liquidity);
    const me = this.exec.address().toLowerCase();
    // On v3 amountDesired (= amount*Max, already including slippage room) is the amount
    // DEPOSITED: the NPM computes liquidity from that figure and pulls that much, so the
    // real position is ~1% larger than the plan's `amt`/`L` (lp2 #2 and #3: capital
    // recorded 1.2% below the tokens that really left the wallet). The
    // IncreaseLiquidity event in the receipt carries the real figure — that is what gets booked.
    if (this.chain.isV3Venue(plan.venue)) {
      for (const l of receipt.logs || []) {
        if (l.address.toLowerCase() !== this.chain.npmFor(plan.venue) || l.topics[0] !== TOPIC.increaseLiq) continue;
        const b = ethers.getBytes(l.data);
        const w = (i) => BigInt(ethers.hexlify(b.slice(i * 32, i * 32 + 32)));
        if (w(0) > 0n) { L = w(0); amt = { amount0: w(1), amount1: w(2) }; plan = { ...plan, liquidity: L.toString() }; }
      }
    }
    if (!amt) {
      const spent = async (tok, max) => {
        try { return await this.spentIn(receipt, tok, me); }
        catch { return BigInt(max || '0'); }   // native ETH is not isolated: estimate the plan bound
      };
      amt = { amount0: await spent(plan.token0, plan.amount0Max), amount1: await spent(plan.token1, plan.amount1Max) };
    }
    if (!sqrt) sqrt = this.chain.isV3Venue(plan.venue) ? await this.chain.slot0V3(plan.poolRef) : await this.chain.slot0V4(plan.poolRef);
    const s2 = sqrt;

    // 4. tokenId from the Transfer log (0x0 -> us)
    let tokenId = null;
    for (const l of receipt.logs || []) {
      const mgr = this.chain.isV3Venue(plan.venue) ? this.chain.npmFor(plan.venue) : this.chain.ADDR.posmV4;
      if (l.address.toLowerCase() === mgr && l.topics[0] === TOPIC.transfer
        && asAddr(l.topics[1]) === '0x0000000000000000000000000000000000000000'
        && asAddr(l.topics[2]) === me) tokenId = BigInt(l.topics[3]).toString();
    }
    const toks = await this.chain.tokens([plan.token0, plan.token1]);
    const v = s2 && this.chain.valueInQuote({
      sqrtPriceX96: s2.sqrtPriceX96, amount0: amt.amount0, amount1: amt.amount1,
      dec0: toks[0].decimals, dec1: toks[1].decimals, token0: plan.token0, token1: plan.token1,
    });
    // Idempotent: a position with this tokenId is already recorded (adopted first, or
    // an earlier booking was cut off after writing the row) — do not create a second row.
    const dup = !adding && tokenId && this.store?.get?.('SELECT id FROM positions WHERE chain=? AND venue=? AND token_id=?', this.network, plan.venue, tokenId);
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
      // Capital is ADDED, not overwritten: otherwise added capital reads
      // as free profit and the IL baseline also gets reset.
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
    // The "already booked" marker in the txs table — bookPendingMints does not repeat it.
    const trow = this.store?.get?.('SELECT detail FROM txs WHERE hash=?', hash);
    if (trow) { let d = {}; try { d = JSON.parse(trow.detail || '{}'); } catch { /* detail lama */ } d.recorded = positionId; this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify(d), hash); }
    const pair = `${toks[0].symbol}/${toks[1].symbol}`;
    // v.value is expressed in the pool's quote asset (can be ETH), NOT dollars — it used to be printed
    // straight with "$" so a 0.079 ETH position read "$0.08" instead of ~$195.
    const usdVal = quoteToUsd(v?.value ?? 0, v?.kind || 'usd', this.ethUsd);
    return {
      txHash: hash, positionId, adding: !!adding, pair, valueUsd: usdVal, curTick: s2?.tick ?? null, steps: notes,
      note: `${adding ? 'tambah ' : ''}${pair} $${usdVal.toFixed(2)}${notes.length ? ' (' + notes.join(', ') + ')' : ''}`,
    };
  }

  pendingFeeClaim(id) {
    return this.store.get(`SELECT t.* FROM txs t LEFT JOIN fee_claims f ON f.tx_hash=t.hash
      WHERE t.chain='${this.network}' AND t.kind='claim_fees' AND t.status!='gagal' AND f.tx_hash IS NULL
      AND json_extract(t.detail,'$.position')=? ORDER BY t.ts LIMIT 1`, id);
  }

  // `sell`: sell the fee's memecoin side to the pool's quote asset after the claim. null = follow the
  // position's setting (automatic harvest in 'claim' mode); a manual claim sells nothing
  // unless asked, so the "Claim fee" button still means exactly what it used to.
  async claimFees(id, opts = {}) {
    if (this.dryRun() || !this.exec.address()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (this.exiting.has(id)) throw new Error('posisi ini sedang diproses');
    if (this.compound?.pending(id)) throw new Error('compound sebelumnya belum selesai — tunggu konfirmasi');
    const pos = this.store.get("SELECT * FROM positions WHERE id=? AND status='open'", id);
    if (!pos || pos.token_id == null) throw new Error('posisi tidak ditemukan');
    if (!(pos.venue === 'v4' || this.chain.isV3Venue(pos.venue))) throw new Error('venue posisi tidak didukung');
    this.exiting.add(id);
    try {
      // After a timeout/restart, settle the old transaction first. Do not resend.
      const pending = this.pendingFeeClaim(id);
      let hash = pending?.hash;
      if (!hash) {
        const v3 = this.chain.isV3Venue(pos.venue);
        const iface = new ethers.Interface(v3 ? ABI.npmV3 : ABI.posmV4);
        const [ownerData] = await this.rpc.ethCallMany([{ to: v3 ? this.chain.npmFor(pos.venue) : this.chain.ADDR.posmV4,
          data: iface.encodeFunctionData('ownerOf', [pos.token_id]) }]);
        const owner = iface.decodeFunctionResult('ownerOf', ownerData)[0].toLowerCase();
        if (owner !== this.exec.address().toLowerCase()) throw new Error('NFT posisi bukan milik wallet bot');
        await this.topUpGas([]);
        const poolKey = pos.venue === 'v4' ? await this.poolKeyOf(pos) : null;
        if (pos.venue === 'v4' && !poolKey) throw new Error('poolKey posisi tidak terbaca');
        const plan = { tokenId: pos.token_id, poolKey };
        const tx = pos.venue === 'v4' ? this.exec.buildV4Collect(plan, this.exec.deadline()) : this.exec.buildV3Collect({ ...plan, venue: pos.venue });
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
      let sold = null;
      let sellError = null;
      if (this.sellFeeWanted(id, opts.sell)) {
        // Failing to sell is not failing to claim: the fees are already in the wallet and the item has already
        // gone into the sell queue (retryLeftovers), so the claim is still reported as a success —
        // with sellError so the caller can say "queued", not stay silent.
        try { sold = await this.sellClaimedFee(pos, hash, result, { quiet: !!opts.quiet }); }
        catch (e) { sellError = e.message; this.store.log('warn', `jual fee posisi #${id}: ${e.message}`, { quiet: true }); }
      }
      return { ok: true, tx: hash, ...result, sold, sellError };
    } finally { this.exiting.delete(id); }
  }

  // How much `token` came NET into `owner` in this transaction, read from its
  // receipt — not from the "before/after" balance difference, which can be zero if the RPC
  // read is still one block behind, or contaminated by other txs in between.
  async receivedIn(receipt, token, owner) {
    const v = await this.netFlow(receipt, token, owner);
    return v > 0n ? v : 0n;
  }

  // How much `token` went NET out of `owner` in this transaction (mint capital).
  async spentIn(receipt, token, owner) {
    const v = await this.netFlow(receipt, token, owner);
    return v < 0n ? -v : 0n;
  }

  // Net flow of `token` to `owner` in this transaction: positive = in, negative = out.
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
    // Native ETH has no Transfer. Read the historical balance at the receipt's block
    // so a retry after a timeout does not count wallet activity in another block.
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
    const txRow = this.store.get('SELECT kind, detail FROM txs WHERE hash=?', hash);
    const detail = JSON.parse(txRow?.detail || '{}');
    const owner = String(detail.wallet || this.exec.address()).toLowerCase();
    const amount = (token) => this.receivedIn(receipt, token, owner);
    const amount0 = await amount(pos.token0), amount1 = await amount(pos.token1);
    // marking price, not the raw pool price: a pool swept empty puts the price at the bound
    const slot = await this.positions.markSlotFor(pos);
    const [t0, t1] = await this.chain.tokens([pos.token0, pos.token1]);
    const value = slot && this.chain.valueInQuote({ sqrtPriceX96: slot.sqrtPriceX96, amount0, amount1,
      dec0: t0.decimals, dec1: t1.decimals, token0: pos.token0, token1: pos.token1 });
    if (!value) throw new Error('nilai fee belum terbaca');
    // The memecoin side is valued ON ITS OWN at the same price: that is the part of claimed_quote
    // that has not really become money yet, and this figure is what the sale result will later replace.
    const meme = this.memeSideOf(pos, amount0, amount1, slot, [t0, t1]);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.store.run('INSERT OR IGNORE INTO fee_claims(tx_hash,position_id,ts,amount0,amount1,value_quote) VALUES(?,?,?,?,?,?)',
        hash, pos.id, Date.now(), String(amount0), String(amount1), value.value);
      if (Number(r.changes)) {
        this.store.run(`UPDATE positions SET claimed_quote=COALESCE(claimed_quote,0)+?,
          out_quote=out_quote+CASE WHEN status='closed' THEN ? ELSE 0 END, fees_quote=0 WHERE id=?`, value.value, value.value, pos.id);
        // The memecoin of a plain claim now sits in the wallet at the claim-price estimate. Booking it in the
        // fee ledger here (not only when the bot sells it) lets ANY later sale — the automatic one or a manual
        // swap — replace the estimate with the real proceeds. A compound reinvests it, so it never waits there.
        if (meme && txRow?.kind === 'claim_fees') this.positions.noteFeeLeftover({ posId: pos.id, token: meme.token,
          amount: meme.amount, estQuote: meme.quoteValue, txHash: hash });
      }
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    return { amount0: String(amount0), amount1: String(amount1), meme,
      claimedUsd: quoteToUsd(value.value, value.kind, this.ethUsd) };
  }

  // The non-quote side of a fee claim: { token, quote, amount, quoteValue } or null
  // for a pair that is money on both sides (ETH/USDG) or whose memecoin is zero.
  memeSideOf(pos, amount0, amount1, slot, toks) {
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    if (!q) return null;
    const side = q.side === 0 ? 1 : 0;
    const token = String(side === 0 ? pos.token0 : pos.token1).toLowerCase();
    const quote = String(q.side === 0 ? pos.token0 : pos.token1).toLowerCase();
    if (this.chain.quoteSideOf(token, token)) return null;
    const amount = side === 0 ? amount0 : amount1;
    if (!(amount > 0n)) return null;   // returned as a string: the claim result is sent as JSON
    const v = slot && this.chain.valueInQuote({ sqrtPriceX96: slot.sqrtPriceX96,
      amount0: side === 0 ? amount : 0n, amount1: side === 1 ? amount : 0n,
      dec0: toks[0].decimals, dec1: toks[1].decimals, token0: pos.token0, token1: pos.token1 });
    return { token, quote, amount: amount.toString(), quoteValue: v?.value ?? 0 };
  }

  // Is the fee's memecoin side sold after the claim? An explicit override wins;
  // otherwise the automatic harvest 'claim' mode decides.
  sellFeeWanted(id, override = null) {
    if (override != null) return !!override;
    const st = this.store.get('SELECT enabled, mode, sell_fee FROM compound_settings WHERE position_id=?', id);
    return !!(st?.enabled && st.mode === 'claim' && st.sell_fee);
  }

  // Memecoin from a freshly claimed fee: recorded in the fee ledger (so the claim-price
  // estimate is later replaced by the actual sale result) then sold to the same pool's
  // quote asset. Its amount is from the claim receipt, not the wallet balance — this wallet can hold
  // the same token from positions or other programs.
  async sellClaimedFee(pos, hash, claim, { quiet = false } = {}) {
    const meme = claim?.meme;
    if (!meme || !(BigInt(meme.amount) > 0n)) return null;
    // The fee ledger row was already written by recordFeeClaim.
    return this.sellToken({ posId: pos.id, target: pos.target, token: meme.token, quote: meme.quote,
      amount: BigInt(meme.amount), tries: 0, kind: 'fee' }, { quiet });
  }

  async reconcileFeeClaims() {
    const rows = this.store.all(`SELECT t.* FROM txs t LEFT JOIN fee_claims f ON f.tx_hash=t.hash
      WHERE t.chain=? AND t.kind IN ('claim_fees','compound') AND t.status!='gagal' AND f.tx_hash IS NULL ORDER BY t.ts LIMIT 20`, this.network);
    for (const row of rows) {
      const id = JSON.parse(row.detail || '{}').position;
      if (this.exiting.has(id)) continue;
      const pos = this.store.get('SELECT * FROM positions WHERE id=?', id);
      if (!pos) continue;
      this.exiting.add(id);
      try {
        const rc = await this.rpc.call('eth_getTransactionReceipt', [row.hash]);
        if (!rc) {
          // Never landed: do not leave it "pending" forever — executeExit refuses to
          // close a position while its claim is unfinished (see Compound.reconcile).
          if (Date.now() - row.ts > 30 * 60_000) {
            const known = await this.rpc.call('eth_getTransactionByHash', [row.hash]).catch(() => 'tak terbaca');
            if (!known) this.store.run("UPDATE txs SET status='gagal' WHERE hash=?", row.hash);
          }
          continue;
        }
        const ok = BigInt(rc.status) === 1n;
        this.store.run('UPDATE txs SET status=? WHERE hash=?', ok ? 'sukses' : 'gagal', row.hash);
        if (!ok) continue;
        const result = await this.recordFeeClaim(pos, row.hash, rc);
        // A claim that completed AFTER the process died: its memecoin side never
        // entered the sell queue and is not swept (the wallet sweep skips tokens of positions
        // still open). Queued here, once — recordFeeClaim returns {}
        // for a claim that has already been booked.
        if (row.kind === 'claim_fees' && this.sellFeeWanted(id)) {
          try { await this.sellClaimedFee(pos, row.hash, result, { quiet: true }); }
          catch (e) { this.store.log('warn', `jual fee posisi #${id}: ${e.message}`, { quiet: true }); }
        }
      } catch (e) {
        this.store.log('warn', `pencatatan claim fee ${row.hash}: ${e.message}`, { quiet: true });
      } finally { this.exiting.delete(id); }
    }
  }

  // A position may only have one exit transaction running. A manual close
  // (dashboard/Telegram) waits for the receipt up to 90 seconds; without this guard
  // a standalone exit trigger, reconciliation, or a second click in that interval sends a
  // second tx that is certain to revert after the first tx burns its NFT — gas wasted.
  // `force` (force close from the dashboard): the compound/claim guards that are still waiting
  // are skipped, and the liquidity to burn is re-read from the chain — not from records
  // that can be stale — so the position really is empty. The double-tx guard (`exiting`)
  // and the closed status still apply: they prevent a second burn that is certain to revert.
  async executeExit(plan, pos, { force = false } = {}) {
    if (this.stopping) throw new Error('bot sedang berhenti (restart) — keluar dilanjutkan saat hidup lagi');
    if (this.exiting.has(pos.id)) throw new Error('posisi ini sedang dalam proses ditutup');
    if (!force) {
      const comp = this.compound?.pending(pos.id);
      if (comp && comp.status !== 'sukses') throw new Error('compound sebelumnya belum selesai — tunggu konfirmasi');
      const claim = this.pendingFeeClaim(pos.id);
      if (claim && claim.status !== 'sukses') throw new Error('claim fee sebelumnya belum selesai — tunggu konfirmasi dan sinkronisasi');
    }
    const cur = this.store.get('SELECT status FROM positions WHERE id=?', pos.id);
    if (cur && cur.status !== 'open') throw new Error('posisi sudah tertutup');
    if (force && plan.full) {
      const L = await this.chainLiquidity(pos);
      if (L === 0n) throw new Error('likuiditas posisi sudah nol di chain — dibukukan oleh sinkron berikutnya');
      if (L != null && L !== BigInt(plan.liquidity)) {
        this.store.log('warn', `tutup paksa #${pos.id}: likuiditas di chain ${L} ≠ catatan ${plan.liquidity} — dibakar sesuai chain`, { quiet: true });
        plan = { ...plan, liquidity: L.toString() };
      }
    }
    this.exiting.add(pos.id);
    try { return await this.sendExit(plan, pos); }
    finally { this.exiting.delete(pos.id); }
  }

  // A target exit signal is only decided ONCE (see handle), so a momentary RPC disturbance
  // used to mean our position was left open forever. Retried here —
  // but ONLY if its exit transaction was never sent (`notSent`). An error
  // after sending (revert, late receipt) is not retried: the position may already have
  // changed, and reconciliation takes care of it.
  async executeExitRetry(plan, pos, { waits = this.exitRetryWaits || [3000, 10_000, 30_000] } = {}) {
    for (let i = 0; ; i++) {
      // Taken over manually during the retry pause: this automatic exit is cancelled.
      if (i > 0 && this.store.get('SELECT takeover_ts FROM positions WHERE id=?', pos.id)?.takeover_ts != null) {
        throw new Error(`posisi #${pos.id} diambil alih manual — keluar otomatis dibatalkan`);
      }
      try { return await this.executeExit(plan, pos); }
      catch (e) {
        if (!e.notSent || i >= waits.length) throw e;
        this.store.log('warn', `keluar #${pos.id} belum terkirim (${String(e.message).slice(0, 160)}) — coba lagi dalam ${waits[i] / 1000} dtk (${i + 2}/${waits.length + 1})`, { quiet: true });
        await new Promise((r) => setTimeout(r, waits[i]));
        // The last guard before resending: a tx that was thought not to have landed
        // may only be visible now, and our liquidity on chain must not be
        // smaller than the record (larger is fine: compound adds to it).
        // If either is off, sending again could withdraw twice.
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

  // A position whose liquidity is already ZERO on chain without a recorded close. Three causes:
  // a bot exit tx whose receipt failed to be read (RPC down), a manual withdrawal
  // outside the bot (#45: $110 withdrawn via Uniswap, it used to be recorded as a $0 result = total loss),
  // or a bot tx that only landed after the wait limit. The proceeds are looked up first — from the
  // bot tx receipt in the txs table, if none from the last ModifyLiquidity log —
  // then recorded via recordExit like an ordinary exit. Closed at $0 only if
  // everything fails, and the owner is notified so they can fix it manually.
  async closeEmptyPosition(pos) {
    // `pos` comes from a sync that can be tens of seconds old. A bot exit flow that
    // runs at the same time (target closes → burn) may already have booked it between
    // the sync and this position's turn in the trigger loop — `exiting` is empty again,
    // but the position object still has status open. Re-read first. lp3 #220: the bot's
    // burn was booked +150 USDG, 5 seconds later booked again from the ModifyLiquidity log
    // with the same tx — a $300 result from $150 capital, "profit" $150.
    if (this.store.get('SELECT status FROM positions WHERE id=?', pos.id)?.status !== 'open') return null;
    const plan = { full: true, liquidity: pos.liquidity };
    let hash = null;
    for (const r of this.store.all("SELECT hash, detail FROM txs WHERE chain=? AND kind IN ('burn','decrease') AND ts >= ? ORDER BY ts DESC", this.network, pos.opened_ts || 0)) {
      try {
        const d = JSON.parse(r.detail || '{}');
        if (d.position !== pos.id) continue;
        // The full close is already booked — it must not be looked up again via logs (the same
        // tx would be found and booked twice).
        if (d.closeProceeds) {
          this.store.log('warn', `#${pos.id} kosong di chain dan tx tutupnya ${r.hash.slice(0, 12)}… sudah dibukukan — tidak dibukukan ulang`, { quiet: true });
          return null;
        }
        // A partial withdrawal that is already booked — not the tx that emptied it.
        if (d.decreaseProceeds) break;
        hash = r.hash; break;
      } catch { /* old detail without JSON */ }
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

  // Bot mint/increase txs that were sent but whose position is not yet booked (the receipt
  // failed to be read / past the wait limit). Success → booked from the receipt complete with
  // the target link; revert → flagged failed and its zap token queued for sale;
  // never landed (30 minutes without a receipt) → the same as a revert.
  async bookPendingMints() {
    if (!this.exec.address()) return;
    const rows = this.store.all("SELECT hash, ts, kind, detail FROM txs WHERE chain=? AND kind IN ('mint','increase') AND status != 'gagal' AND ts > ? ORDER BY ts", this.network, Date.now() - 24 * 3600_000);
    for (const r of rows) {
      let d; try { d = JSON.parse(r.detail || '{}'); } catch { continue; }
      if (!d.plan || d.recorded) continue;
      if (Date.now() - r.ts < 120_000) continue;   // its own entry flow is still waiting (90 s)
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
      // The mint was created: the surplus zap token that did not go into the position is queued
      // for sale here too — this path takes care of it if the receipt is only read
      // later (the entry flow itself has given up waiting).
      if (d.zapped) {
        await this.sweepZapSurplus(d.plan, d.zapped, receipt, { hash: r.hash })
          .catch((e) => this.store.log('warn', `kelebihan zap ${r.hash.slice(0, 12)}… tidak terantre: ${e.message}`, { quiet: true }));
      }
      const res = await this.recordEntry(d.plan, r.hash, receipt);
      const msg = `posisi #${res.positionId} dibukukan belakangan dari receipt ${r.hash.slice(0, 12)}… — ${res.note}`;
      this.notify(msg, { kind: 'entry', positionId: res.positionId, txHash: r.hash, target: d.target, mirrorOf: d.plan.mirrorOf, valueUsd: res.valueUsd, pair: res.pair });
    }
  }

  // Bot exit txs (burn/decrease) that were sent but whose result is not yet booked —
  // the receipt failed to be read then (RPC down / past the wait limit). Retried on
  // every sync until the receipt is read: success → booked (a full close if the
  // liquidity is now zero, otherwise as a partial withdrawal); revert → flagged.
  async bookPendingExits() {
    if (!this.exec.address()) return;
    const rows = this.store.all("SELECT hash, kind, detail FROM txs WHERE chain=? AND kind IN ('burn','decrease') AND status != 'gagal' AND ts > ? ORDER BY ts", this.network, Date.now() - 24 * 3600_000);
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

  // The last tx that WITHDREW liquidity from this v4 position (ModifyLiquidity with salt ==
  // tokenId and a negative delta), searched backward from the latest block in a limited window.
  // Called rarely (an empty position not recorded), so the getLogs cost is reasonable.
  async lastWithdrawTx(pos, { span = this.cfg.loop?.empty_scan_blocks ?? 3000, step = 500 } = {}) {
    const head = parseInt(await this.rpc.call('eth_blockNumber', []), 16);
    const salt = BigInt(pos.token_id).toString(16).padStart(64, '0');
    for (let to = head; to > head - span; to -= step) {
      const from = Math.max(0, to - step + 1);
      const logs = await this.rpc.getLogs({
        address: this.chain.ADDR.poolManager, topics: [TOPIC.modifyLiquidity, pos.pool_ref],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      });
      // data = tickLower, tickUpper, liquidityDelta (int256), salt — each 32 bytes
      const mine = logs.filter((l) => l.data.length === 2 + 4 * 64 && l.data.slice(-64) === salt
        && BigInt.asIntN(256, BigInt('0x' + l.data.slice(2 + 2 * 64, 2 + 3 * 64))) < 0n);
      if (mine.length) return mine[mine.length - 1].transactionHash;
    }
    return null;
  }

  // Our position's liquidity per the chain; null if unreadable.
  async chainLiquidity(pos) {
    try {
      if (this.chain.isV3Venue(pos.venue)) {
        const [w] = await this.rpc.ethCallMany([{ to: this.chain.npmFor(pos.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(pos.token_id)]) }]);
        return w && w !== '0x' ? BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]) : null;
      }
      const [w] = await this.rpc.ethCallMany([{ to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(pos.token_id)]) }]);
      return w && w !== '0x' ? BigInt(w) : null;
    } catch { return null; }
  }

  async sendExit(plan, pos) {
    let tx, before, hash;
    try {
      // Exiting needs gas too. Filled BEFORE the "before" balance is read, so its unwrap
      // is not counted as a close result of an ETH-paired position.
      const gasNotes = [];
      await this.topUpGas(gasNotes);
      if (gasNotes.length) this.store.log('info', `sebelum tutup #${pos.id}: ${gasNotes.join(', ')}`);
      if (this.chain.isV3Venue(pos.venue)) {
        tx = this.exec.buildV3Decrease({ ...plan, venue: pos.venue, tokenId: pos.token_id }, this.exec.deadline());
      } else {
        const poolKey = await this.poolKeyOf(pos);
        if (!poolKey) throw new Error('poolKey posisi tidak terbaca');
        tx = this.exec.buildV4Decrease({ ...plan, poolKey, tokenId: pos.token_id }, this.exec.deadline());
      }
      // The balance BEFORE exit: the close result is measured from its difference, not from the
      // periodic sync data. A position opened then closed between two syncs
      // (30 seconds) used to be recorded with a $0 result — its PnL read as a total loss.
      before = await this.exec.balances([pos.token0, pos.token1]);
      hash = await this.exec.send(tx, { kind: plan.full ? 'burn' : 'decrease', detail: { position: pos.id } });
    } catch (e) { e.notSent = true; throw e; }   // no exit tx on chain yet: safe to repeat
    const rc = await this.exec.waitReceipt(hash, 90_000);
    // The tx is on chain but its receipt is not yet read: do NOT close it with $0 on the next
    // sync — closeEmptyPosition finds this tx in the txs table and records its result
    // from the receipt once readable.
    if (rc.timeout) throw new Error(`belum terkonfirmasi setelah 90 detik — tx ${hash} mungkin masih diproses; hasilnya dicatat otomatis begitu receipt terbaca`);
    if (!rc.ok) throw new Error(`transaksi keluar revert (${hash})`);
    return this.recordExit(plan, pos, hash, rc.receipt, before);
  }

  // Booking after the exit tx is confirmed: proceeds from the receipt, leftover memecoin, then
  // the sale of the leftovers. Used by sendExit and closeEmptyPosition (a tx whose receipt
  // is only read later, or a withdrawal outside the bot).
  async recordExit(plan, pos, hash, receipt, before = null) {
    const proceeds = await this.exitProceeds(pos, before, receipt);
    // The position is recorded closed FIRST — complete with the leftover memecoin received and
    // its value at the close price — and only then are the leftovers sold. If the sale succeeds,
    // recordLeftoverSale replaces that estimate with the actual result; if it
    // gets stuck, equity still values it at the current price, rather than making it vanish.
    const live = this.positions.live.find((p) => p.id === pos.id);
    let left = null;
    // leftover memecoin valued at the marking price (markSqrt), not the pool price that can be at the bound
    try { left = await this.leftoverOf(pos, receipt, proceeds?.markSqrt ?? live?.markSqrt ?? live?.curSqrt ?? null); }
    catch (e) { this.store.log('warn', `sisa #${pos.id} tidak terukur: ${e.message}`, { quiet: true }); }
    if (plan.full) {
      this.positions.markClosed(pos.id, {
        out0: proceeds?.amount0 ?? live?.amount0, out1: proceeds?.amount1 ?? live?.amount1,
        outQuote: proceeds?.valueQuote ?? ((live?.valueUsd || 0) + (live?.feeUsd || 0)), txHash: hash,
        exitSqrt: proceeds?.sqrt ?? live?.curSqrt ?? null, left,
      });
    } else {
      // Partial withdrawal: its result is ALREADY in the wallet, so it must enter out_quote now.
      // It used to only reduce the liquidity — position #25 lost $68.52 from its
      // records (54.75 USDG + memecoin sold for $13.77) and read as a $64 loss
      // when it was actually a $4 profit.
      this.positions.markDecreased(pos.id, {
        liquidity: (BigInt(pos.liquidity) - BigInt(plan.liquidity)).toString(),
        out0: proceeds?.amount0 ?? 0n, out1: proceeds?.amount1 ?? 0n,
        outQuote: proceeds?.valueQuote ?? 0, txHash: hash, left,
      });
    }
    // Sell the memecoin JUST received from this exit transaction. Its error must not
    // cancel recording the exit — the position really is closed on chain.
    let sold = null;
    try { sold = await this.sellLeftover(pos, receipt, { quiet: true }); }
    // A failed sale goes into the retry queue (keepLeftover); only reported if
    // the queue gives up.
    catch (e) { this.store.log('error', `jual sisa #${pos.id}: ${e.message}`, { quiet: true }); }
    return { txHash: hash, sold, note: `${plan.full ? 'tutup penuh' : 'kurangi'} posisi #${pos.id}${sold ? ` · ${sold}` : ''}` };
  }

  // How much really entered the wallet from the exit transaction, read from the
  // Transfer log in the receipt (native ETH: the historical balance at that block, gas added back —
  // gas reduces the balance but is not part of the position's result). The "before/after"
  // balance difference is only a fallback: an RPC one block behind once made it
  // zero, so position #27 was recorded from a sync cache that was already stale.
  // Its value is computed at the pool price at that time.
  async exitProceeds(pos, before, receipt) {
    try {
      const me = this.exec.address().toLowerCase();
      let amount0, amount1;
      try {
        amount0 = await this.receivedIn(receipt, pos.token0, me);
        amount1 = await this.receivedIn(receipt, pos.token1, me);
      } catch (e) {
        if (!before) throw e;   // without the "before" balance there is no fallback
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
      // marking price (the pool's own if fit); exit_sqrt stays the raw pool price
      const s = await this.positions.markSlotFor(pos);
      const toks = await this.chain.tokens([pos.token0, pos.token1]);
      const v = s && this.chain.valueInQuote({
        sqrtPriceX96: s.sqrtPriceX96, amount0, amount1,
        dec0: toks[0].decimals, dec1: toks[1].decimals, token0: pos.token0, token1: pos.token1,
      });
      return { amount0: amount0.toString(), amount1: amount1.toString(), valueQuote: v ? v.value : null, sqrt: s?.poolSqrt ?? null, markSqrt: s?.sqrtPriceX96 ?? null };
    } catch (e) { this.store.log('warn', `hasil keluar #${pos.id} tidak terukur: ${e.message}`, { quiet: true }); return null; }   // fallback: the last sync figure
  }

  // Memecoin that entered the wallet from this exit transaction + its value at the close price
  // (position quote asset units). Its amount is from the Transfer log in the receipt — the same
  // as what sellLeftover will sell — not from the balance difference.
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

  // ---- sell leftover memecoin --------------------------------------------
  // Exiting an LP position returns a mix of quote asset + memecoin, depending on
  // where the price is. That memecoin is not the purpose of copying — it is sold back to the quote asset
  // of the same pool. ONLY the amount received from this exit tx is sold (read from the
  // Transfer log in the receipt), not the whole balance: this wallet can be used by other programs
  // that hold the same token.
  async sellLeftover(pos, receipt, opts = {}) {
    const rules = this.rulesFrom(pos.target);
    if (!rules.exit.sell_leftover) return null;
    // quoteSideOf returns an object {side, symbol, kind}, not a number.
    const q = this.chain.quoteSideOf(pos.token0, pos.token1);
    if (!q) return null;                            // a pair without a quote asset
    const meme = String(q.side === 0 ? pos.token1 : pos.token0).toLowerCase();
    const quote = String(q.side === 0 ? pos.token0 : pos.token1).toLowerCase();
    // ETH/USDG, WETH/USDG, etc.: both are "money" — there is no memecoin to sell.
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

  // Sell `amount` of a token into `quote` via Kyber. Failure -> recorded to be retried.
  // `quiet`: a sale that happens inside the exit transaction has already been reported by the
  // position close news — do not send a second notice for the same thing.
  async sellToken(item, { quiet = false } = {}) {
    const rules = this.rulesFrom(item.target);
    // One sale per token at a time. The automatic queue (every second), the "sell now"
    // button, and leftovers from an exit tx can touch the same token at once —
    // a second sale builds a swap from the balance the first is selling and
    // reverts (gas burned), or sells another item's share. What is held back stays queued.
    this.selling = this.selling || new Set();
    const lockKey = String(item.token).toLowerCase();
    if (this.tokenInEntry(lockKey)) {
      this.keepLeftover({ ...item, amount: String(item.amount) }, 'menunggu entry yang memakai token ini selesai');
      return null;
    }
    if (this.selling.has(lockKey)) {
      this.keepLeftover({ ...item, amount: String(item.amount), next: 0 }, 'menunggu penjualan token yang sama selesai');
      return null;
    }
    this.selling.add(lockKey);
    try { return await this.sellTokenLocked(item, rules, { quiet }); }
    finally { this.selling.delete(lockKey); }
  }

  // An independent price comparator for one leftover sale, so the loss-limit gate
  // does not depend on whether Kyber happens to have a price feed for that token.
  //   usdIn   : the value of `amount` at its own position's pool price (valueLeftover already
  //             uses markFor, which clamps an absurd pool price to the position's entry price)
  //   usdPerOut/outDecimals : the exit side is always a quote asset — its value we know exactly
  // null on either side is not a failure: routeLoss uses whatever exists.
  async sellRef(item, amount) {
    const out = this.chain.QUOTES[String(item.quote).toLowerCase()] || null;
    const ref = {
      usdIn: null,
      usdPerOut: out ? (out.kind === 'eth' ? this.ethUsd : 1) : null,
      outDecimals: out?.decimals ?? null,
    };
    try {
      const rows = this.positions.leftoverRows(item.token)
        .filter((r) => item.posId == null || r.id === item.posId);
      if (rows.length) ref.usdIn = await this.positions.valueLeftover(rows, amount, this.ethUsd);
      else {
        // Fee memecoin not yet sold has its own ledger, the same row shape.
        const fee = this.positions.feeLeftoverRows(item.token, item.posId ?? null);
        if (fee.length) ref.usdIn = await this.positions.valueLeftover(fee, amount, this.ethUsd);
      }
    } catch (e) {
      this.store.log('warn', `pembanding harga sisa ${String(item.token).slice(0, 10)}…: ${e.message}`, { quiet: true });
    }
    if (!(ref.usdIn > 0)) ref.usdIn = null;
    return ref;
  }

  // The largest amount that still fits the loss limit, found by binary search over Kyber quotes.
  //
  // All-or-nothing leaves only two endings that are equally bad: stuck forever,
  // or dumped whole at any price. What happened in production was always the second,
  // through the gate gap above, and the pattern is exactly the same in the three biggest incidents —
  // rejected many times while Kyber had a price, then IN THE SAME MINUTE a quote
  // without a USD price slipped through and the entire leftover went out:
  //   #82  13 Sep 18:55 rejected 42.0% → 18:56 rejected 56.6% → 18:56 sold $72.76 ($173)
  //   #175 15 Sep 18:59 rejected 93.2% → 18:59 sold $7.26
  //   #187 16 Sep 10:18 rejected 88.2% → 10:18 sold $4.14
  // After that gap was closed, what remains is precisely the first ending — hence the chunking.
  // Sell as much as the pool can absorb now, the rest goes back to the queue: the gap
  // between attempts gives liquidity and arbitrage time to restore the price, and that is exactly
  // what is never obtained if everything is dumped in one tx.
  //
  // Quotes only (GET), no tx is sent. MAX_PROBE steps are used so the
  // cost stays ~5 HTTP calls per problematic sale.
  async fitSell(item, amount, rules, ref) {
    const MAX_PROBE = 5, MIN_CHUNK_USD = 2;
    const maxLoss = rules.exit.sell_max_loss_bps;
    const usdOf = (part) => (ref.usdIn != null ? (ref.usdIn * Number(part)) / Number(amount) : null);
    let ok = null, lo = 0n, hi = amount;
    for (let i = 0; i < MAX_PROBE && hi - lo > amount / 100n; i++) {
      const mid = lo + (hi - lo) / 2n;
      if (mid <= 0n) break;
      // Too small to pay for its own gas (~$0.16/sale): stop shrinking.
      const usd = usdOf(mid);
      if (usd != null && usd < MIN_CHUNK_USD) break;
      const q = await this.kyber.quote(item.token, item.quote, mid);
      const loss = q ? Kyber.routeLoss(q, { ...ref, usdIn: usdOf(mid) }) : null;
      if (loss && loss.bps <= maxLoss) { ok = { amount: mid, loss: loss.bps, usdOut: loss.usdOut }; lo = mid; }
      else hi = mid;
    }
    return ok;
  }

  async sellTokenLocked(item, rules, { quiet }) {
    // A sale needs gas: native ETH below the reserve is topped up first (from WETH/USDG).
    await this.topUpGas([]).catch(() => {});
    let amount = BigInt(item.amount), label = String(item.token).slice(0, 10);
    try {
      const bal = (await this.exec.balances([item.token])).get(item.token) || 0n;
      amount = bal < BigInt(item.amount) ? bal : BigInt(item.amount);
      if (amount === 0n) { this.dropLeftover(item); return null; }
      const meta = await this.chain.token(item.token).catch(() => null);
      label = `${(Number(amount) / 10 ** (meta?.decimals ?? 18)).toPrecision(4)} ${meta?.symbol || item.token.slice(0, 8)}`;
    } catch (e) {
      // The balance is unreadable (RPC). This error used to slip through BEFORE the item was queued: leftovers
      // from an exit tx never entered the queue and were never sold by anyone.
      // Still queued (without a loud warning — this is a temporary RPC error).
      this.keepLeftover({ ...item, amount: String(item.amount) }, `saldo belum terbaca: ${e.message}`);
      throw new Error(`${label} belum terjual: ${e.message}`);
    }
    const ref = await this.sellRef(item, amount);
    const swapOpts = {
      slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps,
      kind: 'sell_leftover', detail: { position: item.posId, source: leftoverSource(item), target: item.target ?? null }, ref, requireLoss: true,
    };
    let sold = amount;
    try {
      let r = null;
      try {
        r = await this.kyber.swap(item.token, item.quote, amount, swapOpts);
      } catch (e) {
        // A failed safeguard or an unread receipt stops here. Only two market
        // causes fall through below: a route that loses too much (e.loss) and a tx
        // rejected by the chain through the third attempt (e.reverted).
        if (!(e.loss || e.reverted)) throw e;
        // An expensive aggregator route does not necessarily mean the market is expensive — Kyber
        // sometimes routes through a bad path, and its own price can be empty. The direct
        // pool is evaluated on its own (pool fee + price impact) with the same limit,
        // and only sent if its simulation passes; if the pool does not fit either,
        // only then is the amount cut and sold in stages via Kyber.
        const viaPool = await this.sellViaPool(item, amount, rules).catch(() => null);
        if (viaPool) {
          this.log(`sisa ${label}: Kyber tidak jadi (${e.message}) — terjual utuh lewat pool langsung`);
          r = viaPool;
        } else {
          // The full amount does not fit the loss limit: find the largest chunk that fits and
          // sell that first. The rest stays in the queue, neither burned nor dumped by force.
          if (!e.loss) throw e;
          const fit = await this.fitSell(item, amount, rules, ref);
          if (!fit) throw e;
          this.log(`sisa ${label}: jumlah penuh rugi ${(e.loss.lossBps / 100).toFixed(1)}%, dijual bertahap ${(Number(fit.amount * 1000n / amount) / 10).toFixed(0)}% dulu (rugi ${(fit.loss / 100).toFixed(1)}%)`);
          sold = fit.amount;
          r = await this.kyber.swap(item.token, item.quote, sold, swapOpts);
        }
      }
      // Kyber does not know the route (a new token's pool is often not yet indexed): try selling
      // directly into a pool we know — the position's own pool and pools of the same pair.
      if (!r) { sold = amount; r = await this.sellViaPool(item, amount, rules); }
      if (!r) throw new Error('Tidak ada agregator yang menemukan rute (pool langsung juga tidak bisa)');
      const rest = amount - sold;
      // A partial sale is progress, not failure: the attempt counter and the
      // old quote are reset so the warning banner does not pile up as if stuck.
      if (rest > 0n) this.keepLeftover({ ...item, amount: rest.toString(), tries: 0, lastLossBps: null, lastUsdIn: null, lastUsdOut: null },
        'sebagian terjual, sisanya menunggu likuiditas');
      else this.dropLeftover(item);
      try {
        // Claimed fees and close leftovers can both contain this token:
        // recordTokenSale splits the proceeds into the right ledger.
        this.positions.recordTokenSale({ posId: item.posId, token: item.token, amount: sold, quoteToken: item.quote,
          txHash: r.hash, amountOut: r.amountOut, usdOut: r.quote?.usdOut, ethUsd: this.ethUsd });
      } catch (e) { this.store.log('warn', `catat hasil jual ${leftoverOrigin(item)}: ${e.message}`, { quiet: true }); }
      // Kyber's usdOut can be empty on a thin token; the exit side is a quote asset, so its value
      // is computed ourselves rather than reporting "$0.00" for a sale that succeeded.
      const usdOut = r.quote?.usdOut ?? (r.amountOut != null && ref.usdPerOut != null
        ? (Number(r.amountOut) / 10 ** ref.outDecimals) * ref.usdPerOut : null);
      const msg = `jual ${label}${rest > 0n ? ' (sebagian)' : ''} → $${(usdOut || 0).toFixed(2)} (${r.quote.dex})`;
      if (!quiet) {
        this.notify(`${leftoverOrigin(item)}: ${msg}`, {
          kind: 'leftover', positionId: item.posId, txHash: r.hash, label, usdIn: r.quote.usdIn ?? ref.usdIn,
          usdOut, dex: r.quote.dex, tries: item.tries || 0, partial: rest > 0n,
        });
      }
      return msg;
    } catch (e) {
      this.keepLeftover({ ...item, amount: amount.toString() }, e.message);
      this.alertLeftover({ ...item, amount: amount.toString() }, label, e);
      throw new Error(`${label} belum terjual: ${e.message}`);
    }
  }

  // Sell via a single direct pool (UniversalRouter), a fallback if Kyber has no route.
  // The same safeguards as selling via Kyber: the loss limit (pool fee + price impact) from the
  // sell_max_loss_bps rule, minOut from the pool estimate minus slippage, and the tx is only
  // sent if its simulation passes. Dust (< $0.50) is not sold: the gas costs more.
  async sellViaPool(item, amount, rules) {
    const token = String(item.token).toLowerCase(), quote = String(item.quote).toLowerCase();
    const ctx = { store: this.store, chain: this.chain, rpc: this.rpc, exec: this.exec, log: this.log };
    const extra = [];
    if (item.posId != null) {
      const p = this.store.get('SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks FROM positions WHERE id=?', item.posId);
      if (p && [p.token0, p.token1].map((x) => String(x).toLowerCase()).sort().join() === [token, quote].sort().join()) {
        extra.push({ ...p, pool_addr: this.chain.isV3Venue(p.venue) ? p.pool_ref : null });
      }
    }
    const known = extra.length || this.store.get('SELECT 1 FROM pools WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?))', this.network, token, quote, quote, token);
    if (!known) return null;
    const maxLoss = Number(rules.exit.sell_max_loss_bps) || 1500;
    const usdOf = (out) => {
      const q = this.chain.QUOTES[quote];
      return q ? (Number(out) / 10 ** q.decimals) * (q.kind === 'eth' ? this.ethUsd : 1) : null;
    };
    // Estimate first without a meaningful allowance/simulation (minOut 1): if dust or too
    // lossy, stop before the approval that costs gas.
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
    const h = await this.exec.send(pick.tx, { kind: 'sell_leftover', detail: { position: item.posId, source: leftoverSource(item), target: item.target ?? null, via: pick.pool.pool_ref, dex: `pool ${pick.pool.venue}`, usdOut,
      tokenIn: String(token).toLowerCase(), tokenOut: String(quote).toLowerCase(), amountInRaw: amount.toString() } });
    const rc = await this.exec.waitReceipt(h, 90_000);
    if (rc.timeout) throw new Error(`jual lewat pool ${h} belum terkonfirmasi setelah 90 detik`);
    if (!rc.ok) throw new Error(`jual lewat pool gagal (${h})`);
    const me = this.exec.address().toLowerCase();
    const got = isNative(quote) ? null : await this.receivedIn(rc.receipt, quote, me).catch(() => null);
    return { hash: h, amountOut: got ?? pick.outEst, quote: { dex: `pool ${pick.pool.venue} ${String(pick.pool.pool_ref).slice(0, 10)}…`, usdIn: null, usdOut: got != null ? usdOf(got) : usdOut } };
  }

  // A token that cannot be sold = stuck money. Reported LOUDLY on the
  // first failure, then reminded every 6 hours while still stuck — not
  // every attempt: the queue checks every few seconds, and the same news
  // thousands of times only makes people immune.
  alertLeftover(item, label, e) {
    const cur = this.leftovers().find((x) => this.sameLeftover(x, item));
    if (!cur) return;
    const first = (cur.tries || 0) <= 1;
    const due = Date.now() - (cur.alertedAt || 0) > 6 * 3600_000;
    if (!first && !due) return;
    this.saveLeftovers(this.leftovers().map((x) => (this.sameLeftover(x, item) ? { ...x, alertedAt: Date.now() } : x)));
    this.notify(`SISA BELUM TERJUAL: ${label} dari ${leftoverOrigin(item)} — ${e.message}`, {
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
    try { return JSON.parse(this.store.getState(this.sk('leftovers'), '[]') || '[]'); }
    catch { return []; }
  }
  saveLeftovers(list) { this.store.setState(this.sk('leftovers'), JSON.stringify(list)); }
  // An item is identified by the pair (position, token). posId null = swept from the wallet,
  // not from a position — `?? null` equates null and undefined so old items
  // (that do not have this field yet) are never mixed up with sweep items.
  sameLeftover(a, b) { return (a.posId ?? null) === (b.posId ?? null) && a.token === b.token; }
  // Items are NEVER dropped by themselves: the money is still stuck in the wallet, so
  // the dashboard warning and the swap token list must keep seeing it until sold
  // or removed manually. `tries` is just a counter; the schedule is every few seconds.
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

  // Called every second (index.js). Each item is checked with ONE Kyber quote
  // (not build + send): if the loss is still above the limit, just record it and
  // wait for the next tick. Only if it passes is the real sale run —
  // with the same safeguards as usual. So hunting for liquidity that
  // improves momentarily is cheap: one HTTP call to Kyber per item per interval.
  async retryLeftovers() {
    if (this.stopping || this.dryRun() || !this.exec.address() || this.leftoverBusy) return;
    this.leftoverBusy = true;
    try {
      for (const item of this.leftovers()) {
        if (Date.now() < (item.next || 0)) continue;
        if (this.tokenInEntry(item.token)) continue;   // sold after its entry finishes
        const rules = this.rulesFrom(item.target);
        try {
          const bal = (await this.exec.balances([item.token])).get(item.token) || 0n;
          const amount = bal < BigInt(item.amount) ? bal : BigInt(item.amount);
          if (amount === 0n) { this.dropLeftover(item); continue; }
          const q = await this.kyber.quote(item.token, item.quote, amount);
          const ref = await this.sellRef(item, amount);
          const lossRef = q ? Kyber.routeLoss(q, ref) : null;
          const loss = lossRef?.bps ?? null;
          // Without a Kyber route: the direct pool path is tried (sellToken → sellViaPool), at most
          // every 60 seconds per item — each attempt reads & simulates pools.
          if (!q && Date.now() - (item.poolTriedAt || 0) > 60_000) {
            this.saveLeftovers(this.leftovers().map((x) => (this.sameLeftover(x, item) ? { ...x, poolTriedAt: Date.now() } : x)));
            await this.sellToken({ ...item, poolTriedAt: Date.now() });
            continue;
          }
          // An UNMEASURABLE loss is treated the same as a loss above the limit: held back.
          // `loss != null` used to let a quote without a USD price slip straight into a
          // full sale — the same path that drained position #82.
          if (!q || loss == null || loss > rules.exit.sell_max_loss_bps) {
            const why = !q ? 'Tidak ada agregator yang menemukan rute'
              : loss == null ? 'rugi rute tidak terukur (agregator tanpa harga USD dan tanpa pembanding)'
                : `rute agregator rugi ${(loss / 100).toFixed(1)}% (batas ${(rules.exit.sell_max_loss_bps / 100).toFixed(1)}%) — $${lossRef.usdIn.toFixed(2)} → $${lossRef.usdOut.toFixed(2)}`;
            const e = new Error(why);
            if (lossRef) e.loss = { lossBps: loss, maxLossBps: rules.exit.sell_max_loss_bps, usdIn: lossRef.usdIn, usdOut: lossRef.usdOut, dex: q.dex };
            // The full amount does not fit, but part of it may. Chunk search
            // costs ~5 quotes, while this loop runs every second for every item —
            // so two brakes: only for items that have already failed a few times (a loss that merely
            // flickers usually disappears by itself on the next tick, no need to cut),
            // and at most every 60 seconds. The first sale after a close does not go through
            // here — sellTokenLocked cuts right away once the full amount is refused.
            if (q && (item.tries || 0) >= 3 && Date.now() - (item.fitTriedAt || 0) > 60_000) {
              this.saveLeftovers(this.leftovers().map((x) => (this.sameLeftover(x, item) ? { ...x, fitTriedAt: Date.now() } : x)));
              if (await this.fitSell(item, amount, rules, ref)) {
                await this.sellToken({ ...item, amount: amount.toString(), fitTriedAt: Date.now() });
                continue;
              }
            }
            // The latest quote is stored so the banner on the dashboard shows the current figure.
            this.keepLeftover({ ...item, amount: amount.toString(), lastLossBps: loss, lastUsdOut: lossRef?.usdOut ?? null, lastUsdIn: lossRef?.usdIn ?? null }, why);
            const meta = await this.chain.token(item.token).catch(() => null);
            this.alertLeftover(item, `${(Number(amount) / 10 ** (meta?.decimals ?? 18)).toPrecision(4)} ${meta?.symbol || item.token.slice(0, 8)}`, e);
            continue;
          }
          await this.sellToken(item);
        } catch (e) { this.store.log('warn', `coba ulang jual sisa #${item.posId}: ${e.message}`, { quiet: true }); }   // still in the queue
      }
    } finally { this.leftoverBusy = false; }
  }

  // Sweep memecoins that have already ended up sitting in the wallet.
  //
  // sellLeftover only catches what comes out of the bot's own exit tx (read
  // from the Transfer log in its receipt), so tokens that were there earlier — leftovers of an
  // old run, a manual LP, direct transfers — never entered the queue and were never
  // sold by anyone. Here the wallet contents are read, each non-quote token is quoted to Kyber
  // ONCE, and those whose value is above the threshold are put into the same queue as a
  // position's leftovers (posId null). Dust below the threshold is deliberately skipped: its route would
  // never pass the loss limit, and an item that fails forever only makes the warning banner
  // immune to being read. No transaction is sent here — it only fills the queue;
  // the sale still goes through retryLeftovers with the same safeguards.
  async sweepWallet({ minUsd = 0.5, quote = this.chain.ADDR.usdg } = {}) {
    const me = this.exec.address();
    if (!me) throw new Error('wallet bot belum diatur');
    const q = String(quote).toLowerCase();
    // Candidates: every token the bot has ever known + those that ever entered the wallet
    // (the same list the Swap page uses, refreshed by Manual.seenTokens).
    const set = new Set();
    for (const r of this.store.all('SELECT address FROM tokens WHERE chain=?', this.network)) if (r.address) set.add(String(r.address).toLowerCase());
    try {
      const st = JSON.parse(this.store.getState(this.sk('swap_seen'), '{}') || '{}');
      if (st.wallet === me) for (const a of st.tokens || []) set.add(String(a).toLowerCase());
    } catch { /* the tokens table list alone is enough */ }
    // Tokens added manually on the Swap page are included: precisely these
    // get stuck most often — they never were a position, so are not in the tokens
    // table, and have passed the Transfer scan window if they arrived long ago.
    try {
      const c = JSON.parse(this.store.getState(this.sk('swap_tokens'), '[]') || '[]');
      if (Array.isArray(c)) for (const a of c) if (/^0x[0-9a-f]{40}$/i.test(a)) set.add(String(a).toLowerCase());
    } catch { /* the manual list may be empty */ }
    // A quote asset is the destination, not leftover. Tokens of still-open positions are also not
    // touched: they are working material (zap, add liquidity), not junk.
    for (const a of Object.keys(this.chain.QUOTES)) set.delete(a);
    set.delete(this.chain.ADDR.native);
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE chain=? AND status='open'", this.network)) {
      for (const t of [r.token0, r.token1]) if (t) set.delete(String(t).toLowerCase());
    }
    for (const it of this.leftovers()) set.delete(String(it.token).toLowerCase());
    for (const tk of this.entryTokens?.keys() || []) set.delete(tk);   // material of an entry that is running
    const list = [...set];
    if (!list.length) return { scanned: 0, queued: [], skipped: [] };

    const bal = await this.exec.balances(list);
    const owns = list.filter((a) => (bal.get(a) || 0n) > 0n);
    const metas = await this.chain.tokens(owns);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [String(t.address).toLowerCase(), t]));

    const queued = [], skipped = [];
    for (const token of owns) {
      const amount = bal.get(token);
      const meta = byAddr.get(token) || {};
      const label = `${fmtUnits(amount, meta.decimals ?? 18)} ${meta.symbol || token.slice(0, 8)}`;
      // One quote per token: what decides whether it is worth selling is how much
      // can really be withdrawn, not the pool price.
      const k = await this.kyber.quote(token, q, amount).catch(() => null);
      const usd = k?.usdOut ?? null;
      if (usd == null || usd < minUsd) {
        skipped.push({ token, label, usd,
          why: !k ? 'Tidak ada agregator yang menemukan rute' : `cuma $${(usd || 0).toFixed(2)} (< $${minUsd})` });
        continue;
      }
      this.keepLeftover({ posId: null, target: null, token, quote: q, amount: amount.toString(), tries: 0,
        since: Date.now(), source: 'wallet', lastUsdOut: usd, lastUsdIn: k.usdIn ?? null }, 'baru disapu dari wallet, menunggu giliran');
      queued.push({ token, label, usd });
    }
    if (queued.length) {
      this.store.log('info', `sapu wallet: ${queued.length} token masuk antrean jual — ${queued.map((x) => `${x.label} (~$${x.usd.toFixed(2)})`).join(', ')}`);
    }
    return { scanned: owns.length, queued, skipped };
  }

  // The last safety net for exit signals.
  //
  // Every detection path can fail: the RPC skips a range, the process dies when the
  // action arrives, or the target exits before our mint could be recorded. If that
  // happens, our mirror position hangs forever while its target has
  // gone. Here the condition is checked against the source least able to be wrong:
  // the TARGET position's liquidity on chain. If it is already zero while ours is still
  // open, we exit.
  //
  // It needs TWO consecutive zero observations so a momentarily failed read or a
  // close-then-open rebalance in one transaction does not trigger a close.
  async reconcileExits() {
    if (this.dryRun() || !this.exec.address()) return;
    // v3 is checked too: it used to be v4 only, so a v3 mirror whose exit signal was missed
    // hung forever.
    const rows = this.store.all(
      "SELECT * FROM positions WHERE chain=? AND status='open' AND target IS NOT NULL AND mirror_of IS NOT NULL AND token_id IS NOT NULL AND takeover_ts IS NULL", this.network)
      .filter((r) => r.venue === 'v4' || this.chain.isV3Venue(r.venue));
    if (!rows.length) { this.goneStreak = new Map(); return; }
    this.goneStreak = this.goneStreak || new Map();
    let res;
    try {
      // strict: a temporary error throws (not taken as zero). A null result from v3 = the legitimate
      // revert of positions() for a burned NFT = the target exited fully.
      const out = await this.rpc.ethCallMany(rows.map((r) => (this.chain.isV3Venue(r.venue)
        ? { to: this.chain.npmFor(r.venue), data: IF_NPM.encodeFunctionData('positions', [BigInt(r.mirror_of)]) }
        : { to: this.chain.ADDR.posmV4, data: IF_POSM.encodeFunctionData('getPositionLiquidity', [BigInt(r.mirror_of)]) })), 'latest', { strict: true });
      res = out.map((w, i) => {
        if (!this.chain.isV3Venue(rows[i].venue)) {
          if (!w || w === '0x') return null;
          const L = BigInt(w);
          // An NFT not yet known to the node does NOT revert on v4 — getPositionLiquidity answers 0.
          // A lagging node (ordofi ~2k blocks) therefore sees a freshly minted target position
          // as "empty", and our freshly opened mirror gets closed. Zero is only
          // trusted for a mirror that is >10 minutes old, the same as a revert on v3.
          if (L === 0n && Date.now() - (rows[i].opened_ts || 0) <= 10 * 60_000) return null;
          return L;
        }
        // A revert is trusted as "burned" only for a mirror that is >10 minutes old: a
        // lagging node also reverts a target NFT that was just minted.
        if (w == null) return Date.now() - (rows[i].opened_ts || 0) > 10 * 60_000 ? 0n : null;
        if (w === '0x') return null;
        try { return BigInt(IF_NPM.decodeFunctionResult('positions', w)[7]); } catch { return null; }
      });
    } catch (e) { this.trouble('rekon-baca', `rekonsiliasi keluar: ${e.message}`, { after: 5, afterMs: 5 * 60_000, level: 'warn' }); return; }
    this.cleared('rekon-baca', 'rekonsiliasi keluar: RPC terbaca lagi');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const liq = res[i];
      if (liq == null) { this.goneStreak.delete(r.id); continue; }   // unreadable: do not act
      if (liq > 0n) { this.goneStreak.delete(r.id); continue; }     // the target is still inside
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

  // ---- periodic maintenance ---------------------------------------------
  // The sync is called every 30 seconds by setInterval. When the RPC is slow a round can
  // take longer than that, and a second round running at the same time books the same thing
  // twice: closeEmptyPosition/bookPendingExits (doubled exit proceeds and leftover sales),
  // bookPendingMints (doubled position rows). One round at a time.
  async syncPositions() {
    if (this.syncBusy || this.stopping) return;
    this.syncBusy = true;
    try { return await this.syncPositionsOnce(); }
    finally { this.syncBusy = false; }
  }

  async syncPositionsOnce() {
    if (this.cfg.prices?.auto_eth_price !== false) this.ethUsd = await this.chain.ethUsd(this.ethUsd);
    // Positions opened outside the bot appear without needing a restart (every 10 minutes).
    const addr = this.exec.address();
    if (addr && Date.now() - (this.lastAdopt || 0) > 10 * 60_000) {
      this.lastAdopt = Date.now();
      await this.adoptOwnPositions(addr);
    }
    // External deposits/withdrawals → wallet capital (net PnL). Every 5 minutes — every
    // minute while a piled-up window is still being paid in instalments (public archive nodes are limited per
    // minute); consecutive errors are handled like other steps, not stopping the tick.
    if (addr && this.capital.available() && Date.now() - (this.capital.lastSync || 0) > (this.capital.backlog ? 60_000 : 5 * 60_000)) {
      await this.capital.sync(addr).then(() => this.cleared('modal', 'pelacakan setoran: berhasil lagi'))
        .catch((e) => this.trouble('modal', `pelacakan setoran: ${e.message}`, { after: 3, afterMs: 30 * 60_000 }));
    }
    // All of these steps repeat every sync (30 seconds) — a momentary error is not reported.
    const once = (key, label, p) => p.then(() => this.cleared(key, `${label}: berhasil lagi`))
      .catch((e) => this.trouble(key, `${label}: ${e.message}`, { after: 5, afterMs: 5 * 60_000 }));
    await once('compound', 'pencatatan compound', this.compound.reconcile());
    await once('claim', 'pencatatan claim fee', this.reconcileFeeClaims());
    await once('rekon', 'rekonsiliasi keluar', this.reconcileExits());
    await this.positions.sync(this.ethUsd);
    await once('buku-masuk', 'pembukuan mint tertunda', this.bookPendingMints());
    await once('buku-keluar', 'pembukuan tx keluar tertunda', this.bookPendingExits());
    await once('zap-yatim', 'pemulihan zap tanpa LP', this.recoverStrandedZaps());
    await once('kas', 'saldo kas', this.refreshCash());
    await once('sisa', 'nilai token sisa', this.positions.refreshLeftovers(this.ethUsd, this.exec.address()));
    // The position's own target rules (manual/adopted positions without a target: the global rules).
    const triggers = this.positions.exitTriggers((p) => this.rulesFrom(p.target));
    for (const t of triggers) {
      if (this.stopping) break;
      if (this.exiting.has(t.pos.id)) continue;
      // Manual control: standalone exit rules do not apply. Read from the database, not the
      // sync result (can be 30 seconds old). A position that is empty on chain is still booked.
      if (!t.pos.empty && this.store.get('SELECT takeover_ts FROM positions WHERE id=?', t.pos.id)?.takeover_ts != null) continue;
      if (t.pos.empty) {
        // Closing in the database without a transaction = a $0 result recorded forever. Re-read
        // first; if it turns out to still exist, leave it to the next sync to evaluate.
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
        this.cleared(`keluar:${t.pos.id}`, null);                   // close card = its news
        // Closed because it is out of range, not because the target exited: if the target is still
        // inside and the price comes back near, its mirror is opened again.
        if (t.kind === 'oor' && t.pos.mirror_of && t.pos.target) {
          this.watchReentry({ target: t.pos.target, venue: t.pos.venue, tokenId: t.pos.mirror_of }, this.rulesFrom(t.pos.target), { why: 'ditutup', posId: t.pos.id });
        }
      } catch (e) {
        // The trigger still applies, so it is repeated on the next sync. Two failures
        // (~1 minute) are already reported: funds are currently not protected by a stop-loss.
        this.trouble(`keluar:${t.pos.id}`, `keluar mandiri gagal #${t.pos.id}: ${e.message}`, { after: 2 });
      }
    }
    if (!this.stopping) await this.compound.tick(Date.now(), new Set(triggers.map((t) => t.pos.id)));
    if (!this.stopping) await once('masuk-lagi', 'buka lagi posisi yang ditunda', this.reentryTick());
  }

  // ---- reopen a position that was deferred/closed for being far from the range -----------
  // One watch per target position (target + venue + tokenId), stored in the state table
  // so it survives a restart. Created when (a) a target entry is skipped because its range is
  // > out_of_range_pct from the price, or (b) a mirror is closed by the out-of-range rule.
  // Released once the mirror is open again, the target exits, or its rule is switched off.
  reentryKey(target, venue, tokenId) { return this.sk(`reentry:${target}:${venue}:${tokenId}`); }

  watchReentry({ target, venue, tokenId }, rules, extra = {}) {
    const near = this.reentryNearPct(rules);
    if (!near || !target || !tokenId) return null;
    const key = this.reentryKey(target, venue, tokenId);
    let prev = null;
    try { prev = JSON.parse(this.store.getState(key) || 'null'); } catch { prev = null; }
    const w = { ts: Date.now(), target, venue, tokenId: String(tokenId), tries: 0, ...extra, nearPct: near };
    // An old watch for the same position is updated, not duplicated.
    if (prev && prev.actionId != null && w.actionId == null) w.actionId = prev.actionId;
    this.store.setState(key, JSON.stringify(w));
    this.store.log('info', `pantau #${tokenId} target ${target.slice(0, 10)}… (${w.why || 'jauh dari rentang'}): buka lagi kalau harga ≤ ${near}% dari rentang`, { quiet: true });
    return w;
  }

  // The "near" threshold in effect: reenter_within_pct, forced below out_of_range_pct
  // so the mirror does not open-close at one threshold. 0/null = reopen off.
  reentryNearPct(rules) {
    const e = rules.exit;
    let near = Number(e.reenter_within_pct) || 0;
    if (near <= 0) return 0;
    if (e.out_of_range_pct > 0 && near >= e.out_of_range_pct) near = e.out_of_range_pct / 2;
    return near;
  }

  reentryWatches() {
    const out = [];
    for (const r of this.store.all("SELECT k, v FROM state WHERE k LIKE 'reentry:%' AND k LIKE ?", `%:${this.network}`)) {
      try { const w = JSON.parse(r.v); if (w && w.target && w.tokenId) out.push({ key: r.k, ...w }); } catch { /* baris rusak: diabaikan */ }
    }
    return out;
  }

  async reentryTick() {
    const watches = this.reentryWatches();
    if (!watches.length) return;
    const drop = (w, why) => { this.store.run('DELETE FROM state WHERE k=?', w.key); if (why) this.store.log('info', `berhenti memantau #${w.tokenId} target ${w.target.slice(0, 10)}…: ${why}`, { quiet: true }); };
    for (const w of watches) {
      if (this.stopping) return;
      const t = this.store.get('SELECT enabled FROM targets WHERE chain=? AND address=?', this.network, w.target);
      if (!t) { drop(w, 'target dihapus'); continue; }
      const rules = this.rulesFrom(w.target);
      const near = this.reentryNearPct(rules);
      if (!near) { drop(w, 'aturan buka-lagi dimatikan'); continue; }
      if (this.store.get("SELECT 1 FROM positions WHERE chain=? AND status='open' AND mirror_of=? AND target=?", this.network, w.tokenId, w.target)) { drop(w, 'cermin sudah terbuka'); continue; }
      // Pause/disabled target/drawdown: the same as an ordinary entry, waited on — not released.
      if (!t.enabled || this.paused() || this.drawdownTripped()) continue;
      if (w.retryAfter && Date.now() < w.retryAfter) continue;
      // The target position must still hold liquidity. Unreadable = wait for the next sync.
      let liq = null;
      try { liq = (await this.targetLiquidity(w.venue, w.tokenId))?.liquidity ?? null; } catch { liq = null; }
      if (liq == null) continue;
      if (liq <= 0n) { drop(w, 'target sudah keluar dari posisinya'); continue; }
      // The range & pool of the target position: from its last entry action (fallback: our closed
      // mirror row — the range is exactly the same only in exact mode, but enough for distance).
      const src = this.store.get(
        "SELECT * FROM actions WHERE chain=? AND target=? AND venue=? AND token_id=? AND kind IN ('mint','increase','reentry') AND tick_lower IS NOT NULL AND pool_ref IS NOT NULL ORDER BY id DESC LIMIT 1",
        this.network, w.target, w.venue, w.tokenId)
        || (w.posId != null ? this.store.get('SELECT * FROM positions WHERE id=?', w.posId) : null);
      if (!src || src.tick_lower == null || src.tick_upper == null || !src.pool_ref) { drop(w, 'rentang posisi target tidak diketahui'); continue; }
      let slot0 = null;
      try { slot0 = this.chain.isV3Venue(w.venue) ? await this.chain.slot0V3(src.pool_ref) : await this.chain.slot0V4(src.pool_ref); } catch { slot0 = null; }
      if (!slot0) continue;
      const dist = m.distanceFromRangePct(slot0.tick, src.tick_lower, src.tick_upper);
      if (dist > near) continue;                                    // still far: wait
      // Near & the target is still inside: evaluated like a new entry signal, with the
      // target's CURRENT liquidity (the size follows what it really holds). A synthetic
      // 'reentry' action is recorded so the decision shows in the history like other signals.
      const id = Number(this.store.run(
        `INSERT INTO actions(chain,ts,block,tx_hash,log_index,target,venue,kind,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,quote_symbol)
         VALUES(?,?,?,?,?,?,?,'reentry',?,?,?,?,?,?,?,?,?,?,?)`,
        this.network, Date.now(), this.head || 0, `reentry:${w.tokenId}:${Date.now()}`, 0, w.target, w.venue, w.tokenId, src.pool_ref,
        src.token0, src.token1, src.fee, src.tick_spacing, src.hooks, src.tick_lower, src.tick_upper, liq.toString(), src.quote_symbol ?? null).lastInsertRowid);
      const act = this.actFromRow(this.store.get('SELECT * FROM actions WHERE id=?', id));
      act.slot0 = slot0;
      drop(w, null);
      try { await this.handleEntry(act, rules); }
      catch (e) { this.decide(id, 'error', String(e.message).slice(0, 300)); this.store.log('error', `buka lagi #${w.tokenId}: ${e.message}`); }
      const d = this.store.get('SELECT verdict, reason FROM decisions WHERE action_id=? ORDER BY id DESC LIMIT 1', id);
      if (d && d.verdict !== 'copy' && d.verdict !== 'dry' && !/dari harga \(batas/.test(d.reason || '')) {
        // Cannot yet (cash, budget, pool cooldown, …): retried every 15 minutes, at most
        // 8 times, while the price is still near and the target is still inside.
        const tries = (w.tries || 0) + 1;
        if (tries < 8) this.store.setState(w.key, JSON.stringify({ ...w, key: undefined, tries, retryAfter: Date.now() + 15 * 60_000 }));
        else this.store.log('warn', `buka lagi #${w.tokenId} target ${w.target.slice(0, 10)}… menyerah setelah ${tries} percobaan: ${d.reason}`);
      }
    }
  }

  // Native ETH reserve for gas: fixed from the config, or the cost of one heaviest transaction
  // when the gas price is high (Executor.gasReserve). A fake exec in tests has none: fixed.
  async gasReserve() {
    const fixed = BigInt(this.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    if (!this.exec?.gasReserve) return fixed;
    try { return await this.exec.gasReserve(); } catch { return fixed; }
  }

  // Native ETH below the gas reserve but WETH available: unwrap until the reserve is
  // full again. Without this a wallet whose cash is WETH slowly runs out of gas —
  // although exit transactions are what need gas most. A failure here does not
  // stop entry or exit: the remaining native ETH may still suffice.
  async topUpGas(notes) {
    const reserve = await this.gasReserve();
    let nat;
    try {
      const b = await this.exec.balances([this.chain.ADDR.native, this.chain.ADDR.weth]);
      nat = b.get(this.chain.ADDR.native) || 0n;
      const weth = b.get(this.chain.ADDR.weth) || 0n;
      if (nat >= reserve) return;
      if (weth > 0n) {
        const amt = weth < reserve - nat ? weth : reserve - nat;
        // Under 1/10 of the reserve is not worth the unwrap's own gas — without this
        // limit WETH dust triggers a pointless transaction on every entry and exit.
        if (amt * 10n >= reserve) {
          const h = await this.exec.send(this.exec.buildUnwrapWeth(amt), { kind: 'unwrap_weth', detail: { amountInRaw: String(amt) } });
          if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`tx ${h} gagal`);
          notes.push(`isi gas: buka bungkus ${fmtUnits(amt, 18)} ${this.chain.wethSymbol}`);
          nat += amt;
        }
      }
    } catch (e) {
      this.store.log('warn', `isi gas dari ${this.chain.wethSymbol} gagal: ${e.message}`, { quiet: true });   // retried on the next transaction
      return;
    }
    // Without WETH, USDG cash only: native ETH runs out = ALL transactions fail "insufficient
    // funds for gas" — including closing positions and selling leftovers (12 Sep 14:39–14:42:
    // three entries and the sale of 18.86 FRONTIER failed in a row). Buy enough ETH
    // from USDG while there is still gas for its swap. Only when below half
    // the reserve, so as not to swap a little at a time on every transaction.
    if (nat == null || nat * 2n >= reserve || !this.kyber?.swap) return;
    // Failed (e.g. the ETH is not even enough for this swap): do not repeat on every
    // leftover sale every 5 seconds — pause 10 minutes.
    if (Date.now() - (this.gasTopupFailedAt || 0) < 10 * 60_000) return;
    try {
      const rules = this.rulesFrom(null);
      if (rules?.swap?.enabled === false || !(this.ethUsd > 0)) return;
      const { usdgDecimals, usdgSymbol, nativeSymbol } = this.chain;
      const usdg = (await this.exec.balances([this.chain.ADDR.usdg])).get(this.chain.ADDR.usdg) || 0n;
      const want = Engine.gasTopupWei(reserve, nat, this.cfg);
      const pay = Engine.gasTopupUsdg(want, this.ethUsd, this.cfg, usdgDecimals);
      if (pay < 10n ** BigInt(usdgDecimals) || usdg < pay) return;   // < $1 or the stablecoin is not enough
      const r = await this.kyber.swap(this.chain.ADDR.usdg, this.chain.ADDR.native, pay, { slippageBps: 100, maxLossBps: 300, kind: 'gas_topup' });
      if (r) notes.push(`isi gas: beli ${fmtUnits(want, 18)} ${nativeSymbol} dari ${fmtUnits(pay, usdgDecimals)} ${usdgSymbol}`);
      else this.gasTopupFailedAt = Date.now();
    } catch (e) {
      this.gasTopupFailedAt = Date.now();
      this.store.log('warn', `isi gas dari ${this.chain.usdgSymbol} gagal: ${e.message}`, { quiet: true });
    }
  }

  // How much ETH the gas top-up buys. The dynamic reserve = gas limit × maxFee, so a spike in the
  // gas price — or a single endpoint reporting a nonsense eth_gasPrice — can make it
  // 0.2+ ETH; without a bound, the gas top-up would swap hundreds of dollars of USDG into ETH. The
  // purchase target is capped at 4× the fixed reserve, and its value capped by gas.topup_max_usd ($25).
  static gasTopupWei(reserve, have, cfg) {
    const fixed = BigInt(cfg?.gas?.native_reserve_wei ?? 2_000_000_000_000_000);
    const target = reserve < fixed * 4n ? reserve : fixed * 4n;
    return target > have ? target - have : 0n;
  }
  static gasTopupUsdg(wei, ethUsd, cfg, usdgDecimals = 6) {
    if (!(wei > 0n) || !(ethUsd > 0)) return 0n;
    const maxUsd = Number(cfg?.gas?.topup_max_usd ?? 25);
    const usd = Math.min((Number(wei) / 1e18) * ethUsd * 1.03, Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 25);
    return BigInt(Math.ceil(usd * 10 ** usdgDecimals));
  }

  // Cash that can be used to open positions: USDG, and ETH/WETH above the gas reserve (in
  // ETH). Split per asset because cash in ANOTHER quote asset has to be bridged first —
  // policy cuts it deeper. Deliberately read fresh (not this.cash, which can
  // be two minutes old) because its result decides the transaction size.
  async spendableCash() {
    const reserve = await this.gasReserve();
    const { usdgDecimals } = this.chain;
    const b = await this.exec.balances([this.chain.ADDR.native, this.chain.ADDR.usdg, this.chain.ADDR.weth]);
    const ethLike = (b.get(this.chain.ADDR.native) || 0n) + (b.get(this.chain.ADDR.weth) || 0n);
    const eth = ethLike > reserve ? ethLike - reserve : 0n;
    let usdg = b.get(this.chain.ADDR.usdg) || 0n;
    // ETH+WETH below half the reserve: topUpGas will buy ETH from USDG before
    // the entry. Without subtracting it here, the position is sized from USDG part of which is used up
    // for gas, then fails "insufficient cash".
    if (ethLike * 2n < reserve && this.ethUsd > 0) {
      const gasUsdg = Engine.gasTopupUsdg(Engine.gasTopupWei(reserve, ethLike, this.cfg), this.ethUsd, this.cfg, usdgDecimals);
      // the same condition as topUpGas: only if that purchase will really happen
      if (gasUsdg >= 10n ** BigInt(usdgDecimals) && usdg >= gasUsdg) usdg -= gasUsdg;
    }
    return { usdg: Number(usdg) / 10 ** usdgDecimals, eth: Number(eth) / 1e18 };
  }

  // Cash in the wallet (USDG + ETH + WETH) in USD. Re-read on every position sync,
  // in the same second as the position value: if cash is stale while positions are fresh,
  // the portfolio total counts the money twice right after a position is opened.
  async refreshCash() {
    if (!this.exec.address()) { this.cash = null; return null; }
    // The first read after a tx lands in a block is pinned to the block: an endpoint
    // lagging a few blocks will answer the OLD balance for 'latest' — cash also looks
    // unchanged although the position is already recorded. An endpoint that does not yet
    // have that block answers a temporary error and the RPC pool moves to another endpoint.
    // Later reads go back to 'latest': pinning EVERY read makes a free endpoint
    // (publicnode) refuse it as an archive request, and the load moves to
    // Alchemy whose quota is already used up — expensive for protection the
    // `txSeq` guard in snapshotEquity already provides.
    // The reference is the chain head once it is past that tx's block (`head` = the LOWEST head
    // among endpoints, so all of them already have it): deposits that came in after our tx
    // are also read, not just the state at the tx's block.
    const seq = this.exec.txSeq;
    const at = Math.max(this.exec.minedBlock || 0, this.head || 0);
    const block = seq !== this.cashSeq && at ? '0x' + at.toString(16) : 'latest';
    const { usdgDecimals } = this.chain;
    const b = await this.exec.balances([this.chain.ADDR.native, this.chain.ADDR.usdg, this.chain.ADDR.weth], block);
    const eth = Number(b.get(this.chain.ADDR.native) || 0n) / 1e18;
    const weth = Number(b.get(this.chain.ADDR.weth) || 0n) / 1e18;
    const usdg = Number(b.get(this.chain.ADDR.usdg) || 0n) / 10 ** usdgDecimals;
    this.cash = { usdg, eth, weth, usd: usdg + (eth + weth) * this.ethUsd, ts: Date.now() };
    this.cashSeq = seq;
    return this.cash;
  }

  // Cash for the dashboard: this.cash if no tx has landed in a block since it was read,
  // otherwise re-read first. this.cash is refreshed on every sync (30 seconds); in
  // between, positions can be opened/closed and the positions table changes immediately, the cash
  // not yet. The dashboard then adds old cash + a new position (a total EXCESS equal to the
  // position's capital) or old cash without the position that just closed (a total SHORTFALL equal to its
  // proceeds) for up to a minute. The leftover token value is also re-read: it too
  // only changes at the sync, although closing a position leaves tokens (total short) and
  // selling the leftover moves it into cash (counted twice). Requests that arrive
  // at the same time (overview polled every 5 seconds by several tabs) share one read.
  // Failed to read: the old cash, not null — a momentarily stale figure is better than an empty card.
  async freshCash() {
    if (!this.exec.address()) return null;
    if (this.cash && this.cashSeq === this.exec.txSeq) return this.cash;
    this.cashRefresh ??= this.refreshCash()
      .then((c) => this.positions.refreshLeftovers(this.ethUsd, this.exec.address()).catch(() => null).then(() => c))
      .finally(() => { this.cashRefresh = null; });
    return this.cashRefresh.catch(() => this.cash);
  }

  async snapshotEquity() {
    // In the middle of an entry/exit cash has moved but the position is not yet
    // recorded (or the reverse): the point is certainly wrong. Skip; there is another in 5 minutes.
    // Cash is ALWAYS re-read here, not from the tick cache. That cache is filled at the start of
    // the tick, BEFORE positions are opened/closed in the same tick — a snapshot using it
    // records old cash + a new position: the total plunged $139 when #38 closed, and the net PnL
    // curve also dived then spiked. Unreadable = NULL (the chart skips the point).
    //
    // The guard above only applies in that second: a cash read takes a few seconds, and
    // an entry/exit can START and FINISH in between — cash from before the tx,
    // the position summary from after. So `txSeq` is recorded before and checked
    // again after; if a tx landed in a block in between, the point is repeated once
    // (cash re-read, now certain to include that tx) and if still busy, skipped —
    // there is another point in 5 minutes.
    for (let attempt = 0; attempt < 2; attempt++) {
      if ((this.activeEntries || 0) > 0 || this.exiting.size > 0) return;
      const seq = this.exec.txSeq;
      const cash = this.exec.address() ? await this.refreshCash().catch(() => null) : null;
      const s = this.positions.summary(this.ethUsd);
      if (this.exec.txSeq !== seq || (this.activeEntries || 0) > 0 || this.exiting.size > 0) continue;
      const w = cash ? cash.usd : null;   // unreadable = NULL, not 0
      // Leftover memecoin not yet sold is counted as a "position": without this
      // the total curve plunges when a position closes and spikes again when its leftovers are sold.
      const lo = s.leftoverUsd || 0;
      const total = (w || 0) + s.exposureUsd + lo + s.feeUsd;
      this.store.run(
        'INSERT OR REPLACE INTO equity(chain,ts,wallet_quote,positions_quote,total_quote,realized_quote,fees_quote,open_positions,pnl_quote) VALUES(?,?,?,?,?,?,?,?,?)',
        this.network, Date.now(), w, s.exposureUsd + lo, total, s.realizedUsd, s.feeUsd, s.openCount,
        s.realizedUsd + s.unrealizedUsd);
      // The wallet is installed but cash failed to read this cycle: `total` plunges falsely by the
      // missing cash (see the `w` comment above) — skip the breaker, do not trip it
      // because of a sluggish RPC, not a portfolio that really lost.
      if (!this.exec.address() || cash) this.updateDrawdown(total);
      return;
    }
  }

  // Equity points from before the pnl_quote column existed. Their PnL can be reconstructed from
  // what was recorded: realized + position value + fee − the capital of positions open
  // at that time (derived from each position's open/close time).
  //
  // An ADOPTED position carries opened_ts from the chain, long before it entered the database — at
  // points before it was adopted it was not valued, so its capital must not
  // be subtracted either. The count of open positions recorded at that point (open_positions)
  // decides: the surplus candidates are dropped starting from the largest id, because
  // the id follows the order of entry into the database.
  //
  // Version 1 did not account for adoption; old points (NULL cash) are recomputed once.
  backfillEquityPnl() {
    const V = '2';
    const redo = this.store.getState(this.sk('equity_pnl_backfill')) !== V;
    const rows = this.store.all(`SELECT ts, positions_quote, fees_quote, realized_quote, open_positions FROM equity
      WHERE chain=? AND (pnl_quote IS NULL${redo ? ' OR wallet_quote IS NULL' : ''})`, this.network);
    const pos = this.store.all("SELECT id, opened_ts, closed_ts, cost_quote, quote_symbol FROM positions WHERE chain=? AND status IN ('open','closed') ORDER BY id", this.network);
    for (const r of rows) {
      const cand = pos.filter((p) => p.opened_ts <= r.ts && (!p.closed_ts || p.closed_ts > r.ts))
        .slice(0, Math.max(0, r.open_positions ?? Infinity));
      const cost = cand.reduce((a, p) => a + (p.cost_quote || 0) * usdPerQuote(p.quote_symbol, this.ethUsd, this.chain), 0);
      this.store.run('UPDATE equity SET pnl_quote=? WHERE chain=? AND ts=?',
        (r.realized_quote || 0) + (r.positions_quote || 0) + (r.fees_quote || 0) - cost, this.network, r.ts);
    }
    if (redo) this.store.setState(this.sk('equity_pnl_backfill'), V);
    return rows.length;
  }

  // `detail` (optional) is the structured data of that event — {kind:'entry'|'exit'|
  // 'leftover', positionId, txHash, ...}. ntfy still receives plain text; listeners
  // that can format (the Telegram bot) use the detail to compose a neat card.
  // `level` determines the log line written (default 'info'). News whose content is
  // a problem is written 'warn'/'error' so on the dashboard it appears as a problem, not
  // mixed in with ordinary entry/exit cards.
  notify(msg, detail = null, level = 'info') {
    const topic = this.cfg.notify?.ntfy_topic;
    // An additional listener (the Telegram bot) is installed from outside; it receives the same
    // important news as ntfy, without having to peek at every log line.
    // Deliberately called BEFORE its log line is written: that line triggers store.onLog
    // with the same text, and the listener can only filter its echo if it
    // already knows what news was just sent.
    if (this.onNotify) { try { this.onNotify(msg, { ...(detail || {}), chain: this.network, chainLabel: this.label }); } catch { /* abaikan */ } }
    this.store.log(level, msg);
    if (!topic) return;
    fetch(`https://ntfy.sh/${topic}`, { method: 'POST', body: `Quiver [${this.label}]: ${msg}` }).catch(() => {});
  }
}

module.exports = { Engine };
