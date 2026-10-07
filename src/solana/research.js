'use strict';
// Wallet research on Solana: a wallet's LP position history (Meteora DLMM, Orca, Raydium)
// and its PnL — the counterpart of src/wallet.js (EVM). Results are written to the SAME tables
// (wallets, wpositions, wevents) in the same units (values in USD), so the "This wallet's LP
// performance" panel, the Wallet page, and the research tables on pool/token pages show
// them without a special branch.
//
// Data source: the wallet's transaction history (getSignaturesForAddress + getParsedTransactions),
// then each program's official EVENTS inside — decoded with its Anchor IDL:
//   Meteora DLMM : AddLiquidity / RemoveLiquidity (amounts + active_bin_id), ClaimFee(2),
//                  PositionCreate / PositionClose — via emit_cpi (inner instruction)
//   Orca         : PositionOpened, LiquidityIncreased / LiquidityDecreased (ticks, L,
//                  amounts) — via "Program data:" logs; collect_fees has no event, its
//                  amounts are read from the pool vault transfers out beneath it
//   Raydium CLMM : CreatePersonalPosition, IncreaseLiquidity / DecreaseLiquidity (fees
//                  separate), CollectPersonalFee, LiquidityCalculate (pool sqrt price)
// The price at the time of each event comes from the chain itself (DLMM active bin, Raydium
// pool sqrt price, or the deposit composition within the tick range for Orca: √P = √A + amount1/L).
// Positions still open are valued at the current price through the venue adapters.
const { PublicKey } = require('@solana/web3.js');
const anchor = require('@coral-xyz/anchor');
const bs58 = require('bs58').default;
const R = require('@raydium-io/raydium-sdk-v2');
const m = require('../v3math');
const u = require('./units');
const { WalletResearch, summarize } = require('../wallet');
const { TRANSIENT } = require('./rpc');

const IDL = {
  meteora: require('@meteora-ag/dlmm').IDL,
  orca: require('@orca-so/whirlpools-sdk/dist/artifacts/whirlpool.json'),
  raydium: require('./idl/raydium_clmm.json'),
};
// Prefix of the Anchor event inner instruction (emit_cpi): sha256("anchor:event")[..8].
const EVENT_IX_TAG = Buffer.from('e445a52e51cb9a1d', 'hex');
// The window from the dashboard is expressed in Robinhood blocks (~0.101 s): 900,000 = ~1 day.
const WINDOW_BLOCK_MS = 101;
// A bot wallet can have thousands of transactions a day (mostly swaps). Cap per scan;
// anything older is flagged incomplete.
const MAX_TX = 2500;
// publicnode serves getTransaction at ±50/second; mainnet-beta almost always 429s.
const TX_CONCURRENCY = 10;
// A history endpoint refusing this many times in a row is taken as dead for this scan.
const HIST_DEAD_AFTER = 6;

const flatAccounts = (list) => (list || []).flatMap((a) => (a.accounts ? flatAccounts(a.accounts) : [a.name]));
const big = (x) => (x == null ? 0n : BigInt(x.toString()));
const num = (x) => (x == null ? null : Number(x.toString()));
const b58 = (k) => (k?.toBase58 ? k.toBase58() : String(k));
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] !== undefined) return o[k]; return undefined; };

class SolanaWalletResearch {
  constructor({ rpc, store, chain, log }) {
    this.rpc = rpc; this.store = store; this.chain = chain; this.log = log || console.log;
    this.network = chain.network;
    this.liveCache = new Map();
    this.codec = {};
    for (const [venue, idl] of Object.entries(IDL)) {
      const accounts = new Map(idl.instructions.map((ix) => [ix.name, flatAccounts(ix.accounts)]));
      this.codec[venue] = { program: idl.address, ev: new anchor.BorshEventCoder(idl), ix: new anchor.BorshInstructionCoder(idl), accounts };
    }
    this.byProgram = new Map(Object.entries(this.codec).map(([v, c]) => [c.program, v]));
    // Close-proceeds tokens still held vs already sold (src/proceeds.js, Solana version).
    this.proceeds = new (require('./proceeds').SolanaProceeds)({ rpc, store, chain, research: this, log: this.log });
  }

