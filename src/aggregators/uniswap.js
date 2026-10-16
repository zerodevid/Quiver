'use strict';
// Uniswap, straight on chain: no API, no key. Quotes come from Uniswap's own Quoter
// contracts (V4Quoter for v4 pools, QuoterV2 for v3 pools) — exact amounts, ticks crossed and
// hooks run included, unlike the constant-liquidity estimate in swappool.js. The swap goes
// through the chain's UniversalRouter into the single best pool.
//
// Scope: single hop, pools of EXACTLY this pair that the pools table knows (the scanner
// records every pool it has seen). No wrap step: a native-ETH leg only meets v4 pools that
// hold native ETH, a WETH leg only meets WETH pools. Only Uniswap venues ('v4' and the
// chain's Uniswap v3 'v3'); a fork such as PancakeSwap is not reachable through this router.
//
// Guards before anything is sent:
//   1. the calldata is built here (Executor#buildSwapV4/V3), to the chain's UniversalRouter;
//   2. minimum output = fresh Quoter amount − slippage, enforced by the router itself;
//   3. the exact tx is dry-run with eth_call from our wallet (both v4 param layouts, top
//      pools in one batch) — a hook or pool that rejects the swap costs no gas. Many memecoin
//      pools have hooks that reject the Quoter or the router; those simply have no route here;
//   4. the same USD loss gate as every other aggregator (Kyber.routeLoss);
//   5. after the tx, the output must have reached OUR wallet (receipt Transfer logs).
// Approvals go through Permit2 to the UniversalRouter (Executor#ensureRouterAllowance), the
// same path the direct-pool fallback already uses.
const { ethers } = require('ethers');
const { ensureChain } = require('../networks');
const { Kyber } = require('../kyber');
const { RpcPool } = require('../rpc');
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
const TOPIC_XFER = ethers.id('Transfer(address,address,uint256)');
const DYNAMIC_FEE = 0x800000;
const MAX_POOLS = 12;      // quoted per pair, one eth_call batch
const MAX_SIMULATED = 3;   // best-quoted pools dry-run before sending
const isZeroAddr = (a) => !a || /^0x0+$/.test(a);
// Both v4 swap param layouts are dry-run on every swap, never just a remembered one: measured
// 2026-10-16 on Robinhood, the same hooked ETH/USDG pool took 'limit' for ETH→USDG but only
// 'plain' for USDG→ETH (PoolManager reverted 0x4713c18b on the price limit).
const LAYOUTS = ['limit', 'plain'];

