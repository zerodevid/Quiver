'use strict';
// Mata uang kedua untuk dasbor: kurs USD -> mata uang pilihan (Pengaturan → Tampilan).
//
// Angka utama di dasbor tetap dolar — itu satuan yang dipakai mesin, harga pool, dan
// semua perhitungan PnL. Kurs di sini cuma untuk keterangan kecil di sampingnya
// ("≈ Rp20,3 jt"), supaya nominalnya punya rasa besaran buat yang tidak berpikir
// dalam dolar. Karena sifatnya keterangan, tidak ada yang bergantung padanya:
// kalau kursnya gagal diambil, dasbor tetap jalan dan keterangannya hilang.
//
// Sumbernya dua, gratis dan tanpa kunci: open.er-api.com (pembaruan harian, semua
// mata uang) dengan cadangan api.frankfurter.app (kurs referensi ECB). Jawabannya
// disimpan di tabel state, jadi restart bot tidak berarti menarik ulang — dan kalau
// keduanya sedang tidak bisa dihubungi, kurs terakhir tetap dipakai (ditandai basi).

// Yang ditawarkan di pemilih. Daftar pendek yang disengaja: mata uang yang mungkin
// dipakai orang yang menjalankan bot ini, bukan seluruh 160 kode yang dikirim API.
const CURRENCIES = {
  IDR: 'Rupiah Indonesia', MYR: 'Ringgit Malaysia', SGD: 'Dolar Singapura', THB: 'Baht Thailand',
  VND: 'Dong Vietnam', PHP: 'Peso Filipina', INR: 'Rupee India', CNY: 'Yuan Tiongkok',
  JPY: 'Yen Jepang', KRW: 'Won Korea', HKD: 'Dolar Hong Kong', TWD: 'Dolar Taiwan',
  AUD: 'Dolar Australia', NZD: 'Dolar Selandia Baru', CAD: 'Dolar Kanada',
  EUR: 'Euro', GBP: 'Pound Sterling', CHF: 'Franc Swiss', SEK: 'Krona Swedia',
  TRY: 'Lira Turki', RUB: 'Rubel Rusia', UAH: 'Hryvnia Ukraina', PLN: 'Zloty Polandia',
  BRL: 'Real Brasil', MXN: 'Peso Meksiko', ARS: 'Peso Argentina',
  AED: 'Dirham UEA', SAR: 'Riyal Saudi', ZAR: 'Rand Afrika Selatan', NGN: 'Naira Nigeria',
};

const SOURCES = [
  ['open.er-api.com', 'https://open.er-api.com/v6/latest/USD', (j) => (j && j.result === 'success' ? j.rates : null)],
  ['frankfurter.app', 'https://api.frankfurter.app/latest?base=USD', (j) => (j && j.rates) || null],
];

class Fx {
  // ttlMs: kurs mata uang bergerak lambat (sumbernya sendiri harian), jadi enam jam
  // sudah jauh lebih sering daripada datanya berubah.
  constructor({ store = null, log = null, fetch: fetchImpl = null, ttlMs = 6 * 3600_000 } = {}) {
    this.store = store;
    this.log = log || (() => {});
    this.fetch = fetchImpl || ((...a) => globalThis.fetch(...a));
    this.ttlMs = ttlMs;
    this.rates = null;
    this.at = 0;
    this.source = null;
    this.error = null;
    this.pending = null;
    try {
      const raw = store && store.getState('fx_rates');
      const j = raw ? JSON.parse(raw) : null;
      if (j && j.rates && j.rates.EUR) { this.rates = j.rates; this.at = j.at || 0; this.source = j.source || null; }
    } catch { /* state rusak: tarik ulang saja */ }
  }

  fresh() { return !!this.rates && Date.now() - this.at < this.ttlMs; }

  // Kurs satu mata uang untuk dasbor. Dipanggil dari /api/overview yang dipoll tiap
  // 5 detik, jadi TIDAK menunggu jaringan: kalau kursnya basi, penyegaran dijalankan
  // di latar dan jawaban sekarang memakai nilai lama (atau kosong kalau belum pernah ada).
  view(code) {
    const c = String(code || '').toUpperCase();
    if (!CURRENCIES[c]) return null;
    if (!this.fresh()) this.refresh().catch(() => {});
    const rate = this.rates ? this.rates[c] : null;
    const stale = !this.fresh();
    return {
      currency: c, name: CURRENCIES[c],
      rate: rate || null, at: this.at || null, source: this.source,
      stale: !!rate && stale,
      error: rate && !stale ? null : this.error,
    };
  }

  // force: dari tombol "Perbarui kurs" di Pengaturan — abaikan umur cache.
  refresh(force = false) {
    if (!force && this.fresh()) return Promise.resolve(true);
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = null; });
    return this.pending;
  }

  async load() {
    const errs = [];
    for (const [name, url, pick] of SOURCES) {
      try {
        const r = await this.fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const rates = pick(await r.json());
        // EUR ada di semua sumber kurs yang waras — penanda bahwa yang terbaca memang
        // tabel kurs, bukan halaman galat yang kebetulan berformat JSON.
        if (!rates || !rates.EUR) throw new Error('jawaban tanpa kurs');
        this.rates = rates; this.at = Date.now(); this.source = name; this.error = null;
        try { if (this.store) this.store.setState('fx_rates', JSON.stringify({ at: this.at, source: name, rates })); } catch { /* biarkan */ }
        return true;
      } catch (e) { errs.push(`${name}: ${e.message}`); }
    }
    this.error = errs.join(' · ');
    this.log(`kurs mata uang gagal diambil (${this.error})`);
    return false;
  }
}

// Mata uang yang dipakai dasbor. Belum pernah diatur (config lama, pemasangan baru)
// = Rupiah: bot ini dipakai dari Indonesia, dan keterangan kecil yang langsung ada
// lebih berguna daripada fitur yang harus ditemukan dulu. Dimatikan dari Pengaturan
// tersimpan sebagai null, dan null TIDAK dibaca sebagai "belum pernah diatur".
const currencyOf = (cfg) => (cfg?.display && 'currency' in cfg.display ? cfg.display.currency || '' : 'IDR');

module.exports = { Fx, CURRENCIES, currencyOf };
