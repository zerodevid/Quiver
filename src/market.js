'use strict';
const crypto = require('node:crypto');
// Data pasar pihak ketiga untuk halaman detail posisi: statistik pool dari
// DexScreener dan lilin OHLCV dari GeckoTerminal. Dua sumber karena masing-masing
// unggul di satu hal — DexScreener punya volume/transaksi/likuiditas terkini yang
// rapi, GeckoTerminal punya OHLCV per pool (DexScreener tidak membuka API lilin).
//
// Keduanya membatasi panggilan per IP (GeckoTerminal ~30/menit), jadi jawabannya
// disimpan sebentar di memori: dasbor yang dibuka di dua tab, atau poll berkala
// halaman detail, tidak boleh menggandakan panggilan ke luar.
// Slug chain di tiap layanan diambil dari profil chain (networks.js: dexscreener,
// geckoterminal) — satu instance Market per chain.
const dsBase = (slug) => `https://api.dexscreener.com/latest/dex/pairs/${slug}/`;
// Semua pool yang memuat token (maks. 30) — /tokens/v1 hanya memberi satu per token.
const dsTokenBase = (slug) => `https://api.dexscreener.com/token-pairs/v1/${slug}/`;
const gtBase = (slug) => `https://api.geckoterminal.com/api/v2/networks/${slug}/pools/`;
const { gtTradesUrl, normalizeTrades } = require('./trades.mjs');
// OpenAPI resmi GMGN (butuh API key dari gmgn.ai/ai): lilin harga versi GMGN — data
// yang sama dengan chart di gmgn.ai, tapi digambar di chart kita sendiri supaya
// rentang posisi bisa ditumpangkan. Baca-saja cukup header X-APIKEY; paket gratis
// ~1 permintaan/detik per key.
const GMGN_API = 'https://openapi.gmgn.ai';

// Rentang waktu lilin yang ditawarkan UI -> (timeframe, aggregate) GeckoTerminal.
const TF = {
  '1m': ['minute', 1, 60], '5m': ['minute', 5, 300], '15m': ['minute', 15, 900],
  '1h': ['hour', 1, 3600], '4h': ['hour', 4, 14400], '1d': ['day', 1, 86400],
};

class Market {
  // gmgnKey: fungsi yang mengembalikan API key GMGN saat ini (bisa berubah dari
  // halaman Pengaturan tanpa restart), atau null kalau belum diisi.
  constructor({ log, fetch: fetchImpl, chain = null, gmgnKey = null } = {}) {
    this.log = log || (() => {});
    this.fetch = fetchImpl || globalThis.fetch;
    this.gmgnKey = typeof gmgnKey === 'function' ? gmgnKey : () => gmgnKey;
    this.gmgnSlug = chain?.gmgn || chain?.network || 'robinhood';
    this.gmgnCooldown = 0;    // ms — OpenAPI GMGN tidak dipanggil sebelum ini (habis kena limit)
    this.network = chain?.network || 'robinhood';
    this.DS = dsBase(chain?.dexscreener || 'robinhood');
    this.DS_TOKEN = dsTokenBase(chain?.dexscreener || 'robinhood');
    this.gtSlug = chain?.geckoterminal || 'robinhood';
    this.GT = gtBase(this.gtSlug);
    this.cache = new Map();   // key -> { until, value: Promise }
    this.good = new Map();    // key -> { at, value } — jawaban baik terakhir (cadangan)
    this.gtCooldown = 0;      // ms — GeckoTerminal tidak dipanggil sebelum ini (habis kena 429)
  }

