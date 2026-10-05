'use strict';
// RPC pool for Robinhood Chain.
//
// Two real problems handled here:
//  1. The ISP (Telkomsel) hijacks the DNS of `rpc.mainnet.chain.robinhood.com` to its
//     internetbaik portal, so TLS fails with "altnames do not match". The fix is to
//     resolve via DoH 1.1.1.1 (an IP address, needs no DNS) then pin that IP
//     to the connection while still using the original SNI/hostname so the certificate is valid.
//  2. `eth_getLogs` is limited to 10,000 logs per query and the official endpoint replies 429
//     when heavy calls come back to back — hence an inflight queue + failover.
const https = require('node:https');
const { URL } = require('node:url');
const { RpcCache } = require('./rpccache');

const DOH = 'https://1.1.1.1/dns-query';

function spanOf(filter) {
  const n = (v) => (typeof v === 'string' && v.startsWith('0x') ? parseInt(v, 16) : null);
  const a = n(filter.fromBlock), b = n(filter.toBlock);
  return a != null && b != null ? Math.max(0, b - a) : 0;
}

class RpcPool {
  constructor(endpoints, log = console.log, opts = {}) {
    this.eps = endpoints.map((e) => this.makeEp(e));
    this.log = log;
    this.maxInflight = opts.max_inflight || 3;
    this.useDoh = opts.dns_over_https !== false;
    this.inflight = 0;
    this.queue = [];
    this.dns = new Map();      // host -> { ips:[], until }
    this.agents = new Map();   // host|ip -> https.Agent
    this.id = 1;
    // eth_getLogs is the heaviest call and the only one that makes the official
    // endpoint reply 429. The main engine, the wallet scanner, and scout all go through here,
    // so its quota is managed centrally: at most N at once and a minimum gap between sends.
    this.logsMax = opts.logs_concurrency || 2;
    this.logsGapMs = opts.logs_gap_ms ?? 150;
    this.logsActive = 0;
    this.logsQueue = [];
    this.logsLast = 0;
    // block ≈ 0.1 second: 20 blocks ≈ 2 seconds of delay in reading a target action
    this.headMargin = opts.head_margin_blocks ?? 20;
    // Slack of the HARD limit above the socket timeout (see post): enough for a reply
    // that is flowing slowly, not enough to hang forever.
    this.hardMarginMs = opts.hard_margin_ms ?? 5000;
    // The latest chain height seen from the reply of any endpoint. Used by the
    // cache to decide whether a block is deep enough to store; never
    // used to decide up to which block to scan (that is safeHead).
    this.head = 0;
    // Cache of answers that are already final (src/rpccache.js). Without a `store` — e.g. a
    // temporary pool to test an endpoint on the Settings page — there is no cache.
    const c = opts.cache;
    this.cache = c && c.store && c.enabled !== false ? new RpcCache({ log, ...c }) : null;
  }

  noteHead(n) { if (Number.isFinite(n) && n > this.head) this.head = n; }

  async logsSlot(priority = false) {
    if (this.logsActive < this.logsMax && !this.logsQueue.length) { this.logsActive++; }
    else {
      // Priority work (the copy engine following the latest blocks) is slotted in
      // at the front of the queue; wallet history scanning waits behind.
      await new Promise((res) => (priority ? this.logsQueue.unshift(res) : this.logsQueue.push(res)));
    }
    const wait = this.logsLast + this.logsGapMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.logsLast = Date.now();
  }
  logsRelease() {
    const next = this.logsQueue.shift();
    if (next) next(); else this.logsActive--;
  }

  makeEp(e) {
    return {
      url: e.url, headers: e.headers || null, maxBatch: e.max_batch || 40, weight: e.weight ?? 1,
      // Not every endpoint can do everything. publicnode, for example, is fastest for
      // eth_call (120ms) but refuses eth_getLogs beyond the last ~10 blocks with
      // "Archive requests require a personal token". If this is not distinguished, half of the
      // scans fail silently.
      noLogs: !!e.no_logs,
      // Archive node: can eth_call at a past block. Only ordofi turned out to be able to —
      // the official endpoint replies "metadata is not found", publicnode 403.
      archive: !!e.archive,
      maxLogBlocks: e.max_log_blocks || 0,
      // A read-only endpoint that refuses eth_sendRawTransaction ("Method not found").
      // Can be set in the config; otherwise it is flagged by itself the first time it refuses.
      noSend: !!e.no_send,
      fails: 0, cooldownUntil: 0, calls: 0, errors: 0, lastMs: 0, inflight: 0,
      // Rest SPECIFICALLY for getLogs: an endpoint that replies with a JSON-RPC error for getLogs
      // ("historical state is not available", "network is busy", "time budget") is often
      // still healthy for eth_call — so only its getLogs share is redirected.
      logsCooldownUntil: 0, logsErrors: 0,
    };
  }

