'use strict';
// Cache of RPC answers that can NO LONGER CHANGE.
//
// Most of the RPC load here is not live data but dead data read
// over and over: the same transaction receipt is read on every sync (30 seconds), past
// block headers are read again each time history is recomputed, balances at past blocks
// are re-read each time the capital tracker splits a range, and getLogs for the same
// block range is requested again each time a wallet is rescanned. The answers cannot
// differ — a block that has passed does not change — yet every read still eats
// the endpoint's quota (Alchemy 429 "monthly capacity", ordofi "network is busy").
//
// So: calls that are TIED to a single past block are stored; the answer is reused
// without touching the network. What is not tied to a block (eth_blockNumber, eth_call
// at `latest`, gas, current balances) never enters here — that is precisely data that
// must always be fresh.
//
// Two layers: a Map in memory (the running process) and the `rpc_cache` table in
// SQLite (survives restarts and deploys). The key includes the chain, so one database
// used by several chains does not get them mixed up.
//
// The "already final" condition: the referenced block must lag at least `confirmations`
// blocks behind the chain head we last saw. While the chain height is not yet
// known (not a single eth_blockNumber yet), nothing is stored.
const crypto = require('node:crypto');

const numTag = (t) => (typeof t === 'string' && /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null);

// A stable key: the order of an object's fields must not change the key (getLogs filters
// are written in different orders by several callers), and upper/lower-case hex is the same.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'string') return v.toLowerCase();
  return String(v);
}
function keyOf(method, params) {
  const s = `${method}|${stable(params || [])}`;
  // Long keys (getLogs filters with many topics) are condensed — the SQLite index
  // does not need to carry a sentence that long.
  return s.length <= 160 ? s : `${method}|#${crypto.createHash('sha1').update(s).digest('hex')}`;
}

// A call whose answer is tied to a single block. `block` = that block; `blockOf` =
// the block is only known from the answer (receipts and transactions carry their own
// blockNumber; while still pending, both are null and nothing is stored).
// What is not here is never stored.
function pinOf(method, params) {
  switch (method) {
    // Chain identity: not tied to any block.
    case 'eth_chainId': return { block: 0 };
    case 'eth_getBlockByNumber': {
      const b = numTag(params?.[0]);      // 'latest'/'pending' -> null, not stored
      return b == null ? null : { block: b };
    }
    case 'eth_getBlockByHash': return { blockOf: (r) => numTag(r?.number) };
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash': return { blockOf: (r) => numTag(r?.blockNumber) };
    case 'eth_getBalance':
    case 'eth_getCode':
    case 'eth_getTransactionCount': {
      const b = numTag(params?.[1]);
      return b == null ? null : { block: b };
    }
    case 'eth_getStorageAt': {
      const b = numTag(params?.[2]);
      return b == null ? null : { block: b };
    }
    // eth_call at a past block (archive node): its result is a pure function of that block's state.
    case 'eth_call': {
      const b = numTag(params?.[1]);
      return b == null ? null : { block: b };
    }
    // A range whose both ends have passed. The reference block is the RIGHT end: that is the one
    // closest to the chain head.
    case 'eth_getLogs': {
      const f = params?.[0];
      if (!f || f.blockHash) return null;
      const a = numTag(f.fromBlock), b = numTag(f.toBlock);
      return a == null || b == null ? null : { block: b };
    }
    default: return null;
  }
}

class RpcCache {
  constructor({ store, chain = 'robinhood', log = () => {}, confirmations = 64, ttl_days = 30,
    max_rows = 100_000, max_entry_kb = 512, max_mb = 200, mem_entries = 3000, mem_mb = 32 } = {}) {
    this.store = store;
    this.chain = chain;
    this.log = log;
    this.conf = Math.max(0, confirmations);
    this.ttlMs = Math.max(1, ttl_days) * 86400_000;
    this.maxRows = Math.max(1, max_rows);
    this.maxEntry = Math.max(1, max_entry_kb) * 1024;
    this.maxBytes = Math.max(1, max_mb) * 1024 * 1024;
    this.memMax = Math.max(0, mem_entries);
    // The memory layer is limited both ways: entry count AND its total in bytes. A single
    // getLogs answer can be hundreds of kilobytes — 3,000 entries like that would take up more
    // process memory than the whole rest of the bot.
    this.memBytesMax = Math.max(1, mem_mb) * 1024 * 1024;
    this.memBytes = 0;
    this.mem = new Map();
    this.hits = 0; this.misses = 0; this.writes = 0; this.tooBig = 0;
    // Per method: hit / miss / not stored. Without this, "is the cache working?"
    // can only be answered by guessing — a combined figure does not tell which method
    // keeps missing (e.g. a receipt whose answer is null and is asked again on every sync).
    this.by = {};
    try { this.sweep(); } catch (e) { this.log(`cache rpc: bersih-bersih awal gagal (${e.message})`); }
  }

  // null = this call may never be stored.
  plan(method, params) {
    const pin = pinOf(method, params);
    return pin ? { ...pin, method, key: keyOf(method, params) } : null;
  }

  // A block that is not deep enough will never be here (put refuses it), so
  // there is no need to ask the database at all: the engine reads fees at block head-3
  // every tick for every position, and that is a pointless query repeated forever. It also
  // keeps the "what percent was answered without the network" figure meaningful — only
  // reads that CAN be stored are counted.
  tooFresh(plan, head) {
    return plan.block != null && plan.block > 0 && (!head || plan.block > head - this.conf);
  }

