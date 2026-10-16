'use strict';
// Uniswap, straight on chain: no API, no key. Quotes come from Uniswap's own Quoter
// contracts (V4Quoter for v4 pools, QuoterV2 for v3 pools) — exact amounts, ticks crossed and
// hooks run included, unlike the constant-liquidity estimate in swappool.js. The swap is one
// UniversalRouter transaction.
//
// Routes: the pair's own pools, or two hops through a base asset (USDG / WETH / native) —
// a memecoin usually has a pool against USDG only, so MEME → ETH is MEME → USDG → ETH. Native
// ETH and WETH are interchangeable at either end (WRAP_ETH / UNWRAP_WETH in the same tx):
// DexScreener lists WETH pools only, so a native-ETH pool may be unknown on an instance. The
// hops may mix venues: v4+v4 is one V4_SWAP (the second hop spends the first one's open
// delta), v3+v3 is one V3 path, and a mixed route parks the middle token in the router
// (ADDRESS_THIS / CONTRACT_BALANCE) between a V4_SWAP and a V3_SWAP_EXACT_IN.
// V3_SWAP_EXACT_IN carries a trailing `uint256[] maxHopSlippage` (empty): UniversalRouter v2.1
// (Robinhood) reads it and reverts SliceOutOfBounds (0x3b99b53d) without it; older routers
// read only the first five fields, so the extra field is harmless there.
//
// Pools come from the pools table. A token not looked up lately is first resolved through
// `discover` (DexScreener's pool list, checked on chain and stored — Manual#resolveListed),
// so a token the scanner never saw, or an instance with a small table, still finds its pools.
// Only Uniswap venues ('v4' and the chain's Uniswap v3 'v3'); a fork such as PancakeSwap is
// not reachable through this router.
//
// Guards before anything is sent:
//   1. the calldata is built here, to the chain's UniversalRouter;
//   2. minimum output = fresh Quoter amount − slippage, enforced by the router itself;
//   3. the exact tx is dry-run with eth_call from our wallet (both v4 param layouts, the best
//      routes in one batch) — a hook or pool that rejects the swap costs no gas. Many memecoin
//      pools have hooks that reject the Quoter or the router; those simply have no route here;
//   4. the same USD loss gate as every other aggregator (Kyber.routeLoss);
//   5. after the tx, the output must have reached OUR wallet (receipt Transfer logs).
// Approvals go through Permit2 to the UniversalRouter (Executor#ensureRouterAllowance), the
// same path the direct-pool fallback already uses.
const { ethers } = require('ethers');
const { ensureChain } = require('../networks');
const { Kyber } = require('../kyber');
const { RpcPool } = require('../rpc');
const { ABI, ACT, CMD, SENTINEL } = require('../chain');
const { lc, isNative } = require('./base');

