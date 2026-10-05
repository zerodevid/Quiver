'use strict';
const { ensureChain } = require('./networks');
// Swap through the KyberSwap aggregator.
//
// Why not go straight to the pool: tested 2026-09-11 with eth_call simulation from the bot
// wallet, of 14 ETH/USDG pools only 2 accept a swap via the UniversalRouter — the rest are
// rejected by their own hook (WrappedError from beforeSwap). Most memecoin pools
// also refuse (an empty revert inside the callback). Kyber routes across ALL DEXes and
// pools on this chain, and its path is already proven on the same wallet by the
// robinhood-lp bot. The direct pool path still exists as a fallback in the engine.
//
// Kyber calldata cannot be read, so every swap goes through 4 safeguards before it is sent
// (adapted from robinhood-lp-bot/src/chain/kyber.ts):
//   1. the built routerAddress MUST equal the whitelisted router; tx.to is always
//      that whitelisted address, never an address from the API.
//   2. the ETH value sent == amountIn for native ETH, otherwise 0.
//   3. the built amountIn == the requested amountIn (cannot spend more).
//   4. the built amountOut >= quote − slippage (does not shift when encoded).
const { ethers } = require('ethers');

const DEFAULT_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5'; // MetaAggregationRouterV2 (verified on chain 4663)
const API_BASE = 'https://aggregator-api.kyberswap.com';          // + /<chain>/api/v1, chain = profile.kyberPath
const ZERO = '0x0000000000000000000000000000000000000000';       // native = currency 0x0 (the same on every chain)
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';        // Kyber's sentinel for native ETH
const HEADERS = { 'x-client-id': 'quiver' };
const IF_ERC20 = new ethers.Interface([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
]);

const kTok = (t) => (String(t).toLowerCase() === ZERO ? NATIVE : t);
// MetaAggregationRouterV2: two entry points, both carrying SwapDescriptionV2 —
// verified from real build calldata (2026-09-13: selector 0xe21fd0e9).
const DESC = 'tuple(address srcToken,address dstToken,address[] srcReceivers,uint256[] srcAmounts,address[] feeReceivers,uint256[] feeAmounts,address dstReceiver,uint256 amount,uint256 minReturnAmount,uint256 flags,bytes permit)';
const IF_ROUTER = new ethers.Interface([
  `function swap(tuple(address callTarget,address approveTarget,bytes targetData,${DESC} desc,bytes clientData) execution)`,
  `function swapSimpleMode(address caller,${DESC} desc,bytes executorData,bytes clientData)`,
]);
const sameTok = (a, b) => String(a).toLowerCase() === String(kTok(b)).toLowerCase();

class Kyber {
  constructor({ exec, rpc, cfg, chain, log }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.chain = ensureChain(chain); this.log = log || (() => {});
  }
  router() { return ethers.getAddress(this.cfg.swap?.kyber_router || DEFAULT_ROUTER); }
  api() { return this.cfg.swap?.kyber_api || `${API_BASE}/${this.chain?.kyberPath || 'robinhood'}/api/v1`; }
  enabled() { return this.cfg.swap?.kyber !== false; }

  // Quote of the best route. null if there is no route (the caller may use a fallback).
  async quote(tokenIn, tokenOut, amountIn) {
    const u = new URL(`${this.api()}/routes`);
    u.searchParams.set('tokenIn', kTok(tokenIn));
    u.searchParams.set('tokenOut', kTok(tokenOut));
    u.searchParams.set('amountIn', amountIn.toString());
    u.searchParams.set('gasInclude', 'true');
    try {
      const r = await fetch(u, { headers: HEADERS, signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.code !== 0 || !j?.data?.routeSummary) return null;
      const rs = j.data.routeSummary;
      return {
        routeSummary: rs, routerAddress: j.data.routerAddress,
        amountOut: BigInt(rs.amountOut),
        usdIn: Number(rs.amountInUsd) || null, usdOut: Number(rs.amountOutUsd) || null,
        dex: [...new Set((rs.route || []).flat().map((h) => h.exchange))].join('+'),
      };
    } catch { return null; }
  }

  // Quote with several attempts. quote() swallows ALL failures into null —
  // timeout, 5xx, a route momentarily "not found" — so a caller that fires once and then
  // falls through to the fallback path can cancel the operation because of a momentary disturbance. Exactly that
  // happened to the lp2 bridge on 25 Sep 2026: a single null quote, the fallback a direct
  // pool that on this chain is certain to be refused, the entry cancelled. attempt() has long retried
  // its quote 3x for the same reason; this provides that for outside callers.
  async quoteRetry(tokenIn, tokenOut, amountIn, tries = 3) {
    for (let i = 0; ; i++) {
      const q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q || i >= tries - 1) return q;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }

  async build(routeSummary, sender, slippageBps) {
    try {
      const r = await fetch(`${this.api()}/route/build`, {
        method: 'POST',
        headers: { ...HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ routeSummary, sender, recipient: sender, slippageTolerance: slippageBps, source: 'quiver', enableGasEstimation: false }),
        signal: AbortSignal.timeout(20_000),
      });
      const j = await r.json().catch(() => null);
      if (!r.ok || j?.code !== 0 || !j?.data?.data) return null;
      return j.data;
    } catch { return null; }
  }

