'use strict';
// Manual LP, manual swap, and "follow an action" for Solana. Dashboard routes & Telegram flows
// are the same as EVM (src/manual.js, inherited): only the parts that touch the chain are
// rewritten here —
//   pools     : scan a token's pools through DexScreener/GeckoTerminal, confirmed by the
//               owner of each account (the Meteora DLMM / Orca / Raydium CLMM programs)
//   plan      : range in equivalent ticks → the venue's native units (bins / ticks), token
//               amounts from VALUE (same as planner.js), not from v3 L
//   balances  : native SOL + wSOL merged, USDC/USDT; swaps through Jupiter
//   execution : the Solana engine.executeEntry & engine.swap — the same path as automatic
//               copying
// base58 addresses are CASE-SENSITIVE: never lower-cased.
const { Manual, ticksFromPct } = require('../manual');
const m = require('../v3math');
const u = require('./units');
const { planRange, quoteToUsd } = require('../policy');
const { share0, amountsForValue, CLMM_MAX_TICK } = require('./planner');
const { WSOL } = require('../networks');
const { resolveStrategy, shapeWeight, STRATEGIES } = require('./dlmm-shape');
const { poolStats } = require('./meteora-api');

const isBase58 = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(a || ''));
const str = (a) => String(a || '').trim();
const DLMM_MAX_BINS = 1400;

class SolanaManual extends Manual {
  // ---- pools ------------------------------------------------------------------------
  // A pool not recorded yet (address pasted from DexScreener): venue from its account owner,
  // then its state is read once — chain.pools also stores it in the table.
  async poolByRef(poolRef) {
    const ref = str(poolRef);
    if (!isBase58(ref)) return null;
    const row = this.store.get('SELECT venue, token0 FROM pools WHERE chain=? AND pool_ref=?', this.network, ref);
    if (!row?.token0 || !this.chain.isSolVenue(row.venue)) {
      const venue = await this.chain.venueOfPool(ref).catch(() => null);
      if (!venue) return null;
      if (!(await this.chain.pool(venue, ref, { maxAgeMs: 0 }).catch(() => null))) return null;
    }
    const p = await super.poolByRef(ref);
    if (p) p.poolAddr = ref;
    return p;
  }

  async addPrices(list) {
    await Promise.all(list.map(async (p) => {
      p.curTick = (await this.chain.slot0Of(p.poolRef).catch(() => null))?.tick ?? null;
    }));
    return list;
  }

