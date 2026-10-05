'use strict';
// Token logos from GeckoTerminal (fallback: DexScreener) — fetched by the SERVER, stored in data/icons/, then
// served from the dashboard's own origin via GET /api/icon?a=0x….
//
// Why not <img src="https://coin-images.coingecko.com/…"> directly in the browser:
//  - the browser would tell a third party which tokens are being viewed;
//  - GeckoTerminal limits ~30 calls/minute per IP — a dashboard open on
//    several devices quickly exhausts the quota, whereas the server needs only one call per token;
//  - an already stored logo still shows while GeckoTerminal is down.
//
// Security: images are served from the same origin as the dashboard (which holds the
// login cookie). So the file type is determined from its BYTES, not from the origin
// server's header, and SVG is rejected — an SVG can carry a script that would run if the
// URL is opened directly.
const fs = require('node:fs');
const path = require('node:path');

const apiFor = (slug) => `https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/multi/`;
// Fallback: DexScreener stores the logo uploaded by the token's creator via its profile —
// covering some tokens that GeckoTerminal still has as "missing.png".
const dsApiFor = (slug) => `https://api.dexscreener.com/tokens/v1/${slug}/`;
const BATCH = 30;                    // address limit per /tokens/multi call
const GAP_MS = 2500;                 // ~24 calls/minute, under the limit of 30
const MAX_BYTES = 1_000_000;
const RETRY_NONE_MS = 12 * 3600e3;   // new tokens are often only given a logo later
const RETRY_ERR_MS = 10 * 60e3;
// Format requested from the CDN. WebP is deliberately not named: resvg (share card,
// src/share-card.js) cannot read it, so a WebP logo shows on the dashboard but becomes an
// initial on the card. GeckoTerminal & DexScreener send PNG/JPEG if WebP is not
// requested; a CDN that still sends WebP (CoinGecko) is stored as-is and retried
// every RETRY_NONE_MS in case it has changed.
const ACCEPT = 'image/png,image/jpeg,image/gif';
const ZERO = '0x0000000000000000000000000000000000000000';

// Signatures of accepted image files.
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['png', 'image/png'];
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8') return ['gif', 'image/gif'];
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  return null;
}
const isEvmAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);
const isBase58 = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

class Icons {
  constructor({ store, dir, chain = null, log = () => {}, fetchImpl = globalThis.fetch, gapMs = GAP_MS, collectMs = 150, now = Date.now }) {
    this.store = store; this.dir = dir; this.log = log; this.fetch = fetchImpl;
    this.network = chain?.network || 'robinhood';
    // Solana: alamat base58 PEKA HURUF (tidak di-lowercase); ikon cadangan dari Jupiter.
    this.chain = chain;
    this.sol = chain?.kind === 'solana';
    this.lc = this.sol ? (x) => String(x || '').trim() : (x) => String(x || '').toLowerCase();
    this.isAddr = this.sol ? isBase58 : isEvmAddr;
    this.API = apiFor(chain?.geckoterminal || 'robinhood');
    this.DS_API = dsApiFor(chain?.dexscreener || 'robinhood');
    this.gapMs = gapMs; this.collectMs = collectMs; this.now = now;
    this.want = new Set();
    this.waiters = new Map();          // address -> [resolve]
    this.running = false;
    this.lastCall = 0;
    this.stats = { calls: 0, ok: 0, none: 0, errors: 0 };
    fs.mkdirSync(dir, { recursive: true });
  }

  row(a) { return this.store.get('SELECT * FROM icons WHERE chain=? AND address=?', this.network, a); }

  // Record the failure/absence — but an already stored logo (e.g. a WebP being
  // replaced by a PNG) must not vanish just because its retry failed.
  // A WebP logo that failed to update is retried after RETRY_ERR_MS, instead of waiting
  // the full RETRY_NONE_MS like a WebP that was just downloaded.
  keep(a, status, src = null) {
    const prev = this.row(a);
    if (prev?.status === 'ok' && prev.file && fs.existsSync(path.join(this.dir, prev.file))) {
      this.save(a, 'ok', prev.file, prev.ctype, prev.src, this.now() - RETRY_NONE_MS + RETRY_ERR_MS);
    } else this.save(a, status, null, null, src);
  }
  save(a, status, file = null, ctype = null, src = null, ts = this.now()) {
    this.store.run(`INSERT INTO icons(chain,address,status,file,ctype,src,checked_ts) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET status=excluded.status, file=excluded.file, ctype=excluded.ctype,
      src=excluded.src, checked_ts=excluded.checked_ts`, this.network, a, status, file, ctype, src, ts);
  }

  // Does GeckoTerminal still need to be asked?
  stale(r) {
    if (!r) return true;
    if (r.status === 'ok') {
      if (!r.file || !fs.existsSync(path.join(this.dir, r.file))) return true;
      return r.ctype === 'image/webp' && this.now() - (r.checked_ts || 0) > RETRY_NONE_MS;
    }
    return this.now() - (r.checked_ts || 0) > (r.status === 'none' ? RETRY_NONE_MS : RETRY_ERR_MS);
  }

  read(a) {
    const r = this.row(a);
    if (r?.status !== 'ok' || !r.file) return null;
    try { return { buf: fs.readFileSync(path.join(this.dir, r.file)), ctype: r.ctype }; } catch { return null; }
  }

