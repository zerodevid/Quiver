'use strict';
// Bot Telegram: seluruh isi dasbor lewat percakapan.
//
// Aturan utama modul ini: ia TIDAK punya logika sendiri. Setiap tombol memanggil
// rute API yang persis sama dengan yang dipakai browser (server.js -> server.api),
// jadi validasi, penjagaan, dan pencatatan cuma ditulis sekali. Kalau dasbor tidak
// mengizinkan sesuatu, bot juga tidak.
//
// Gerbang keamanan:
//  - Hanya chat yang ada di cfg.telegram.chat_ids yang dilayani. Chat lain dijawab
//    satu kalimat dan tidak bisa membaca apa pun.
//  - Menyambungkan chat butuh kode sekali pakai yang dibuat di dasbor (atau dicetak
//    ke log saat bot pertama kali hidup tanpa chat terhubung).
//  - Kunci privat TIDAK PERNAH lewat Telegram: impor ditolak, ekspor tidak ada.
//    Riwayat chat Telegram tersimpan di server Telegram — bukan tempat kunci.
//  - Perbuatan yang memindahkan dana (LIVE, tutup posisi, ganti wallet) selalu
//    lewat konfirmasi.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { writeCfg } = require('./env');
const { localeContext, tr, locale, localizeSchema, note } = require('./telegram-i18n');

const API = 'https://api.telegram.org/bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- format ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = (n, d = 2) => Number(n).toLocaleString(locale() === 'en' ? 'en-US' : 'id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${nf(n, d)}`);
const pct = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : ''}${nf(n, d)}%`);
const sgn = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : '−'}$${nf(Math.abs(n), d)}`);
const shortA = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—');
const shortH = (h) => (h ? `${String(h).slice(0, 10)}…` : '—');
// Buang nol di ekor pecahan: "1,50" -> "1,5", "1,00" -> "1". Angka tanpa koma
// tidak disentuh — di format Indonesia "1.000" adalah seribu, bukan satu koma nol.
// Rentang LP manual: "10 30" / "-10 +30" / "−10/+30" = turun 10%, naik 30%; "25" = ±25%.
// Tanda yang ditulis dihormati: "-30 -10" = seluruhnya di bawah harga, "+10 +30" =
// seluruhnya di atas. Angka tanpa tanda memakai arah biasa (bawah turun, atas naik).
// Hasilnya tetap lowerPct = seberapa jauh batas bawah DI BAWAH harga (negatif = di atas).
function parseRentang(text) {
  const nums = [...String(text).replace(/[−–]/g, '-').replace(/,/g, '.').matchAll(/(?:^|[^\d.])([-+]?)(\d+(?:\.\d+)?)/g)];
  if (!nums.length || nums.length > 2) return { error: tr("kirim satu angka (±) atau dua angka: batas bawah lalu batas atas, misal 10 30") };
  if (nums.length === 1) {
    const w = Number(nums[0][2]);
    if (!(w < 100)) return { error: tr("batas bawah harus di atas −100% — turun 100% berarti harga nol") };
    return w === 0 ? { error: tr("rentangnya kosong") } : { lowerPct: w, upperPct: w };
  }
  // Perubahan bertanda dari harga kini untuk tiap batas.
  let [a, b] = nums.map(([, s, v], i) => (s === '-' ? -Number(v) : s === '+' ? Number(v) : i === 0 ? -Number(v) : Number(v)));
  if (a > b) [a, b] = [b, a];
  if (a === 0 && b === 0) return { error: tr("rentangnya kosong") };
  if (a === b) return { error: tr("batas atas harus lebih tinggi dari batas bawah") };
  if (!(a > -100)) return { error: tr("batas bawah harus di atas −100% — turun 100% berarti harga nol") };
  if (!(b <= 100000)) return { error: tr("batas atas maksimal 100.000%") };
  return { lowerPct: a === 0 ? 0 : -a, upperPct: b };
}
// Di mana token itu diperdagangkan kalau bukan di Uniswap v3/v4 (data GeckoTerminal).
function pasarLainTeks(lainnya) {
  if (!lainnya?.length) return [];
  const nf0 = (n) => (n >= 1000 ? tr("${0}rb", [nf(n / 1000, 1)]) : `$${nf(n, 0)}`);
  return [
    '',
    tr("<b>Diperdagangkan di:</b>"),
    ...lainnya.map((x) => tr("• {0} — {1} · likuiditas {2}", [esc(x.dex), esc(x.name), nf0(x.reserveUsd)])),
    '',
    tr("<i>Bot hanya bisa membuka LP di Uniswap v3/v4 (likuiditas terkonsentrasi dengan rentang harga). Pool gaya v2 seperti Pons V2 tidak punya rentang, NFT posisi, maupun fee terpisah — cara kerjanya lain sama sekali.</i>"),
  ];
}

// Sesi lama masih membawa widthPct (±X% simetris dalam tick) — tetap ditampilkan apa adanya.
function rentangTeks(d) {
  if (d.lowerPct == null && d.upperPct == null) return `±${trimZ(nf(d.widthPct ?? 25, 1))}%`;
  const lo = d.lowerPct ?? 0, up = d.upperPct ?? 0;
  const bertanda = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${trimZ(nf(Math.abs(v), 2))}%`;
  return lo === up ? `±${trimZ(nf(lo, 2))}%` : `${bertanda(-lo)} / ${bertanda(up)}`;
}

const trimZ = (s) => { const sep = locale() === 'en' ? '.' : ','; if (!s.includes(sep)) return s; const trimmed = s.replace(/0+$/, ''); return trimmed.endsWith(sep) ? trimmed.slice(0, -1) : trimmed; };
const num = (n) => (n == null ? '—' : Number(n).toLocaleString(locale() === 'en' ? 'en-US' : 'id-ID'));
// Jumlah token: nol di ekor cuma bikin kolom ramai ("0,000000" -> "0"). Tetapi
// jumlah yang lebih kecil dari presisi kolom TIDAK boleh ikut jadi "0" — itu
// membaca seperti tidak ada tokennya sama sekali; pakai angka penting.
const tok = (n, d = 6) => {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const x = Number(n);
  if (x === 0) return '0';
  if (Math.abs(x) < 10 ** -d) return (x < 0 ? '−' : '') + harga(Math.abs(x));
  return trimZ(nf(x, d));
};

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return tr("baru saja");
  if (s < 60) return tr("{0} dtk lalu", [s]);
  if (s < 3600) return tr("{0} mnt lalu", [Math.round(s / 60)]);
  if (s < 86400) return tr("{0} jam lalu", [Math.round(s / 3600)]);
  const h = s / 86400;
  return tr("{0} hari lalu", [h < 10 ? trimZ(nf(h, 1)) : Math.round(h)]);
}
// Kebalikan ago(): untuk waktu yang belum tiba. ago() memotong selisih negatif jadi
// nol, jadi memakainya untuk jadwal berikutnya selalu menghasilkan "0 dtk".
function nanti(ts) {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return tr("sebentar lagi");
  if (s < 60) return tr("{0} dtk lagi", [s]);
  if (s < 3600) return tr("{0} mnt lagi", [Math.round(s / 60)]);
  return tr("{0}j {1}m lagi", [Math.floor(s / 3600), Math.round((s % 3600) / 60)]);
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u).slice(0, 24); } };

function dur(sec) {
  if (sec < 60) return tr("{0} detik", [Math.round(sec)]);
  if (sec < 3600) return tr("{0} menit", [Math.round(sec / 60)]);
  if (sec < 86400) {
    const j = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return m ? tr("{0} jam {1} menit", [j, m]) : tr("{0} jam", [j]);
  }
  const h = Math.floor(sec / 86400), j = Math.floor((sec % 86400) / 3600);
  return j ? tr("{0} hari {1} jam", [h, j]) : tr("{0} hari", [h]);
}

// Tabel dua kolom. Obrolan Telegram memakai font proporsional, jadi men-padding
// dengan spasi di teks biasa menghasilkan titik dua yang berantakan (persis yang
// terlihat sebelum ini). Satu-satunya cara kolom benar-benar lurus adalah blok
// <pre> — di dalamnya font monospace dan spasi dihitung. Konsekuensinya tidak ada
// penebalan di dalam tabel, jadi angka terpenting ditaruh di atasnya.
// `align`: satu huruf per kolom, 'r' untuk rata kanan (angka), selain itu rata kiri.
// Padding dihitung SEBELUM esc(): '&' jadi '&amp;' di HTML tapi tetap satu karakter
// di layar, jadi mengukur setelahnya justru merusak kelurusan kolom.
function kolom(rows, align = '') {
  const isi = rows.filter((r) => r.some((c) => c != null && c !== ''));
  if (!isi.length) return null;
  const n = Math.max(...isi.map((r) => r.length));
  const w = [];
  for (let i = 0; i < n; i++) w[i] = Math.max(...isi.map((r) => String(r[i] ?? '').length));
  const baris = isi.map((r) => Array.from({ length: n }, (_, i) => {
    const c = String(r[i] ?? '');
    return align[i] === 'r' ? c.padStart(w[i]) : c.padEnd(w[i]);
  }).join('  ').trimEnd());
  return `<pre>${baris.map(esc).join('\n')}</pre>`;
}
const tabel = (rows) => kolom(rows.filter(([, v]) => v != null && v !== ''));
// Tabel yang isinya murni angka: rata kanan supaya koma desimalnya sejajar.
const angka = (rows) => kolom(rows.filter(([, v]) => v != null && v !== ''), 'lr');