  // Replace the endpoint list while running (from the Settings page). Stats of endpoints
  // whose URL did not change are kept; old keep-alive connections are dropped.
  reconfigure(endpoints) {
    const old = new Map(this.eps.map((e) => [e.url, e]));
    this.eps = endpoints.map((e) => {
      const n = this.makeEp(e);
      const o = old.get(e.url);
      if (o) Object.assign(n, { calls: o.calls, errors: o.errors, logsErrors: o.logsErrors, lastMs: o.lastMs, fails: 0, cooldownUntil: 0 });
      return n;
    });
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
  }

  // ---- DNS ----------------------------------------------------------------
  async resolve(host) {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return [host];
    const hit = this.dns.get(host);
    if (hit && hit.until > Date.now()) return hit.ips;
    let ips = [];
    if (this.useDoh) {
      try {
        const r = await fetch(`${DOH}?name=${encodeURIComponent(host)}&type=A`, {
          headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      } catch (e) { this.log(`doh gagal ${host}: ${e.message}`); }
    }
    this.dns.set(host, { ips, until: Date.now() + 60_000 });
    return ips;
  }

  agentFor(host, ips) {
    const list = (ips || []).filter(Boolean);
    const key = `${host}|${list.join(',')}`;
    let a = this.agents.get(key);
    if (!a) {
      // Node >= 20 calls lookup with {all:true} (autoSelectFamily), so its callback
      // must return an array — otherwise the result is ERR_INVALID_IP_ADDRESS: undefined.
      const lookup = list.length
        ? (h, o, cb) => (o && o.all
            ? cb(null, list.map((address) => ({ address, family: 4 })))
            : cb(null, list[0], 4))
        : undefined;
      a = new https.Agent({ keepAlive: true, maxSockets: 8, timeout: 30_000, lookup });
      this.agents.set(key, a);
    }
    return a;
  }

  // A single HTTP request MUST finish — succeed or fail. https' built-in `timeout` option
  // only measures socket IDLENESS and is only installed after the request gets its turn
  // for a socket from the agent; a request that hangs before that, or a socket
  // that dies without emitting 'error' or 'timeout', makes this Promise never
  // settle. Just one like that on the tick path freezes scanning FOREVER
  // (`busy` is never released, and `ep.inflight` never goes down): that is what
  // happened on lpcopy3 2026-09-25 — 15 hours without a single new block scanned, without an error.
  // Hence three nets: a hard wall-clock limit, rejection when the socket
  // closes without a reply, and a one-shot guard so the Promise is not settled
  // twice.
  post(urlStr, body, timeoutMs, ips, extraHeaders = null) {
    const u = new URL(urlStr);
    const hardMs = timeoutMs + this.hardMarginMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      let guard = null;
      const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(guard); fn(v); };
      const req = https.request({
        protocol: u.protocol, hostname: u.hostname, port: u.port || 443,
        path: u.pathname + u.search, method: 'POST',
        servername: u.hostname,
        headers: { ...(extraHeaders || {}), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': 'quiver/1.0' },
        agent: this.agentFor(u.hostname, ips), timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode !== 200) return done(reject, new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
          try { done(resolve, JSON.parse(text)); } catch { done(reject, new Error(`balasan bukan JSON: ${text.slice(0, 120)}`)); }
        });
      });
      guard = setTimeout(() => {
        req.destroy(new Error('batas keras'));
        done(reject, new Error(`tidak ada balasan dalam ${Math.round(hardMs / 1000)} dtk (batas keras)`));
      }, hardMs);
      // Deliberately NOT unref'd: this guard is exactly what must stay alive when
      // the request itself no longer holds any handle.
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (e) => done(reject, e));
      // The socket closed without a complete reply and without 'error' (a keep-alive
      // cut by the server exactly as it is reused). A successful reply has already
      // called done() at 'end', so this never overwrites a legitimate result.
      req.on('close', () => done(reject, new Error('koneksi tertutup tanpa balasan')));
      req.end(body);
    });
  }

  // ---- queue ------------------------------------------------------------
  async slot() {
    if (this.inflight < this.maxInflight) { this.inflight++; return; }
    await new Promise((res) => this.queue.push(res));
  }
  release() {
    const next = this.queue.shift();
    if (next) next(); else this.inflight--;
  }

  allCooling() { return this.allCoolingFor(false); }
  coolingFor() {
    const now = Date.now();
    return Math.max(0, Math.min(...this.eps.map((e) => e.cooldownUntil)) - now);
  }

  // Endpoints that may be used for this batch of calls, IN PRIORITY ORDER:
  // the list order in the config/Settings page is its order. The top one is used
  // while healthy; one that is resting (failed, 429) drops to the back so
  // calls fall to the next fallback, and returns to the top once its rest
  // is over. (It used to be sorted by least busy to spread the load — but
  // the owner wants to decide which endpoint is relied on first.)
  // logSpan: the width of the getLogs block range. Endpoints with a smaller max_log_blocks
  // are skipped — ordofi, for instance, hangs ~60 seconds then replies "network is busy"
  // for a 40k-block range, while the official endpoint answers 900k blocks in 0.34 seconds.
  canServe(e, needsLogs, logSpan, needsArchive = false) {
    if (needsArchive && !e.archive) return false;
    if (!needsLogs) return true;
    if (e.noLogs) return false;
    return !(e.maxLogBlocks && logSpan > e.maxLogBlocks);
  }

  // Until when the endpoint rests for this kind of call.
  coolUntil(e, needsLogs) { return needsLogs ? Math.max(e.cooldownUntil, e.logsCooldownUntil) : e.cooldownUntil; }

  usable(needsLogs = false, logSpan = 0, needsArchive = false) {
    const now = Date.now();
    let pool = this.eps.filter((e) => this.canServe(e, needsLogs, logSpan, needsArchive));
    if (needsArchive && !pool.length) return [];
    if (!pool.length) pool = this.eps;             // nothing matches: just try
    const ok = pool.filter((e) => this.coolUntil(e, needsLogs) < now);      // the list order is kept
    if (ok.length) return ok;
    // all resting: try anyway, starting with the one whose rest ends soonest
    return pool.slice().sort((a, b) => this.coolUntil(a, needsLogs) - this.coolUntil(b, needsLogs));
  }

  allCoolingFor(needsLogs = false, logSpan = 0, needsArchive = false) {
    const now = Date.now();
    const pool = this.eps.filter((e) => this.canServe(e, needsLogs, logSpan, needsArchive));
    return (pool.length ? pool : this.eps).every((e) => this.coolUntil(e, needsLogs) > now);
  }

  // The block height that is SAFE for all endpoints. Endpoints can differ by 10-20 blocks
  // (~1-2 seconds). If the cursor is advanced to the head of the fastest endpoint and then getLogs
  // is served by a lagging endpoint, the blocks in between are lost forever —
  // because the cursor has already passed. So the lowest is used.
  //
  // Note: this used to send N identical eth_blockNumber in ONE batch — a batch goes
  // to a single endpoint, so "min" was always = "max" (headSpread always 0) and the top
  // endpoint's quota burned N× every 1.5 seconds. Now a single call; protection from a
  // lagging getLogs endpoint is in _getLogs (the range's end block must exist on the
  // same endpoint that answers its logs).
  async safeHead() {
    const [r] = await this.batch([{ method: 'eth_blockNumber' }]);
    const h = r && !r.error && r.result ? parseInt(r.result, 16) : null;
    if (!h) throw new Error('tidak ada endpoint yang membalas blockNumber');
    this.noteHead(h);
    // A public getLogs endpoint is usually 3–5 blocks behind the fastest endpoint. Without this
    // distance the range end often does not exist there yet and scanning fails repeatedly.
    const safe = h - this.headMargin;
    return { min: safe, max: h, spread: h - safe };
  }

  // A per-item error inside a 200 reply that is TEMPORARY (quota, busy node,
  // lagging node) — not a legitimate answer. An eth_call that reverts is a legitimate answer.
  static transientItemError(err) {
    if (!err) return false;
    const msg = String(err.message || '');
    if (err.code === 3 || /revert/i.test(msg)) return false;
    if ([429, -32005, -32029, -32001, -31001, -32603].includes(err.code)) return true;
    return /429|too many|rate.?limit|exceeded|capacity|busy|timeout|timed out|try again|unavailable|no backend|internal error|header not found|missing trie|historical state|upstream|relay|overload/i.test(msg);
  }

  static isRevert(err) {
    return !!err && (err.code === 3 || /revert/i.test(String(err.message || '')));
  }

  // ---- calling ------------------------------------------------------------
  // calls: [{method, params}] -> parallel results; throws if all endpoints fail
  // `used` (optional): an object filled with {ep} — the endpoint that served last, so the
  // caller can rest it if its 200 reply turned out to contain an error.
  // Calls whose answer is already stored are answered from the cache; only the rest
  // go to the network. `nocache: true` on a call bypasses the cache entirely
  // (used by _getLogs for the range's end block: what is tested there is whether the
  // ENDPOINT already has that block, so a stored answer answers nothing).
  // eth_getLogs is also not stored here but in getLogs(), after the
  // "lagging node" check passes — an empty log list from a lagging node
  // must not be immortalised.
  async batch(calls, opts = {}) {
    if (!this.cache) return this.batchLive(calls, opts);
    const plans = calls.map((c) => (c.nocache || c.method === 'eth_getLogs' ? null : this.cache.plan(c.method, c.params)));
    const out = new Array(calls.length).fill(null);
    const ask = [];
    for (let i = 0; i < calls.length; i++) {
      const hit = plans[i] ? this.cache.get(plans[i], this.head) : undefined;
      if (hit !== undefined) out[i] = { result: hit, cached: true };
      else ask.push(i);
    }
    if (!ask.length) return out;
    const res = await this.batchLive(ask.map((i) => calls[i]), opts);
    ask.forEach((i, k) => {
      out[i] = res[k];
      if (plans[i] && res[k] && !res[k].error && !res[k].transient) this.cache.put(plans[i], res[k].result, this.head);
    });
    return out;
  }

  async batchLive(calls, opts = {}) {
    const out = await this.batchOnce(calls, opts);
    // getLogs has its own failover (_getLogs: a getLogs-specific rest per endpoint).
    if (calls.some((c) => c.method === 'eth_getLogs')) return out;
    // Items that fail TEMPORARILY (a quota error inside a 200 reply, or an item
    // missing from the batch reply) are retried on another endpoint. Such an item used to
    // reach the caller as null — and ethCallMany(null) read as "revert/zero":
    // an unknown NFT owner (target action dropped), zero liquidity (position closed).
    const tries = Math.max(1, Math.min(this.eps.length, 4));
    for (let t = 1; t < tries; t++) {
      const idx = out.map((r, i) => (r?.transient ? i : -1)).filter((i) => i >= 0);
      if (!idx.length) break;
      if (opts.used) opts.used.ep = null;
      let again;
      try { again = await this.batchOnce(idx.map((i) => calls[i]), opts); } catch { break; }
      idx.forEach((i, k) => { out[i] = again[k]; });
    }
    return out;
  }

  async batchOnce(calls, { timeoutMs = 30_000, logSpan = 0, archive = false, used = null } = {}) {
    if (!calls.length) return [];
    const out = new Array(calls.length).fill(null);
    const needsLogs = calls.some((c) => c.method === 'eth_getLogs');
    let pos = 0;
    while (pos < calls.length) {
      const eps = this.usable(needsLogs, logSpan, archive);
      if (!eps.length) throw new Error('tidak ada endpoint arsip terdaftar');
      const ep = eps[0];
      if (used) used.ep = ep;
      const size = Math.min(ep.maxBatch, calls.length - pos);
      const slice = calls.slice(pos, pos + size);
      const payload = slice.map((c) => ({ jsonrpc: '2.0', id: this.id++, method: c.method, params: c.params || [] }));
      const single = payload.length === 1;
      await this.slot();
      const t0 = Date.now();
      ep.inflight++;
      try {
        const ips = await this.resolve(new URL(ep.url).hostname);
        const body = JSON.stringify(single ? payload[0] : payload);
        const res = await this.post(ep.url, body, timeoutMs, ips, ep.headers);
        const arr = single ? [res] : res;
        if (!Array.isArray(arr)) throw new Error(arr?.error?.message || 'balasan batch bukan array');
        const byId = new Map(arr.map((r) => [r?.id, r]));
        let flaky = 0;
        for (let i = 0; i < slice.length; i++) {
          const r = byId.get(payload[i].id);
          if (!r) { out[pos + i] = { error: { message: 'item hilang dari balasan batch' }, transient: true }; flaky++; }
          else if (r.error) {
            const tr = RpcPool.transientItemError(r.error);
            out[pos + i] = tr ? { error: r.error, transient: true } : { error: r.error };
            if (tr) flaky++;
          } else {
            out[pos + i] = { result: r.result ?? null };
            // The chain height is also read from ordinary traffic — no extra call
            // just to know how deeply a block is embedded.
            const c = slice[i];
            if (c.method === 'eth_blockNumber') this.noteHead(parseInt(r.result, 16));
            else if (c.method === 'eth_getBlockByNumber' && !/^0x/.test(String(c.params?.[0] ?? ''))) this.noteHead(parseInt(r.result?.number, 16));
          }
        }
        ep.calls += slice.length; ep.lastMs = Date.now() - t0;
        if (flaky && !needsLogs) {
          // The endpoint answers but part of its contents are quota errors: rest it briefly
          // so retries of those items fall to another endpoint. (getLogs errors are handled by
          // _getLogs with a getLogs-specific rest — that endpoint's eth_call keeps working.)
          ep.errors++; ep.fails++;
          ep.cooldownUntil = Date.now() + Math.min(30_000, 4000 * 2 ** Math.min(ep.fails - 1, 3));
        } else ep.fails = 0;
        pos += size;
      } catch (e) {
        ep.errors++; ep.fails++;
        // 429 means "you are too frequent" — trying again 2 seconds later only
        // prolongs the penalty. An ordinary transport disturbance needs only a short pause.
        const rateLimited = /429|too many requests|network is busy/i.test(e.message);
        const base = rateLimited ? 8000 : 1000;
        ep.cooldownUntil = Date.now() + Math.min(rateLimited ? 60_000 : 30_000, base * 2 ** Math.min(ep.fails - 1, 3));
        this.log(`rpc ${new URL(ep.url).hostname} gagal (${e.message}) — istirahat ${Math.round((ep.cooldownUntil - Date.now()) / 1000)}s`);
        // The slot is released by the `finally` below — which also runs when throwing from here.
        // It used to be released twice: `inflight` went negative and max_inflight no longer
        // limited anything (more 429s precisely when all endpoints are angry).
        if (this.allCoolingFor(needsLogs, logSpan, archive)) {
          throw new Error(`semua endpoint RPC${needsLogs ? ' (yang mendukung getLogs)' : ''} tumbang: ${e.message}`);
        }
      } finally { ep.inflight--; this.release(); }
    }
    return out;
  }

  async call(method, params = [], opts) {
    const [r] = await this.batch([{ method, params }], opts);
    if (!r) throw new Error(`${method}: tidak ada balasan`);
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
  }

  // Broadcast of a signed transaction. Through an ordinary `call`, a JSON-RPC error
  // from ONE endpoint (e.g. "Method not found" from a read-only endpoint) immediately becomes a
  // total failure — a 200 reply containing an error is taken as a legitimate answer, so the pool does not
  // switch endpoints. As a result a target exit failed to be copied although another endpoint
  // could have broadcast it. The same raw tx always has the same hash, so
  // broadcasting it to ALL endpoints at once is safe (it cannot be sent twice)
  // and the most resilient. Not through the inflight queue: a broadcast must not
  // wait behind a heavy getLogs.
  async sendRaw(raw, { timeoutMs = 20_000 } = {}) {
    let eps = this.eps.filter((e) => !e.noSend);
    if (!eps.length) eps = this.eps;
    const errs = [];
    const one = async (ep) => {
      const host = new URL(ep.url).hostname;
      ep.inflight++;
      try {
        const ips = await this.resolve(host);
        const body = JSON.stringify({ jsonrpc: '2.0', id: this.id++, method: 'eth_sendRawTransaction', params: [raw] });
        const res = await this.post(ep.url, body, timeoutMs, ips, ep.headers);
        ep.calls++;
        if (res?.error) {
          const msg = res.error.message || JSON.stringify(res.error);
          if (res.error.code === -32601 || /method not found|method .{0,40}(not supported|not available|does not exist|not allowed|disabled)/i.test(msg)) {
            ep.noSend = true;
            this.log(`rpc ${host} tidak menerima siaran transaksi (${msg}) — dilewati untuk kirim`);
          }
          throw new Error(msg);
        }
        if (!res?.result) throw new Error('tidak ada hash dalam balasan');
        return res.result;
      } catch (e) {
        ep.errors++;
        errs.push(`${host}: ${e.message}`);
        throw e;
      } finally { ep.inflight--; }
    };
    try { return await Promise.any(eps.map(one)); }
    catch { throw new Error(`eth_sendRawTransaction: ${errs.join(' | ')}`); }
  }

  hasArchive() { return this.eps.some((e) => e.archive); }
  // The largest getLogs block range accepted by any endpoint (0 = one has no
  // limit). Long-window scanners cut their requests to follow this figure.
  maxLogSpan() {
    const eps = this.eps.filter((e) => !e.noLogs);
    if (!eps.length || eps.some((e) => !e.maxLogBlocks)) return 0;
    return Math.max(...eps.map((e) => e.maxLogBlocks));
  }

  // eth_call at a past block — only sent to archive endpoints.
  async callAt(to, data, block) {
    const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
    return this.call('eth_call', [{ to, data }, tag], { archive: true });
  }

  async blockNumber() { return parseInt(await this.call('eth_blockNumber'), 16); }

  // eth_getLogs with failover between endpoints when upstream replies with an error.
  //
  // This differs from a transport failure: upstream replies 200 with a JSON-RPC error
  // ("returns more logs than the upstream will serve", "historical state is not
  // available", "the network is busy", "backend exceeded time budget", "invalid block
  // range"), so the pool considers it a success and does not switch endpoints. Only capacity
  // errors used to be redirected; other errors immediately failed the tick — and because
  // the endpoint was not rested, the next tick fell on the same endpoint
  // again: 844 failures of "historical state is not available" in 12 hours, the cursor
  // lagged, a target exit signal was missed. Now ALL getLogs errors
  // rest that endpoint's getLogs share (its eth_call keeps being used) and
  // try the next fallback; it only gives up when all have been tried.
  async getLogs(filter, { priority = false } = {}) {
    // A range already read whose both ends have passed: answered from the
    // cache BEFORE queueing — otherwise a rescan would still pay the gap between
    // getLogs (logs_gap_ms) for data already in hand.
    const plan = this.cache ? this.cache.plan('eth_getLogs', [filter]) : null;
    const hit = plan ? this.cache.get(plan, this.head) : undefined;
    if (hit !== undefined) return hit;
    await this.logsSlot(priority);
    let out;
    try { out = await this._getLogs(filter); } finally { this.logsRelease(); }
    if (plan) this.cache.put(plan, out, this.head);
    return out;
  }

  async _getLogs(filter) {
    const capacityErr = (m) => /more logs than|log.{0,12}limit|too many (?:logs|results)|response size|query returned more/i.test(m || '');
    const busyErr = (m) => /429|too many requests|network is busy|rate limit/i.test(m || '');
    const eligible = this.eps.filter((e) => !e.noLogs);
    const span = spanOf(filter);
    // The range's end block is requested in the SAME batch (one HTTP request, one node).
    // A lagging node replies to getLogs for a block it does not have yet with an EMPTY
    // list without an error — the cursor advances and the target action in that range is lost forever.
    // That node also replies getBlockByNumber(end) = null: that is what is caught here.
    const toTag = typeof filter.toBlock === 'string' && /^0x[0-9a-f]+$/i.test(filter.toBlock) ? filter.toBlock : null;
    let lastErr = null;
    for (let attempt = 0; attempt < Math.max(1, eligible.length); attempt++) {
      const used = {};
      try {
        const calls = [{ method: 'eth_getLogs', params: [filter] }];
        if (toTag) calls.push({ method: 'eth_getBlockByNumber', params: [toTag, false], nocache: true });
        const res = await this.batch(calls, { timeoutMs: 45_000, logSpan: span, used });
        const [lr, br] = res;
        if (!lr) throw new Error('eth_getLogs: tidak ada balasan');
        if (lr.error) throw new Error(`eth_getLogs: ${lr.error.message}`);
        const out = lr.result;
        // Some upstreams reply `result: null` instead of an empty list when failing
        // inside. If that were accepted as "no logs", a block range is
        // lost SILENTLY while the cursor still advances — the target action in that range
        // would never be seen. Treat it as a failure so it is repeated.
        if (!Array.isArray(out)) throw new Error('eth_getLogs mengembalikan hasil bukan daftar');
        if (toTag && (!br || br.error || !br.result)) {
          throw new Error(`endpoint belum sampai blok ${parseInt(toTag, 16)} (node tertinggal)`);
        }
        if (used.ep) used.ep.logsStreak = 0;
        return out;
      } catch (e) {
        lastErr = e;
        // All endpoints are already resting (consecutive transport failures): nothing
        // can be tried right now.
        if (/semua endpoint RPC/.test(e.message)) throw e;
        const ep = used.ep || this.usable(true, span)[0];
        if (!ep) throw e;
        const host = new URL(ep.url).hostname;
        ep.logsErrors++;
        // Capacity: 8 seconds is enough, the next range may be lighter. Busy/429:
        // longer, retrying quickly only prolongs the penalty. Lagging: 10
        // seconds, the node usually catches up. Other errors ("historical state", "time budget",
        // "invalid range"): 20 seconds — a few ticks go through other endpoints first.
        const ms = capacityErr(e.message) ? 8000 : busyErr(e.message) ? 30_000 : /tertinggal/.test(e.message) ? 10_000 : 20_000;
        // Consecutive refusals (ordofi: "more logs than upstream will serve" on almost every
        // range): the rest doubles up to 5 minutes, so attempts are not used up
        // on the same endpoint. A single successful reply returns it to zero.
        ep.logsStreak = (ep.logsStreak || 0) + 1;
        const cool = Math.min(300_000, ms * 2 ** Math.min(ep.logsStreak - 1, 5));
        ep.logsCooldownUntil = Math.max(ep.logsCooldownUntil, Date.now() + cool);
        lastErr = new Error(`${e.message} [${host}]`);
        if (this.allCoolingFor(true, span)) break;
        this.log(`getLogs ${host} gagal (${String(e.message).slice(0, 90)}) — istirahat getLogs ${Math.round(cool / 1000)}s, coba endpoint lain`);
      }
    }
    throw lastErr;
  }

  // Wrapped eth_call: return the hex data or throw with the revert message
  async ethCall(to, data, block = 'latest') {
    return this.call('eth_call', [{ to, data }, block]);
  }

  // Many eth_calls at once. Result: array of hex|null (null = revert/failed)
  //
  // `from` and `value` may be set to simulate a transaction as the bot wallet
  // (balance and allowance are read too) — used to choose the swap pool: a pool that refuses
  // a swap is detected here, before gas is spent. An ordinary read only needs {to, data}.
  //
  // strict: throw if any item still fails TEMPORARILY after being tried on another
  // endpoint — for callers that must not equate "unreadable" with "revert"
  // (e.g. ownerOf: revert = NFT burned, unreadable = do not know yet).
  async ethCallMany(items, block = 'latest', { strict = false } = {}) {
    const res = await this.batch(items.map((i) => {
      const tx = { to: i.to, data: i.data };
      if (i.from) tx.from = i.from;
      if (i.value != null && BigInt(i.value) > 0n) tx.value = '0x' + BigInt(i.value).toString(16);
      return { method: 'eth_call', params: [tx, block] };
    }));
    if (strict) {
      // Only a REVERT may legitimately be read as null. Other errors — temporary, or "block not found"
      // / "state not available" from a node that does not have the requested block — throw:
      // a strict caller would equate null with "NFT burned / liquidity zero".
      const bad = res.find((r) => !r || r.transient || (r.error && !RpcPool.isRevert(r.error)));
      if (bad) throw new Error(`eth_call tidak terbaca dari RPC: ${bad?.error?.message || 'tidak ada balasan'}`);
    }
    return res.map((r) => (r && !r.error ? r.result : null));
  }

  // Cache summary (null = no cache in this pool) — used by the Settings page.
  cacheStats() { return this.cache ? this.cache.stats() : null; }

  stats() {
    return this.eps.map((e) => ({
      host: new URL(e.url).hostname, calls: e.calls, errors: e.errors,
      lastMs: e.lastMs, cooling: e.cooldownUntil > Date.now(),
      logsCooling: e.logsCooldownUntil > Date.now(), logsErrors: e.logsErrors,
      noLogs: e.noLogs, noSend: e.noSend, maxLogBlocks: e.maxLogBlocks, archive: e.archive, inflight: e.inflight, url: e.url,
    }));
  }
}

module.exports = { RpcPool };
