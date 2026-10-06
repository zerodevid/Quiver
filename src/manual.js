'use strict';
const { ensureChain } = require('./networks');
// Manual LP and manual swap.
//
// Both use the SAME execution path as automatic copying:
// `engine.executeEntry` to open a position (including the cash bridge, zap, allowances,
// re-locking the amount at the current price, and recording the position) and
// `engine.kyber.swap` to exchange assets. This module only prepares the plan —
// there is no second transaction-sending path to maintain.
//
// A position opened here is stored with a NULL target. The consequence is deliberate:
// `reconcileExits` skips it (there is no target to follow out), but the
// standalone exit rules (stop loss / take profit / age / out of range) STILL
// apply if set — those are rules over our own position.
const { ethers } = require('ethers');
const m = require('./v3math');
const { TOPIC } = require('./chain');
const { planRange, valueOfLiquidity, usdToQuote, quoteToUsd } = require('./policy');

const isNative = (t) => /^0x0{40}$/.test(String(t).toLowerCase());
const lc = (t) => String(t || '').toLowerCase();

// Uniswap v4 uses the top bit of uint24 as the DYNAMIC FEE marker, not a fee
// number. Without this, a pool marked dynamic reads "838.86%" — a figure that never
// existed and makes the scan result list look full of traps.
const DYNAMIC_FEE = 0x800000;
const SEEN_STEP = 500_000;            // blocks per wallet token scan step
const EMPTY_RECHECK_MS = 10 * 60_000;  // a token with a zero balance is re-read at most every 10 minutes

// "Down to X%, up to Y%" from the current price -> raw ticks (not yet
// rounded to spacing). The percentages are in the PRICE AS SEEN by the user: the token in
// the quote asset. That price rises with the tick if the quote is token1, and FALLS
// if the quote is token0 — there the price's lower bound becomes the tick's UPPER bound.
// A negative value moves the bound to the other side of the price: lowerPct −10 = lower bound 10%
// ABOVE the price, upperPct −10 = upper bound 10% BELOW the price. That way
// a one-sided range does not have to stick to the current price (e.g. −30% … −10%).
function ticksFromPct({ curTick, quoteSide, lowerPct, upperPct }) {
  const lo = Number(lowerPct ?? 0), up = Number(upperPct ?? 0);
  if (!Number.isFinite(lo) || lo >= 100) return { error: 'batas bawah harus di atas −100% — turun 100% berarti harga nol' };
  if (!Number.isFinite(up) || up <= -100 || up > 100000) return { error: 'batas atas harus di atas −100% dan maksimal +100.000%' };
  if (lo === 0 && up === 0) return { error: 'rentangnya kosong — isi batas bawah atau batas atas' };
  if (lo + up <= 0) return { error: 'batas atas harus lebih tinggi dari batas bawah' };
  const LN = Math.log(1.0001);
  const dDown = Math.log(1 - lo / 100) / LN;   // <= 0 except a lower bound above the price
  const dUp = Math.log(1 + up / 100) / LN;    // >= 0 except an upper bound below the price
  const [a, b] = quoteSide === 1 ? [curTick + dDown, curTick + dUp] : [curTick - dUp, curTick - dDown];
  return { tickLower: Math.floor(a), tickUpper: Math.ceil(b) };
}
// ---- layered ("ladder") entry ----------------------------------------------
// One budget spread over several adjacent single-sided ranges BELOW the price: the
// nearest layer sits just under the price, each next one lies deeper. A layer holds only
// the quote asset until the price falls into it, so the deeper the price goes the more of
// the budget is turned into the token, at a lower average price. `method` sets how the
// budget is weighted from the nearest layer to the deepest one.
const LADDER_METHODS = {
  equal: () => 1,
  linear: (i) => i + 1,           // 1, 2, 3, …
  grow15: (i) => 1.5 ** i,        // 1, 1.5, 2.25, …
  double: (i) => 2 ** i,          // 1, 2, 4, …
};
const LADDER_MIN_LAYERS = 2, LADDER_MAX_LAYERS = 10;

