'use strict';
// Logo token dari GeckoTerminal (cadangan: DexScreener) — diambil SERVER, disimpan di data/icons/, lalu
// disajikan dari origin dasbor sendiri lewat GET /api/icon?a=0x….
//
// Kenapa tidak <img src="https://coin-images.coingecko.com/…"> langsung di browser:
//  - browser jadi memberi tahu pihak ketiga token apa saja yang sedang dilihat;
//  - GeckoTerminal membatasi ~30 panggilan/menit per IP — dasbor yang dibuka di
//    beberapa perangkat cepat habis jatahnya, sedangkan server cukup sekali per token;
//  - logo yang sudah tersimpan tetap tampil saat GeckoTerminal sedang down.
//
// Keamanan: gambar disajikan dari origin yang sama dengan dasbor (yang memegang
// cookie login). Jadi tipe berkas ditentukan dari BYTE-nya, bukan dari header
// server asal, dan SVG ditolak — SVG bisa membawa skrip yang akan jalan kalau
// URL-nya dibuka langsung.
const fs = require('node:fs');
const path = require('node:path');

const apiFor = (slug) => `https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/multi/`;
// Cadangan: DexScreener menyimpan logo yang diunggah pembuat token lewat profilnya —
// menutup sebagian token yang di GeckoTerminal masih "missing.png".
const dsApiFor = (slug) => `https://api.dexscreener.com/tokens/v1/${slug}/`;
const BATCH = 30;                    // batas alamat per panggilan /tokens/multi
const GAP_MS = 2500;                 // ~24 panggilan/menit, di bawah batas 30
const MAX_BYTES = 1_000_000;
const RETRY_NONE_MS = 12 * 3600e3;   // token baru sering baru diberi logo belakangan
const RETRY_ERR_MS = 10 * 60e3;
const ZERO = '0x0000000000000000000000000000000000000000';

// Tanda tangan berkas gambar yang diterima.
function sniff(b) {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ['png', 'image/png'];
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ['jpg', 'image/jpeg'];
  if (b.length > 6 && b.toString('ascii', 0, 4) === 'GIF8') return ['gif', 'image/gif'];
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
  return null;
}
const isAddr = (a) => /^0x[0-9a-f]{40}$/.test(a);

class Icons {
  constructor({ store, dir, chain = null, log = () => {}, fetchImpl = globalThis.fetch, gapMs = GAP_MS, collectMs = 150, now = Date.now }) {
    this.store = store; this.dir = dir; this.log = log; this.fetch = fetchImpl;
    this.network = chain?.network || 'robinhood';
    this.API = apiFor(chain?.geckoterminal || 'robinhood');
    this.DS_API = dsApiFor(chain?.dexscreener || 'robinhood');
    this.gapMs = gapMs; this.collectMs = collectMs; this.now = now;
    this.want = new Set();
    this.waiters = new Map();          // alamat -> [resolve]
    this.running = false;
    this.lastCall = 0;
    this.stats = { calls: 0, ok: 0, none: 0, errors: 0 };
    fs.mkdirSync(dir, { recursive: true });
  }

  row(a) { return this.store.get('SELECT * FROM icons WHERE chain=? AND address=?', this.network, a); }
  save(a, status, file = null, ctype = null, src = null) {
    this.store.run(`INSERT INTO icons(chain,address,status,file,ctype,src,checked_ts) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(chain,address) DO UPDATE SET status=excluded.status, file=excluded.file, ctype=excluded.ctype,
      src=excluded.src, checked_ts=excluded.checked_ts`, this.network, a, status, file, ctype, src, this.now());
  }

  // Masih perlu ditanyakan ke GeckoTerminal?
  stale(r) {
    if (!r) return true;
    if (r.status === 'ok') return !r.file || !fs.existsSync(path.join(this.dir, r.file));
    return this.now() - (r.checked_ts || 0) > (r.status === 'none' ? RETRY_NONE_MS : RETRY_ERR_MS);
  }