  // Satu permintaan yang sama dalam jendela `ttl` ms dijawab dari cache — termasuk
  // yang masih berjalan, supaya dua tab yang membuka detail bersamaan berbagi satu
  // panggilan. Jawaban gagal tidak disimpan lama: coba lagi 10 detik kemudian.
  //
  // Kalau panggilannya GAGAL tetapi kita pernah punya jawaban baik yang belum terlalu
  // tua, jawaban lama itu yang dikembalikan dengan tanda `stale`. GeckoTerminal
  // membatasi panggilan per IP (429) dan satu VPS ini dipakai beberapa instance
  // sekaligus: tanpa cadangan ini, grafik yang tadi tampil mendadak berganti pesan
  // galat hanya karena tetangganya kebetulan menarik data di detik yang sama.
  memo(key, ttl, fn, { staleMs = 15 * 60_000 } = {}) {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.until > now) return hit.value;
    const fallback = (err) => {
      const last = this.good.get(key);
      if (last && Date.now() - last.at < staleMs) {
        const v = { ...last.value, stale: true, staleAt: last.at, staleReason: err };
        this.cache.set(key, { until: Date.now() + 10_000, value: Promise.resolve(v) });
        return v;
      }
      const v = { error: err };
      this.cache.set(key, { until: Date.now() + 10_000, value: Promise.resolve(v) });
      return v;
    };
    const value = fn().then(
      (v) => {
        if (v?.error) return fallback(v.error);
        if (v && typeof v === 'object') this.good.set(key, { at: Date.now(), value: v });
        return v;
      },
      (e) => fallback(e.message),
    );
    this.cache.set(key, { until: now + ttl, value });
    if (this.cache.size > 200) { for (const [k, v] of this.cache) if (v.until <= now) this.cache.delete(k); }
    if (this.good.size > 200) { for (const [k, v] of this.good) if (Date.now() - v.at > staleMs) this.good.delete(k); }
    return value;
  }

  // `tries` > 1 hanya untuk pemanggil yang memang butuh jawabannya sekarang (kartu
  // grafik Telegram): dari VPS, GeckoTerminal bisa menjawab 10+ detik, dan sekali
  // kena batas waktu tombolnya berbalas galat padahal percobaan kedua lolos.
  // Yang dipoll dasbor tetap sekali coba supaya halaman tidak menunggu dua kali.
  //
  // Sekali GeckoTerminal menjawab 429, SEMUA panggilan ke sana ditahan 20 detik
  // (memo lalu menyajikan cadangan/stale): terus menembak saat jatah habis hanya
  // memperpanjang blokirnya untuk ketiga instance di IP ini.
  async json(url, { timeoutMs = 12_000, tries = 1 } = {}) {
    const gt = url.startsWith('https://api.geckoterminal.com/');
    if (gt && this.gtCooldown > Date.now()) throw new Error('batas panggilan (429) — coba lagi sebentar');
    let last = null;
    for (let i = 0; i < tries; i++) {
      try {
        const r = await this.fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
        if (r.status === 429) {
          if (gt) this.gtCooldown = Date.now() + 20_000;
          throw new Error('batas panggilan (429) — coba lagi sebentar');
        }
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      } catch (e) {
        last = e;
        // Yang layak diulang: batas waktu, koneksi putus, dan galat sisi server
        // (502/503/504 — GeckoTerminal sesekali menjawab itu beberapa detik).
        // 429 TIDAK diulang: itu justru minta kita berhenti sebentar.
        const layak = /abort|timeout|timed out|fetch failed|network|ECONN|socket/i.test(String(e.message))
          || /^HTTP 5\d\d$/.test(String(e.message));
        if (!layak || i === tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 700));
      }
    }
    throw last;
  }

  // Statistik pool dari DexScreener. pool v4 = poolId (bytes32), v3 = alamat pool.
  pair(ref) {
    const key = `ds:${String(ref).toLowerCase()}`;
    return this.memo(key, 30_000, async () => {
      const j = await this.json(this.DS + ref);
      const p = j?.pairs?.[0] || j?.pair;
      if (!p) return { error: 'pool ini belum terindeks di DexScreener' };
      const lc = (a) => String(a || '').toLowerCase();
      return {
        url: p.url, dexId: p.dexId, labels: p.labels || [],
        base: { address: lc(p.baseToken?.address), symbol: p.baseToken?.symbol },
        quote: { address: lc(p.quoteToken?.address), symbol: p.quoteToken?.symbol },
        priceUsd: Number(p.priceUsd) || null, priceNative: Number(p.priceNative) || null,
        priceChange: p.priceChange || {}, volume: p.volume || {}, txns: p.txns || {},
        liquidityUsd: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, marketCap: p.marketCap ?? null,
        pairCreatedAt: p.pairCreatedAt ?? null,
        imageUrl: p.info?.imageUrl || null,
        websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
        fetchedAt: Date.now(),
      };
    });
  }

  // Semua pool satu token dari DexScreener, likuiditas terbesar di depan — bahan
  // halaman detail token. Pool pertama jadi sumber grafik harganya.
  token(address) {
    const a = String(address).toLowerCase();
    return this.memo(`dst:${a}`, 30_000, async () => {
      const j = await this.json(this.DS_TOKEN + a);
      const list = Array.isArray(j) ? j : j?.pairs || [];
      const lc = (x) => String(x || '').toLowerCase();
      const pairs = list.filter((p) => p?.pairAddress).map((p) => ({
        pool: lc(p.pairAddress), url: p.url, dexId: p.dexId, labels: p.labels || [],
        base: { address: lc(p.baseToken?.address), symbol: p.baseToken?.symbol, name: p.baseToken?.name },
        quote: { address: lc(p.quoteToken?.address), symbol: p.quoteToken?.symbol, name: p.quoteToken?.name },
        priceUsd: Number(p.priceUsd) || null, priceNative: Number(p.priceNative) || null,
        priceChange: p.priceChange || {}, volume: p.volume || {}, txns: p.txns || {},
        liquidityUsd: p.liquidity?.usd ?? null, fdv: p.fdv ?? null, marketCap: p.marketCap ?? null,
        pairCreatedAt: p.pairCreatedAt ?? null,
        websites: (p.info?.websites || []).map((w) => w.url).filter(Boolean).slice(0, 3),
        socials: (p.info?.socials || []).filter((x) => x?.url).map((x) => ({ type: x.type, url: x.url })).slice(0, 4),
      })).sort((x, y) => (y.liquidityUsd || 0) - (x.liquidityUsd || 0));
      return { pairs, fetchedAt: Date.now() };
    });
  }

  // Lilin OHLCV dari GeckoTerminal, urut naik menurut waktu.
  //  - token: alamat token yang jadi dasar harga (token spekulatif), supaya arah
  //    harganya sama dengan rentang posisi di UI — bukan terserah GeckoTerminal.
  //  - currency 'token': harga dalam aset kuotasi pool (USDG/ETH), bukan USD, supaya
  //    sejajar dengan rentang tick posisi.
  //  - before: batas akhir (ms) — posisi yang sudah ditutup dilihat di sekitar masa
  //    hidupnya, bukan sampai sekarang. Dibulatkan ke lilin supaya cache-nya kena.
  candles(ref, tf = '1h', { limit = 300, token = null, currency = 'token', before = null, patient = false } = {}) {
    const [frame, agg, secs] = TF[tf] || TF['1h'];
    const n = Math.max(10, Math.min(1000, Number(limit) || 300));
    const beforeS = before ? Math.ceil(before / 1000 / secs) * secs : null;
    const key = `gt:${String(ref).toLowerCase()}:${tf}:${n}:${token || ''}:${currency}:${beforeS || ''}`;
    // Cache selama setengah lilin, maksimum 60 detik: lilin yang sedang berjalan
    // tetap terlihat bergerak tanpa membanjiri GeckoTerminal. Riwayat yang sudah
    // lewat (before) tidak berubah lagi — simpan lebih lama.
    return this.memo(key, beforeS ? 10 * 60_000 : Math.min(60_000, Math.max(15_000, (secs * 1000) / 2)), async () => {
      const q = new URLSearchParams({ aggregate: String(agg), limit: String(n), currency });
      if (token) q.set('token', token);
      if (beforeS) q.set('before_timestamp', String(beforeS));
      const j = await this.json(`${this.GT}${ref}/ohlcv/${frame}?${q}`, patient ? { timeoutMs: 25_000, tries: 2 } : {});
      if (!j) return { error: 'pool ini belum terindeks di GeckoTerminal' };
      const list = j?.data?.attributes?.ohlcv_list || [];
      // Sesekali ada dua lilin berwaktu sama: yang muncul belakangan menang.
      const byT = new Map(list.map(([t, o, h, l, c, v]) => [t, { t: t * 1000, o, h, l, c, v }]));
      const candles = [...byT.values()].sort((a, b) => a.t - b.t);
      return {
        tf, secs, candles,
        base: j?.meta?.base ? { address: String(j.meta.base.address || '').toLowerCase(), symbol: j.meta.base.symbol } : null,
        quote: j?.meta?.quote ? { address: String(j.meta.quote.address || '').toLowerCase(), symbol: j.meta.quote.symbol } : null,
        fetchedAt: Date.now(),
      };
    });
  }

  // Lilin OHLCV dari OpenAPI GMGN untuk satu token (harga USD, bukan aset kuotasi
  // pool — GMGN menghargai token, bukan pool). Bentuk jawabannya disamakan dengan
  // candles() supaya UI memakai jalur yang sama; `source: 'gmgn'` dan
  // `currency: 'usd'` memberi tahu UI bahwa rentang posisi perlu dikonversi ke USD.
  // Tanpa key: { error } supaya UI kembali ke GeckoTerminal.
  gmgnEnabled() { return !!this.gmgnKey(); }
  candlesGmgn(token, tf = '1h', { limit = 300, before = null } = {}) {
    const key = this.gmgnKey();
    if (!key) return Promise.resolve({ error: 'API key GMGN belum diisi (Pengaturan → GMGN)' });
    const [, , secs] = TF[tf] || TF['1h'];
    const n = Math.max(10, Math.min(1000, Number(limit) || 300));
    const beforeS = before ? Math.ceil(before / 1000 / secs) * secs : null;
    const ck = `gmgn:${String(token).toLowerCase()}:${tf}:${n}:${beforeS || ''}`;
    return this.memo(ck, beforeS ? 10 * 60_000 : Math.min(60_000, Math.max(15_000, (secs * 1000) / 2)), async () => {
      const to = beforeS ? beforeS : Math.floor(Date.now() / 1000);
      const j = await this.gmgn('/v1/market/token_kline', { address: String(token).toLowerCase(), resolution: tf, from: (to - n * secs) * 1000, to: to * 1000 });
      if (j?.error) return j;
      const byT = new Map();
      for (const c of j?.list || []) {
        const t = Number(c.time), o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
        if (!(t > 0) || !(o > 0) || !(h > 0) || !(l > 0) || !(cl > 0)) continue;
        // volume = jumlah token, amount = nilai USD — UI memakai nilai USD sebagai volume.
        byT.set(t, { t: t * 1000, o, h, l, c: cl, v: Number(c.amount) || 0 });
      }
      const candles = [...byT.values()].sort((a, b) => a.t - b.t);
      return { tf, secs, candles, source: 'gmgn', currency: 'usd', base: { address: String(token).toLowerCase() }, quote: null, fetchedAt: Date.now() };
    });
  }

  // Satu panggilan baca ke OpenAPI GMGN. Jawaban dibungkus { code, data, error,
  // message }: code 0 = sukses. Limit (RATE_LIMIT_*) menahan semua panggilan 10
  // detik supaya memo menyajikan cadangan, bukan menembak terus.
  async gmgn(subPath, params = {}, { timeoutMs = 12_000 } = {}) {
    const key = this.gmgnKey();
    if (!key) return { error: 'API key GMGN belum diisi' };
    if (this.gmgnCooldown > Date.now()) throw new Error('batas panggilan GMGN — coba lagi sebentar');
    const q = new URLSearchParams({ chain: this.gmgnSlug, ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      timestamp: String(Math.floor(Date.now() / 1000)), client_id: crypto.randomUUID() });
    const r = await this.fetch(`${GMGN_API}${subPath}?${q}`, { headers: { accept: 'application/json', 'X-APIKEY': key }, signal: AbortSignal.timeout(timeoutMs) });
    const j = await r.json().catch(() => null);
    if (r.status === 429 || /RATE_LIMIT/.test(String(j?.error || ''))) {
      this.gmgnCooldown = Date.now() + 10_000;
      throw new Error(`batas panggilan GMGN (${j?.error || 429})${j?.message ? ` — ${j.message}` : ''}`);
    }
    if (r.status === 401 || r.status === 403) return { error: `GMGN menolak API key (HTTP ${r.status}${j?.message ? `: ${j.message}` : ''})` };
    if (!r.ok) throw new Error(`GMGN HTTP ${r.status}`);
    if (!j || j.code !== 0) return { error: `GMGN: ${j?.message || j?.error || 'jawaban tidak dikenal'}` };
    return j.data ?? {};
  }

  // Transaksi swap terakhir di satu pool dari GeckoTerminal (maks. 300 dalam 24 jam
  // terakhir), terbaru di depan — cadangan pita "running trade" kalau browser tidak
  // bisa memanggil GeckoTerminal sendiri (lihat trades.mjs). Cache 15 detik: IP VPS
  // ini dipakai tiga instance sekaligus dan jatahnya ~30 panggilan/menit.
  trades(ref, { token = null, limit = 80 } = {}) {
    const t = String(token || '').toLowerCase();
    return this.memo(`gtt:${String(ref).toLowerCase()}:${t}:${limit}`, 15_000, async () => {
      const j = await this.json(gtTradesUrl(this.gtSlug, ref));
      if (!j) return { error: 'pool ini belum terindeks di GeckoTerminal' };
      return { trades: normalizeTrades(j, { token: t || null, limit }), fetchedAt: Date.now() };
    });
  }
}

module.exports = { Market, TF };