  // ---- fetch history -------------------------------------------------------------
  // The wallet's successful signatures, newest first, back to `sinceMs` / `stopSig` / MAX_TX.
  async signatures(wallet, { sinceMs = 0, stopSig = null } = {}) {
    const out = [];
    let before = null, capped = false;
    for (;;) {
      const page = await this.withRetry(() => this.rpc.run((c) => c.getSignaturesForAddress(new PublicKey(wallet), { limit: 1000, ...(before ? { before } : {}) }), { needsHistory: true }), 'daftar transaksi');
      if (!page.length) break;
      let stop = false;
      for (const s of page) {
        if (stopSig && s.signature === stopSig) { stop = true; break; }
        if (s.blockTime && s.blockTime * 1000 < sinceMs) { stop = true; break; }
        if (!s.err) out.push(s);
        if (out.length >= MAX_TX) { stop = true; capped = true; break; }
      }
      if (stop || page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    return { sigs: out, capped };
  }

  // Transactions are read in turn across ALL endpoints (new transactions are everywhere);
  // those not found are asked again from an endpoint that keeps history. Public endpoints
  // rate-limit per method — a 429 is waited out and retried (growing pause), not
  // failing the whole scan.
  async withRetry(fn, what) {
    for (let i = 0; ; i++) {
      try { return await fn(); } catch (e) {
        if (i >= 8 || !TRANSIENT.test(String(e.message))) throw e;
        await new Promise((r) => setTimeout(r, Math.min(20_000, 1500 * 2 ** i)));
        if (i === 3) this.log(`riset: ${what} tersendat (${String(e.message).slice(0, 80)}) — mencoba lagi`);
      }
    }
  }

  // One transaction per call (publicnode refuses batched getTransaction > 1), 4
  // running at once and rotating among the endpoints.
  async transactions(sigs, onProgress) {
    // Version 1: some mainnet transactions already use the v1 message format; jsonParsed
    // comes back as JSON, so the web3.js v1 client does not need to decode it.
    const opts = { maxSupportedTransactionVersion: 1, commitment: 'confirmed' };
    const fetchTx = (sig) => (c) => c.getParsedTransaction(sig, opts);
    const out = new Array(sigs.length);
    let next = 0, done = 0, skipped = 0;
    const missing = [];
    // The fast endpoint (publicnode) only keeps ±1 day of transactions; older ones only
    // exist on the history endpoint (mainnet-beta), which refuses getTransaction from many IPs
    // altogether. So: try the fast endpoint first; as soon as it answers "not found" for a
    // transaction of age T, transactions older than T go straight to the history endpoint.
    // When the history endpoint keeps refusing, the rest are skipped (their positions become
    // "incomplete") — a scan must not spin for a quarter of an hour without results.
    let quickFloor = 0, histFails = 0, histDead = false;
    this.oldUnread = 0;
    const history = async (sig) => {
      if (histDead) return undefined;
      try {
        const tx = await this.rpc.run(fetchTx(sig), { needsHistory: true });
        histFails = 0;
        return tx;
      } catch (e) {
        if (!TRANSIENT.test(String(e.message))) throw e;
        if (++histFails >= HIST_DEAD_AFTER && !histDead) {
          histDead = true;
          this.log(`riset: endpoint riwayat menolak terus (${String(e.message).slice(0, 60)}) — transaksi lebih tua dari ±1 hari dilewati; tambahkan RPC berkunci (Helius) untuk riwayat penuh`);
        }
        await new Promise((r) => setTimeout(r, 400 * histFails));
        return histDead ? undefined : history(sig);
      }
    };
    const one = async (s) => {
      const sig = s.signature;
      try {
        let tx = null;
        const old = s.blockTime && quickFloor && s.blockTime <= quickFloor;
        if (!old) {
          tx = await this.withRetry(() => this.rpc.run(fetchTx(sig)), 'baca transaksi');
          if (!tx && s.blockTime && Date.now() / 1000 - s.blockTime > 600) quickFloor = Math.max(quickFloor, s.blockTime);
        }
        if (!tx) {
          const h = await history(sig);
          if (h === undefined) { this.oldUnread++; return null; }
          tx = h;
        }
        // A very new transaction may not be available yet on the node asked: once more
        // after a pause. Still null = "pending" (read on the next refresh).
        if (!tx && (!s.blockTime || Date.now() / 1000 - s.blockTime < 600)) {
          await new Promise((r) => setTimeout(r, 2500));
          tx = await this.rpc.run(fetchTx(sig)).catch(() => null);
          if (!tx) missing.push(sig);
        }
        return tx;
      } catch (e) {
        // Still 429 after all retries: becomes "pending", the scan still finishes.
        if (TRANSIENT.test(String(e.message))) { missing.push(sig); return null; }
        if (skipped++ < 3) this.log(`riset: tx ${sig.slice(0, 8)} dilewati (${String(e.message).slice(0, 100)})`);
        return null;
      }
    };
    const worker = async () => {
      while (next < sigs.length) {
        const k = next++;
        const tx = await one(sigs[k]);
        if (tx && !tx.meta?.err) out[k] = { sig: sigs[k].signature, tx };
        done++;
        if (onProgress && (done % 10 === 0 || done === sigs.length)) onProgress({ phase: 'transaksi', scanned: done, total: sigs.length });
      }
    };
    await Promise.all(Array.from({ length: TX_CONCURRENCY }, worker));
    const txs = out.filter(Boolean);
    txs.missing = missing;
    txs.oldUnread = this.oldUnread;
    return txs;
  }

  // ---- per-transaction extraction ------------------------------------------------
  // All instructions in execution order (top level + inner), each with its decoded name
  // when its program is one of the three venues.
  instructions(tx) {
    const innerBy = new Map((tx.meta?.innerInstructions || []).map((x) => [x.index, x.instructions]));
    const seq = [];
    tx.transaction.message.instructions.forEach((ix, i) => { seq.push(ix); for (const j of innerBy.get(i) || []) seq.push(j); });
    return seq.map((ix) => {
      const venue = this.byProgram.get(b58(ix.programId));
      if (!venue || !ix.data) return { raw: ix };
      const data = Buffer.from(bs58.decode(ix.data));
      if (data.subarray(0, 8).equals(EVENT_IX_TAG)) {
        let ev = null;
        try { ev = this.codec[venue].ev.decode(data.subarray(8).toString('base64')); } catch { ev = null; }
        return { raw: ix, venue, event: ev };
      }
      let dec = null;
      try { dec = this.codec[venue].ix.decode(data); } catch { dec = null; }
      if (!dec) return { raw: ix, venue };
      const names = this.codec[venue].accounts.get(dec.name) || [];
      const acc = Object.fromEntries(names.map((n, k) => [n, ix.accounts?.[k] ? b58(ix.accounts[k]) : null]));
      return { raw: ix, venue, name: dec.name, args: dec.data, acc };
    });
  }

  // "Program data:" events in the logs (Orca & Raydium use emit!).
  logEvents(tx) {
    const out = [];
    for (const l of tx.meta?.logMessages || []) {
      const mm = /^Program data: (.+)$/.exec(l);
      if (!mm) continue;
      for (const venue of ['orca', 'raydium']) {
        let ev = null;
        try { ev = this.codec[venue].ev.decode(mm[1]); } catch { ev = null; }
        if (ev) { out.push({ venue, event: ev }); break; }
      }
    }
    return out;
  }

  // One transaction -> a list of position events { venue, id, pool, kind, a0, a1, f0, f1,
  // liq, tickLower, tickUpper, lowerBin, upperBin, activeBin, sqrtX96 }.
  extract({ sig, tx }) {
    const out = [];
    const slot = tx.slot, ts = tx.blockTime ? tx.blockTime * 1000 : null;
    const seq = this.instructions(tx);
    const push = (e) => out.push({ sig, slot, ts, idx: out.length, ...e });

    // --- Meteora DLMM: inner events (emit_cpi) + range from initialize_position* ---
    const dlmmRange = new Map();   // position -> {lowerBin, upperBin}
    for (const s of seq) {
      if (s.venue === 'meteora' && s.name && /^initialize_position/.test(s.name) && s.acc.position) {
        const lo = num(s.args.lower_bin_id ?? s.args.lowerBinId), w = num(s.args.width);
        if (lo != null && w != null) dlmmRange.set(s.acc.position, { lowerBin: lo, upperBin: lo + w - 1 });
      }
    }
    // rebalance_liquidity: the position stays, its liquidity is re-laid over new bins. The same tx
    // usually also carries remove_liquidity / add_liquidity on it (an automation's "move range"),
    // so all of them fold into ONE 'rebalance' event with the net flow — not a withdrawal.
    const rebal = new Map();   // position -> the folded event
    for (const s of seq) {
      if (s.venue !== 'meteora' || s.event?.name !== 'Rebalancing') continue;
      const d = s.event.data, pos = b58(pick(d, 'position'));
      const r = rebal.get(pos) || { w0: 0n, w1: 0n, d0: 0n, d1: 0n, f0: 0n, f1: 0n };
      r.pool = b58(pick(d, 'lb_pair', 'lbPair'));
      r.w0 += big(d.x_withdrawn_amount); r.w1 += big(d.y_withdrawn_amount);
      r.d0 += big(d.x_added_amount); r.d1 += big(d.y_added_amount);
      r.f0 += big(d.x_fee_amount); r.f1 += big(d.y_fee_amount);
      r.prevLower ??= num(d.old_min_id); r.prevUpper ??= num(d.old_max_id);
      r.lowerBin = num(d.new_min_id); r.upperBin = num(d.new_max_id); r.activeBin = num(d.active_bin_id);
      rebal.set(pos, r);
    }
    const seenClaim = new Set();
    for (const s of seq) {
      if (s.venue !== 'meteora' || !s.event) continue;
      const { name, data: d } = s.event;
      const pos = b58(pick(d, 'position')), pool = pick(d, 'lb_pair', 'lbPair') ? b58(pick(d, 'lb_pair', 'lbPair')) : null;
      const bin = pick(d, 'active_bin_id', 'activeBinId');
      if (name === 'PositionCreate') push({ venue: 'meteora', id: pos, pool, kind: 'open', ...(dlmmRange.get(pos) || {}) });
      else if ((name === 'AddLiquidity' || name === 'RemoveLiquidity') && rebal.has(pos)) {
        const r = rebal.get(pos), [a0 = 0n, a1 = 0n] = (d.amounts || []).map(big);
        if (name === 'AddLiquidity') { r.d0 += a0; r.d1 += a1; } else { r.w0 += a0; r.w1 += a1; }
      } else if (name === 'Rebalancing') {
        const r = rebal.get(pos);
        if (r.emitted) continue;
        r.emitted = true;
        // Placed here, after any claim earlier in the tx; flows from later instructions still
        // fold in because the object is shared until the loop ends.
        push({ venue: 'meteora', id: pos, pool: r.pool, kind: 'rebalance', activeBin: r.activeBin,
          lowerBin: r.lowerBin, upperBin: r.upperBin, prevLower: r.prevLower, prevUpper: r.prevUpper });
        r.ev = out[out.length - 1];
        // should_claim_fee: the claim rides inside the rebalance (no ClaimFee event of its own).
        if (r.f0 > 0n || r.f1 > 0n) push({ venue: 'meteora', id: pos, pool: r.pool, kind: 'collect', f0: r.f0, f1: r.f1, activeBin: r.activeBin, viaRebalance: true });
      } else if (name === 'AddLiquidity' || name === 'RemoveLiquidity') {
        const [a0, a1] = (d.amounts || []).map(big);
        push({ venue: 'meteora', id: pos, pool, kind: name === 'AddLiquidity' ? 'increase' : 'decrease', a0, a1, activeBin: num(bin), ...(dlmmRange.get(pos) || {}) });
      } else if (name === 'ClaimFee' || name === 'ClaimFee2') {
        // One claim emits ClaimFee AND ClaimFee2 with the same amounts — counted once.
        const f0 = big(pick(d, 'fee_x', 'feeX')), f1 = big(pick(d, 'fee_y', 'feeY'));
        const k = `${pos}:${f0}:${f1}`;
        if (seenClaim.has(k)) { if (bin != null) { const prev = out.find((e) => e.kind === 'collect' && e.id === pos && e.f0 === f0 && e.f1 === f1); if (prev) prev.activeBin = num(bin); } continue; }
        seenClaim.add(k);
        push({ venue: 'meteora', id: pos, pool, kind: 'collect', f0, f1, activeBin: bin != null ? num(bin) : null });
      } else if (name === 'PositionClose') push({ venue: 'meteora', id: pos, kind: 'close' });
    }

    for (const r of rebal.values()) {
      if (!r.ev) continue;
      // Net flow per token: positive = deposited into the position, negative = taken out of it.
      r.ev.a0 = r.d0 - r.w0; r.ev.a1 = r.d1 - r.w1;
      Object.assign(r.ev, { w0: r.w0, w1: r.w1, d0: r.d0, d1: r.d1 });
    }

    // --- Orca & Raydium: log events + instructions for what has no event ---
    const logs = this.logEvents(tx);
    const orcaIx = seq.filter((s) => s.venue === 'orca' && s.name);
    const rayIx = seq.filter((s) => s.venue === 'raydium' && s.name);
    for (const { venue, event } of logs.filter((x) => x.venue === 'orca')) {
      const d = event.data;
      const base = { venue, id: b58(d.position), pool: b58(d.whirlpool), tickLower: num(d.tick_lower_index), tickUpper: num(d.tick_upper_index) };
      if (event.name === 'PositionOpened') push({ ...base, kind: 'open' });
      else if (event.name === 'LiquidityIncreased' || event.name === 'LiquidityDecreased') {
        push({ ...base, kind: event.name === 'LiquidityIncreased' ? 'increase' : 'decrease', liq: big(d.liquidity), a0: big(d.token_a_amount), a1: big(d.token_b_amount) });
      }
    }
    // collect_fees(_v2): amount = the vault A/B transfers out that follow it
    for (let i = 0; i < seq.length; i++) {
      const s = seq[i];
      if (s.venue !== 'orca' || !s.name || !/^collect_fees/.test(s.name)) continue;
      let f0 = 0n, f1 = 0n;
      for (let j = i + 1; j < seq.length && !seq[j].name; j++) {
        const p = seq[j].raw?.parsed;
        if (!p || !/^transfer/.test(p.type || '')) continue;
        const amt = big(p.info.amount ?? p.info.tokenAmount?.amount);
        if (p.info.source === s.acc.token_vault_a) f0 += amt;
        else if (p.info.source === s.acc.token_vault_b) f1 += amt;
      }
      if (f0 || f1) push({ venue: 'orca', id: s.acc.position, pool: s.acc.whirlpool, kind: 'collect', f0, f1 });
    }
    for (const s of orcaIx) if (/^close_position/.test(s.name) && s.acc.position) push({ venue: 'orca', id: s.acc.position, kind: 'close' });

    // Raydium: Increase/Decrease/Collect are keyed by the position NFT mint → position PDA. Pool &
    // price from the LiquidityChange/LiquidityCalculate emitted right before.
    const rayOpen = rayIx.filter((s) => /^open_position/.test(s.name));
    let openK = 0, lastChange = null, lastCalc = null;
    const pdaOf = (mint) => R.getPdaPersonalPositionAddress(R.CLMM_PROGRAM_ID, new PublicKey(mint)).publicKey.toBase58();
    for (const { event } of logs.filter((x) => x.venue === 'raydium')) {
      const d = event.data;
      if (event.name === 'LiquidityChangeEvent') { lastChange = d; continue; }
      if (event.name === 'LiquidityCalculateEvent') { lastCalc = d; continue; }
      const sqrtX96 = lastCalc ? u.x64ToX96(lastCalc.pool_sqrt_price_x64) : null;
      const pool = lastChange ? b58(lastChange.pool_state) : null;
      if (event.name === 'CreatePersonalPositionEvent') {
        const ix = rayOpen[openK++];
        const id = ix?.acc?.personal_position || null;
        if (id) {
          const base = { venue: 'raydium', id, pool: b58(d.pool_state), tickLower: num(d.tick_lower_index), tickUpper: num(d.tick_upper_index) };
          push({ ...base, kind: 'open' });
          push({ ...base, kind: 'increase', liq: big(d.liquidity), a0: big(d.deposit_amount_0), a1: big(d.deposit_amount_1), sqrtX96 });
        }
      } else if (event.name === 'IncreaseLiquidityEvent') {
        push({ venue: 'raydium', id: pdaOf(b58(d.position_nft_mint)), pool, kind: 'increase', liq: big(d.liquidity), a0: big(d.amount_0), a1: big(d.amount_1), sqrtX96 });
      } else if (event.name === 'DecreaseLiquidityEvent') {
        push({ venue: 'raydium', id: pdaOf(b58(d.position_nft_mint)), pool, kind: 'decrease', liq: big(d.liquidity),
          a0: big(d.decrease_amount_0), a1: big(d.decrease_amount_1), f0: big(d.fee_amount_0), f1: big(d.fee_amount_1), sqrtX96 });
      } else if (event.name === 'CollectPersonalFeeEvent') {
        push({ venue: 'raydium', id: pdaOf(b58(d.position_nft_mint)), pool, kind: 'collect', f0: big(d.amount_0), f1: big(d.amount_1), sqrtX96 });
      }
      lastChange = null; lastCalc = null;
    }
    for (const s of rayIx) if (s.name === 'close_position' && s.acc.personal_position) push({ venue: 'raydium', id: s.acc.personal_position, kind: 'close' });
    return out;
  }

  // ---- assemble positions ------------------------------------------------------------
  // The price (sqrtX96) of one event: from the event when present, otherwise from the amount
  // composition within the tick range (v3 formula), otherwise from the nearest event of that position.
  static sqrtFromAmounts(L, a0, a1, tl, tu) {
    if (tl == null || tu == null) return null;
    const sa = m.getSqrtRatioAtTick(tl), sb = m.getSqrtRatioAtTick(tu);
    if (a0 > 0n && a1 === 0n) return sa;      // all token0: price below / at the lower edge of the range
    if (a1 > 0n && a0 === 0n) return sb;      // all token1: above the range
    if (!(L > 0n) || !(a1 > 0n)) return null;
    const p = sa + (a1 * m.Q96) / L;
    return p < sa ? sa : p > sb ? sb : p;
  }

  newPos(e) {
    return {
      venue: e.venue, id: e.id, pool: e.pool || null, tickLower: null, tickUpper: null, lowerBin: null, upperBin: null,
      sawOpen: false, sawClose: false, firstSlot: null, firstTs: null, lastSlot: null, lastTs: null,
      in0: 0n, in1: 0n, out0: 0n, out1: 0n, fee0: 0n, fee1: 0n, investedUsd: 0, returnedUsd: 0, feesUsd: 0,
      lastSqrt: null, events: [],
    };
  }

  apply(p, e, st, ethUsd) {
    p.pool ??= e.pool || null;
    if (e.tickLower != null) { p.tickLower = e.tickLower; p.tickUpper = e.tickUpper; }
    if (e.lowerBin != null) { p.lowerBin = e.lowerBin; p.upperBin = e.upperBin; }
    if (p.firstSlot == null || e.slot < p.firstSlot) { p.firstSlot = e.slot; p.firstTs = e.ts; }
    if (p.lastSlot == null || e.slot >= p.lastSlot) { p.lastSlot = e.slot; p.lastTs = e.ts; }
    if (e.kind === 'open') { p.sawOpen = true; return; }
    if (e.kind === 'close') { p.sawClose = true; return; }
    // event price
    let sqrt = e.sqrtX96 || null;
    if (!sqrt && e.activeBin != null && st?.binStep) sqrt = u.binSqrtX96(e.activeBin, st.binStep);
    if (!sqrt && (e.kind === 'increase' || e.kind === 'decrease')) sqrt = SolanaWalletResearch.sqrtFromAmounts(e.liq, e.a0 || 0n, e.a1 || 0n, p.tickLower, p.tickUpper);
    sqrt ||= p.lastSqrt || st?.sqrtX96 || null;
    if (sqrt) p.lastSqrt = sqrt;
    const usdOf = (x0, x1) => {
      if (!st || !sqrt) return null;
      const v = this.chain.valueInQuote({ sqrtPriceX96: sqrt, amount0: x0, amount1: x1, dec0: st.dec0, dec1: st.dec1, token0: st.token0, token1: st.token1 });
      return v ? v.value * (v.kind === 'eth' ? ethUsd : 1) : null;
    };
    const a0 = e.a0 || 0n, a1 = e.a1 || 0n, f0 = e.f0 || 0n, f1 = e.f1 || 0n;
    let valueUsd = null;
    if (e.kind === 'increase') {
      p.in0 += a0; p.in1 += a1; valueUsd = usdOf(a0, a1); p.investedUsd += valueUsd || 0;
    } else if (e.kind === 'rebalance') {
      // a0/a1 are net and signed: the part added counts as invested, the part taken as returned.
      const pos0 = a0 > 0n ? a0 : 0n, pos1 = a1 > 0n ? a1 : 0n, neg0 = a0 < 0n ? -a0 : 0n, neg1 = a1 < 0n ? -a1 : 0n;
      p.in0 += pos0; p.in1 += pos1; p.out0 += neg0; p.out1 += neg1;
      const inUsd = pos0 || pos1 ? usdOf(pos0, pos1) : 0, outUsd = neg0 || neg1 ? usdOf(neg0, neg1) : 0;
      p.investedUsd += inUsd || 0; p.returnedUsd += outUsd || 0;
      valueUsd = inUsd == null || outUsd == null ? null : inUsd - outUsd;
    } else if (e.kind === 'decrease' || e.kind === 'collect') {
      p.out0 += a0 + f0; p.out1 += a1 + f1; p.fee0 += f0; p.fee1 += f1;
      valueUsd = usdOf(a0 + f0, a1 + f1);
      p.returnedUsd += valueUsd || 0;
      p.feesUsd += usdOf(f0, f1) || 0;
    }
    p.events.push({ ...e, sqrt, valueUsd });
  }

  // The wallet's open positions now (all three venues). A venue that failed to read: null —
  // its positions must not read as "closed".
  async livePositions(wallet) {
    const out = new Map(), failed = new Set();
    for (const [venue, a] of Object.entries(this.chain.adapters)) {
      try { for (const p of await a.listPositions(wallet, (mm) => this.chain.decimalsMap(mm))) out.set(p.id, p); }
      catch (e) { failed.add(venue); this.log(`riset ${wallet.slice(0, 6)}…: posisi ${venue} tidak terbaca (${e.message})`); }
    }
    return { live: out, failed };
  }

  async build(wallet, txs, ethUsd, { base = new Map(), onProgress } = {}) {
    const evs = [];
    for (const t of txs) {
      try { evs.push(...this.extract(t)); } catch (e) { this.log(`riset: tx ${t.sig.slice(0, 8)} gagal dibaca: ${e.message}`); }
    }
    evs.sort((a, b) => a.slot - b.slot || a.idx - b.idx);
    const positions = base;
    const poolOf = new Map();
    const { live, failed } = await this.livePositions(wallet);
    // The pool of a position whose events carry no pool (Orca collect/close, Raydium
    // without LiquidityChange): from the live position or another event of the same position
    for (const e of evs) if (e.pool) poolOf.set(e.id, e.pool);
    for (const [id, p] of live) poolOf.set(id, p.pool);
    const pools = new Map();
    const poolState = async (venue, pool) => {
      if (!pool) return null;
      const k = `${venue}:${pool}`;
      if (!pools.has(k)) {
        const st = await this.chain.pool(venue, pool).catch(() => null);
        // both tokens' symbols must be in the tokens table (the dashboard reads from there)
        if (st) await this.chain.tokens([st.token0, st.token1]).catch(() => null);
        pools.set(k, st);
      }
      return pools.get(k);
    };
    let n = 0;
    for (const e of evs) {
      const p = positions.get(e.id) || positions.set(e.id, this.newPos(e)).get(e.id);
      p.pool ??= poolOf.get(e.id) || null;
      this.apply(p, e, await poolState(p.venue, p.pool), ethUsd);
      if (onProgress && ++n % 50 === 0) onProgress({ phase: 'posisi', scanned: n, total: evs.length });
    }
    // Positions still open but without events in this window (opened earlier)
    for (const [id, lp] of live) if (!positions.has(id)) positions.set(id, { ...this.newPos(lp), pool: lp.pool });
    for (const p of positions.values()) {
      const lp = live.get(p.id);
      p.st = await poolState(p.venue, p.pool);
      p.live = lp || null;
      p.status = lp ? 'open' : failed.has(p.venue) && !p.sawClose ? (p.status || 'open') : 'closed';
      if (lp) { p.tickLower = lp.tickLower; p.tickUpper = lp.tickUpper; }
      else if (p.venue === 'meteora' && p.lowerBin != null && p.st?.binStep) {
        ({ tickLower: p.tickLower, tickUpper: p.tickUpper } = u.binRangeToTicks(p.lowerBin, p.upperBin, p.st.binStep));
      }
      // No opening event in the window = its starting capital is unknown.
      p.incomplete = p.sawOpen || p.fromDb ? (p.incomplete || 0) : 1;
      // No longer live but no withdrawal/close event read (its transactions not read yet /
      // outside the window): the result is unknown — NOT booked
      // as a 100% loss.
      if (p.status === 'closed' && !p.sawClose && !p.events.some((e) => e.kind === 'decrease') && !(p.returnedUsd > 0)) p.incomplete = 1;
    }
    return positions;
  }

  // ---- store ---------------------------------------------------------------------
  async persist(wallet, positions, { fromSlot, head, ethUsd }) {
    // Token tracker results (proceeds) of unchanged closed positions are kept —
    // the INSERT OR REPLACE below deletes them, and re-tracking everything on every refresh
    // means re-reading dozens of transactions from public RPC.
    const tracked = new Map(this.store.all(`SELECT token_id, out0, out1, held_tok, sold_tok, realized_q, unrealized_q, pnl_q, tracked_to
      FROM wpositions WHERE chain=? AND wallet=? AND status='closed' AND tracked_to IS NOT NULL`, this.network, wallet).map((r) => [r.token_id, r]));
    for (const p of positions.values()) {
      if (!p.st) continue;   // pool unreadable: cannot be valued
      const q = this.chain.quoteSideOf(p.st.token0, p.st.token1);
      let liveUsd = 0, liveFeeUsd = 0, inRange = null;
      if (p.live && p.st.sqrtX96) {
        const v = (x0, x1) => { const r = this.chain.valueInQuote({ sqrtPriceX96: p.st.sqrtX96, amount0: x0, amount1: x1, dec0: p.st.dec0, dec1: p.st.dec1, token0: p.st.token0, token1: p.st.token1 }); return r ? r.value * (r.kind === 'eth' ? ethUsd : 1) : 0; };
        liveUsd = v(p.live.amount0, p.live.amount1); liveFeeUsd = v(p.live.fee0, p.live.fee1);
        inRange = p.st.tick >= p.tickLower && p.st.tick < p.tickUpper;
      }
      const invested = p.incomplete ? null : p.investedUsd;
      const pnl = invested == null ? null : p.returnedUsd + liveUsd + liveFeeUsd - invested;
      const closedTs = p.status === 'closed' ? p.lastTs : null;
      this.store.run(`INSERT OR REPLACE INTO wpositions
        (chain,wallet,venue,token_id,pool_ref,token0,token1,fee,tick_spacing,hooks,tick_lower,tick_upper,liquidity,
         in0,in1,out0,out1,fee0,fee1,invested_q,returned_q,fees_q,pnl_q,quote_symbol,
         opened_block,opened_ts,closed_block,closed_ts,status,events_n,incomplete,live_value_q,live_fee_q,in_range)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.network, wallet, p.venue, p.id, p.pool, p.st.token0, p.st.token1, p.st.fee ?? null, p.st.tickSpacing ?? null, null,
      p.tickLower, p.tickUpper, p.live ? String(p.live.liquidity) : '0',
      p.in0.toString(), p.in1.toString(), p.out0.toString(), p.out1.toString(), p.fee0.toString(), p.fee1.toString(),
      invested, p.returnedUsd, p.feesUsd, pnl, q?.symbol ?? null,
      p.firstSlot, p.firstTs, p.status === 'closed' ? p.lastSlot : null, closedTs, p.status, p.events.length + (p.eventsBefore || 0),
      p.incomplete ? 1 : 0, liveUsd, liveFeeUsd, inRange == null ? null : inRange ? 1 : 0);
      const t = tracked.get(p.id);
      if (t && p.status === 'closed' && t.out0 === p.out0.toString() && t.out1 === p.out1.toString()) {
        this.store.run('UPDATE wpositions SET held_tok=?, sold_tok=?, realized_q=?, unrealized_q=?, pnl_q=?, tracked_to=? WHERE chain=? AND wallet=? AND venue=? AND token_id=?',
          t.held_tok, t.sold_tok, t.realized_q, t.unrealized_q, invested == null ? null : t.pnl_q, t.tracked_to, this.network, wallet, p.venue, p.id);
      }
      p.events.forEach((e, k) => {
        const moved0 = e.kind === 'increase' || e.kind === 'rebalance' ? e.a0 || 0n : (e.a0 || 0n) + (e.f0 || 0n);
        const moved1 = e.kind === 'increase' || e.kind === 'rebalance' ? e.a1 || 0n : (e.a1 || 0n) + (e.f1 || 0n);
        this.store.run(`INSERT OR REPLACE INTO wevents
          (chain,wallet,token_id,block,ts,tx_hash,log_index,kind,liq_delta,amount0,amount1,princ0,princ1,fee0,fee1,sqrt_price,value_q)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.network, wallet, p.id, e.slot, e.ts, e.sig, e.idx * 1000 + k, e.kind === 'increase' && !p.events.slice(0, k).some((x) => x.kind === 'increase') && p.sawOpen ? 'mint' : e.kind,
        e.liq != null ? String(e.kind === 'decrease' ? -e.liq : e.liq) : null, moved0.toString(), moved1.toString(),
        (e.a0 || 0n).toString(), (e.a1 || 0n).toString(), (e.f0 || 0n).toString(), (e.f1 || 0n).toString(),
        e.sqrt ? e.sqrt.toString() : null, e.valueUsd);
      });
    }
    try { await this.proceeds.track(wallet, { head, ethUsd }); }
    catch (e) { this.log(`lacak hasil ${wallet.slice(0, 6)}…: ${e.message}`); }
    const stats = this.statsFromDb(wallet);
    this.store.run(`INSERT INTO wallets(chain,address,first_block,scanned_to,last_scan_ts,stats,positions_n) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET first_block=MIN(first_block,excluded.first_block), scanned_to=MAX(scanned_to,excluded.scanned_to),
        last_scan_ts=excluded.last_scan_ts, stats=excluded.stats, positions_n=excluded.positions_n`,
    this.network, wallet, fromSlot, head, Date.now(), JSON.stringify(stats), stats.positionsTotal);
    return stats;
  }