// topPct / bottomPct: how far BELOW the price the top of the nearest layer and the bottom
// of the deepest layer are (positive numbers, top < bottom < 100). Layers split that span
// into equal steps in price ratio. Each layer comes out in planLp's convention:
// lowerPct = percent below the price, upperPct = signed (negative = below the price).
function ladderLayers({ usd, topPct = 0, bottomPct, layers, method = 'linear' }) {
  const top = Number(topPct), bottom = Number(bottomPct), n = Number(layers), total = Number(usd);
  if (!Number.isFinite(total) || total <= 0) return { error: 'nominal harus angka lebih dari nol' };
  if (!Number.isInteger(n) || n < LADDER_MIN_LAYERS || n > LADDER_MAX_LAYERS) return { error: `jumlah layer harus ${LADDER_MIN_LAYERS}–${LADDER_MAX_LAYERS}` };
  if (!LADDER_METHODS[method]) return { error: 'metode layer tidak dikenal' };
  if (!Number.isFinite(top) || top < 0 || !Number.isFinite(bottom) || bottom >= 100) return { error: 'batas layer harus di antara 0% dan 100% di bawah harga' };
  if (bottom <= top) return { error: 'batas terdalam harus lebih jauh di bawah harga daripada batas teratas' };
  const rTop = 1 - top / 100, rBot = 1 - bottom / 100;
  const edge = (i) => rTop * (rBot / rTop) ** (i / n);
  const w = Array.from({ length: n }, (_, i) => LADDER_METHODS[method](i));
  const wSum = w.reduce((a, b) => a + b, 0);
  const cents = w.map((x) => Math.floor((total * x / wSum) * 100));
  cents[n - 1] += Math.round(total * 100) - cents.reduce((a, b) => a + b, 0);   // rounding remainder -> deepest
  return {
    layers: Array.from({ length: n }, (_, i) => ({
      n: i + 1, usd: cents[i] / 100,
      lowerPct: (1 - edge(i + 1)) * 100, upperPct: (edge(i) - 1) * 100,
    })),
  };
}
function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} dtk`;
  if (s < 3600) return `${Math.round(s / 60)} mnt`;
  const j = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return m ? `${j} jam ${m} mnt` : `${j} jam`;
}
// Solana venues (src/solana/manual.js) — their actions can be followed by hand too.
const SOL_VENUES = new Set(['meteora', 'orca', 'raydium']);
const dynamicFeeVal = (f) => f != null && (Number(f) & DYNAMIC_FEE) !== 0;
const feePctOf = (f) => (f == null || dynamicFeeVal(f) ? null : Number(f) / 10000);

class Manual {
  constructor({ engine, store, chain, rpc, log }) {
    chain = ensureChain(chain);
    this.engine = engine; this.store = store; this.chain = chain; this.rpc = rpc;
    this.network = chain.network;
    this.log = log || (() => {});
  }
  sk(name) { return `${name}:${this.network}`; }

  // ---- list of known pools -------------------------------------------
  // The source is pools already seen while monitoring targets, so the user does not
  // need to look up a poolId themselves. Ordered from the most recently active.
  async pools({ q = '', limit = 40, withPrice = false } = {}) {
    const rows = this.store.all(`
      SELECT p.*, t0.symbol s0, t0.decimals d0, t1.symbol s1, t1.decimals d1,
             (SELECT MAX(ts) FROM actions a WHERE a.chain = p.chain AND a.pool_ref = p.pool_ref) last_ts
      FROM pools p
      LEFT JOIN tokens t0 ON t0.chain = p.chain AND t0.address = p.token0
      LEFT JOIN tokens t1 ON t1.chain = p.chain AND t1.address = p.token1
      WHERE p.chain=?
      ORDER BY COALESCE(last_ts, 0) DESC, p.first_block DESC`, this.network);
    const search = String(q).trim().toLowerCase();
    const out = [];
    for (const r of rows) {
      const pair = `${r.s0 || '?'}/${r.s1 || '?'}`;
      if (search && !pair.toLowerCase().includes(search) && !lc(r.pool_ref).includes(search)) continue;
      const qs = this.chain.quoteSideOf(r.token0, r.token1);
      out.push({
        poolRef: r.pool_ref, venue: r.venue, pair, symbol0: r.s0 || '?', symbol1: r.s1 || '?',
        dec0: r.d0 ?? 18, dec1: r.d1 ?? 18,
        token0: r.token0, token1: r.token1, fee: r.fee, feePct: feePctOf(r.fee), dynamicFee: dynamicFeeVal(r.fee),
        tickSpacing: r.tick_spacing, hooks: r.hooks,
        hasHooks: !!(r.hooks && !/^0x0+$/i.test(r.hooks)),
        quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null,
        lastTs: r.last_ts || null,
      });
      if (out.length >= limit) break;
    }
    if (withPrice) await this.addPrices(out);
    return out;
  }

  async addPrices(list) {
    const v4 = list.filter((p) => p.venue === 'v4');
    if (!v4.length) return list;
    try {
      const slots = await this.chain.slot0V4Many(v4.map((p) => p.poolRef));
      v4.forEach((p, i) => { p.curTick = slots[i]?.tick ?? null; });
    } catch { /* the price is not required to pick a pool */ }
    return list;
  }

  async poolByRef(poolRef) {
    const r = this.store.get('SELECT * FROM pools WHERE chain=? AND pool_ref=?', this.network, poolRef);
    if (!r) return null;
    const [t0, t1] = await this.chain.tokens([r.token0, r.token1]);
    const qs = this.chain.quoteSideOf(r.token0, r.token1);
    return {
      poolRef: r.pool_ref, venue: r.venue, token0: r.token0, token1: r.token1,
      fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks, poolAddr: r.pool_addr,
      symbol0: t0.symbol, symbol1: t1.symbol, dec0: t0.decimals, dec1: t1.decimals,
      pair: `${t0.symbol}/${t1.symbol}`, feePct: feePctOf(r.fee), dynamicFee: dynamicFeeVal(r.fee),
      hasHooks: !!(r.hooks && !/^0x0+$/i.test(r.hooks)),
      quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null, quoteKind: qs?.kind || null,
    };
  }

  // ---- scan pools from a token address ---------------------------------------
  /**
   * Find every Uniswap v4 AND v3 pool containing a token, straight from the chain.
   *
   * The v4 Initialize event indexes BOTH currencies, so a pool can be found from
   * its token side without first knowing its fee/tickSpacing/hooks:
   *   Initialize(PoolId indexed id, Currency indexed c0, Currency indexed c1,
   *              uint24 fee, int24 tickSpacing, IHooks hooks, uint160 sqrtP, int24 tick)
   * The rest is in data, with the same layout already used by pools.js.
   *
   * The full range is tried once first — the query is already topic-filtered, so the result is
   * small and the official endpoint can handle it. If refused, fall back to chunks.
   */
  async scanPools(token, { onProgress = () => {} } = {}) {
    const t = lc(token);
    if (!/^0x[0-9a-f]{40}$/.test(t)) throw new Error('alamat token harus 0x diikuti 40 karakter hex');
    const head = await this.rpc.blockNumber();
    const pad = (a) => '0x' + a.replace(/^0x/, '').padStart(64, '0');
    const hex = (n) => '0x' + Math.max(0, n).toString(16);
    const found = new Map();

    const word = (l, i) => BigInt(ethers.hexlify(ethers.getBytes(l.data).slice(i * 32, i * 32 + 32)));
    const addrT = (x) => ('0x' + x.slice(-40)).toLowerCase();
    const serapV4 = (logs) => {
      for (const l of logs) {
        found.set(l.topics[1], {
          poolRef: l.topics[1], venue: 'v4',
          token0: addrT(l.topics[2]), token1: addrT(l.topics[3]),
          fee: Number(word(l, 0)),
          tickSpacing: Number(BigInt.asIntN(24, word(l, 1))),
          hooks: '0x' + ethers.hexlify(ethers.getBytes(l.data).slice(2 * 32 + 12, 3 * 32)).slice(2),
          firstBlock: parseInt(l.blockNumber, 16),
        });
      }
    };
    // Uniswap v3: PoolCreated(address indexed token0, address indexed token1,
    // uint24 indexed fee, int24 tickSpacing, address pool) on the factory contract.
    // A v3 pool is referenced by its contract ADDRESS (poolRef = pool), the same as in
    // the copy path.
    const serapV3 = (logs, venue = 'v3') => {
      for (const l of logs) {
        const pool = ('0x' + word(l, 1).toString(16).padStart(40, '0')).toLowerCase();
        found.set(pool, {
          poolRef: pool, poolAddr: pool, venue,
          token0: addrT(l.topics[1]), token1: addrT(l.topics[2]),
          fee: Number(BigInt(l.topics[3])),
          tickSpacing: Number(BigInt.asIntN(24, word(l, 0))),
          hooks: null,
          firstBlock: parseInt(l.blockNumber, 16),
        });
      }
    };

    // The token can be on either side (order is determined by address value), so each
    // venue is queried twice. v4 indexes both currencies in topics 2 & 3; v3 in 1 & 2.
    // Each v3 venue (Uniswap v3, and PancakeSwap v3 on BSC) has its own factory.
    const factories = [];
    for (const v of this.chain.venues) {
      try { factories.push([v.key, await this.chain.factoryV3(v.npmV3)]); } catch { /* skip this venue, v4 keeps working */ }
    }
    const query = [
      [this.chain.ADDR.poolManager, [TOPIC.initializeV4, null, pad(t), null], serapV4],
      [this.chain.ADDR.poolManager, [TOPIC.initializeV4, null, null, pad(t)], serapV4],
      ...factories.flatMap(([venue, factory]) => [
        [factory, [TOPIC.poolCreatedV3, pad(t), null], (logs) => serapV3(logs, venue)],
        [factory, [TOPIC.poolCreatedV3, null, pad(t)], (logs) => serapV3(logs, venue)],
      ]),
    ];
    // An endpoint that limits the getLogs range (public BSC: 5000 blocks) cannot
    // scan from genesis — the window is limited to the last ~1 million blocks, cut to its
    // limit. Without a limit (Robinhood: ordofi/Alchemy): 400 thousand blocks per chunk.
    const limit = this.rpc.maxLogSpan?.() || 0;
    const CHUNK = limit ? Math.min(400_000, limit) : 400_000;
    const floor = limit ? Math.max(0, head - 1_000_000) : 0;
    const potong = Math.ceil((head - floor) / CHUNK);
    const total = potong * query.length;
    let step = 0;
    for (const [address, topics, serap] of query) {
      try {
        if (limit) throw new Error('rentang dibatasi');   // directly per chunk
        serap(await this.rpc.getLogs({ address, topics, fromBlock: '0x0', toBlock: hex(head) }));
        step += potong;
        onProgress({ done: step, total });
        continue;
      } catch { /* endpoint rejects a range that large: fall back to chunks */ }
      for (let hi = head; hi > floor;) {
        const lo = Math.max(floor, hi - CHUNK);
        try {
          serap(await this.rpc.getLogs({ address, topics, fromBlock: hex(lo), toBlock: hex(hi) }));
        } catch { /* one chunk failed: do not fail the whole scan */ }
        step++;
        onProgress({ done: step, total });
        if (lo === 0) break;
        hi = lo - 1;
      }
    }

    const list = [...found.values()];
    if (!list.length) return [];

    // Store so this pool also appears in the ordinary list from now on, and fetch its
    // token metadata (the name is used everywhere).
    for (const p of list) {
      this.store.run(
        `INSERT INTO pools(chain,pool_ref,venue,token0,token1,fee,tick_spacing,hooks,pool_addr,first_block)
         VALUES(?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(chain,pool_ref) DO UPDATE SET
           token0=excluded.token0, token1=excluded.token1, fee=excluded.fee,
           tick_spacing=excluded.tick_spacing, hooks=excluded.hooks,
           pool_addr=COALESCE(excluded.pool_addr, pools.pool_addr),
           first_block=COALESCE(pools.first_block, excluded.first_block)`,
        this.network, p.poolRef, p.venue, p.token0, p.token1, p.fee, p.tickSpacing, p.hooks, p.poolAddr || null, p.firstBlock);
    }
    const metas = await this.chain.tokens([...new Set(list.flatMap((p) => [p.token0, p.token1]))]);
    const byAddr = new Map(metas.map((m) => [lc(m.address), m]));

    // Liquidity is read so an empty pool can be flagged — a pool that was created
    // then abandoned is not rare, and entering it is just throwing away gas.
    let liq = [];
    try {
      liq = await Promise.all(list.map((p) => (this.chain.isV3Venue(p.venue)
        ? this.rpc.ethCallMany([{ to: p.poolRef, data: '0x1a686502' }])   // liquidity()
          .then(([w]) => (w && w !== '0x' ? BigInt(w) : null)).catch(() => null)
        : this.chain.poolLiquidity(p.poolRef).catch(() => null))));
    } catch { liq = []; }

    return list.map((p, i) => {
      const qs = this.chain.quoteSideOf(p.token0, p.token1);
      const s0 = byAddr.get(p.token0)?.symbol || '?';
      const s1 = byAddr.get(p.token1)?.symbol || '?';
      return {
        ...p, pair: `${s0}/${s1}`, symbol0: s0, symbol1: s1,
        dec0: byAddr.get(p.token0)?.decimals ?? 18, dec1: byAddr.get(p.token1)?.decimals ?? 18,
        feePct: feePctOf(p.fee), dynamicFee: dynamicFeeVal(p.fee),
        hasHooks: !!(p.hooks && !/^0x0+$/i.test(p.hooks)),
        quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null,
        liquidity: liq[i] != null ? String(liq[i]) : null,
        kosong: liq[i] != null ? BigInt(liq[i]) === 0n : null,
      };
    }).sort((a, b) => (b.quoteSide != null) - (a.quoteSide != null)
      || (a.kosong === true) - (b.kosong === true)
      || b.firstBlock - a.firstBlock);
  }

  // A token with no Uniswap v3/v4 pool that can be entered is usually still
  // traded elsewhere (e.g. Pons V2 — a v2-style pool with no price range).
  // Rather than just "no pool", say where — the data comes from GeckoTerminal.
  async otherMarket(token, fetchImpl = globalThis.fetch) {
    try {
      const r = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/${lc(token)}/pools?page=1`,
        { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return null;
      const j = await r.json();
      const nameVal = (id) => String(id || '?').replace(/-robinhood$/, '').split('-')
        .map((w) => (/^v\d$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
      return (j.data || []).slice(0, 5).map((d) => ({
        dex: nameVal(d.relationships?.dex?.data?.id), dexId: d.relationships?.dex?.data?.id || null,
        name: d.attributes?.name || '?', address: d.attributes?.address || null,
        reserveUsd: Number(d.attributes?.reserve_in_usd) || 0,
      }));
    } catch { return null; }
  }

  // ---- manual LP plan --------------------------------------------------
  /**
   * Build a mint plan from the user's choices, using the same rules engine as
   * automatic copying to compute the range and value the position.
   * Returns { error } or { plan, preview, warnings }.
   */
  // `pool` (optional): an already-built pool descriptor (the poolByRef shape) — used by
  // followPlan for a pool not yet in the pools table. `target`: that target's rules
  // are used, and `ranged` = the tick range is computed via that rule's planRange
  // (mode exact/recenter/scale…) from the given ticks, exactly the automatic copy path.
  async planLp({ poolRef, usd, widthPct = 25, lowerPct = null, upperPct = null, tickLower = null, tickUpper = null, full = false,
    pool = null, target = null, ranged = false }) {
    const eng = this.engine;
    const p = pool || await this.poolByRef(poolRef);
    if (!p) return { error: 'pool tidak dikenal — pilih dari daftar atau pantau dulu targetnya' };
    if (p.quoteSide == null) return { error: `pasangan ${p.pair} tidak punya aset kuotasi yang dikenal (USDG/ETH/WETH)` };

    const rules = eng.rulesFrom(target);
    if (p.hasHooks && !rules.filters.allow_hooks) {
      return { error: `pool ini memakai hook ${String(p.hooks).slice(0, 10)}… — hook bisa mengunci penarikan. Nyalakan "Izinkan pool ber-hook" di Aturan kalau memang disengaja.` };
    }
    if (dynamicFeeVal(p.fee)) {
      return { error: `pool ini memakai fee dinamis (ditentukan hook-nya saat transaksi berjalan) — tidak bisa dinilai di muka` };
    }
    if (p.fee != null && p.fee > rules.filters.max_fee_bps) {
      return { error: `fee pool ${(p.fee / 10000).toFixed(2)}% di atas batas ${(rules.filters.max_fee_bps / 10000).toFixed(2)}%. Ubah "Batas fee pool" di Aturan kalau memang disengaja.` };
    }
    const notional = Number(usd);
    if (!Number.isFinite(notional) || notional <= 0) return { error: 'nominal harus angka lebih dari nol' };

    const slot0 = this.chain.isV3Venue(p.venue)
      ? await this.chain.slot0V3(p.poolAddr || p.poolRef)
      : await this.chain.slot0V4(p.poolRef);
    if (!slot0) return { error: 'harga pool tidak terbaca sekarang' };

    let singleSide = null;
    // A bound at the current price (0%) or across it means one side. Rounding
    // a bound near the price must move away from the price, so spacing does not
    // introduce a need for the second token.
    if (!full && tickLower == null && tickUpper == null && (lowerPct != null || upperPct != null)) {
      const r = ticksFromPct({ curTick: slot0.tick, quoteSide: p.quoteSide, lowerPct, upperPct });
      if (r.error) return r;
      ({ tickLower, tickUpper } = r);
      if (Number(lowerPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token0' : 'token1';
      else if (Number(upperPct ?? 0) <= 0) singleSide = p.quoteSide === 1 ? 'token1' : 'token0';
    }

    // Range: computed by the same planRange as the automatic path.
    const actLike = {
      venue: p.venue, token0: p.token0, token1: p.token1, fee: p.fee,
      tickSpacing: p.tickSpacing, hooks: p.hooks, poolRef: p.poolRef,
      tickLower: tickLower ?? slot0.tick, tickUpper: tickUpper ?? slot0.tick,
    };
    let range;
    if (ranged && tickLower != null && tickUpper != null) {
      range = planRange(rules, actLike, slot0.tick);
    } else if (tickLower != null && tickUpper != null) {
      const sp = p.tickSpacing || 60;
      range = {
        tickLower: m.alignTick(Math.min(tickLower, tickUpper), sp, 'down'),
        tickUpper: m.alignTick(Math.max(tickLower, tickUpper), sp, 'up'),
        tickSpacing: sp,
      };
      if (range.tickUpper <= range.tickLower) range.tickUpper = range.tickLower + sp;
      if (singleSide === 'token0') {
        range.tickLower = Math.max(range.tickLower, m.alignTick(slot0.tick + 1, sp, 'up'));
        range.tickUpper = Math.max(range.tickUpper, range.tickLower + sp);
      } else if (singleSide === 'token1') {
        range.tickUpper = Math.min(range.tickUpper, m.alignTick(slot0.tick, sp, 'down'));
        range.tickLower = Math.min(range.tickLower, range.tickUpper - sp);
      }
    } else {
      range = planRange({ ...rules, range: { ...rules.range, mode: full ? 'full' : 'width_pct', width_pct: widthPct } }, actLike, slot0.tick);
    }

    if (!Number.isInteger(range.tickLower) || !Number.isInteger(range.tickUpper)
      || range.tickLower < m.MIN_TICK || range.tickUpper > m.MAX_TICK) return { error: 'rentang melewati batas tick Uniswap' };

    // Liquidity worth exactly `amount` dollars, derived from a single
    // reference measurement — position value is linear in L over the same range.
    const wantQuote = usdToQuote(notional, p.quoteKind, eng.ethUsd);
    const Lref = 10n ** 18n;
    const ref = valueOfLiquidity(this.chain, actLike, Lref, range.tickLower, range.tickUpper, slot0, p.dec0, p.dec1);
    if (!ref.value || ref.value <= 0) return { error: 'tidak bisa menilai posisi di rentang ini' };
    const L = (Lref * BigInt(Math.round(wantQuote * 1e9))) / BigInt(Math.round(ref.value * 1e9));
    if (L <= 0n) return { error: 'nominal terlalu kecil untuk rentang ini' };

    const est = valueOfLiquidity(this.chain, actLike, L, range.tickLower, range.tickUpper, slot0, p.dec0, p.dec1);
    const valueUsd = quoteToUsd(est.value || 0, p.quoteKind, eng.ethUsd);
    const slip = BigInt(rules.swap.max_slippage_bps);
    const pad = (x) => (x * (10000n + slip)) / 10000n;
    const side = m.sideOfRange(slot0.tick, range.tickLower, range.tickUpper);

    const plan = {
      venue: p.venue, action: 'mint',
      poolRef: p.poolRef,
      poolKey: p.venue === 'v4'
        ? { currency0: p.token0, currency1: p.token1, fee: p.fee, tickSpacing: range.tickSpacing, hooks: p.hooks }
        : null,
      token0: p.token0, token1: p.token1, fee: p.fee, tickSpacing: range.tickSpacing,
      tickLower: range.tickLower, tickUpper: range.tickUpper,
      liquidity: L.toString(),
      amount0: est.amount0.toString(), amount1: est.amount1.toString(),
      amount0Max: pad(est.amount0).toString(), amount1Max: pad(est.amount1).toString(),
      valueQuote: est.value, quoteSymbol: p.quoteSymbol, quoteKind: p.quoteKind, quoteSide: p.quoteSide,
      valueUsd, side, singleSide,
      mirrorOf: null, target: target ?? null, manual: true,
      curTick: slot0.tick,
    };

    // Limits the user already set are still honoured: a manual command can have a
    // typo too. The message names which limit so it is clear what to change.
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
    if (valueUsd < s.min_quote_usd) warnings.push(`di bawah minimum biasa ($${s.min_quote_usd}) — biaya gas bisa memakan porsi besar`);
    if (side !== 'both') warnings.push('posisi satu sisi — fee baru diperoleh saat harga masuk rentang');
    if (p.fee != null && p.fee >= 30000) warnings.push(`fee pool ${(p.fee / 10000).toFixed(2)}% — tinggi, hanya sepadan kalau ramai`);

    // Cash: executeEntry can bridge ETH<->USDG, so what is checked is the total value.
    // The pool's pair token is read too: what is already held shrinks the zap.
    const bal = await eng.exec.balances(this.balanceList(p));
    const { walletCashUsd } = this.fromBalance(bal, p, slot0);
    const available = (t) => {
      const raw = bal.get(lc(t)) || 0n;
      return isNative(t) ? (raw > this.gasReserve() ? raw - this.gasReserve() : 0n) : raw;
    };
    const funded = available(p.token0) >= BigInt(plan.amount0Max) && available(p.token1) >= BigInt(plan.amount1Max);
    if (!funded && walletCashUsd < valueUsd) return { error: `kas cuma $${walletCashUsd.toFixed(2)}, butuh ~$${valueUsd.toFixed(2)}` };
    if (!funded && walletCashUsd < valueUsd * 1.02) warnings.push('kas nyaris pas — sisakan sedikit untuk gas dan slippage');

    const sim = this.simulateSwap({ p, plan, slot0, bal, rules });
    warnings.push(...sim.problems);

    // The effective percent after rounding to tick spacing, in the price seen by the
    // user — "−10%" can become −10.4% in a wide-spacing pool.
    const ratio = (t) => (p.quoteSide === 1 ? 1.0001 ** (t - slot0.tick) : 1.0001 ** (slot0.tick - t));
    const [tPriceLower, tPriceUpper] = p.quoteSide === 1 ? [range.tickLower, range.tickUpper] : [range.tickUpper, range.tickLower];
    const lowerPctEff = (1 - ratio(tPriceLower)) * 100, upperPctEff = (ratio(tPriceUpper) - 1) * 100;

    return {
      plan,
      warnings,
      preview: {
        lowerPct: lowerPctEff, upperPct: upperPctEff,
        pair: p.pair, venue: p.venue, feePct: p.feePct, dynamicFee: p.dynamicFee,
        symbol0: p.symbol0, symbol1: p.symbol1, dec0: p.dec0, dec1: p.dec1, quoteSide: p.quoteSide,
        tickLower: range.tickLower, tickUpper: range.tickUpper, curTick: slot0.tick,
        valueUsd, amount0: est.amount0.toString(), amount1: est.amount1.toString(),
        side, hasHooks: p.hasHooks, walletCashUsd,
        swaps: sim.step,
        swapOn: !!rules.swap.enabled, slippageBps: rules.swap.max_slippage_bps,
        saldo: this.fromBalance(bal, p, slot0, sim.after),
      },
    };
  }

  // Plans every layer of a ladder (see ladderLayers) without sending anything. The limits
  // planLp checks per position are also checked for the whole ladder: the open-position
  // count, total exposure and cash.
  async planLadder({ poolRef, usd, topPct = 0, bottomPct, layers, method = 'linear' }) {
    const spec = ladderLayers({ usd, topPct, bottomPct, layers, method });
    if (spec.error) return spec;
    const eng = this.engine;
    const rules = eng.rulesFrom(null);
    const sum = eng.positions.summary(eng.ethUsd);
    const n = spec.layers.length;
    if (sum.openCount + n > rules.filters.max_open_positions) {
      return { error: `${n} layer butuh ${n} posisi, tapi sudah ada ${sum.openCount} terbuka (batas ${rules.filters.max_open_positions}).` };
    }
    if (sum.exposureUsd + Number(usd) > rules.sizing.max_total_exposure_usd) {
      return { error: `total eksposur jadi $${(sum.exposureUsd + Number(usd)).toFixed(2)}, melebihi batas $${rules.sizing.max_total_exposure_usd}.` };
    }
    const out = [], warnings = new Set();
    let first = null;
    for (const l of spec.layers) {
      const d = await this.planLp({ poolRef, usd: l.usd, lowerPct: l.lowerPct, upperPct: l.upperPct });
      if (d.error) return { error: `layer ${l.n}: ${d.error}` };
      first ||= d.preview;
      for (const w of d.warnings) warnings.add(w);
      out.push({ ...l, valueUsd: d.preview.valueUsd, tickLower: d.preview.tickLower, tickUpper: d.preview.tickUpper,
        lowerPctEff: d.preview.lowerPct, upperPctEff: d.preview.upperPct });
    }
    const totalUsd = out.reduce((a, l) => a + l.valueUsd, 0);
    if (first.walletCashUsd < totalUsd) return { error: `kas cuma $${first.walletCashUsd.toFixed(2)}, butuh ~$${totalUsd.toFixed(2)} untuk ${n} layer` };
    if (first.walletCashUsd < totalUsd * 1.02) warnings.add('kas nyaris pas — sisakan sedikit untuk gas dan slippage');
    // Several mints cost several gas fees; the layers are small, so it can matter.
    warnings.add(`${n} posisi terpisah — tiap layer = satu transaksi mint dan satu biaya gas`);
    return {
      layers: out, warnings: [...warnings], method,
      preview: { pair: first.pair, venue: first.venue, feePct: first.feePct, symbol0: first.symbol0, symbol1: first.symbol1,
        dec0: first.dec0, dec1: first.dec1, quoteSide: first.quoteSide, curTick: first.curTick,
        walletCashUsd: first.walletCashUsd, totalUsd },
    };
  }

  // Opens a ladder layer by layer, nearest first. Each layer is planned again right before
  // its mint (fresh price and balances) and the run stops at the first failure: what was
  // opened stays open and is reported. onProgress({ done, total, note }) after each layer.
  async openLadder({ poolRef, usd, topPct = 0, bottomPct, layers, method = 'linear' }, onProgress = () => {}) {
    const spec = ladderLayers({ usd, topPct, bottomPct, layers, method });
    if (spec.error) return { error: spec.error, opened: [] };
    const opened = [];
    for (const l of spec.layers) {
      try {
        const d = await this.planLp({ poolRef, usd: l.usd, lowerPct: l.lowerPct, upperPct: l.upperPct });
        if (d.error) throw new Error(d.error);
        const r = await this.openLp(d.plan);
        opened.push({ n: l.n, usd: l.usd, tx: r.txHash, positionId: r.positionId, note: r.note });
        onProgress({ done: opened.length, total: spec.layers.length, note: r.note });
      } catch (e) {
        return { error: `layer ${l.n}/${spec.layers.length}: ${e.message}`, opened };
      }
    }
    return { ok: true, opened };
  }

  // ---- balances & swap simulation -----------------------------------------
  // The gas reserve follows the current gas price (see Executor.gasReserveCached).
  gasReserve() { return this.engine.exec?.gasReserveCached ? this.engine.exec.gasReserveCached() : BigInt(this.engine.cfg.gas?.native_reserve_wei ?? 2_000_000_000_000_000); }

  balanceList(p) {
    return [...new Set([this.chain.ADDR.native, this.chain.ADDR.usdg, this.chain.ADDR.weth, ...(p ? [lc(p.token0), lc(p.token1)] : [])])];
  }

  // Dollars per ONE token (decimal-adjusted). Quote assets from the ETH price;
  // the pool's pair token from the pool price against its quote asset. Otherwise: null.
  usdPer(tok, p, slot0) {
    const t = lc(tok), q = this.chain.QUOTES[t];
    if (q) return q.kind === 'eth' ? this.engine.ethUsd : 1;
    if (!p || !slot0 || p.quoteSide == null) return null;
    const px = m.priceFromSqrt(slot0.sqrtPriceX96, p.dec0, p.dec1);   // token1 per token0
    const qUsd = this.usdPer(p.quoteSide === 0 ? p.token0 : p.token1);
    if (t === lc(p.token0) && p.quoteSide === 1) return px * qUsd;
    if (t === lc(p.token1) && p.quoteSide === 0) return px > 0 ? qUsd / px : null;
    return null;
  }

  // One token row: the human-readable amount + its dollar value.
  kaki(tok, raw, p, slot0) {
    const t = lc(tok);
    const dec = this.chain.QUOTES[t]?.decimals ?? (p && t === lc(p.token0) ? p.dec0 : p && t === lc(p.token1) ? p.dec1 : 18);
    const symbol = this.chain.QUOTES[t]?.symbol ?? (p && t === lc(p.token0) ? p.symbol0 : p && t === lc(p.token1) ? p.symbol1 : '?');
    const amount = Number(raw) / 10 ** dec;
    const u = this.usdPer(t, p, slot0);
    return { token: t, symbol, amount, usd: u != null ? amount * u : null };
  }

  /**
   * The wallet balances relevant to opening a position: cash (ETH/USDG/WETH) and the
   * pool's pair token. `after` (optional) = the estimated balance after swap & mint.
   * cashUsd is deliberately computed as before (full ETH, including the gas reserve) so the
   * "cash is only $X" limit does not shift; the reserve is reported separately.
   */
  fromBalance(bal, p, slot0, after = null) {
    const tokens = this.balanceList(p).map((t) => {
      const row = { ...this.kaki(t, bal.get(t) || 0n, p, slot0), isQuote: !!this.chain.QUOTES[t], native: isNative(t) };
      if (after) {
        const s = this.kaki(t, after.get(t) ?? bal.get(t) ?? 0n, p, slot0);
        row.after = s.amount; row.afterUsd = s.usd;
      }
      return row;
    });
    const walletCashUsd = tokens.filter((x) => x.isQuote).reduce((a, x) => a + (x.usd || 0), 0);
    return { tokens, walletCashUsd, gasReserveEth: Number(this.gasReserve()) / 1e18 };
  }

  async saldo(poolRef) {
    const eng = this.engine;
    const p = poolRef ? await this.poolByRef(poolRef) : null;
    let slot0 = null;
    if (p) {
      slot0 = await (this.chain.isV3Venue(p.venue) ? this.chain.slot0V3(p.poolAddr || p.poolRef) : this.chain.slot0V4(p.poolRef))
        .catch(() => null);
    }
    const bal = await eng.exec.balances(this.balanceList(p));
    return { ...this.fromBalance(bal, p, slot0), wallet: !!eng.exec.address() };
  }

  /**
   * Imitates the swap steps of engine.executeEntry — wrap/unwrap WETH,
   * the USDG<->ETH bridge, then the zap — on top of the current balances, WITHOUT sending anything.
   * The formulas are copied from there, so if executeEntry changes, this must change too.
   *
   * The zap figures are the same as what will be sent (pool price + slippage room). The bridge
   * is estimated from the ETH price: the real Kyber quote is only requested at execution.
   * `problems` = the steps that will make execution stop.
   */
  simulateSwap({ p, plan, slot0, bal, rules }) {
    const eng = this.engine;
    const reserve = this.gasReserve();
    const slip = rules.swap.max_slippage_bps;
    const s = new Map(this.balanceList(p).map((t) => [t, bal.get(t) || 0n]));
    const get = (t) => s.get(lc(t)) || 0n;
    const avail = (t) => { const v = get(t); return isNative(t) ? (v > reserve ? v - reserve : 0n) : v; };
    const move = (a, x, b, y) => { s.set(lc(a), get(a) - x); s.set(lc(b), get(b) + y); };
    const step = [], problems = [];
    const record = (kindName, a, x, b, y, extra = {}) => {
      step.push({ jenis: kindName, dari: this.kaki(a, x, p, slot0), ke: this.kaki(b, y, p, slot0), ...extra });
      move(a, x, b, y);
    };
    const fmt = (t, raw) => { const k = this.kaki(t, raw, p, slot0); return `${k.amount.toPrecision(4)} ${k.symbol}`; };

    // 0a. top up gas from WETH if native ETH is below the reserve (engine.topUpGas)
    if (get(this.chain.ADDR.native) < reserve && get(this.chain.ADDR.weth) > 0n) {
      const deficit = reserve - get(this.chain.ADDR.native), exists = get(this.chain.ADDR.weth);
      const amt = exists < deficit ? exists : deficit;
      if (amt * 10n >= reserve) record('buka_bungkus', this.chain.ADDR.weth, amt, this.chain.ADDR.native, amt, { gas: true });
    }

    // 0. cash into this pool's quote asset (engine.ensureQuoteAsset)
    const qTok = lc(plan.quoteSide === 0 ? plan.token0 : plan.token1);
    const qDec = this.chain.QUOTES[qTok]?.decimals ?? 18;
    const needQ = BigInt(Math.ceil((plan.valueQuote || 0) * 1.05 * 10 ** qDec));
    const funded = avail(plan.token0) >= BigInt(plan.amount0Max) && avail(plan.token1) >= BigInt(plan.amount1Max);
    if (!funded && needQ > 0n && avail(qTok) < needQ) {
      if (qTok === this.chain.ADDR.weth || qTok === this.chain.ADDR.native) {
        const lain = qTok === this.chain.ADDR.weth ? this.chain.ADDR.native : this.chain.ADDR.weth;
        const want = needQ - avail(qTok), exists = avail(lain);
        if (exists > 0n) record(qTok === this.chain.ADDR.weth ? 'bungkus' : 'buka_bungkus', lain, exists < want ? exists : want, qTok, exists < want ? exists : want);
      }
      if (avail(qTok) < needQ) {
        const wantEth = qTok === this.chain.ADDR.native || qTok === this.chain.ADDR.weth;
        const payTok = wantEth ? this.chain.ADDR.usdg : this.chain.ADDR.native, outTok = wantEth ? this.chain.ADDR.native : this.chain.ADDR.usdg;
        const short = needQ - avail(qTok);
        const k = 1 + slip / 10000;
        const uDec = this.chain.usdgDecimals;
        const pay = wantEth
          ? BigInt(Math.ceil((Number(short) / 1e18) * eng.ethUsd * 10 ** uDec * k))
          : BigInt(Math.ceil((Number(short) / 10 ** uDec / eng.ethUsd) * 1e18 * k));
        // ETH cash for the bridge = native ETH above the reserve + WETH (unwrapped as needed).
        const can = wantEth ? avail(payTok) : avail(this.chain.ADDR.native) + get(this.chain.ADDR.weth);
        if (!rules.swap.enabled) problems.push('kas ada di aset kuotasi lain dan auto-swap dimatikan — pembukaan akan berhenti');
        else if (can < pay) problems.push(`kas kurang untuk jembatan: butuh ~${fmt(payTok, pay)}, bisa dipakai ${fmt(payTok, can)}${wantEth ? '' : ' (ETH+WETH)'}`);
        if (!wantEth && rules.swap.enabled && avail(this.chain.ADDR.native) < pay && get(this.chain.ADDR.weth) > 0n) {
          const deficit = pay - avail(this.chain.ADDR.native), exists = get(this.chain.ADDR.weth);
          const amt = exists < deficit ? exists : deficit;
          record('buka_bungkus', this.chain.ADDR.weth, amt, this.chain.ADDR.native, amt);
        }
        record('jembatan', payTok, pay, outTok, short, { maxLossBps: rules.swap.max_price_impact_bps, estimate: true });
        if (qTok === this.chain.ADDR.weth) {
          const want = needQ - avail(qTok), exists = avail(this.chain.ADDR.native);
          const amt = exists < want ? exists : want;
          if (amt > 0n) record('bungkus', this.chain.ADDR.native, amt, qTok, amt);
        }
      }
    }

    // 1. zap: cover each token's shortfall from its pair token
    const price1per0 = Number(slot0.sqrtPriceX96) ** 2 / Number(m.Q96) ** 2;
    const feeBps = plan.fee != null && plan.fee < 1_000_000 ? plan.fee / 100 : null;
    const zapLossBps = feeBps != null
      ? Math.max(rules.swap.max_price_impact_bps, Math.round(feeBps) + 200)
      : rules.swap.max_price_impact_bps;
    for (const [idx, tok, need] of [[0, plan.token0, BigInt(plan.amount0Max)], [1, plan.token1, BigInt(plan.amount1Max)]]) {
      const have = avail(tok);
      if (have >= need) continue;
      const short = need - have;
      const payTok = idx === 0 ? plan.token1 : plan.token0;
      const k = 1 + slip / 10000;
      const payRaw = idx === 0
        ? BigInt(Math.ceil(Number(short) * price1per0 * k))
        : BigInt(Math.ceil((Number(short) / price1per0) * k));
      if (payRaw <= 0n) continue;
      if (!rules.swap.enabled) problems.push(`kurang ${fmt(tok, short)} dan auto-swap dimatikan — pembukaan akan berhenti`);
      else if (avail(payTok) < payRaw) problems.push(`saldo kurang untuk zap: butuh ~${fmt(payTok, payRaw)}, ada ${fmt(payTok, avail(payTok))}`);
      record('zap', payTok, payRaw, tok, short, { maxLossBps: zapLossBps });
    }

    // 2. the mint uses its estimated amount (not the upper bound with slippage)
    s.set(lc(plan.token0), get(plan.token0) - BigInt(plan.amount0));
    s.set(lc(plan.token1), get(plan.token1) - BigInt(plan.amount1));
    for (const [t, v] of s) if (v < 0n) s.set(t, 0n);
    return { step, problems, after: s };
  }

  // ---- manually follow a failed / skipped target action ----------------------
  // The target opens a position, the bot does not follow (skipped: cooldown, limit, stale signal;
  // failed: zap route loses, insufficient cash). The user may decide to follow later.
  // The position is recorded AS A MIRROR of that target position (target + mirror_of = the target's
  // tokenId), so its exit is still automatic: follows close/partial withdrawal when the
  // target exits (handleExit), reconciliation if the exit signal is missed, and that target's
  // standalone exit rules. The plan path is planLp (limits, cash, hook, swap simulation),
  // the range is the target rule's planRange — the same as an automatic copy.
  poolFromAction(a, toks) {
    const qs = this.chain.quoteSideOf(a.token0, a.token1);
    return {
      poolRef: a.pool_ref, venue: a.venue, token0: a.token0, token1: a.token1,
      fee: a.fee, tickSpacing: a.tick_spacing, hooks: a.hooks, poolAddr: this.chain.isV3Venue(a.venue) ? a.pool_ref : null,
      symbol0: toks[0].symbol, symbol1: toks[1].symbol, dec0: toks[0].decimals, dec1: toks[1].decimals,
      pair: `${toks[0].symbol}/${toks[1].symbol}`, feePct: feePctOf(a.fee), dynamicFee: dynamicFeeVal(a.fee),
      hasHooks: !!(a.hooks && !/^0x0+$/i.test(a.hooks)),
      quoteSymbol: qs?.symbol || null, quoteSide: qs?.side ?? null, quoteKind: qs?.kind || null,
    };
  }

  // Conditions for an action that may be followed, without RPC — also used by the Activity list.
  static followable(a, openMirrors) {
    return (a.kind === 'increase' || a.kind === 'mint') && (a.venue === 'v4' || String(a.venue).endsWith('v3') || SOL_VENUES.has(a.venue))
      && (a.verdict === 'skip' || a.verdict === 'error') && !!a.token_id && !!a.pool_ref
      && a.tick_lower != null && a.tick_upper != null
      && !openMirrors.has(`${a.target}|${a.token_id}`);
  }

  openMirrorKeys() {
    return new Set(this.store.all("SELECT target, mirror_of FROM positions WHERE chain=? AND status='open' AND target IS NOT NULL AND mirror_of IS NOT NULL", this.network)
      .map((r) => `${r.target}|${r.mirror_of}`));
  }

  async followContext(actionId) {
    const a = this.store.get(`SELECT a.*, d.id AS decision_id, d.verdict, d.reason, d.plan
      FROM actions a LEFT JOIN decisions d ON d.action_id = a.id WHERE a.id=?`, Number(actionId));
    if (!a) return { error: 'aksi tidak ditemukan' };
    if (!a.verdict) return { error: 'aksi ini masih diproses bot — tunggu keputusannya' };
    if (a.verdict === 'copy' || a.verdict === 'dry') return { error: 'aksi ini sudah disalin bot' };
    const mirror = this.store.get("SELECT id FROM positions WHERE chain=? AND status='open' AND target=? AND mirror_of=?", this.network, a.target, a.token_id ?? '');
    if (mirror) return { error: `posisi target ini sudah diikuti oleh posisi #${mirror.id}` };
    if (!Manual.followable(a, new Set())) return { error: 'hanya aksi buka/tambah posisi yang gagal atau dilewati yang bisa diikuti' };
    // A target that has fully exited: our position has no counterpart to follow out.
    let targetLiq = null;
    try { targetLiq = (await this.engine.targetLiquidity(a.venue, a.token_id))?.liquidity ?? null; } catch { /* unreadable */ }
    if (targetLiq === 0n) return { error: 'target sudah menutup posisi ini — tidak ada yang bisa diikuti' };
    const toks = await this.chain.tokens([a.token0, a.token1]);
    const rules = this.engine.rulesFrom(a.target);
    let botPlan = null;
    try { botPlan = a.plan ? JSON.parse(a.plan) : null; } catch { /* rencana lama */ }
    const t = this.store.get('SELECT label FROM targets WHERE chain=? AND address=?', this.network, a.target);
    const k = this.chain.isEthLike(a.quote_symbol) ? this.engine.ethUsd : 1;
    const targetUsd = a.value_quote != null ? a.value_quote * k : null;
    // Suggested amount: the size the bot originally planned (already past the limits),
    // if none — the per-position limit, no larger than the target position.
    const cap = rules.sizing.max_quote_per_position_usd;
    const suggestUsd = Number.isFinite(botPlan?.valueUsd) && botPlan.valueUsd > 0 ? botPlan.valueUsd
      : targetUsd != null ? Math.min(cap, targetUsd) : cap;
    const e = rules.exit;
    return {
      a, toks, rules,
      info: {
        actionId: a.id, ts: a.ts, ageMs: Date.now() - a.ts, target: a.target, targetLabel: t?.label || null,
        tokenId: a.token_id, venue: a.venue, pair: `${toks[0].symbol}/${toks[1].symbol}`,
        verdict: a.verdict, reason: a.reason, targetUsd, suggestUsd: Math.floor(suggestUsd * 100) / 100,
        targetOpen: targetLiq == null ? null : targetLiq > 0n,
        exit: {
          followTarget: !!e.follow_target, followPartial: !!e.follow_partial,
          stopLossPct: e.stop_loss_pct, takeProfitPct: e.take_profit_pct,
          maxAgeHours: e.max_age_hours, outOfRangeMinutes: e.out_of_range_minutes, outOfRangePct: e.out_of_range_pct, reenterWithinPct: e.reenter_within_pct, sellLeftover: !!e.sell_leftover,
        },
      },
    };
  }

  async planFollow({ actionId, usd }) {
    const c = await this.followContext(actionId);
    if (c.error) return c;
    const notional = usd != null && usd !== '' ? Number(usd) : c.info.suggestUsd;
    const r = await this.planLp({
      pool: this.poolFromAction(c.a, c.toks), poolRef: c.a.pool_ref, usd: notional,
      tickLower: c.a.tick_lower, tickUpper: c.a.tick_upper, ranged: true, target: c.a.target,
    });
    if (r.error) return { ...r, follow: c.info };
    r.plan.mirrorOf = c.a.token_id;
    r.plan.targetRange = [c.a.tick_lower, c.a.tick_upper];
    r.plan.targetValueUsd = c.info.targetUsd;
    return { ...r, follow: { ...c.info, usd: notional } };
  }

  async follow({ actionId, usd }) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    // Re-planned here, at the current price & balances — not the preview plan
    // that can be minutes old while the confirmation modal is open.
    const d = await this.planFollow({ actionId, usd });
    if (d.error) throw new Error(d.error);
    const { plan, follow: f } = d;
    const slot0 = this.chain.isV3Venue(plan.venue) ? await this.chain.slot0V3(plan.poolRef) : await this.chain.slot0V4(plan.poolRef);
    const r = await eng.executeEntry(plan, { target: f.target, tokenId: f.tokenId, slot0 });
    const late = duration(Date.now() - f.ts);
    const prev = this.store.get('SELECT id, verdict, reason FROM decisions WHERE action_id=? ORDER BY id DESC LIMIT 1', f.actionId);
    // This action's decision is replaced with "copied" (one decision per action); the original
    // decision is kept in its plan so the trail is not lost.
    const saved = { ...plan, followedManually: { at: Date.now(), lateMs: Date.now() - f.ts, verdict: prev?.verdict, reason: prev?.reason } };
    if (prev) {
      this.store.run('UPDATE decisions SET verdict=?, reason=?, plan=?, tx_hash=?, position_id=? WHERE id=?',
        'copy', `diikuti manual ${late} setelah target masuk — ${r.note}`.slice(0, 600), JSON.stringify(saved), r.txHash, r.positionId, prev.id);
    }
    eng.lastCopyAt?.set(plan.poolRef, Date.now());
    eng.notify(`LP diikuti manual (${late} setelah target): ${r.note}`, {
      kind: 'entry', positionId: r.positionId, txHash: r.txHash, adding: !!r.adding,
      pair: r.pair, valueUsd: r.valueUsd, curTick: r.curTick, steps: r.steps,
      target: f.target, mirrorOf: f.tokenId, reason: `diikuti manual ${late} setelah target masuk`,
      targetUsd: plan.targetValueUsd ?? null, targetTs: f.ts ?? null, targetRange: plan.targetRange ?? null,
    });
    return { ...r, lateMs: Date.now() - f.ts };
  }

  // ---- take over / hand back control of a mirror position ------------------------
  // Take over = the position is released from its target: the target's exit/partial withdrawal/addition is not
  // followed, exit reconciliation is skipped, standalone exit rules (SL/TP/age/out of
  // range) do not apply. Its link to the target (target, mirror_of) stays stored,
  // so it can be handed back — as long as that target position still exists on chain. After the
  // target position closes, there is nothing left to follow: the position stays manual.
  takeoverRow(id) {
    const pos = this.store.get('SELECT * FROM positions WHERE id=?', Number(id));
    if (!pos) return { error: 'posisi tidak ditemukan' };
    if (pos.status !== 'open') return { error: 'posisi sudah tertutup' };
    if (!pos.target || !pos.mirror_of) return { error: 'posisi ini tidak mengikuti target — sudah dalam kendali manual' };
    return { pos };
  }

  async takeover(id) {
    const { pos, error } = this.takeoverRow(id);
    if (error) throw new Error(error);
    if (pos.takeover_ts != null) return { ok: true, takeoverTs: pos.takeover_ts };
    if (this.engine.exiting?.has(pos.id)) throw new Error('posisi sedang ditutup — tunggu hasilnya');
    const ts = Date.now();
    this.store.run('UPDATE positions SET takeover_ts=? WHERE id=? AND takeover_ts IS NULL', ts, pos.id);
    this.store.log('info', `posisi #${pos.id} diambil alih manual — tidak lagi mengikuti target #${pos.mirror_of}`);
    return { ok: true, takeoverTs: ts };
  }

  // Target position status for the "hand back" button/confirmation. targetOpen null = unreadable.
  async handBackInfo(id) {
    const { pos, error } = this.takeoverRow(id);
    if (error) return { error };
    let liq = null;
    try { liq = (await this.engine.targetLiquidity(pos.venue, pos.mirror_of))?.liquidity ?? null; } catch { /* unreadable */ }
    const e = this.engine.rulesFrom(pos.target).exit;
    return {
      id: pos.id, takeoverTs: pos.takeover_ts, target: pos.target, tokenId: pos.mirror_of,
      targetOpen: liq == null ? null : liq > 0n,
      exit: {
        followTarget: !!e.follow_target, followPartial: !!e.follow_partial,
        stopLossPct: e.stop_loss_pct, takeProfitPct: e.take_profit_pct,
        maxAgeHours: e.max_age_hours, outOfRangeMinutes: e.out_of_range_minutes, outOfRangePct: e.out_of_range_pct, reenterWithinPct: e.reenter_within_pct,
      },
    };
  }

  async handBack(id) {
    const info = await this.handBackInfo(id);
    if (info.error) throw new Error(info.error);
    if (info.takeoverTs == null) return { ok: true };
    if (info.targetOpen === false) throw new Error(`target sudah menutup posisi #${info.tokenId} — tidak ada yang bisa diikuti lagi, posisi ini tetap manual`);
    if (info.targetOpen == null) throw new Error('status posisi target tidak terbaca dari RPC — coba lagi sebentar');
    // The "out of range since" count is reset: time spent in manual must not immediately
    // trigger a close once it is handed back.
    this.store.setState(`oor:${info.id}`, 0);
    this.store.run('UPDATE positions SET takeover_ts=NULL WHERE id=?', info.id);
    this.store.log('info', `posisi #${info.id} dikembalikan ke otomatis — mengikuti target #${info.tokenId} lagi`);
    return { ok: true };
  }

  async openLp(plan) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    const slot0 = this.chain.isV3Venue(plan.venue)
      ? await this.chain.slot0V3(plan.poolRef)
      : await this.chain.slot0V4(plan.poolRef);
    const r = await eng.executeEntry(plan, { target: null, slot0 });
    eng.notify(`LP manual dibuka: ${r.note}`);
    return r;
  }

  // ---- manual swap --------------------------------------------------------
  // Tokens added by the user via address (the Swap page). Stored in the state table,
  // not in the browser, so they also show up in the Telegram bot and on other devices.
  // The caller must ensure the address really is a token: this list does not check.
  customTokens() {
    try {
      const v = JSON.parse(this.store.getState(this.sk('swap_tokens'), '[]'));
      return Array.isArray(v) ? v.map(lc).filter((a) => /^0x[0-9a-f]{40}$/.test(a)) : [];
    } catch { return []; }
  }
  addCustomToken(a) {
    const list = this.customTokens().filter((x) => x !== lc(a));
    this.store.setState(this.sk('swap_tokens'), JSON.stringify([lc(a), ...list].slice(0, 50)));
  }
  removeCustomToken(a) {
    this.store.setState(this.sk('swap_tokens'), JSON.stringify(this.customTokens().filter((x) => x !== lc(a))));
  }

  // Which ERC-20 tokens have ever ARRIVED in the bot wallet — from Transfer logs whose
  // `to` is our wallet. Without this, a token sent from outside (not a result of a
  // bot position) never appears in the swap list even when its balance exists.
  //
  // The scan runs IN THE BACKGROUND: what is returned is always the stored list. held()
  // used to wait for this scan; a wide-range getLogs is only served by the official RPC, and
  // while that RPC replied 429 the scan never finished — it fell behind by
  // millions of blocks, and every opening of the Swap page repeated the same scan until the
  // request hung for minutes.
  seenState(me) {
    let st = { wallet: null, block: 0, tokens: [] };
    try { st = { ...st, ...JSON.parse(this.store.getState(this.sk('swap_seen'), '{}')) }; } catch { /* start from zero */ }
    return st.wallet === me ? st : { wallet: me, block: 0, tokens: [] };
  }
  seenTokens() {
    const me = this.engine.exec.address();
    if (!me) return [];
    const st = this.seenState(me);
    // Rescan at most every 60 seconds (also after a failure): the Swap page and the
    // Telegram bot call held() repeatedly, and getLogs is the heaviest RPC call.
    if (!this.seenScan && !(st.block && Date.now() - (st.ts || 0) < 60_000)) {
      this.seenScan = this.scanSeen(me)
        .catch((e) => this.log(`pindai token wallet gagal: ${e.message}`))
        .finally(() => { this.seenScan = null; });
    }
    return st.tokens;
  }
  // Staged per SEEN_STEP blocks and stored at each step, so an RPC that goes down
  // midway does not throw away progress. The first scan goes back 900 thousand blocks,
  // like wallet research.
  async scanSeen(me) {
    const { getLogsSafe } = require('./scout');
    const head = await this.rpc.blockNumber();
    let st = this.seenState(me);
    for (let lo = st.block ? st.block + 1 : Math.max(0, head - 900_000); lo <= head;) {
      const hi = Math.min(head, lo + SEEN_STEP - 1);
      const logs = await getLogsSafe(this.rpc, { topics: [TOPIC.transfer, null, ethers.zeroPadValue(me, 32)] }, lo, hi);
      const set = new Set(st.tokens);
      // ERC-721 Transfer has the same topic but its tokenId is in topics[3];
      // ERC-20 uses data for the amount.
      for (const l of logs) {
        if (l.topics.length !== 3 || !l.address) continue;
        set.add(lc(l.address));
        this.emptyAt?.delete(lc(l.address));  // newly arrived: its balance is read again
      }
      st = { wallet: me, block: hi, ts: Date.now(), tokens: [...set].slice(-300) };
      this.store.setState(this.sk('swap_seen'), JSON.stringify(st));
      lo = hi + 1;
    }
  }

  // Tokens that make sense to offer: quote assets + tokens we really hold
  // (from open positions, the leftover sell queue, and all tokens that ever entered the
  // wallet — only those whose balance is still there) + manually added tokens.
  // Balances are read once, in one batch.
  async held() {
    const eng = this.engine;
    const set = new Set([this.chain.ADDR.native, this.chain.ADDR.usdg, this.chain.ADDR.weth]);
    const custom = new Set(this.customTokens());
    for (const r of this.store.all("SELECT token0, token1 FROM positions WHERE chain=? AND status='open'", this.network)) {
      if (r.token0) set.add(lc(r.token0));
      if (r.token1) set.add(lc(r.token1));
    }
    for (const it of eng.leftovers()) if (it.token) set.add(lc(it.token));
    for (const a of custom) set.add(a);
    // Tokens that have ever entered the wallet + every token the bot knows: their balance
    // is checked at once, but only those still with a balance enter the list — tokens
    // that have been fully sold need not fill the picker.
    const extra = new Set();
    for (const a of this.seenTokens()) if (!set.has(a)) extra.add(a);
    for (const r of this.store.all('SELECT address FROM tokens WHERE chain=?', this.network)) if (r.address && !set.has(lc(r.address))) extra.add(lc(r.address));
    // The tokens table holds hundreds of memecoins the bot has seen, almost all of them
    // with a zero balance. Those that read zero are not re-read during EMPTY_RECHECK_MS —
    // without this every opening of the Swap page = hundreds of eth_calls on an RPC that is at 429.
    // Tokens that just arrived (log scan) or were the result of a swap are taken off this list.
    const now = Date.now();
    const emptyAt = this.emptyAt || (this.emptyAt = new Map());
    const check = [...extra].filter((a) => !(now - (emptyAt.get(a) || 0) < EMPTY_RECHECK_MS));
    const list = [...set, ...check];
    const bal = await eng.exec.balances(list);
    for (const a of check) if ((bal.get(a) || 0n) > 0n) emptyAt.delete(a); else emptyAt.set(a, now);
    const keep = list.filter((a) => set.has(a) || (bal.get(a) || 0n) > 0n);
    // Metadata of a token that has a balance but is not yet known is read from the chain (and stored).
    const metas = await this.chain.tokens(keep);
    const byAddr = new Map(metas.filter(Boolean).map((t) => [lc(t.address), t]));
    return keep.map((a) => {
      const meta = byAddr.get(a) || {};
      const raw = bal.get(a) || 0n;
      const dec = meta.decimals ?? (this.chain.QUOTES[a]?.decimals ?? 18);
      return {
        address: a, symbol: meta.symbol || this.chain.QUOTES[a]?.symbol || a.slice(0, 8), decimals: dec,
        raw: raw.toString(), amount: Number(raw) / 10 ** dec,
        isQuote: !!this.chain.QUOTES[a], native: isNative(a), custom: custom.has(a) && !this.chain.QUOTES[a],
      };
    }).sort((x, y) => (y.isQuote ? 1 : 0) - (x.isQuote ? 1 : 0) || y.amount - x.amount);
  }

  // Turn "all" / "50%" / a number into a raw amount, leaving gas
  // aside if what is sold is native ETH.
  async amountRaw(token, input) {
    const { raw, maxVal, dec, symbol } = await this.amountInfo(token, input);
    if (raw > maxVal) throw new Error(`saldo cuma ${(Number(maxVal) / 10 ** dec).toPrecision(6)} ${symbol}`.trim());
    return raw;
  }

  // The same parse WITHOUT the balance check: the swap page still shows a quote for an
  // amount above the balance (button disabled), so the user sees the rate before topping up.
  async amountInfo(token, input) {
    const h = (await this.held()).find((x) => x.address === lc(token));
    const dec = h?.decimals ?? 18;
    const bal = BigInt(h?.raw || '0');
    const reserve = this.gasReserve();
    const maxVal = isNative(token) ? (bal > reserve ? bal - reserve : 0n) : bal;
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
    return out(ethers.parseUnits(n.toFixed(Math.min(dec, 18)), dec));
  }

  // `aggregator`: 'auto' (default) = the best route among those that stay inside the loss limit,
  // or an aggregator id to quote exactly that one. Every aggregator's quote comes back in
  // `routes` so the page can show the whole scan.
  async quoteSwap({ tokenIn, tokenOut, amountRaw, aggregator = 'auto' }) {
    const eng = this.engine;
    if (lc(tokenIn) === lc(tokenOut)) return { error: 'token masuk dan keluar sama' };
    if (!amountRaw || BigInt(amountRaw) <= 0n) return { error: 'jumlah nol' };
    const [mi, mo] = await this.chain.tokens([tokenIn, tokenOut]);
    const rows = await eng.kyber.scan(tokenIn, tokenOut, BigInt(amountRaw));
    const { Kyber } = require('./kyber');
    // The exit side is valued on its own if it is a quote asset: without this the "route cost" is empty
    // precisely on the thin tokens whose figure most needs to be seen before pressing swap.
    const qo = this.chain.QUOTES[lc(tokenOut)] || null;
    const ref = qo && { usdPerOut: qo.kind === 'eth' ? eng.ethUsd : 1, outDecimals: qo.decimals };
    const rules = eng.rulesFrom(null);
    const maxLossBps = rules.exit.sell_max_loss_bps;
    const outDec = mo.decimals ?? 18;
    const routes = rows.map((r) => {
      const loss = r.q ? Kyber.lossBps(r.q, ref) : null;
      return {
        id: r.id, label: r.label, state: r.state, blocker: r.blocker, ms: r.ms, dex: r.q?.dex || null,
        amountOut: r.q ? Number(r.q.amountOut) / 10 ** outDec : null,
        usdIn: r.q?.usdIn ?? null, usdOut: r.q?.usdOut ?? null, lossBps: loss,
        tooLossy: loss != null && loss > maxLossBps, q: r.q,
      };
    });
    const have = routes.filter((r) => r.q);
    const bestOf = (list) => list.reduce((m, r) => (!m || r.q.amountOut > m.q.amountOut ? r : m), null);
    const best = bestOf(have.filter((r) => !r.tooLossy)) || bestOf(have);
    const pick = aggregator && aggregator !== 'auto' ? routes.find((r) => r.id === aggregator) : best;
    const view = routes.map(({ q, ...r }) => ({ ...r, best: r.id === best?.id }));
    if (!pick || !pick.q) {
      const why = pick ? (pick.state === 'off' ? `${pick.label} tidak aktif (${pick.blocker})` : `${pick.label} tidak menemukan rute untuk pasangan ini`)
        : 'Tidak ada agregator yang menemukan rute untuk pasangan ini';
      return { error: why, routes: view, aggregator };
    }
    return {
      symbolIn: mi.symbol, symbolOut: mo.symbol,
      amountIn: Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 18),
      amountOut: pick.amountOut,
      usdIn: pick.usdIn, usdOut: pick.usdOut, lossBps: pick.lossBps, dex: pick.dex,
      maxLossBps, slippageBps: rules.swap.max_slippage_bps,
      tooLossy: pick.tooLossy,
      aggregator: aggregator || 'auto', chosen: pick.id, chosenLabel: pick.label, routes: view,
    };
  }

  async doSwap({ tokenIn, tokenOut, amountRaw, aggregator = 'auto' }) {
    const eng = this.engine;
    if (!eng.exec.address()) throw new Error('belum ada wallet');
    if (eng.dryRun()) throw new Error('mode simulasi: tidak mengirim transaksi');
    if (eng.stopping) throw new Error('bot sedang berhenti (restart) — coba lagi sebentar');
    // The same token is being sold by the automatic leftover queue: two swaps from the same balance
    // → the second reverts (gas burned) or sells a share that was already sold.
    eng.selling = eng.selling || new Set();
    const lockKey = lc(tokenIn);
    if (eng.selling.has(lockKey)) throw new Error('token ini sedang dijual otomatis — tunggu sebentar');
    if (eng.tokenInEntry?.(lockKey)) throw new Error('token ini sedang dipakai membuka posisi — tunggu entry-nya selesai');
    eng.selling.add(lockKey);
    try { return await this.doSwapLocked({ tokenIn, tokenOut, amountRaw, aggregator }); }
    finally { eng.selling.delete(lockKey); this.emptyAt?.delete(lc(tokenOut)); }
  }

  async doSwapLocked({ tokenIn, tokenOut, amountRaw, aggregator = 'auto' }) {
    const eng = this.engine;
    const rules = eng.rulesFrom(null);
    const [mi, mo] = await this.chain.tokens([tokenIn, tokenOut]);
    const entry = Number(BigInt(amountRaw)) / 10 ** (mi.decimals ?? 18);
    // The token and amount are also recorded in txs so the history on the Swap page can
    // show "0.5 ETH → 1,700 USDG", not just a hash.
    const detail = { tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), symbolIn: mi.symbol, symbolOut: mo.symbol, amountIn: entry };
    const r = await eng.kyber.swap(tokenIn, tokenOut, BigInt(amountRaw), {
      slippageBps: rules.swap.max_slippage_bps,
      maxLossBps: rules.exit.sell_max_loss_bps,
      kind: 'swap_manual', detail,
      ...(aggregator && aggregator !== 'auto' ? { only: aggregator } : {}),
    });
    if (!r) throw new Error('Tidak ada agregator yang menemukan rute');
    // Result from the receipt; if unreadable (native ETH + a lagging node) use the quote.
    const outRaw = r.amountOut ?? BigInt(r.quote?.amountOut ?? 0);
    const outgoing = Number(outRaw) / 10 ** (mo.decimals ?? 18);
    // What is sold may be memecoin from fees that were claimed, or leftovers of a position
    // that has closed: that position's PnL is corrected to this sale's proceeds (FIFO if several
    // positions hold the same token).
    try {
      eng.positions.recordTokenSale({ token: lc(tokenIn), amount: BigInt(amountRaw), quoteToken: lc(tokenOut),
        txHash: r.hash, amountOut: r.amountOut, usdOut: r.quote?.usdOut, ethUsd: eng.ethUsd });
    } catch (e) { this.store.log('warn', `catat hasil jual sisa: ${e.message}`, { quiet: true }); }
    try {
      const row = this.store.get('SELECT detail FROM txs WHERE hash=?', r.hash);
      const d = row?.detail ? JSON.parse(row.detail) : detail;
      this.store.run('UPDATE txs SET detail=? WHERE hash=?', JSON.stringify({ ...d, amountOut: outgoing }), r.hash);
    } catch { /* history only: the swap was already sent */ }
    const note = `${entry.toPrecision(6)} ${mi.symbol} → ${outgoing.toPrecision(6)} ${mo.symbol}`;
    eng.notify(`swap manual: ${note}`);
    return { txHash: r.hash, amountOut: outRaw.toString(), note, dex: r.quote?.dex || null };
  }
}

module.exports = { ticksFromPct, ladderLayers, LADDER_METHODS, Manual };