  // The contents of the calldata the API returned: where the swap result is sent, which token, how much
  // is paid, and the minimum received. null if the shape is not recognised —
  // calldata that cannot be read is never sent.
  static inspect(data) {
    let p;
    try { p = IF_ROUTER.parseTransaction({ data }); } catch { return null; }
    if (!p) return null;
    const d = p.name === 'swap' ? p.args[0].desc : p.args[1];
    return { fn: p.name, srcToken: d.srcToken, dstToken: d.dstToken, dstReceiver: d.dstReceiver, amount: BigInt(d.amount), minReturn: BigInt(d.minReturnAmount) };
  }

  // Route loss in bps (pool fee + price impact), by Kyber's own USD values.
  //
  // `ref` = an independent comparator from the caller, used for the side Kyber does NOT
  // price: { usdIn, usdPerOut, outDecimals }. This is not decoration. Kyber returns empty
  // amountInUsd/amountOutUsd precisely for thin memecoins that most need the loss-limit gate,
  // and that used to make this function return null — while the gate
  // was written `loss != null && loss > limit`, so the gate was skipped SILENTLY. Measured
  // 17 Sep 2026 over 244 swaps since capital started being recorded: the 223 swaps that have a USD price
  // were off +0.4% from the close price estimate, the 21 swaps without a USD price were off −33.6%
  // (−$105; −$100 of it from one position, #82, whose gate rejected it
  // many times at 42–57% and then let it through once a quote came without a USD price).
  //
  // When selling leftovers, the exit side can ALWAYS be valued on its own — the token coming out is a quote
  // asset — so a single side from Kyber is enough to measure.
  static routeLoss(q, ref = null) {
    if (!q) return null;
    const usdIn = (q.usdIn ?? ref?.usdIn) || null;
    const usdOut = q.usdOut ?? (ref?.usdPerOut != null && ref?.outDecimals != null
      ? (Number(q.amountOut) / 10 ** ref.outDecimals) * ref.usdPerOut
      : null);
    if (!(usdIn > 0) || usdOut == null) return null;
    return { bps: ((usdIn - usdOut) / usdIn) * 10_000, usdIn, usdOut };
  }
  static lossBps(q, ref = null) { return Kyber.routeLoss(q, ref)?.bps ?? null; }