  stateKey(wallet) { return `sol_research:${this.network}:${wallet}`; }

  // ---- full scan ------------------------------------------------------------------
  async scan(wallet, { blocks = 900_000, ethUsd = 150, onProgress } = {}) {
    const sinceMs = Date.now() - blocks * WINDOW_BLOCK_MS;
    const head = await this.rpc.slot();
    if (onProgress) onProgress({ phase: 'tanda tangan', scanned: 0, total: 1 });
    const { sigs, capped } = await this.signatures(wallet, { sinceMs });
    const txs = await this.transactions(sigs, onProgress);
    const positions = await this.build(wallet, txs, ethUsd, { onProgress });
    // A full scan rebuilds: this wallet's old rows are replaced entirely.
    this.store.run('DELETE FROM wpositions WHERE chain=? AND wallet=?', this.network, wallet);
    this.store.run('DELETE FROM wevents WHERE chain=? AND wallet=?', this.network, wallet);
    const fromSlot = sigs.length ? sigs[sigs.length - 1].slot : head;
    const stats = await this.persist(wallet, positions, { fromSlot, head, ethUsd });
    this.store.setState(this.stateKey(wallet), JSON.stringify({ newest: sigs[0]?.signature || null, sinceMs, capped, pending: txs.missing }));
    if (txs.missing.length) this.log(`riset ${wallet.slice(0, 6)}…: ${txs.missing.length} transaksi belum tersedia — dibaca pada pembaruan berikutnya`);
    if (txs.oldUnread) this.log(`riset ${wallet.slice(0, 6)}…: ${txs.oldUnread} transaksi lama tidak terbaca dari RPC publik — posisinya ditandai tidak lengkap`);
    if (capped) this.log(`riset ${wallet.slice(0, 6)}…: dibatasi ${MAX_TX} transaksi terbaru — posisi yang lebih tua tidak lengkap`);
    return { wallet, positions: [...positions.values()], head, from: fromSlot, stats, txs: txs.length };
  }