// ---- harga dari tick ------------------------------------------------------
// Rumus dan arahnya sama persis dengan dasbor (web/src/fmt.js): kalau aset kuotasi
// ada di token0, harga token spekulatif adalah KEBALIKAN tick — tickLower justru
// memberi harga TERTINGGI. Menampilkan tick mentah ke user tidak berarti apa-apa.
const tickPrice = (tick, dec0, dec1, quoteSide) => {
  const p1per0 = 1.0001 ** tick * 10 ** ((dec0 ?? 18) - (dec1 ?? 18));
  return quoteSide === 0 ? 1 / p1per0 : p1per0;
};
function harga(p) {
  if (p == null || !Number.isFinite(p) || p <= 0) return '—';
  if (p >= 1e6) return p.toLocaleString(locale() === 'en' ? 'en-US' : 'id-ID', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString(locale() === 'en' ? 'en-US' : 'id-ID', { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString(locale() === 'en' ? 'en-US' : 'id-ID', { maximumSignificantDigits: 3 });
  return p.toExponential(2).replace('.', ',');
}

// Rentang harga sebagai batang: di mana harga sekarang berdiri di antara kedua tepi,
// dan berapa persen lagi sebelum posisi berhenti menghasilkan fee.
function rentang(p) {
  const tickLower = p.tick_lower ?? p.tickLower;
  const tickUpper = p.tick_upper ?? p.tickUpper;
  const { curTick, dec0, dec1, quoteSide, symbol0, symbol1 } = p;
  if (tickLower == null || tickUpper == null || quoteSide == null) return null;
  const at = (t) => tickPrice(t, dec0, dec1, quoteSide);
  const a = at(tickLower), b = at(tickUpper);
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0) return null;
  const kuotasi = quoteSide === 0 ? symbol0 : symbol1;
  const dasar = quoteSide === 0 ? symbol1 : symbol0;
  const kini = curTick != null ? at(curTick) : null;

  const W = 15;
  const L = Math.log;
  let bar = '─'.repeat(W);
  let ket = null;
  if (kini != null && Number.isFinite(kini) && kini > 0) {
    const f = (L(kini) - L(lo)) / (L(hi) - L(lo) || 1);
    const i = Math.max(0, Math.min(W - 1, Math.round(f * (W - 1))));
    bar = '─'.repeat(i) + '●' + '─'.repeat(W - 1 - i);
    if (kini >= lo && kini <= hi) {
      const keBawah = (kini / lo - 1) * 100, keAtas = (hi / kini - 1) * 100;
      ket = tr("di dalam, {0}% ke tepi {1}", [nf(Math.min(keBawah, keAtas), 0), keBawah < keAtas ? tr("bawah") : tr("atas")]);
    } else {
      const jauh = kini < lo ? (lo / kini - 1) * 100 : (kini / hi - 1) * 100;
      ket = tr("di luar rentang, {0}% di {1}", [nf(jauh, 0), kini < lo ? tr("bawah") : tr("atas")]);
    }
  }
  return {
    judul: tr("Rentang harga — {0} dalam {1}", [dasar || '?', kuotasi || '?']),
    bar: `<pre>${esc(harga(lo))} ${bar} ${esc(harga(hi))}</pre>`,
    kini: kini != null ? tr("harga kini {0}", [harga(kini)]) : null,
    ket,
  };
}
const cut = (s, n = 3800) => (s.length <= n ? s : s.slice(0, n) + tr("\n…(dipotong)"));

// Baris log yang didorong ke chat. Pesan mesin umumnya berbentuk "konteks: rincian"
// (mis. "eksekusi masuk: saldo kurang"); konteksnya dijadikan judul supaya sekali
// lirik sudah jelas bagian mana yang bermasalah, rinciannya di baris sendiri.
function logBaris(level, msg) {
  const [icon, jenis] = { error: ['⛔', tr("Galat")], warn: ['⚠️', tr("Peringatan")], info: ['ℹ️', 'Info'], pulih: ['✅', tr("Pulih")] }[level] || ['•', level];
  const m = /^([^:\n]{2,40}):\s+([\s\S]+)$/.exec(String(msg ?? ''));
  const judul = m ? `${jenis} · ${note(m[1])}` : jenis;
  const isi = note(m ? m[2] : String(msg ?? ''));
  return cut(`${icon} <b>${esc(judul)}</b>\n${esc(isi)}`);
}

// ---- papan tombol ---------------------------------------------------------
const btn = (text, data) => ({ text, callback_data: data });
const kb = (rows) => ({ inline_keyboard: rows.filter(Boolean) });
const BACK_HOME = btn('🏠 Menu', 'h');

// ---- skema kolom yang bisa disetel ----------------------------------------
// Satu deskripsi dipakai untuk tiga hal: menampilkan nilai, membuat tombol, dan
// memvalidasi jawaban. Menambah setelan baru = menambah satu baris di sini.
const F = {
  num: (k, label, o = {}) => ({ k, label, type: 'num', lo: 0, hi: 1e12, ...o }),
  usd: (k, label, o = {}) => ({ k, label, type: 'usd', lo: 0, hi: 1e9, ...o }),
  pct: (k, label, o = {}) => ({ k, label, type: 'pct', lo: 0, hi: 100000, ...o }),
  bps: (k, label, o = {}) => ({ k, label, type: 'bps', lo: 0, hi: 100000, ...o }),
  int: (k, label, o = {}) => ({ k, label, type: 'int', lo: 0, hi: 1e9, ...o }),
  bool: (k, label, o = {}) => ({ k, label, type: 'bool', ...o }),
  pick: (k, label, opts, o = {}) => ({ k, label, type: 'pilih', opts, ...o }),
  list: (k, label, o = {}) => ({ k, label, type: 'daftar', ...o }),
};

const RULE_GROUPS = [
  {
    g: 'sizing', title: '💰 Ukuran posisi', fields: [
      F.pick('mode', 'Cara menentukan ukuran', [
        ['mirror', 'Sama persis dengan target'], ['pct', 'Persen dari target'],
        ['multiplier', 'Kelipatan target'], ['fixed_quote', 'Nominal tetap']]),
      F.pct('pct', 'Persen dari target', { hi: 1000, when: (r) => r.sizing.mode === 'pct' }),
      F.num('multiplier', 'Kelipatan target', { hi: 100, when: (r) => r.sizing.mode === 'multiplier' }),
      F.usd('fixed_quote_usd', 'Nominal tetap (pool USDG)', { when: (r) => r.sizing.mode === 'fixed_quote' }),
      F.num('fixed_quote_eth', 'Nominal tetap (pool ETH)', { hi: 1000, unit: 'ETH', when: (r) => r.sizing.mode === 'fixed_quote' }),
      F.usd('min_quote_usd', 'Minimum masuk', { help: 'Di bawah ini posisi dilewat — biar tidak habis di gas.' }),
      F.usd('max_quote_per_position_usd', 'Batas per posisi', { help: 'Target LP $400 tapi batas $200 → kita masuk $200.' }),
      F.usd('max_total_exposure_usd', 'Batas total semua posisi'),
      F.usd('daily_budget_usd', 'Anggaran per hari'),
    ],
  },
  {
    g: 'range', title: '📐 Rentang harga', fields: [
      F.pick('mode', 'Cara menentukan rentang', [
        ['exact', 'Persis seperti target'], ['recenter', 'Lebar sama, dipusatkan harga kini'],
        ['scale', 'Lebar target × pengali'], ['width_pct', 'Lebar ±X% dari harga kini'], ['full', 'Seluruh rentang']]),
      F.num('scale', 'Pengali lebar', { hi: 100, when: (r) => r.range.mode === 'scale' }),
      F.pct('width_pct', 'Lebar ±X%', { when: (r) => r.range.mode === 'width_pct' }),
      F.pick('align', 'Pembulatan tick', [['nearest', 'Terdekat'], ['down', 'Ke bawah'], ['up', 'Ke atas']], { when: (r) => r.range.mode !== 'exact' }),
      F.int('min_width_ticks', 'Lebar minimum (tick)', { when: (r) => r.range.mode !== 'full' }),
    ],
  },
  {
    g: 'onesided', title: '⚖️ Posisi satu sisi', fields: [
      F.pick('policy', 'Kalau harga di luar rentang', [
        ['copy', 'Tetap ikut'], ['skip', 'Lewati'], ['recenter', 'Pusatkan ke harga kini']]),
      F.usd('max_quote_usd', 'Batas nominal satu sisi', { when: (r) => r.onesided.policy !== 'skip' }),
    ],
  },
  {
    g: 'swap', title: '🔁 Tukar aset', fields: [
      F.bool('enabled', 'Boleh menukar aset untuk masuk'),
      F.bps('max_slippage_bps', 'Toleransi geser harga', { hi: 5000, when: (r) => r.swap.enabled }),
      F.bps('max_price_impact_bps', 'Batas rugi rute', { hi: 10000, when: (r) => r.swap.enabled }),
    ],
  },
  {
    g: 'exit', title: '🚪 Keluar posisi', fields: [
      F.bool('follow_target', 'Ikut keluar saat target keluar'),
      F.bool('follow_partial', 'Ikut menarik sebagian', { when: (r) => r.exit.follow_target }),
      F.int('out_of_range_minutes', 'Tutup kalau di luar rentang selama (menit)', { help: '0 = mati.' }),
      F.pct('stop_loss_pct', 'Tutup kalau rugi (%)', { hi: 100, help: '0 = mati.' }),
      F.pct('take_profit_pct', 'Tutup kalau untung (%)', { help: '0 = mati.' }),
      F.num('max_age_hours', 'Tutup setelah (jam)', { hi: 100000, help: '0 = mati.' }),
      F.bool('sell_leftover', 'Jual otomatis memecoin sisa'),
      F.bps('sell_max_loss_bps', 'Batas rugi saat menjual sisa', { hi: 10000, when: (r) => r.exit.sell_leftover }),
      F.int('leftover_retry_sec', 'Cek ulang sisa tiap (detik)', { lo: 1, hi: 3600, when: (r) => r.exit.sell_leftover,
        help: 'Satu kutipan Kyber per token per interval; dijual begitu ruginya di bawah batas. Terlalu rapat bisa kena batas laju Kyber.' }),
    ],
  },
  {
    g: 'filters', title: '🧲 Saringan', fields: [
      F.bool('allow_hooks', 'Izinkan pool ber-hook', { help: 'Hook bisa mengunci penarikan. Hati-hati.' }),
      F.list('quote_whitelist', 'Aset kuotasi yang boleh', { help: 'Contoh: USDG, ETH, WETH' }),
      F.list('token_blacklist', 'Daftar hitam token', { help: 'Alamat, dipisah koma. "-" untuk kosongkan.' }),
      F.list('token_whitelist', 'Daftar putih token', { help: 'Kalau diisi, HANYA token ini yang diikuti.' }),
      F.int('min_pool_age_minutes', 'Umur pool minimum (menit)'),
      F.usd('min_target_quote_usd', 'Abaikan aksi target di bawah'),
      F.int('max_open_positions', 'Maksimum posisi terbuka', { hi: 1000 }),
      F.int('cooldown_seconds', 'Jeda antar salinan (detik)'),
      F.list('venues', 'Venue yang dipakai', { help: 'v4, v3' }),
      F.int('max_fee_bps', 'Batas fee pool', { hi: 1e7 }),
    ],
  },
];

// Setelan mesin (bukan aturan salin). Tiap formulir dikirim utuh ke rutenya, jadi
// nilai lama dibaca dulu dari /api/settings lalu digabung dengan yang diubah.
const FORMS = {
  gas: {
    title: '⛽ Gas', post: '/api/settings/gas', pick: (s) => ({ ...s.gas }),
    fields: [
      F.num('price_multiplier', 'Pengali harga gas', { lo: 1, hi: 5 }),
      F.num('priority_gwei', 'Priority fee (gwei)', { hi: 100 }),
      F.int('max_gas_limit', 'Batas gas per transaksi', { lo: 100000, hi: 30000000 }),
      F.num('max_fee_gwei', 'Batas harga gas (gwei)', { lo: 0.01, hi: 10000 }),
      F.num('reserve_eth', 'Cadangan ETH tak tersentuh', { hi: 10, unit: 'ETH' }),
    ],
  },
  mesin: {
    title: '🔧 Mesin', post: '/api/settings/loop', pick: (s) => ({ ...s.loop, ...s.prices }),
    note: 'Perubahan interval baru berlaku setelah proses di-restart.',
    fields: [
      F.int('poll_ms', 'Jeda pindai (ms)', { lo: 500, hi: 60000 }),
      F.int('max_block_span', 'Rentang blok per pindai', { lo: 100, hi: 3000 }),
      F.int('sync_seconds', 'Jeda sinkron posisi (detik)', { lo: 10, hi: 600 }),
      F.num('eth_usd', 'Harga ETH cadangan', { lo: 100, hi: 100000 }),
      F.bool('auto_eth_price', 'Ambil harga ETH otomatis'),
    ],
  },
};

const NOTIF = [
  ['penting', 'Kabar penting (LP disalin / ditutup)'],
  ['error', 'Galat'],
  ['warn', 'Peringatan'],
  ['info', 'Semua baris log'],
];

// ---- util objek -----------------------------------------------------------
const dget = (o, a, b) => (o && o[a] ? o[a][b] : undefined);
function dset(o, a, b, v) { o[a] = { ...(o[a] || {}), [b]: v }; return o; }
function ddel(o, a, b) {
  if (o[a]) { delete o[a][b]; if (!Object.keys(o[a]).length) delete o[a]; }
  return o;
}

function showVal(spec, v) {
  if (v === undefined || v === null) return '—';
  switch (spec.type) {
    case 'bool': return v ? tr("✅ ya") : tr("❌ tidak");
    case 'usd': return usd(v, v >= 100 ? 0 : 2);
    case 'pct': return `${trimZ(nf(v, 2))}%`;
    case 'bps': return `${trimZ(nf(v / 100, 2))}%`;
    case 'pilih': return (spec.opts.find(([k]) => k === v) || [null, String(v)])[1];
    case 'daftar': return Array.isArray(v) && v.length ? v.join(', ') : tr("(kosong)");
    default: return `${trimZ(nf(v, Number.isInteger(v) ? 0 : 4))}${spec.unit ? ' ' + spec.unit : ''}`;
  }
}

// Mengubah jawaban user jadi nilai yang sah, atau melempar galat berbahasa manusia.
function parseVal(spec, raw) {
  const t = String(raw).trim();
  if (spec.type === 'daftar') {
    if (t === '-' || t === '') return [];
    return t.split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (spec.type === 'pilih') {
    const hit = spec.opts.find(([k]) => k === t);
    if (!hit) throw new Error(tr("pilihannya: {0}", [spec.opts.map(([k]) => k).join(', ')]));
    return hit[0];
  }
  if (spec.type === 'bool') return /^(1|ya|yes|y|true|on|nyala)$/i.test(t);
  let n = Number(t.replace(/[$%\s]/g, '').replace(',', '.'));
  if (spec.type === 'bps' && /%$/.test(t.trim())) n = n * 100;
  if (!Number.isFinite(n)) throw new Error(tr("harus berupa angka"));
  if (spec.type === 'int' || spec.type === 'bps') n = Math.round(n);
  if (n < spec.lo || n > spec.hi) throw new Error(tr("harus antara {0} dan {1}", [spec.lo, spec.hi]));
  return n;
}
const askHint = (spec) => {
  if (spec.type === 'daftar') return tr("Kirim daftar dipisah koma, atau \"-\" untuk mengosongkan.");
  if (spec.type === 'bps') return tr("Kirim angka persen (mis. 1,5) atau bps (mis. 150). Antara {0} dan {1} bps.", [spec.lo, spec.hi]);
  return tr("Kirim angka antara {0} dan {1}.", [spec.lo, spec.hi]);
};

// Nama perintah dibuat Inggris supaya cepat diketik dan cocok dengan kebiasaan bot
// Telegram lain; bahasa layar dipilih per chat. Nama lama yang berbahasa Indonesia
// tetap diterima diam-diam (ALIAS) — tidak ditampilkan di menu, tapi tidak
// mematahkan petunjuk atau kebiasaan yang sudah terlanjur dipakai.
const COMMANDS = [
  ['menu', 'Main menu'],
  ['language', 'Choose English or Indonesian'],
  ['summary', 'How the bot is doing right now'],
  ['positions', 'Open positions'],
  ['targets', 'Wallets being copied'],
  ['activity', 'Latest target actions'],
  ['rules', 'Copy rules'],
  ['settings', 'Wallet, RPC, gas, engine'],
  ['balance', 'Bot wallet balance'],
  ['leftovers', 'Leftover memecoin sell queue'],
  ['logs', 'Recent log lines'],
  ['tx', 'Recent transactions'],
  ['scout', 'Quick snapshot of any wallet'],
  ['research', 'Full PnL research on a wallet'],
  ['pause', 'Pause copying'],
  ['resume', 'Resume copying'],
  ['cancel', 'Cancel current input'],
  ['help', 'List every command'],
];
const ALIAS = {
  mulai: 'start', ringkasan: 'summary', status: 'summary', posisi: 'positions',
  target: 'targets', aktivitas: 'activity', aturan: 'rules', pengaturan: 'settings',
  saldo: 'balance', sisa: 'leftovers', log: 'logs', riset: 'research',
  jeda: 'pause', lanjut: 'resume', bantuan: 'help', batal: 'cancel',
};

// Perintah penyambungan: /start <kode>. Dipakai juga oleh tautan dalam t.me.
const PAIR_RE = /^\/(?:start|mulai)(?:@\S+)?\s+(\S+)/i;

class Telegram {
  constructor({ cfg, cfgPath, store, engine, api, shareCard, log }) {
    this.cfg = cfg; this.cfgPath = cfgPath; this.store = store; this.engine = engine;
    this.api = api; this.shareCard = shareCard; this.log = log || (() => {});
    this.sessions = new Map();          // chatId -> { scope, pending, ... }
    this.pairCode = null;               // { code, exp }
    this.offset = Number(store.getState('tg_offset', '0')) || 0;
    this.queue = []; this.sending = false; this.stopped = false; this.fails = 0;
    this.me = null;
    // Token bisa dipasang/diganti dari dasbor selagi proses hidup. `gen` menandai
    // generasi polling: begitu ia naik, loop lama berhenti sendiri saat permintaan
    // yang sedang menggantung kembali (atau dibatalkan lewat `ac`).
    this.gen = 0; this.ac = null; this.wired = false; this.startError = null;
  }

  // ---- dasar ---------------------------------------------------------------
  language(chatId) { return this.store.getState('tg_language:' + chatId, this.cfg.telegram?.language || 'en') === 'id' ? 'id' : 'en'; }
  setLanguage(chatId, language) {
    if (!['id', 'en'].includes(language)) throw new Error('Unsupported language');
    this.store.setState('tg_language:' + chatId, language);
    this.sess(chatId).pending = null;
  }
  token() { return this.cfg.telegram?.bot_token || null; }
  chats() { return (this.cfg.telegram?.chat_ids || []).map(String); }
  notifCfg() { return { penting: true, error: true, warn: true, info: false, ...(this.cfg.telegram?.notify || {}) }; }
  saveCfg() {
    writeCfg(this.cfgPath, this.cfg);        // nilai dari .env tidak ikut tertulis
  }
  sess(chatId) {
    if (!this.sessions.has(chatId)) this.sessions.set(chatId, { scope: 'g', pending: null });
    return this.sessions.get(chatId);
  }

  async tg(method, params = {}) {
    const tok = this.token();
    if (!tok) throw new Error(tr("bot_token Telegram belum diisi"));
    const r = await fetch(`${API}${tok}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: method === 'getUpdates' && this.ac
        ? AbortSignal.any([AbortSignal.timeout(70_000), this.ac.signal])
        : AbortSignal.timeout(25_000),
    });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) throw new Error(j?.description || `HTTP ${r.status}`);
    return j.result;
  }

  async send(chatId, text, keyboard) {
    return this.tg('sendMessage', {
      chat_id: chatId, text: cut(text), parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  }
  // Gambar (kartu bagikan dari dasbor). Multipart, bukan JSON: Telegram hanya
  // menerima berkas lewat form-data. Dikirim sebagai foto supaya tampil langsung
  // di obrolan, bukan sebagai lampiran yang harus diunduh dulu.
  async sendPhoto(chatId, png, caption) {
    const tok = this.token();
    if (!tok) throw new Error(tr("bot_token Telegram belum diisi"));
    const fd = new FormData();
    fd.append('chat_id', String(chatId));
    if (caption) fd.append('caption', cut(caption));
    fd.append('photo', new Blob([png], { type: 'image/png' }), 'quiver.png');
    const r = await fetch(`${API}${tok}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(40_000) });
    const j = await r.json().catch(() => null);
    if (!j || !j.ok) throw new Error(j?.description || `HTTP ${r.status}`);
    return j.result;
  }
  // Navigasi menu menimpa pesan yang sama supaya obrolan tidak penuh.
  async edit(chatId, msgId, text, keyboard) {
    try {
      return await this.tg('editMessageText', {
        chat_id: chatId, message_id: msgId, text: cut(text), parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
    } catch (e) {
      if (/message is not modified/i.test(e.message)) return null;
      return this.send(chatId, text, keyboard);      // pesan terlalu tua untuk disunting
    }
  }

  // Kabar keluar diantre: Telegram menolak lebih dari ~1 pesan/detik per chat.
  push(text, keyboard = null, render = null) {
    if (!this.token() || !this.chats().length) return;
    if (this.queue.length > 40) return;              // banjir log: jangan menumpuk
    this.queue.push(typeof text === 'function' ? { text: '', keyboard, render: text } : { text, keyboard, render });
    if (!this.sending) this.drain();
  }
  async drain() {
    this.sending = true;
    while (this.queue.length && !this.stopped) {
      const { text, keyboard, render } = this.queue.shift();
      for (const c of this.chats()) {
        try {
          await localeContext.run(this.language(c), async () => {
            const result = render ? render() : [text, keyboard];
            const rendered = result?.then ? await result : result;
            await this.send(c, rendered[0], rendered[1]);
          });
        } catch (e) { this.log(`telegram kirim: ${e.message}`); }
      }
      await sleep(1100);
    }
    this.sending = false;
  }

  // ---- penyambungan chat ---------------------------------------------------
  newPairCode() {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    this.pairCode = { code, exp: Date.now() + 15 * 60_000 };
    return code;
  }
  tryPair(chatId, code) {
    const p = this.pairCode;
    if (!p || Date.now() > p.exp) return { error: tr("Kode sudah kedaluwarsa. Buat kode baru di dasbor → Pengaturan → Telegram.") };
    if (String(code || '').trim().toUpperCase() !== p.code) return { error: tr("Kode salah.") };
    this.pairCode = null;
    const ids = [...new Set([...this.chats(), String(chatId)])];
    this.cfg.telegram = { ...(this.cfg.telegram || {}), chat_ids: ids };
    this.saveCfg();
    this.log(`telegram: chat ${chatId} disambungkan`);
    return { ok: true };
  }

  // ---- daur hidup ----------------------------------------------------------
  async start() {
    this.startError = null;
    if (!this.token()) { this.log('telegram: bot_token belum diisi — bot tidak dijalankan'); return { ok: false, reason: 'tanpa token' }; }
    this.stopped = false;
    this.ac = new AbortController();
    const gen = ++this.gen;
    try {
      this.me = await this.tg('getMe');
      await this.tg('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })) });
    } catch (e) {
      this.startError = e.message;
      this.log(`telegram: tidak bisa menghubungi Telegram (${e.message}) — tetap mencoba di latar`);
    }
    if (gen !== this.gen) return { ok: false, reason: 'dibatalkan' };   // keburu diganti lagi
    this.log(`telegram: bot ${this.me ? '@' + this.me.username : '(?)'} jalan · ${this.chats().length} chat terhubung`);
    if (!this.chats().length) {
      const c = this.newPairCode();
      this.log(`telegram: belum ada chat terhubung. Kirim ke bot →  /start ${c}   (berlaku 15 menit)`);
    }
    this.wire();
    this.poll(gen);
    return { ok: !this.startError, username: this.me?.username || null, error: this.startError };
  }

  // Menyalakan ulang dengan token yang baru disimpan, tanpa me-restart proses.
  // Loop lama dihentikan dulu supaya tidak ada dua pendengar pada satu antrean update.
  async restart() {
    this.gen++;
    try { this.ac?.abort(); } catch { /* belum ada permintaan berjalan */ }
    this.me = null;
    return this.start();
  }

  // Pengait ke mesin cuma dipasang sekali seumur proses — kalau tidak, tiap
  // penyalaan ulang menambah satu lapis pembungkus dan kabar terkirim berlipat.
  wire() {
    if (this.wired) return;
    this.wired = true;
    const prevNotify = this.engine.onNotify;
    this.engine.onNotify = (msg, detail) => {
      if (prevNotify) prevNotify(msg, detail);
      // engine.notify() juga menulis baris log 'info' dengan teks yang sama. Kalau
      // pengiriman baris info sedang dinyalakan, kabar yang sama akan datang dua
      // kali — yang ini dicatat supaya penyaring log di bawah melewatinya.
      this.lastNotify = msg;
      if (!this.notifCfg().penting) return;
      if (!detail?.kind) return this.push(`🔔 <b>${esc(note(msg))}</b>`, null, () => [`🔔 <b>${esc(note(msg))}</b>`, null]);
      // Kabar berdetail disusun jadi kartu (butuh baca API, jadi asinkron). Kalau
      // penyusunannya gagal, teks polosnya tetap terkirim — kabar tidak boleh hilang.
      this.push(async () => {
        try { return await this.kartu(msg, detail); }
        catch (e) { this.log(`telegram kartu: ${e.message}`); return [`🔔 <b>${esc(note(msg))}</b>`, null]; }
      });
    };
    const prevLog = this.store.onLog;
    this.store.onLog = (level, msg, meta) => {
      if (prevLog) prevLog(level, msg, meta);
      const n = this.notifCfg();
      // Masalah yang sedang ditangani jalan cadangan (RPC berpindah endpoint, tick
      // mengulang rentang, antrean coba-ulang): cukup di log dan dasbor. Mesin sendiri
      // yang mengirim satu peringatan kalau cadangannya terus gagal.
      if (meta?.quiet) return;
      // Kabar pulih menutup peringatan galat — ikut setelan galat, bukan setelan info.
      if (meta?.recovered) { if (n.error) this.push(logBaris('pulih', msg), null, () => [logBaris('pulih', msg), null]); return; }
      if (level === 'error' && n.error) this.push(logBaris(level, msg), null, () => [logBaris(level, msg), null]);
      else if (level === 'warn' && n.warn) this.push(logBaris(level, msg), null, () => [logBaris(level, msg), null]);
      else if (level === 'info' && n.info && msg !== this.lastNotify) this.push(logBaris(level, msg), null, () => [logBaris(level, msg), null]);
    };
  }
  stop() { this.stopped = true; this.gen++; try { this.ac?.abort(); } catch { /* abaikan */ } }

  async poll(gen = this.gen) {
    while (!this.stopped && gen === this.gen) {
      try {
        const ups = await this.tg('getUpdates', {
          offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'],
        });
        if (gen !== this.gen) return;
        for (const u of ups) {
          this.offset = u.update_id + 1;
          this.store.setState('tg_offset', this.offset);
          // Sengaja TIDAK ditunggu: satu riset wallet bisa berjalan belasan menit,
          // dan selama itu tombol lain harus tetap bisa ditekan. Offset sudah maju
          // duluan, jadi update yang sama tidak akan diproses dua kali.
          this.handle(u).catch((e) => this.log(`telegram tangani: ${e.message}`));
        }
        if (gen !== this.gen) return;               // token diganti selagi menunggu
        this.fails = 0;
      } catch (e) {
        if (gen !== this.gen || this.stopped) return;  // dihentikan sengaja, bukan galat
        this.fails++;
        // 409 = ada instance lain ikut polling token yang sama; jangan berisik.
        if (this.fails <= 3 || this.fails % 25 === 0) this.log(`telegram polling: ${e.message}`);
        await sleep(Math.min(30_000, 1500 * this.fails));
      }
    }
  }

  // ---- penerima update -----------------------------------------------------
  async handle(u) {
    const chat = u.message?.chat || u.callback_query?.message?.chat;
    if (!chat) return;
    return localeContext.run(this.language(String(chat.id)), () => this.handleLocalized(u));
  }

  async handleLocalized(u) {
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.message) return this.onMessage(u.message);
  }

  async onMessage(msg) {
    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    if (!this.chats().includes(chatId)) {
      const m = text.match(PAIR_RE);
      if (m) {
        // Bot ini bisa menutup posisi dan menyalakan LIVE; di grup SEMUA anggota bisa
        // menekan tombolnya. Hanya chat pribadi yang boleh disambungkan, kecuali
        // telegram.allow_groups sengaja dinyalakan di config.
        if (msg.chat.type && msg.chat.type !== 'private' && !this.cfg.telegram?.allow_groups) {
          return this.send(chatId, tr("❌ Grup tidak bisa disambungkan: semua anggota grup akan bisa mengendalikan bot. Sambungkan dari chat pribadi, atau nyalakan telegram.allow_groups di config kalau memang disengaja."));
        }
        const r = this.tryPair(chatId, m[1]);
        if (r.error) return this.send(chatId, `❌ ${esc(note(r.error))}`);
        return this.screen(chatId, null, 'h', tr("✅ Chat tersambung. Selamat datang di <b>Quiver</b>.\n\n"));
      }
      // Bot ini bisa ditemukan siapa saja lewat namanya. Petunjuknya dikirim sekali
      // per chat; sisanya didiamkan supaya tidak bisa dipakai memancing balasan terus.
      if (!this.told) this.told = new Set();
      if (this.told.has(chatId)) return;
      this.told.add(chatId);
      return this.send(chatId, tr("Chat ini belum tersambung ke Quiver.\n\nBuka dasbor → <b>Pengaturan</b> → <b>Telegram</b> → <i>Buat kode</i>, lalu kirim di sini:\n<code>/start KODE</code>"));
    }

    const s = this.sess(chatId);
    // Sedang ditanya sesuatu? Jawaban apa pun yang bukan perintah dianggap isian.
    if (s.pending && !text.startsWith('/')) {
      const p = s.pending; s.pending = null;
      try { return await this.answer(chatId, p, text); }
      catch (e) {
        s.retryInput = p;
        return this.send(chatId, tr("⚠️ <b>Belum berhasil</b>\n{0}\n\nPilih Isi ulang untuk memperbaiki jawaban Anda.", [esc(note(e.message))]),
          kb([[btn(tr("✏️ Isi ulang"), 'inputRetry'), btn(tr("↩︎ Batal"), 'cancelInput')]]));
      }
    }
    // Alamat ditempel begitu saja (atau tautan DexScreener/GeckoTerminal yang memuatnya):
    // token -> langsung ke kartu pasang LP; wallet -> pilihan riset / jadikan target.
    // (?![0-9a-f]) mencegah poolId v4 (64 hex) terbaca sebagai alamat 40 hex.
    if (!text.startsWith('/') && text.length <= 300) {
      const a = text.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/)?.[0];
      if (a) return this.tempel(chatId, a.toLowerCase());
    }
    if (!text.startsWith('/')) return this.screen(chatId, null, 'h');

    const raw = text.slice(1).split(/[\s@]/)[0].toLowerCase();
    const cmd = ALIAS[raw] || raw;
    const arg = text.split(/\s+/).slice(1).join(' ').trim();
    const go = (d) => this.screen(chatId, null, d);
    if (cmd !== 'cancel') { s.pending = null; s.retryInput = null; }
    switch (cmd) {
      case 'cancel': return go('cancelInput');
      case 'start': case 'menu': return go('h');
      case 'summary': return go('o');
      case 'positions': return go('p');
      case 'targets': return go('t');
      case 'activity': return go('a:0');
      case 'rules': return go('r');
      case 'settings': return go('s');
      case 'language': case 'bahasa': return go('lang');
      case 'balance': return go('b');
      case 'leftovers': return go('f');
      case 'logs': return go('l');
      case 'tx': return go('x');
      case 'pause': return this.setPause(chatId, null, true);
      case 'resume': return this.setPause(chatId, null, false);
      case 'scout':
        if (arg) return this.runScout(chatId, arg);
        return this.ask(chatId, { kind: 'scout' }, tr("Kirim alamat wallet yang mau dipotret.\n<i>Contoh:</i> <code>0x3c92…2976</code>"));
      case 'research':
        if (arg) return this.runRiset(chatId, arg);
        return this.ask(chatId, { kind: 'riset' }, tr("Kirim alamat wallet yang mau diriset (PnL, posisi, riwayat)."));
      case 'help':
        return this.send(chatId, tr("<b>Perintah</b>\n{0}\n\nSemua ini juga ada tombolnya di /menu.\n\n💡 Tempel <b>alamat token</b> kapan saja → langsung ke layar pasang LP. Tempel <b>alamat wallet</b> → riset PnL atau jadikan target.", [COMMANDS.map(([c, d]) => `/${c} — ${esc(tr(d))}`).join('\n')]), kb([[BACK_HOME]]));
      default:
        return this.send(chatId, tr("Perintah tidak dikenal. /bantuan untuk daftarnya."), kb([[BACK_HOME]]));
    }
  }

  async onCallback(q) {
    const chatId = String(q.message.chat.id);
    const msgId = q.message.message_id;
    // Telegram memutar animasi di tombol sampai callback-nya dijawab, dan berhenti
    // menerima jawaban setelah beberapa detik. Layar yang lambat (uji RPC, riset)
    // karena itu dijawab duluan oleh pengaman 2 detik; jawaban kedua diabaikan.
    let acked = false;
    const ack = async (text, alert = false) => {
      if (acked) return;
      acked = true;
      await this.tg('answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
    };
    if (!this.chats().includes(chatId)) return ack(tr("Chat ini tidak berwenang."), true);
    const guard = setTimeout(() => { ack(); }, 2000);
    try {
      await this.screen(chatId, msgId, q.data, '', ack);
      await ack();
    } catch (e) {
      this.log(`telegram tombol ${q.data}: ${e.message}`);
      await ack(tr("Galat: {0}", [e.message]).slice(0, 190), true);
      await this.edit(chatId, msgId, tr("⛔ <b>Gagal</b>\n<code>{0}</code>", [esc(note(e.message))]), kb([[BACK_HOME]])).catch(() => {});
    } finally { clearTimeout(guard); }
  }

  // Menanyakan sesuatu ke user; jawabannya ditangani di answer().
  ask(chatId, pending, text) {
    this.sess(chatId).pending = { ...pending, prompt: text };
    this.sess(chatId).retryInput = null;
    return this.send(chatId, tr("{0}\n\n<i>Balas dengan teks. /cancel untuk membatalkan.</i>", [text]),
      kb([[btn(tr("↩︎ Batal"), 'cancelInput')]]));
  }

  // ---- pemetaan layar ------------------------------------------------------
  async screen(chatId, msgId, data, prefix = '', ack = null) {
    const [head, ...rest] = String(data).split(':');
    const out = (text, keyboard) => (msgId ? this.edit(chatId, msgId, prefix + text, keyboard) : this.send(chatId, prefix + text, keyboard));
    const s = this.sess(chatId);

    const input = s.pending || s.retryInput;
    s.pending = null;
    s.retryInput = null;
    switch (head) {
      case 'inputRetry':
        if (input?.prompt) return this.ask(chatId, input, input.prompt);
        return this.screen(chatId, msgId, 'h', tr("Sesi input sudah berakhir. Pilih tindakan dari menu.\n\n"));
      case 'cancelInput':
        return this.screen(chatId, msgId, input?.retry || 'h', tr("Input dibatalkan.\n\n"));
      case 'lang': return out('<b>Language / Bahasa</b>\nChoose your language. Pilih bahasa Anda.', kb([
        [btn((this.language(chatId) === 'en' ? '✓ ' : '') + 'English', 'langSet:en'), btn((this.language(chatId) === 'id' ? '✓ ' : '') + 'Bahasa Indonesia', 'langSet:id')],
        [BACK_HOME],
      ]));
      case 'langSet': {
        this.setLanguage(chatId, rest[0]);
        return localeContext.run(rest[0], () => this.screen(chatId, msgId, 's'));
      }
      case 'h': return out(...(await this.home()));
      case 'o': return out(...(await this.overview()));
      case 'b': return out(...(await this.saldo()));
      case 'p': return rest[0] ? out(...(await this.posisiDetail(rest[0]))) : out(...(await this.posisi()));
      case 'pc': return out(...(await this.tutupKonfirm(rest[0])));
      // Kartu bagikan: gambar PnL (src/share-card.js) dikirim sebagai foto ke chat ini;
      // layar yang sedang tampil tidak diubah, cukup notifikasi kecil di tombolnya.
      case 'ps': case 'os': {
        if (!this.shareCard) throw new Error('kartu bagikan tidak tersedia');
        const card = await this.shareCard({ kind: head === 'ps' ? 'position' : 'total', id: rest[0], lang: locale() });
        if (card.error) throw new Error(note(card.error));
        await this.sendPhoto(chatId, card.png, card.caption);
        return ack ? ack(tr("Kartu dikirim.")) : null;
      }
      case 'ac': return out(...(await this.compoundScreen(rest[0])));
      case 'acT': {
        const r = await this.api('POST', '/api/positions/compound', { id: Number(rest[0]), enabled: rest[1] === '1' });
        if (r.error) return out(esc(note(r.error)), kb([[btn(tr("↩︎ Posisi"), `p:${rest[0]}`)]]));
        return out(...(await this.compoundScreen(rest[0])));
      }
      case 'acM': return this.ask(chatId, { kind: 'compoundMin', posId: Number(rest[0]), retry: `ac:${rest[0]}` },
        tr("Ketik minimum fee yang ditambahkan dalam USD, misalnya 5. Batas: 0,01 sampai 1.000.000."));
      case 'acI': return this.ask(chatId, { kind: 'compoundInterval', posId: Number(rest[0]), retry: `ac:${rest[0]}` },
        tr("Ketik interval pemeriksaan dalam menit, misalnya 30. Batas: 1 sampai 10.080 menit."));
      case 'pf': {
        const d = await this.api('GET', '/api/positions');
        const p = (d.positions || []).find((x) => String(x.id) === rest[0]);
        if (!p) return out(tr("Posisi #{0} tidak ada di daftar terbuka.", [esc(rest[0])]), kb([[BACK_HOME]]));
        return out(tr("💰 <b>Claim fee posisi #{0}?</b>\nPerkiraan fee: {1}. Fee dikirim ke wallet dalam token pool. Likuiditas tetap terbuka; gas tetap dibayar.", [esc(p.id), usd(p.feeUsd)]),
          kb([[btn(tr("✅ Claim fee"), `pF:${p.id}`)], [btn(tr("↩︎ Posisi"), `p:${p.id}`)]]));
      }
      case 'pF': {
        if (ack) await ack(tr("Mengirim transaksi…"));
        await out(tr("⏳ Mengklaim fee… menunggu konfirmasi di chain."));
        const r = await this.api('POST', '/api/positions/claim', { id: Number(rest[0]) });
        const message = r.error ? tr("❌ Claim fee gagal: {0}", [esc(note(r.error))])
          : r.pending ? tr("⏳ Claim fee masih diproses. Cek lagi sebentar. Tx: {0}", [esc(r.tx)])
          : r.accountingPending ? tr("✅ Fee sudah diklaim. Pencatatan nominal menunggu sinkronisasi. Tx: {0}", [esc(r.tx)])
          : tr("✅ Fee diklaim ke wallet. Posisi tetap terbuka. Tx: {0}", [esc(r.tx)]);
        return out(message, kb([[btn(tr("↩︎ Posisi"), `p:${rest[0]}`), BACK_HOME]]));
      }
      case 'pC': {
        if (ack) await ack(tr("Mengirim transaksi…"));
        // Server baru menjawab setelah receipt diterima (bisa ~1 menit); tanpa pesan
        // antara, layar konfirmasi terlihat macet dan tombolnya mengundang klik ulang.
        if (msgId) await out(tr("⏳ Menutup posisi #{0}… menunggu konfirmasi di chain.", [esc(rest[0])]));
        const r = await this.api('POST', '/api/positions/close', { id: Number(rest[0]) });
        if (r.error) return out(tr("❌ Gagal menutup posisi #{0}\n<code>{1}</code>", [esc(rest[0]), esc(note(r.error))]), kb([[btn(tr("↩︎ Posisi"), 'p'), BACK_HOME]]));
        const hasil = [
          r.outUsd != null && `Diterima ${usd(r.outUsd)}`,
          r.pnlUsd != null && `PnL ${sgn(r.pnlUsd)}`,
        ].filter(Boolean).join(' · ');
        return out(tr("✅ Posisi #{0} ditutup.{1}{2}\nTx: <code>{3}</code>", [esc(rest[0]), hasil ? `\n${hasil}` : '', r.sold ? `\n${esc(r.sold)}` : '', esc(shortH(r.tx))]), kb([[btn(tr("↩︎ Posisi"), 'p'), BACK_HOME]]));
      }
      case 't': return rest[0] ? out(...(await this.targetDetail(rest[0]))) : out(...(await this.targets()));
      case 'tt': {
        const list = (await this.api('GET', '/api/targets')).targets;
        const tgt = list.find((x) => x.address === rest[0]);
        await this.api('POST', '/api/targets/toggle', { address: rest[0], enabled: !tgt?.enabled });
        if (ack) await ack(tgt?.enabled ? tr("Target dimatikan") : tr("Target dinyalakan"));
        return out(...(await this.targetDetail(rest[0])));
      }
      case 'tn': return this.ask(chatId, { kind: 'label', address: rest[0], retry: `t:${rest[0]}` }, tr("Kirim nama baru untuk <code>{0}</code>.", [esc(shortA(rest[0]))]));
      case 'td': return out(tr("🗑 Hapus target <code>{0}</code>?\n\nPosisi yang sudah terbuka <b>tidak</b> ikut ditutup — bot cuma berhenti mengikuti wallet ini.", [esc(rest[0])]),
        kb([[btn(tr("✅ Ya, hapus"), `tD:${rest[0]}`)], [btn(tr("↩︎ Batal"), `t:${rest[0]}`)]]));
      case 'tD':
        await this.api('POST', '/api/targets/delete', { address: rest[0] });
        if (ack) await ack(tr("Target dihapus"));
        return out(...(await this.targets()));
      case 'ta': return this.ask(chatId, { kind: 'tambahTarget', retry: 't' }, tr("Kirim alamat wallet yang mau diikuti.\nBoleh sekalian namanya: <code>0xabc… Bang GE</code>"));
      case 'tr':
        await this.api('POST', '/api/wallet/scan', { address: rest[0], mode: 'refresh' });
        if (ack) await ack(tr("Riset dimulai di latar"));
        return out(...(await this.riset(rest[0])));
      case 'tw': return out(...(await this.riset(rest[0])));
      case 'ts': s.scope = rest[0]; return out(...(await this.rulesMenu(chatId)));

      case 'a': return out(...(await this.aktivitas(Number(rest[0] || 0))));
      case 'l': return out(...(await this.logs()));
      case 'x': return out(...(await this.txs()));

      case 'r': return rest[0] ? out(...(await this.rulesGroup(chatId, Number(rest[0])))) : out(...(await this.rulesMenu(chatId)));
      case 'rg': s.scope = 'g'; return out(...(await this.rulesMenu(chatId)));
      case 're': return this.askField(chatId, localizeSchema(RULE_GROUPS)[+rest[0]].fields[+rest[1]], `re:${rest[0]}:${rest[1]}`, `r:${rest[0]}`);
      case 'rb': case 'rv': {
        const grp = localizeSchema(RULE_GROUPS)[+rest[0]], spec = grp.fields[+rest[1]];
        const cur = await this.readRules(chatId);
        const val = head === 'rb' ? !this.resolvedRule(cur.resolved, grp.g, spec.k) : spec.opts[+rest[2]][0];
        await this.writeRule(chatId, grp.g, spec.k, val);
        if (ack) await ack(tr("Tersimpan"));
        return out(...(await this.rulesGroup(chatId, +rest[0])));
      }
      case 'rp': {                                  // pilih nilai dari daftar
        const grp = localizeSchema(RULE_GROUPS)[+rest[0]], spec = grp.fields[+rest[1]];
        return out(tr("<b>{0}</b>\n{1}\nPilih:", [esc(spec.label), spec.help ? esc(spec.help) + '\n' : '']),
          kb([...spec.opts.map(([k, lbl], i) => [btn(lbl, `rv:${rest[0]}:${rest[1]}:${i}`)]), [btn(tr("↩︎ Kembali"), `r:${rest[0]}`)]]));
      }
      case 'rx':
        await this.clearRule(chatId, localizeSchema(RULE_GROUPS)[+rest[0]].g, localizeSchema(RULE_GROUPS)[+rest[0]].fields[+rest[1]].k);
        if (ack) await ack(tr("Penyesuaian dihapus"));
        return out(...(await this.rulesGroup(chatId, +rest[0])));

      case 's': return out(...(await this.settings()));
      case 'sp': return this.setPause(chatId, msgId, !this.engine.paused(), ack);
      case 'sl': {
        if (!this.engine.dryRun()) {                 // mematikan LIVE tidak perlu konfirmasi
          const r = await this.api('POST', '/api/settings/live', { live: false });
          if (ack) await ack(r.error || tr("Kembali ke mode simulasi"));
          return out(...(await this.settings()));
        }
        return this.ask(chatId, { kind: 'live', retry: 's' },
          tr("⚠️ <b>Menyalakan mode LIVE</b>\n\nMulai saat itu bot mengirim transaksi sungguhan memakai dana di wallet bot.\n\nKetik <code>LIVE</code> untuk mengonfirmasi."));
      }
      case 'wb': return out(...(await this.walletScreen()));
      case 'wbg': return out(tr("🔑 <b>Buat wallet baru?</b>\n\nKunci lama otomatis dicadangkan (tidak dihapus), lalu bot memakai alamat baru. Dana di alamat lama <b>tidak</b> ikut pindah.\n\nHanya bisa saat mode simulasi."),
        kb([[btn(tr("✅ Ya, buat baru"), 'wbG')], [btn(tr("↩︎ Batal"), 'wb')]]));
      case 'wbG': {
        const r = await this.api('POST', '/api/settings/wallet/generate', { replace: true });
        if (r.error) return out(`❌ ${esc(note(r.error))}`, kb([[btn(tr("↩︎ Kembali"), 'wb')]]));
        return out(tr("✅ Wallet baru: <code>{0}</code>\nFrasa pemulihan disimpan di server (<code>{1}</code>) dan sengaja tidak dikirim lewat Telegram.", [esc(r.address), esc(r.mnemonicFile)]), kb([[btn(tr("↩︎ Wallet"), 'wb')], [BACK_HOME]]));
      }
      case 'wbr': return this.ask(chatId, { kind: 'lepasWallet', retry: 'wb' }, tr("Untuk melepas wallet, kirim alamatnya persis (kunci dicadangkan, tidak dihapus)."));

      case 'sr': {
        if (!rest[0]) return out(...(await this.rpcScreen()));
        if (ack) await ack(tr("Menguji endpoint…"));
        await out(tr("🔬 Menguji endpoint… <i>(bisa sampai satu menit)</i>"));
        return out(...(await this.rpcTest(+rest[0])));
      }
      case 'sra': return this.ask(chatId, { kind: 'rpcTambah', retry: 'sr' }, tr("Kirim URL endpoint RPC baru (harus <code>https://</code>).\n\n<i>Jangan kirim URL yang mengandung API key lewat Telegram — pakai dasbor untuk itu.</i>"));
      case 'srd': {
        const st = await this.api('GET', '/api/settings');
        const keep = st.rpc.filter((e) => e.id !== +rest[0]).map((e) => ({ id: e.id }));
        const r = await this.api('POST', '/api/settings/rpc', { endpoints: keep });
        if (ack) await ack(r.error || tr("Endpoint dihapus"));
        return out(...(await this.rpcScreen()));
      }

      case 'sf': return out(...(await this.form(rest[0])));
      case 'sfe': return this.askField(chatId, localizeSchema(FORMS)[rest[0]].fields[+rest[1]], `sfe:${rest[0]}:${rest[1]}`, `sf:${rest[0]}`);
      case 'sfb': {
        const f = localizeSchema(FORMS)[rest[0]], spec = f.fields[+rest[1]];
        const st = await this.api('GET', '/api/settings');
        const cur = f.pick(st);
        const r = await this.api('POST', f.post, { ...cur, [spec.k]: !cur[spec.k] });
        if (ack) await ack(r.error || tr("Tersimpan"));
        return out(...(await this.form(rest[0])));
      }

      case 'sn': return out(...(await this.notifyScreen()));
      case 'snb': {
        const n = this.notifCfg();
        this.cfg.telegram = { ...(this.cfg.telegram || {}), notify: { ...n, [rest[0]]: !n[rest[0]] } };
        this.saveCfg();
        if (ack) await ack(tr("Tersimpan"));
        return out(...(await this.notifyScreen()));
      }
      case 'snp': return this.ask(chatId, { kind: 'ntfy', retry: 'sn' }, tr("Kirim topik ntfy (4–64 huruf/angka/-/_), atau <code>-</code> untuk mematikan."));
      case 'snt': {
        const r = await this.api('POST', '/api/settings/notify/test');
        if (ack) await ack(r.error || tr("Terkirim ke ntfy"));
        return out(...(await this.notifyScreen()));
      }
      case 'sc': return out(...(await this.chatsScreen()));
      case 'scd': {
        const ids = this.chats().filter((c) => c !== rest[0]);
        this.cfg.telegram = { ...(this.cfg.telegram || {}), chat_ids: ids };
        this.saveCfg();
        this.log(`telegram: chat ${rest[0]} dilepas`);
        if (ack) await ack(tr("Chat dilepas"));
        return out(...(await this.chatsScreen()));
      }
      case 'sk': return out(tr("🔐 <b>Ganti token akses dasbor?</b>\n\nSemua peramban yang sedang terbuka harus masuk ulang dengan token baru."),
        kb([[btn(tr("✅ Ya, ganti"), 'sK')], [btn(tr("↩︎ Batal"), 's')]]));
      case 'sK': {
        const r = await this.api('POST', '/api/settings/token/rotate', {});
        return out(tr("🔐 Token akses baru:\n<code>{0}</code>\n\n<i>Simpan sekarang — token ini tidak ditampilkan lagi. Hapus pesan ini setelah disalin.</i>", [esc(r.token)]), kb([[btn(tr("↩︎ Pengaturan"), 's')]]));
      }

      case 'f': return out(...(await this.leftovers()));
      case 'fr': {
        if (ack) await ack(tr("Mencoba menjual sekarang…"));
        const r = await this.api('POST', '/api/leftovers/retry', {});
        return out(...(await this.leftovers(r.error)));
      }
      case 'fd': {
        const r = await this.api('POST', '/api/leftovers/drop', { posId: Number(rest[0]), token: rest[1] });
        if (ack) await ack(r.error || tr("Dikeluarkan dari antrean"));
        return out(...(await this.leftovers()));
      }

      // ---- LP manual ----
      case 'ml': s.lpAsal = 'ml'; return out(...(await this.lpMenu(chatId)));

      // ---- kartu pasang LP (alamat token ditempel) ----
      case 'qk': return out(...(await this.lpKartu(chatId)));
      case 'qkn': s.lp = { ...(s.lp || {}), usd: Number(rest[0]) }; return out(...(await this.lpKartu(chatId)));
      case 'qkN': s.lpAsal = 'qk';
        return this.ask(chatId, { kind: 'lpUsd', retry: 'qk' }, tr("Berapa dolar yang mau dimasukkan?\n\n<i>Ini nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.</i>"));
      case 'qkw': s.lp = { ...(s.lp || {}), lowerPct: Number(rest[0]), upperPct: Number(rest[1]), widthPct: undefined, full: false };
        return out(...(await this.lpKartu(chatId)));
      case 'qkF': s.lp = { ...(s.lp || {}), full: true }; return out(...(await this.lpKartu(chatId)));
      case 'qkC': s.lpAsal = 'qk';
        return this.ask(chatId, { kind: 'lpWidth', retry: 'qk' },
          tr("Kirim <b>batas bawah</b> dan <b>batas atas</b> dalam persen dari harga kini.\n\n")
          + tr("<code>10 30</code> → turun sampai −10%, naik sampai +30%\n")
          + '<code>25</code> → ±25%\n'
          + tr("<code>-30 -10</code> → seluruhnya di bawah harga kini: hanya aset kuotasi (misal USDG) yang disetor\n\n"));
      case 'qkp': return out(...this.lpKartuPool(chatId));
      case 'qkP': {
        const pool = (s.qkPools || [])[+rest[0]];
        if (pool) s.lp = { ...(s.lp || {}), poolRef: pool.poolRef, pair: pool.pair };
        return out(...(await this.lpKartu(chatId)));
      }
      case 'qkY': return out(...this.lpKartuYakin(chatId));

      // ---- alamat wallet yang ditempel ----
      case 'adT': {
        if (!/^0x[0-9a-f]{40}$/.test(s.alamat || '')) return out(tr("Alamatnya sudah tidak tersimpan — tempel lagi."), kb([[BACK_HOME]]));
        const r = await this.api('POST', '/api/targets', { address: s.alamat, label: null });
        if (r.error) return out(`❌ ${esc(note(r.error))}`, kb([[BACK_HOME]]));
        return out(tr("✅ <code>{0}</code> sekarang diikuti.\n<i>Aturan default dipakai sampai kamu setel sendiri.</i>", [esc(shortA(s.alamat))]), kb([[btn(tr("🎯 Daftar target"), 't'), BACK_HOME]]));
      }
      case 'mlp': return out(...(await this.lpPools(chatId, Number(rest[0] || 0), rest[1] || '')));
      case 'mlP': {
        const pool = (s.poolList || [])[+rest[0]];
        if (!pool) return out(...(await this.lpPools(chatId, 0)));
        s.lp = { ...(s.lp || { usd: null, lowerPct: 25, upperPct: 25 }), poolRef: pool.poolRef, pair: pool.pair };
        return out(...(await this.lpMenu(chatId)));
      }
      case 'mlc': return this.ask(chatId, { kind: 'poolCari', retry: 'mlp:0' }, tr("Ketik nama pasangan yang dicari, misal <code>HOOKR</code> atau <code>USDG/ND4</code>."));
      case 'mla': return this.ask(chatId, { kind: 'scanToken', retry: 'mlp:0' },
        tr("Kirim <b>alamat token</b>-nya. Bot akan mencari sendiri semua pool Uniswap v3 & v4 yang memuat token itu, langsung dari chain.\n\n<i>Contoh:</i> <code>0x12d5ee7917ca430073c3a638ee1e6f0648a98a01</code>"));
      case 'mls': return out(...(await this.lpHasilPindai(chatId, rest[0], rest[1] === 'all')));
      case 'mln': return this.ask(chatId, { kind: 'lpUsd', retry: 'ml' }, tr("Berapa dolar yang mau dimasukkan?\n\n<i>Ini nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.</i>"));
      case 'mlr': return out(...(await this.lpRange(chatId)));
      case 'mlw': {
        const lo = Number(rest[0]), up = Number(rest[1] ?? rest[0]);
        s.lp = { ...(s.lp || {}), lowerPct: lo, upperPct: up, widthPct: undefined, full: false };
        return out(...(await this.lpMenu(chatId)));
      }
      case 'mlF': { s.lp = { ...(s.lp || {}), full: true }; return out(...(await this.lpMenu(chatId))); }
      case 'mlC': return this.ask(chatId, { kind: 'lpWidth', retry: 'mlr' },
        tr("Kirim <b>batas bawah</b> dan <b>batas atas</b> dalam persen dari harga kini.\n\n")
        + tr("<code>10 30</code> → turun sampai −10%, naik sampai +30%\n")
        + '<code>25</code> → ±25%\n'
        + tr("<code>0 50</code> → mulai tepat di harga kini, naik sampai +50%\n")
        + tr("<code>-30 -10</code> → seluruhnya di bawah harga kini: hanya aset kuotasi (misal USDG) yang disetor\n\n")
        + tr("<i>Makin sempit makin besar fee-nya, tapi makin cepat keluar rentang.</i>"));
      case 'mlv': return out(...(await this.lpPreview(chatId)));
      case 'mlX': {
        const d = s.lp || {};
        if (ack) await ack(tr("Membuka posisi…"));
        await out(tr("⏳ Membuka posisi… <i>(jembatan kas, zap, lalu mint — bisa sampai satu menit)</i>"));
        const r = await this.api('POST', '/api/manual/lp/open', d);
        if (r.error) return out(tr("⛔ <b>Gagal membuka LP</b>\n<code>{0}</code>", [esc(note(r.error))]), kb([[s.lpAsal === 'qk' ? btn(tr("↩︎ Kembali"), 'qk') : btn(tr("↩︎ LP manual"), 'ml'), BACK_HOME]]));
        s.lp = null;
        return out(tr("✅ <b>LP dibuka</b>\n{0}\ntx <code>{1}</code>", [esc(r.note), esc(shortH(r.tx))]), kb([[btn(tr("💼 Lihat posisi"), 'p')], [BACK_HOME]]));
      }

      // ---- swap manual ----
      case 'sw': return out(...(await this.swapMenu(chatId)));
      case 'swf': case 'swt': return out(...(await this.swapPick(chatId, head === 'swf' ? 'from' : 'to')));
      case 'swF': case 'swT': {
        const tok = (s.tokenList || [])[+rest[0]];
        if (!tok) return out(...(await this.swapMenu(chatId)));
        s.sw = { ...(s.sw || {}), [head === 'swF' ? 'from' : 'to']: tok.address, [head === 'swF' ? 'symFrom' : 'symTo']: tok.symbol };
        return out(...(await this.swapMenu(chatId)));
      }
      case 'swn': return this.ask(chatId, { kind: 'swAmount', retry: 'sw' }, tr("Berapa yang mau ditukar?\n\nBoleh angka (<code>0,05</code>), persen (<code>50%</code>), atau <code>semua</code>."));
      case 'swq': return out(...(await this.swapQuote(chatId, ack)));
      case 'swX': {
        const d = s.sw || {};
        if (ack) await ack(tr("Menukar…"));
        await out(tr("⏳ Menukar lewat Kyber…"));
        const r = await this.api('POST', '/api/manual/swap', { tokenIn: d.from, tokenOut: d.to, amount: d.amount });
        if (r.error) return out(tr("⛔ <b>Swap gagal</b>\n<code>{0}</code>", [esc(note(r.error))]), kb([[btn('↩︎ Swap', 'sw'), BACK_HOME]]));
        s.sw = { ...d, amount: null };
        return out(tr("✅ <b>Swap selesai</b>\n{0}{1}\ntx <code>{2}</code>", [esc(r.note), r.dex ? tr("\nlewat {0}", [esc(r.dex)]) : '', esc(shortH(r.tx))]), kb([[btn(tr("💵 Saldo"), 'b'), btn(tr("🔁 Swap lagi"), 'sw')], [BACK_HOME]]));
      }

      case 'k': return this.ask(chatId, { kind: 'scout' }, tr("Kirim alamat wallet yang mau dipotret."));
      case 'w': return this.ask(chatId, { kind: 'riset' }, tr("Kirim alamat wallet yang mau diriset."));
      case 'wl': return out(...(await this.walletList()));
      case 'wr': return out(...(await this.riset(rest[0])));
      default: return out(...(await this.home()));
    }
  }

  // ---- jawaban atas pertanyaan --------------------------------------------
  async answer(chatId, p, text) {
    switch (p.kind) {
      case 'scout': return this.runScout(chatId, text);
      case 'riset': return this.runRiset(chatId, text);
      case 'label': {
        const r = await this.api('POST', '/api/targets/label', { address: p.address, label: text });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, `t:${p.address}`, tr("✅ Nama diperbarui.\n\n"));
      }
      case 'tambahTarget': {
        const [addr, ...lbl] = text.split(/\s+/);
        const r = await this.api('POST', '/api/targets', { address: addr, label: lbl.join(' ') || null });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 't', tr("✅ Target ditambahkan.\n\n"));
      }
      case 'live': {
        const r = await this.api('POST', '/api/settings/live', { live: true, confirm: text.trim() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 's', tr("🟢 <b>Mode LIVE menyala.</b>\n\n"));
      }
      case 'lepasWallet': {
        const r = await this.api('POST', '/api/settings/wallet/remove', { confirm: text.trim().toLowerCase() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'wb', tr("✅ Wallet dilepas (kunci dicadangkan).\n\n"));
      }
      case 'ntfy': {
        const r = await this.api('POST', '/api/settings/notify', { ntfy_topic: text.trim() === '-' ? '' : text.trim() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'sn', tr("✅ Tersimpan.\n\n"));
      }
      case 'rpcTambah': {
        const st = await this.api('GET', '/api/settings');
        const list = [...st.rpc.map((e) => ({ id: e.id })), { url: text.trim() }];
        const r = await this.api('POST', '/api/settings/rpc', { endpoints: list });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'sr', tr("✅ Endpoint ditambahkan.\n\n"));
      }
      case 'poolCari': return this.screen(chatId, null, `mlp:0:${encodeURIComponent(text.trim().slice(0, 24))}`);
      case 'scanToken': return this.runScanPool(chatId, text);
      case 'compoundMin':
      case 'compoundInterval': {
        const value = Number(String(text).trim().replace(',', '.'));
        if (!Number.isFinite(value)) throw new Error(tr("nominal harus angka lebih dari nol"));
        const field = p.kind === 'compoundMin' ? 'minUsd' : 'intervalMinutes';
        const r = await this.api('POST', '/api/positions/compound', { id: p.posId, [field]: value });
        if (r.error) throw new Error(note(r.error));
        return this.screen(chatId, null, `ac:${p.posId}`);
      }
      case 'lpUsd': {
        const n = Number(String(text).replace(/[$\s]/g, '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) throw new Error(tr("nominal harus angka lebih dari nol"));
        const se = this.sess(chatId);
        se.lp = { ...(se.lp || { lowerPct: 25, upperPct: 25 }), usd: n };
        return this.screen(chatId, null, se.lpAsal === 'qk' ? 'qk' : 'ml', tr("✅ Nominal ${0}\n\n", [nf(n, 2)]));
      }
      case 'lpWidth': {
        const r = parseRentang(text);
        if (r.error) throw new Error(r.error);
        const se = this.sess(chatId);
        se.lp = { ...(se.lp || {}), lowerPct: r.lowerPct, upperPct: r.upperPct, widthPct: undefined, full: false };
        return this.screen(chatId, null, se.lpAsal === 'qk' ? 'qk' : 'ml', tr("✅ Rentang {0}\n\n", [rentangTeks(se.lp)]));
      }
      case 'swAmount': {
        const se = this.sess(chatId);
        se.sw = { ...(se.sw || {}), amount: String(text).trim() };
        return this.screen(chatId, null, 'swq');
      }
      case 'rule': {
        const grp = localizeSchema(RULE_GROUPS)[p.gi], spec = grp.fields[p.fi];
        const val = parseVal(spec, text);
        await this.writeRule(chatId, grp.g, spec.k, val);
        return this.screen(chatId, null, `r:${p.gi}`, `✅ <b>${esc(spec.label)}</b> → ${esc(showVal(spec, val))}\n\n`);
      }
      case 'form': {
        const f = localizeSchema(FORMS)[p.form], spec = f.fields[p.fi];
        const val = parseVal(spec, text);
        const st = await this.api('GET', '/api/settings');
        const r = await this.api('POST', f.post, { ...f.pick(st), [spec.k]: val });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, `sf:${p.form}`, `✅ <b>${esc(spec.label)}</b> → ${esc(showVal(spec, val))}\n\n`);
      }
      default: return this.screen(chatId, null, 'h');
    }
  }

  askField(chatId, spec, retryData, backData) {
    if (spec.type === 'pilih') {
      const [gi, fi] = retryData.split(':').slice(1);
      return this.screen(chatId, null, retryData.startsWith('re') ? `rp:${gi}:${fi}` : backData);
    }
    const [kind, a, b] = retryData.split(':');
    const pending = kind === 're' ? { kind: 'rule', gi: +a, fi: +b, retry: backData } : { kind: 'form', form: a, fi: +b, retry: backData };
    return this.ask(chatId, pending, `<b>${esc(spec.label)}</b>\n${spec.help ? esc(spec.help) + '\n' : ''}\n${esc(askHint(spec))}`);
  }

  // ---- aturan: baca / tulis ------------------------------------------------
  async readRules(chatId) {
    const s = this.sess(chatId);
    if (s.scope === 'g') {
      const r = await this.api('GET', '/api/rules');
      return { scope: 'g', label: tr("semua target"), raw: r.raw || {}, resolved: r.rules };
    }
    const t = (await this.api('GET', '/api/targets')).targets.find((x) => x.address === s.scope);
    if (!t) { s.scope = 'g'; return this.readRules(chatId); }
    return { scope: t.address, label: t.label || shortA(t.address), raw: t.rulesOwn || {}, resolved: t.rulesResolved };
  }
  resolvedRule(resolved, g, k) { return resolved?.[g]?.[k]; }
  async writeRule(chatId, g, k, v) {
    const cur = await this.readRules(chatId);
    const raw = dset({ ...cur.raw }, g, k, v);
    const r = cur.scope === 'g'
      ? await this.api('POST', '/api/rules', { rules: raw })
      : await this.api('POST', '/api/targets/rules', { address: cur.scope, rules: raw });
    // Server menolak nilai di luar batas (mis. slippage > 5000 bps): tampilkan, jangan diam.
    if (r?.error) throw new Error(r.error);
  }
  async clearRule(chatId, g, k) {
    const cur = await this.readRules(chatId);
    if (cur.scope === 'g') return;                  // di tingkat global tidak ada yang bisa dilepas
    const raw = ddel(JSON.parse(JSON.stringify(cur.raw)), g, k);
    const r = await this.api('POST', '/api/targets/rules', { address: cur.scope, rules: Object.keys(raw).length ? raw : null });
    if (r?.error) throw new Error(r.error);
  }

  // ---- kabar penting (notifikasi terdorong) ----------------------------------
  // Satu kartu per kejadian yang memindahkan dana. Angkanya dibaca ulang lewat API
  // yang sama dengan dasbor supaya kartu dan layar tidak pernah berbeda pendapat.
  async kartu(msg, detail) {
    if (!detail || !detail.kind) return [`🔔 <b>${esc(msg)}</b>`, null];
    let p = null;
    if (detail.positionId != null) {
      try { p = (await this.api('GET', '/api/position', null, { id: detail.positionId })).position || null; }
      catch { p = null; }
    }
    if (detail.kind === 'entry') return this.kartuMasuk(detail, p);
    if (detail.kind === 'exit') return this.kartuKeluar(detail, p);
    if (detail.kind === 'leftover') return this.kartuSisa(detail, p);
    if (detail.kind === 'leftover_stuck') return this.kartuSisaMacet(detail, p);
    return [`🔔 <b>${esc(msg)}</b>`, null];
  }

  // Baris "cermin dari": nama target kalau ada, alamat pendek, dan NFT yang diikuti.
  targetBaris(detail, p) {
    const addr = detail.target || p?.target;
    if (!addr) return null;
    const nama = p?.targetLabel;
    const nft = detail.mirrorOf ?? p?.mirror_of;
    return `${nama ? `<b>${esc(nama)}</b> ` : ''}<code>${esc(shortA(addr))}</code>${nft ? ` · NFT #${esc(nft)}` : ''}`;
  }
  txBaris(hash) { return hash ? `🔗 <code>${esc(shortH(hash))}</code>` : null; }
  modeTag() { return this.engine.dryRun() ? tr("🧪 SIMULASI") : '🟢 LIVE'; }

  kartuMasuk(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : (d.pair || '?');
    const venue = p?.venue ? esc(p.venue) : null;
    const fee = p?.fee != null ? tr("fee {0}%", [trimZ(nf(p.fee / 10000, 2))]) : null;
    const nilai = d.valueUsd ?? p?.costUsd;
    const L = [
      `${d.adding ? tr("➕ <b>LP DITAMBAH</b>") : tr("🟢 <b>LP DISALIN</b>")} · ${this.modeTag()}`,
      `<b>${esc(pair)}</b>${[venue, fee].filter(Boolean).map((x) => ` · ${x}`).join('')}`,
      '',
      `💰 ${d.adding ? tr("Ditambah") : tr("Modal masuk")} <b>${usd(nilai)}</b>${d.adding && p?.costUsd != null ? tr(" · total modal {0}", [usd(p.costUsd)]) : ''}`,
    ];
    // Rentang: posisi baru belum tersinkron, jadi harga kini diambil dari tick pool
    // saat mint yang dibawa mesin — tanpa itu batangnya tidak bertitik.
    const r = p ? rentang({ ...p, curTick: p.curTick ?? d.curTick ?? null }) : null;
    if (r) {
      L.push('');
      L.push(`<b>${esc(r.judul)}</b>`);
      L.push(r.bar);
      L.push(r.kini ? `${esc(r.kini)}${r.ket ? ` — ${esc(r.ket)}` : ''}` : null);
    }
    const jejak = [
      ['🎯', this.targetBaris(d, p)],
      ['📝', d.reason ? esc(note(d.reason)) : null],
      ['⚙️', d.steps?.length ? esc(d.steps.map(note).join(' · ')) : null],
      [null, this.txBaris(d.txHash)],
    ].filter(([, v]) => v).map(([ic, v]) => (ic ? `${ic} ${v}` : v));
    if (jejak.length) { L.push(''); L.push(...jejak); }
    L.push(tr("<i>posisi #{0}{1}</i>", [esc(d.positionId), p?.token_id ? ` · NFT #${esc(p.token_id)}` : '']));
    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn(tr("💼 Lihat posisi"), `p:${d.positionId}`), btn(tr("🔴 Tutup"), `pc:${d.positionId}`)],
      [btn(tr("💼 Semua posisi"), 'p'), BACK_HOME],
    ])];
  }

  kartuKeluar(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : tr("posisi #{0}", [d.positionId]);
    const pnl = p?.pnlUsd;
    const judul = d.auto ? tr("🛡 <b>KELUAR MANDIRI</b>") : d.full ? tr("🔴 <b>LP DITUTUP</b>") : tr("➖ <b>LP DIKURANGI</b>");
    const lama = p?.ageHours > 0 ? tr(" · dipegang {0}", [esc(dur(p.ageHours * 3600))]) : '';
    const L = [
      `${judul} · ${this.modeTag()}`,
      `<b>${esc(pair)}</b>${p?.token_id ? ` · NFT #${esc(p.token_id)}` : ''}${lama}`,
      '',
    ];
    if (d.full && p?.empty) {
      // Hasil bersih ditaruh di luar tabel supaya bisa ditebalkan.
      L.push(`${pnl >= 0 ? tr("📈 Untung") : tr("📉 Rugi")} <b>${sgn(pnl)}</b>  ${pct(p.pnlPct)}`);
      L.push(angka([
        [tr("hasil"), usd(p.outUsd ?? p.valueUsd)],
        [tr("modal"), usd(p.costUsd)],
      ]));
    } else if (p) {
      // Tutup sebagian: nilai yang tersisa baru akurat setelah sinkron berikutnya.
      L.push(angka([[tr("modal awal"), usd(p.costUsd)]]));
    }
    const jejak = [
      ['📝', d.reason ? esc(note(d.reason)) : null],
      ['🧹', d.sold ? esc(note(d.sold)) : null],
      ['🎯', this.targetBaris(d, p)],
      [null, this.txBaris(d.txHash)],
    ].filter(([, v]) => v).map(([ic, v]) => (ic ? `${ic} ${v}` : v));
    if (jejak.length) { if (L[L.length - 1] !== '') L.push(''); L.push(...jejak); }
    L.push(tr("<i>posisi #{0}</i>", [esc(d.positionId)]));
    const rows = d.full
      ? [[btn(tr("💼 Posisi"), 'p'), btn(tr("💵 Saldo"), 'b')], [btn(tr("📜 Aktivitas"), 'a:0'), BACK_HOME]]
      : [[btn(tr("💼 Lihat posisi"), `p:${d.positionId}`), btn(tr("💵 Saldo"), 'b')], [BACK_HOME]];
    return [cut(L.filter((x) => x != null).join('\n')), kb(rows)];
  }

  kartuSisa(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : tr("posisi #{0}", [d.positionId]);
    const selisih = d.usdIn > 0 && d.usdOut != null ? ((d.usdOut - d.usdIn) / d.usdIn) * 100 : null;
    const L = [
      tr("🧹 <b>SISA TERJUAL</b> · {0}", [this.modeTag()]),
      tr("<b>{0}</b> · posisi #{1}", [esc(pair), esc(d.positionId)]),
      '',
      tr("💰 Diterima <b>{0}</b> dari {1}", [usd(d.usdOut), esc(d.label || '?')]),
      angka([
        [tr("nilai token"), usd(d.usdIn)],
        [tr("diterima"), usd(d.usdOut)],
        [tr("selisih"), selisih != null ? pct(selisih) : null],
        [tr("lewat"), d.dex || null],
        [tr("percobaan"), d.tries ? tr("ke-{0}", [d.tries + 1]) : null],
      ]),
      this.txBaris(d.txHash),
    ];
    return [cut(L.filter((x) => x != null).join('\n')), kb([[btn(tr("🧹 Sisa jual"), 'f'), btn(tr("💵 Saldo"), 'b')], [BACK_HOME]])];
  }

  // Memecoin sisa yang DITOLAK dijual: uangnya tersangkut di wallet sampai rutenya
  // membaik atau pengguna turun tangan. Sengaja mencolok — ini satu-satunya kabar
  // yang butuh keputusan orang, bukan sekadar laporan.
  kartuSisaMacet(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : tr("posisi #{0}", [d.positionId]);
    const rugi = d.lossBps != null ? `${nf(d.lossBps / 100, 1)}%` : null;
    const batas = d.maxLossBps != null ? `${nf(d.maxLossBps / 100, 1)}%` : null;
    const L = [
      tr("🚨🚨 <b>SISA BELUM TERJUAL</b> · {0}", [this.modeTag()]),
      tr("<b>{0}</b> · posisi #{1}", [esc(pair), esc(d.positionId)]),
      '',
      tr("⚠️ <b>{0}</b> masih tersangkut di wallet{1}.", [esc(d.label || '?'), d.reminder && d.since ? tr(" sejak {0}", [esc(ago(d.since))]) : '']),
      rugi ? tr("Bot menolak menjual: rutenya rugi <b>{0}</b>{1}.", [rugi, batas ? tr(" (batas {0})", [batas]) : '']) : tr("Bot belum bisa menjual: <i>{0}</i>", [esc(note(d.why || '?'))]),
      '',
      angka([
        [tr("nilai token"), usd(d.usdIn)],
        [tr("bisa ditarik"), usd(d.usdOut)],
        [tr("rugi rute"), rugi],
        [tr("batas aturan"), batas],
        [tr("sudah dicoba"), d.tries ? `${num(d.tries)}×` : null],
      ]),
      tr("🔁 Dikutip ulang <b>tiap {0} dtk</b> — begitu ruginya turun ke bawah batas, langsung dijual.", [esc(String(d.retrySec || 5))]),
      '',
      tr("<b>Pilihan:</b> tunggu likuiditas pulih, jual bertahap lewat Swap (porsi kecil = dampak harga kecil), atau naikkan batas rugi di Aturan → Keluar posisi."),
    ];
    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn(tr("🔁 Coba jual sekarang"), 'fr'), btn(tr("🔁 Swap manual"), 'sw')],
      [btn(tr("🧹 Antrean sisa"), 'f'), btn(tr("⚙️ Aturan"), 'r')],
      [BACK_HOME],
    ])];
  }

  // ---- layar ---------------------------------------------------------------
  // Kesehatan mesin dalam satu baris: yang pertama bermasalah yang disebut, supaya
  // tidak perlu membaca tabel pemantauan untuk tahu apakah bot baik-baik saja.
  kesehatan(o) {
    const macet = o.lastSync && Date.now() - o.lastSync > 3 * 60_000;
    const rpcIstirahat = (o.rpc || []).filter((r) => r.cooling).length;
    if (o.mode.paused) return tr("⏸ <b>Dijeda</b> — posisi baru target tidak disalin");
    if (o.chain.lag > 30) return tr("⚠️ <b>Tertinggal {0} blok</b> — aksi target terlambat terbaca", [num(o.chain.lag)]);
    if (macet) return tr("⚠️ <b>Sinkron posisi macet</b> — terakhir {0}", [esc(ago(o.lastSync))]);
    if (rpcIstirahat) return tr("⚠️ <b>{0} RPC istirahat</b> — memakai cadangan", [rpcIstirahat]);
    return tr("✅ Sehat · blok {0}{1}", [num(o.chain.head), o.chain.lag ? tr(" · tertinggal {0}", [num(o.chain.lag)]) : '']);
  }

  // Portofolio 24 jam: nilai sekarang dan perubahan PnL dibanding titik terakhir
  // sebelum jendela — rumus yang sama dengan grafik PnL di dasbor.
  async porto24() {
    try {
      const p = await this.api('GET', '/api/portfolio', null, { range: '24h' });
      const pts = (p.series || []).filter((e) => e.pnl != null);
      const awal = p.baseline?.pnl ?? pts[0]?.pnl;
      // Satu titik saja (cuma titik "sekarang") berarti belum ada riwayat: selisihnya
      // pasti nol dan menyesatkan, jadi tidak ditampilkan.
      const ada = p.baseline?.pnl != null ? pts.length >= 1 : pts.length >= 2;
      return { ...p, delta24: ada ? pts[pts.length - 1].pnl - awal : null };
    } catch { return null; }
  }

  async home() {
    const [o, pf] = await Promise.all([this.api('GET', '/api/overview'), this.porto24()]);
    const mode = o.mode.dry_run ? tr("🧪 SIMULASI") : '🟢 LIVE';
    const s = o.summary;
    const pnl = s.realizedUsd + s.unrealizedUsd;
    const text = [
      `<b>Quiver</b> · ${mode}`,
      `<code>${esc(shortA(o.mode.wallet))}</code>`,
      this.kesehatan(o),
      o.mode.dry_run ? tr("Mode simulasi: transaksi salin tidak dikirim ke chain.") : tr("Mode LIVE: transaksi menggunakan dana wallet."),
      '',
      pf?.now?.cash ? tr("💰 Portofolio <b>{0}</b>", [usd(pf.now.value)]) : null,
      `📈 PnL <b>${sgn(pnl)}</b>${pf?.delta24 != null ? tr(" · 24 jam {0}", [sgn(pf.delta24)]) : ''}`,
      tr("💼 {0} posisi · {1}{2}", [s.openCount, usd(s.exposureUsd), s.openCount ? ` · ${s.inRange}/${s.openCount} in-range` : '']),
      '',
      tr("Pilih <b>Target</b> untuk mengikuti wallet, atau <b>LP manual</b> untuk membuka posisi sendiri.\n<i>Anda juga bisa mengirim alamat token atau wallet lengkap.</i>"),
    ].filter((x) => x != null).join('\n');
    return [text, kb([
      [btn(tr("📊 Ringkasan"), 'o'), btn(tr("💼 Posisi"), 'p')],
      [btn('🎯 Target', 't'), btn(tr("📜 Aktivitas"), 'a:0')],
      [btn(tr("⚙️ Aturan salin"), 'r'), btn(tr("🔧 Pengaturan"), 's')],
      [btn(tr("➕ LP manual"), 'ml'), btn('🔁 Swap', 'sw')],
      [btn(tr("🔎 Riset wallet"), 'w'), btn('🔭 Scout', 'k')],
      [btn(tr("🧹 Sisa jual"), 'f'), btn(tr("💵 Saldo"), 'b')],
      [btn(tr("📝 Log"), 'l'), btn(tr("🧾 Transaksi"), 'x')],
      [btn('🌐 Language / Bahasa', 'lang')],
      [btn(o.mode.paused ? tr("▶️ Lanjutkan") : tr("⏸ Jeda"), 'sp'), btn(tr("🔄 Segarkan"), 'h')],
    ])];
  }

  async overview() {
    const [o, pf, pos] = await Promise.all([
      this.api('GET', '/api/overview'), this.porto24(),
      this.api('GET', '/api/positions').catch(() => ({ positions: [] })),
    ]);
    const s = o.summary, t = o.totals, now = pf?.now, st = pf?.stats;
    const pnl = s.realizedUsd + s.unrealizedUsd;
    // modal nyata kalau terlacak; "nilai − PnL" melingkar (PnL besar → pembagi kecil)
    const cap = now?.capitalNet ?? now?.capital;
    const pnlPct = cap > 0 ? (pnl / cap) * 100 : null;
    const L = [
      tr("📊 <b>Ringkasan</b> · {0}", [o.mode.dry_run ? tr("🧪 SIMULASI") : '🟢 LIVE']),
      tr("<code>{0}</code> · sinkron {1}", [esc(shortA(o.mode.wallet)), esc(ago(o.lastSync))]),
      this.kesehatan(o),
      '',
    ];

    // 1. Uang: angka terbesar di atas, tebal; rinciannya di tabel yang lurus.
    if (now?.cash) L.push(tr("💰 Portofolio <b>{0}</b>", [usd(now.value)]));
    L.push(`${pnl >= 0 ? '📈' : '📉'} PnL <b>${sgn(pnl)}</b>${pnlPct != null ? ` ${pct(pnlPct)}` : ''}${pf?.delta24 != null ? tr(" · 24 jam {0}", [sgn(pf.delta24)]) : ''}`);
    L.push(angka([
      [tr("kas wallet"), now?.cash ? usd(now.cash.usd) : null],
      [tr("dalam posisi"), usd(s.exposureUsd)],
      [tr("fee belum diklaim"), usd(s.feeUsd)],
      [tr("token sisa belum dijual"), s.leftoverUsd > 0.005 ? usd(s.leftoverUsd) : null],
      [tr("modal posisi"), usd(s.costUsd)],
      [tr("belum terealisasi"), sgn(s.unrealizedUsd)],
      [tr("sudah terealisasi"), sgn(s.realizedUsd)],
    ]));

    // 2. Posisi terbuka, terbesar dulu.
    const open = (pos.positions || []).filter((p) => !p.empty).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    L.push('');
    L.push(tr("<b>💼 Posisi terbuka · {0}</b>{1}", [open.length, open.length ? tr("  🟢 {0} in · 🟡 {1} luar", [s.inRange, open.length - s.inRange]) : '']));
    if (open.length) {
      L.push(kolom(open.slice(0, 6).map((p) => [
        `${p.symbol0}/${p.symbol1}`.slice(0, 14), usd(p.valueUsd), sgn(p.pnlUsd), p.inRange ? 'in' : tr("luar"),
      ]), 'lrrl'));
      if (open.length > 6) L.push(tr("<i>+{0} posisi lainnya</i>", [open.length - 6]));
    } else L.push(tr("<i>Belum ada posisi terbuka.</i>"));

    // 3. Rekam jejak posisi yang sudah ditutup.
    if (st?.closedCount) {
      L.push('');
      L.push(tr("<b>🏆 Rekam jejak · {0} ditutup</b>", [num(st.closedCount)]));
      L.push(angka([
        [tr("menang / kalah"), `${st.wins} / ${st.losses}`],
        [tr("win rate"), pct(st.winRatePct, 0).replace('+', '')],
        ['rata-rata', sgn(st.avgPnl)],
        [tr("terbaik"), sgn(st.best)],
        [tr("terburuk"), sgn(st.worst)],
        [tr("rata-rata dipegang"), st.avgHoldHours != null ? dur(st.avgHoldHours * 3600) : null],
      ]));
    }

    // 4. Per sumber: target mana yang menghasilkan.
    const src = (pf?.byTarget || []).filter((g) => g.open || g.closed).slice(0, 5);
    if (src.length) {
      L.push('');
      L.push(tr("<b>🎯 Per sumber</b>"));
      L.push(kolom(src.map((g) => [
        (g.label || (g.target ? shortA(g.target) : 'manual')).slice(0, 14),
        tr("{0} buka", [g.open]), sgn(g.realized + g.upnl),
      ]), 'lrr'));
    }

    // 5. Mesin penyalin.
    L.push('');
    L.push(tr("<b>🛰 Penyalinan</b>"));
    L.push(angka([
      [tr("aksi target terpantau"), num(t.actions)],
      [o.mode.dry_run ? tr("akan disalin (simulasi)") : tr("disalin"), num(o.mode.dry_run ? t.would : t.copied)],
      [tr("dilewat"), num(t.skipped)],
      [tr("galat"), t.errors ? num(t.errors) : null],
    ]));
    if (o.skipReasons?.length) {
      L.push(tr("<i>Alasan terbanyak dilewat:</i>"));
      L.push(kolom(o.skipReasons.slice(0, 3).map((r) => [`${r.n}×`, note(r.reason).slice(0, 38)]), 'r'));
    }
    if ((o.rpc || []).some((r) => r.errors)) {
      L.push(tr("<i>RPC bermasalah:</i>"));
      L.push(kolom(o.rpc.filter((r) => r.errors).map((r) => [hostOf(r.url), tr("{0} galat", [num(r.errors)]), r.cooling ? tr("istirahat") : '']), 'lrl'));
    }
    L.push('');
    L.push(tr("<i>ETH {0} · jalan {1}</i>", [usd(o.chain.ethUsd, 0), esc(dur(o.stats.uptimeSec))]));
    if (o.stats.lastError) L.push(tr("⛔ Galat terakhir: <code>{0}</code>", [esc(String(o.stats.lastError).slice(0, 200))]));

    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn(tr("💼 Posisi"), 'p'), btn('🎯 Target', 't')],
      [btn(tr("📜 Aktivitas"), 'a:0'), btn(tr("💵 Saldo"), 'b')],
      [btn(tr("🔄 Segarkan"), 'o'), btn(tr("📤 Bagikan total PnL"), 'os')],
      [BACK_HOME],
    ])];
  }

  async saldo() {
    const st = await this.api('GET', '/api/settings');
    const b = st.wallet.balances;
    const o = await this.api('GET', '/api/overview');
    const L = [
      tr("<b>💵 Saldo wallet bot</b>"),
      `<code>${esc(st.wallet.address || tr('(belum ada wallet)'))}</code>`,
      '',
      tr("<b>Di wallet</b>"),
      b ? angka([['ETH', tok(b.eth)], ['USDG', tok(b.usdg, 2)], ['WETH', tok(b.weth)]])
        : tr("Saldo tidak terbaca sekarang (RPC sedang sibuk)."),
      tr("<b>Di dalam posisi</b>"),
      tabel([
        [tr("nilai"), tr("{0} · {1} posisi", [usd(o.summary.exposureUsd), o.summary.openCount])],
        [tr("fee belum diklaim"), usd(o.summary.feeUsd)],
      ]),
    ];
    return [L.filter((x) => x != null).join('\n'), kb([[btn(tr("🔄 Segarkan"), 'b'), btn(tr("💼 Posisi"), 'p')], [BACK_HOME]])];
  }

  async posisi() {
    const d = await this.api('GET', '/api/positions');
    const open = (d.positions || []).filter((p) => !p.empty);
    const tot = open.reduce((a, p) => ({ v: a.v + (p.valueUsd || 0), f: a.f + (p.feeUsd || 0), p: a.p + (p.pnlUsd || 0) }), { v: 0, f: 0, p: 0 });
    const L = [tr("<b>💼 Posisi terbuka — {0}</b>", [open.length])];
    if (!open.length) L.push(tr("\nBelum ada posisi terbuka."));
    else {
      L.push(`${usd(tot.v)} · fee ${usd(tot.f)} · <b>${sgn(tot.p)}</b>`);
      // Emoji sengaja TIDAK masuk blok monospace: lebarnya tidak satu karakter dan
      // merusak kelurusan kolom. Statusnya ditulis sebagai kata.
      L.push(kolom(open.map((p) => [
        `${p.symbol0}/${p.symbol1}`, usd(p.valueUsd), sgn(p.pnlUsd), p.inRange ? 'in' : tr("luar"),
      ]), 'lrr'));
    }
    const rows = open.map((p) => [btn(`${p.inRange ? '🟢' : '🟡'} ${p.symbol0}/${p.symbol1}  ${usd(p.valueUsd)}`, `p:${p.id}`)]);
    const closed = (d.closed || []).slice(0, 6);
    if (closed.length) {
      L.push(tr("<b>Terakhir ditutup</b>"));
      L.push(kolom(closed.map((c) => {
        const pnl = (c.out_quote || 0) - (c.cost_quote || 0);
        return [`#${c.token_id}`, sgn(pnl), ago(c.closed_ts)];
      }), 'lr'));
    }
    return [L.filter((x) => x != null).join('\n'), kb([...rows, [btn(tr("🔄 Segarkan"), 'p'), BACK_HOME]])];
  }

  async posisiDetail(id) {
    const d = await this.api('GET', '/api/positions');
    const p = (d.positions || []).find((x) => String(x.id) === String(id));
    if (!p) return [tr("Posisi #{0} tidak ada di daftar terbuka.", [esc(id)]), kb([[btn(tr("↩︎ Posisi"), 'p'), BACK_HOME]])];
    const r = rentang(p);
    const L = [
      `<b>${esc(p.symbol0)}/${esc(p.symbol1)}</b>  <code>#${esc(p.token_id)}</code>`,
      `${p.inRange == null ? tr('⏳ Menunggu sinkronisasi') : p.inRange ? '🟢 in-range' : tr("🟡 di luar rentang")} · ${esc(p.venue)} · fee ${p.fee != null ? trimZ(nf(p.fee / 10000, 2)) + '%' : '—'} · ${esc(dur(p.ageHours * 3600))}`,
      '',
      // Angka yang paling dicari ditaruh di luar tabel supaya bisa ditebalkan:
      // isi blok <pre> selalu polos.
      `<b>${sgn(p.pnlUsd)}</b>  ${pct(p.pnlPct)}`,
      angka([
        [tr("nilai"), usd(p.valueUsd)],
        [tr("modal"), usd(p.costUsd)],
        [tr("fee belum diklaim"), usd(p.feeUsd)],
        [tr("Fee sudah diklaim"), usd(p.claimedUsd)],
        [tr("Fee di-compound"), usd(p.compound?.compoundedUsd)],
        ['IL vs HODL', p.ilUsd != null ? sgn(p.ilUsd) : null],
      ]),
    ];
    if (r) {
      L.push(`<b>${esc(r.judul)}</b>`);
      L.push(r.bar);
      L.push(r.kini ? `${esc(r.kini)}${r.ket ? ` — ${esc(r.ket)}` : ''}` : (r.ket ? esc(r.ket) : null));
    }
    const tokenQty = (raw, dec) => raw == null ? '—' : tok(Number(raw) / 10 ** (dec ?? 18));
    L.push('', tr('<b>🪙 Komposisi token</b>'));
    for (const side of [0, 1]) {
      L.push(`<b>${esc(p[`symbol${side}`])}</b>`);
      L.push(angka([
        [tr('Di posisi'), tokenQty(p[`amount${side}`], p[`dec${side}`])],
        [tr('Modal token'), tokenQty(p[`cost${side}`], p[`dec${side}`])],
        [tr('fee belum diklaim'), tokenQty(p[`fee${side}`], p[`dec${side}`])],
      ]));
    }
    if (p.inRange === false) L.push(tr('<i>Di luar rentang: tidak menghasilkan fee swap sampai harga kembali ke rentang.</i>'));
    if (p.compound?.enabled) L.push(tr('♻️ Minimum {0} · periksa setiap {1} menit', [usd(p.compound.minUsd), p.compound.intervalMinutes]));
    L.push(tr('<i>Sinkronisasi terakhir: {0}</i>', [esc(d.syncedAt ? ago(d.syncedAt) : '—')]));
    const jejak = tabel([
      [tr("posisi"), `#${p.id}`],
      [tr("cermin dari"), p.target ? `${shortA(p.target)} #${p.mirror_of || '—'}` : null],
      [tr("tx buka"), p.tx_open ? shortH(p.tx_open) : null],
    ]);
    if (jejak) { L.push(''); L.push(jejak); }
    return [L.filter((x) => x != null).join('\n'), kb([
      p.venue === 'v4' ? [btn(`♻️ Auto-compound · ${p.compound?.enabled ? 'ON' : 'OFF'}`, `ac:${p.id}`)] : null,
      [btn(tr("💰 Claim fee"), `pf:${p.id}`)],
      [btn(tr("🔴 Tutup posisi ini"), `pc:${p.id}`)],
      [btn(tr("🔄 Segarkan"), `p:${p.id}`), btn(tr("📤 Bagikan kartu"), `ps:${p.id}`)],
      [btn(tr("↩︎ Posisi"), 'p'), BACK_HOME],
    ])];
  }

  async compoundScreen(id) {
    const r = await this.api('GET', '/api/positions/compound', {}, { id });
    if (r.error) return [esc(note(r.error)), kb([[btn(tr("↩︎ Posisi"), `p:${id}`)]])];
    const c = r.compound;
    const L = [
      tr("♻️ <b>Auto-compound posisi #{0}</b>", [esc(id)]),
      tr("Fee ditambahkan ke posisi v4 yang sama. Hanya fee yang dipakai; gas dibayar dari wallet. Sisa token yang tidak cocok dengan rasio LP masuk ke wallet."),
      '',
      `Status: <b>${c.enabled ? 'ON' : 'OFF'}</b>`,
      tr("Minimum ditambahkan: {0}", [usd(c.minUsd)]),
      tr("Periksa setiap {0} menit", [c.intervalMinutes]),
      tr("Total ditambahkan (perkiraan): {0}", [usd(c.compoundedUsd)]),
      c.lastCheck ? tr("Pemeriksaan terakhir: {0}", [esc(ago(c.lastCheck))]) : null,
      c.lastNote ? esc(note(tr(c.lastNote))) : null,
      '',
      tr("Berjalan saat LIVE dan bot tidak dijeda. Slippage serta batas posisi mengikuti Aturan. Mengaktifkan mengizinkan transaksi otomatis."),
    ];
    return [L.filter((x) => x != null).join('\n'), kb([
      c.supported ? [btn(c.enabled ? tr("⏸ Matikan auto-compound") : tr("▶️ Aktifkan auto-compound"), `acT:${id}:${c.enabled ? 0 : 1}`)] : null,
      c.supported ? [btn(tr("✏️ Minimum fee"), `acM:${id}`), btn(tr("⏱ Interval"), `acI:${id}`)] : null,
      [btn(tr("🔄 Segarkan"), `ac:${id}`)],
      [btn(tr("↩︎ Posisi"), `p:${id}`)],
    ])];
  }

  async tutupKonfirm(id) {
    const d = await this.api('GET', '/api/positions');
    const p = (d.positions || []).find((x) => String(x.id) === String(id));
    const live = !this.engine.dryRun();
    const L = [tr("🔴 <b>Tutup posisi #{0}?</b>", [esc(id)])];
    if (p) L.push(tr("{0}/{1} · nilai {2} · {3}", [esc(p.symbol0), esc(p.symbol1), usd(p.valueUsd), sgn(p.pnlUsd)]));
    L.push('');
    L.push(live
      ? tr("Likuiditas ditarik penuh dan transaksi dikirim sungguhan. Memecoin sisa akan dijual otomatis kalau aturan itu menyala.")
      : tr("⚠️ Bot sedang di mode <b>simulasi</b> — perintah ini akan ditolak."));
    return [L.join('\n'), kb([[btn(tr("✅ Ya, tutup sekarang"), `pC:${id}`)], [btn(tr("↩︎ Batal"), `p:${id}`)]])];
  }

  async targets() {
    const d = await this.api('GET', '/api/targets');
    const L = [tr("<b>🎯 Target ({0})</b>", [d.targets.length])];
    for (const t of d.targets) {
      L.push('');
      L.push(`${t.enabled ? '🟢' : '⚪️'} <b>${esc(t.label || shortA(t.address))}</b>`);
      L.push(tr("  <code>{0}</code> · {1} aksi · {2} disalin", [esc(shortA(t.address)), num(t.actions), num(t.copied)]));
      L.push(tr("  posisi kita: {0} ({1}){2}", [t.openPositions, usd(t.openCostQuote), t.lastActionTs ? tr(" · aksi terakhir {0}", [ago(t.lastActionTs)]) : '']));
    }
    if (!d.targets.length) L.push(tr("\nBelum ada target. Tambahkan satu wallet untuk mulai mengikuti."));
    const rows = d.targets.map((t) => [
      btn(`${t.enabled ? '🟢' : '⚪️'} ${(t.label || shortA(t.address)).slice(0, 24)}`, `t:${t.address}`),
    ]);
    return [L.join('\n'), kb([...rows, [btn(tr("➕ Tambah target"), 'ta')], [btn(tr("🔄 Segarkan"), 't'), BACK_HOME]])];
  }

  async targetDetail(addr) {
    const d = await this.api('GET', '/api/targets');
    const t = d.targets.find((x) => x.address === addr);
    if (!t) return [tr("Target <code>{0}</code> tidak ditemukan.", [esc(addr)]), kb([[btn(tr("↩︎ Target"), 't'), BACK_HOME]])];
    const r = t.rulesResolved;
    const L = [
      `${t.enabled ? '🟢' : '⚪️'} <b>${esc(t.label || tr('tanpa nama'))}</b>${t.enabled ? '' : tr(" — nonaktif")}`,
      `<code>${esc(t.address)}</code>`,
      '',
      tabel([
        [tr("aksi terpantau"), `${num(t.actions)}${t.lastActionTs ? tr(" · terakhir {0}", [ago(t.lastActionTs)]) : ''}`],
        [tr("disalin"), num(t.copied)],
        [tr("posisi kita"), tr("{0} · modal {1}", [t.openPositions, usd(t.openCostQuote)])],
      ]),
      tr("<b>Aturan yang berlaku</b> <i>{0}</i>", [t.rulesOwn ? tr("(ada penyesuaian khusus)") : tr("(ikut aturan umum)")]),
      tabel([
        [tr("cara ukuran"), showVal(localizeSchema(RULE_GROUPS)[0].fields[0], r.sizing.mode)],
        [tr("batas per posisi"), usd(r.sizing.max_quote_per_position_usd, 0)],
        [tr("batas total"), usd(r.sizing.max_total_exposure_usd, 0)],
        [tr("anggaran harian"), usd(r.sizing.daily_budget_usd, 0)],
        [tr("abaikan aksi di bawah"), usd(r.filters.min_target_quote_usd, 0)],
        [tr("maks posisi terbuka"), r.filters.max_open_positions],
      ]),
    ];
    if (t.research) {
      const s = t.research;
      L.push(tr("<b>Riset wallet</b> <i>({0})</i>", [esc(ago(s.lastScanTs))]));
      L.push(angka([
        [tr("posisi terbaca"), s.positionsN != null ? num(s.positionsN) : null],
        [tr("menang"), s.winRatePct != null ? `${nf(s.winRatePct, 0)}%` : null],
        ['PnL', s.pnlUsd != null ? sgn(s.pnlUsd) : null],
      ]));
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(t.enabled ? tr("⚪️ Matikan") : tr("🟢 Nyalakan"), `tt:${t.address}`)],
      [btn(tr("⚙️ Aturan khusus"), `ts:${t.address}`), btn(tr("✏️ Ganti nama"), `tn:${t.address}`)],
      [btn(tr("🔎 Riset wallet"), `tw:${t.address}`), btn(tr("🔄 Perbarui riset"), `tr:${t.address}`)],
      [btn(tr("🔄 Segarkan"), `t:${t.address}`)],
      [btn(tr("🗑 Hapus target"), `td:${t.address}`)],
      [btn(tr("↩︎ Target"), 't'), BACK_HOME],
    ])];
  }

  async aktivitas(off = 0) {
    const d = await this.api('GET', '/api/activity', {}, { limit: 60 });
    const rows = d.activity.slice(off, off + 10);
    const icon = { copy: '✅', dry: '🧪', skip: '⏭', error: '⛔' };
    const L = [tr("<b>📜 Aktivitas target</b> <i>({0}–{1} dari {2})</i>", [off + 1, off + rows.length, d.activity.length])];
    for (const a of rows) {
      const pair = a.symbol0 && a.symbol1 ? `${a.symbol0}/${a.symbol1}` : (a.pool_ref ? shortA(a.pool_ref) : '—');
      L.push('');
      L.push(`${icon[a.verdict] || '•'} <b>${esc(a.kind)}</b> ${esc(pair)} · ${esc(a.targetLabel || shortA(a.target))}`);
      L.push(`  ${a.value_quote ? `${nf(a.value_quote, 2)} ${esc(a.quote_symbol || '')} · ` : ''}${ago(a.ts)}`);
      if (a.reason) L.push(`  <i>${esc(note(a.reason))}</i>`);
      if (a.decision_tx) L.push(tr("  tx <code>{0}</code>", [esc(shortH(a.decision_tx))]));
    }
    if (!rows.length) L.push(tr("\nBelum ada aksi terpantau."));
    const nav = [];
    if (off > 0) nav.push(btn(tr("⬅️ Baru"), `a:${Math.max(0, off - 10)}`));
    if (off + 10 < d.activity.length) nav.push(btn(tr("Lama ➡️"), `a:${off + 10}`));
    return [L.join('\n'), kb([nav.length ? nav : null, [btn(tr("🔄 Segarkan"), `a:${off}`), BACK_HOME]])];
  }

  async logs() {
    const d = await this.api('GET', '/api/logs');
    const icon = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
    const L = [tr("<b>📝 Catatan terakhir</b>"), ''];
    for (const r of d.logs.slice(0, 25)) L.push(`${icon[r.level] || '•'} <i>${esc(ago(r.ts))}</i> ${esc(note(r.msg))}`);
    if (!d.logs.length) L.push(tr("(kosong)"));
    return [L.join('\n'), kb([[btn(tr("🔄 Segarkan"), 'l'), BACK_HOME]])];
  }

  async txs() {
    const d = await this.api('GET', '/api/txs');
    const L = [tr("<b>🧾 Transaksi terakhir</b>"), ''];
    for (const t of d.txs.slice(0, 20)) {
      L.push(`${t.status === 'ok' ? '✅' : t.status === 'error' ? '⛔' : '⏳'} <b>${esc(t.kind)}</b> · ${esc(ago(t.ts))}`);
      L.push(`  <code>${esc(shortH(t.hash))}</code>${t.gas_quote ? ` · gas ${usd(t.gas_quote, 4)}` : ''}`);
      if (t.error) L.push(`  <i>${esc(String(t.error).slice(0, 120))}</i>`);
    }
    if (!d.txs.length) L.push(tr("(belum ada)"));
    return [L.join('\n'), kb([[btn(tr("🔄 Segarkan"), 'x'), BACK_HOME]])];
  }

  // ---- aturan --------------------------------------------------------------
  async rulesMenu(chatId) {
    const cur = await this.readRules(chatId);
    const L = [
      tr("<b>⚙️ Aturan salin</b>"),
      tr("Berlaku untuk: <b>{0}</b>", [esc(cur.scope === 'g' ? tr("semua target") : cur.label)]),
      '',
      cur.scope === 'g'
        ? tr("Ini aturan umum. Tiap target bisa punya penyesuaian sendiri lewat halaman targetnya.")
        : tr("Kolom bertanda • disesuaikan khusus untuk target ini; sisanya ikut aturan umum."),
      '',
      tr("Pilih kelompok:"),
    ];
    const rows = localizeSchema(RULE_GROUPS).map((g, i) => {
      const n = Object.keys(cur.raw[g.g] || {}).length;
      return [btn(`${g.title}${cur.scope !== 'g' && n ? ` (${n}•)` : ''}`, `r:${i}`)];
    });
    if (cur.scope !== 'g') rows.push([btn(tr("🌐 Ke aturan umum"), 'rg')]);
    return [L.join('\n'), kb([...rows, [BACK_HOME]])];
  }

  async rulesGroup(chatId, gi) {
    const grp = localizeSchema(RULE_GROUPS)[gi];
    const cur = await this.readRules(chatId);
    const L = [`<b>${esc(grp.title)}</b> — ${esc(cur.scope === 'g' ? tr("semua target") : cur.label)}`, ''];
    const rows = [];
    grp.fields.forEach((spec, fi) => {
      const v = this.resolvedRule(cur.resolved, grp.g, spec.k);
      const own = dget(cur.raw, grp.g, spec.k) !== undefined;
      // Sebagian aturan cuma berlaku pada mode tertentu (mis. "Persen dari target"
      // hanya dipakai kalau caranya memang persen). Kolomnya tetap ditampilkan dan
      // tetap bisa diubah — cuma diberi tanda, karena tombol yang hilang-muncul
      // sendiri lebih membingungkan daripada satu baris keterangan.
      const inert = spec.when && !spec.when(cur.resolved);
      L.push(`${own && cur.scope !== 'g' ? '• ' : ''}<b>${esc(spec.label)}</b>: ${esc(showVal(spec, v))}${inert ? tr(" <i>· tidak dipakai di mode ini</i>") : ''}`);
      if (spec.type === 'bool') rows.push([btn(`${v ? '✅' : '❌'} ${spec.label}`.slice(0, 40), `rb:${gi}:${fi}`)]);
      else if (spec.type === 'pilih') rows.push([btn(`✏️ ${spec.label}`.slice(0, 40), `rp:${gi}:${fi}`)]);
      else rows.push([btn(`✏️ ${spec.label}`.slice(0, 40), `re:${gi}:${fi}`)]);
      if (own && cur.scope !== 'g') rows[rows.length - 1].push(btn('↺', `rx:${gi}:${fi}`));
    });
    return [L.join('\n'), kb([...rows, [btn(tr("↩︎ Aturan"), 'r'), BACK_HOME]])];
  }

  // ---- pengaturan ----------------------------------------------------------
  async settings() {
    const st = await this.api('GET', '/api/settings');
    const L = [
      tr("<b>🔧 Pengaturan</b>"),
      '',
      `Mode: <b>${st.mode.dry_run ? tr("🧪 SIMULASI") : '🟢 LIVE'}</b>${st.mode.paused ? tr(" · ⏸ dijeda") : ''}`,
      `Wallet: <code>${esc(st.wallet.address || tr('(belum ada)'))}</code>`,
      `RPC: ${st.rpc.length} endpoint`,
      tr("Gas: pengali {0} · cadangan {1} ETH", [nf(st.gas.price_multiplier, 2), nf(st.gas.reserve_eth, 4)]),
      tr("Mesin: pindai tiap {0} ms · sinkron {1} dtk", [num(st.loop.poll_ms), num(st.loop.sync_seconds)]),
      tr("Notifikasi: ntfy {0} · Telegram {1} chat", [st.notify.ntfy_topic ? `<code>${esc(st.notify.ntfy_topic)}</code>` : tr("mati"), this.chats().length]),
    ];
    return [L.join('\n'), kb([
      [btn(st.mode.dry_run ? tr("🟢 Nyalakan LIVE") : tr("🧪 Kembali ke simulasi"), 'sl')],
      [btn(st.mode.paused ? tr("▶️ Lanjutkan") : tr("⏸ Jeda penyalinan"), 'sp')],
      [btn(tr("🔑 Wallet bot"), 'wb'), btn('🌐 RPC', 'sr')],
      [btn('⛽ Gas', 'sf:gas'), btn(tr("🔧 Mesin"), 'sf:mesin')],
      [btn(tr("🔔 Notifikasi"), 'sn'), btn(tr("💬 Chat Telegram"), 'sc')],
      [btn(tr("🔐 Ganti token dasbor"), 'sk')],
      [btn('🌐 Language / Bahasa', 'lang')],
      [btn(tr("🔄 Segarkan"), 's'), BACK_HOME],
    ])];
  }

  async setPause(chatId, msgId, paused, ack = null) {
    await this.api('POST', '/api/mode', { paused });
    if (ack) await ack(paused ? tr("Penyalinan dijeda") : tr("Penyalinan dilanjutkan"));
    const note = paused
      ? tr("⏸ <b>Penyalinan dijeda.</b> Posisi baru dari target tidak disalin. Posisi yang sudah terbuka tetap dilindungi: sinyal keluar target dan aturan keluar tetap dijalankan.\n\n")
      : tr("▶️ <b>Penyalinan dilanjutkan.</b>\n\n");
    return this.screen(chatId, msgId, msgId ? 's' : 'h', note);
  }

  async walletScreen() {
    const st = await this.api('GET', '/api/settings');
    const w = st.wallet, b = w.balances;
    const L = [
      tr("<b>🔑 Wallet bot</b>"),
      `<code>${esc(w.address || tr('(belum ada wallet)'))}</code>`,
      '',
      tabel([
        [tr("berkas kunci"), w.keyFile],
        [tr("izin berkas"), w.hasKey ? `${w.perms || '?'}${w.perms === '600' ? tr(" · aman") : tr(" · terlalu longgar")}` : tr("belum ada")],
        [tr("cadangan kunci"), tr("{0} berkas", [w.backups])],
        ['ETH', b ? tok(b.eth) : null],
        ['USDG', b ? tok(b.usdg, 2) : null],
        ['WETH', b ? tok(b.weth) : null],
      ]),
      tr("<i>Impor kunci privat lewat Telegram sengaja tidak disediakan — riwayat chat tersimpan di server Telegram. Pakai dasbor untuk itu.</i>"),
    ];
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(tr("🆕 Buat wallet baru"), 'wbg')],
      [btn(tr("🗑 Lepas wallet"), 'wbr')],
      [btn(tr("↩︎ Pengaturan"), 's'), BACK_HOME],
    ])];
  }

  async rpcScreen() {
    const st = await this.api('GET', '/api/settings');
    const L = [tr("<b>🌐 Endpoint RPC</b>"), ''];
    st.rpc.forEach((e) => {
      L.push(`<b>${e.id + 1}. ${esc(e.host || hostOf(e.url))}</b>${e.secret ? ' 🔐' : ''}${e.cooling ? tr(" ❄️ istirahat") : ''}`);
      const tag = [e.no_logs ? tr("tanpa getLogs") : null, e.max_log_blocks ? tr("getLogs ≤ {0} blok", [num(e.max_log_blocks)]) : null, e.archive ? tr("arsip") : null].filter(Boolean);
      L.push(tr("   {0} panggilan · {1} galat · {2} ms{3}", [num(e.calls), num(e.errors), num(e.lastMs), tag.length ? ` · ${esc(tag.join(', '))}` : '']));
    });
    const rows = st.rpc.map((e) => [btn(tr("🔬 Uji {0}", [e.host]).slice(0, 30), `sr:${e.id}`), btn('🗑', `srd:${e.id}`)]);
    return [L.join('\n'), kb([...rows, [btn(tr("➕ Tambah endpoint"), 'sra')], [btn(tr("↩︎ Pengaturan"), 's'), BACK_HOME]])];
  }

  async rpcTest(id) {
    const r = await this.api('POST', '/api/settings/rpc/test', { id });
    if (r.error) return [`❌ ${esc(note(r.error))}`, kb([[btn('↩︎ RPC', 'sr')]])];
    const L = [
      `<b>🔬 ${esc(r.url)}</b>`, '',
      `${r.usable ? '✅' : '⛔'} ${esc(note(r.summary))}`,
    ];
    if (r.suggest) {
      L.push('');
      L.push(tr("<b>Bendera yang cocok</b>"));
      L.push(tr("• tanpa getLogs: {0}", [r.suggest.no_logs ? tr("ya") : tr("tidak")]));
      L.push(tr("• batas blok getLogs: {0}", [r.suggest.max_log_blocks || tr("tanpa batas")]));
      L.push(tr("• node arsip: {0}", [r.suggest.archive ? tr("ya") : tr("tidak")]));
      L.push('');
      L.push(tr("<i>Bendera diatur dari dasbor; di sini hanya pengujiannya.</i>"));
    }
    return [L.join('\n'), kb([[btn('↩︎ RPC', 'sr'), BACK_HOME]])];
  }

  async form(name) {
    const f = localizeSchema(FORMS)[name];
    const st = await this.api('GET', '/api/settings');
    const cur = f.pick(st);
    const L = [`<b>${esc(f.title)}</b>`, ''];
    const rows = [];
    f.fields.forEach((spec, i) => {
      L.push(`<b>${esc(spec.label)}</b>: ${esc(showVal(spec, cur[spec.k]))}`);
      rows.push([btn(spec.type === 'bool' ? `${cur[spec.k] ? '✅' : '❌'} ${spec.label}`.slice(0, 40) : `✏️ ${spec.label}`.slice(0, 40),
        spec.type === 'bool' ? `sfb:${name}:${i}` : `sfe:${name}:${i}`)]);
    });
    if (f.note) { L.push(''); L.push(`<i>${esc(f.note)}</i>`); }
    return [L.join('\n'), kb([...rows, [btn(tr("↩︎ Pengaturan"), 's'), BACK_HOME]])];
  }

  async notifyScreen() {
    const st = await this.api('GET', '/api/settings');
    const n = this.notifCfg();
    const L = [
      tr("<b>🔔 Notifikasi</b>"), '',
      `ntfy: ${st.notify.ntfy_topic ? `<code>${esc(st.notify.ntfy_topic)}</code>` : tr("(mati)")}`,
      '',
      tr("<b>Kirim ke Telegram</b>"),
      ...localizeSchema(NOTIF).map(([k, lbl]) => `${n[k] ? '✅' : '❌'} ${esc(lbl)}`),
    ];
    return [L.join('\n'), kb([
      ...localizeSchema(NOTIF).map(([k, lbl]) => [btn(`${n[k] ? '✅' : '❌'} ${lbl}`.slice(0, 40), `snb:${k}`)]),
      [btn(tr("✏️ Topik ntfy"), 'snp'), btn(tr("📨 Uji ntfy"), 'snt')],
      [btn(tr("↩︎ Pengaturan"), 's'), BACK_HOME],
    ])];
  }

  async chatsScreen() {
    const ids = this.chats();
    const L = [tr("<b>💬 Chat Telegram yang berwenang</b>"), ''];
    for (const c of ids) L.push(`• <code>${esc(c)}</code>`);
    if (!ids.length) L.push(tr("(kosong)"));
    L.push('');
    L.push(tr("Chat di daftar ini bisa melakukan <b>semua</b> yang dasbor bisa, termasuk menyalakan LIVE dan menutup posisi. Lepaskan chat yang tidak kamu kenali."));
    if (this.pairCode && Date.now() < this.pairCode.exp) {
      L.push('');
      L.push(tr("Kode sambung aktif: <code>/start {0}</code>", [esc(this.pairCode.code)]));
    }
    return [L.join('\n'), kb([
      ...ids.map((c) => [btn(tr("🗑 Lepas {0}", [c]), `scd:${c}`)]),
      [btn(tr("↩︎ Pengaturan"), 's'), BACK_HOME],
    ])];
  }

  // ---- sisa jual -----------------------------------------------------------
  async leftovers(err = null) {
    const d = await this.api('GET', '/api/leftovers');
    const L = [tr("<b>🧹 Antrean jual memecoin sisa</b>"), ''];
    if (err) L.push(`⚠️ ${esc(err)}\n`);
    if (!d.leftovers.length) L.push(tr("Kosong — tidak ada sisa yang menunggu dijual."));
    for (const it of d.leftovers) {
      L.push(tr("• posisi #{0} · <code>{1}</code>", [it.posId, esc(it.symbol || shortA(it.token))]));
      L.push(tr("  dicoba {0}×{1}{2}", [num(it.tries || 0), it.since ? tr(" sejak {0}", [esc(ago(it.since))]) : '', it.lastLossBps != null ? tr(" · rugi kini {0}%", [nf(it.lastLossBps / 100, 1)]) : '']));
      if (it.why) L.push(`  <i>${esc(note(it.why))}</i>`);
    }
    L.push('');
    L.push(tr("<i>Sisa muncul kalau memecoin hasil menutup posisi belum bisa dijual (rute rugi terlalu besar). Bot mengutip ulang tiap beberapa detik dan menjual begitu lolos batas.</i>"));
    return [L.join('\n'), kb([
      d.leftovers.length ? [btn(tr("🔁 Coba jual sekarang"), 'fr')] : null,
      ...d.leftovers.map((it) => [btn(tr("🗑 Keluarkan #{0} {1}", [it.posId, it.symbol || '']).slice(0, 38), `fd:${it.posId}:${it.token}`)]),
      [btn(tr("🔄 Segarkan"), 'f'), BACK_HOME],
    ])];
  }

  // ---- LP manual -----------------------------------------------------------
  async lpMenu(chatId) {
    const d = this.sess(chatId).lp || {};
    const siap = d.poolRef && d.usd > 0;
    const L = [
      tr("<b>➕ LP manual</b>"),
      tr("Membuka posisi sendiri, di luar penyalinan target. Jalur eksekusinya sama: kas dijembatani, token ditukar seperlunya, lalu mint."),
      tr("💡 <i>Paling cepat: tempel alamat token di chat ini kapan saja.</i>"),
      '',
      tabel([
        ['pool', d.pair || tr('— belum dipilih')],
        [tr("nominal"), d.usd ? usd(d.usd) : tr("— belum diisi")],
        [tr("rentang"), d.full ? tr("seluruh rentang harga") : tr("{0} dari harga kini", [rentangTeks(d)])],
      ]),
    ];
    if (this.engine.dryRun()) L.push(tr("⚠️ Bot sedang di mode <b>simulasi</b> — pratinjau tetap jalan, tapi transaksi tidak akan dikirim."));
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(`🏊 ${d.pair ? tr("Ganti pool") : tr("Pilih pool")}`, 'mlp:0')],
      [btn(tr("💵 Nominal"), 'mln'), btn(tr("📐 Rentang"), 'mlr')],
      siap ? [btn(tr("👁 Pratinjau & buka"), 'mlv')] : null,
      [btn('↩︎ Menu', 'h')],
    ])];
  }

  async lpPools(chatId, off = 0, cari = '') {
    const q = decodeURIComponent(cari || '');
    const d = await this.api('GET', '/api/manual/pools', {}, { q, limit: 60 });
    const s = this.sess(chatId);
    s.poolList = d.pools;                       // indeks tombol menunjuk ke daftar ini
    const hal = d.pools.slice(off, off + 8);
    const L = [tr("<b>🏊 Pilih pool</b>{0}", [q ? tr(" — cari \"{0}\"", [esc(q)]) : ''])];
    if (!d.pools.length) L.push(tr("\nBelum ada pool yang dikenal. Pool muncul di sini setelah bot melihat target beraksi di dalamnya."));
    else {
      L.push(tr("{0} pool dikenal, diurutkan dari yang paling baru beraksi.", [d.pools.length]));
      L.push(kolom(hal.map((p) => [
        p.pair, p.dynamicFee ? tr("dinamis") : `${trimZ(nf(p.feePct ?? 0, 2))}%`, p.hasHooks ? 'hook' : '', p.lastTs ? ago(p.lastTs) : '',
      ]), 'lr'));
    }
    const rows = hal.map((p, i) => [btn(`${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? tr("dinamis") : trimZ(nf(p.feePct ?? 0, 2)) + '%'}`.slice(0, 40), `mlP:${off + i}`)]);
    const nav = [];
    if (off > 0) nav.push(btn('⬅️', `mlp:${Math.max(0, off - 8)}:${cari}`));
    if (off + 8 < d.pools.length) nav.push(btn('➡️', `mlp:${off + 8}:${cari}`));
    return [L.filter((x) => x != null).join('\n'), kb([
      ...rows, nav.length ? nav : null,
      [btn(tr("🔎 Cari pasangan"), 'mlc')],
      [btn(tr("➕ Dari alamat token"), 'mla')],
      [btn(tr("↩︎ LP manual"), 'ml')],
    ])];
  }

  // ---- alamat ditempel ------------------------------------------------------
  async tempel(chatId, a) {
    const m = await this.send(chatId, tr("🔎 Memeriksa <code>{0}</code>…", [esc(shortA(a))]));
    const info = await this.api('GET', '/api/address', {}, { a });
    if (info.error) return this.edit(chatId, m.message_id, `❌ ${esc(note(info.error))}`, kb([[BACK_HOME]]));
    if (info.kind === 'token') return this.pasangLp(chatId, m.message_id, a, info);

    const s = this.sess(chatId);
    s.alamat = a;
    const L = [
      `<b>👛 ${info.kind === 'contract' ? tr("Kontrak") : 'Wallet'}</b> <code>${esc(a)}</code>`,
      info.kind === 'contract' ? tr("Bukan token — kemungkinan smart wallet. Mau diapakan?") : tr("Ini alamat wallet, bukan token. Mau diapakan?"),
      info.isTarget ? tr("\n🎯 Sudah diikuti{0}.", [info.targetLabel ? tr(" sebagai <b>{0}</b>", [esc(info.targetLabel)]) : '']) : null,
    ];
    return this.edit(chatId, m.message_id, L.filter((x) => x != null).join('\n'), kb([
      [btn(tr("🔎 Riset PnL"), `wr:${a}`), info.isTarget ? btn(tr("🎯 Daftar target"), 't') : btn(tr("➕ Jadikan target"), 'adT')],
      [BACK_HOME],
    ]));
  }

  // Menunggu pemindaian pool selesai sambil menyunting pesan progres.
  async tungguPindai(chatId, msgId, token, judul) {
    const [awal, jeda] = this.jedaPindai || [800, 2000];
    for (let i = 0; i < 120; i++) {
      await sleep(i === 0 ? awal : jeda);
      const j = await this.api('GET', '/api/manual/pools/scan', {}, { token });
      if (j.status !== 'jalan') return j;
      if (i % 3 === 1) await this.edit(chatId, msgId, `${judul}… ${j.progress || 0}%`).catch(() => {});
    }
    return { status: 'lama' };
  }

  async pasangLp(chatId, msgId, token, info) {
    const sym = info.symbol || '?';
    const judul = tr("🔎 Mencari pool <b>{0}</b>", [esc(sym)]);
    await this.edit(chatId, msgId, `${judul}…`);
    const r0 = await this.api('POST', '/api/manual/pools/scan', { token });
    if (r0.error) return this.edit(chatId, msgId, `❌ ${esc(note(r0.error))}`, kb([[BACK_HOME]]));
    const j = await this.tungguPindai(chatId, msgId, token, judul);
    if (j.status === 'gagal') return this.edit(chatId, msgId, tr("❌ Pemindaian gagal: <code>{0}</code>", [esc(note(j.error))]), kb([[BACK_HOME]]));
    if (j.status === 'lama') return this.edit(chatId, msgId, tr("⏳ Pemindaian masih berjalan — tempel lagi alamatnya sebentar lagi."), kb([[BACK_HOME]]));
    const list = j.pools || [];
    if (!list.length) {
      return this.edit(chatId, msgId, [
        `<b>${esc(sym)}</b> <code>${esc(shortA(token))}</code>`,
        '',
        tr("Belum ada pool Uniswap v3/v4 yang bisa dimasuki untuk token ini."),
        j.total ? tr("<i>{0} pool ditemukan, tapi semuanya kosong, berfee dinamis, atau tidak dipasangkan USDG/ETH.</i>", [j.total]) : null,
        ...pasarLainTeks(j.lainnya),
      ].filter((x) => x != null).join('\n'), kb([[BACK_HOME]]));
    }
    const s = this.sess(chatId);
    const prev = s.lp || {};
    s.qkPools = list;
    s.lpToken = { address: token, symbol: sym, name: info.name || '' };
    s.lpAsal = 'qk';
    // Nominal & rentang terakhir dibawa: menempel beberapa token berturut-turut tidak
    // perlu mengisi ulang semuanya.
    s.lp = {
      poolRef: list[0].poolRef, pair: list[0].pair, usd: prev.usd ?? null,
      lowerPct: prev.lowerPct ?? 25, upperPct: prev.upperPct ?? 25, full: !!prev.full,
    };
    const [text, keyboard] = await this.lpKartu(chatId);
    return this.edit(chatId, msgId, text, keyboard);
  }

  // Satu layar berisi semuanya: pool, nominal, rentang, pratinjau, dan tombol buka.
  // Setiap tombol menyunting layar ini di tempat.
  async lpKartu(chatId) {
    const s = this.sess(chatId);
    const d = s.lp || {};
    const list = s.qkPools || [];
    if (!d.poolRef) return [tr("Sesinya sudah habis (bot baru dimulai ulang). Tempel lagi alamat tokennya."), kb([[BACK_HOME]])];
    const pool = list.find((p) => p.poolRef === d.poolRef);
    const tk = s.lpToken || {};
    const L = [tr("<b>➕ Pasang LP — {0}</b>", [esc(d.pair || '?')])];
    if (tk.address) L.push(`<code>${esc(tk.address)}</code>`);
    if (pool) {
      L.push([pool.venue, pool.dynamicFee ? tr("fee dinamis") : tr("fee {0}%", [trimZ(nf(pool.feePct ?? 0, 2))]), pool.hasHooks ? tr("🪝 hook") : null,
        list.length > 1 ? tr("{0} pool lain", [list.length - 1]) : null].filter(Boolean).join(' · '));
    }
    L.push('');
    L.push(tabel([
      [tr("nominal"), d.usd > 0 ? usd(d.usd) : tr("— pilih di bawah")],
      [tr("rentang"), d.full ? tr("seluruh rentang") : tr("{0} dari harga kini", [rentangTeks(d)])],
    ]));

    let nilai = null;
    if (d.usd > 0) {
      const r = await this.api('POST', '/api/manual/lp/plan', d);
      if (r.error) L.push(`⛔ ${esc(note(r.error))}`);
      else {
        const p = r.preview;
        nilai = p.valueUsd;
        L.push(angka([
          [p.symbol0, tok(Number(p.amount0) / 10 ** p.dec0, 6)],
          [p.symbol1, tok(Number(p.amount1) / 10 ** p.dec1, 6)],
          [tr("kas tersedia"), usd(p.kasUsd)],
        ]));
        const rg = rentang(p);
        if (rg) {
          L.push(`<b>${esc(rg.judul)}</b>`);
          L.push(rg.bar);
          if (rg.kini) L.push(`${esc(rg.kini)}${rg.ket ? ` — ${esc(rg.ket)}` : ''}`);
        }
        for (const w of r.warnings || []) L.push(`⚠️ ${esc(w)}`);
      }
    } else {
      L.push(tr("<i>Pilih nominal — pratinjau muncul di sini.</i>"));
    }
    const live = !this.engine.dryRun();
    if (!live) L.push(tr("\n⚠️ Mode <b>simulasi</b> — pratinjau jalan, tapi posisi tidak bisa dibuka dari sini."));

    const pilih = (on, label) => (on ? `✓ ${label}` : label);
    const RG = [[10, 10, '±10%'], [25, 25, '±25%'], [50, 50, '±50%'], [50, 100, '½×–2×']];
    return [L.filter((x) => x != null).join('\n'), kb([
      [...[25, 50, 100].map((v) => btn(pilih(d.usd === v, `$${v}`), `qkn:${v}`)), btn('✏️ $', 'qkN')],
      RG.map(([a, b, l]) => btn(pilih(!d.full && d.lowerPct === a && d.upperPct === b, l), `qkw:${a}:${b}`)),
      [btn(tr("1 sisi · bawah −25%"), 'qkw:25:0'), btn(tr("1 sisi · atas +25%"), 'qkw:0:25')],
      [btn(pilih(!!d.full, tr("seluruh rentang")), 'qkF'), btn(tr("✏️ bawah & atas"), 'qkC')],
      list.length > 1 ? [btn(tr("🏊 Ganti pool ({0})", [list.length]), 'qkp')] : null,
      nilai != null && live ? [btn(tr("✅ Buka posisi {0}", [usd(nilai)]), 'qkY')] : null,
      [btn(tr("🔄 Segarkan"), 'qk'), BACK_HOME],
    ])];
  }

  lpKartuPool(chatId) {
    const s = this.sess(chatId);
    const list = (s.qkPools || []).slice(0, 12);
    const cur = s.lp?.poolRef;
    return [tr("<b>🏊 Pilih pool</b> untuk <b>{0}</b>", [esc(s.lpToken?.symbol || '?')]), kb([
      ...list.map((p, i) => [btn(`${p.poolRef === cur ? '✓ ' : ''}${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? tr("dinamis") : trimZ(nf(p.feePct ?? 0, 2)) + '%'}${p.kosong ? tr(" · kosong") : ''}`.slice(0, 44), `qkP:${i}`)]),
      [btn(tr("↩︎ Kembali"), 'qk')],
    ])];
  }

  lpKartuYakin(chatId) {
    const d = this.sess(chatId).lp || {};
    if (!d.poolRef || !(d.usd > 0)) return [tr("Nominal atau pool belum dipilih."), kb([[btn(tr("↩︎ Kembali"), 'qk')]])];
    return [[
      tr("<b>Kirim transaksi sungguhan?</b>"),
      '',
      tabel([['pool', d.pair], [tr("nominal"), usd(d.usd)], [tr("rentang"), d.full ? tr("seluruh rentang") : rentangTeks(d)]]),
      tr("Kas dijembatani, token ditukar seperlunya, lalu mint — bisa sampai satu menit. Posisi ini tidak ikut ditutup saat target mana pun keluar."),
    ].join('\n'), kb([[btn(tr("✅ Ya, buka sekarang"), 'mlX')], [btn(tr("↩︎ Batal"), 'qk')]])];
  }

  // Mencari pool sebuah token langsung dari chain. Pesannya disunting selama
  // pemindaian berjalan supaya terlihat masih hidup — bisa belasan detik.
  async runScanPool(chatId, tokenRaw) {
    const token = String(tokenRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) {
      return this.send(chatId, tr("❌ Alamat token harus 0x diikuti 40 karakter hex."), kb([[btn(tr("↩︎ Coba lagi"), 'mla'), BACK_HOME]]));
    }
    const r0 = await this.api('POST', '/api/manual/pools/scan', { token });
    if (r0.error) return this.send(chatId, `❌ ${esc(note(r0.error))}`, kb([[BACK_HOME]]));
    const m = await this.send(chatId, tr("🔎 Mencari pool untuk <code>{0}</code>…", [esc(shortA(token))]));
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      const j = await this.api('GET', '/api/manual/pools/scan', {}, { token });
      if (j.status === 'jalan') {
        if (i % 3 === 0) await this.edit(chatId, m.message_id, tr("🔎 Mencari pool untuk <code>{0}</code>… {1}%", [esc(shortA(token)), j.progress || 0]));
        continue;
      }
      if (j.status === 'gagal') return this.edit(chatId, m.message_id, tr("❌ Pemindaian gagal: <code>{0}</code>", [esc(note(j.error))]), kb([[btn(tr("↩︎ Pilih pool"), 'mlp:0'), BACK_HOME]]));
      const [text, keyboard] = await this.lpHasilPindai(chatId, token, false);
      return this.edit(chatId, m.message_id, text, keyboard);
    }
    return this.edit(chatId, m.message_id, tr("⏳ Pemindaian masih berjalan — buka lagi sebentar lagi."), kb([[btn(tr("🔄 Periksa"), `mls:${token}`), BACK_HOME]]));
  }

  async lpHasilPindai(chatId, token, semua) {
    const j = await this.api('GET', '/api/manual/pools/scan', {}, { token, all: semua ? '1' : '' });
    if (j.status === 'kosong') return [tr("Pemindaian itu sudah tidak tersimpan. Kirim alamatnya lagi."), kb([[btn(tr("➕ Dari alamat token"), 'mla')], [BACK_HOME]])];
    if (j.status === 'jalan') return [tr("🔎 Masih memindai… {0}%", [j.progress || 0]), kb([[btn(tr("🔄 Periksa lagi"), `mls:${token}`)], [BACK_HOME]])];
    if (j.status === 'gagal') return [`❌ ${esc(note(j.error))}`, kb([[btn(tr("➕ Coba token lain"), 'mla')], [BACK_HOME]])];

    const list = j.pools || [];
    const s = this.sess(chatId);
    s.poolList = list;                              // indeks tombol menunjuk daftar ini
    const L = [tr("<b>🔎 Pool untuk</b> <code>{0}</code>", [esc(shortA(token))])];
    if (!list.length) {
      L.push(tr("\nTidak ada pool Uniswap v3/v4 yang bisa dimasuki untuk token ini."));
      if (j.total) L.push(tr("<i>{0} pool ditemukan, semuanya tanpa likuiditas atau tanpa aset kuotasi.</i>", [j.total]));
      L.push(...pasarLainTeks(j.lainnya));
    } else {
      L.push(tr("{0} pool bisa dimasuki{1} (dari {2} yang ada).", [list.length, j.hidden ? tr(" · {0} disembunyikan", [j.hidden]) : '', j.total]));
      L.push(kolom(list.slice(0, 10).map((p) => [
        p.pair, p.dynamicFee ? tr("dinamis") : `${trimZ(nf(p.feePct ?? 0, 2))}%`, p.hasHooks ? 'hook' : '',
      ]), 'lr'));
      if (j.hidden) L.push(tr("<i>Yang disembunyikan: pool tanpa likuiditas, berfee dinamis, atau tidak dipasangkan USDG/ETH — masuk ke sana sama saja membuang gas.</i>"));
    }
    const rows = list.slice(0, 10).map((p, i) => [btn(
      `${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? tr("dinamis") : trimZ(nf(p.feePct ?? 0, 2)) + '%'}`.slice(0, 40), `mlP:${i}`)]);
    return [L.filter((x) => x != null).join('\n'), kb([
      ...rows,
      j.hidden && !semua ? [btn(tr("👁 Tampilkan semua ({0})", [j.total]), `mls:${token}:all`)] : null,
      [btn(tr("➕ Token lain"), 'mla'), btn(tr("↩︎ Pilih pool"), 'mlp:0')],
    ])];
  }

  async lpRange(chatId) {
    const d = this.sess(chatId).lp || {};
    const L = [
      tr("<b>📐 Rentang harga</b>"),
      tr("Fee hanya mengalir selama harga berada di dalam rentang. Sempit = fee lebih besar tapi lebih cepat keluar; lebar = lebih aman tapi encer."),
      '',
      tr("Sekarang: <b>{0}</b>", [d.full ? tr("seluruh rentang") : rentangTeks(d)]),
      '',
      tr("<i>Batas bawah dan atas boleh berbeda — misal turun 10%, naik 30%.</i>"),
      tr("Satu sisi: isi 25 0 atau 0 25. Hanya satu token disetor; fee mulai saat harga masuk rentang. Auto-swap bisa diperlukan untuk menyediakan token itu."),
      tr("Tanda +/− memindah batas ke sisi lain harga: <code>-30 -10</code> = seluruhnya di bawah harga (hanya aset kuotasi), <code>+10 +30</code> = seluruhnya di atas (hanya tokennya)."),
    ];
    return [L.join('\n'), kb([
      [btn('±5%', 'mlw:5:5'), btn('±10%', 'mlw:10:10'), btn('±25%', 'mlw:25:25')],
      [btn(tr("1 sisi · bawah −25%"), 'mlw:25:0'), btn(tr("1 sisi · atas +25%"), 'mlw:0:25')],
      [btn('±50%', 'mlw:50:50'), btn('½× – 2×', 'mlw:50:100'), btn(tr("seluruh rentang"), 'mlF')],
      [btn(tr("✏️ Atur bawah & atas"), 'mlC')],
      [btn(tr("↩︎ LP manual"), 'ml')],
    ])];
  }

  async lpPreview(chatId) {
    const d = this.sess(chatId).lp || {};
    const r = await this.api('POST', '/api/manual/lp/plan', d);
    if (r.error) {
      return [tr("⛔ <b>Belum bisa dibuka</b>\n{0}", [esc(note(r.error))]), kb([[btn(tr("↩︎ LP manual"), 'ml'), BACK_HOME]])];
    }
    const p = r.preview;
    const rg = rentang(p);
    const L = [
      tr("<b>👁 Pratinjau — {0}</b>", [esc(p.pair)]),
      `${esc(p.venue)} · fee ${p.dynamicFee ? tr("dinamis") : trimZ(nf(p.feePct ?? 0, 2)) + '%'} · ${p.side === 'both' ? tr("dua sisi") : tr("satu sisi")}`,
      '',
      angka([
        [tr("nilai posisi"), usd(p.valueUsd)],
        [p.symbol0, tok(Number(p.amount0) / 10 ** p.dec0, 6)],
        [p.symbol1, tok(Number(p.amount1) / 10 ** p.dec1, 6)],
        [tr("kas tersedia"), usd(p.kasUsd)],
      ]),
    ];
    if (rg) {
      L.push(`<b>${esc(rg.judul)}</b>`);
      L.push(rg.bar);
      if (rg.kini) L.push(`${esc(rg.kini)}${rg.ket ? ` — ${esc(rg.ket)}` : ''}`);
    }
    for (const w of r.warnings || []) L.push(`⚠️ ${esc(w)}`);
    const live = !this.engine.dryRun();
    L.push('');
    L.push(live
      ? tr("Transaksi dikirim sungguhan dari wallet bot. Posisi ini tidak mencermin siapa pun — ia tidak akan ikut ditutup saat target keluar.")
      : tr("⚠️ Mode <b>simulasi</b>: tombol di bawah akan ditolak."));
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(tr("✅ Buka posisi sekarang"), 'mlX')],
      [btn(tr("💵 Ubah nominal"), 'mln'), btn(tr("📐 Ubah rentang"), 'mlr')],
      [btn(tr("↩︎ LP manual"), 'ml')],
    ])];
  }

  // ---- swap manual ----------------------------------------------------------
  async swapMenu(chatId) {
    const s = this.sess(chatId);
    const d = s.sw || {};
    const t = await this.api('GET', '/api/manual/tokens');
    s.tokenList = t.tokens;
    const punya = t.tokens.filter((x) => x.amount > 0);
    const L = [
      tr("<b>🔁 Swap</b>"),
      tr("Menukar lewat agregator Kyber — rute yang sama dipakai bot untuk zap dan menjual sisa."),
      '',
      tabel([
        [tr("dari"), d.symFrom || tr('— belum dipilih')],
        [tr("ke"), d.symTo || tr('— belum dipilih')],
        [tr("jumlah"), d.amount || tr('— belum diisi')],
      ]),
      tr("<b>Saldo</b>"),
      punya.length ? angka(punya.map((x) => [x.symbol, tok(x.amount, 6)])) : tr("Semua saldo kosong."),
    ];
    if (this.engine.dryRun()) L.push(tr("⚠️ Bot sedang di mode <b>simulasi</b> — kutipan tetap jalan, tapi transaksi tidak akan dikirim."));
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(tr("📤 Dari"), 'swf'), btn(tr("📥 Ke"), 'swt')],
      [btn(tr("🔢 Jumlah"), 'swn')],
      d.from && d.to && d.amount ? [btn(tr("👁 Kutipan & tukar"), 'swq')] : null,
      [btn('↩︎ Menu', 'h')],
    ])];
  }

  async swapPick(chatId, sisi) {
    const s = this.sess(chatId);
    const t = await this.api('GET', '/api/manual/tokens');
    s.tokenList = t.tokens;
    // Sisi "dari" hanya menawarkan yang benar-benar ada saldonya; sisi "ke" boleh apa saja.
    const pilih = sisi === 'from' ? t.tokens.filter((x) => x.amount > 0) : t.tokens;
    const L = [
      `<b>${sisi === 'from' ? tr("📤 Ditukar dari") : tr("📥 Ditukar ke")}</b>`,
      sisi === 'from' ? tr("Hanya token yang ada saldonya.") : tr("Aset kuotasi dan token yang pernah kita pegang."),
      '',
      pilih.length ? angka(pilih.map((x) => [x.symbol, tok(x.amount, 6)])) : tr("Tidak ada pilihan."),
    ];
    const rows = pilih.map((x) => [btn(`${x.symbol} · ${tok(x.amount, 4)}`.slice(0, 40),
      `${sisi === 'from' ? 'swF' : 'swT'}:${t.tokens.indexOf(x)}`)]);
    return [L.filter((x) => x != null).join('\n'), kb([...rows, [btn('↩︎ Swap', 'sw')]])];
  }

  async swapQuote(chatId, ack) {
    const d = this.sess(chatId).sw || {};
    if (!d.from || !d.to || !d.amount) return this.swapMenu(chatId);
    if (ack) await ack(tr("Mengambil kutipan…"));
    const q = await this.api('POST', '/api/manual/swap/quote', { tokenIn: d.from, tokenOut: d.to, amount: d.amount });
    if (q.error) return [`⛔ ${esc(note(q.error))}`, kb([[btn('↩︎ Swap', 'sw'), BACK_HOME]])];
    const L = [
      `<b>👁 ${esc(q.symbolIn)} → ${esc(q.symbolOut)}</b>`,
      '',
      angka([
        [tr("dikirim"), `${tok(q.amountIn, 6)} ${q.symbolIn}`],
        [tr("diterima"), `${tok(q.amountOut, 6)} ${q.symbolOut}`],
        [tr("nilai masuk"), q.usdIn != null ? usd(q.usdIn) : null],
        [tr("nilai keluar"), q.usdOut != null ? usd(q.usdOut) : null],
        [tr("biaya rute"), q.lossBps != null ? `${trimZ(nf(q.lossBps / 100, 2))}%` : null],
      ]),
      q.dex ? tr("<i>lewat {0}</i>", [esc(q.dex)]) : null,
    ];
    if (q.tooLossy) {
      L.push('');
      L.push(tr("⛔ Rute ini rugi {0}%, di atas batas {1}% — bot akan menolaknya. Kecilkan jumlahnya atau naikkan batas di Aturan → Keluar posisi.", [trimZ(nf(q.lossBps / 100, 1)), trimZ(nf(q.maxLossBps / 100, 1))]));
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      q.tooLossy ? null : [btn(tr("✅ Tukar sekarang"), 'swX')],
      [btn(tr("🔢 Ubah jumlah"), 'swn'), btn(tr("🔄 Kutipan ulang"), 'swq')],
      [btn('↩︎ Swap', 'sw')],
    ])];
  }

  // ---- scout & riset -------------------------------------------------------
  async runScout(chatId, addrRaw) {
    const addr = String(addrRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return this.send(chatId, tr("❌ Alamat harus 0x diikuti 40 karakter hex."), kb([[btn(tr("↩︎ Coba lagi"), 'k'), BACK_HOME]]));
    const r0 = await this.api('POST', '/api/scout', { address: addr });
    if (r0.error) return this.send(chatId, `❌ ${esc(note(r0.error))}`, kb([[BACK_HOME]]));
    const m = await this.send(chatId, tr("🔭 Memotret <code>{0}</code>…", [esc(shortA(addr))]));
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      const j = await this.api('GET', '/api/scout', {}, { address: addr });
      if (j.status === 'jalan') {
        if (i % 3 === 0) await this.edit(chatId, m.message_id, tr("🔭 Memotret <code>{0}</code>… {1}%", [esc(shortA(addr)), j.progress || 0]));
        continue;
      }
      if (j.status === 'gagal') return this.edit(chatId, m.message_id, tr("❌ Scout gagal: <code>{0}</code>", [esc(note(j.error))]), kb([[BACK_HOME]]));
      const r = j.result;
      const pairs = Object.entries(r.pairs).sort((a, b) => b[1].valueUsd - a[1].valueUsd).slice(0, 8);
      const L = [
        `<b>🔭 Scout</b> <code>${esc(addr)}</code>`, '',
        tr("posisi hidup    : {0} (dilepas {1})", [r.positionsAlive, r.positionsClosed]),
        tr("nilai posisi    : {0}", [usd(r.totalValueUsd)]),
        tr("fee belum klaim : {0} ({1}% dari nilai)", [usd(r.totalUnclaimedFeeUsd), nf(r.feeRatioPct, 2)]),
        tr("sedang in-range : {0}%", [nf(r.inRangePct, 0)]),
        tr("median posisi   : {0} · lebar {1}%", [usd(r.medianPositionUsd, 0), nf(r.medianWidthPct, 0)]),
        tr("median umur     : {0} jam", [nf(r.medianAgeHours, 1)]),
        '', tr("<b>Pasangan</b>"),
        ...pairs.map(([k, v]) => tr("• {0} — {1} posisi · {2} · fee {3}", [esc(k), v.n, usd(v.valueUsd, 0), usd(v.feeUsd)])),
      ];
      return this.edit(chatId, m.message_id, L.join('\n'), kb([
        [btn(tr("🔎 Riset lengkap"), `wr:${addr}`), btn(tr("➕ Jadikan target"), 'ta')],
        [BACK_HOME],
      ]));
    }
    return this.edit(chatId, m.message_id, tr("⏳ Scout masih berjalan — coba lagi sebentar lagi."), kb([[BACK_HOME]]));
  }

  async runRiset(chatId, addrRaw) {
    const addr = String(addrRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return this.send(chatId, tr("❌ Alamat harus 0x diikuti 40 karakter hex."), kb([[btn(tr("↩︎ Coba lagi"), 'w'), BACK_HOME]]));
    const w = await this.api('GET', '/api/wallet', {}, { address: addr });
    if (!w.found) {
      await this.api('POST', '/api/wallet/scan', { address: addr, mode: 'full' });
      const m = await this.send(chatId, tr("🔎 Wallet ini belum pernah diriset — memindai riwayatnya sekarang. Ini bisa beberapa menit."));
      for (let i = 0; i < 240; i++) {
        await sleep(3000);
        const j = await this.api('GET', '/api/wallet', {}, { address: addr });
        if (j.found && j.job?.status !== 'jalan') break;
        if (j.job?.status === 'gagal') return this.edit(chatId, m.message_id, tr("❌ Riset gagal: <code>{0}</code>", [esc(note(j.job.error))]), kb([[BACK_HOME]]));
        if (i % 3 === 0) await this.edit(chatId, m.message_id, tr("🔎 Memindai <code>{0}</code>… {1}% <i>({2})</i>", [esc(shortA(addr)), j.job?.progress || 0, esc(j.job?.phase || tr("mulai"))]));
      }
      const [text, keyboard] = await this.riset(addr);
      return this.edit(chatId, m.message_id, text, keyboard);
    }
    return this.screen(chatId, null, `wr:${addr}`);
  }

  async riset(addr) {
    const w = await this.api('GET', '/api/wallet', {}, { address: addr });
    if (!w.found) {
      return [tr("Wallet <code>{0}</code> belum pernah diriset.", [esc(addr)]), kb([[btn(tr("🔎 Riset sekarang"), 'w')], [BACK_HOME]])];
    }
    const s = w.stats || {};
    const L = [
      tr("<b>🔎 Riset</b>{0}", [w.label ? ` — ${esc(w.label)}` : '']),
      `<code>${esc(addr)}</code>`,
      tr("<i>dipindai sampai blok {0} · {1}</i>", [num(w.scannedTo), esc(ago(w.lastScanTs))]),
      w.job?.status === 'jalan' ? tr("⏳ sedang diperbarui ({0}%)", [w.job.progress || 0]) : null,
      '',
      angka([
        [tr("posisi terbuka"), w.open.length],
        [tr("posisi ditutup"), w.closed.length],
        [tr("menang"), s.winRatePct != null ? `${nf(s.winRatePct, 0)}%` : null],
        ['PnL', s.pnlUsd != null ? sgn(s.pnlUsd) : null],
        [tr("fee dikumpulkan"), s.feesUsd != null ? sgn(s.feesUsd) : null],
        [tr("modal diputar"), s.investedUsd != null ? sgn(s.investedUsd) : null],
      ]),
    ];
    if (w.open.length) {
      L.push(tr("<b>Posisi terbuka</b>"));
      L.push(tabel(w.open.slice(0, 8).map((p) => [
        `${p.symbol0}/${p.symbol1}`,
        `${usd(p.invested_q)} · fee ${usd(p.feeShown)} · ${dur((p.ageHours || 0) * 3600)}`,
      ])));
    }
    if (w.closed.length) {
      L.push(tr("<b>Terakhir ditutup</b>"));
      L.push(tabel(w.closed.slice(0, 8).map((p) => [
        `${p.symbol0}/${p.symbol1}`,
        `${sgn(p.pnl_q)} ${pct(p.pnlPct)} · ${ago(p.closed_ts)}`,
      ])));
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(tr("🔄 Perbarui riset"), `tr:${addr}`)],
      w.isTarget ? [btn(tr("🎯 Halaman target"), `t:${addr}`)] : [btn(tr("➕ Jadikan target"), 'ta')],
      [btn(tr("📇 Wallet lain"), 'wl'), BACK_HOME],
    ])];
  }

  async walletList() {
    const d = await this.api('GET', '/api/wallets');
    const L = [tr("<b>📇 Wallet yang pernah diriset</b>"), ''];
    for (const w of d.wallets.slice(0, 20)) {
      L.push(tr("• <code>{0}</code> {1} — {2} posisi · {3}", [esc(shortA(w.address)), esc(w.label || ''), w.positions_n || 0, ago(w.last_scan_ts)]));
    }
    if (!d.wallets.length) L.push(tr("(belum ada)"));
    return [L.join('\n'), kb([
      ...d.wallets.slice(0, 12).map((w) => [btn(`${(w.label || shortA(w.address)).slice(0, 28)}`, `wr:${w.address}`)]),
      [btn(tr("🔎 Riset wallet baru"), 'w'), BACK_HOME],
    ])];
  }
}

module.exports = { Telegram, parseVal, showVal, RULE_GROUPS, FORMS, COMMANDS, ALIAS, kolom, tabel, rentang, tickPrice, dur, parseRentang, rentangTeks };