  // CLMM/DLMM pools holding `token`. There is no "pool created" event that can be filtered
  // per token over public RPC (free endpoints refuse getProgramAccounts), so the candidate
  // list comes from the Meteora DLMM API + DexScreener + GeckoTerminal indexes, then each address
  // is confirmed by its account owner and its state read from the chain — the outside index only
  // points. Meteora also supplies the pool statistics (TVL, volume, fees, APR) for DLMM pools.
  async scanPools(token, { onProgress = () => {}, fetchImpl = globalThis.fetch } = {}) {
    const t = str(token);
    if (!isBase58(t)) throw new Error('alamat token Solana harus base58 (32–44 karakter)');
    const cand = new Map();   // address -> {createdAt, liquidityUsd}
    const meteoraStats = new Map();   // DLMM pool address -> poolStats()
    let ok = 0;
    const getJson = async (url) => {
      const r = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    };
    try {
      const j = await getJson(`https://api.dexscreener.com/token-pairs/v1/solana/${t}`);
      for (const p of Array.isArray(j) ? j : j.pairs || []) {
        if (!p?.pairAddress) continue;
        cand.set(p.pairAddress, { createdAt: Number(p.pairCreatedAt) || null, liquidityUsd: Number(p.liquidity?.usd) || null });
      }
      ok++;
    } catch (e) { this.log(`pindai pool ${t}: DexScreener ${e.message}`); }
    onProgress({ done: 1, total: 4 });
    try {
      const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${t}/pools?page=1`);
      for (const d of j.data || []) {
        const a = d.attributes?.address;
        if (!a) continue;
        const prev = cand.get(a) || {};
        cand.set(a, {
          createdAt: prev.createdAt ?? (Date.parse(d.attributes?.pool_created_at) || null),
          liquidityUsd: prev.liquidityUsd ?? (Number(d.attributes?.reserve_in_usd) || null),
        });
      }
      ok++;
    } catch (e) { this.log(`pindai pool ${t}: GeckoTerminal ${e.message}`); }
    onProgress({ done: 2, total: 4 });
    // Meteora's numbers are exact for DLMM pools: they win over the other indexes.
    try {
      const { pools } = await this.chain.meteora.pools({ query: t, sortBy: 'tvl:desc', pageSize: 100 });
      for (const mp of pools) {
        const prev = cand.get(mp.address) || {};
        cand.set(mp.address, { createdAt: mp.createdAt ?? prev.createdAt ?? null, liquidityUsd: mp.tvlUsd ?? prev.liquidityUsd ?? null });
        meteoraStats.set(mp.address, poolStats(mp));
      }
      ok++;
    } catch (e) { this.log(`pindai pool ${t}: Meteora ${e.message}`); }
    onProgress({ done: 3, total: 4 });
    if (!ok) throw new Error('indeks pool (Meteora, DexScreener & GeckoTerminal) tidak bisa dihubungi — coba lagi sebentar');
    if (!cand.size) return [];

    // Venue from the account's owner program: one getMultipleAccounts per 100 addresses.
    const { PublicKey } = require('@solana/web3.js');
    const addrs = [...cand.keys()].filter(isBase58);
    const byProgram = new Map(Object.values(this.chain.adapters).map((a) => [a.program, a.key]));
    const perVenue = new Map();
    for (let i = 0; i < addrs.length; i += 100) {
      const part = addrs.slice(i, i + 100);
      const infos = await this.rpc.run((c) => c.getMultipleAccountsInfo(part.map((a) => new PublicKey(a))));
      part.forEach((a, k) => {
        const v = byProgram.get(infos[k]?.owner?.toBase58());
        if (v) perVenue.set(v, [...(perVenue.get(v) || []), a]);
      });
    }
    const states = [];
    for (const [venue, list] of perVenue) {
      const got = await this.chain.pools(venue, list, { maxAgeMs: 0 }).catch(() => new Map());
      for (const st of got.values()) if (st && (st.token0 === t || st.token1 === t)) states.push(st);
    }
    onProgress({ done: 4, total: 4 });
    if (!states.length) return [];

    const metas = await this.chain.tokens([...new Set(states.flatMap((s) => [s.token0, s.token1]))]);
    const byAddr = new Map(metas.filter(Boolean).map((x) => [x.address, x]));
    return states.map((st) => {
      const c = cand.get(st.id) || {};
      const qs = this.chain.quoteSideOf(st.token0, st.token1);
      const s0 = byAddr.get(st.token0)?.symbol || '?', s1 = byAddr.get(st.token1)?.symbol || '?';
      const liq = st.liquidity != null ? BigInt(st.liquidity) : null;
      if (c.createdAt) {
        this.store.run('UPDATE pools SET first_ts=COALESCE(first_ts, ?) WHERE chain=? AND pool_ref=?', c.createdAt, this.network, st.id);
      }
      return {
        poolRef: st.id, poolAddr: st.id, venue: st.venue,
        token0: st.token0, token1: st.token1, fee: st.fee ?? null, tickSpacing: st.tickSpacing ?? null, hooks: null,
        firstBlock: c.createdAt || 0, createdAt: c.createdAt || null, liquidityUsd: c.liquidityUsd ?? null,
        pair: `${s0}/${s1}`, symbol0: s0, symbol1: s1,
        dec0: st.dec0 ?? byAddr.get(st.token0)?.decimals ?? 9, dec1: st.dec1 ?? byAddr.get(st.token1)?.decimals ?? 9,
        feePct: st.fee != null ? st.fee / 10000 : null, dynamicFee: false, hasHooks: false,
        quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null,
        stats: meteoraStats.get(st.id) || null,
        liquidity: liq != null ? String(liq) : null,
        kosong: liq != null ? liq === 0n || (c.liquidityUsd != null && c.liquidityUsd < 1) : null,
        enabled: st.enabled !== false,
      };
    }).sort((a, b) => (b.quoteSide != null) - (a.quoteSide != null)
      || (a.kosong === true) - (b.kosong === true)
      || (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  }

  // Other markets (plain Raydium/Pump/Meteora DAMM AMMs…) when there is no CLMM/DLMM pool.
  async otherMarket(token, fetchImpl = globalThis.fetch) {
    try {
      const r = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${str(token)}/pools?page=1`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const j = await r.json();
      const dexName = (id) => String(id || '?').replace(/-solana$/, '').split('-')
        .map((w) => (/^v\d$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
      return (j.data || []).slice(0, 5).map((d) => ({
        dex: dexName(d.relationships?.dex?.data?.id), dexId: d.relationships?.dex?.data?.id || null,
        name: d.attributes?.name || '?', address: d.attributes?.address || null,
        reserveUsd: Number(d.attributes?.reserve_in_usd) || 0,
      }));
    } catch { return null; }
  }

  // ---- manual LP plan --------------------------------------------------------------
  // Input & return shape as Manual.planLp. Extra: `native` = the venue's native range already
  // fixed (follow an action, exact mode: the target's bins/ticks as is).
  // strategy: Meteora DLMM shape (spot | curve | bidask); unset = the rules' choice, and
  // spot when that is 'mirror' (a manual LP has no target shape to follow).
  async planLp({ poolRef, usd, widthPct = 25, lowerPct = null, upperPct = null, tickLower = null, tickUpper = null, full = false,
    pool = null, target = null, ranged = false, native = null, strategy = null }) {
    const eng = this.engine;
    const p = pool || await this.poolByRef(poolRef);
    if (!p) return { error: 'pool tidak dikenal — tempel alamat pool Meteora DLMM / Orca / Raydium CLMM, atau pindai dari alamat token' };
    if (!this.chain.isSolVenue(p.venue)) return { error: `venue ${p.venue} tidak didukung di Solana` };
    if (p.quoteSide == null) return { error: `pasangan ${p.pair} tidak punya aset kuotasi yang dikenal (${Object.values(this.chain.QUOTES).map((x) => x.symbol).join('/')})` };
    const rules = eng.rulesFrom(target);
    const raw = await this.chain.pool(p.venue, p.poolRef, { maxAgeMs: 0 }).catch(() => null);
    const st = raw ? { ...raw, symbol0: p.symbol0, symbol1: p.symbol1 } : null;
    if (!st || st.sqrtX96 == null) return { error: 'harga pool tidak terbaca sekarang' };
    if (st.enabled === false) return { error: 'pool ini sedang dinonaktifkan programnya' };
    const fee = st.fee ?? p.fee;
    if (fee != null && fee > rules.filters.max_fee_bps) {
      return { error: `fee pool ${(fee / 10000).toFixed(2)}% di atas batas ${(rules.filters.max_fee_bps / 10000).toFixed(2)}%. Ubah "Batas fee pool" di Aturan kalau memang disengaja.` };
    }
    const nominal = Number(usd);
    if (!Number.isFinite(nominal) || nominal <= 0) return { error: 'nominal harus angka lebih dari nol' };
    const ad = this.chain.adapter(p.venue);
    const cur = st.tick;

    // 1) range in equivalent ticks (exactly as EVM), then to the venue's native units
    let singleSide = null;
    if (!native && !full && tickLower == null && tickUpper == null && (lowerPct != null || upperPct != null)) {
      const r = ticksFromPct({ curTick: cur, quoteSide: p.quoteSide, lowerPct, upperPct });
      if (r.error) return r;
      ({ tickLower, tickUpper } = r);
      if (Number(lowerPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token0' : 'token1';
      else if (Number(upperPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token1' : 'token0';
    }
    let lower, upper;
    if (native) {
      ({ lower, upper } = native);
    } else {
      let tl, tu;
      const actLike = { tickLower: tickLower ?? cur, tickUpper: tickUpper ?? cur, tickSpacing: st.tickSpacing };
      if (ranged && tickLower != null && tickUpper != null) ({ tickLower: tl, tickUpper: tu } = planRange(rules, actLike, cur));
      else if (tickLower != null && tickUpper != null) { tl = Math.min(tickLower, tickUpper); tu = Math.max(tickLower, tickUpper); }
      else {
        // Full range: DLMM is capped at 1400 bins per position, CLMM by the program's tick bounds.
        if (full && p.venue === 'meteora') {
          const half = Math.floor(DLMM_MAX_BINS / 2) - 1;
          ({ tickLower: tl, tickUpper: tu } = ad.ticksOf(st, st.current - half, st.current + half));
        } else if (full) { tl = -CLMM_MAX_TICK; tu = CLMM_MAX_TICK; }
        else ({ tickLower: tl, tickUpper: tu } = planRange({ ...rules, range: { ...rules.range, mode: 'width_pct', width_pct: widthPct } }, actLike, cur));
      }
      ({ lower, upper } = ad.nativeRange(st, tl, tu));
    }
    // One-sided: the bound near the price moves away from it so the second token is not needed.
    if (p.venue === 'meteora') {
      if (singleSide === 'token0') { lower = Math.max(lower, st.current + 1); upper = Math.max(upper, lower); }
      if (singleSide === 'token1') { upper = Math.min(upper, st.current - 1); lower = Math.min(lower, upper); }
      if (upper - lower + 1 > DLMM_MAX_BINS) return { error: `rentang ${upper - lower + 1} bin melebihi batas posisi DLMM (${DLMM_MAX_BINS}) — persempit rentangnya` };
    } else {
      const sp = st.spacing;
      if (singleSide === 'token0') { lower = Math.max(lower, m.alignTick(cur + 1, sp, 'up')); upper = Math.max(upper, lower + sp); }
      if (singleSide === 'token1') { upper = Math.min(upper, m.alignTick(cur, sp, 'down')); lower = Math.min(lower, upper - sp); }
      const lim = Math.floor(CLMM_MAX_TICK / sp) * sp;
      lower = Math.max(-lim, lower); upper = Math.min(lim, upper);
      if (upper <= lower) return { error: 'rentang kosong sesudah dibulatkan ke tick spacing' };
    }
    const { tickLower: tl, tickUpper: tu } = ad.ticksOf(st, lower, upper);
    if (strategy != null && strategy !== '' && !STRATEGIES.includes(strategy)) return { error: `strategi harus salah satu dari ${STRATEGIES.join(', ')}` };
    const shape = p.venue === 'meteora' ? resolveStrategy(strategy || rules.range.dlmm_strategy, null) : null;

    // 2) token amounts from value (see planner.js)
    const q = this.chain.quoteSideOf(st.token0, st.token1);
    const quoteAmt = q.kind === 'eth' ? nominal / eng.ethUsd : nominal;
    const side = m.sideOfRange(cur, tl, tu);
    let { amount0, amount1 } = amountsForValue(st, q, quoteAmt, share0(p.venue, st, tl, tu, lower, upper, shape || 'spot'));
    if (side === 'token0_only') amount1 = 0n;
    if (side === 'token1_only') amount0 = 0n;
    const est = this.chain.valueInQuote({ sqrtPriceX96: st.sqrtX96, amount0, amount1, dec0: st.dec0, dec1: st.dec1, token0: st.token0, token1: st.token1 });
    if (!est || !(est.value > 0)) return { error: 'nominal terlalu kecil untuk rentang ini' };
    const valueUsd = quoteToUsd(est.value, q.kind, eng.ethUsd);
    const slip = BigInt(rules.swap.max_slippage_bps);
    const pad = (x) => (x * (10000n + slip)) / 10000n;

    const plan = {
      venue: p.venue, action: 'mint', poolRef: st.id, poolKey: null,
      token0: st.token0, token1: st.token1, fee, tickSpacing: st.tickSpacing,
      tickLower: tl, tickUpper: tu, lower, upper, binStep: st.binStep ?? null, strategy: shape,
      liquidity: '0',
      amount0: amount0.toString(), amount1: amount1.toString(),
      amount0Max: pad(amount0).toString(), amount1Max: pad(amount1).toString(),
      valueQuote: est.value, quoteSymbol: q.symbol, quoteKind: q.kind, quoteSide: q.side,
      valueUsd, side, singleSide,
      mirrorOf: null, target: target ?? null, manual: true,
      curTick: cur, slippageBps: rules.swap.max_slippage_bps,
    };

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
    if (valueUsd < s.min_quote_usd) warnings.push(`di bawah minimum biasa ($${s.min_quote_usd}) — biaya transaksi bisa memakan porsi besar`);
    if (side !== 'both') warnings.push('posisi satu sisi — fee baru diperoleh saat harga masuk rentang');
    if (fee != null && fee >= 30000) warnings.push(`fee pool ${(fee / 10000).toFixed(2)}% — tinggi, hanya sepadan kalau ramai`);
    if (p.venue === 'meteora' && upper - lower + 1 > 70) warnings.push(`rentang ${upper - lower + 1} bin — posisi DLMM lebar butuh sewa akun lebih besar (dikembalikan saat ditutup)`);

    const bal = await eng.exec.balances();
    const px = await this.usdPrices(st);
    const { walletCashUsd } = this.fromBalance(bal, st, px);
    const avail = (t) => eng.availOf(bal, t);
    const funded = avail(st.token0) >= amount0 && avail(st.token1) >= amount1;
    if (!funded && walletCashUsd < valueUsd) return { error: `kas cuma $${walletCashUsd.toFixed(2)}, butuh ~$${valueUsd.toFixed(2)}` };
    if (!funded && walletCashUsd < valueUsd * 1.02) warnings.push('kas nyaris pas — sisakan sedikit untuk biaya dan slippage');

    const sim = this.simulateSwap({ st, plan, bal, rules, px });
    warnings.push(...sim.problems);

    const rasio = (t) => (p.quoteSide === 1 ? 1.0001 ** (t - cur) : 1.0001 ** (cur - t));
    const [tHargaBawah, tHargaAtas] = p.quoteSide === 1 ? [tl, tu] : [tu, tl];
    return {
      plan,
      warnings,
      preview: {
        lowerPct: (1 - rasio(tHargaBawah)) * 100, upperPct: (rasio(tHargaAtas) - 1) * 100,
        pair: p.pair, venue: p.venue, feePct: fee != null ? fee / 10000 : null, dynamicFee: false,
        symbol0: p.symbol0, symbol1: p.symbol1, dec0: st.dec0, dec1: st.dec1, quoteSide: p.quoteSide,
        tickLower: tl, tickUpper: tu, curTick: cur,
        nativeLower: lower, nativeUpper: upper, nativeUnit: p.venue === 'meteora' ? 'bin' : 'tick', activeBin: p.venue === 'meteora' ? st.current : null,
        strategy: shape,
        distribution: shape ? this.distribution(lower, upper, st.current, st.binStep, shape) : null,
        valueUsd, amount0: amount0.toString(), amount1: amount1.toString(),
        side, hasHooks: false, walletCashUsd,
        swaps: sim.step, router: 'Jupiter',
        swapOn: !!rules.swap.enabled, slippageBps: rules.swap.max_slippage_bps,
        saldo: this.fromBalance(bal, st, px, sim.after),
      },
    };
  }

  // Relative value per bin of a planned DLMM position, for the dashboard's shape preview.
  // The SDK lays out the real amounts; the weights are the same ones the planner splits
  // X/Y with. Bins above the active bin hold token0 only, below token1 only.
  distribution(lower, upper, active, binStep, strategy) {
    const n = Math.max(Math.abs(lower - active), Math.abs(upper - active), 1);
    const bins = [];
    for (let b = lower; b <= upper; b++) bins.push([b, shapeWeight(strategy, Math.abs(b - active), n)]);
    const max = Math.max(...bins.map((x) => x[1]));
    return { binStep, active, bins: bins.map(([b, w]) => [b, w / max]) };
  }

  // ---- balances & swap simulation -----------------------------------------------------
  gasReserve() { return this.engine.exec.gasReserveCached(); }

  // USD price per one token: Jupiter for pool tokens, quote assets from their own rule.
  async usdPrices(st) {
    const mints = [...new Set([WSOL, this.chain.ADDR.usdg, this.chain.ADDR.usdt, ...(st ? [st.token0, st.token1] : [])])];
    const px = await this.chain.jup.prices(mints).catch(() => new Map());
    const out = new Map(px);
    for (const [a, q] of Object.entries(this.chain.QUOTES)) out.set(a, q.kind === 'eth' ? this.engine.ethUsd : 1);
    // Pool tokens Jupiter does not know: from the pool price against its quote asset.
    if (st) {
      const qs = this.chain.quoteSideOf(st.token0, st.token1);
      if (qs) {
        const p = u.priceFromSqrtX96(st.sqrtX96, st.dec0, st.dec1);   // token1 per token0
        const qUsd = out.get(qs.side === 0 ? st.token0 : st.token1);
        if (qs.side === 1 && !out.get(st.token0)) out.set(st.token0, p * qUsd);
        if (qs.side === 0 && !out.get(st.token1) && p > 0) out.set(st.token1, qUsd / p);
      }
    }
    return out;
  }

  balanceList(st) {
    return [...new Set([WSOL, this.chain.ADDR.usdg, this.chain.ADDR.usdt, ...(st ? [st.token0, st.token1] : [])])];
  }

  // Raw amount held for one mint; SOL = native + wSOL (one money).
  rawOf(bal, t) { return t === WSOL ? (bal.get('SOL') || 0n) + (bal.get(WSOL) || 0n) : bal.get(t) || 0n; }

  kaki(tok, raw, st, px) {
    const q = this.chain.QUOTES[tok];
    const dec = q?.decimals ?? (st && tok === st.token0 ? st.dec0 : st && tok === st.token1 ? st.dec1 : 9);
    const symbol = tok === WSOL ? 'SOL' : q?.symbol ?? (st && tok === st.token0 ? st.symbol0 : st && tok === st.token1 ? st.symbol1 : null)
      ?? this.store.get('SELECT symbol FROM tokens WHERE chain=? AND address=?', this.network, tok)?.symbol ?? '?';
    const amount = Number(raw) / 10 ** dec;
    const usdPer = px?.get(tok);
    return { token: tok, symbol, amount, usd: usdPer != null ? amount * usdPer : null };
  }

  fromBalance(bal, st, px, after = null) {
    const tokens = this.balanceList(st).map((t) => {
      const row = { ...this.kaki(t, this.rawOf(bal, t), st, px), isQuote: !!this.chain.QUOTES[t], native: t === WSOL };
      if (after) {
        const s = this.kaki(t, this.rawOf(after, t), st, px);
        row.after = s.amount; row.afterUsd = s.usd;
      }
      return row;
    });
    const walletCashUsd = tokens.filter((x) => x.isQuote).reduce((a, x) => a + (x.usd || 0), 0);
    const reserve = Number(this.gasReserve()) / 1e9;
    return { tokens, walletCashUsd, gasReserveEth: reserve, gasReserve: reserve, nativeSymbol: 'SOL' };
  }

  async saldo(poolRef) {
    const eng = this.engine;
    const p = poolRef ? await this.poolByRef(poolRef) : null;
    const raw = p ? await this.chain.pool(p.venue, p.poolRef).catch(() => null) : null;
    const st = raw ? { ...raw, symbol0: p.symbol0, symbol1: p.symbol1 } : null;
    const [bal, px] = await Promise.all([eng.exec.balances(), this.usdPrices(st)]);
    return { ...this.fromBalance(bal, st, px), wallet: !!eng.exec.address() };
  }

  /**
   * Imitates the swap steps of SolanaEngine.executeEntry on top of the current balances,
   * WITHOUT sending anything: top up gas (USDC→SOL when SOL is below half the reserve), then
   * buy each side's shortfall through Jupiter, from the pool's quote asset first, then other cash.
   * The formulas are copied from there — if executeEntry changes, this must change too.
   */
  simulateSwap({ st, plan, bal, rules, px }) {
    const eng = this.engine;
    const s = new Map(bal);
    const get = (t) => this.rawOf(s, t);
    // SOL is added/removed through the native key: availOf sums both.
    const add = (t, x) => {
      if (t === WSOL) s.set('SOL', (s.get('SOL') || 0n) + x);
      else s.set(t, (s.get(t) || 0n) + x);
    };
    const step = [], problems = [];
    const record = (kind, a, x, b, y, extra = {}) => {
      step.push({ jenis: kind, dari: this.kaki(a, x, st, px), ke: this.kaki(b, y, st, px), router: 'Jupiter', ...extra });
      add(a, -x); add(b, y);
    };
    const fmt = (t, raw) => { const k = this.kaki(t, raw, st, px); return `${k.amount.toPrecision(4)} ${k.symbol}`; };
    const slip = rules.swap.max_slippage_bps;

    // 0. top up gas (engine.topUpGas)
    const reserve = this.gasReserve();
    const sol = s.get('SOL') || 0n;
    if (sol * 2n < reserve) {
      const wantUsd = Math.min(Number(eng.cfg.gas?.topup_max_usd ?? 25), (Number(reserve - sol) / 1e9) * eng.ethUsd * 1.03);
      const pay = BigInt(Math.ceil(wantUsd * 1e6));
      if (pay >= 1_000_000n && get(this.chain.ADDR.usdg) >= pay) {
        record('jembatan', this.chain.ADDR.usdg, pay, WSOL, BigInt(Math.floor((wantUsd / eng.ethUsd) * 1e9)), { gas: true, estimate: true, maxLossBps: 300 });
      }
    }

    // 1. buy each side's shortfall
    const q = this.chain.quoteSideOf(plan.token0, plan.token1);
    const quoteMint = q.side === 0 ? plan.token0 : plan.token1;
    for (const [mint, want] of [[plan.token0, BigInt(plan.amount0)], [plan.token1, BigInt(plan.amount1)]]) {
      const have = eng.availOf(s, mint);
      if (want <= have) continue;
      const short = want - have;
      const p = px.get(mint);
      if (!rules.swap.enabled) { problems.push(`kurang ${fmt(mint, short)} dan tukar otomatis dimatikan — pembukaan akan berhenti`); continue; }
      if (!p) { problems.push(`harga ${fmt(mint, short).split(' ').pop()} tidak diketahui Jupiter — tidak bisa dibeli otomatis`); continue; }
      const dec = mint === st.token0 ? st.dec0 : st.dec1;
      const usd = (Number(short) / 10 ** dec) * p * (1 + (slip + 50) / 10_000);
      const src = eng.fundSource(s, usd, mint === quoteMint ? null : quoteMint);
      if (!src) { problems.push(`kas tidak cukup untuk membeli ${fmt(mint, short)} (~$${usd.toFixed(2)})`); continue; }
      const zap = src[0] === plan.token0 || src[0] === plan.token1;
      record(zap ? 'zap' : 'jembatan', src[0], src[1], mint, short, { maxLossBps: rules.swap.max_price_impact_bps, estimate: true });
    }

    // 2. deposit into the position
    add(plan.token0, -BigInt(plan.amount0));
    add(plan.token1, -BigInt(plan.amount1));
    for (const [t, v] of s) if (typeof v === 'bigint' && v < 0n) s.set(t, 0n);
    return { step, problems, after: s };
  }

  // ---- follow an action -----------------------------------------------------------------
  poolFromAction(a, toks) {
    const p = super.poolFromAction(a, toks);
    return { ...p, poolAddr: a.pool_ref, hooks: null, hasHooks: false, dynamicFee: false };
  }

  // Exact mode: the target's native bins/ticks are used as is (from the action's ext), the same
  // as automatic copying. Other modes: planRange from the target's equivalent ticks.
  async planFollow({ actionId, usd }) {
    const c = await this.followContext(actionId);
    if (c.error) return c;
    const nominal = usd != null && usd !== '' ? Number(usd) : c.info.suggestUsd;
    let ext = {};
    try { ext = JSON.parse(c.a.ext || '{}') || {}; } catch { ext = {}; }
    const exact = c.rules.range.mode === 'exact' && ext.lower != null && ext.upper != null;
    const r = await this.planLp({
      pool: this.poolFromAction(c.a, c.toks), poolRef: c.a.pool_ref, usd: nominal,
      tickLower: c.a.tick_lower, tickUpper: c.a.tick_upper, ranged: true, target: c.a.target,
      native: exact ? { lower: Number(ext.lower), upper: Number(ext.upper) } : null,
      strategy: c.a.venue === 'meteora' ? resolveStrategy(c.rules.range.dlmm_strategy, ext.strategy) : null,
    });
    if (r.error) return { ...r, follow: c.info };
    r.plan.mirrorOf = c.a.token_id;
    r.plan.targetRange = [c.a.tick_lower, c.a.tick_upper];
    r.plan.targetValueUsd = c.info.targetUsd;
    return { ...r, follow: { ...c.info, usd: nominal } };
  }

  // ---- manual swap ----------------------------------------------------------------------
  customTokens() {
    try {
      const v = JSON.parse(this.store.getState(this.sk('swap_tokens'), '[]'));
      return Array.isArray(v) ? v.map(str).filter(isBase58) : [];
    } catch { return []; }
  }
  addCustomToken(a) {
    const t = str(a);
    const list = this.customTokens().filter((x) => x !== t);
    this.store.setState(this.sk('swap_tokens'), JSON.stringify([t, ...list].slice(0, 50)));
  }
  removeCustomToken(a) {
    this.store.setState(this.sk('swap_tokens'), JSON.stringify(this.customTokens().filter((x) => x !== str(a))));
  }

  // All the wallet's token accounts are already read by exec.balances (getParsedTokenAccountsByOwner),
  // so there is no need to scan the transfer history like on EVM.
  async seenTokens() { return []; }

  async held() {
    const eng = this.engine;
    const set = new Set([WSOL, this.chain.ADDR.usdg, this.chain.ADDR.usdt]);
    const custom = new Set(this.customTokens());
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE chain=? AND status='open'", this.network)) {
      if (r.token0) set.add(r.token0);
      if (r.token1) set.add(r.token1);
    }
    for (const it of eng.leftovers()) if (it.token) set.add(it.token);
    for (const a of custom) set.add(a);
    const bal = eng.exec.address() ? await eng.exec.balances() : new Map();
    for (const [k, v] of bal) if (k !== 'SOL' && isBase58(k) && v > 0n) set.add(k);
    const list = [...set];
    const metas = await this.chain.tokens(list).catch(() => []);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [t.address, t]));
    return list.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = this.rawOf(bal, a);
      const dec = meta.decimals ?? this.chain.QUOTES[a]?.decimals ?? 9;
      return {
        address: a, symbol: a === WSOL ? 'SOL' : meta.symbol || this.chain.QUOTES[a]?.symbol || a.slice(0, 6), decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!this.chain.QUOTES[a], native: a === WSOL, custom: custom.has(a) && !this.chain.QUOTES[a],
      };
    })
      // Position NFTs (0 decimals) are not tradable tokens
      .filter((x) => x.decimals > 0 || x.custom)
      .sort((x, y) => (y.isQuote ? 1 : 0) - (x.isQuote ? 1 : 0) || y.amount - x.amount);
  }

  // The same parse as amountRaw WITHOUT the balance check (the swap page still quotes an
  // amount above the balance, with the button disabled). SOL = native + wSOL minus the reserve.
  async amountInfo(token, input) {
    const tok = str(token);
    const h = (await this.held()).find((x) => x.address === tok);
    const dec = h?.decimals ?? 9;
    const bal = BigInt(h?.raw || '0');
    const reserve = this.gasReserve();
    const maxVal = tok === WSOL ? (bal > reserve ? bal - reserve : 0n) : bal;
    const symbol = h?.symbol || '';
    const out = (raw) => ({ raw, maxVal, dec, symbol });
    const t = String(input).trim().toLowerCase();
    if (t === 'semua' || t === 'all' || t === 'max') return out(maxVal);
    const percent = t.match(/^([\d.,]+)\s*%$/);
    if (percent) {
      const f = Number(percent[1].replace(',', '.'));
      if (!Number.isFinite(f) || f <= 0 || f > 100) throw new Error('persen harus antara 0 dan 100');
      return out((maxVal * BigInt(Math.round(f * 100))) / 10000n);
    }
    const n = Number(t.replace(/[^\d.,-]/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) throw new Error('jumlah harus angka, "semua", atau persen (mis. 50%)');
    const [ip, fp = ''] = n.toFixed(Math.min(dec, 12)).split('.');
    return out(BigInt(ip) * 10n ** BigInt(dec) + BigInt((fp + '0'.repeat(dec)).slice(0, dec) || '0'));
  }

  async amountRaw(token, input) {
    const { raw, maxVal, dec, symbol } = await this.amountInfo(token, input);
    if (raw > maxVal) throw new Error(`saldo cuma ${(Number(maxVal) / 10 ** dec).toPrecision(6)} ${symbol}`.trim());
    return raw;
  }

  // Manual.doSwap with the mint as-is for the lock (base58 is case-sensitive): the automatic
  // leftover sale locks the same key, so the two never sell the same balance at once.
  async doSwap({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (eng.stopping) throw new Error('bot sedang berhenti (restart) — coba lagi sebentar');
    eng.selling = eng.selling || new Set();
    const lockKey = str(tokenIn);
    if (eng.selling.has(lockKey)) throw new Error('token ini sedang dijual otomatis — tunggu sebentar');
    eng.selling.add(lockKey);
    try { return await this.doSwapLocked({ tokenIn, tokenOut, amountRaw }); }
    finally { eng.selling.delete(lockKey); }
  }

  async quoteSwap({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    const ti = str(tokenIn), to = str(tokenOut);
    if (ti === to) return { error: 'token masuk dan keluar sama' };
    if (!amountRaw || BigInt(amountRaw) <= 0n) return { error: 'jumlah nol' };
    const rules = eng.rulesFrom(null);
    const [mi, mo] = await this.chain.tokens([ti, to]);
    const all = await this.chain.router.quoteAll(ti, to, BigInt(amountRaw), { slippageBps: rules.swap.max_slippage_bps });
    const best = all.find((r) => r.state === 'ok');
    if (!best) return { error: `Jupiter tidak menemukan rute: ${all.map((r) => `${r.label}: ${r.error}`).join('; ')}` };
    const px = await this.chain.jup.prices([ti, to]).catch(() => new Map());
    const amountIn = Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 9);
    const maxLoss = rules.exit.sell_max_loss_bps;
    const usdInOf = px.get(ti) ? amountIn * px.get(ti) : null;
    const routes = all.map((r) => {
      if (r.state !== 'ok') return { id: r.id, label: r.label, state: 'noroute', blocker: r.error, ms: r.ms, best: false };
      const amountOut = Number(r.out) / 10 ** (mo.decimals ?? 9);
      const usdOut = px.get(to) ? amountOut * px.get(to) : null;
      const lossBps = usdInOf && usdOut ? Math.round(((usdInOf - usdOut) / usdInOf) * 10_000) : null;
      const dex = [...new Set((r.q.routePlan || []).map((p) => p.swapInfo?.label).filter(Boolean))].join(' → ') || r.label;
      return { id: r.id, label: r.label, state: 'ok', blocker: null, ms: r.ms, dex, amountOut, usdIn: usdInOf, usdOut,
        lossBps, tooLossy: lossBps != null && lossBps > maxLoss, best: r === best,
        priceImpactPct: r.q.priceImpactPct != null ? Number(r.q.priceImpactPct) * 100 : null };
    });
    const chosen = routes.find((r) => r.best);
    return {
      symbolIn: ti === WSOL ? 'SOL' : mi.symbol, symbolOut: to === WSOL ? 'SOL' : mo.symbol,
      amountIn, amountOut: chosen.amountOut, usdIn: usdInOf, usdOut: chosen.usdOut, lossBps: chosen.lossBps,
      dex: chosen.dex, router: chosen.label, priceImpactPct: chosen.priceImpactPct,
      maxLossBps: maxLoss, slippageBps: rules.swap.max_slippage_bps, tooLossy: chosen.tooLossy,
      // Same shape as the EVM multi-aggregator quote.
      aggregator: 'auto', chosen: chosen.id, chosenLabel: chosen.label, routes,
    };
  }

  async doSwapLocked({ tokenIn, tokenOut, amountRaw }) {
    const eng = this.engine;
    const ti = str(tokenIn), to = str(tokenOut);
    const rules = eng.rulesFrom(null);
    const [mi, mo] = await this.chain.tokens([ti, to]);
    const symIn = ti === WSOL ? 'SOL' : mi.symbol, symOut = to === WSOL ? 'SOL' : mo.symbol;
    const amountIn = Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 9);
    const r = await eng.swap(ti, to, BigInt(amountRaw), {
      slippageBps: rules.swap.max_slippage_bps, maxLossBps: rules.exit.sell_max_loss_bps, kind: 'swap_manual',
    });
    const amountOut = Number(r.out) / 10 ** (mo.decimals ?? 9);
    try {
      eng.positions.recordTokenSale({ token: ti, amount: BigInt(amountRaw), quoteToken: to,
        txHash: r.hash, amountOut: r.out, usdOut: r.usdOut, ethUsd: eng.ethUsd });
    } catch (e) { this.store.log('warn', `catat hasil jual sisa: ${e.message}`, { quiet: true }); }
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', r.hash);
      const d = row?.detail ? JSON.parse(row.detail) : {};
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({
        ...d, tokenIn: ti, tokenOut: to, symbolIn: symIn, symbolOut: symOut, amountIn, amountOut,
      }), r.hash);
    } catch { /* history only — the swap was already sent */ }
    const note = `${amountIn.toPrecision(6)} ${symIn} → ${amountOut.toPrecision(6)} ${symOut}`;
    eng.notify(`swap manual: ${note}`);
    return { txHash: r.hash, amountOut: r.out.toString(), note, dex: 'Jupiter' };
  }
}

module.exports = { SolanaManual, isBase58 };