  // ---- incremental refresh: only transactions since the last scan ------------------
  async refresh(wallet, { ethUsd = 150, onProgress } = {}) {
    let st = null;
    try { st = JSON.parse(this.store.getState(this.stateKey(wallet)) || 'null'); } catch { st = null; }
    if (!st) return this.scan(wallet, { ethUsd, onProgress });
    const head = await this.rpc.slot();
    const { sigs } = await this.signatures(wallet, { stopSig: st.newest, sinceMs: st.sinceMs });
    const pending = (st.pending || []).filter((sg) => !sigs.some((x) => x.signature === sg)).map((signature) => ({ signature }));
    const txs = await this.transactions([...sigs, ...pending], onProgress);
    // Events from pending transactions that turn out to be stored already are not doubled:
    // wevents is keyed (tx_hash, log_index) and the aggregate only adds new events.
    const known = new Set(this.store.all('SELECT DISTINCT tx_hash FROM wevents WHERE chain=? AND wallet=?', this.network, wallet).map((r) => r.tx_hash));
    const fresh = txs.filter((t) => !known.has(t.sig));
    fresh.missing = txs.missing;
    // Positions already stored are the base: new events are added to their aggregate.
    const base = new Map();
    for (const r of this.store.all('SELECT * FROM wpositions WHERE chain=? AND wallet=?', this.network, wallet)) {
      base.set(r.token_id, {
        ...this.newPos({ venue: r.venue, id: r.token_id, pool: r.pool_ref }), fromDb: true, status: r.status,
        tickLower: r.tick_lower, tickUpper: r.tick_upper, sawOpen: !r.incomplete, sawClose: r.status === 'closed',
        firstSlot: r.opened_block, firstTs: r.opened_ts, lastSlot: r.closed_block ?? r.opened_block, lastTs: r.closed_ts ?? r.opened_ts,
        in0: big(r.in0), in1: big(r.in1), out0: big(r.out0), out1: big(r.out1), fee0: big(r.fee0), fee1: big(r.fee1),
        investedUsd: r.invested_q || 0, returnedUsd: r.returned_q || 0, feesUsd: r.fees_q || 0, incomplete: r.incomplete,
        eventsBefore: r.events_n || 0,
      });
    }
    const positions = await this.build(wallet, fresh, ethUsd, { base, onProgress });
    const stats = await this.persist(wallet, positions, { fromSlot: null, head, ethUsd });
    this.store.setState(this.stateKey(wallet), JSON.stringify({ ...st, newest: sigs[0]?.signature || st.newest, pending: txs.missing }));
    return { wallet, positions: [...positions.values()], head, stats, refreshed: fresh.length };
  }

