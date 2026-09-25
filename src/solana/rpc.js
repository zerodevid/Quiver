'use strict';
// Kolam RPC Solana: beberapa endpoint (Helius/Alchemy/QuickNode/publik), masing-masing
// satu Connection @solana/web3.js. Setiap panggilan lewat `run(fn)`: endpoint yang
// menjawab 429/timeout/galat jaringan diistirahatkan sebentar dan panggilan diulang di
// endpoint berikutnya. Galat program (simulasi gagal, akun tidak ada) TIDAK diulang —
// jawabannya sah, mengulang di node lain cuma membuang kuota.
//
// Bentuk stats() sama dengan RpcPool EVM supaya halaman Pengaturan menampilkan
// endpoint Solana apa adanya.
const { Connection } = require('@solana/web3.js');

const TRANSIENT = /429|too many requests|rate limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|502|503|504|Bad Gateway|Service Unavailable|Internal server error|node is behind|Block not available|Slot .* was skipped|failed to get info about account/i;
// getProgramAccounts ditolak endpoint publik untuk program besar: bukan galat
// sementara, tapi endpoint lain (berbayar) mungkin melayaninya.
// Permintaan "terindeks" (akun token per pemilik, holder terbesar, getProgramAccounts)
// ditolak endpoint gratis tertentu dengan 403. Ditandai no_indexed di config, atau
// dipelajari saat galat ini muncul pertama kali.
const INDEXED_REFUSED = /Indexed requests require|personal token/i;
const UNSUPPORTED = /excluded from account secondary indexes|getProgramAccounts.*(disabled|not available|not allowed)|method not found|Method not found|410 Gone|403 Forbidden|Request blocked|not available on free plan/i;

class SolanaRpc {
  constructor(endpoints, log = console.log, opts = {}) {
    this.log = log;
    // Endpoint yang ${VAR}-nya belum terisi dari .env dilewati (URL-nya pasti gagal).
    const usable = (endpoints || []).filter((e) => {
      if (!/\$\{/.test(e.url)) return true;
      log(`endpoint Solana dilewati: variabel di ${e.url.replace(/\?.*$/, '')} belum diisi di .env`);
      return false;
    });
    this.eps = usable.map((e) => ({
      url: e.url, headers: e.headers || null, noGpa: !!e.no_gpa, noSend: !!e.no_send,
      // no_history: riwayat tanda tangan terpotong/kosong (publicnode) — tidak dipakai
      // untuk getSignaturesForAddress; jawaban kosongnya terbaca "target diam".
      noHistory: !!e.no_history,
      // no_indexed: tidak melayani getTokenAccountsByOwner/getTokenLargestAccounts. Panggilan
      // itu tidak pernah dikirim ke sana — sebuah 403 di dalam SDK yang menjalankan dua
      // permintaan paralel meninggalkan promise tak tertangani. publicnode dikenal begitu.
      noIndexed: e.no_indexed ?? /publicnode\.com/.test(e.url),
      conn: new Connection(e.url, {
        commitment: opts.commitment || 'confirmed',
        httpHeaders: e.headers || undefined,
        disableRetryOnRateLimit: true,
        confirmTransactionInitialTimeout: 90_000,
      }),
      calls: 0, errors: 0, lastMs: 0, cooldownUntil: 0, streak: 0, inflight: 0,
    }));
    if (!this.eps.length) throw new Error('tidak ada endpoint RPC Solana');
    this.rr = 0;
  }

  // Connection utama (endpoint sehat pertama) — untuk SDK yang menyimpan Connection
  // sendiri (DLMM, Whirlpool context, Raydium). Panggilan penting tetap lewat run().
  primary() {
    const now = Date.now();
    return (this.eps.find((e) => e.cooldownUntil <= now && !e.noSend) || this.eps[0]).conn;
  }

  order({ needsGpa = false, send = false, needsHistory = false, indexed = false } = {}) {
    const now = Date.now();
    const ok = this.eps.filter((e) => !(needsGpa && e.noGpa) && !(send && e.noSend) && !(needsHistory && e.noHistory)
      && !(indexed && e.noIndexed));
    const warm = ok.filter((e) => e.cooldownUntil <= now);
    const cold = ok.filter((e) => e.cooldownUntil > now).sort((a, b) => a.cooldownUntil - b.cooldownUntil);
    // Putar di antara yang sehat supaya beban tersebar; endpoint pertama di config tetap
    // yang paling sering dipakai kalau hanya ia yang sehat.
    const start = warm.length ? this.rr++ % warm.length : 0;
    return [...warm.slice(start), ...warm.slice(0, start), ...cold];
  }

  // fn(connection, endpoint) -> Promise. Diulang di endpoint lain kalau galatnya
  // sementara; galat lain dilempar apa adanya.
  async run(fn, { needsGpa = false, send = false, needsHistory = false, indexed = false, tries = null } = {}) {
    const list = this.order({ needsGpa, send, needsHistory, indexed });
    if (!list.length) throw new Error(needsGpa ? 'tidak ada endpoint Solana yang melayani getProgramAccounts (tambahkan RPC berbayar: Helius/QuickNode/Alchemy)' : 'tidak ada endpoint Solana');
    let last;
    for (const e of list.slice(0, tries || list.length)) {
      const t0 = Date.now();
      e.calls++; e.inflight++;
      try {
        const r = await fn(e.conn, e);
        e.lastMs = Date.now() - t0; e.streak = 0;
        return r;
      } catch (err) {
        e.lastMs = Date.now() - t0;
        const msg = String(err?.message || err);
        if (UNSUPPORTED.test(msg)) {
          e.errors++; if (needsGpa) e.noGpa = true;
          if (INDEXED_REFUSED.test(msg) && !e.noIndexed) { e.noIndexed = true; this.log(`RPC Solana ${e.url.replace(/\?.*$/, '')}: menolak permintaan terindeks — tidak dipakai lagi untuk itu`); }
          last = err; continue;
        }
        if (!TRANSIENT.test(msg)) throw err;
        e.errors++; e.streak++;
        e.cooldownUntil = Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(5, e.streak - 1));
        last = err;
      } finally { e.inflight--; }
    }
    throw last || new Error('semua endpoint Solana gagal');
  }

  async slot(commitment = 'confirmed') { return this.run((c) => c.getSlot(commitment)); }
  // Antarmuka yang dipakai kode bersama (index.js, dasbor): "blok" = slot.
  async blockNumber() { return this.slot(); }
  async safeHead() { const s = await this.slot(); return { min: s, max: s, spread: 0 }; }
  allCooling() { const now = Date.now(); return this.eps.every((e) => e.cooldownUntil > now); }
  hasArchive() { return false; }

  stats() {
    return this.eps.map((e) => ({
      host: (() => { try { return new URL(e.url).hostname; } catch { return '?'; } })(),
      calls: e.calls, errors: e.errors, lastMs: e.lastMs, cooling: e.cooldownUntil > Date.now(),
      noGpa: e.noGpa, noSend: e.noSend, noHistory: e.noHistory, noIndexed: e.noIndexed, inflight: e.inflight, url: e.url,
    }));
  }
}

module.exports = { SolanaRpc, TRANSIENT };