// Uniswap's Quoter deployments, by chain id (from @uniswap/sdk-core 7.19.4 addresses.js;
// v3 = QuoterV2). Config aggregators.uniswap.quoters.{v3,v4} overrides them.
const QUOTERS = {
  4663: { v3: '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7', v4: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94' },
  56: { v3: '0x78d78e420da98ad378d7799be8f4af69033eb077', v4: '0x9f75dd27d6664c475b90e105573e550ff69437b0' },
  1: { v3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', v4: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203' },
  8453: { v3: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a', v4: '0x0d5e0f971ed27fbff6c2837bf31316121532048d' },
  42161: { v3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', v4: '0x3972c00f7ed4885e145823eb7c655375d275a1c5' },
  10: { v3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', v4: '0x1f3131a13296fb91c90870043742c3cdbff1a8d7' },
  137: { v3: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', v4: '0xb3d5c3dfc3a7aebff71895a7191796bffc2c81b9' },
  43114: { v3: '0xbe0f5544ec67e9b3b2d979aaa43f18fd87e6257f', v4: '0xbe40675bb704506a3c2ccfb762dcfd1e979845c2' },
};
const PK = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
const IF_Q4 = new ethers.Interface([`function quoteExactInputSingle(tuple(${PK} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`]);
const IF_Q3 = new ethers.Interface(['function quoteExactInputSingle(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)']);
const IF_UR = new ethers.Interface(ABI.universalRouter);
const coder = ethers.AbiCoder.defaultAbiCoder();
const TOPIC_XFER = ethers.id('Transfer(address,address,uint256)');
const DYNAMIC_FEE = 0x800000;
const MAX_POOLS = 12;        // quoted per pair, one eth_call batch
const LEG1_KEEP = 2;         // best first hops carried into the second hop, per middle token
const MAX_SIMULATED = 3;     // best routes dry-run before sending
const DISCOVER_TTL_MS = 30 * 60_000;
const DISCOVER_WAIT_MS = 8_000;
const isZeroAddr = (a) => !a || /^0x0+$/.test(a);
// v4 ExactInputSingleParams layouts, dry-run in this order; the first that passes is sent.
// See Executor#buildSwapV4: 'hop' (UniversalRouter v2.1, Robinhood; minHopPriceX36 = 0) and
// 'plain' (v2.0, BSC).
const LAYOUTS = ['hop', 'plain'];
const actionsHex = (list) => '0x' + list.map((a) => a.toString(16).padStart(2, '0')).join('');

class Uniswap {
  constructor({ exec, rpc, cfg, chain, log, store, discover = null }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.chain = ensureChain(chain); this.store = store;
    this.log = log || (() => {});
    this.discover = discover;   // async (token) => pools stored; optional
    this.discovered = new Map(); // token -> { at, p }
    this.warned = new Set();
    this.cache = new Map();   // quote cache: key -> { at, q }
  }

  get id() { return 'uniswap'; }
  get label() { return 'Uniswap'; }
  get needsKey() { return false; }
  settings() { return this.cfg.aggregators?.uniswap || {}; }
  hasCredentials() { return true; }
  quoters() {
    const base = QUOTERS[this.chain.CHAIN_ID] || {};
    const o = this.settings().quoters || {};
    return { v3: lc(o.v3 || base.v3) || null, v4: lc(o.v4 || base.v4) || null };
  }
  supportsChain() {
    const q = this.quoters();
    return !!this.store && !!this.chain.ADDR?.universalRouter && !!(q.v3 || q.v4);
  }
  enabled() { return this.settings().enabled !== false && this.supportsChain(); }
  blocker() {
    if (this.settings().enabled === false) return 'dimatikan';
    if (!this.supportsChain()) return 'chain ini belum didukung';
    return null;
  }
  warn(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); this.log(msg); } }

  // Middle tokens for two-hop routes: the chain's base assets.
  mids() {
    const A = this.chain.ADDR;
    return [...new Set([A.usdg, A.weth, A.native].filter(Boolean).map(lc))];
  }

  // Look a token's pools up through `discover` at most every 30 min; the first call per token
  // waits up to 8 s, later ones never wait. Native ETH has no listing of its own.
  async ensureDiscovered(tokens) {
    if (!this.discover) return;
    const now = Date.now();
    const waits = [];
    for (const t of new Set(tokens.map(lc))) {
      if (isNative(t)) continue;
      const d = this.discovered.get(t);
      if (d?.p) { if (d.first) waits.push(d.p); continue; }   // lookup in flight
      if (d && now - d.at < DISCOVER_TTL_MS) continue;
      const p = Promise.resolve().then(() => this.discover(t))
        .catch((e) => this.warn(`Uniswap: pencarian pool ${t.slice(0, 10)}… gagal (${e.message})`))
        .finally(() => this.discovered.set(t, { at: Date.now(), p: null, first: false }));
      this.discovered.set(t, { at: now, p, first: !d });
      if (!d) waits.push(p);
    }
    if (waits.length) await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, DISCOVER_WAIT_MS))]);
  }

  // Uniswap pools of exactly this pair: v4 always, v3 only on the Uniswap venue. Plain pools
  // first when there are more than the batch takes: hooked ones reject more often.
  pools(tokenIn, tokenOut) {
    const a = lc(tokenIn), b = lc(tokenOut);
    const q = this.quoters();
    const rows = this.store.all(`SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks, pool_addr FROM pools
      WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?))`, this.chain.network, a, b, b, a);
    return rows.filter((r) => (r.venue === 'v4' && q.v4) || (r.venue === 'v3' && q.v3 && r.pool_addr))
      .sort((x, y) => (isZeroAddr(y.hooks) ? 1 : 0) - (isZeroAddr(x.hooks) ? 1 : 0))
      .slice(0, MAX_POOLS);
  }

  poolKey(r) {
    return [r.token0, r.token1, Number(r.fee), Number(r.tick_spacing), r.hooks || ethers.ZeroAddress];
  }

  // One hop over many pools, each with its own input amount: [{ hop, amountOut }] for those the
  // Quoter answers. hop = { row, tokenIn, tokenOut, zeroForOne }.
  async quoteHops(items) {
    if (!items.length) return [];
    const q = this.quoters();
    const res = await this.rpc.ethCallMany(items.map(({ hop, amountIn }) => (hop.row.venue === 'v4'
      ? { to: q.v4, data: IF_Q4.encodeFunctionData('quoteExactInputSingle', [[this.poolKey(hop.row), hop.zeroForOne, amountIn, '0x']]) }
      : { to: q.v3, data: IF_Q3.encodeFunctionData('quoteExactInputSingle', [[hop.tokenIn, hop.tokenOut, amountIn, Number(hop.row.fee), 0]]) })));
    const out = [];
    items.forEach((it, i) => {
      if (!res[i] || res[i] === '0x') return;
      try {
        const amountOut = BigInt((it.hop.row.venue === 'v4' ? IF_Q4 : IF_Q3).decodeFunctionResult('quoteExactInputSingle', res[i])[0]);
        if (amountOut > 0n) out.push({ ...it, amountOut });
      } catch { /* not a quote */ }
    });
    return out;
  }

  hopsFor(tokenIn, tokenOut) {
    return this.pools(tokenIn, tokenOut).map((row) => ({ row, tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), zeroForOne: lc(tokenIn) === lc(row.token0) }));
  }

  // Every route the Quoter can price, best first:
  // [{ hops: [hop…], outs: [amount…], amountOut, wrapIn, unwrapOut }].
  async routes(tokenIn, tokenOut, amountIn) {
    const a = lc(tokenIn), b = lc(tokenOut);
    const native = lc(this.chain.ADDR.native), weth = lc(this.chain.ADDR.weth);
    const ethLike = (t) => t === native || t === weth;
    // Native ETH can enter or leave as WETH: the router wraps/unwraps in the same tx.
    const ends = (t) => (t === native && weth ? [native, weth] : [t]);
    await this.ensureDiscovered([a, b, ...this.mids().filter((m) => !isNative(m))]);
    const found = [];
    const jobs = [];
    for (const ai of ends(a)) {
      for (const bi of ends(b)) {
        if (ai === bi) continue;
        const flags = { wrapIn: ai !== a, unwrapOut: bi !== b };
        jobs.push(this.quoteHops(this.hopsFor(ai, bi).map((hop) => ({ hop, amountIn })))
          .then((r) => r.forEach((x) => found.push({ hops: [x.hop], outs: [x.amountOut], amountOut: x.amountOut, ...flags }))));
        // A middle token never repeats an end; when either end is ETH-like, neither ETH form is a middle.
        const mids = this.mids().filter((m) => m !== ai && m !== bi && !((ethLike(ai) || ethLike(bi)) && ethLike(m)));
        for (const m of mids) jobs.push(this.twoHop(ai, m, bi, amountIn, flags, found));
      }
    }
    await Promise.all(jobs);
    return found.sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : x.hops.length - y.hops.length));
  }

  async twoHop(a, m, b, amountIn, flags, found) {
    const first = this.hopsFor(a, m), second = this.hopsFor(m, b);
    if (!first.length || !second.length) return;
    const leg1 = (await this.quoteHops(first.map((hop) => ({ hop, amountIn }))))
      .sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : 0)).slice(0, LEG1_KEEP);
    const items = leg1.flatMap((l1) => second
      // The v3 router pays out ERC20 only; a native middle token cannot feed or leave a v3 hop.
      .filter((hop) => !(isNative(m) && (hop.row.venue === 'v3' || l1.hop.row.venue === 'v3')))
      .map((hop) => ({ hop, amountIn: l1.amountOut, l1 })));
    for (const x of await this.quoteHops(items)) {
      found.push({ hops: [x.l1.hop, x.hop], outs: [x.l1.amountOut, x.amountOut], amountOut: x.amountOut, ...flags });
    }
  }

  feeLabel(r) {
    const fee = Number(r.fee);
    return fee & DYNAMIC_FEE ? 'fee dinamis' : `${+(fee / 10_000).toFixed(4)}%`;
  }
  symbol(t) {
    const A = this.chain.ADDR, Q = this.chain.QUOTES || {};
    if (lc(t) === lc(A.native)) return this.chain.nativeSymbol || 'ETH';
    return Q[lc(t)]?.symbol || null;
  }
  toQuote(route) {
    const leg = (h) => `${h.row.venue} ${this.feeLabel(h.row)}${isZeroAddr(h.row.hooks) ? '' : ' hook'}`;
    const via = route.hops.length > 1 ? ` via ${this.symbol(route.hops[0].tokenOut) || route.hops[0].tokenOut.slice(0, 8)}` : '';
    const wrap = route.wrapIn ? ' (wrap ETH)' : route.unwrapOut ? ' (unwrap WETH)' : '';
    return {
      amountOut: route.amountOut, usdIn: null, usdOut: null, aggregator: this.id,
      dex: `Uniswap: ${route.hops.map(leg).join(' → ')}${via}${wrap}`,
      pools: route.hops.map((h) => h.row.pool_ref),
    };
  }

  // Quote in the shared shape ({ amountOut, usdIn, usdOut, dex, aggregator }). Cached 10 s.
  async quote(tokenIn, tokenOut, amountIn) {
    if (!this.enabled() || amountIn <= 0n) return null;
    const key = `${lc(tokenIn)}:${lc(tokenOut)}:${amountIn}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.q;
    let q = null;
    try {
      const best = (await this.routes(tokenIn, tokenOut, amountIn))[0];
      q = best ? this.toQuote(best) : null;
    } catch (e) { this.warn(`Uniswap quote: ${e.message}`); }
    this.cache.set(key, { at: Date.now(), q });
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    return q;
  }

  async quoteRetry(tokenIn, tokenOut, amountIn, tries = 2) {
    for (let i = 0; ; i++) {
      const q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q || i >= tries - 1) return q;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }

  // ---- calldata ----
  v4SwapParam(h, amountIn, minOut, layout) {
    return layout === 'hop'
      ? coder.encode([`tuple(${PK} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)`],
        [[this.poolKey(h.row), h.zeroForOne, amountIn, minOut, 0n, '0x']])
      : coder.encode([`tuple(${PK} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`],
        [[this.poolKey(h.row), h.zeroForOne, amountIn, minOut, '0x']]);
  }

  // One UniversalRouter tx for a route. Consecutive hops on the same venue share one command;
  // between commands the middle token waits in the router. Only the final output carries a
  // minimum: the last swap's, or UNWRAP_WETH's when the route ends in WETH for a native output.
  buildRoute(route, amountIn, minOut, layout, deadline) {
    const me = this.exec.address();
    const groups = [];
    for (const h of route.hops) {
      const g = groups[groups.length - 1];
      if (g && g.venue === h.row.venue) g.hops.push(h); else groups.push({ venue: h.row.venue, hops: [h] });
    }
    let commands = '0x';
    const inputs = [];
    const cmd = (c, input) => { commands += c.toString(16).padStart(2, '0'); inputs.push(input); };
    if (route.wrapIn) cmd(CMD.WRAP_ETH, coder.encode(['address', 'uint256'], [SENTINEL.ADDRESS_THIS, amountIn]));
    groups.forEach((g, gi) => {
      // fromRouter: the input already sits in the router (wrapped ETH, or an earlier command's
      // output). toRouter: the output stays there for the next command (or the unwrap).
      const fromRouter = gi > 0 || !!route.wrapIn;
      const toRouter = gi < groups.length - 1 || !!route.unwrapOut;
      const min = toRouter ? 0n : minOut;
      const gIn = g.hops[0].tokenIn, gOut = g.hops[g.hops.length - 1].tokenOut;
      if (g.venue === 'v3') {
        const parts = [gIn];
        for (const h of g.hops) parts.push(ethers.toBeHex(Number(h.row.fee), 3), h.tokenOut);
        cmd(CMD.V3_SWAP_EXACT_IN, coder.encode(['address', 'uint256', 'uint256', 'bytes', 'bool', 'uint256[]'], [
          toRouter ? SENTINEL.ADDRESS_THIS : me, fromRouter ? SENTINEL.CONTRACT_BALANCE : amountIn, min, ethers.concat(parts), !fromRouter, [],
        ]));
        return;
      }
      const acts = [], params = [];
      if (fromRouter) { acts.push(ACT.SETTLE); params.push(coder.encode(['address', 'uint256', 'bool'], [gIn, SENTINEL.CONTRACT_BALANCE, false])); }
      g.hops.forEach((h, hi) => {
        acts.push(ACT.SWAP_EXACT_IN_SINGLE);
        const lastHop = hi === g.hops.length - 1;
        params.push(this.v4SwapParam(h, !fromRouter && hi === 0 ? amountIn : SENTINEL.OPEN_DELTA, lastHop ? min : 0n, layout));
      });
      if (!fromRouter) { acts.push(ACT.SETTLE_ALL); params.push(coder.encode(['address', 'uint256'], [gIn, amountIn])); }
      if (toRouter) { acts.push(ACT.TAKE); params.push(coder.encode(['address', 'address', 'uint256'], [gOut, SENTINEL.ADDRESS_THIS, SENTINEL.OPEN_DELTA])); }
      else { acts.push(ACT.TAKE_ALL); params.push(coder.encode(['address', 'uint256'], [gOut, minOut])); }
      cmd(CMD.V4_SWAP, coder.encode(['bytes', 'bytes[]'], [actionsHex(acts), params]));
    });
    if (route.unwrapOut) cmd(CMD.UNWRAP_WETH, coder.encode(['address', 'uint256'], [me, minOut]));
    return {
      to: this.chain.ADDR.universalRouter,
      data: IF_UR.encodeFunctionData('execute', [commands, inputs, deadline]),
      value: route.wrapIn || isNative(route.hops[0].tokenIn) ? String(amountIn) : '0',
    };
  }

  // Same contract as Kyber#swap: { hash, amountOut, quote, receipt }; null = no route;
  // errors tagged e.loss / e.reverted / e.pending / e.guard.
  async swap(tokenIn, tokenOut, amountIn, { slippageBps = 150, maxLossBps = null, kind = 'kyber_swap', detail = null, ref = null, requireLoss = false } = {}) {
    if (!this.enabled() || amountIn <= 0n) return null;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const slip = Math.min(slippageBps * (attempt + 1), maxLossBps || slippageBps * 3);
      try {
        const r = await this.attempt(tokenIn, tokenOut, amountIn, { slippageBps: slip, maxLossBps, kind, detail, ref, requireLoss });
        if (r || attempt === 2) return r;
      } catch (e) {
        lastErr = e;
        if (e.pending || e.guard || e.loss) throw e;
        if (!e.reverted && !e.simulated) throw e;
        this.log(`swap Uniswap percobaan ${attempt + 1} tertolak (${e.message}) — kutipan ulang`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr || new Error('swap Uniswap gagal setelah 3 percobaan');
  }

  async attempt(tokenIn, tokenOut, amountIn, { slippageBps, maxLossBps, kind, detail, ref, requireLoss }) {
    const me = this.exec.address();
    const guard = (msg) => { const e = new Error(msg); e.guard = true; return e; };

    const ranked = await this.routes(tokenIn, tokenOut, amountIn);
    if (!ranked.length) return null;
    const q = this.toQuote(ranked[0]);

    const loss = Kyber.routeLoss(q, ref);
    if (maxLossBps != null && requireLoss && !loss) throw guard('rugi rute tidak terukur (Uniswap tanpa harga USD dan tanpa pembanding) — tidak dijual');
    if (maxLossBps != null && loss && loss.bps > maxLossBps) {
      const e = new Error(`rute Uniswap rugi ${(loss.bps / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%) — $${loss.usdIn.toFixed(2)} → $${loss.usdOut.toFixed(2)}`);
      e.loss = { lossBps: loss.bps, maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut, dex: q.dex };
      throw e;
    }

    for (const a of await this.exec.ensureRouterAllowance(tokenIn)) {
      const h = await this.exec.send(a, { kind: a.kind });
      if (!(await this.exec.waitReceipt(h)).ok) throw guard(`izin token untuk Uniswap gagal (${h})`);
    }

    // Dry-run the best few routes (both v4 layouts when a v4 hop is in it) in one batch; the
    // first that passes, in quote order, is sent with its own Quoter amount as the basis.
    const deadline = this.exec.deadline();
    const tries = [];
    for (const route of ranked.slice(0, MAX_SIMULATED)) {
      const minOut = (route.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      const layouts = route.hops.some((h) => h.row.venue === 'v4') ? LAYOUTS : [null];
      for (const layout of layouts) tries.push({ route, minOut, layout, tx: this.buildRoute(route, amountIn, minOut, layout, deadline) });
    }
    const sim = await this.rpc.batch(tries.map((c) => {
      const tx = { to: c.tx.to, data: c.tx.data, from: me };
      if (c.tx.value != null && BigInt(c.tx.value) > 0n) tx.value = '0x' + BigInt(c.tx.value).toString(16);
      return { method: 'eth_call', params: [tx, 'latest'] };
    }));
    const ok = sim.findIndex((r) => r && !r.error);
    if (ok < 0) {
      const blind = sim.some((r) => !r || r.transient || (r.error && !RpcPool.isRevert(r.error)));
      const e = new Error(blind ? 'simulasi swap Uniswap tidak terjawab RPC' : `${Math.min(ranked.length, MAX_SIMULATED)} rute Uniswap teratas menolak swap saat disimulasikan`);
      e.simulated = true;
      throw e;
    }
    const pick = tries[ok];
    const used = pick.route === ranked[0] ? q : this.toQuote(pick.route);
    if (pick.route !== ranked[0]) this.log(`Uniswap: rute terbaik menolak simulasi — pakai ${used.dex}`);
    if (lc(pick.tx.to) !== lc(this.chain.ADDR.universalRouter)) throw guard(`tx Uniswap janggal: tujuan ${pick.tx.to} bukan UniversalRouter`);

    const outBal = async () => (await this.exec.balances([tokenOut])).get(lc(tokenOut)) || 0n;
    const before = await outBal();
    const hash = await this.exec.send({ to: pick.tx.to, data: pick.tx.data, value: String(pick.tx.value || '0'), gasMul: 2 }, { kind, detail: {
      tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), amountInRaw: amountIn.toString(),
      ...(detail || {}), aggregator: this.id, dex: used.dex, uniswapPools: used.pools, usdIn: used.usdIn, usdOut: used.usdOut,
    } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) { const e = new Error(`swap Uniswap ${hash} belum terkonfirmasi setelah 90 detik`); e.pending = true; e.txHash = hash; throw e; }
    if (!rc.ok) { const e = new Error(`swap Uniswap gagal (${hash})`); e.reverted = true; e.txHash = hash; throw e; }

    let amountOut = null;
    if (!isNative(tokenOut)) {
      let v = 0n;
      for (const l of rc.receipt?.logs || []) {
        if (lc(l.address) !== lc(tokenOut) || l.topics[0] !== TOPIC_XFER || l.topics.length !== 3) continue;
        if (lc('0x' + l.topics[2].slice(-40)) === lc(me)) v += BigInt(l.data);
        if (lc('0x' + l.topics[1].slice(-40)) === lc(me)) v -= BigInt(l.data);
      }
      if (v > 0n) amountOut = v;
      else if (rc.receipt?.logs?.length) {
        const e = new Error(`swap Uniswap ${hash} berhasil di chain tapi ${tokenOut} tidak masuk ke wallet kita — periksa tx-nya`);
        e.guard = true; e.txHash = hash;
        throw e;
      }
    }
    if (amountOut == null) {
      const after = await outBal();
      amountOut = after > before ? after - before : null;
    }
    if (amountOut != null && used.amountOut > 0n) {
      const slipBps = Number(((used.amountOut - amountOut) * 10_000n) / used.amountOut);
      this.exec.noteTx?.(hash, { quotedOut: used.amountOut.toString(), gotOut: amountOut.toString(), slipBps, execSlipUsd: null });
    }
    return { hash, amountOut, quote: used, receipt: rc.receipt };
  }
}

module.exports = { Uniswap, QUOTERS };