  // ---- open position value at the current price (Wallet/Pool/Token pages) ----------
  async refreshOpen(rows, ethUsd, { ttlMs = 15_000 } = {}) {
    const open = rows.filter((r) => r.status === 'open' && r.pool_ref && this.chain.adapters[r.venue]);
    const now = Date.now();
    const due = open.filter((r) => now - (this.liveCache.get(`${r.wallet}:${r.token_id}`) || 0) >= ttlMs);
    const byVenue = new Map();
    for (const r of due) (byVenue.get(r.venue) || byVenue.set(r.venue, []).get(r.venue)).push(r);
    for (const [venue, list] of byVenue) {
      let got;
      try { got = await this.chain.adapter(venue).getPositions(list.map((r) => ({ id: r.token_id, pool: r.pool_ref })), (mm) => this.chain.decimalsMap(mm)); }
      catch { continue; }
      for (const r of list) {
        const p = got.get(r.token_id);
        if (!p) continue;   // null = already closed; the next scan books it
        const st = await this.chain.pool(venue, r.pool_ref).catch(() => null);
        if (!st) continue;
        const v = (x0, x1) => { const q = this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0: x0, amount1: x1, dec0: st.dec0, dec1: st.dec1, token0: st.token0, token1: st.token1 }); return q ? q.value * (q.kind === 'eth' ? ethUsd : 1) : 0; };
        r.live_value_q = v(p.amount0, p.amount1); r.live_fee_q = v(p.fee0, p.fee1);
        r.pnl_q = r.invested_q == null ? null : r.live_value_q + r.live_fee_q + (r.returned_q || 0) - r.invested_q;
        r.in_range = st.tick >= r.tick_lower && st.tick < r.tick_upper ? 1 : 0;
        r.curTick = st.tick; r.liveTs = now;
        this.liveCache.set(`${r.wallet}:${r.token_id}`, now);
        this.store.run('UPDATE wpositions SET live_value_q=?, live_fee_q=?, pnl_q=?, in_range=? WHERE chain=? AND wallet=? AND token_id=?',
          r.live_value_q, r.live_fee_q, r.pnl_q, r.in_range, this.network, r.wallet, r.token_id);
      }
    }
  }
}

// Summary from the DB: exactly the EVM version (one formula for both chain kinds).
SolanaWalletResearch.prototype.statsFromDb = WalletResearch.prototype.statsFromDb;

module.exports = { SolanaWalletResearch, summarize, EVENT_IX_TAG };
