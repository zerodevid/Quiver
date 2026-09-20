'use strict';
// Rahasia lewat .env — supaya config.json bisa dibagikan, dicadangkan, atau dikirim
// ke server tanpa ikut membawa token dan kunci.
//
// Urutan prioritas: variabel lingkungan yang sudah ada (mis. dari pm2 / shell) >
// isi berkas .env > nilai di config.json. Nilai yang datang dari .env TIDAK PERNAH
// ditulis balik ke config.json: setiap penulisan config lewat writeCfg(), yang
// mengembalikan kolom-kolom itu ke isi berkas aslinya sebelum menyimpan.
//
// Yang bisa diisi (lihat .env.example):
//   LPCOPY_PRIVATE_KEY          kunci privat wallet bot (menggantikan wallet.key_file)
//   LPCOPY_AUTH_TOKEN           token masuk dasbor           -> server.auth_token
//   LPCOPY_TELEGRAM_BOT_TOKEN   token bot dari @BotFather    -> telegram.bot_token
//   LPCOPY_NTFY_TOPIC           topik ntfy.sh                -> notify.ntfy_topic
//   LPCOPY_GMGN_API_KEY         API key OpenAPI GMGN         -> gmgn.api_key
//   variabel apa pun            dirujuk dari URL/header RPC sebagai ${NAMA}, mis.
//                               "https://…alchemy.com/v2/${ALCHEMY_KEY}"
const fs = require('node:fs');
const path = require('node:path');

// Kolom config yang bisa diambil alih .env: [variabel, jalur di config].
const FIELDS = [
  ['LPCOPY_AUTH_TOKEN', ['server', 'auth_token']],
  ['LPCOPY_TELEGRAM_BOT_TOKEN', ['telegram', 'bot_token']],
  ['LPCOPY_NTFY_TOPIC', ['notify', 'ntfy_topic']],
  ['LPCOPY_GMGN_API_KEY', ['gmgn', 'api_key']],
];
const META = Symbol('lpcopy.env');

// Pengurai .env kecil: KEY=nilai, baris kosong dan # komentar diabaikan, nilai boleh
// diapit '…' (apa adanya) atau "…" (\n dikenali), "export KEY=…" diterima.
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    else v = v.replace(/\s+#.*$/, '').trim();          // komentar di ujung baris
    out[m[1]] = v;
  }
  return out;
}

// Muat .env ke process.env tanpa menimpa variabel yang sudah ada. Mengembalikan
// daftar nama yang dimuat (bukan nilainya) untuk dicatat di log.
function loadDotEnv(file) {
  if (!file || !fs.existsSync(file)) return { file: null, keys: [], external: [] };
  const vars = parseEnv(fs.readFileSync(file, 'utf8'));
  const st = fs.statSync(file);
  const loose = (st.mode & 0o077) !== 0;
  // Kunci privat di berkas yang bisa dibaca pengguna lain = bocor. Sama kerasnya
  // dengan pemeriksaan wallet.key_file di executor.
  if (loose && vars.LPCOPY_PRIVATE_KEY) throw new Error(`izin ${file} terlalu longgar untuk menyimpan kunci privat — jalankan: chmod 600 ${file}`);
  const keys = [], external = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === '') continue;                                   // kosong = tidak diisi
    if (process.env[k] !== undefined) { external.push(k); continue; }
    process.env[k] = v;
    keys.push(k);
  }
  return { file, keys, external, loose };
}

const getAt = (o, p) => p.reduce((a, k) => (a == null ? undefined : a[k]), o);
function setAt(o, p, v) {
  let cur = o;
  for (const k of p.slice(0, -1)) cur = cur[k] = cur[k] && typeof cur[k] === 'object' ? cur[k] : {};
  cur[p[p.length - 1]] = v;
}
const TPL = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Semua daftar endpoint RPC di config: per chain (cfg.chains.<nama>.chain.endpoints)
// dan bentuk lama satu-chain (cfg.chain.endpoints) selama belum dinormalkan.
function allEndpoints(cfg) {
  const out = [];
  if (Array.isArray(cfg?.chain?.endpoints)) out.push(...cfg.chain.endpoints);
  for (const c of Object.values(cfg?.chains || {})) if (Array.isArray(c?.chain?.endpoints)) out.push(...c.chain.endpoints);
  return out;
}

// Terapkan variabel lingkungan ke cfg (di tempat). Catatan tentang apa yang diambil
// alih disimpan di properti simbol — tidak ikut JSON.stringify.
function applyEnv(cfg, env = process.env) {
  const meta = { fields: [], templates: new Map(), missing: [] };
  for (const [name, p] of FIELDS) {
    const v = env[name];
    if (v == null || v === '') continue;
    meta.fields.push({ name, path: p, value: v, fileValue: getAt(cfg, p) ?? null });
    setAt(cfg, p, v);
  }
  // ${NAMA} di URL dan header RPC. Yang variabelnya tidak ada dibiarkan apa adanya
  // (endpoint itu akan gagal dan terlihat di halaman Pengaturan) dan dicatat.
  const sub = (s) => {
    if (typeof s !== 'string' || !s.includes('${')) return s;
    const r = s.replace(TPL, (all, n) => {
      if (env[n] == null || env[n] === '') { meta.missing.push(n); return all; }
      return env[n];
    });
    if (r !== s) meta.templates.set(r, s);
    return r;
  };
  for (const e of allEndpoints(cfg)) {
    e.url = sub(e.url);
    if (e.headers && typeof e.headers === 'object') for (const k of Object.keys(e.headers)) e.headers[k] = sub(e.headers[k]);
  }
  Object.defineProperty(cfg, META, { value: meta, enumerable: false, configurable: true });
  return meta;
}

// Nama variabel yang sedang mengatur sebuah kolom, atau null. Dipakai halaman
// Pengaturan untuk menolak perubahan yang akan ditimpa lagi saat restart.
function envName(cfg, dotted) {
  const f = cfg?.[META]?.fields.find((x) => x.path.join('.') === dotted);
  return f ? f.name : null;
}
const privateKeyFromEnv = () => !!process.env.LPCOPY_PRIVATE_KEY;

// Salinan cfg yang aman ditulis ke disk: kolom dari .env dikembalikan ke nilai
// berkas aslinya, dan URL/header RPC yang berisi rahasia kembali ke bentuk ${NAMA}.
function cfgForDisk(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  const meta = cfg?.[META];
  if (!meta) return out;
  for (const f of meta.fields) {
    // Kalau nilainya sudah diubah dari luar (seharusnya ditolak), jangan menebak.
    if (getAt(out, f.path) === f.value) setAt(out, f.path, f.fileValue);
  }
  const back = (s) => (typeof s === 'string' && meta.templates.has(s) ? meta.templates.get(s) : s);
  for (const e of allEndpoints(out)) {
    e.url = back(e.url);
    if (e.headers && typeof e.headers === 'object') for (const k of Object.keys(e.headers)) e.headers[k] = back(e.headers[k]);
  }
  return out;
}

// Satu-satunya jalan menulis config.json. Izin 600: isinya tetap bisa memuat rahasia
// bagi yang belum pindah ke .env.
function writeCfg(cfgPath, cfg) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfgForDisk(cfg), null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* abaikan */ }
}

const defaultEnvPath = (root) => process.env.LPCOPY_ENV || path.join(root, '.env');

module.exports = { parseEnv, loadDotEnv, applyEnv, cfgForDisk, writeCfg, envName, privateKeyFromEnv, defaultEnvPath, allEndpoints, FIELDS };
