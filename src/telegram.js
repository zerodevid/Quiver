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

const API = 'https://api.telegram.org/bot';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- format ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const nf = (n, d = 2) => Number(n).toLocaleString('id-ID', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${nf(n, d)}`);
const pct = (n, d = 1) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : ''}${nf(n, d)}%`);
const sgn = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n >= 0 ? '+' : '−'}$${nf(Math.abs(n), d)}`);
const shortA = (a) => (a ? `${String(a).slice(0, 6)}…${String(a).slice(-4)}` : '—');
const shortH = (h) => (h ? `${String(h).slice(0, 10)}…` : '—');
// Buang nol di ekor pecahan: "1,50" -> "1,5", "1,00" -> "1". Angka tanpa koma
// tidak disentuh — di format Indonesia "1.000" adalah seribu, bukan satu koma nol.
// Rentang LP manual: "10 30" / "-10 +30" / "−10/+30" = turun 10%, naik 30%; "25" = ±25%.
function parseRentang(text) {
  const nums = String(text).replace(/[−–]/g, '-').replace(/,/g, '.').match(/[-+]?\d+(?:\.\d+)?/g) || [];
  if (!nums.length || nums.length > 2) return { error: 'kirim satu angka (±) atau dua angka: batas bawah lalu batas atas, misal 10 30' };
  const [a, b] = nums.map((x) => Math.abs(Number(x)));
  const lowerPct = a, upperPct = nums.length === 2 ? b : a;
  if (!(lowerPct >= 0 && lowerPct < 100)) return { error: 'batas bawah harus 0 sampai di bawah 100% — turun 100% berarti harga nol' };
  if (!(upperPct >= 0 && upperPct <= 100000)) return { error: 'batas atas maksimal 100.000%' };
  if (lowerPct === 0 && upperPct === 0) return { error: 'rentangnya kosong' };
  return { lowerPct, upperPct };
}
// Di mana token itu diperdagangkan kalau bukan di Uniswap v3/v4 (data GeckoTerminal).
function pasarLainTeks(lainnya) {
  if (!lainnya?.length) return [];
  const nf0 = (n) => (n >= 1000 ? `$${nf(n / 1000, 1)}rb` : `$${nf(n, 0)}`);
  return [
    '',
    '<b>Diperdagangkan di:</b>',
    ...lainnya.map((x) => `• ${esc(x.dex)} — ${esc(x.name)} · likuiditas ${nf0(x.reserveUsd)}`),
    '',
    '<i>Bot hanya bisa membuka LP di Uniswap v3/v4 (likuiditas terkonsentrasi dengan rentang harga). Pool gaya v2 seperti Pons V2 tidak punya rentang, NFT posisi, maupun fee terpisah — cara kerjanya lain sama sekali.</i>',
  ];
}

// Sesi lama masih membawa widthPct (±X% simetris dalam tick) — tetap ditampilkan apa adanya.
function rentangTeks(d) {
  if (d.lowerPct == null && d.upperPct == null) return `±${trimZ(nf(d.widthPct ?? 25, 1))}%`;
  const lo = d.lowerPct ?? 0, up = d.upperPct ?? 0;
  return lo === up ? `±${trimZ(nf(lo, 2))}%` : `−${trimZ(nf(lo, 2))}% / +${trimZ(nf(up, 2))}%`;
}

const trimZ = (s) => (s.includes(',') ? s.replace(/,?0+$/, '') : s);
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('id-ID'));
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
  if (s < 5) return 'baru saja';
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.round(s / 3600)} jam lalu`;
  const h = s / 86400;
  return `${h < 10 ? trimZ(nf(h, 1)) : Math.round(h)} hari lalu`;
}
// Kebalikan ago(): untuk waktu yang belum tiba. ago() memotong selisih negatif jadi
// nol, jadi memakainya untuk jadwal berikutnya selalu menghasilkan "0 dtk".
function nanti(ts) {
  if (!ts) return '—';
  const s = Math.round((ts - Date.now()) / 1000);
  if (s <= 0) return 'sebentar lagi';
  if (s < 60) return `${s} dtk lagi`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lagi`;
  return `${Math.floor(s / 3600)}j ${Math.round((s % 3600) / 60)}m lagi`;
}
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return String(u).slice(0, 24); } };

function dur(sec) {
  if (sec < 60) return `${Math.round(sec)} detik`;
  if (sec < 3600) return `${Math.round(sec / 60)} menit`;
  if (sec < 86400) {
    const j = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
    return m ? `${j} jam ${m} menit` : `${j} jam`;
  }
  const h = Math.floor(sec / 86400), j = Math.floor((sec % 86400) / 3600);
  return j ? `${h} hari ${j} jam` : `${h} hari`;
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
  if (p >= 1e6) return p.toLocaleString('id-ID', { maximumFractionDigits: 0 });
  if (p >= 1) return p.toLocaleString('id-ID', { maximumSignificantDigits: 6 });
  if (p >= 1e-7) return p.toLocaleString('id-ID', { maximumSignificantDigits: 3 });
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
      ket = `di dalam, ${nf(Math.min(keBawah, keAtas), 0)}% ke tepi ${keBawah < keAtas ? 'bawah' : 'atas'}`;
    } else {
      const jauh = kini < lo ? (lo / kini - 1) * 100 : (kini / hi - 1) * 100;
      ket = `di luar rentang, ${nf(jauh, 0)}% di ${kini < lo ? 'bawah' : 'atas'}`;
    }
  }
  return {
    judul: `Rentang harga — ${dasar || '?'} dalam ${kuotasi || '?'}`,
    bar: `<pre>${esc(harga(lo))} ${bar} ${esc(harga(hi))}</pre>`,
    kini: kini != null ? `harga kini ${harga(kini)}` : null,
    ket,
  };
}
const cut = (s, n = 3800) => (s.length <= n ? s : s.slice(0, n) + '\n…(dipotong)');

// Baris log yang didorong ke chat. Pesan mesin umumnya berbentuk "konteks: rincian"
// (mis. "eksekusi masuk: saldo kurang"); konteksnya dijadikan judul supaya sekali
// lirik sudah jelas bagian mana yang bermasalah, rinciannya di baris sendiri.
function logBaris(level, msg) {
  const [icon, jenis] = { error: ['⛔', 'Galat'], warn: ['⚠️', 'Peringatan'], info: ['ℹ️', 'Info'], pulih: ['✅', 'Pulih'] }[level] || ['•', level];
  const m = /^([^:\n]{2,40}):\s+([\s\S]+)$/.exec(String(msg ?? ''));
  const judul = m ? `${jenis} · ${m[1]}` : jenis;
  const isi = m ? m[2] : String(msg ?? '');
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
      F.bps('max_slippage_bps', 'Toleransi geser harga', { when: (r) => r.swap.enabled }),
      F.bps('max_price_impact_bps', 'Batas rugi rute', { when: (r) => r.swap.enabled }),
    ],
  },
  {
    g: 'exit', title: '🚪 Keluar posisi', fields: [
      F.bool('follow_target', 'Ikut keluar saat target keluar'),
      F.bool('follow_partial', 'Ikut menarik sebagian', { when: (r) => r.exit.follow_target }),
      F.int('out_of_range_minutes', 'Tutup kalau di luar rentang selama (menit)', { help: '0 = mati.' }),
      F.pct('stop_loss_pct', 'Tutup kalau rugi (%)', { help: '0 = mati.' }),
      F.pct('take_profit_pct', 'Tutup kalau untung (%)', { help: '0 = mati.' }),
      F.num('max_age_hours', 'Tutup setelah (jam)', { hi: 100000, help: '0 = mati.' }),
      F.bool('sell_leftover', 'Jual otomatis memecoin sisa'),
      F.bps('sell_max_loss_bps', 'Batas rugi saat menjual sisa', { when: (r) => r.exit.sell_leftover }),
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
    case 'bool': return v ? '✅ ya' : '❌ tidak';
    case 'usd': return usd(v, v >= 100 ? 0 : 2);
    case 'pct': return `${trimZ(nf(v, 2))}%`;
    case 'bps': return `${trimZ(nf(v / 100, 2))}%`;
    case 'pilih': return (spec.opts.find(([k]) => k === v) || [null, String(v)])[1];
    case 'daftar': return Array.isArray(v) && v.length ? v.join(', ') : '(kosong)';
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
    if (!hit) throw new Error(`pilihannya: ${spec.opts.map(([k]) => k).join(', ')}`);
    return hit[0];
  }
  if (spec.type === 'bool') return /^(1|ya|y|true|on|nyala)$/i.test(t);
  let n = Number(t.replace(/[$%\s]/g, '').replace(',', '.'));
  if (spec.type === 'bps' && /%$/.test(t.trim())) n = n * 100;
  if (!Number.isFinite(n)) throw new Error('harus berupa angka');
  if (spec.type === 'int') n = Math.round(n);
  if (n < spec.lo || n > spec.hi) throw new Error(`harus antara ${spec.lo} dan ${spec.hi}`);
  return n;
}
const askHint = (spec) => {
  if (spec.type === 'daftar') return 'Kirim daftar dipisah koma, atau "-" untuk mengosongkan.';
  if (spec.type === 'bps') return `Kirim angka persen (mis. 1,5) atau bps (mis. 150). Antara ${spec.lo} dan ${spec.hi} bps.`;
  return `Kirim angka antara ${spec.lo} dan ${spec.hi}.`;
};

// Nama perintah dibuat Inggris supaya cepat diketik dan cocok dengan kebiasaan bot
// Telegram lain; isi layarnya tetap Indonesia. Nama lama yang berbahasa Indonesia
// tetap diterima diam-diam (ALIAS) — tidak ditampilkan di menu, tapi tidak
// mematahkan petunjuk atau kebiasaan yang sudah terlanjur dipakai.
const COMMANDS = [
  ['menu', 'Main menu'],
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
  ['help', 'List every command'],
];
const ALIAS = {
  mulai: 'start', ringkasan: 'summary', status: 'summary', posisi: 'positions',
  target: 'targets', aktivitas: 'activity', aturan: 'rules', pengaturan: 'settings',
  saldo: 'balance', sisa: 'leftovers', log: 'logs', riset: 'research',
  jeda: 'pause', lanjut: 'resume', bantuan: 'help',
};

// Perintah penyambungan: /start <kode>. Dipakai juga oleh tautan dalam t.me.
const PAIR_RE = /^\/(?:start|mulai)(?:@\S+)?\s+(\S+)/i;

class Telegram {
  constructor({ cfg, cfgPath, store, engine, api, log }) {
    this.cfg = cfg; this.cfgPath = cfgPath; this.store = store; this.engine = engine;
    this.api = api; this.log = log || (() => {});
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
    if (!tok) throw new Error('bot_token Telegram belum diisi');
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
  push(text, keyboard = null) {
    if (!this.token() || !this.chats().length) return;
    if (this.queue.length > 40) return;              // banjir log: jangan menumpuk
    this.queue.push({ text, keyboard });
    if (!this.sending) this.drain();
  }
  async drain() {
    this.sending = true;
    while (this.queue.length && !this.stopped) {
      const { text, keyboard } = this.queue.shift();
      for (const c of this.chats()) {
        try { await this.send(c, text, keyboard); } catch (e) { this.log(`telegram kirim: ${e.message}`); }
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
    if (!p || Date.now() > p.exp) return { error: 'Kode sudah kedaluwarsa. Buat kode baru di dasbor → Pengaturan → Telegram.' };
    if (String(code || '').trim().toUpperCase() !== p.code) return { error: 'Kode salah.' };
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
      if (!detail?.kind) return this.push(`🔔 <b>${esc(msg)}</b>`);
      // Kabar berdetail disusun jadi kartu (butuh baca API, jadi asinkron). Kalau
      // penyusunannya gagal, teks polosnya tetap terkirim — kabar tidak boleh hilang.
      this.kartu(msg, detail)
        .catch((e) => { this.log(`telegram kartu: ${e.message}`); return [`🔔 <b>${esc(msg)}</b>`, null]; })
        .then(([text, keyboard]) => this.push(text, keyboard));
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
      if (meta?.recovered) { if (n.error) this.push(logBaris('pulih', msg)); return; }
      if (level === 'error' && n.error) this.push(logBaris(level, msg));
      else if (level === 'warn' && n.warn) this.push(logBaris(level, msg));
      else if (level === 'info' && n.info && msg !== this.lastNotify) this.push(logBaris(level, msg));
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
    if (u.callback_query) return this.onCallback(u.callback_query);
    if (u.message) return this.onMessage(u.message);
  }

  async onMessage(msg) {
    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();
    if (!this.chats().includes(chatId)) {
      const m = text.match(PAIR_RE);
      if (m) {
        const r = this.tryPair(chatId, m[1]);
        if (r.error) return this.send(chatId, `❌ ${esc(r.error)}`);
        return this.screen(chatId, null, 'h', `✅ Chat tersambung. Selamat datang di <b>Quiver</b>.\n\n`);
      }
      // Bot ini bisa ditemukan siapa saja lewat namanya. Petunjuknya dikirim sekali
      // per chat; sisanya didiamkan supaya tidak bisa dipakai memancing balasan terus.
      if (!this.told) this.told = new Set();
      if (this.told.has(chatId)) return;
      this.told.add(chatId);
      return this.send(chatId, 'Chat ini belum tersambung ke Quiver.\n\nBuka dasbor → <b>Pengaturan</b> → <b>Telegram</b> → <i>Buat kode</i>, lalu kirim di sini:\n<code>/start KODE</code>');
    }

    const s = this.sess(chatId);
    // Sedang ditanya sesuatu? Jawaban apa pun yang bukan perintah dianggap isian.
    if (s.pending && !text.startsWith('/')) {
      const p = s.pending; s.pending = null;
      try { return await this.answer(chatId, p, text); }
      catch (e) { return this.send(chatId, `❌ ${esc(e.message)}`, kb([[btn('↩︎ Coba lagi', p.retry || 'h'), BACK_HOME]])); }
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
    switch (cmd) {
      case 'start': case 'menu': return go('h');
      case 'summary': return go('o');
      case 'positions': return go('p');
      case 'targets': return go('t');
      case 'activity': return go('a:0');
      case 'rules': return go('r');
      case 'settings': return go('s');
      case 'balance': return go('b');
      case 'leftovers': return go('f');
      case 'logs': return go('l');
      case 'tx': return go('x');
      case 'pause': return this.setPause(chatId, null, true);
      case 'resume': return this.setPause(chatId, null, false);
      case 'scout':
        if (arg) return this.runScout(chatId, arg);
        return this.ask(chatId, { kind: 'scout' }, 'Kirim alamat wallet yang mau dipotret.\n<i>Contoh:</i> <code>0x3c92…2976</code>');
      case 'research':
        if (arg) return this.runRiset(chatId, arg);
        return this.ask(chatId, { kind: 'riset' }, 'Kirim alamat wallet yang mau diriset (PnL, posisi, riwayat).');
      case 'help':
        return this.send(chatId, `<b>Perintah</b>\n${COMMANDS.map(([c, d]) => `/${c} — ${esc(d)}`).join('\n')}\n\nSemua ini juga ada tombolnya di /menu.\n\n💡 Tempel <b>alamat token</b> kapan saja → langsung ke layar pasang LP. Tempel <b>alamat wallet</b> → riset PnL atau jadikan target.`, kb([[BACK_HOME]]));
      default:
        return this.send(chatId, 'Perintah tidak dikenal. /bantuan untuk daftarnya.', kb([[BACK_HOME]]));
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
    if (!this.chats().includes(chatId)) return ack('Chat ini tidak berwenang.', true);
    const guard = setTimeout(() => { ack(); }, 2000);
    try {
      await this.screen(chatId, msgId, q.data, '', ack);
      await ack();
    } catch (e) {
      this.log(`telegram tombol ${q.data}: ${e.message}`);
      await ack(`Galat: ${e.message}`.slice(0, 190), true);
      await this.edit(chatId, msgId, `⛔ <b>Gagal</b>\n<code>${esc(e.message)}</code>`, kb([[BACK_HOME]])).catch(() => {});
    } finally { clearTimeout(guard); }
  }

  // Menanyakan sesuatu ke user; jawabannya ditangani di answer().
  ask(chatId, pending, text) {
    this.sess(chatId).pending = pending;
    return this.send(chatId, `${text}\n\n<i>Kirim /menu untuk membatalkan.</i>`);
  }

  // ---- pemetaan layar ------------------------------------------------------
  async screen(chatId, msgId, data, prefix = '', ack = null) {
    const [head, ...rest] = String(data).split(':');
    const out = (text, keyboard) => (msgId ? this.edit(chatId, msgId, prefix + text, keyboard) : this.send(chatId, prefix + text, keyboard));
    const s = this.sess(chatId);

    switch (head) {
      case 'h': return out(...(await this.home()));
      case 'o': return out(...(await this.overview()));
      case 'b': return out(...(await this.saldo()));
      case 'p': return rest[0] ? out(...(await this.posisiDetail(rest[0]))) : out(...(await this.posisi()));
      case 'pc': return out(...(await this.tutupKonfirm(rest[0])));
      case 'pC': {
        if (ack) await ack('Mengirim transaksi…');
        // Server baru menjawab setelah receipt diterima (bisa ~1 menit); tanpa pesan
        // antara, layar konfirmasi terlihat macet dan tombolnya mengundang klik ulang.
        if (msgId) await out(`⏳ Menutup posisi #${esc(rest[0])}… menunggu konfirmasi di chain.`);
        const r = await this.api('POST', '/api/positions/close', { id: Number(rest[0]) });
        if (r.error) return out(`❌ Gagal menutup posisi #${esc(rest[0])}\n<code>${esc(r.error)}</code>`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]]));
        const hasil = [
          r.outUsd != null && `Diterima ${usd(r.outUsd)}`,
          r.pnlUsd != null && `PnL ${sgn(r.pnlUsd)}`,
        ].filter(Boolean).join(' · ');
        return out(`✅ Posisi #${esc(rest[0])} ditutup.${hasil ? `\n${hasil}` : ''}${r.sold ? `\n${esc(r.sold)}` : ''}\nTx: <code>${esc(shortH(r.tx))}</code>`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]]));
      }
      case 't': return rest[0] ? out(...(await this.targetDetail(rest[0]))) : out(...(await this.targets()));
      case 'tt': {
        const list = (await this.api('GET', '/api/targets')).targets;
        const tgt = list.find((x) => x.address === rest[0]);
        await this.api('POST', '/api/targets/toggle', { address: rest[0], enabled: !tgt?.enabled });
        if (ack) await ack(tgt?.enabled ? 'Target dimatikan' : 'Target dinyalakan');
        return out(...(await this.targetDetail(rest[0])));
      }
      case 'tn': return this.ask(chatId, { kind: 'label', address: rest[0], retry: `t:${rest[0]}` }, `Kirim nama baru untuk <code>${esc(shortA(rest[0]))}</code>.`);
      case 'td': return out(`🗑 Hapus target <code>${esc(rest[0])}</code>?\n\nPosisi yang sudah terbuka <b>tidak</b> ikut ditutup — bot cuma berhenti mengikuti wallet ini.`,
        kb([[btn('✅ Ya, hapus', `tD:${rest[0]}`)], [btn('↩︎ Batal', `t:${rest[0]}`)]]));
      case 'tD':
        await this.api('POST', '/api/targets/delete', { address: rest[0] });
        if (ack) await ack('Target dihapus');
        return out(...(await this.targets()));
      case 'ta': return this.ask(chatId, { kind: 'tambahTarget', retry: 't' }, 'Kirim alamat wallet yang mau diikuti.\nBoleh sekalian namanya: <code>0xabc… Bang GE</code>');
      case 'tr':
        await this.api('POST', '/api/wallet/scan', { address: rest[0], mode: 'refresh' });
        if (ack) await ack('Riset dimulai di latar');
        return out(...(await this.riset(rest[0])));
      case 'tw': return out(...(await this.riset(rest[0])));
      case 'ts': s.scope = rest[0]; return out(...(await this.rulesMenu(chatId)));

      case 'a': return out(...(await this.aktivitas(Number(rest[0] || 0))));
      case 'l': return out(...(await this.logs()));
      case 'x': return out(...(await this.txs()));

      case 'r': return rest[0] ? out(...(await this.rulesGroup(chatId, Number(rest[0])))) : out(...(await this.rulesMenu(chatId)));
      case 'rg': s.scope = 'g'; return out(...(await this.rulesMenu(chatId)));
      case 're': return this.askField(chatId, RULE_GROUPS[+rest[0]].fields[+rest[1]], `re:${rest[0]}:${rest[1]}`, `r:${rest[0]}`);
      case 'rb': case 'rv': {
        const grp = RULE_GROUPS[+rest[0]], spec = grp.fields[+rest[1]];
        const cur = await this.readRules(chatId);
        const val = head === 'rb' ? !this.resolvedRule(cur.resolved, grp.g, spec.k) : spec.opts[+rest[2]][0];
        await this.writeRule(chatId, grp.g, spec.k, val);
        if (ack) await ack('Tersimpan');
        return out(...(await this.rulesGroup(chatId, +rest[0])));
      }
      case 'rp': {                                  // pilih nilai dari daftar
        const grp = RULE_GROUPS[+rest[0]], spec = grp.fields[+rest[1]];
        return out(`<b>${esc(spec.label)}</b>\n${spec.help ? esc(spec.help) + '\n' : ''}\nPilih:`,
          kb([...spec.opts.map(([k, lbl], i) => [btn(lbl, `rv:${rest[0]}:${rest[1]}:${i}`)]), [btn('↩︎ Kembali', `r:${rest[0]}`)]]));
      }
      case 'rx':
        await this.clearRule(chatId, RULE_GROUPS[+rest[0]].g, RULE_GROUPS[+rest[0]].fields[+rest[1]].k);
        if (ack) await ack('Penyesuaian dihapus');
        return out(...(await this.rulesGroup(chatId, +rest[0])));

      case 's': return out(...(await this.settings()));
      case 'sp': return this.setPause(chatId, msgId, !this.engine.paused(), ack);
      case 'sl': {
        if (!this.engine.dryRun()) {                 // mematikan LIVE tidak perlu konfirmasi
          const r = await this.api('POST', '/api/settings/live', { live: false });
          if (ack) await ack(r.error || 'Kembali ke mode simulasi');
          return out(...(await this.settings()));
        }
        return this.ask(chatId, { kind: 'live', retry: 's' },
          '⚠️ <b>Menyalakan mode LIVE</b>\n\nMulai saat itu bot mengirim transaksi sungguhan memakai dana di wallet bot.\n\nKetik <code>LIVE</code> untuk mengonfirmasi.');
      }
      case 'wb': return out(...(await this.walletScreen()));
      case 'wbg': return out('🔑 <b>Buat wallet baru?</b>\n\nKunci lama otomatis dicadangkan (tidak dihapus), lalu bot memakai alamat baru. Dana di alamat lama <b>tidak</b> ikut pindah.\n\nHanya bisa saat mode simulasi.',
        kb([[btn('✅ Ya, buat baru', 'wbG')], [btn('↩︎ Batal', 'wb')]]));
      case 'wbG': {
        const r = await this.api('POST', '/api/settings/wallet/generate', { replace: true });
        if (r.error) return out(`❌ ${esc(r.error)}`, kb([[btn('↩︎ Kembali', 'wb')]]));
        return out(`✅ Wallet baru: <code>${esc(r.address)}</code>\nFrasa pemulihan disimpan di server (<code>${esc(r.mnemonicFile)}</code>) dan sengaja tidak dikirim lewat Telegram.`, kb([[btn('↩︎ Wallet', 'wb')], [BACK_HOME]]));
      }
      case 'wbr': return this.ask(chatId, { kind: 'lepasWallet', retry: 'wb' }, 'Untuk melepas wallet, kirim alamatnya persis (kunci dicadangkan, tidak dihapus).');

      case 'sr': {
        if (!rest[0]) return out(...(await this.rpcScreen()));
        if (ack) await ack('Menguji endpoint…');
        await out('🔬 Menguji endpoint… <i>(bisa sampai satu menit)</i>');
        return out(...(await this.rpcTest(+rest[0])));
      }
      case 'sra': return this.ask(chatId, { kind: 'rpcTambah', retry: 'sr' }, 'Kirim URL endpoint RPC baru (harus <code>https://</code>).\n\n<i>Jangan kirim URL yang mengandung API key lewat Telegram — pakai dasbor untuk itu.</i>');
      case 'srd': {
        const st = await this.api('GET', '/api/settings');
        const keep = st.rpc.filter((e) => e.id !== +rest[0]).map((e) => ({ id: e.id }));
        const r = await this.api('POST', '/api/settings/rpc', { endpoints: keep });
        if (ack) await ack(r.error || 'Endpoint dihapus');
        return out(...(await this.rpcScreen()));
      }

      case 'sf': return out(...(await this.form(rest[0])));
      case 'sfe': return this.askField(chatId, FORMS[rest[0]].fields[+rest[1]], `sfe:${rest[0]}:${rest[1]}`, `sf:${rest[0]}`);
      case 'sfb': {
        const f = FORMS[rest[0]], spec = f.fields[+rest[1]];
        const st = await this.api('GET', '/api/settings');
        const cur = f.pick(st);
        const r = await this.api('POST', f.post, { ...cur, [spec.k]: !cur[spec.k] });
        if (ack) await ack(r.error || 'Tersimpan');
        return out(...(await this.form(rest[0])));
      }

      case 'sn': return out(...(await this.notifyScreen()));
      case 'snb': {
        const n = this.notifCfg();
        this.cfg.telegram = { ...(this.cfg.telegram || {}), notify: { ...n, [rest[0]]: !n[rest[0]] } };
        this.saveCfg();
        if (ack) await ack('Tersimpan');
        return out(...(await this.notifyScreen()));
      }
      case 'snp': return this.ask(chatId, { kind: 'ntfy', retry: 'sn' }, 'Kirim topik ntfy (4–64 huruf/angka/-/_), atau <code>-</code> untuk mematikan.');
      case 'snt': {
        const r = await this.api('POST', '/api/settings/notify/test');
        if (ack) await ack(r.error || 'Terkirim ke ntfy');
        return out(...(await this.notifyScreen()));
      }
      case 'sc': return out(...(await this.chatsScreen()));
      case 'scd': {
        const ids = this.chats().filter((c) => c !== rest[0]);
        this.cfg.telegram = { ...(this.cfg.telegram || {}), chat_ids: ids };
        this.saveCfg();
        this.log(`telegram: chat ${rest[0]} dilepas`);
        if (ack) await ack('Chat dilepas');
        return out(...(await this.chatsScreen()));
      }
      case 'sk': return out('🔐 <b>Ganti token akses dasbor?</b>\n\nSemua peramban yang sedang terbuka harus masuk ulang dengan token baru.',
        kb([[btn('✅ Ya, ganti', 'sK')], [btn('↩︎ Batal', 's')]]));
      case 'sK': {
        const r = await this.api('POST', '/api/settings/token/rotate', {});
        return out(`🔐 Token akses baru:\n<code>${esc(r.token)}</code>\n\n<i>Simpan sekarang — token ini tidak ditampilkan lagi. Hapus pesan ini setelah disalin.</i>`, kb([[btn('↩︎ Pengaturan', 's')]]));
      }

      case 'f': return out(...(await this.leftovers()));
      case 'fr': {
        if (ack) await ack('Mencoba menjual sekarang…');
        const r = await this.api('POST', '/api/leftovers/retry', {});
        return out(...(await this.leftovers(r.error)));
      }
      case 'fd': {
        const r = await this.api('POST', '/api/leftovers/drop', { posId: Number(rest[0]), token: rest[1] });
        if (ack) await ack(r.error || 'Dikeluarkan dari antrean');
        return out(...(await this.leftovers()));
      }

      // ---- LP manual ----
      case 'ml': s.lpAsal = 'ml'; return out(...(await this.lpMenu(chatId)));

      // ---- kartu pasang LP (alamat token ditempel) ----
      case 'qk': return out(...(await this.lpKartu(chatId)));
      case 'qkn': s.lp = { ...(s.lp || {}), usd: Number(rest[0]) }; return out(...(await this.lpKartu(chatId)));
      case 'qkN': s.lpAsal = 'qk';
        return this.ask(chatId, { kind: 'lpUsd', retry: 'qk' }, 'Berapa dolar yang mau dimasukkan?\n\n<i>Ini nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.</i>');
      case 'qkw': s.lp = { ...(s.lp || {}), lowerPct: Number(rest[0]), upperPct: Number(rest[1]), widthPct: undefined, full: false };
        return out(...(await this.lpKartu(chatId)));
      case 'qkF': s.lp = { ...(s.lp || {}), full: true }; return out(...(await this.lpKartu(chatId)));
      case 'qkC': s.lpAsal = 'qk';
        return this.ask(chatId, { kind: 'lpWidth', retry: 'qk' },
          'Kirim <b>batas bawah</b> dan <b>batas atas</b> dalam persen dari harga kini.\n\n'
          + '<code>10 30</code> → turun sampai −10%, naik sampai +30%\n'
          + '<code>25</code> → ±25%');
      case 'qkp': return out(...this.lpKartuPool(chatId));
      case 'qkP': {
        const pool = (s.qkPools || [])[+rest[0]];
        if (pool) s.lp = { ...(s.lp || {}), poolRef: pool.poolRef, pair: pool.pair };
        return out(...(await this.lpKartu(chatId)));
      }
      case 'qkY': return out(...this.lpKartuYakin(chatId));

      // ---- alamat wallet yang ditempel ----
      case 'adT': {
        if (!/^0x[0-9a-f]{40}$/.test(s.alamat || '')) return out('Alamatnya sudah tidak tersimpan — tempel lagi.', kb([[BACK_HOME]]));
        const r = await this.api('POST', '/api/targets', { address: s.alamat, label: null });
        if (r.error) return out(`❌ ${esc(r.error)}`, kb([[BACK_HOME]]));
        return out(`✅ <code>${esc(shortA(s.alamat))}</code> sekarang diikuti.\n<i>Aturan default dipakai sampai kamu setel sendiri.</i>`, kb([[btn('🎯 Daftar target', 't'), BACK_HOME]]));
      }
      case 'mlp': return out(...(await this.lpPools(chatId, Number(rest[0] || 0), rest[1] || '')));
      case 'mlP': {
        const pool = (s.poolList || [])[+rest[0]];
        if (!pool) return out(...(await this.lpPools(chatId, 0)));
        s.lp = { ...(s.lp || { usd: null, lowerPct: 25, upperPct: 25 }), poolRef: pool.poolRef, pair: pool.pair };
        return out(...(await this.lpMenu(chatId)));
      }
      case 'mlc': return this.ask(chatId, { kind: 'poolCari', retry: 'mlp:0' }, 'Ketik nama pasangan yang dicari, misal <code>HOOKR</code> atau <code>USDG/ND4</code>.');
      case 'mla': return this.ask(chatId, { kind: 'scanToken', retry: 'mlp:0' },
        'Kirim <b>alamat token</b>-nya. Bot akan mencari sendiri semua pool Uniswap v3 & v4 yang memuat token itu, langsung dari chain.\n\n<i>Contoh:</i> <code>0x12d5ee7917ca430073c3a638ee1e6f0648a98a01</code>');
      case 'mls': return out(...(await this.lpHasilPindai(chatId, rest[0], rest[1] === 'all')));
      case 'mln': return this.ask(chatId, { kind: 'lpUsd', retry: 'ml' }, 'Berapa dolar yang mau dimasukkan?\n\n<i>Ini nilai posisi, bukan jumlah token — bot mengurus sendiri tukar-menukarnya.</i>');
      case 'mlr': return out(...(await this.lpRange(chatId)));
      case 'mlw': {
        const lo = Number(rest[0]), up = Number(rest[1] ?? rest[0]);
        s.lp = { ...(s.lp || {}), lowerPct: lo, upperPct: up, widthPct: undefined, full: false };
        return out(...(await this.lpMenu(chatId)));
      }
      case 'mlF': { s.lp = { ...(s.lp || {}), full: true }; return out(...(await this.lpMenu(chatId))); }
      case 'mlC': return this.ask(chatId, { kind: 'lpWidth', retry: 'mlr' },
        'Kirim <b>batas bawah</b> dan <b>batas atas</b> dalam persen dari harga kini.\n\n'
        + '<code>10 30</code> → turun sampai −10%, naik sampai +30%\n'
        + '<code>25</code> → ±25%\n'
        + '<code>0 50</code> → mulai tepat di harga kini, naik sampai +50%\n\n'
        + '<i>Makin sempit makin besar fee-nya, tapi makin cepat keluar rentang.</i>');
      case 'mlv': return out(...(await this.lpPreview(chatId)));
      case 'mlX': {
        const d = s.lp || {};
        if (ack) await ack('Membuka posisi…');
        await out('⏳ Membuka posisi… <i>(jembatan kas, zap, lalu mint — bisa sampai satu menit)</i>');
        const r = await this.api('POST', '/api/manual/lp/open', d);
        if (r.error) return out(`⛔ <b>Gagal membuka LP</b>\n<code>${esc(r.error)}</code>`, kb([[s.lpAsal === 'qk' ? btn('↩︎ Kembali', 'qk') : btn('↩︎ LP manual', 'ml'), BACK_HOME]]));
        s.lp = null;
        return out(`✅ <b>LP dibuka</b>\n${esc(r.note)}\ntx <code>${esc(shortH(r.tx))}</code>`, kb([[btn('💼 Lihat posisi', 'p')], [BACK_HOME]]));
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
      case 'swn': return this.ask(chatId, { kind: 'swAmount', retry: 'sw' }, 'Berapa yang mau ditukar?\n\nBoleh angka (<code>0,05</code>), persen (<code>50%</code>), atau <code>semua</code>.');
      case 'swq': return out(...(await this.swapQuote(chatId, ack)));
      case 'swX': {
        const d = s.sw || {};
        if (ack) await ack('Menukar…');
        await out('⏳ Menukar lewat Kyber…');
        const r = await this.api('POST', '/api/manual/swap', { tokenIn: d.from, tokenOut: d.to, amount: d.amount });
        if (r.error) return out(`⛔ <b>Swap gagal</b>\n<code>${esc(r.error)}</code>`, kb([[btn('↩︎ Swap', 'sw'), BACK_HOME]]));
        s.sw = { ...d, amount: null };
        return out(`✅ <b>Swap selesai</b>\n${esc(r.note)}${r.dex ? `\nlewat ${esc(r.dex)}` : ''}\ntx <code>${esc(shortH(r.tx))}</code>`, kb([[btn('💵 Saldo', 'b'), btn('🔁 Swap lagi', 'sw')], [BACK_HOME]]));
      }

      case 'k': return this.ask(chatId, { kind: 'scout' }, 'Kirim alamat wallet yang mau dipotret.');
      case 'w': return this.ask(chatId, { kind: 'riset' }, 'Kirim alamat wallet yang mau diriset.');
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
        return this.screen(chatId, null, `t:${p.address}`, '✅ Nama diperbarui.\n\n');
      }
      case 'tambahTarget': {
        const [addr, ...lbl] = text.split(/\s+/);
        const r = await this.api('POST', '/api/targets', { address: addr, label: lbl.join(' ') || null });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 't', '✅ Target ditambahkan.\n\n');
      }
      case 'live': {
        const r = await this.api('POST', '/api/settings/live', { live: true, confirm: text.trim() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 's', '🟢 <b>Mode LIVE menyala.</b>\n\n');
      }
      case 'lepasWallet': {
        const r = await this.api('POST', '/api/settings/wallet/remove', { confirm: text.trim().toLowerCase() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'wb', '✅ Wallet dilepas (kunci dicadangkan).\n\n');
      }
      case 'ntfy': {
        const r = await this.api('POST', '/api/settings/notify', { ntfy_topic: text.trim() === '-' ? '' : text.trim() });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'sn', '✅ Tersimpan.\n\n');
      }
      case 'rpcTambah': {
        const st = await this.api('GET', '/api/settings');
        const list = [...st.rpc.map((e) => ({ id: e.id })), { url: text.trim() }];
        const r = await this.api('POST', '/api/settings/rpc', { endpoints: list });
        if (r.error) throw new Error(r.error);
        return this.screen(chatId, null, 'sr', '✅ Endpoint ditambahkan.\n\n');
      }
      case 'poolCari': return this.screen(chatId, null, `mlp:0:${encodeURIComponent(text.trim().slice(0, 24))}`);
      case 'scanToken': return this.runScanPool(chatId, text);
      case 'lpUsd': {
        const n = Number(String(text).replace(/[$\s]/g, '').replace(',', '.'));
        if (!Number.isFinite(n) || n <= 0) throw new Error('nominal harus angka lebih dari nol');
        const se = this.sess(chatId);
        se.lp = { ...(se.lp || { lowerPct: 25, upperPct: 25 }), usd: n };
        return this.screen(chatId, null, se.lpAsal === 'qk' ? 'qk' : 'ml', `✅ Nominal $${nf(n, 2)}\n\n`);
      }
      case 'lpWidth': {
        const r = parseRentang(text);
        if (r.error) throw new Error(r.error);
        const se = this.sess(chatId);
        se.lp = { ...(se.lp || {}), lowerPct: r.lowerPct, upperPct: r.upperPct, widthPct: undefined, full: false };
        return this.screen(chatId, null, se.lpAsal === 'qk' ? 'qk' : 'ml', `✅ Rentang ${rentangTeks(se.lp)}\n\n`);
      }
      case 'swAmount': {
        const se = this.sess(chatId);
        se.sw = { ...(se.sw || {}), amount: String(text).trim() };
        return this.screen(chatId, null, 'swq');
      }
      case 'rule': {
        const grp = RULE_GROUPS[p.gi], spec = grp.fields[p.fi];
        const val = parseVal(spec, text);
        await this.writeRule(chatId, grp.g, spec.k, val);
        return this.screen(chatId, null, `r:${p.gi}`, `✅ <b>${esc(spec.label)}</b> → ${esc(showVal(spec, val))}\n\n`);
      }
      case 'form': {
        const f = FORMS[p.form], spec = f.fields[p.fi];
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
      return { scope: 'g', label: 'semua target', raw: r.raw || {}, resolved: r.rules };
    }
    const t = (await this.api('GET', '/api/targets')).targets.find((x) => x.address === s.scope);
    if (!t) { s.scope = 'g'; return this.readRules(chatId); }
    return { scope: t.address, label: t.label || shortA(t.address), raw: t.rulesOwn || {}, resolved: t.rulesResolved };
  }
  resolvedRule(resolved, g, k) { return resolved?.[g]?.[k]; }
  async writeRule(chatId, g, k, v) {
    const cur = await this.readRules(chatId);
    const raw = dset({ ...cur.raw }, g, k, v);
    if (cur.scope === 'g') await this.api('POST', '/api/rules', { rules: raw });
    else await this.api('POST', '/api/targets/rules', { address: cur.scope, rules: raw });
  }
  async clearRule(chatId, g, k) {
    const cur = await this.readRules(chatId);
    if (cur.scope === 'g') return;                  // di tingkat global tidak ada yang bisa dilepas
    const raw = ddel(JSON.parse(JSON.stringify(cur.raw)), g, k);
    await this.api('POST', '/api/targets/rules', { address: cur.scope, rules: Object.keys(raw).length ? raw : null });
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
  modeTag() { return this.engine.dryRun() ? '🧪 SIMULASI' : '🟢 LIVE'; }

  kartuMasuk(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : (d.pair || '?');
    const venue = p?.venue ? esc(p.venue) : null;
    const fee = p?.fee != null ? `fee ${trimZ(nf(p.fee / 10000, 2))}%` : null;
    const nilai = d.valueUsd ?? p?.costUsd;
    const L = [
      `${d.adding ? '➕ <b>LP DITAMBAH</b>' : '🟢 <b>LP DISALIN</b>'} · ${this.modeTag()}`,
      `<b>${esc(pair)}</b>${[venue, fee].filter(Boolean).map((x) => ` · ${x}`).join('')}`,
      '',
      `💰 ${d.adding ? 'Ditambah' : 'Modal masuk'} <b>${usd(nilai)}</b>${d.adding && p?.costUsd != null ? ` · total modal ${usd(p.costUsd)}` : ''}`,
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
      ['📝', d.reason ? esc(d.reason) : null],
      ['⚙️', d.steps?.length ? esc(d.steps.join(' · ')) : null],
      [null, this.txBaris(d.txHash)],
    ].filter(([, v]) => v).map(([ic, v]) => (ic ? `${ic} ${v}` : v));
    if (jejak.length) { L.push(''); L.push(...jejak); }
    L.push(`<i>posisi #${esc(d.positionId)}${p?.token_id ? ` · NFT #${esc(p.token_id)}` : ''}</i>`);
    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn('💼 Lihat posisi', `p:${d.positionId}`), btn('🔴 Tutup', `pc:${d.positionId}`)],
      [btn('💼 Semua posisi', 'p'), BACK_HOME],
    ])];
  }

  kartuKeluar(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : `posisi #${d.positionId}`;
    const pnl = p?.pnlUsd;
    const judul = d.auto ? '🛡 <b>KELUAR MANDIRI</b>' : d.full ? '🔴 <b>LP DITUTUP</b>' : '➖ <b>LP DIKURANGI</b>';
    const lama = p?.ageHours > 0 ? ` · dipegang ${esc(dur(p.ageHours * 3600))}` : '';
    const L = [
      `${judul} · ${this.modeTag()}`,
      `<b>${esc(pair)}</b>${p?.token_id ? ` · NFT #${esc(p.token_id)}` : ''}${lama}`,
      '',
    ];
    if (d.full && p?.empty) {
      // Hasil bersih ditaruh di luar tabel supaya bisa ditebalkan.
      L.push(`${pnl >= 0 ? '📈 Untung' : '📉 Rugi'} <b>${sgn(pnl)}</b>  ${pct(p.pnlPct)}`);
      L.push(angka([
        ['hasil', usd(p.outUsd ?? p.valueUsd)],
        ['modal', usd(p.costUsd)],
      ]));
    } else if (p) {
      // Tutup sebagian: nilai yang tersisa baru akurat setelah sinkron berikutnya.
      L.push(angka([['modal awal', usd(p.costUsd)]]));
    }
    const jejak = [
      ['📝', d.reason ? esc(d.reason) : null],
      ['🧹', d.sold ? esc(d.sold) : null],
      ['🎯', this.targetBaris(d, p)],
      [null, this.txBaris(d.txHash)],
    ].filter(([, v]) => v).map(([ic, v]) => (ic ? `${ic} ${v}` : v));
    if (jejak.length) { if (L[L.length - 1] !== '') L.push(''); L.push(...jejak); }
    L.push(`<i>posisi #${esc(d.positionId)}</i>`);
    const rows = d.full
      ? [[btn('💼 Posisi', 'p'), btn('💵 Saldo', 'b')], [btn('📜 Aktivitas', 'a:0'), BACK_HOME]]
      : [[btn('💼 Lihat posisi', `p:${d.positionId}`), btn('💵 Saldo', 'b')], [BACK_HOME]];
    return [cut(L.filter((x) => x != null).join('\n')), kb(rows)];
  }

  kartuSisa(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : `posisi #${d.positionId}`;
    const selisih = d.usdIn > 0 && d.usdOut != null ? ((d.usdOut - d.usdIn) / d.usdIn) * 100 : null;
    const L = [
      `🧹 <b>SISA TERJUAL</b> · ${this.modeTag()}`,
      `<b>${esc(pair)}</b> · posisi #${esc(d.positionId)}`,
      '',
      `💰 Diterima <b>${usd(d.usdOut)}</b> dari ${esc(d.label || '?')}`,
      angka([
        ['nilai token', usd(d.usdIn)],
        ['diterima', usd(d.usdOut)],
        ['selisih', selisih != null ? pct(selisih) : null],
        ['lewat', d.dex || null],
        ['percobaan', d.tries ? `ke-${d.tries + 1}` : null],
      ]),
      this.txBaris(d.txHash),
    ];
    return [cut(L.filter((x) => x != null).join('\n')), kb([[btn('🧹 Sisa jual', 'f'), btn('💵 Saldo', 'b')], [BACK_HOME]])];
  }

  // Memecoin sisa yang DITOLAK dijual: uangnya tersangkut di wallet sampai rutenya
  // membaik atau pengguna turun tangan. Sengaja mencolok — ini satu-satunya kabar
  // yang butuh keputusan orang, bukan sekadar laporan.
  kartuSisaMacet(d, p) {
    const pair = p ? `${p.symbol0}/${p.symbol1}` : `posisi #${d.positionId}`;
    const rugi = d.lossBps != null ? `${nf(d.lossBps / 100, 1)}%` : null;
    const batas = d.maxLossBps != null ? `${nf(d.maxLossBps / 100, 1)}%` : null;
    const L = [
      `🚨🚨 <b>SISA BELUM TERJUAL</b> · ${this.modeTag()}`,
      `<b>${esc(pair)}</b> · posisi #${esc(d.positionId)}`,
      '',
      `⚠️ <b>${esc(d.label || '?')}</b> masih tersangkut di wallet${d.reminder && d.since ? ` sejak ${esc(ago(d.since))}` : ''}.`,
      rugi ? `Bot menolak menjual: rutenya rugi <b>${rugi}</b>${batas ? ` (batas ${batas})` : ''}.` : `Bot belum bisa menjual: <i>${esc(d.why || '?')}</i>`,
      '',
      angka([
        ['nilai token', usd(d.usdIn)],
        ['bisa ditarik', usd(d.usdOut)],
        ['rugi rute', rugi],
        ['batas aturan', batas],
        ['sudah dicoba', d.tries ? `${num(d.tries)}×` : null],
      ]),
      `🔁 Dikutip ulang <b>tiap ${esc(String(d.retrySec || 5))} dtk</b> — begitu ruginya turun ke bawah batas, langsung dijual.`,
      '',
      '<b>Pilihan:</b> tunggu likuiditas pulih, jual bertahap lewat Swap (porsi kecil = dampak harga kecil), atau naikkan batas rugi di Aturan → Keluar posisi.',
    ];
    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn('🔁 Coba jual sekarang', 'fr'), btn('🔁 Swap manual', 'sw')],
      [btn('🧹 Antrean sisa', 'f'), btn('⚙️ Aturan', 'r')],
      [BACK_HOME],
    ])];
  }

  // ---- layar ---------------------------------------------------------------
  // Kesehatan mesin dalam satu baris: yang pertama bermasalah yang disebut, supaya
  // tidak perlu membaca tabel pemantauan untuk tahu apakah bot baik-baik saja.
  kesehatan(o) {
    const macet = o.lastSync && Date.now() - o.lastSync > 3 * 60_000;
    const rpcIstirahat = (o.rpc || []).filter((r) => r.cooling).length;
    if (o.mode.paused) return '⏸ <b>Dijeda</b> — aksi target tidak disalin';
    if (o.chain.lag > 30) return `⚠️ <b>Tertinggal ${num(o.chain.lag)} blok</b> — aksi target terlambat terbaca`;
    if (macet) return `⚠️ <b>Sinkron posisi macet</b> — terakhir ${esc(ago(o.lastSync))}`;
    if (rpcIstirahat) return `⚠️ <b>${rpcIstirahat} RPC istirahat</b> — memakai cadangan`;
    return `✅ Sehat · blok ${num(o.chain.head)}${o.chain.lag ? ` · tertinggal ${num(o.chain.lag)}` : ''}`;
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
    const mode = o.mode.dry_run ? '🧪 SIMULASI' : '🟢 LIVE';
    const s = o.summary;
    const pnl = s.realizedUsd + s.unrealizedUsd;
    const text = [
      `<b>Quiver</b> · ${mode}`,
      `<code>${esc(shortA(o.mode.wallet))}</code>`,
      this.kesehatan(o),
      '',
      pf?.now?.cash ? `💰 Portofolio <b>${usd(pf.now.value)}</b>` : null,
      `📈 PnL <b>${sgn(pnl)}</b>${pf?.delta24 != null ? ` · 24 jam ${sgn(pf.delta24)}` : ''}`,
      `💼 ${s.openCount} posisi · ${usd(s.exposureUsd)}${s.openCount ? ` · ${s.inRange}/${s.openCount} in-range` : ''}`,
      '',
      '💡 <i>Tempel alamat token untuk langsung pasang LP.</i>',
    ].filter((x) => x != null).join('\n');
    return [text, kb([
      [btn('📊 Ringkasan', 'o'), btn('💼 Posisi', 'p')],
      [btn('🎯 Target', 't'), btn('📜 Aktivitas', 'a:0')],
      [btn('⚙️ Aturan salin', 'r'), btn('🔧 Pengaturan', 's')],
      [btn('➕ LP manual', 'ml'), btn('🔁 Swap', 'sw')],
      [btn('🔎 Riset wallet', 'w'), btn('🔭 Scout', 'k')],
      [btn('🧹 Sisa jual', 'f'), btn('💵 Saldo', 'b')],
      [btn('📝 Log', 'l'), btn('🧾 Transaksi', 'x')],
      [btn(o.mode.paused ? '▶️ Lanjutkan' : '⏸ Jeda', 'sp'), btn('🔄 Segarkan', 'h')],
    ])];
  }

  async overview() {
    const [o, pf, pos] = await Promise.all([
      this.api('GET', '/api/overview'), this.porto24(),
      this.api('GET', '/api/positions').catch(() => ({ positions: [] })),
    ]);
    const s = o.summary, t = o.totals, now = pf?.now, st = pf?.stats;
    const pnl = s.realizedUsd + s.unrealizedUsd;
    const pnlPct = now?.capital > 0 ? (pnl / now.capital) * 100 : null;
    const L = [
      `📊 <b>Ringkasan</b> · ${o.mode.dry_run ? '🧪 SIMULASI' : '🟢 LIVE'}`,
      `<code>${esc(shortA(o.mode.wallet))}</code> · sinkron ${esc(ago(o.lastSync))}`,
      this.kesehatan(o),
      '',
    ];

    // 1. Uang: angka terbesar di atas, tebal; rinciannya di tabel yang lurus.
    if (now?.cash) L.push(`💰 Portofolio <b>${usd(now.value)}</b>`);
    L.push(`${pnl >= 0 ? '📈' : '📉'} PnL <b>${sgn(pnl)}</b>${pnlPct != null ? ` ${pct(pnlPct)}` : ''}${pf?.delta24 != null ? ` · 24 jam ${sgn(pf.delta24)}` : ''}`);
    L.push(angka([
      ['kas wallet', now?.cash ? usd(now.cash.usd) : null],
      ['dalam posisi', usd(s.exposureUsd)],
      ['fee belum diklaim', usd(s.feeUsd)],
      ['modal posisi', usd(s.costUsd)],
      ['belum terealisasi', sgn(s.unrealizedUsd)],
      ['sudah terealisasi', sgn(s.realizedUsd)],
    ]));

    // 2. Posisi terbuka, terbesar dulu.
    const open = (pos.positions || []).filter((p) => !p.empty).sort((a, b) => (b.valueUsd || 0) - (a.valueUsd || 0));
    L.push('');
    L.push(`<b>💼 Posisi terbuka · ${open.length}</b>${open.length ? `  🟢 ${s.inRange} in · 🟡 ${open.length - s.inRange} luar` : ''}`);
    if (open.length) {
      L.push(kolom(open.slice(0, 6).map((p) => [
        `${p.symbol0}/${p.symbol1}`.slice(0, 14), usd(p.valueUsd), sgn(p.pnlUsd), p.inRange ? 'in' : 'luar',
      ]), 'lrrl'));
      if (open.length > 6) L.push(`<i>+${open.length - 6} posisi lainnya</i>`);
    } else L.push('<i>Belum ada posisi terbuka.</i>');

    // 3. Rekam jejak posisi yang sudah ditutup.
    if (st?.closedCount) {
      L.push('');
      L.push(`<b>🏆 Rekam jejak · ${num(st.closedCount)} ditutup</b>`);
      L.push(angka([
        ['menang / kalah', `${st.wins} / ${st.losses}`],
        ['win rate', pct(st.winRatePct, 0).replace('+', '')],
        ['rata-rata', sgn(st.avgPnl)],
        ['terbaik', sgn(st.best)],
        ['terburuk', sgn(st.worst)],
        ['rata-rata dipegang', st.avgHoldHours != null ? dur(st.avgHoldHours * 3600) : null],
      ]));
    }

    // 4. Per sumber: target mana yang menghasilkan.
    const src = (pf?.byTarget || []).filter((g) => g.open || g.closed).slice(0, 5);
    if (src.length) {
      L.push('');
      L.push('<b>🎯 Per sumber</b>');
      L.push(kolom(src.map((g) => [
        (g.label || (g.target ? shortA(g.target) : 'manual')).slice(0, 14),
        `${g.open} buka`, sgn(g.realized + g.upnl),
      ]), 'lrr'));
    }

    // 5. Mesin penyalin.
    L.push('');
    L.push('<b>🛰 Penyalinan</b>');
    L.push(angka([
      ['aksi target terpantau', num(t.actions)],
      [o.mode.dry_run ? 'akan disalin (simulasi)' : 'disalin', num(o.mode.dry_run ? t.would : t.copied)],
      ['dilewat', num(t.skipped)],
      ['galat', t.errors ? num(t.errors) : null],
    ]));
    if (o.skipReasons?.length) {
      L.push('<i>Alasan terbanyak dilewat:</i>');
      L.push(kolom(o.skipReasons.slice(0, 3).map((r) => [`${r.n}×`, String(r.reason).slice(0, 38)]), 'r'));
    }
    if ((o.rpc || []).some((r) => r.errors)) {
      L.push('<i>RPC bermasalah:</i>');
      L.push(kolom(o.rpc.filter((r) => r.errors).map((r) => [hostOf(r.url), `${num(r.errors)} galat`, r.cooling ? 'istirahat' : '']), 'lrl'));
    }
    L.push('');
    L.push(`<i>ETH ${usd(o.chain.ethUsd, 0)} · jalan ${esc(dur(o.stats.uptimeSec))}</i>`);
    if (o.stats.lastError) L.push(`⛔ Galat terakhir: <code>${esc(String(o.stats.lastError).slice(0, 200))}</code>`);

    return [cut(L.filter((x) => x != null).join('\n')), kb([
      [btn('💼 Posisi', 'p'), btn('🎯 Target', 't')],
      [btn('📜 Aktivitas', 'a:0'), btn('💵 Saldo', 'b')],
      [btn('🔄 Segarkan', 'o'), BACK_HOME],
    ])];
  }

  async saldo() {
    const st = await this.api('GET', '/api/settings');
    const b = st.wallet.balances;
    const o = await this.api('GET', '/api/overview');
    const L = [
      '<b>💵 Saldo wallet bot</b>',
      `<code>${esc(st.wallet.address || '(belum ada wallet)')}</code>`,
      '',
      '<b>Di wallet</b>',
      b ? angka([['ETH', tok(b.eth)], ['USDG', tok(b.usdg, 2)], ['WETH', tok(b.weth)]])
        : 'Saldo tidak terbaca sekarang (RPC sedang sibuk).',
      '<b>Di dalam posisi</b>',
      tabel([
        ['nilai', `${usd(o.summary.exposureUsd)} · ${o.summary.openCount} posisi`],
        ['fee belum diklaim', usd(o.summary.feeUsd)],
      ]),
    ];
    return [L.filter((x) => x != null).join('\n'), kb([[btn('🔄 Segarkan', 'b'), btn('💼 Posisi', 'p')], [BACK_HOME]])];
  }

  async posisi() {
    const d = await this.api('GET', '/api/positions');
    const open = (d.positions || []).filter((p) => !p.empty);
    const tot = open.reduce((a, p) => ({ v: a.v + (p.valueUsd || 0), f: a.f + (p.feeUsd || 0), p: a.p + (p.pnlUsd || 0) }), { v: 0, f: 0, p: 0 });
    const L = [`<b>💼 Posisi terbuka — ${open.length}</b>`];
    if (!open.length) L.push('\nBelum ada posisi terbuka.');
    else {
      L.push(`${usd(tot.v)} · fee ${usd(tot.f)} · <b>${sgn(tot.p)}</b>`);
      // Emoji sengaja TIDAK masuk blok monospace: lebarnya tidak satu karakter dan
      // merusak kelurusan kolom. Statusnya ditulis sebagai kata.
      L.push(kolom(open.map((p) => [
        `${p.symbol0}/${p.symbol1}`, usd(p.valueUsd), sgn(p.pnlUsd), p.inRange ? 'in' : 'luar',
      ]), 'lrr'));
    }
    const rows = open.map((p) => [btn(`${p.inRange ? '🟢' : '🟡'} ${p.symbol0}/${p.symbol1}  ${usd(p.valueUsd)}`, `p:${p.id}`)]);
    const closed = (d.closed || []).slice(0, 6);
    if (closed.length) {
      L.push('<b>Terakhir ditutup</b>');
      L.push(kolom(closed.map((c) => {
        const pnl = (c.out_quote || 0) - (c.cost_quote || 0);
        return [`#${c.token_id}`, sgn(pnl), ago(c.closed_ts)];
      }), 'lr'));
    }
    return [L.filter((x) => x != null).join('\n'), kb([...rows, [btn('🔄 Segarkan', 'p'), BACK_HOME]])];
  }

  async posisiDetail(id) {
    const d = await this.api('GET', '/api/positions');
    const p = (d.positions || []).find((x) => String(x.id) === String(id));
    if (!p) return [`Posisi #${esc(id)} tidak ada di daftar terbuka.`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]])];
    const r = rentang(p);
    const L = [
      `<b>${esc(p.symbol0)}/${esc(p.symbol1)}</b>  <code>#${esc(p.token_id)}</code>`,
      `${p.inRange ? '🟢 in-range' : '🟡 di luar rentang'} · ${esc(p.venue)} · fee ${p.fee != null ? trimZ(nf(p.fee / 10000, 2)) + '%' : '—'} · ${esc(dur(p.ageHours * 3600))}`,
      '',
      // Angka yang paling dicari ditaruh di luar tabel supaya bisa ditebalkan:
      // isi blok <pre> selalu polos.
      `<b>${sgn(p.pnlUsd)}</b>  ${pct(p.pnlPct)}`,
      angka([
        ['nilai', usd(p.valueUsd)],
        ['modal', usd(p.costUsd)],
        ['fee belum diklaim', usd(p.feeUsd)],
        ['IL vs HODL', p.ilUsd != null ? sgn(p.ilUsd) : null],
      ]),
    ];
    if (r) {
      L.push(`<b>${esc(r.judul)}</b>`);
      L.push(r.bar);
      L.push(r.kini ? `${esc(r.kini)}${r.ket ? ` — ${esc(r.ket)}` : ''}` : (r.ket ? esc(r.ket) : null));
    }
    const jejak = tabel([
      ['posisi', `#${p.id}`],
      ['cermin dari', p.target ? `${shortA(p.target)} #${p.mirror_of || '—'}` : null],
      ['tx buka', p.tx_open ? shortH(p.tx_open) : null],
    ]);
    if (jejak) { L.push(''); L.push(jejak); }
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn('🔴 Tutup posisi ini', `pc:${p.id}`)],
      [btn('↩︎ Posisi', 'p'), BACK_HOME],
    ])];
  }

  async tutupKonfirm(id) {
    const d = await this.api('GET', '/api/positions');
    const p = (d.positions || []).find((x) => String(x.id) === String(id));
    const live = !this.engine.dryRun();
    const L = [`🔴 <b>Tutup posisi #${esc(id)}?</b>`];
    if (p) L.push(`${esc(p.symbol0)}/${esc(p.symbol1)} · nilai ${usd(p.valueUsd)} · ${sgn(p.pnlUsd)}`);
    L.push('');
    L.push(live
      ? 'Likuiditas ditarik penuh dan transaksi dikirim sungguhan. Memecoin sisa akan dijual otomatis kalau aturan itu menyala.'
      : '⚠️ Bot sedang di mode <b>simulasi</b> — perintah ini akan ditolak.');
    return [L.join('\n'), kb([[btn('✅ Ya, tutup sekarang', `pC:${id}`)], [btn('↩︎ Batal', `p:${id}`)]])];
  }

  async targets() {
    const d = await this.api('GET', '/api/targets');
    const L = [`<b>🎯 Target (${d.targets.length})</b>`];
    for (const t of d.targets) {
      L.push('');
      L.push(`${t.enabled ? '🟢' : '⚪️'} <b>${esc(t.label || shortA(t.address))}</b>`);
      L.push(`  <code>${esc(shortA(t.address))}</code> · ${num(t.actions)} aksi · ${num(t.copied)} disalin`);
      L.push(`  posisi kita: ${t.openPositions} (${usd(t.openCostQuote)})${t.lastActionTs ? ` · aksi terakhir ${ago(t.lastActionTs)}` : ''}`);
    }
    if (!d.targets.length) L.push('\nBelum ada target. Tambahkan satu wallet untuk mulai mengikuti.');
    const rows = d.targets.map((t) => [
      btn(`${t.enabled ? '🟢' : '⚪️'} ${(t.label || shortA(t.address)).slice(0, 24)}`, `t:${t.address}`),
    ]);
    return [L.join('\n'), kb([...rows, [btn('➕ Tambah target', 'ta')], [btn('🔄 Segarkan', 't'), BACK_HOME]])];
  }

  async targetDetail(addr) {
    const d = await this.api('GET', '/api/targets');
    const t = d.targets.find((x) => x.address === addr);
    if (!t) return [`Target <code>${esc(addr)}</code> tidak ditemukan.`, kb([[btn('↩︎ Target', 't'), BACK_HOME]])];
    const r = t.rulesResolved;
    const L = [
      `${t.enabled ? '🟢' : '⚪️'} <b>${esc(t.label || 'tanpa nama')}</b>${t.enabled ? '' : ' — nonaktif'}`,
      `<code>${esc(t.address)}</code>`,
      '',
      tabel([
        ['aksi terpantau', `${num(t.actions)}${t.lastActionTs ? ` · terakhir ${ago(t.lastActionTs)}` : ''}`],
        ['disalin', num(t.copied)],
        ['posisi kita', `${t.openPositions} · modal ${usd(t.openCostQuote)}`],
      ]),
      `<b>Aturan yang berlaku</b> <i>${t.rulesOwn ? '(ada penyesuaian khusus)' : '(ikut aturan umum)'}</i>`,
      tabel([
        ['cara ukuran', showVal(RULE_GROUPS[0].fields[0], r.sizing.mode)],
        ['batas per posisi', usd(r.sizing.max_quote_per_position_usd, 0)],
        ['batas total', usd(r.sizing.max_total_exposure_usd, 0)],
        ['anggaran harian', usd(r.sizing.daily_budget_usd, 0)],
        ['abaikan aksi di bawah', usd(r.filters.min_target_quote_usd, 0)],
        ['maks posisi terbuka', r.filters.max_open_positions],
      ]),
    ];
    if (t.research) {
      const s = t.research;
      L.push(`<b>Riset wallet</b> <i>(${esc(ago(s.lastScanTs))})</i>`);
      L.push(angka([
        ['posisi terbaca', s.positionsN != null ? num(s.positionsN) : null],
        ['menang', s.winRatePct != null ? `${nf(s.winRatePct, 0)}%` : null],
        ['PnL', s.pnlUsd != null ? sgn(s.pnlUsd) : null],
      ]));
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(t.enabled ? '⚪️ Matikan' : '🟢 Nyalakan', `tt:${t.address}`)],
      [btn('⚙️ Aturan khusus', `ts:${t.address}`), btn('✏️ Ganti nama', `tn:${t.address}`)],
      [btn('🔎 Riset wallet', `tw:${t.address}`), btn('🔄 Perbarui riset', `tr:${t.address}`)],
      [btn('🗑 Hapus target', `td:${t.address}`)],
      [btn('↩︎ Target', 't'), BACK_HOME],
    ])];
  }

  async aktivitas(off = 0) {
    const d = await this.api('GET', '/api/activity', {}, { limit: 60 });
    const rows = d.activity.slice(off, off + 10);
    const icon = { copy: '✅', dry: '🧪', skip: '⏭', error: '⛔' };
    const L = [`<b>📜 Aktivitas target</b> <i>(${off + 1}–${off + rows.length} dari ${d.activity.length})</i>`];
    for (const a of rows) {
      const pair = a.symbol0 && a.symbol1 ? `${a.symbol0}/${a.symbol1}` : (a.pool_ref ? shortA(a.pool_ref) : '—');
      L.push('');
      L.push(`${icon[a.verdict] || '•'} <b>${esc(a.kind)}</b> ${esc(pair)} · ${esc(a.targetLabel || shortA(a.target))}`);
      L.push(`  ${a.value_quote ? `${nf(a.value_quote, 2)} ${esc(a.quote_symbol || '')} · ` : ''}${ago(a.ts)}`);
      if (a.reason) L.push(`  <i>${esc(a.reason)}</i>`);
      if (a.decision_tx) L.push(`  tx <code>${esc(shortH(a.decision_tx))}</code>`);
    }
    if (!rows.length) L.push('\nBelum ada aksi terpantau.');
    const nav = [];
    if (off > 0) nav.push(btn('⬅️ Baru', `a:${Math.max(0, off - 10)}`));
    if (off + 10 < d.activity.length) nav.push(btn('Lama ➡️', `a:${off + 10}`));
    return [L.join('\n'), kb([nav.length ? nav : null, [btn('🔄 Segarkan', `a:${off}`), BACK_HOME]])];
  }

  async logs() {
    const d = await this.api('GET', '/api/logs');
    const icon = { error: '⛔', warn: '⚠️', info: 'ℹ️' };
    const L = ['<b>📝 Catatan terakhir</b>', ''];
    for (const r of d.logs.slice(0, 25)) L.push(`${icon[r.level] || '•'} <i>${esc(ago(r.ts))}</i> ${esc(r.msg)}`);
    if (!d.logs.length) L.push('(kosong)');
    return [L.join('\n'), kb([[btn('🔄 Segarkan', 'l'), BACK_HOME]])];
  }

  async txs() {
    const d = await this.api('GET', '/api/txs');
    const L = ['<b>🧾 Transaksi terakhir</b>', ''];
    for (const t of d.txs.slice(0, 20)) {
      L.push(`${t.status === 'ok' ? '✅' : t.status === 'error' ? '⛔' : '⏳'} <b>${esc(t.kind)}</b> · ${esc(ago(t.ts))}`);
      L.push(`  <code>${esc(shortH(t.hash))}</code>${t.gas_quote ? ` · gas ${usd(t.gas_quote, 4)}` : ''}`);
      if (t.error) L.push(`  <i>${esc(String(t.error).slice(0, 120))}</i>`);
    }
    if (!d.txs.length) L.push('(belum ada)');
    return [L.join('\n'), kb([[btn('🔄 Segarkan', 'x'), BACK_HOME]])];
  }

  // ---- aturan --------------------------------------------------------------
  async rulesMenu(chatId) {
    const cur = await this.readRules(chatId);
    const L = [
      `<b>⚙️ Aturan salin</b>`,
      `Berlaku untuk: <b>${esc(cur.scope === 'g' ? 'semua target' : cur.label)}</b>`,
      '',
      cur.scope === 'g'
        ? 'Ini aturan umum. Tiap target bisa punya penyesuaian sendiri lewat halaman targetnya.'
        : 'Kolom bertanda • disesuaikan khusus untuk target ini; sisanya ikut aturan umum.',
      '',
      'Pilih kelompok:',
    ];
    const rows = RULE_GROUPS.map((g, i) => {
      const n = Object.keys(cur.raw[g.g] || {}).length;
      return [btn(`${g.title}${cur.scope !== 'g' && n ? ` (${n}•)` : ''}`, `r:${i}`)];
    });
    if (cur.scope !== 'g') rows.push([btn('🌐 Ke aturan umum', 'rg')]);
    return [L.join('\n'), kb([...rows, [BACK_HOME]])];
  }

  async rulesGroup(chatId, gi) {
    const grp = RULE_GROUPS[gi];
    const cur = await this.readRules(chatId);
    const L = [`<b>${esc(grp.title)}</b> — ${esc(cur.scope === 'g' ? 'semua target' : cur.label)}`, ''];
    const rows = [];
    grp.fields.forEach((spec, fi) => {
      const v = this.resolvedRule(cur.resolved, grp.g, spec.k);
      const own = dget(cur.raw, grp.g, spec.k) !== undefined;
      // Sebagian aturan cuma berlaku pada mode tertentu (mis. "Persen dari target"
      // hanya dipakai kalau caranya memang persen). Kolomnya tetap ditampilkan dan
      // tetap bisa diubah — cuma diberi tanda, karena tombol yang hilang-muncul
      // sendiri lebih membingungkan daripada satu baris keterangan.
      const inert = spec.when && !spec.when(cur.resolved);
      L.push(`${own && cur.scope !== 'g' ? '• ' : ''}<b>${esc(spec.label)}</b>: ${esc(showVal(spec, v))}${inert ? ' <i>· tidak dipakai di mode ini</i>' : ''}`);
      if (spec.type === 'bool') rows.push([btn(`${v ? '✅' : '❌'} ${spec.label}`.slice(0, 40), `rb:${gi}:${fi}`)]);
      else if (spec.type === 'pilih') rows.push([btn(`✏️ ${spec.label}`.slice(0, 40), `rp:${gi}:${fi}`)]);
      else rows.push([btn(`✏️ ${spec.label}`.slice(0, 40), `re:${gi}:${fi}`)]);
      if (own && cur.scope !== 'g') rows[rows.length - 1].push(btn('↺', `rx:${gi}:${fi}`));
    });
    return [L.join('\n'), kb([...rows, [btn('↩︎ Aturan', 'r'), BACK_HOME]])];
  }

  // ---- pengaturan ----------------------------------------------------------
  async settings() {
    const st = await this.api('GET', '/api/settings');
    const L = [
      '<b>🔧 Pengaturan</b>',
      '',
      `Mode: <b>${st.mode.dry_run ? '🧪 SIMULASI' : '🟢 LIVE'}</b>${st.mode.paused ? ' · ⏸ dijeda' : ''}`,
      `Wallet: <code>${esc(st.wallet.address || '(belum ada)')}</code>`,
      `RPC: ${st.rpc.length} endpoint`,
      `Gas: pengali ${nf(st.gas.price_multiplier, 2)} · cadangan ${nf(st.gas.reserve_eth, 4)} ETH`,
      `Mesin: pindai tiap ${num(st.loop.poll_ms)} ms · sinkron ${num(st.loop.sync_seconds)} dtk`,
      `Notifikasi: ntfy ${st.notify.ntfy_topic ? `<code>${esc(st.notify.ntfy_topic)}</code>` : 'mati'} · Telegram ${this.chats().length} chat`,
    ];
    return [L.join('\n'), kb([
      [btn(st.mode.dry_run ? '🟢 Nyalakan LIVE' : '🧪 Kembali ke simulasi', 'sl')],
      [btn(st.mode.paused ? '▶️ Lanjutkan' : '⏸ Jeda penyalinan', 'sp')],
      [btn('🔑 Wallet bot', 'wb'), btn('🌐 RPC', 'sr')],
      [btn('⛽ Gas', 'sf:gas'), btn('🔧 Mesin', 'sf:mesin')],
      [btn('🔔 Notifikasi', 'sn'), btn('💬 Chat Telegram', 'sc')],
      [btn('🔐 Ganti token dasbor', 'sk')],
      [btn('🔄 Segarkan', 's'), BACK_HOME],
    ])];
  }

  async setPause(chatId, msgId, paused, ack = null) {
    await this.api('POST', '/api/mode', { paused });
    if (ack) await ack(paused ? 'Penyalinan dijeda' : 'Penyalinan dilanjutkan');
    const note = paused
      ? '⏸ <b>Penyalinan dijeda.</b> Aksi target tetap dipantau dan dicatat, tapi tidak ada transaksi baru. Posisi yang sudah terbuka tetap dipantau untuk keluar.\n\n'
      : '▶️ <b>Penyalinan dilanjutkan.</b>\n\n';
    return this.screen(chatId, msgId, msgId ? 's' : 'h', note);
  }

  async walletScreen() {
    const st = await this.api('GET', '/api/settings');
    const w = st.wallet, b = w.balances;
    const L = [
      '<b>🔑 Wallet bot</b>',
      `<code>${esc(w.address || '(belum ada wallet)')}</code>`,
      '',
      tabel([
        ['berkas kunci', w.keyFile],
        ['izin berkas', w.hasKey ? `${w.perms || '?'}${w.perms === '600' ? ' · aman' : ' · terlalu longgar'}` : 'belum ada'],
        ['cadangan kunci', `${w.backups} berkas`],
        ['ETH', b ? tok(b.eth) : null],
        ['USDG', b ? tok(b.usdg, 2) : null],
        ['WETH', b ? tok(b.weth) : null],
      ]),
      '<i>Impor kunci privat lewat Telegram sengaja tidak disediakan — riwayat chat tersimpan di server Telegram. Pakai dasbor untuk itu.</i>',
    ];
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn('🆕 Buat wallet baru', 'wbg')],
      [btn('🗑 Lepas wallet', 'wbr')],
      [btn('↩︎ Pengaturan', 's'), BACK_HOME],
    ])];
  }

  async rpcScreen() {
    const st = await this.api('GET', '/api/settings');
    const L = ['<b>🌐 Endpoint RPC</b>', ''];
    st.rpc.forEach((e) => {
      L.push(`<b>${e.id + 1}. ${esc(e.host || hostOf(e.url))}</b>${e.secret ? ' 🔐' : ''}${e.cooling ? ' ❄️ istirahat' : ''}`);
      const tag = [e.no_logs ? 'tanpa getLogs' : null, e.max_log_blocks ? `getLogs ≤ ${num(e.max_log_blocks)} blok` : null, e.archive ? 'arsip' : null].filter(Boolean);
      L.push(`   ${num(e.calls)} panggilan · ${num(e.errors)} galat · ${num(e.lastMs)} ms${tag.length ? ` · ${esc(tag.join(', '))}` : ''}`);
    });
    const rows = st.rpc.map((e) => [btn(`🔬 Uji ${e.host}`.slice(0, 30), `sr:${e.id}`), btn('🗑', `srd:${e.id}`)]);
    return [L.join('\n'), kb([...rows, [btn('➕ Tambah endpoint', 'sra')], [btn('↩︎ Pengaturan', 's'), BACK_HOME]])];
  }

  async rpcTest(id) {
    const r = await this.api('POST', '/api/settings/rpc/test', { id });
    if (r.error) return [`❌ ${esc(r.error)}`, kb([[btn('↩︎ RPC', 'sr')]])];
    const L = [
      `<b>🔬 ${esc(r.url)}</b>`, '',
      `${r.usable ? '✅' : '⛔'} ${esc(r.summary)}`,
    ];
    if (r.suggest) {
      L.push('');
      L.push('<b>Bendera yang cocok</b>');
      L.push(`• tanpa getLogs: ${r.suggest.no_logs ? 'ya' : 'tidak'}`);
      L.push(`• batas blok getLogs: ${r.suggest.max_log_blocks || 'tanpa batas'}`);
      L.push(`• node arsip: ${r.suggest.archive ? 'ya' : 'tidak'}`);
      L.push('');
      L.push('<i>Bendera diatur dari dasbor; di sini hanya pengujiannya.</i>');
    }
    return [L.join('\n'), kb([[btn('↩︎ RPC', 'sr'), BACK_HOME]])];
  }

  async form(name) {
    const f = FORMS[name];
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
    return [L.join('\n'), kb([...rows, [btn('↩︎ Pengaturan', 's'), BACK_HOME]])];
  }

  async notifyScreen() {
    const st = await this.api('GET', '/api/settings');
    const n = this.notifCfg();
    const L = [
      '<b>🔔 Notifikasi</b>', '',
      `ntfy: ${st.notify.ntfy_topic ? `<code>${esc(st.notify.ntfy_topic)}</code>` : '(mati)'}`,
      '',
      '<b>Kirim ke Telegram</b>',
      ...NOTIF.map(([k, lbl]) => `${n[k] ? '✅' : '❌'} ${esc(lbl)}`),
    ];
    return [L.join('\n'), kb([
      ...NOTIF.map(([k, lbl]) => [btn(`${n[k] ? '✅' : '❌'} ${lbl}`.slice(0, 40), `snb:${k}`)]),
      [btn('✏️ Topik ntfy', 'snp'), btn('📨 Uji ntfy', 'snt')],
      [btn('↩︎ Pengaturan', 's'), BACK_HOME],
    ])];
  }

  async chatsScreen() {
    const ids = this.chats();
    const L = ['<b>💬 Chat Telegram yang berwenang</b>', ''];
    for (const c of ids) L.push(`• <code>${esc(c)}</code>`);
    if (!ids.length) L.push('(kosong)');
    L.push('');
    L.push('Chat di daftar ini bisa melakukan <b>semua</b> yang dasbor bisa, termasuk menyalakan LIVE dan menutup posisi. Lepaskan chat yang tidak kamu kenali.');
    if (this.pairCode && Date.now() < this.pairCode.exp) {
      L.push('');
      L.push(`Kode sambung aktif: <code>/start ${esc(this.pairCode.code)}</code>`);
    }
    return [L.join('\n'), kb([
      ...ids.map((c) => [btn(`🗑 Lepas ${c}`, `scd:${c}`)]),
      [btn('↩︎ Pengaturan', 's'), BACK_HOME],
    ])];
  }

  // ---- sisa jual -----------------------------------------------------------
  async leftovers(err = null) {
    const d = await this.api('GET', '/api/leftovers');
    const L = ['<b>🧹 Antrean jual memecoin sisa</b>', ''];
    if (err) L.push(`⚠️ ${esc(err)}\n`);
    if (!d.leftovers.length) L.push('Kosong — tidak ada sisa yang menunggu dijual.');
    for (const it of d.leftovers) {
      L.push(`• posisi #${it.posId} · <code>${esc(it.symbol || shortA(it.token))}</code>`);
      L.push(`  dicoba ${num(it.tries || 0)}×${it.since ? ` sejak ${esc(ago(it.since))}` : ''}${it.lastLossBps != null ? ` · rugi kini ${nf(it.lastLossBps / 100, 1)}%` : ''}`);
      if (it.why) L.push(`  <i>${esc(it.why)}</i>`);
    }
    L.push('');
    L.push('<i>Sisa muncul kalau memecoin hasil menutup posisi belum bisa dijual (rute rugi terlalu besar). Bot mengutip ulang tiap beberapa detik dan menjual begitu lolos batas.</i>');
    return [L.join('\n'), kb([
      d.leftovers.length ? [btn('🔁 Coba jual sekarang', 'fr')] : null,
      ...d.leftovers.map((it) => [btn(`🗑 Keluarkan #${it.posId} ${it.symbol || ''}`.slice(0, 38), `fd:${it.posId}:${it.token}`)]),
      [btn('🔄 Segarkan', 'f'), BACK_HOME],
    ])];
  }

  // ---- LP manual -----------------------------------------------------------
  async lpMenu(chatId) {
    const d = this.sess(chatId).lp || {};
    const siap = d.poolRef && d.usd > 0;
    const L = [
      '<b>➕ LP manual</b>',
      'Membuka posisi sendiri, di luar penyalinan target. Jalur eksekusinya sama: kas dijembatani, token ditukar seperlunya, lalu mint.',
      '💡 <i>Paling cepat: tempel alamat token di chat ini kapan saja.</i>',
      '',
      tabel([
        ['pool', d.pair || '— belum dipilih'],
        ['nominal', d.usd ? usd(d.usd) : '— belum diisi'],
        ['rentang', d.full ? 'seluruh rentang harga' : `${rentangTeks(d)} dari harga kini`],
      ]),
    ];
    if (this.engine.dryRun()) L.push('⚠️ Bot sedang di mode <b>simulasi</b> — pratinjau tetap jalan, tapi transaksi tidak akan dikirim.');
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn(`🏊 ${d.pair ? 'Ganti pool' : 'Pilih pool'}`, 'mlp:0')],
      [btn('💵 Nominal', 'mln'), btn('📐 Rentang', 'mlr')],
      siap ? [btn('👁 Pratinjau & buka', 'mlv')] : null,
      [btn('↩︎ Menu', 'h')],
    ])];
  }

  async lpPools(chatId, off = 0, cari = '') {
    const q = decodeURIComponent(cari || '');
    const d = await this.api('GET', '/api/manual/pools', {}, { q, limit: 60 });
    const s = this.sess(chatId);
    s.poolList = d.pools;                       // indeks tombol menunjuk ke daftar ini
    const hal = d.pools.slice(off, off + 8);
    const L = [`<b>🏊 Pilih pool</b>${q ? ` — cari "${esc(q)}"` : ''}`];
    if (!d.pools.length) L.push('\nBelum ada pool yang dikenal. Pool muncul di sini setelah bot melihat target beraksi di dalamnya.');
    else {
      L.push(`${d.pools.length} pool dikenal, diurutkan dari yang paling baru beraksi.`);
      L.push(kolom(hal.map((p) => [
        p.pair, p.dynamicFee ? 'dinamis' : `${trimZ(nf(p.feePct ?? 0, 2))}%`, p.hasHooks ? 'hook' : '', p.lastTs ? ago(p.lastTs) : '',
      ]), 'lr'));
    }
    const rows = hal.map((p, i) => [btn(`${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? 'dinamis' : trimZ(nf(p.feePct ?? 0, 2)) + '%'}`.slice(0, 40), `mlP:${off + i}`)]);
    const nav = [];
    if (off > 0) nav.push(btn('⬅️', `mlp:${Math.max(0, off - 8)}:${cari}`));
    if (off + 8 < d.pools.length) nav.push(btn('➡️', `mlp:${off + 8}:${cari}`));
    return [L.filter((x) => x != null).join('\n'), kb([
      ...rows, nav.length ? nav : null,
      [btn('🔎 Cari pasangan', 'mlc')],
      [btn('➕ Dari alamat token', 'mla')],
      [btn('↩︎ LP manual', 'ml')],
    ])];
  }

  // ---- alamat ditempel ------------------------------------------------------
  async tempel(chatId, a) {
    const m = await this.send(chatId, `🔎 Memeriksa <code>${esc(shortA(a))}</code>…`);
    const info = await this.api('GET', '/api/address', {}, { a });
    if (info.error) return this.edit(chatId, m.message_id, `❌ ${esc(info.error)}`, kb([[BACK_HOME]]));
    if (info.kind === 'token') return this.pasangLp(chatId, m.message_id, a, info);

    const s = this.sess(chatId);
    s.alamat = a;
    const L = [
      `<b>👛 ${info.kind === 'contract' ? 'Kontrak' : 'Wallet'}</b> <code>${esc(a)}</code>`,
      info.kind === 'contract' ? 'Bukan token — kemungkinan smart wallet. Mau diapakan?' : 'Ini alamat wallet, bukan token. Mau diapakan?',
      info.isTarget ? `\n🎯 Sudah diikuti${info.targetLabel ? ` sebagai <b>${esc(info.targetLabel)}</b>` : ''}.` : null,
    ];
    return this.edit(chatId, m.message_id, L.filter((x) => x != null).join('\n'), kb([
      [btn('🔎 Riset PnL', `wr:${a}`), info.isTarget ? btn('🎯 Daftar target', 't') : btn('➕ Jadikan target', 'adT')],
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
    const judul = `🔎 Mencari pool <b>${esc(sym)}</b>`;
    await this.edit(chatId, msgId, `${judul}…`);
    const r0 = await this.api('POST', '/api/manual/pools/scan', { token });
    if (r0.error) return this.edit(chatId, msgId, `❌ ${esc(r0.error)}`, kb([[BACK_HOME]]));
    const j = await this.tungguPindai(chatId, msgId, token, judul);
    if (j.status === 'gagal') return this.edit(chatId, msgId, `❌ Pemindaian gagal: <code>${esc(j.error)}</code>`, kb([[BACK_HOME]]));
    if (j.status === 'lama') return this.edit(chatId, msgId, '⏳ Pemindaian masih berjalan — tempel lagi alamatnya sebentar lagi.', kb([[BACK_HOME]]));
    const list = j.pools || [];
    if (!list.length) {
      return this.edit(chatId, msgId, [
        `<b>${esc(sym)}</b> <code>${esc(shortA(token))}</code>`,
        '',
        'Belum ada pool Uniswap v3/v4 yang bisa dimasuki untuk token ini.',
        j.total ? `<i>${j.total} pool ditemukan, tapi semuanya kosong, berfee dinamis, atau tidak dipasangkan USDG/ETH.</i>` : null,
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
    if (!d.poolRef) return ['Sesinya sudah habis (bot baru dimulai ulang). Tempel lagi alamat tokennya.', kb([[BACK_HOME]])];
    const pool = list.find((p) => p.poolRef === d.poolRef);
    const tk = s.lpToken || {};
    const L = [`<b>➕ Pasang LP — ${esc(d.pair || '?')}</b>`];
    if (tk.address) L.push(`<code>${esc(tk.address)}</code>`);
    if (pool) {
      L.push([pool.venue, pool.dynamicFee ? 'fee dinamis' : `fee ${trimZ(nf(pool.feePct ?? 0, 2))}%`, pool.hasHooks ? '🪝 hook' : null,
        list.length > 1 ? `${list.length - 1} pool lain` : null].filter(Boolean).join(' · '));
    }
    L.push('');
    L.push(tabel([
      ['nominal', d.usd > 0 ? usd(d.usd) : '— pilih di bawah'],
      ['rentang', d.full ? 'seluruh rentang' : `${rentangTeks(d)} dari harga kini`],
    ]));

    let nilai = null;
    if (d.usd > 0) {
      const r = await this.api('POST', '/api/manual/lp/plan', d);
      if (r.error) L.push(`⛔ ${esc(r.error)}`);
      else {
        const p = r.preview;
        nilai = p.valueUsd;
        L.push(angka([
          [p.symbol0, tok(Number(p.amount0) / 10 ** p.dec0, 6)],
          [p.symbol1, tok(Number(p.amount1) / 10 ** p.dec1, 6)],
          ['kas tersedia', usd(p.kasUsd)],
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
      L.push('<i>Pilih nominal — pratinjau muncul di sini.</i>');
    }
    const live = !this.engine.dryRun();
    if (!live) L.push('\n⚠️ Mode <b>simulasi</b> — pratinjau jalan, tapi posisi tidak bisa dibuka dari sini.');

    const pilih = (on, label) => (on ? `✓ ${label}` : label);
    const RG = [[10, 10, '±10%'], [25, 25, '±25%'], [50, 50, '±50%'], [50, 100, '½×–2×']];
    return [L.filter((x) => x != null).join('\n'), kb([
      [...[25, 50, 100].map((v) => btn(pilih(d.usd === v, `$${v}`), `qkn:${v}`)), btn('✏️ $', 'qkN')],
      RG.map(([a, b, l]) => btn(pilih(!d.full && d.lowerPct === a && d.upperPct === b, l), `qkw:${a}:${b}`)),
      [btn(pilih(!!d.full, 'seluruh rentang'), 'qkF'), btn('✏️ bawah & atas', 'qkC')],
      list.length > 1 ? [btn(`🏊 Ganti pool (${list.length})`, 'qkp')] : null,
      nilai != null && live ? [btn(`✅ Buka posisi ${usd(nilai)}`, 'qkY')] : null,
      [btn('🔄 Segarkan', 'qk'), BACK_HOME],
    ])];
  }

  lpKartuPool(chatId) {
    const s = this.sess(chatId);
    const list = (s.qkPools || []).slice(0, 12);
    const cur = s.lp?.poolRef;
    return [`<b>🏊 Pilih pool</b> untuk <b>${esc(s.lpToken?.symbol || '?')}</b>`, kb([
      ...list.map((p, i) => [btn(`${p.poolRef === cur ? '✓ ' : ''}${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? 'dinamis' : trimZ(nf(p.feePct ?? 0, 2)) + '%'}${p.kosong ? ' · kosong' : ''}`.slice(0, 44), `qkP:${i}`)]),
      [btn('↩︎ Kembali', 'qk')],
    ])];
  }

  lpKartuYakin(chatId) {
    const d = this.sess(chatId).lp || {};
    if (!d.poolRef || !(d.usd > 0)) return ['Nominal atau pool belum dipilih.', kb([[btn('↩︎ Kembali', 'qk')]])];
    return [[
      '<b>Kirim transaksi sungguhan?</b>',
      '',
      tabel([['pool', d.pair], ['nominal', usd(d.usd)], ['rentang', d.full ? 'seluruh rentang' : rentangTeks(d)]]),
      'Kas dijembatani, token ditukar seperlunya, lalu mint — bisa sampai satu menit. Posisi ini tidak ikut ditutup saat target mana pun keluar.',
    ].join('\n'), kb([[btn('✅ Ya, buka sekarang', 'mlX')], [btn('↩︎ Batal', 'qk')]])];
  }

  // Mencari pool sebuah token langsung dari chain. Pesannya disunting selama
  // pemindaian berjalan supaya terlihat masih hidup — bisa belasan detik.
  async runScanPool(chatId, tokenRaw) {
    const token = String(tokenRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(token)) {
      return this.send(chatId, '❌ Alamat token harus 0x diikuti 40 karakter hex.', kb([[btn('↩︎ Coba lagi', 'mla'), BACK_HOME]]));
    }
    const r0 = await this.api('POST', '/api/manual/pools/scan', { token });
    if (r0.error) return this.send(chatId, `❌ ${esc(r0.error)}`, kb([[BACK_HOME]]));
    const m = await this.send(chatId, `🔎 Mencari pool untuk <code>${esc(shortA(token))}</code>…`);
    for (let i = 0; i < 120; i++) {
      await sleep(2000);
      const j = await this.api('GET', '/api/manual/pools/scan', {}, { token });
      if (j.status === 'jalan') {
        if (i % 3 === 0) await this.edit(chatId, m.message_id, `🔎 Mencari pool untuk <code>${esc(shortA(token))}</code>… ${j.progress || 0}%`);
        continue;
      }
      if (j.status === 'gagal') return this.edit(chatId, m.message_id, `❌ Pemindaian gagal: <code>${esc(j.error)}</code>`, kb([[btn('↩︎ Pilih pool', 'mlp:0'), BACK_HOME]]));
      const [text, keyboard] = await this.lpHasilPindai(chatId, token, false);
      return this.edit(chatId, m.message_id, text, keyboard);
    }
    return this.edit(chatId, m.message_id, '⏳ Pemindaian masih berjalan — buka lagi sebentar lagi.', kb([[btn('🔄 Periksa', `mls:${token}`), BACK_HOME]]));
  }

  async lpHasilPindai(chatId, token, semua) {
    const j = await this.api('GET', '/api/manual/pools/scan', {}, { token, all: semua ? '1' : '' });
    if (j.status === 'kosong') return ['Pemindaian itu sudah tidak tersimpan. Kirim alamatnya lagi.', kb([[btn('➕ Dari alamat token', 'mla')], [BACK_HOME]])];
    if (j.status === 'jalan') return [`🔎 Masih memindai… ${j.progress || 0}%`, kb([[btn('🔄 Periksa lagi', `mls:${token}`)], [BACK_HOME]])];
    if (j.status === 'gagal') return [`❌ ${esc(j.error)}`, kb([[btn('➕ Coba token lain', 'mla')], [BACK_HOME]])];

    const list = j.pools || [];
    const s = this.sess(chatId);
    s.poolList = list;                              // indeks tombol menunjuk daftar ini
    const L = [`<b>🔎 Pool untuk</b> <code>${esc(shortA(token))}</code>`];
    if (!list.length) {
      L.push('\nTidak ada pool Uniswap v3/v4 yang bisa dimasuki untuk token ini.');
      if (j.total) L.push(`<i>${j.total} pool ditemukan, semuanya tanpa likuiditas atau tanpa aset kuotasi.</i>`);
      L.push(...pasarLainTeks(j.lainnya));
    } else {
      L.push(`${list.length} pool bisa dimasuki${j.hidden ? ` · ${j.hidden} disembunyikan` : ''} (dari ${j.total} yang ada).`);
      L.push(kolom(list.slice(0, 10).map((p) => [
        p.pair, p.dynamicFee ? 'dinamis' : `${trimZ(nf(p.feePct ?? 0, 2))}%`, p.hasHooks ? 'hook' : '',
      ]), 'lr'));
      if (j.hidden) L.push('<i>Yang disembunyikan: pool tanpa likuiditas, berfee dinamis, atau tidak dipasangkan USDG/ETH — masuk ke sana sama saja membuang gas.</i>');
    }
    const rows = list.slice(0, 10).map((p, i) => [btn(
      `${p.hasHooks ? '🪝 ' : ''}${p.pair} · ${p.dynamicFee ? 'dinamis' : trimZ(nf(p.feePct ?? 0, 2)) + '%'}`.slice(0, 40), `mlP:${i}`)]);
    return [L.filter((x) => x != null).join('\n'), kb([
      ...rows,
      j.hidden && !semua ? [btn(`👁 Tampilkan semua (${j.total})`, `mls:${token}:all`)] : null,
      [btn('➕ Token lain', 'mla'), btn('↩︎ Pilih pool', 'mlp:0')],
    ])];
  }

  async lpRange(chatId) {
    const d = this.sess(chatId).lp || {};
    const L = [
      '<b>📐 Rentang harga</b>',
      'Fee hanya mengalir selama harga berada di dalam rentang. Sempit = fee lebih besar tapi lebih cepat keluar; lebar = lebih aman tapi encer.',
      '',
      `Sekarang: <b>${d.full ? 'seluruh rentang' : rentangTeks(d)}</b>`,
      '',
      '<i>Batas bawah dan atas boleh berbeda — misal turun 10%, naik 30%.</i>',
    ];
    return [L.join('\n'), kb([
      [btn('±5%', 'mlw:5:5'), btn('±10%', 'mlw:10:10'), btn('±25%', 'mlw:25:25')],
      [btn('±50%', 'mlw:50:50'), btn('½× – 2×', 'mlw:50:100'), btn('seluruh rentang', 'mlF')],
      [btn('✏️ Atur bawah & atas', 'mlC')],
      [btn('↩︎ LP manual', 'ml')],
    ])];
  }

  async lpPreview(chatId) {
    const d = this.sess(chatId).lp || {};
    const r = await this.api('POST', '/api/manual/lp/plan', d);
    if (r.error) {
      return [`⛔ <b>Belum bisa dibuka</b>\n${esc(r.error)}`, kb([[btn('↩︎ LP manual', 'ml'), BACK_HOME]])];
    }
    const p = r.preview;
    const rg = rentang(p);
    const L = [
      `<b>👁 Pratinjau — ${esc(p.pair)}</b>`,
      `${esc(p.venue)} · fee ${p.dynamicFee ? 'dinamis' : trimZ(nf(p.feePct ?? 0, 2)) + '%'} · ${p.side === 'both' ? 'dua sisi' : 'satu sisi'}`,
      '',
      angka([
        ['nilai posisi', usd(p.valueUsd)],
        [p.symbol0, tok(Number(p.amount0) / 10 ** p.dec0, 6)],
        [p.symbol1, tok(Number(p.amount1) / 10 ** p.dec1, 6)],
        ['kas tersedia', usd(p.kasUsd)],
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
      ? 'Transaksi dikirim sungguhan dari wallet bot. Posisi ini tidak mencermin siapa pun — ia tidak akan ikut ditutup saat target keluar.'
      : '⚠️ Mode <b>simulasi</b>: tombol di bawah akan ditolak.');
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn('✅ Buka posisi sekarang', 'mlX')],
      [btn('💵 Ubah nominal', 'mln'), btn('📐 Ubah rentang', 'mlr')],
      [btn('↩︎ LP manual', 'ml')],
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
      '<b>🔁 Swap</b>',
      'Menukar lewat agregator Kyber — rute yang sama dipakai bot untuk zap dan menjual sisa.',
      '',
      tabel([
        ['dari', d.symFrom || '— belum dipilih'],
        ['ke', d.symTo || '— belum dipilih'],
        ['jumlah', d.amount || '— belum diisi'],
      ]),
      '<b>Saldo</b>',
      punya.length ? angka(punya.map((x) => [x.symbol, tok(x.amount, 6)])) : 'Semua saldo kosong.',
    ];
    if (this.engine.dryRun()) L.push('⚠️ Bot sedang di mode <b>simulasi</b> — kutipan tetap jalan, tapi transaksi tidak akan dikirim.');
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn('📤 Dari', 'swf'), btn('📥 Ke', 'swt')],
      [btn('🔢 Jumlah', 'swn')],
      d.from && d.to && d.amount ? [btn('👁 Kutipan & tukar', 'swq')] : null,
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
      `<b>${sisi === 'from' ? '📤 Ditukar dari' : '📥 Ditukar ke'}</b>`,
      sisi === 'from' ? 'Hanya token yang ada saldonya.' : 'Aset kuotasi dan token yang pernah kita pegang.',
      '',
      pilih.length ? angka(pilih.map((x) => [x.symbol, tok(x.amount, 6)])) : 'Tidak ada pilihan.',
    ];
    const rows = pilih.map((x) => [btn(`${x.symbol} · ${tok(x.amount, 4)}`.slice(0, 40),
      `${sisi === 'from' ? 'swF' : 'swT'}:${t.tokens.indexOf(x)}`)]);
    return [L.filter((x) => x != null).join('\n'), kb([...rows, [btn('↩︎ Swap', 'sw')]])];
  }

  async swapQuote(chatId, ack) {
    const d = this.sess(chatId).sw || {};
    if (!d.from || !d.to || !d.amount) return this.swapMenu(chatId);
    if (ack) await ack('Mengambil kutipan…');
    const q = await this.api('POST', '/api/manual/swap/quote', { tokenIn: d.from, tokenOut: d.to, amount: d.amount });
    if (q.error) return [`⛔ ${esc(q.error)}`, kb([[btn('↩︎ Swap', 'sw'), BACK_HOME]])];
    const L = [
      `<b>👁 ${esc(q.symbolIn)} → ${esc(q.symbolOut)}</b>`,
      '',
      angka([
        ['dikirim', `${tok(q.amountIn, 6)} ${q.symbolIn}`],
        ['diterima', `${tok(q.amountOut, 6)} ${q.symbolOut}`],
        ['nilai masuk', q.usdIn != null ? usd(q.usdIn) : null],
        ['nilai keluar', q.usdOut != null ? usd(q.usdOut) : null],
        ['biaya rute', q.lossBps != null ? `${trimZ(nf(q.lossBps / 100, 2))}%` : null],
      ]),
      q.dex ? `<i>lewat ${esc(q.dex)}</i>` : null,
    ];
    if (q.tooLossy) {
      L.push('');
      L.push(`⛔ Rute ini rugi ${trimZ(nf(q.lossBps / 100, 1))}%, di atas batas ${trimZ(nf(q.maxLossBps / 100, 1))}% — bot akan menolaknya. Kecilkan jumlahnya atau naikkan batas di Aturan → Keluar posisi.`);
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      q.tooLossy ? null : [btn('✅ Tukar sekarang', 'swX')],
      [btn('🔢 Ubah jumlah', 'swn'), btn('🔄 Kutipan ulang', 'swq')],
      [btn('↩︎ Swap', 'sw')],
    ])];
  }

  // ---- scout & riset -------------------------------------------------------
  async runScout(chatId, addrRaw) {
    const addr = String(addrRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return this.send(chatId, '❌ Alamat harus 0x diikuti 40 karakter hex.', kb([[btn('↩︎ Coba lagi', 'k'), BACK_HOME]]));
    const r0 = await this.api('POST', '/api/scout', { address: addr });
    if (r0.error) return this.send(chatId, `❌ ${esc(r0.error)}`, kb([[BACK_HOME]]));
    const m = await this.send(chatId, `🔭 Memotret <code>${esc(shortA(addr))}</code>…`);
    for (let i = 0; i < 150; i++) {
      await sleep(2000);
      const j = await this.api('GET', '/api/scout', {}, { address: addr });
      if (j.status === 'jalan') {
        if (i % 3 === 0) await this.edit(chatId, m.message_id, `🔭 Memotret <code>${esc(shortA(addr))}</code>… ${j.progress || 0}%`);
        continue;
      }
      if (j.status === 'gagal') return this.edit(chatId, m.message_id, `❌ Scout gagal: <code>${esc(j.error)}</code>`, kb([[BACK_HOME]]));
      const r = j.result;
      const pairs = Object.entries(r.pairs).sort((a, b) => b[1].valueUsd - a[1].valueUsd).slice(0, 8);
      const L = [
        `<b>🔭 Scout</b> <code>${esc(addr)}</code>`, '',
        `posisi hidup    : ${r.positionsAlive} (dilepas ${r.positionsClosed})`,
        `nilai posisi    : ${usd(r.totalValueUsd)}`,
        `fee belum klaim : ${usd(r.totalUnclaimedFeeUsd)} (${nf(r.feeRatioPct, 2)}% dari nilai)`,
        `sedang in-range : ${nf(r.inRangePct, 0)}%`,
        `median posisi   : ${usd(r.medianPositionUsd, 0)} · lebar ${nf(r.medianWidthPct, 0)}%`,
        `median umur     : ${nf(r.medianAgeHours, 1)} jam`,
        '', '<b>Pasangan</b>',
        ...pairs.map(([k, v]) => `• ${esc(k)} — ${v.n} posisi · ${usd(v.valueUsd, 0)} · fee ${usd(v.feeUsd)}`),
      ];
      return this.edit(chatId, m.message_id, L.join('\n'), kb([
        [btn('🔎 Riset lengkap', `wr:${addr}`), btn('➕ Jadikan target', 'ta')],
        [BACK_HOME],
      ]));
    }
    return this.edit(chatId, m.message_id, '⏳ Scout masih berjalan — coba lagi sebentar lagi.', kb([[BACK_HOME]]));
  }

  async runRiset(chatId, addrRaw) {
    const addr = String(addrRaw).trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) return this.send(chatId, '❌ Alamat harus 0x diikuti 40 karakter hex.', kb([[btn('↩︎ Coba lagi', 'w'), BACK_HOME]]));
    const w = await this.api('GET', '/api/wallet', {}, { address: addr });
    if (!w.found) {
      await this.api('POST', '/api/wallet/scan', { address: addr, mode: 'full' });
      const m = await this.send(chatId, `🔎 Wallet ini belum pernah diriset — memindai riwayatnya sekarang. Ini bisa beberapa menit.`);
      for (let i = 0; i < 240; i++) {
        await sleep(3000);
        const j = await this.api('GET', '/api/wallet', {}, { address: addr });
        if (j.found && j.job?.status !== 'jalan') break;
        if (j.job?.status === 'gagal') return this.edit(chatId, m.message_id, `❌ Riset gagal: <code>${esc(j.job.error)}</code>`, kb([[BACK_HOME]]));
        if (i % 3 === 0) await this.edit(chatId, m.message_id, `🔎 Memindai <code>${esc(shortA(addr))}</code>… ${j.job?.progress || 0}% <i>(${esc(j.job?.phase || 'mulai')})</i>`);
      }
      const [text, keyboard] = await this.riset(addr);
      return this.edit(chatId, m.message_id, text, keyboard);
    }
    return this.screen(chatId, null, `wr:${addr}`);
  }

  async riset(addr) {
    const w = await this.api('GET', '/api/wallet', {}, { address: addr });
    if (!w.found) {
      return [`Wallet <code>${esc(addr)}</code> belum pernah diriset.`, kb([[btn('🔎 Riset sekarang', 'w')], [BACK_HOME]])];
    }
    const s = w.stats || {};
    const L = [
      `<b>🔎 Riset</b>${w.label ? ` — ${esc(w.label)}` : ''}`,
      `<code>${esc(addr)}</code>`,
      `<i>dipindai sampai blok ${num(w.scannedTo)} · ${esc(ago(w.lastScanTs))}</i>`,
      w.job?.status === 'jalan' ? `⏳ sedang diperbarui (${w.job.progress || 0}%)` : null,
      '',
      angka([
        ['posisi terbuka', w.open.length],
        ['posisi ditutup', w.closed.length],
        ['menang', s.winRatePct != null ? `${nf(s.winRatePct, 0)}%` : null],
        ['PnL', s.pnlUsd != null ? sgn(s.pnlUsd) : null],
        ['fee dikumpulkan', s.feesUsd != null ? sgn(s.feesUsd) : null],
        ['modal diputar', s.investedUsd != null ? sgn(s.investedUsd) : null],
      ]),
    ];
    if (w.open.length) {
      L.push('<b>Posisi terbuka</b>');
      L.push(tabel(w.open.slice(0, 8).map((p) => [
        `${p.symbol0}/${p.symbol1}`,
        `${usd(p.invested_q)} · fee ${usd(p.feeShown)} · ${dur((p.ageHours || 0) * 3600)}`,
      ])));
    }
    if (w.closed.length) {
      L.push('<b>Terakhir ditutup</b>');
      L.push(tabel(w.closed.slice(0, 8).map((p) => [
        `${p.symbol0}/${p.symbol1}`,
        `${sgn(p.pnl_q)} ${pct(p.pnlPct)} · ${ago(p.closed_ts)}`,
      ])));
    }
    return [L.filter((x) => x != null).join('\n'), kb([
      [btn('🔄 Perbarui riset', `tr:${addr}`)],
      w.isTarget ? [btn('🎯 Halaman target', `t:${addr}`)] : [btn('➕ Jadikan target', 'ta')],
      [btn('📇 Wallet lain', 'wl'), BACK_HOME],
    ])];
  }

  async walletList() {
    const d = await this.api('GET', '/api/wallets');
    const L = ['<b>📇 Wallet yang pernah diriset</b>', ''];
    for (const w of d.wallets.slice(0, 20)) {
      L.push(`• <code>${esc(shortA(w.address))}</code> ${esc(w.label || '')} — ${w.positions_n || 0} posisi · ${ago(w.last_scan_ts)}`);
    }
    if (!d.wallets.length) L.push('(belum ada)');
    return [L.join('\n'), kb([
      ...d.wallets.slice(0, 12).map((w) => [btn(`${(w.label || shortA(w.address)).slice(0, 28)}`, `wr:${w.address}`)]),
      [btn('🔎 Riset wallet baru', 'w'), BACK_HOME],
    ])];
  }
}

module.exports = { Telegram, parseVal, showVal, RULE_GROUPS, FORMS, COMMANDS, ALIAS, kolom, tabel, rentang, tickPrice, dur, parseRentang, rentangTeks };
