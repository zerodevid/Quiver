'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { RpcPool } = require('./rpc');
const { Store } = require('./db');
const { Chain } = require('./pools');
const { Engine } = require('./engine');
const { createServer } = require('./server');
const { scoutWallet } = require('./scout');
const { Telegram } = require('./telegram');
const { loadDotEnv, applyEnv, defaultEnvPath } = require('./env');

const ROOT = path.join(__dirname, '..');
// .env dimuat PALING AWAL: ia juga boleh berisi LPCOPY_CONFIG.
let DOTENV;
try { DOTENV = loadDotEnv(defaultEnvPath(ROOT)); }
catch (e) { console.error(`.env: ${e.message}`); process.exit(1); }
const CFG_PATH = process.env.LPCOPY_CONFIG || path.join(ROOT, 'config.json');

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.db = cfg.db || {}; cfg.db.path = path.isAbsolute(cfg.db.path || '') ? cfg.db.path : path.join(ROOT, cfg.db.path || 'data/lpcopy.db');
  return cfg;
}
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

async function main() {
  const cfg = loadCfg();
  const envMeta = applyEnv(cfg);
  const cmd = process.argv[2] || 'run';
  const store = new Store(cfg.db.path);
  const logFile = path.join(ROOT, 'logs', 'lpcopy.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = (msg) => {
    const line = `${ts()} ${msg}`;
    console.log(line);
    try { fs.appendFileSync(logFile, line + '\n'); } catch { /* abaikan */ }
  };
  // Hanya NAMA variabel yang dicatat — nilainya tidak pernah masuk log.
  if (DOTENV.file) {
    const ext = DOTENV.external.length ? ` · ${DOTENV.external.join(', ')} memakai nilai dari luar .env` : '';
    log(`.env dimuat: ${DOTENV.keys.length ? DOTENV.keys.join(', ') : 'belum ada yang diisi'}${ext}`);
    if (DOTENV.loose) log(`peringatan: izin ${DOTENV.file} terlalu longgar — jalankan: chmod 600 ${DOTENV.file}`);
  }
  if (envMeta.missing.length) log(`peringatan: RPC merujuk variabel yang tidak ada: ${[...new Set(envMeta.missing)].join(', ')}`);
  const rpc = new RpcPool(cfg.chain.endpoints, log, {
    max_inflight: cfg.chain.max_inflight || 3,
    dns_over_https: cfg.chain.dns_over_https !== false,
  });
  const chain = new Chain(rpc, store, log);

  // seed target dari config (hanya kalau belum ada)
  for (const t of cfg.targets || []) {
    store.run('INSERT OR IGNORE INTO targets(address,label,enabled,added_ts,rules) VALUES(?,?,?,?,?)',
      String(t.address).toLowerCase(), t.label || null, t.enabled === false ? 0 : 1, Date.now(),
      t.rules ? JSON.stringify(t.rules) : null);
  }

  if (cmd === 'scout') {
    const addr = (process.argv[3] || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { console.error('pakai: lp scout <alamat>'); process.exit(1); }
    const blocks = Number(process.argv[4] || cfg.scout?.blocks || 900_000);
    const ethUsd = await chain.ethUsd(cfg.prices?.eth_usd || 2500);
    process.stderr.write('memindai…');
    const r = await scoutWallet(rpc, chain, addr, {
      blocks, ethUsd, onProgress: (p) => process.stderr.write(`\rmemindai ${Math.round(p.scanned / p.total * 100)}%   `),
    });
    process.stderr.write('\r                       \r');
    console.log(`\nRAPOR WALLET ${addr}`);
    console.log(`  jendela pindai   : ${blocks.toLocaleString('id')} blok (~${(blocks * 0.101 / 3600).toFixed(1)} jam)`);
    console.log(`  posisi hidup     : ${r.positionsAlive} (pernah dilepas: ${r.positionsClosed})`);
    console.log(`  nilai posisi     : $${r.totalValueUsd.toFixed(2)}`);
    console.log(`  fee belum klaim  : $${r.totalUnclaimedFeeUsd.toFixed(2)}  (${r.feeRatioPct.toFixed(2)}% dari nilai)`);
    console.log(`  sedang in-range  : ${r.inRangePct.toFixed(0)}%`);
    console.log(`  median posisi    : $${r.medianPositionUsd.toFixed(0)}`);
    console.log(`  median lebar     : ${r.medianWidthPct.toFixed(0)}%`);
    console.log(`  median umur      : ${r.medianAgeHours.toFixed(1)} jam`);
    console.log('  pasangan:');
    for (const [k, v] of Object.entries(r.pairs).sort((a, b) => b[1].valueUsd - a[1].valueUsd).slice(0, 12)) {
      console.log(`    ${k.padEnd(22)} ${String(v.n).padStart(3)} posisi  $${v.valueUsd.toFixed(0).padStart(7)}  fee $${v.feeUsd.toFixed(2)}`);
    }
    return process.exit(0);
  }

  if (cmd === 'add') {
    const addr = (process.argv[3] || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { console.error('pakai: lp add <alamat> [label]'); process.exit(1); }
    store.run('INSERT OR IGNORE INTO targets(address,label,enabled,added_ts) VALUES(?,?,1,?)', addr, process.argv[4] || null, Date.now());
    console.log('ditambahkan:', addr);
    return process.exit(0);
  }
  if (cmd === 'list') {
    for (const t of store.all('SELECT * FROM targets')) {
      console.log(`${t.enabled ? '[ON ]' : '[off]'} ${t.address} ${t.label || ''}`);
    }
    return process.exit(0);
  }

  // ---- mode jalan --------------------------------------------------------
  // Kunci satu instance: dua proses berbagi DB yang sama akan saling menimpa kursor.
  const pidFile = path.join(ROOT, 'data', 'lpcopy.pid');
  if (fs.existsSync(pidFile)) {
    const old = Number(fs.readFileSync(pidFile, 'utf8').trim());
    let alive = false;
    try { process.kill(old, 0); alive = true; } catch { alive = false; }
    if (alive) { console.error(`Quiver sudah jalan (pid ${old}). Hentikan dulu: kill ${old}`); process.exit(1); }
  }
  fs.writeFileSync(pidFile, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(pidFile); } catch { /* sudah hilang */ } };
  process.on('exit', cleanup);

  const engine = new Engine({ rpc, store, chain, cfg, log });

  // Berhenti dengan tertib. pm2 restart (setiap deploy) mengirim SIGINT; dulu proses
  // langsung keluar — entry yang sudah zap tapi belum mint meninggalkan token telanjang,
  // tx keluar yang belum dibukukan menunggu sinkron berikutnya. Sekarang tidak ada
  // pekerjaan baru yang dimulai, dan pekerjaan yang sedang jalan ditunggu (maks 100 dtk;
  // kill_timeout pm2 di ecosystem.config.cjs 120 dtk). Sinyal kedua = keluar paksa.
  // (Didaftarkan sebelum init: backfill & sinkron awal juga bisa mengirim transaksi.)
  const timers = [];
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) { log(`${sig} kedua — keluar paksa`); cleanup(); process.exit(1); }
    stopping = true;
    for (const t of timers) clearInterval(t);
    const busy = !engine.idle();
    if (busy) log(`berhenti (${sig}) — menunggu transaksi yang sedang berjalan selesai…`);
    const clean = await engine.drain(100_000);
    log(clean ? 'berhenti' : 'berhenti — batas tunggu habis, sebagian pekerjaan dilanjutkan saat hidup lagi');
    try { telegram?.stop(); } catch { /* abaikan */ }
    cleanup();
    process.exit(0);
  };
  process.on('SIGINT', () => { shutdown('SIGINT'); });
  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  // Node mematikan proses pada promise rejection yang tak tertangani — satu janji "lepas"
  // yang gagal akan membunuh bot seketika, di tengah zap atau mint, tanpa berhenti tertib.
  // Dicatat saja; alur yang benar-benar penting punya penanganannya sendiri.
  process.on('unhandledRejection', (e) => {
    log(`PERINGATAN: promise tak tertangani — ${e?.stack || e}`);
    try { store.log('error', `promise tak tertangani: ${String(e?.message || e).slice(0, 300)}`); } catch { /* abaikan */ }
  });
  // Galat sinkron tak tertangkap: state proses tidak lagi bisa dipercaya — berhenti tertib
  // (menunggu transaksi berjalan), pm2 menyalakan ulang.
  process.on('uncaughtException', (e) => {
    log(`GALAT TAK TERTANGKAP: ${e?.stack || e}`);
    try { store.log('error', `galat tak tertangkap: ${String(e?.message || e).slice(0, 300)}`); } catch { /* abaikan */ }
    shutdown('uncaughtException');
  });

  // Bot Telegram memakai pintu API yang sama dengan dasbor (server.api). Ia dibuat
  // lebih dulu supaya halaman Pengaturan bisa menampilkan status & kode sambungnya,
  // tetapi baru menyentuh server saat sebuah tombol ditekan — saat itu server sudah ada.
  let server;
  const telegram = new Telegram({
    cfg, cfgPath: CFG_PATH, store, engine, log,
    api: (method, pathname, body, query) => server.api(method, pathname, body, query),
    shareCard: (opts) => server.shareCard(opts),
  });

  // Server dinyalakan LEBIH DULU: inisialisasi bisa memakan puluhan detik kalau RPC
  // sedang lambat, dan dashboard harus tetap bisa dibuka selama pemanasan.
  server = createServer({ engine, store, cfg, cfgPath: CFG_PATH, chain, rpc, log, telegram });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${cfg.server.port} sudah dipakai — kemungkinan Quiver lain masih jalan.`);
      log(`  cek: lsof -ti tcp:${cfg.server.port}   |   hentikan: lsof -ti tcp:${cfg.server.port} | xargs kill`);
    } else log(`server: ${e.message}`);
    process.exit(1);
  });
  server.listen(cfg.server.port, cfg.server.host, () => {
    log(`dashboard: http://${cfg.server.host}:${cfg.server.port}`);
  });

  telegram.start().catch((e) => log(`telegram: ${e.message}`));

  log('menyiapkan mesin…');
  await engine.init();
  await engine.syncPositions();
  try { const n = engine.backfillEquityPnl(); if (n) log(`ekuitas: PnL kumulatif direkonstruksi untuk ${n} titik lama`); } catch (e) { log(`ekuitas: ${e.message}`); }

  const pollMs = cfg.loop?.poll_ms || 1500;
  const syncMs = (cfg.loop?.sync_seconds || 30) * 1000;
  const eqMs = (cfg.loop?.equity_seconds || 300) * 1000;
  log(`mode: ${engine.dryRun() ? 'SIMULASI (tidak mengirim transaksi)' : 'LIVE'} | target aktif: ${engine.watcher.enabledSet().size}`);

  timers.push(
    setInterval(() => engine.tick().catch((e) => log(`tick: ${e.message}`)), pollMs),
    setInterval(() => engine.syncPositions().catch((e) => log(`sync: ${e.message}`)), syncMs),
    setInterval(() => engine.snapshotEquity().catch((e) => log(`equity: ${e.message}`)), eqMs),
    // Memecoin sisa yang ditolak dijual diburu terus: tiap detik dilihat apakah
    // jadwalnya (aturan `leftover_retry_sec`) sudah tiba; kalau ya, dikutip ulang.
    setInterval(() => engine.retryLeftovers().catch((e) => log(`jual sisa: ${e.message}`)), 1000),
    setInterval(() => store.prune(30), 3600_000),
  );

}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