  /**
   * Exact-in swap. Returns { hash, amountOut, quote } — amountOut is measured from the
   * balance difference, not from the quote. null if Kyber cannot route (the caller
   * may use a fallback). Throws an error if a safeguard fails or the loss limit is exceeded
   * — never silently sends something unsafe.
   *
   * The thrown error is flagged so the caller can tell the cause: `e.loss`
   * (the route is above the loss limit, carries the figure), `e.reverted` (rejected by the chain through
   * the third attempt), `e.pending` (receipt not yet read — the tx may still land,
   * never repeat). One without a flag = a safeguard failed. The engine only diverts
   * `loss`/`reverted` to a direct pool; the rest stop the operation.
   */
  async swap(tokenIn, tokenOut, amountIn, { slippageBps = 150, maxLossBps = null, kind = 'kyber_swap', detail = null, ref = null, requireLoss = false } = {}) {
    if (!this.enabled() || amountIn <= 0n) return null;
    const me = this.exec.address();
    const nativeIn = String(tokenIn).toLowerCase() === ZERO;
    // A Kyber quote goes stale quickly on a fast-moving memecoin: minOut is already
    // locked into the calldata, so a price that shifts by more than the slippage makes the
    // tx get rejected "Return amount is not enough". Fetch a fresh quote and retry.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Tolerance is raised gradually ONLY when retrying: 1x, 2x, 3x. The first attempt
      // stays tight so a fair price is not sacrificed; the loosening is
      // only used if the price really is moving fast. The route loss limit (maxLossBps)
      // is not loosened, so a bad route is still rejected.
      const slip = Math.min(slippageBps * (attempt + 1), maxLossBps || slippageBps * 3);
      try {
        const r = await this.attempt(tokenIn, tokenOut, amountIn, { slippageBps: slip, maxLossBps, kind, detail, me, nativeIn, ref, requireLoss });
        if (r || attempt === 2) return r;
      } catch (e) {
        lastErr = e;
        // Only a stale price is worth retrying; the safety gate & loss limit are not. A swap
        // that REVERTED on chain is also retried (stale quote, #154 12 Sep: the zap was cancelled although
        // the next second the same route passed) — a revert does not move any tokens.
        // What is NEVER retried: a receipt not yet read (the tx may still land).
        if (e.pending) throw e;
        if (!(e.reverted || /Return amount is not enough|not enough|slippage|revert/i.test(e.message)) || /router Kyber tidak cocok|nilai ETH tx|menyimpang|rugi/.test(e.message)) throw e;
        this.log(`swap Kyber percobaan ${attempt + 1} tertolak harga basi — kutipan ulang, toleransi ${(Math.min(slippageBps * (attempt + 2), maxLossBps || slippageBps * 3) / 100).toFixed(1)}%`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr || new Error('swap Kyber gagal setelah 3 percobaan');
  }

  async attempt(tokenIn, tokenOut, amountIn, { slippageBps, maxLossBps, kind, detail, me, nativeIn, ref = null, requireLoss = false }) {
    // A route is sometimes momentarily "not found" although a few seconds later there is one — try 3 times.
    let q = null, built = null;
    for (let i = 0; i < 3 && !built; i++) {
      q = await this.quote(tokenIn, tokenOut, amountIn);
      if (q) built = await this.build(q.routeSummary, me, slippageBps);
      if (!built && i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
    if (!q || !built) return null;

    const loss = Kyber.routeLoss(q, ref);
    // Unmeasurable = not sent, for callers that ask for it (automatic sales).
    // "Not knowing how much it loses" is not a legitimate reason to dump a token without a limit; what is
    // unmeasurable goes to the retry queue and is reported, not executed blind.
    if (maxLossBps != null && requireLoss && !loss) {
      throw new Error('rugi rute tidak terukur (Kyber tanpa harga USD dan tanpa pembanding) — tidak dijual');
    }
    if (maxLossBps != null && loss && loss.bps > maxLossBps) {
      const e = new Error(`rute Kyber rugi ${(loss.bps / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%) — $${loss.usdIn.toFixed(2)} → $${loss.usdOut.toFixed(2)}`);
      // The figures are carried along so the "leftover not yet sold" warning can show
      // the token value vs what can be withdrawn without parsing the error text.
      e.loss = { lossBps: loss.bps, maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut, dex: q.dex || null };
      throw e;
    }

    // ---- safeguards ----
    if (ethers.getAddress(built.routerAddress) !== this.router()) {
      throw new Error(`router Kyber tidak cocok: ${built.routerAddress} ≠ whitelist`);
    }
    const value = BigInt(built.transactionValue ?? '0');
    if (value !== (nativeIn ? amountIn : 0n)) throw new Error(`nilai ETH tx Kyber janggal: ${value}, seharusnya ${nativeIn ? amountIn : 0n}`);
    const minOut = (q.amountOut * BigInt(10_000 - slippageBps)) / 10_000n;
    if (BigInt(built.amountIn) !== amountIn || BigInt(built.amountOut) < minOut) {
      throw new Error(`hasil build Kyber menyimpang (masuk ${built.amountIn}, keluar ${built.amountOut} < ${minOut})`);
    }
    // 5. The figures above are only the API's claims about itself. What gets executed is
    //    the calldata: it is read and matched — result recipient = our wallet, the right token,
    //    pay amount = amountIn, minimum receive ≥ quote − 2× slippage (the build uses its own
    //    amountOut as the basis for minReturn). An API that changes/is hijacked cannot
    //    direct the result to another address or empty out minReturn.
    const cd = Kyber.inspect(built.data);
    if (!cd) throw new Error('calldata Kyber tidak dikenali — tidak dikirim');
    if (String(cd.dstReceiver).toLowerCase() !== String(me).toLowerCase()) throw new Error(`calldata Kyber janggal: penerima ${cd.dstReceiver} bukan wallet kita`);
    if (!sameTok(cd.srcToken, tokenIn) || !sameTok(cd.dstToken, tokenOut)) throw new Error(`calldata Kyber janggal: token ${cd.srcToken}→${cd.dstToken}`);
    if (cd.amount !== amountIn) throw new Error(`calldata Kyber janggal: jumlah bayar ${cd.amount} ≠ ${amountIn}`);
    const floor = (q.amountOut * BigInt(Math.max(0, 10_000 - 2 * slippageBps))) / 10_000n;
    if (cd.minReturn < floor) throw new Error(`calldata Kyber janggal: minimum terima ${cd.minReturn} < ${floor}`);

    // Allowance for the input token: exactly amountIn, directly to the whitelisted router.
    if (!nativeIn) {
      const [a] = await this.rpc.ethCallMany([{ to: tokenIn, data: IF_ERC20.encodeFunctionData('allowance', [me, this.router()]) }]);
      if (!a || BigInt(a) < amountIn) {
        const h = await this.exec.send({ to: tokenIn, data: IF_ERC20.encodeFunctionData('approve', [this.router(), amountIn]) }, { kind: 'approve_kyber' });
        if (!(await this.exec.waitReceipt(h)).ok) throw new Error(`izin token untuk Kyber gagal (${h})`);
      }
    }

    const outBal = async () => (await this.exec.balances([tokenOut])).get(String(tokenOut).toLowerCase()) || 0n;
    const before = await outBal();
    const tx = { to: this.router(), data: built.data, value: value.toString(), gasMul: 2 };
    // The token & amount in are recorded on every swap so the Swap history can write
    // "1,200 MEME → 4.1 USDG" for zaps, leftover sales, bridges etc. — not just the USD value.
    const hash = await this.exec.send(tx, { kind, detail: {
      tokenIn: String(tokenIn).toLowerCase(), tokenOut: String(tokenOut).toLowerCase(), amountInRaw: amountIn.toString(),
      ...(detail || {}), dex: q.dex, usdIn: q.usdIn, usdOut: q.usdOut,
    } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) {
      const e = new Error(`swap Kyber ${hash} belum terkonfirmasi setelah 90 detik`);
      e.pending = true; e.txHash = hash;
      throw e;
    }
    if (!rc.ok) { const e = new Error(`swap Kyber gagal (${hash})`); e.reverted = true; e.txHash = hash; throw e; }
    // The result is read from the Transfer log in the receipt (certainly this tx's). The balance
    // difference is only a fallback (native ETH): a node lagging by one block once gave 0 —
    // and that 0 was then recorded as "leftover sold for $0". Unreadable = null, the caller
    // uses the Kyber quote as an estimate, not zero.
    let amountOut = null;
    if (String(tokenOut).toLowerCase() !== ZERO) {
      const TOPIC_XFER = ethers.id('Transfer(address,address,uint256)');
      let v = 0n;
      for (const l of rc.receipt?.logs || []) {
        if (String(l.address).toLowerCase() !== String(tokenOut).toLowerCase() || l.topics[0] !== TOPIC_XFER || l.topics.length !== 3) continue;
        if (('0x' + l.topics[2].slice(-40)).toLowerCase() === String(me).toLowerCase()) v += BigInt(l.data);
        if (('0x' + l.topics[1].slice(-40)).toLowerCase() === String(me).toLowerCase()) v -= BigInt(l.data);
      }
      if (v > 0n) amountOut = v;
    }
    if (amountOut == null) {
      const after = await outBal();
      amountOut = after > before ? after - before : null;
    }
    // What was actually received vs what was quoted — the price shift at execution
    // (pure slippage, outside the route fee). Recorded on its own row so
    // each position's cost can cite the figure, not just estimate.
    if (amountOut != null && q.amountOut > 0n) {
      const slipBps = Number(((q.amountOut - amountOut) * 10_000n) / q.amountOut);
      this.exec.noteTx(hash, {
        quotedOut: q.amountOut.toString(), gotOut: amountOut.toString(), slipBps,
        // The USD value of that shift, using the exit side's price from the same quote.
        execSlipUsd: q.usdOut != null ? (q.usdOut * slipBps) / 10_000 : null,
      });
    }
    return { hash, amountOut, quote: q, receipt: rc.receipt };
  }
}

module.exports = { Kyber, KYBER_NATIVE: NATIVE, DEFAULT_ROUTER };