  tally(method, field) {
    const b = this.by[method] || (this.by[method] = { hit: 0, miss: 0, skip: 0 });
    b[field]++;
  }

  // undefined = not in the cache (a `null` value itself is never stored).
  //
  // What is stored in memory is the JSON TEXT, not the object: every caller
  // receives its own new object. A caller that mutates the answer in place (ethers
  // likes to normalise receipts) would otherwise change the cache contents for
  // all later callers — and that is a very hard bug to trace.
  get(plan, head) {
    if (!plan || this.tooFresh(plan, head)) return undefined;
    const hit = this.mem.get(plan.key);
    if (hit !== undefined) { this.hits++; this.tally(plan.method, 'hit'); return JSON.parse(hit.json); }
    let row;
    try { row = this.store.get('SELECT res FROM rpc_cache WHERE chain=? AND k=?', this.chain, plan.key); }
    catch (e) { this.log(`cache rpc: baca gagal (${e.message})`); return undefined; }
    if (!row) { this.misses++; this.tally(plan.method, 'miss'); return undefined; }
    let val;
    try { val = JSON.parse(row.res); } catch { return undefined; }
    this.remember(plan.key, row.res, Buffer.byteLength(row.res));
    this.hits++; this.tally(plan.method, 'hit');
    return val;
  }

  remember(key, json, bytes) {
    if (!this.memMax) return;
    const old = this.mem.get(key);
    if (old !== undefined) this.memBytes -= old.bytes;
    this.mem.set(key, { json, bytes });
    this.memBytes += bytes;
    // A Map keeps insertion order: the oldest is dropped first.
    while (this.mem.size > this.memMax || this.memBytes > this.memBytesMax) {
      const k = this.mem.keys().next().value;
      if (k === undefined) break;
      this.memBytes -= this.mem.get(k).bytes;
      this.mem.delete(k);
    }
  }

  // head = the last chain height seen (0 = unknown; nothing is stored).
  put(plan, result, head) {
    if (!plan || result == null) return false;
    const block = plan.block != null ? plan.block : plan.blockOf(result);
    // Not stored: a receipt that is still pending (no block yet), or a block that
    // is not deep enough. Counted per method — if `skip` keeps rising while `miss`
    // rises too, that call can simply never be cached.
    if (block == null) { this.tally(plan.method, 'skip'); return false; }
    if (block > 0 && (!head || block > head - this.conf)) { this.tally(plan.method, 'skip'); return false; }
    let res;
    try { res = JSON.stringify(result); } catch { return false; }
    const bytes = Buffer.byteLength(res);
    if (bytes > this.maxEntry) { this.tooBig++; return false; }
    this.remember(plan.key, res, bytes);
    try {
      this.store.run(`INSERT INTO rpc_cache(chain,k,method,block,res,bytes,ts) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(chain,k) DO UPDATE SET res=excluded.res, bytes=excluded.bytes, ts=excluded.ts`,
      this.chain, plan.key, plan.method, block, res, bytes, Date.now());
      this.writes++;
    } catch (e) { this.log(`cache rpc: tulis gagal (${e.message})`); return false; }
    return true;
  }

  // Drop the expired, then the oldest if the table is too large. A lost cache
  // only means one more RPC call — no data is lost with it.
  sweep() {
    const t0 = Date.now();
    this.store.run('DELETE FROM rpc_cache WHERE ts < ?', t0 - this.ttlMs);
    const sum = this.store.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM rpc_cache WHERE chain=?', this.chain) || { n: 0, b: 0 };
    if (sum.n <= this.maxRows && sum.b <= this.maxBytes) return 0;
    // The limit is exceeded: the oldest rows are dropped until both are back under the limit.
    const rows = this.store.all('SELECT ts, bytes FROM rpc_cache WHERE chain=? ORDER BY ts ASC', this.chain);
    let n = sum.n, b = sum.b, cut = 0, dropped = 0;
    for (const r of rows) {
      if (n <= this.maxRows && b <= this.maxBytes) break;
      n--; b -= r.bytes || 0; cut = r.ts; dropped++;
    }
    if (!dropped) return 0;
    this.store.run('DELETE FROM rpc_cache WHERE chain=? AND ts <= ?', this.chain, cut);
    this.mem.clear(); this.memBytes = 0;
    this.log(`cache rpc: ${dropped} entri lama dibuang (batas ${this.maxRows} baris / ${Math.round(this.maxBytes / 1048576)} MB)`);
    return dropped;
  }

  stats() {
    let n = 0, bytes = 0;
    try {
      const r = this.store.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM rpc_cache WHERE chain=?', this.chain);
      n = Number(r?.n || 0); bytes = Number(r?.b || 0);
    } catch { /* the table does not exist yet: show zero */ }
    const asked = this.hits + this.misses;
    return {
      rows: n, bytes, mem: this.mem.size, memBytes: this.memBytes,
      hits: this.hits, misses: this.misses, writes: this.writes, tooBig: this.tooBig, by: this.by,
      hitPct: asked ? Math.round((this.hits / asked) * 100) : 0,
      confirmations: this.conf,
    };
  }
}

module.exports = { RpcCache, keyOf, pinOf };
