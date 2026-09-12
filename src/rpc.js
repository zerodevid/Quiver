'use strict';
// Kolam RPC untuk Robinhood Chain.
//
// Dua masalah nyata yang ditangani di sini:
//  1. ISP (Telkomsel) membajak DNS `rpc.mainnet.chain.robinhood.com` ke portal
//     internetbaik-nya, jadi TLS gagal dengan "altnames tidak cocok". Solusinya
//     resolve lewat DoH 1.1.1.1 (alamat IP, tidak butuh DNS) lalu sematkan IP itu
//     ke koneksi sambil tetap memakai SNI/hostname asli supaya sertifikat valid.
//  2. `eth_getLogs` dibatasi 10.000 log per query dan endpoint resmi membalas 429
//     kalau panggilan berat datang beruntun — jadi ada antrean inflight + failover.
const https = require('node:https');
const { URL } = require('node:url');

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
    // eth_getLogs adalah panggilan paling berat dan satu-satunya yang bikin endpoint
    // resmi membalas 429. Mesin utama, pemindai wallet, dan scout semuanya lewat sini,
    // jadi jatahnya diatur terpusat: maksimal N bersamaan dan jarak minimum antar-kirim.
    this.logsMax = opts.logs_concurrency || 2;
    this.logsGapMs = opts.logs_gap_ms ?? 150;
    this.logsActive = 0;
    this.logsQueue = [];
    this.logsLast = 0;
    // blok ≈ 0,1 detik: 20 blok ≈ 2 detik keterlambatan membaca aksi target
    this.headMargin = opts.head_margin_blocks ?? 20;
  }

  async logsSlot(priority = false) {
    if (this.logsActive < this.logsMax && !this.logsQueue.length) { this.logsActive++; }
    else {
      // Pekerjaan berprioritas (mesin copy yang mengikuti blok terbaru) diselipkan
      // di depan antrean; pemindaian riwayat wallet menunggu di belakang.
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
      // Tidak semua endpoint sanggup semuanya. publicnode misalnya paling cepat untuk
      // eth_call (120ms) tapi menolak eth_getLogs di luar ~10 blok terakhir dengan
      // "Archive requests require a personal token". Kalau ini tidak dibedakan, separuh
      // pemindaian gagal diam-diam.
      noLogs: !!e.no_logs,
      // Node arsip: sanggup eth_call di blok lampau. Hanya ordofi yang ternyata bisa —
      // endpoint resmi membalas "metadata is not found", publicnode 403.
      archive: !!e.archive,
      maxLogBlocks: e.max_log_blocks || 0,
      // Endpoint baca-saja yang menolak eth_sendRawTransaction ("Method not found").
      // Bisa diset di config; kalau tidak, ditandai sendiri saat pertama kali menolak.
      noSend: !!e.no_send,
      fails: 0, cooldownUntil: 0, calls: 0, errors: 0, lastMs: 0, inflight: 0,
      // Istirahat KHUSUS getLogs: endpoint yang membalas galat JSON-RPC untuk getLogs
      // ("historical state is not available", "network is busy", "time budget") sering
      // masih sehat untuk eth_call — jadi cuma jatah getLogs-nya yang dialihkan.
      logsCooldownUntil: 0, logsErrors: 0,
    };
  }

  // Ganti daftar endpoint saat berjalan (dari halaman Pengaturan). Statistik endpoint
  // yang URL-nya tidak berubah dipertahankan; koneksi keep-alive lama dibuang.
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
      // Node >= 20 memanggil lookup dengan {all:true} (autoSelectFamily), jadi callback-nya
      // harus mengembalikan array — kalau tidak, hasilnya ERR_INVALID_IP_ADDRESS: undefined.
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

  post(urlStr, body, timeoutMs, ips, extraHeaders = null) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
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
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 120)}`));
          try { resolve(JSON.parse(text)); } catch { reject(new Error(`balasan bukan JSON: ${text.slice(0, 120)}`)); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end(body);
    });
  }

  // ---- antrean ------------------------------------------------------------
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

  // Endpoint yang boleh dipakai untuk sekumpulan panggilan ini, URUT PRIORITAS:
  // urutan daftar di config/halaman Pengaturan adalah urutannya. Yang teratas dipakai
  // selama sehat; yang sedang istirahat (gagal, 429) turun ke belakang sehingga
  // panggilan jatuh ke cadangan berikutnya, dan kembali ke atas begitu istirahatnya
  // selesai. (Dulu diurutkan dari yang paling senggang supaya beban tersebar — tapi
  // pemilik ingin menentukan sendiri endpoint mana yang diandalkan lebih dulu.)
  // logSpan: lebar rentang blok getLogs. Endpoint dengan max_log_blocks lebih kecil
  // dilewati — ordofi misalnya menggantung ~60 detik lalu membalas "network is busy"
  // untuk rentang 40rb blok, padahal endpoint resmi menjawab 900rb blok dalam 0,34 detik.
  canServe(e, needsLogs, logSpan, needsArchive = false) {
    if (needsArchive && !e.archive) return false;
    if (!needsLogs) return true;
    if (e.noLogs) return false;
    return !(e.maxLogBlocks && logSpan > e.maxLogBlocks);
  }

  // Sampai kapan endpoint istirahat untuk jenis panggilan ini.
  coolUntil(e, needsLogs) { return needsLogs ? Math.max(e.cooldownUntil, e.logsCooldownUntil) : e.cooldownUntil; }

  usable(needsLogs = false, logSpan = 0, needsArchive = false) {
    const now = Date.now();
    let pool = this.eps.filter((e) => this.canServe(e, needsLogs, logSpan, needsArchive));
    if (needsArchive && !pool.length) return [];
    if (!pool.length) pool = this.eps;             // tidak ada yang cocok: coba saja
    const ok = pool.filter((e) => this.coolUntil(e, needsLogs) < now);      // urutan daftar dipertahankan
    if (ok.length) return ok;
    // semua istirahat: tetap coba, mulai dari yang istirahatnya paling cepat selesai
    return pool.slice().sort((a, b) => this.coolUntil(a, needsLogs) - this.coolUntil(b, needsLogs));
  }

  allCoolingFor(needsLogs = false, logSpan = 0, needsArchive = false) {
    const now = Date.now();
    const pool = this.eps.filter((e) => this.canServe(e, needsLogs, logSpan, needsArchive));
    return (pool.length ? pool : this.eps).every((e) => this.coolUntil(e, needsLogs) > now);
  }

  // Tinggi blok yang AMAN dipakai semua endpoint. Endpoint bisa beda 10-20 blok
  // (~1-2 detik). Kalau kursor dimajukan ke kepala endpoint tercepat lalu getLogs
  // dilayani endpoint yang tertinggal, blok di antaranya hilang selamanya —
  // karena kursor sudah terlanjur lewat. Jadi dipakai yang paling rendah.
  //
  // Catatan: dulu ini mengirim N eth_blockNumber identik dalam SATU batch — batch pergi
  // ke satu endpoint, jadi "min" selalu = "max" (headSpread selalu 0) dan kuota endpoint
  // teratas terbakar N× tiap 1,5 detik. Sekarang satu panggilan; perlindungan dari
  // endpoint getLogs yang tertinggal ada di _getLogs (blok ujung rentang harus ada di
  // endpoint yang sama yang menjawab log-nya).
  async safeHead() {
    const [r] = await this.batch([{ method: 'eth_blockNumber' }]);
    const h = r && !r.error && r.result ? parseInt(r.result, 16) : null;
    if (!h) throw new Error('tidak ada endpoint yang membalas blockNumber');
    // Endpoint getLogs publik biasanya 3–5 blok di belakang endpoint tercepat. Tanpa
    // jarak ini ujung rentang sering belum ada di sana dan pemindaian gagal beruntun.
    const safe = h - this.headMargin;
    return { min: safe, max: h, spread: h - safe };
  }

  // Galat per-item di dalam balasan 200 yang sifatnya SEMENTARA (kuota, node sibuk,
  // node tertinggal) — bukan jawaban sah. eth_call yang revert itu jawaban sah.
  static transientItemError(err) {
    if (!err) return false;
    const msg = String(err.message || '');
    if (err.code === 3 || /revert/i.test(msg)) return false;
    if ([429, -32005, -32029, -32001, -31001, -32603].includes(err.code)) return true;
    return /429|too many|rate.?limit|exceeded|capacity|busy|timeout|timed out|try again|unavailable|no backend|internal error|header not found|missing trie|historical state|upstream|relay|overload/i.test(msg);
  }

  // ---- pemanggilan --------------------------------------------------------
  // calls: [{method, params}] -> hasil sejajar; melempar kalau semua endpoint gagal
  // `used` (opsional): objek yang diisi {ep} — endpoint yang terakhir melayani, supaya
  // pemanggil bisa mengistirahatkannya kalau balasan 200-nya ternyata berisi galat.
  async batch(calls, opts = {}) {
    const out = await this.batchOnce(calls, opts);
    // getLogs punya failover sendiri (_getLogs: istirahat khusus getLogs per endpoint).
    if (calls.some((c) => c.method === 'eth_getLogs')) return out;
    // Item yang gagal SEMENTARA (galat kuota di dalam balasan 200, atau item yang
    // hilang dari balasan batch) dicoba ulang di endpoint lain. Dulu item seperti itu
    // sampai ke pemanggil sebagai null — dan ethCallMany(null) terbaca "revert/nol":
    // pemilik NFT tidak dikenal (aksi target dibuang), likuiditas nol (posisi ditutup).
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
          } else out[pos + i] = { result: r.result ?? null };
        }
        ep.calls += slice.length; ep.lastMs = Date.now() - t0;
        if (flaky && !needsLogs) {
          // Endpoint menjawab tapi sebagian isinya galat kuota: istirahatkan sebentar
          // supaya ulangan item-item itu jatuh ke endpoint lain. (Galat getLogs diurus
          // _getLogs dengan istirahat khusus getLogs — eth_call endpoint itu tetap jalan.)
          ep.errors++; ep.fails++;
          ep.cooldownUntil = Date.now() + Math.min(30_000, 4000 * 2 ** Math.min(ep.fails - 1, 3));
        } else ep.fails = 0;
        pos += size;
      } catch (e) {
        ep.errors++; ep.fails++;
        // 429 artinya "kamu terlalu sering" — mencoba lagi 2 detik kemudian cuma
        // memperpanjang hukumannya. Gangguan transport biasa cukup jeda singkat.
        const rateLimited = /429|too many requests|network is busy/i.test(e.message);
        const base = rateLimited ? 8000 : 1000;
        ep.cooldownUntil = Date.now() + Math.min(rateLimited ? 60_000 : 30_000, base * 2 ** Math.min(ep.fails - 1, 3));
        this.log(`rpc ${new URL(ep.url).hostname} gagal (${e.message}) — istirahat ${Math.round((ep.cooldownUntil - Date.now()) / 1000)}s`);
        if (this.allCoolingFor(needsLogs, logSpan, archive)) {
          ep.inflight--;
          this.release();
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

  // Siaran transaksi yang sudah ditandatangani. Lewat `call` biasa, galat JSON-RPC
  // dari SATU endpoint (mis. "Method not found" dari endpoint baca-saja) langsung jadi
  // kegagalan total — balasan 200 berisi error dianggap jawaban sah, jadi kolam tidak
  // pindah endpoint. Akibatnya exit target gagal disalin padahal endpoint lain
  // sanggup menyiarkannya. Raw tx yang sama selalu punya hash yang sama, jadi
  // menyiarkannya ke SEMUA endpoint sekaligus aman (tidak mungkin terkirim dua kali)
  // dan paling tahan gangguan. Tidak lewat antrean inflight: siaran jangan sampai
  // menunggu di belakang getLogs yang berat.
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

  // eth_call di blok lampau — hanya dikirim ke endpoint arsip.
  async callAt(to, data, block) {
    const tag = typeof block === 'number' ? '0x' + block.toString(16) : block;
    return this.call('eth_call', [{ to, data }, tag], { archive: true });
  }

  async blockNumber() { return parseInt(await this.call('eth_blockNumber'), 16); }

  // eth_getLogs dengan failover antar-endpoint saat upstream membalas galat.
  //
  // Ini beda dari kegagalan transport: upstream membalas 200 dengan error JSON-RPC
  // ("returns more logs than the upstream will serve", "historical state is not
  // available", "the network is busy", "backend exceeded time budget", "invalid block
  // range"), jadi kolam menganggapnya sukses dan tidak pindah endpoint. Dulu hanya galat
  // kapasitas yang dialihkan; galat lain langsung menggagalkan tick — dan karena
  // endpointnya tidak diistirahatkan, tick berikutnya jatuh ke endpoint yang sama
  // lagi: 844 kegagalan "historical state is not available" dalam 12 jam, kursor
  // tertinggal, sinyal keluar target terlewat. Sekarang SEMUA galat getLogs
  // mengistirahatkan jatah getLogs endpoint itu (eth_call-nya tetap dipakai) dan
  // mencoba cadangan berikutnya; menyerah hanya kalau semua sudah dicoba.
  async getLogs(filter, { priority = false } = {}) {
    await this.logsSlot(priority);
    try { return await this._getLogs(filter); } finally { this.logsRelease(); }
  }

  async _getLogs(filter) {
    const capacityErr = (m) => /more logs than|log.{0,12}limit|too many (?:logs|results)|response size|query returned more/i.test(m || '');
    const busyErr = (m) => /429|too many requests|network is busy|rate limit/i.test(m || '');
    const eligible = this.eps.filter((e) => !e.noLogs);
    const span = spanOf(filter);
    // Blok ujung rentang diminta di batch YANG SAMA (satu permintaan HTTP, satu node).
    // Node yang tertinggal membalas getLogs untuk blok yang belum ia punya dengan daftar
    // KOSONG tanpa galat — kursor maju dan aksi target di rentang itu hilang selamanya.
    // Node itu juga membalas getBlockByNumber(ujung) = null: itu yang ditangkap di sini.
    const toTag = typeof filter.toBlock === 'string' && /^0x[0-9a-f]+$/i.test(filter.toBlock) ? filter.toBlock : null;
    let lastErr = null;
    for (let attempt = 0; attempt < Math.max(1, eligible.length); attempt++) {
      const used = {};
      try {
        const calls = [{ method: 'eth_getLogs', params: [filter] }];
        if (toTag) calls.push({ method: 'eth_getBlockByNumber', params: [toTag, false] });
        const res = await this.batch(calls, { timeoutMs: 45_000, logSpan: span, used });
        const [lr, br] = res;
        if (!lr) throw new Error('eth_getLogs: tidak ada balasan');
        if (lr.error) throw new Error(`eth_getLogs: ${lr.error.message}`);
        const out = lr.result;
        // Sebagian upstream membalas `result: null` alih-alih daftar kosong saat gagal
        // di dalam. Kalau itu diterima sebagai "tidak ada log", satu rentang blok
        // hilang DIAM-DIAM padahal kursor tetap maju — aksi target di rentang itu
        // tidak akan pernah terlihat. Perlakukan sebagai kegagalan supaya diulang.
        if (!Array.isArray(out)) throw new Error('eth_getLogs mengembalikan hasil bukan daftar');
        if (toTag && (!br || br.error || !br.result)) {
          throw new Error(`endpoint belum sampai blok ${parseInt(toTag, 16)} (node tertinggal)`);
        }
        if (used.ep) used.ep.logsStreak = 0;
        return out;
      } catch (e) {
        lastErr = e;
        // Semua endpoint sudah istirahat (kegagalan transport beruntun): tidak ada
        // yang bisa dicoba lagi sekarang.
        if (/semua endpoint RPC/.test(e.message)) throw e;
        const ep = used.ep || this.usable(true, span)[0];
        if (!ep) throw e;
        const host = new URL(ep.url).hostname;
        ep.logsErrors++;
        // Kapasitas: 8 detik cukup, rentang berikutnya mungkin lebih ringan. Sibuk/429:
        // lebih lama, mencoba lagi cepat cuma memperpanjang hukuman. Tertinggal: 10
        // detik, node biasanya menyusul. Galat lain ("historical state", "time budget",
        // "invalid range"): 20 detik — beberapa tick lewat endpoint lain dulu.
        const ms = capacityErr(e.message) ? 8000 : busyErr(e.message) ? 30_000 : /tertinggal/.test(e.message) ? 10_000 : 20_000;
        // Menolak beruntun (ordofi: "more logs than upstream will serve" di hampir tiap
        // rentang): istirahatnya berlipat sampai 5 menit, supaya percobaan tidak habis
        // di endpoint yang sama. Satu balasan sukses mengembalikannya ke nol.
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

  // eth_call terbungkus: kembalikan data hex atau lempar dengan pesan revert
  async ethCall(to, data, block = 'latest') {
    return this.call('eth_call', [{ to, data }, block]);
  }

  // Banyak eth_call sekaligus. Hasil: array hex|null (null = revert/gagal)
  //
  // `from` dan `value` boleh diisi untuk menyimulasikan transaksi sebagai wallet bot
  // (saldo dan izin ikut terbaca) — dipakai memilih pool swap: pool yang menolak swap
  // ketahuan di sini, sebelum ongkos gas keluar. Pembacaan biasa cukup {to, data}.
  //
  // strict: lempar kalau ada item yang tetap gagal SEMENTARA setelah dicoba di endpoint
  // lain — untuk pemanggil yang tidak boleh menyamakan "tidak terbaca" dengan "revert"
  // (mis. ownerOf: revert = NFT dibakar, tidak terbaca = belum tahu).
  async ethCallMany(items, block = 'latest', { strict = false } = {}) {
    const res = await this.batch(items.map((i) => {
      const tx = { to: i.to, data: i.data };
      if (i.from) tx.from = i.from;
      if (i.value != null && BigInt(i.value) > 0n) tx.value = '0x' + BigInt(i.value).toString(16);
      return { method: 'eth_call', params: [tx, block] };
    }));
    if (strict) {
      const bad = res.find((r) => !r || r.transient);
      if (bad) throw new Error(`eth_call tidak terbaca dari RPC: ${bad?.error?.message || 'tidak ada balasan'}`);
    }
    return res.map((r) => (r && !r.error ? r.result : null));
  }

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