  // The logo of one token. `wait` = how long the first fetch may be waited for.
  async get(addr, { wait = 0 } = {}) {
    const a = this.lc(addr);
    if (!this.isAddr(a) || a === ZERO) return null;
    if (!this.stale(this.row(a))) return this.read(a);
    if (!wait) { this.enqueue([a]); return this.read(a); }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, wait);
      const list = this.waiters.get(a) || [];
      list.push(() => { clearTimeout(t); resolve(); });
      this.waiters.set(a, list);
      this.enqueue([a]);
    });
    return this.read(a);
  }

  enqueue(addrs) {
    for (const x of addrs) {
      const a = this.lc(x);
      if (this.isAddr(a) && a !== ZERO && this.stale(this.row(a))) this.want.add(a);
    }
    if (this.want.size && !this.running) this.loop().catch((e) => this.log(`logo: ${e.message}`));
  }

  // Warm-up: every token the database knows, so the first time a page
  // is opened it already has logos.
  warm() {
    const rows = this.store.all(`SELECT address a FROM tokens WHERE chain=?
      UNION SELECT token0 FROM wpositions WHERE chain=? UNION SELECT token1 FROM wpositions WHERE chain=?`, this.network, this.network, this.network);
    this.enqueue(rows.map((r) => r.a));
    return this.want.size;
  }

  wake(a) {
    for (const f of this.waiters.get(a) || []) f();
    this.waiters.delete(a);
  }

  async loop() {
    this.running = true;
    try {
      // A page of 60 rows requests 60 logos within milliseconds. Without this collection
      // delay, the first request would go out alone and spend one call of the
      // quota on a single token.
      await new Promise((r) => setTimeout(r, this.collectMs));
      while (this.want.size) {
        const batch = [...this.want].slice(0, BATCH);
        batch.forEach((a) => this.want.delete(a));
        const delay = this.lastCall + this.gapMs - this.now();
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        this.lastCall = this.now();
        await this.lookup(batch);
        batch.forEach((a) => this.wake(a));
      }
    } finally { this.running = false; }
  }

  async lookup(batch) {
    this.stats.calls++;
    let data;
    try {
      const r = await this.fetch(this.API + batch.join(','), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) throw new Error('GeckoTerminal 429 (batas panggilan)');
      if (!r.ok) throw new Error(`GeckoTerminal HTTP ${r.status}`);
      data = (await r.json())?.data || [];
    } catch (e) {
      this.stats.errors++;
      this.log(`logo: ${e.message} — ${batch.length} token dicoba lagi nanti`);
      for (const a of batch) this.keep(a, 'err');
      return;
    }
    const url = new Map();
    for (const d of data) {
      const u = d.attributes?.image_url;
      // "missing.png" = GeckoTerminal knows the token but has no logo for it.
      if (u && !/missing/i.test(u) && /^https:\/\//.test(u)) url.set(this.lc(d.attributes.address), u);
    }
    const short = batch.filter((a) => !url.has(a));
    if (short.length) {
      try {
        const r = await this.fetch(this.DS_API + short.join(','), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        const pairs = r.ok ? await r.json() : [];
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const a = this.lc(p.baseToken?.address);
          const u = p.info?.imageUrl;
          if (short.includes(a) && !url.has(a) && /^https:\/\//.test(u || '')) url.set(a, u);
        }
      } catch { /* fallback only: GeckoTerminal already answered */ }
    }
    // Solana: Jupiter mengenal logo hampir semua token SPL (termasuk memecoin baru yang
    // belum terindeks GeckoTerminal/DexScreener).
    const sisa = batch.filter((a) => !url.has(a));
    if (this.sol && sisa.length && this.chain?.jup?.tokenInfo) {
      try {
        const info = await this.chain.jup.tokenInfo(sisa);
        for (const a of sisa) { const u = info.get(a)?.icon; if (/^https:\/\//.test(u || '')) url.set(a, u); }
      } catch { /* cadangan saja */ }
    }
    for (const a of batch) {
      const prev = this.row(a);
      const u = url.get(a);
      if (!u) { this.keep(a, 'none'); this.stats.none++; continue; }
      try {
        // Request a format sniff() can recognise; a CDN with "format=auto" may
        // send AVIF to a client that did not state its preference.
        const g = await this.fetch(u, { headers: { accept: ACCEPT }, signal: AbortSignal.timeout(15_000) });
        if (!g.ok) throw new Error(`HTTP ${g.status}`);
        const buf = Buffer.from(await g.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error(`terlalu besar (${buf.length} byte)`);
        const kind = sniff(buf);
        if (!kind) { this.keep(a, 'none', u); this.stats.none++; continue; }
        const file = this.network === 'robinhood' ? `${a}.${kind[0]}` : `${this.network}-${a}.${kind[0]}`;
        fs.writeFileSync(path.join(this.dir, file), buf);
        if (prev?.file && prev.file !== file) fs.rmSync(path.join(this.dir, prev.file), { force: true });
        this.save(a, 'ok', file, kind[1], u);
        this.stats.ok++;
      } catch {
        this.stats.errors++;
        this.keep(a, 'err', u);
      }
    }
  }
}

module.exports = { Icons, sniff };
