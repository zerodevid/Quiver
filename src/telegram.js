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
const num = (n) => (n == null ? '—' : Number(n).toLocaleString('id-ID'));

function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} dtk lalu`;
  if (s < 3600) return `${Math.round(s / 60)} mnt lalu`;
  if (s < 86400) return `${Math.floor(s / 3600)}j ${Math.round((s % 3600) / 60)}m lalu`;
  return `${Math.floor(s / 86400)} hari lalu`;
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
  if (sec < 60) return `${Math.round(sec)} dtk`;
  if (sec < 3600) return `${Math.round(sec / 60)} mnt`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}j ${Math.round((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}h ${Math.floor((sec % 86400) / 3600)}j`;
}
const cut = (s, n = 3800) => (s.length <= n ? s : s.slice(0, n) + '\n…(dipotong)');

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

// Buang nol di ekor pecahan: "1,50" -> "1,5", "1,00" -> "1". Angka tanpa koma
// tidak disentuh — di format Indonesia "1.000" adalah seribu, bukan satu koma nol.
const trimZ = (s) => (s.includes(',') ? s.replace(/,?0+$/, '') : s);

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
    fs.writeFileSync(this.cfgPath, JSON.stringify(this.cfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.cfgPath, 0o600); } catch { /* abaikan */ }
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
  push(text) {
    if (!this.token() || !this.chats().length) return;
    if (this.queue.length > 40) return;              // banjir log: jangan menumpuk
    this.queue.push(text);
    if (!this.sending) this.drain();
  }
  async drain() {
    this.sending = true;
    while (this.queue.length && !this.stopped) {
      const text = this.queue.shift();
      for (const c of this.chats()) {
        try { await this.send(c, text); } catch (e) { this.log(`telegram kirim: ${e.message}`); }
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
    this.engine.onNotify = (msg) => {
      if (prevNotify) prevNotify(msg);
      // engine.notify() juga menulis baris log 'info' dengan teks yang sama. Kalau
      // pengiriman baris info sedang dinyalakan, kabar yang sama akan datang dua
      // kali — yang ini dicatat supaya penyaring log di bawah melewatinya.
      this.lastNotify = msg;
      if (this.notifCfg().penting) this.push(`🔔 <b>${esc(msg)}</b>`);
    };
    const prevLog = this.store.onLog;
    this.store.onLog = (level, msg) => {
      if (prevLog) prevLog(level, msg);
      const n = this.notifCfg();
      const icon = { error: '⛔', warn: '⚠️', info: 'ℹ️' }[level];
      if (level === 'error' && n.error) this.push(`${icon} ${esc(msg)}`);
      else if (level === 'warn' && n.warn) this.push(`${icon} ${esc(msg)}`);
      else if (level === 'info' && n.info && msg !== this.lastNotify) this.push(`${icon} ${esc(msg)}`);
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
        return this.screen(chatId, null, 'h', `✅ Chat tersambung. Selamat datang di <b>lpcopy</b>.\n\n`);
      }
      // Bot ini bisa ditemukan siapa saja lewat namanya. Petunjuknya dikirim sekali
      // per chat; sisanya didiamkan supaya tidak bisa dipakai memancing balasan terus.
      if (!this.told) this.told = new Set();
      if (this.told.has(chatId)) return;
      this.told.add(chatId);
      return this.send(chatId, 'Chat ini belum tersambung ke lpcopy.\n\nBuka dasbor → <b>Pengaturan</b> → <b>Telegram</b> → <i>Buat kode</i>, lalu kirim di sini:\n<code>/start KODE</code>');
    }

    const s = this.sess(chatId);
    // Sedang ditanya sesuatu? Jawaban apa pun yang bukan perintah dianggap isian.
    if (s.pending && !text.startsWith('/')) {
      const p = s.pending; s.pending = null;
      try { return await this.answer(chatId, p, text); }
      catch (e) { return this.send(chatId, `❌ ${esc(e.message)}`, kb([[btn('↩︎ Coba lagi', p.retry || 'h'), BACK_HOME]])); }
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
        return this.send(chatId, `<b>Perintah</b>\n${COMMANDS.map(([c, d]) => `/${c} — ${esc(d)}`).join('\n')}\n\nSemua ini juga ada tombolnya di /menu.`, kb([[BACK_HOME]]));
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
        const r = await this.api('POST', '/api/positions/close', { id: Number(rest[0]) });
        if (r.error) return out(`❌ Gagal menutup posisi #${esc(rest[0])}\n<code>${esc(r.error)}</code>`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]]));
        return out(`✅ Perintah tutup posisi #${esc(rest[0])} terkirim.\nTx: <code>${esc(shortH(r.tx))}</code>`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]]));
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
      case 'sw': return out(...(await this.walletScreen()));
      case 'swg': return out('🔑 <b>Buat wallet baru?</b>\n\nKunci lama otomatis dicadangkan (tidak dihapus), lalu bot memakai alamat baru. Dana di alamat lama <b>tidak</b> ikut pindah.\n\nHanya bisa saat mode simulasi.',
        kb([[btn('✅ Ya, buat baru', 'swG')], [btn('↩︎ Batal', 'sw')]]));
      case 'swG': {
        const r = await this.api('POST', '/api/settings/wallet/generate', { replace: true });
        if (r.error) return out(`❌ ${esc(r.error)}`, kb([[btn('↩︎ Kembali', 'sw')]]));
        return out(`✅ Wallet baru: <code>${esc(r.address)}</code>\nFrasa pemulihan disimpan di server (<code>${esc(r.mnemonicFile)}</code>) dan sengaja tidak dikirim lewat Telegram.`, kb([[btn('↩︎ Wallet', 'sw')], [BACK_HOME]]));
      }
      case 'swr': return this.ask(chatId, { kind: 'lepasWallet', retry: 'sw' }, 'Untuk melepas wallet, kirim alamatnya persis (kunci dicadangkan, tidak dihapus).');

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
        return this.screen(chatId, null, 'sw', '✅ Wallet dilepas (kunci dicadangkan).\n\n');
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

  // ---- layar ---------------------------------------------------------------
  async home() {
    const o = await this.api('GET', '/api/overview');
    const mode = o.mode.dry_run ? '🧪 SIMULASI' : '🟢 LIVE';
    const jeda = o.mode.paused ? ' · ⏸ dijeda' : '';
    const s = o.summary;
    const text = [
      `<b>lpcopy</b> — ${mode}${jeda}`,
      `Wallet: <code>${esc(shortA(o.mode.wallet))}</code>`,
      '',
      `💼 ${s.openCount} posisi terbuka · ${usd(s.exposureUsd)} · fee ${usd(s.feeUsd)}`,
      `📈 Belum terealisasi ${sgn(s.unrealizedUsd)} · terealisasi ${sgn(s.realizedUsd)}`,
      `🔗 Blok ${num(o.chain.head)} · tertinggal ${num(o.chain.lag)}`,
      '',
      'Pilih menu:',
    ].join('\n');
    return [text, kb([
      [btn('📊 Ringkasan', 'o'), btn('💼 Posisi', 'p')],
      [btn('🎯 Target', 't'), btn('📜 Aktivitas', 'a:0')],
      [btn('⚙️ Aturan salin', 'r'), btn('🔧 Pengaturan', 's')],
      [btn('🔎 Riset wallet', 'w'), btn('🔭 Scout', 'k')],
      [btn('🧹 Sisa jual', 'f'), btn('💵 Saldo', 'b')],
      [btn('📝 Log', 'l'), btn('🧾 Transaksi', 'x')],
      [btn(o.mode.paused ? '▶️ Lanjutkan' : '⏸ Jeda', 'sp'), btn('🔄 Segarkan', 'h')],
    ])];
  }

  async overview() {
    const o = await this.api('GET', '/api/overview');
    const s = o.summary, t = o.totals;
    const L = [];
    L.push(`<b>📊 Ringkasan</b>`);
    L.push(`Mode: <b>${o.mode.dry_run ? '🧪 SIMULASI' : '🟢 LIVE'}</b>${o.mode.paused ? ' · ⏸ <b>dijeda</b>' : ''}`);
    L.push(`Wallet bot: <code>${esc(o.mode.wallet || '(belum ada)')}</code>`);
    L.push('');
    L.push(`<b>Posisi</b>`);
    L.push(`• terbuka: ${s.openCount} (${s.inRange} in-range)`);
    L.push(`• nilai: ${usd(s.exposureUsd)} · modal ${usd(s.costUsd)}`);
    L.push(`• fee belum diklaim: ${usd(s.feeUsd)}`);
    L.push(`• belum terealisasi: <b>${sgn(s.unrealizedUsd)}</b>`);
    L.push(`• sudah terealisasi: <b>${sgn(s.realizedUsd)}</b>`);
    L.push('');
    L.push(`<b>Pemantauan</b>`);
    L.push(`• aksi target terpantau: ${num(t.actions)}`);
    L.push(`• disalin: ${num(t.copied)} · dilewat: ${num(t.skipped)} · galat: ${num(t.errors)}`);
    L.push(`• blok kepala: ${num(o.chain.head)} · kursor ${num(o.chain.cursor)} · tertinggal <b>${num(o.chain.lag)}</b>`);
    L.push(`• harga ETH: ${usd(o.chain.ethUsd, 0)}`);
    L.push(`• hidup sejak: ${dur(o.stats.uptimeSec)} lalu · sinkron ${ago(o.lastSync)}`);
    if (o.skipReasons?.length) {
      L.push('');
      L.push('<b>Alasan terbanyak dilewat</b>');
      for (const r of o.skipReasons.slice(0, 5)) L.push(`• ${esc(r.reason)} — ${r.n}×`);
    }
    const bad = (o.rpc || []).filter((r) => r.errors);
    if (bad.length) {
      L.push('');
      L.push('<b>RPC</b>');
      for (const r of o.rpc) L.push(`• ${esc(hostOf(r.url))} — ${num(r.calls)} panggilan, ${num(r.errors)} galat${r.cooling ? ' ❄️' : ''}`);
    }
    if (o.stats.lastError) { L.push(''); L.push(`⛔ Galat terakhir: <code>${esc(o.stats.lastError)}</code>`); }
    return [L.join('\n'), kb([
      [btn('💼 Posisi', 'p'), btn('📜 Aktivitas', 'a:0')],
      [btn('🔄 Segarkan', 'o'), BACK_HOME],
    ])];
  }

  async saldo() {
    const st = await this.api('GET', '/api/settings');
    const b = st.wallet.balances;
    const L = [`<b>💵 Saldo wallet bot</b>`, `<code>${esc(st.wallet.address || '(belum ada wallet)')}</code>`, ''];
    if (!b) L.push('Saldo tidak terbaca sekarang (RPC sedang sibuk).');
    else {
      L.push(`• ETH  : ${nf(b.eth, 6)}`);
      L.push(`• USDG : ${nf(b.usdg, 2)}`);
      L.push(`• WETH : ${nf(b.weth, 6)}`);
    }
    const o = await this.api('GET', '/api/overview');
    L.push('');
    L.push(`Di dalam posisi: ${usd(o.summary.exposureUsd)} (${o.summary.openCount} posisi)`);
    return [L.join('\n'), kb([[btn('🔄 Segarkan', 'b'), btn('💼 Posisi', 'p')], [BACK_HOME]])];
  }

  async posisi() {
    const d = await this.api('GET', '/api/positions');
    const open = (d.positions || []).filter((p) => !p.empty);
    const L = [`<b>💼 Posisi terbuka (${open.length})</b>`];
    if (!open.length) L.push('\nBelum ada posisi terbuka.');
    for (const p of open) {
      L.push('');
      L.push(`<b>${esc(p.symbol0)}/${esc(p.symbol1)}</b> #${esc(p.token_id)} ${p.inRange ? '🟢 in-range' : '🟡 di luar rentang'}`);
      L.push(`  nilai ${usd(p.valueUsd)} · fee ${usd(p.feeUsd)} · ${sgn(p.pnlUsd)} (${pct(p.pnlPct)})`);
      L.push(`  umur ${dur(p.ageHours * 3600)}${p.target ? ` · cermin ${esc(shortA(p.target))}` : ''}`);
    }
    const rows = open.map((p) => [btn(`${p.symbol0}/${p.symbol1} #${p.token_id}`, `p:${p.id}`)]);
    const closed = (d.closed || []).slice(0, 5);
    if (closed.length) {
      L.push('');
      L.push('<b>Terakhir ditutup</b>');
      for (const c of closed) {
        const pnl = (c.out_quote || 0) - (c.cost_quote || 0);
        L.push(`• #${esc(c.token_id)} ${sgn(pnl)} · ${ago(c.closed_ts)}`);
      }
    }
    return [L.join('\n'), kb([...rows, [btn('🔄 Segarkan', 'p'), BACK_HOME]])];
  }

  async posisiDetail(id) {
    const d = await this.api('GET', '/api/positions');
    const p = (d.positions || []).find((x) => String(x.id) === String(id));
    if (!p) return [`Posisi #${esc(id)} tidak ada di daftar terbuka.`, kb([[btn('↩︎ Posisi', 'p'), BACK_HOME]])];
    const L = [
      `<b>${esc(p.symbol0)}/${esc(p.symbol1)}</b> · posisi #${p.id} · NFT #${esc(p.token_id)}`,
      `${p.inRange ? '🟢 in-range' : '🟡 di luar rentang'} · venue ${esc(p.venue)} · fee ${p.fee != null ? nf(p.fee / 10000, 2) + '%' : '—'}`,
      '',
      `nilai      : ${usd(p.valueUsd)}`,
      `modal      : ${usd(p.costUsd)}`,
      `fee         : ${usd(p.feeUsd)}`,
      `untung/rugi : <b>${sgn(p.pnlUsd)}</b> (${pct(p.pnlPct)})`,
      p.ilUsd != null ? `IL vs HODL  : ${sgn(p.ilUsd)}` : null,
      `rentang tick: ${num(p.tick_lower)} … ${num(p.tick_upper)} (kini ${num(p.curTick)})`,
      `umur        : ${dur(p.ageHours * 3600)}`,
      p.target ? `cermin dari : <code>${esc(p.target)}</code> #${esc(p.mirror_of || '—')}` : null,
      p.tx_open ? `tx buka     : <code>${esc(shortH(p.tx_open))}</code>` : null,
    ].filter(Boolean);
    return [L.join('\n'), kb([
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
      `${t.enabled ? '🟢 <b>Aktif</b>' : '⚪️ <b>Nonaktif</b>'} — ${esc(t.label || 'tanpa nama')}`,
      `<code>${esc(t.address)}</code>`,
      '',
      `aksi terpantau : ${num(t.actions)}${t.lastActionTs ? ` (terakhir ${ago(t.lastActionTs)})` : ''}`,
      `disalin        : ${num(t.copied)}`,
      `posisi kita    : ${t.openPositions} · modal ${usd(t.openCostQuote)}`,
      '',
      `<b>Aturan yang berlaku</b>${t.rulesOwn ? ' <i>(ada penyesuaian khusus)</i>' : ' <i>(ikut aturan umum)</i>'}`,
      `• ukuran: ${esc(showVal(RULE_GROUPS[0].fields[0], r.sizing.mode))}`,
      `• batas per posisi: ${usd(r.sizing.max_quote_per_position_usd, 0)}`,
      `• batas total: ${usd(r.sizing.max_total_exposure_usd, 0)} · harian ${usd(r.sizing.daily_budget_usd, 0)}`,
      `• abaikan aksi < ${usd(r.filters.min_target_quote_usd, 0)}`,
      `• maks posisi terbuka: ${r.filters.max_open_positions}`,
    ];
    if (t.research) {
      const s = t.research;
      L.push('');
      L.push(`<b>Riset wallet</b> <i>(${ago(s.lastScanTs)})</i>`);
      if (s.positionsN != null) L.push(`• posisi terbaca: ${num(s.positionsN)}`);
      if (s.winRatePct != null) L.push(`• menang: ${nf(s.winRatePct, 0)}%`);
      if (s.pnlUsd != null) L.push(`• PnL: ${sgn(s.pnlUsd)}`);
    }
    return [L.join('\n'), kb([
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
      [btn('🔑 Wallet bot', 'sw'), btn('🌐 RPC', 'sr')],
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
      `berkas kunci : <code>${esc(w.keyFile)}</code> ${w.hasKey ? `(izin ${esc(w.perms || '?')})` : '— belum ada'}`,
      `cadangan     : ${w.backups} berkas`,
      '',
    ];
    if (b) {
      L.push(`ETH ${nf(b.eth, 6)} · USDG ${nf(b.usdg, 2)} · WETH ${nf(b.weth, 6)}`);
      L.push('');
    }
    L.push('<i>Impor kunci privat lewat Telegram sengaja tidak disediakan — riwayat chat tersimpan di server Telegram. Pakai dasbor untuk itu.</i>');
    return [L.join('\n'), kb([
      [btn('🆕 Buat wallet baru', 'swg')],
      [btn('🗑 Lepas wallet', 'swr')],
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
      L.push(`  percobaan ke-${it.tries || 0}${it.next ? ` · coba lagi ${esc(nanti(it.next))}` : ''}`);
      if (it.why) L.push(`  <i>${esc(it.why)}</i>`);
    }
    L.push('');
    L.push('<i>Sisa muncul kalau memecoin hasil menutup posisi belum bisa dijual (rute rugi terlalu besar atau harga bergerak). Bot mencobanya lagi otomatis sampai 8 kali.</i>');
    return [L.join('\n'), kb([
      d.leftovers.length ? [btn('🔁 Coba jual sekarang', 'fr')] : null,
      ...d.leftovers.map((it) => [btn(`🗑 Keluarkan #${it.posId} ${it.symbol || ''}`.slice(0, 38), `fd:${it.posId}:${it.token}`)]),
      [btn('🔄 Segarkan', 'f'), BACK_HOME],
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
      `<b>🔎 Riset</b> <code>${esc(addr)}</code>`,
      w.label ? esc(w.label) : null,
      `<i>dipindai sampai blok ${num(w.scannedTo)} · ${ago(w.lastScanTs)}</i>`,
      w.job?.status === 'jalan' ? `⏳ sedang diperbarui (${w.job.progress || 0}%)` : null,
      '',
      `posisi terbuka : ${w.open.length}`,
      `posisi ditutup : ${w.closed.length}`,
    ];
    for (const [k, lbl] of [['pnlUsd', 'PnL'], ['feesUsd', 'fee dikumpulkan'], ['investedUsd', 'modal diputar']]) {
      if (s[k] != null) L.push(`${lbl.padEnd(15)}: ${sgn(s[k])}`);
    }
    if (s.winRatePct != null) L.push(`menang         : ${nf(s.winRatePct, 0)}%`);
    if (w.open.length) {
      L.push('');
      L.push('<b>Posisi terbuka</b>');
      for (const p of w.open.slice(0, 10)) {
        L.push(`• ${esc(p.symbol0)}/${esc(p.symbol1)} #${esc(p.token_id)} — modal ${usd(p.invested_q)} · fee ${usd(p.feeShown)} · ${nf(p.ageHours || 0, 1)} jam`);
      }
    }
    if (w.closed.length) {
      L.push('');
      L.push('<b>Terakhir ditutup</b>');
      for (const p of w.closed.slice(0, 8)) {
        L.push(`• ${esc(p.symbol0)}/${esc(p.symbol1)} — ${sgn(p.pnl_q)} (${pct(p.pnlPct)}) · ${esc(ago(p.closed_ts))}`);
      }
    }
    return [L.filter((x) => x !== null).join('\n'), kb([
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

module.exports = { Telegram, parseVal, showVal, RULE_GROUPS, FORMS, COMMANDS, ALIAS };
