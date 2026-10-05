'use strict';
// Shared machinery for the HTTP swap aggregators (OKX, LI.FI, 0x, 1inch, OpenOcean).
//
// Kyber is not built on this: its calldata can be decoded field by field (kyber.js), which
// is a stronger check than anything here. The others return calldata in many router entry
// points, so every one of them goes through the same generic guards before anything is sent:
//   1. tx.to must be that aggregator's router for this chain (whitelist, bytecode verified
//      on chain; config aggregators.<id>.routers can add an upgraded one).
//   2. tx value == amountIn for the native coin, else 0; the API's input amount == amountIn.
//   3. The minimum output the API promises (when it gives one) >= quote − 2× slippage, and
//      the same USD loss gate as Kyber (Kyber.routeLoss).
//   4. Approval goes to the whitelisted spender for EXACTLY amountIn — a bad calldata can
//      never spend more than this one swap.
//   5. The exact tx is simulated with eth_call from our wallet; a revert (or, for routers
//      that return the amount, a result below the floor) stops it before gas is spent.
//   6. After the tx, the output must have reached OUR wallet (receipt Transfer logs).
//
// A subclass supplies: id, label, routers(), spender(), quoteRaw() and buildRaw().
const { ethers } = require('ethers');
const { ensureChain } = require('../networks');
const { Kyber } = require('../kyber');

const ZERO = '0x0000000000000000000000000000000000000000';
const IF_ERC20 = new ethers.Interface([
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
]);
const TOPIC_XFER = ethers.id('Transfer(address,address,uint256)');
const RATE_LIMITED = Symbol('rate limited');
const lc = (a) => String(a || '').toLowerCase();
const isNative = (t) => lc(t) === ZERO;

// One queue per API key (or per aggregator when keyless): every chain in the process
// shares it, and requests leave it at least `gapMs` apart.
const queues = new Map();
function throttled(key, gapMs, fn) {
  const q = queues.get(key) || { tail: Promise.resolve(), last: 0 };
  queues.set(key, q);
  const run = q.tail.then(async () => {
    const wait = q.last + gapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try { return await fn(); } finally { q.last = Date.now(); }
  });
  q.tail = run.catch(() => {});
  return run;
}

// USD value of a raw amount given a unit price and decimals; null when either is missing.
function usdOf(amount, price, decimals) {
  const px = Number(price), dec = Number(decimals);
  return px > 0 && Number.isFinite(dec) ? (Number(amount) / 10 ** dec) * px : null;
}

class ApiAggregator {
  // Subclasses set: id, label, needsKey (bool), gapMs, simReturnsAmount (bool)
  constructor({ exec, rpc, cfg, chain, log, fetch: fetchImpl = null, minGapMs = null }) {
    this.exec = exec; this.rpc = rpc; this.cfg = cfg; this.chain = ensureChain(chain); this.log = log || (() => {});
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.minGapMs = minGapMs;
    this.warned = new Set();
    this.cooldownUntil = 0;
    this.cache = new Map();   // quote cache: key -> { at, q }
  }

  settings() { return this.cfg.aggregators?.[this.id] || {}; }
  apiKey() { return String(this.settings().api_key || ''); }
  hasCredentials() { return !this.needsKey || !!this.apiKey(); }
  supportsChain() { return this.routers().size > 0; }
  // On only when switched on (default on), keyed if it must be, and supported on this chain.
  enabled() { return this.settings().enabled !== false && this.hasCredentials() && this.supportsChain(); }
  // Why it is not usable, for the settings page. null = ready.
  blocker() {
    if (this.settings().enabled === false) return 'dimatikan';
    if (!this.supportsChain()) return 'chain ini belum didukung';
    if (!this.hasCredentials()) return 'butuh API key';
    return null;
  }
  routers() {
    const base = (this.constructor.ROUTERS || {})[this.chain.CHAIN_ID] || [];
    return new Set([...base, ...(this.settings().routers || [])].map(lc));
  }
  gap() { return this.minGapMs ?? this.gapMs ?? 1000; }