class Uniswap {
  constructor({ exec, rpc, cfg, chain, log, store }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.chain = ensureChain(chain); this.store = store;
    this.log = log || (() => {});
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

  // Uniswap pools of exactly this pair: v4 always, v3 only on the Uniswap venue.
  pools(tokenIn, tokenOut) {
    const a = lc(tokenIn), b = lc(tokenOut);
    const q = this.quoters();
    const rows = this.store.all(`SELECT pool_ref, venue, token0, token1, fee, tick_spacing, hooks, pool_addr FROM pools
      WHERE chain=? AND ((token0=? AND token1=?) OR (token0=? AND token1=?))`, this.chain.network, a, b, b, a);
    return rows.filter((r) => (r.venue === 'v4' && q.v4) || (r.venue === 'v3' && q.v3 && r.pool_addr)).slice(0, MAX_POOLS * 2);
  }

  poolKey(r) {
    return [r.token0, r.token1, Number(r.fee), Number(r.tick_spacing), r.hooks || ethers.ZeroAddress];
  }

  // Every pool's exact output from the Quoter, best first: [{ row, amountOut, zeroForOne }].
  async quotePools(tokenIn, tokenOut, amountIn) {
    const q = this.quoters();
    // Plain pools first when there are more than the batch takes: hooked ones reject more often.
    const rows = this.pools(tokenIn, tokenOut)
      .sort((x, y) => (isZeroAddr(y.hooks) ? 1 : 0) - (isZeroAddr(x.hooks) ? 1 : 0))
      .slice(0, MAX_POOLS);
    if (!rows.length) return [];
    const calls = rows.map((r) => {
      const zeroForOne = lc(tokenIn) === lc(r.token0);
      return r.venue === 'v4'
        ? { to: q.v4, data: IF_Q4.encodeFunctionData('quoteExactInputSingle', [[this.poolKey(r), zeroForOne, amountIn, '0x']]) }
        : { to: q.v3, data: IF_Q3.encodeFunctionData('quoteExactInputSingle', [[tokenIn, tokenOut, amountIn, Number(r.fee), 0]]) };
    });
    const res = await this.rpc.ethCallMany(calls);
    const out = [];
    rows.forEach((r, i) => {
      if (!res[i] || res[i] === '0x') return;
      try {
        const d = (r.venue === 'v4' ? IF_Q4 : IF_Q3).decodeFunctionResult('quoteExactInputSingle', res[i]);
        const amountOut = BigInt(d[0]);
        if (amountOut > 0n) out.push({ row: r, amountOut, zeroForOne: lc(tokenIn) === lc(r.token0) });
      } catch { /* not a quote */ }
    });
    return out.sort((x, y) => (y.amountOut > x.amountOut ? 1 : y.amountOut < x.amountOut ? -1 : 0));
  }

  feeLabel(r) {
    const fee = Number(r.fee);
    return fee & DYNAMIC_FEE ? 'fee dinamis' : `${+(fee / 10_000).toFixed(4)}%`;
  }
  toQuote(p) {
    return {
      amountOut: p.amountOut, usdIn: null, usdOut: null, aggregator: this.id,
      dex: `Uniswap: ${p.row.venue} ${this.feeLabel(p.row)}${isZeroAddr(p.row.hooks) ? '' : ' hook'}`,
      pool: p.row.pool_ref,
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
      const best = (await this.quotePools(tokenIn, tokenOut, amountIn))[0];
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

    const ranked = await this.quotePools(tokenIn, tokenOut, amountIn);
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

    // Dry-run the best few pools (both v4 layouts while the router's is unknown) in one batch;
    // the first that passes, in quote order, is sent with its own Quoter amount as the basis.
    const deadline = this.exec.deadline();
    const tries = [];
    for (const p of ranked.slice(0, MAX_SIMULATED)) {
      const minOut = (p.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
      if (p.row.venue === 'v4') {
        const pk = { currency0: p.row.token0, currency1: p.row.token1, fee: Number(p.row.fee), tickSpacing: Number(p.row.tick_spacing), hooks: p.row.hooks || ethers.ZeroAddress };
        for (const layout of LAYOUTS) tries.push({ p, minOut, layout, tx: this.exec.buildSwapV4(pk, p.zeroForOne, amountIn, minOut, deadline, layout) });
      } else {
        tries.push({ p, minOut, tx: this.exec.buildSwapV3(tokenIn, tokenOut, Number(p.row.fee), amountIn, minOut, deadline) });
      }
    }
    const sim = await this.rpc.batch(tries.map((c) => {
      const tx = { to: c.tx.to, data: c.tx.data, from: me };
      if (c.tx.value != null && BigInt(c.tx.value) > 0n) tx.value = '0x' + BigInt(c.tx.value).toString(16);
      return { method: 'eth_call', params: [tx, 'latest'] };
    }));
    const ok = sim.findIndex((r) => r && !r.error);
    if (ok < 0) {
      const blind = sim.some((r) => !r || r.transient || (r.error && !RpcPool.isRevert(r.error)));
      const e = new Error(blind ? 'simulasi swap Uniswap tidak terjawab RPC' : `${Math.min(ranked.length, MAX_SIMULATED)} pool Uniswap teratas menolak swap saat disimulasikan`);
      e.simulated = true;
      throw e;
    }
    const pick = tries[ok];
    const used = pick.p === ranked[0] ? q : this.toQuote(pick.p);
    if (pick.p !== ranked[0]) this.log(`Uniswap: pool terbaik menolak simulasi — pakai ${used.dex}`);
    if (lc(pick.tx.to) !== lc(this.chain.ADDR.universalRouter)) throw guard(`tx Uniswap janggal: tujuan ${pick.tx.to} bukan UniversalRouter`);

    const outBal = async () => (await this.exec.balances([tokenOut])).get(lc(tokenOut)) || 0n;
    const before = await outBal();
    const hash = await this.exec.send({ to: pick.tx.to, data: pick.tx.data, value: String(pick.tx.value || '0'), gasMul: 2 }, { kind, detail: {
      tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), amountInRaw: amountIn.toString(),
      ...(detail || {}), aggregator: this.id, dex: used.dex, uniswapPool: pick.p.row.pool_ref, usdIn: used.usdIn, usdOut: used.usdOut,
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