  read(a) {
    const r = this.row(a);
    if (r?.status !== 'ok' || !r.file) return null;
    try { return { buf: fs.readFileSync(path.join(this.dir, r.file)), ctype: r.ctype }; } catch { return null; }
  }

  // Logo satu token. `wait` = berapa lama boleh menunggu pengambilan pertama.
  async get(addr, { wait = 0 } = {}) {
    const a = String(addr || '').toLowerCase();
    if (!isAddr(a) || a === ZERO) return null;
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
      const a = String(x || '').toLowerCase();
      if (isAddr(a) && a !== ZERO && this.stale(this.row(a))) this.want.add(a);
    }
    if (this.want.size && !this.running) this.loop().catch((e) => this.log(`logo: ${e.message}`));
  }

  // Pemanasan: semua token yang dikenal database, supaya halaman pertama kali
  // dibuka sudah langsung berlogo.
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
      // Halaman berisi 60 baris meminta 60 logo dalam hitungan milidetik. Tanpa jeda
      // pengumpulan ini, permintaan pertama berangkat sendirian dan menghabiskan satu
      // jatah panggilan untuk satu token.
      await new Promise((r) => setTimeout(r, this.collectMs));
      while (this.want.size) {
        const batch = [...this.want].slice(0, BATCH);
        batch.forEach((a) => this.want.delete(a));
        const tunggu = this.lastCall + this.gapMs - this.now();
        if (tunggu > 0) await new Promise((r) => setTimeout(r, tunggu));
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
      for (const a of batch) this.save(a, 'err');
      return;
    }
    const url = new Map();
    for (const d of data) {
      const u = d.attributes?.image_url;
      // "missing.png" = GeckoTerminal tahu tokennya tapi tidak punya logonya.
      if (u && !/missing/i.test(u) && /^https:\/\//.test(u)) url.set(String(d.attributes.address || '').toLowerCase(), u);
    }
    const kurang = batch.filter((a) => !url.has(a));
    if (kurang.length) {
      try {
        const r = await this.fetch(this.DS_API + kurang.join(','), { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
        const pairs = r.ok ? await r.json() : [];
        for (const p of Array.isArray(pairs) ? pairs : []) {
          const a = String(p.baseToken?.address || '').toLowerCase();
          const u = p.info?.imageUrl;
          if (kurang.includes(a) && !url.has(a) && /^https:\/\//.test(u || '')) url.set(a, u);
        }
      } catch { /* cadangan saja — GeckoTerminal sudah menjawab */ }
    }
    for (const a of batch) {
      const u = url.get(a);
      if (!u) { this.save(a, 'none'); this.stats.none++; continue; }
      try {
        // Minta format yang bisa dikenali sniff(); CDN yang "format=auto" bisa
        // mengirim AVIF ke klien yang tidak menyebut pilihannya.
        const g = await this.fetch(u, { headers: { accept: 'image/webp,image/png,image/jpeg,image/gif;q=0.9' }, signal: AbortSignal.timeout(15_000) });
        if (!g.ok) throw new Error(`HTTP ${g.status}`);
        const buf = Buffer.from(await g.arrayBuffer());
        if (buf.length > MAX_BYTES) throw new Error(`terlalu besar (${buf.length} byte)`);
        const kind = sniff(buf);
        if (!kind) { this.save(a, 'none', null, null, u); this.stats.none++; continue; }
        const file = this.network === 'robinhood' ? `${a}.${kind[0]}` : `${this.network}-${a}.${kind[0]}`;
        fs.writeFileSync(path.join(this.dir, file), buf);
        this.save(a, 'ok', file, kind[1], u);
        this.stats.ok++;
      } catch {
        this.stats.errors++;
        this.save(a, 'err', null, null, u);
      }
    }
  }
}

module.exports = { Icons, sniff };