  // Throttled HTTP GET returning parsed JSON, or null. `headers` are added by the subclass.
  // 429 (or a subclass-recognised rate-limit body) puts the aggregator on a 60 s cooldown.
  async http(url, { headers = {}, rateLimited = null } = {}) {
    if (Date.now() < this.cooldownUntil) return null;
    for (let i = 0; ; i++) {
      const r = await throttled(`${this.id}:${this.apiKey() || '-'}`, this.gap(), async () => {
        try {
          const res = await this.fetch(url, { headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(15_000) });
          const j = await res.json().catch(() => null);
          if (res.status === 429 || (rateLimited && rateLimited(j))) return RATE_LIMITED;
          return { status: res.status, ok: res.ok, j };
        } catch (e) { return { status: 0, ok: false, j: null, error: e.message }; }
      });
      if (r !== RATE_LIMITED) return r;
      if (i >= 1) {
        this.cooldownUntil = Date.now() + 60_000;
        this.warn(`${this.label}: batas laju API — diistirahatkan 60 dtk`);
        return null;
      }
    }
  }

  warn(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); this.log(msg); } }

  // Quote in Kyber's shape ({ amountOut, usdIn, usdOut, dex }) plus `aggregator`. Cached 10 s:
  // best-route mode asks every aggregator, and the engine re-quotes the same sale often.
  async quote(tokenIn, tokenOut, amountIn) {
    if (!this.enabled() || amountIn <= 0n) return null;
    const key = `${lc(tokenIn)}:${lc(tokenOut)}:${amountIn}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 10_000) return hit.q;
    let q = null;
    try { q = await this.quoteRaw(tokenIn, tokenOut, amountIn); } catch (e) { this.warn(`${this.label} quote: ${e.message}`); q = null; }
    if (q && q.honeypot && !isNative(tokenOut)) { this.warn(`${this.label}: ${tokenOut} ditandai honeypot — rute tidak dipakai`); q = null; }
    if (q) q = { ...q, aggregator: this.id, dex: q.dex ? `${this.label}: ${q.dex}` : this.label };
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
        this.log(`swap ${this.label} percobaan ${attempt + 1} tertolak (${e.message}) — kutipan ulang`);
      }
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
    throw lastErr || new Error(`swap ${this.label} gagal setelah 3 percobaan`);
  }

  async attempt(tokenIn, tokenOut, amountIn, { slippageBps, maxLossBps, kind, detail, ref, requireLoss }) {
    const me = this.exec.address();
    const nativeIn = isNative(tokenIn);
    const guard = (msg) => { const e = new Error(msg); e.guard = true; return e; };
    const L = this.label;

    let b;
    try { b = await this.buildRaw(tokenIn, tokenOut, amountIn, slippageBps, me); } catch (e) { if (e.guard) throw e; this.warn(`${L} build: ${e.message}`); b = null; }
    if (!b?.tx?.to || !b?.tx?.data || !b.quote) return null;
    const q = { ...b.quote, aggregator: this.id, dex: b.quote.dex ? `${L}: ${b.quote.dex}` : L };
    if (q.honeypot && !isNative(tokenOut)) throw guard(`${L}: ${tokenOut} ditandai honeypot — tidak dibeli`);

    const loss = Kyber.routeLoss(q, ref);
    if (maxLossBps != null && requireLoss && !loss) throw guard(`rugi rute tidak terukur (${L} tanpa harga USD dan tanpa pembanding) — tidak dijual`);
    if (maxLossBps != null && loss && loss.bps > maxLossBps) {
      const e = new Error(`rute ${L} rugi ${(loss.bps / 100).toFixed(1)}% (batas ${(maxLossBps / 100).toFixed(1)}%) — $${loss.usdIn.toFixed(2)} → $${loss.usdOut.toFixed(2)}`);
      e.loss = { lossBps: loss.bps, maxLossBps, usdIn: loss.usdIn, usdOut: loss.usdOut, dex: q.dex };
      throw e;
    }

    // ---- guards ----
    const tx = b.tx;
    if (!this.routers().has(lc(tx.to))) throw guard(`router ${L} tidak dikenal: ${tx.to} — kalau memang upgrade resmi, tambahkan ke aggregators.${this.id}.routers`);
    if (tx.from && lc(tx.from) !== lc(me)) throw guard(`tx ${L} janggal: pengirim ${tx.from} bukan wallet kita`);
    const value = BigInt(tx.value || '0');
    if (value !== (nativeIn ? amountIn : 0n)) throw guard(`nilai ETH tx ${L} janggal: ${value}, seharusnya ${nativeIn ? amountIn : 0n}`);
    if (b.fromAmount != null && BigInt(b.fromAmount) !== amountIn) throw guard(`${L} menyimpang: jumlah bayar ${b.fromAmount} ≠ ${amountIn}`);
    const floor = (q.amountOut * BigInt(Math.max(0, 10_000 - 2 * slippageBps))) / 10_000n;
    const minOut = b.minOut != null ? BigInt(b.minOut) : null;
    if (minOut != null && (minOut <= 0n || minOut < floor)) throw guard(`${L} janggal: minimum terima ${minOut} < ${floor}`);
    // Without a promised minimum the dry run's returned amount is the only check left.
    if (minOut == null && !this.simReturnsAmount) throw guard(`${L} tidak memberi minimum terima — tidak dikirim`);

    // Approval: exactly amountIn, to the whitelisted spender only.
    if (!nativeIn) {
      const spender = ethers.getAddress(this.spender(b));
      const [a] = await this.rpc.ethCallMany([{ to: tokenIn, data: IF_ERC20.encodeFunctionData('allowance', [me, spender]) }]);
      if (!a || BigInt(a) < amountIn) {
        const h = await this.exec.send({ to: tokenIn, data: IF_ERC20.encodeFunctionData('approve', [spender, amountIn]) }, { kind: `approve_${this.id}` });
        if (!(await this.exec.waitReceipt(h)).ok) throw guard(`izin token untuk ${L} gagal (${h})`);
      }
    }

    // Dry run of the exact transaction from our wallet.
    const to = ethers.getAddress(tx.to);
    let sim;
    try {
      sim = await this.rpc.call('eth_call', [{ from: me, to, data: tx.data, value: '0x' + value.toString(16) }, 'latest']);
    } catch (e) {
      const err = new Error(`simulasi swap ${L} ditolak: ${String(e.message).slice(0, 160)}`);
      err.simulated = true;
      throw err;
    }
    if (this.simReturnsAmount && typeof sim === 'string' && sim.length >= 66) {
      const ret = BigInt(sim.slice(0, 66));
      const need = minOut ?? floor;
      if (ret < need) throw guard(`simulasi ${L}: hasil ${ret} < minimum ${need}`);
    } else if (this.simReturnsAmount && minOut == null) {
      throw guard(`simulasi ${L} tidak mengembalikan jumlah — tidak dikirim`);
    }

    const outBal = async () => (await this.exec.balances([tokenOut])).get(lc(tokenOut)) || 0n;
    const before = await outBal();
    const hash = await this.exec.send({ to, data: tx.data, value: value.toString(), gasMul: 2 }, { kind, detail: {
      tokenIn: lc(tokenIn), tokenOut: lc(tokenOut), amountInRaw: amountIn.toString(),
      ...(detail || {}), aggregator: this.id, dex: q.dex, usdIn: q.usdIn, usdOut: q.usdOut,
    } });
    const rc = await this.exec.waitReceipt(hash, 90_000);
    if (rc.timeout) { const e = new Error(`swap ${L} ${hash} belum terkonfirmasi setelah 90 detik`); e.pending = true; e.txHash = hash; throw e; }
    if (!rc.ok) { const e = new Error(`swap ${L} gagal (${hash})`); e.reverted = true; e.txHash = hash; throw e; }

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
        const e = new Error(`swap ${L} ${hash} berhasil di chain tapi ${tokenOut} tidak masuk ke wallet kita — periksa tx-nya`);
        e.guard = true; e.txHash = hash;
        throw e;
      }
    }
    if (amountOut == null) {
      const after = await outBal();
      amountOut = after > before ? after - before : null;
    }
    if (amountOut != null && q.amountOut > 0n) {
      const slipBps = Number(((q.amountOut - amountOut) * 10_000n) / q.amountOut);
      this.exec.noteTx?.(hash, {
        quotedOut: q.amountOut.toString(), gotOut: amountOut.toString(), slipBps,
        execSlipUsd: q.usdOut != null ? (q.usdOut * slipBps) / 10_000 : null,
      });
    }
    return { hash, amountOut, quote: q, receipt: rc.receipt };
  }
}

module.exports = { ApiAggregator, usdOf, lc, isNative, ZERO, throttled };
