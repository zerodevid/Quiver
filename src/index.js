'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { RpcPool } = require('./rpc');
const { Store } = require('./db');
const { Chain } = require('./pools');
const { Engine } = require('./engine');
const { createServer } = require('./server');
const { scoutWallet } = require('./scout');
const { Telegram } = require('./telegram');
const { loadDotEnv, applyEnv, defaultEnvPath, writeCfg } = require('./env');
const { normalizeCfg, chainView, enabledChains, PRIMARY } = require('./multichain');
const { NETWORKS } = require('./networks');

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
// Label singkat chain di depan baris log, supaya log dua mesin di satu proses terbaca.
const TAG = { robinhood: 'RH', bsc: 'BSC' };
const tagOf = (key) => TAG[key] || key.toUpperCase().slice(0, 4);

async function main() {
  const cfg = loadCfg();
  // Bentuk multi-chain (chains.<nama>.*). Config lama dinormalkan di memori; ditulis
  // balik ke disk supaya bentuk barunya terlihat & bisa disunting (writeCfg menjaga
  // rahasia dari .env tidak ikut tertulis).
  const normNotes = normalizeCfg(cfg);
  const envMeta = applyEnv(cfg);
  const cmd = process.argv[2] || 'run';
  const store = new Store(cfg.db.path);
  const logFile = path.join(ROOT, 'logs', 'lpcopy.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Di bawah pm2 stdout sudah ditulis ke logs/<nama>.log (ecosystem.config.cjs) — untuk
  // instance "lpcopy" itu berkas yang SAMA, jadi setiap baris dulu tercatat dua kali dan
  // berkasnya tumbuh tanpa batas. Di bawah pm2 cukup stdout (rotasi: pm2-logrotate).
  // Tanpa pm2 (npm start) tetap ditulis ke berkas, diputar di 20 MB.
  const underPm2 = process.env.pm_id !== undefined;
  const LOG_MAX = 20 * 1024 * 1024;
  let logBytes = (() => { try { return fs.statSync(logFile).size; } catch { return 0; } })();
  const log = (msg) => {
    const line = `${ts()} ${msg}`;
    console.log(line);
    if (underPm2) return;
    try {
      if (logBytes > LOG_MAX) { fs.renameSync(logFile, `${logFile}.1`); logBytes = 0; }
      fs.appendFileSync(logFile, line + '\n');
      logBytes += Buffer.byteLength(line) + 1;
    } catch { /* abaikan */ }
  };
  const logFor = (key) => (msg) => log(`[${tagOf(key)}] ${msg}`);
  // Hanya NAMA variabel yang dicatat — nilainya tidak pernah masuk log.
  if (DOTENV.file) {
    const ext = DOTENV.external.length ? ` · ${DOTENV.external.join(', ')} memakai nilai dari luar .env` : '';
    log(`.env dimuat: ${DOTENV.keys.length ? DOTENV.keys.join(', ') : 'belum ada yang diisi'}${ext}`);
    if (DOTENV.loose) log(`peringatan: izin ${DOTENV.file} terlalu longgar — jalankan: chmod 600 ${DOTENV.file}`);
  }
  if (envMeta.missing.length) log(`peringatan: RPC merujuk variabel yang tidak ada: ${[...new Set(envMeta.missing)].join(', ')}`);
  if (normNotes.length) {
    for (const n of normNotes) log(`config: ${n}`);
    try { writeCfg(CFG_PATH, cfg); log('config: bentuk multi-chain disimpan ke config.json'); }
    catch (e) { log(`config: gagal menyimpan bentuk baru (${e.message}) — dipakai di memori saja`); }
  }

  // Satu set {rpc, chain, engine} per chain yang aktif. Semua berbagi Store (satu
  // database, kolom chain memisahkan datanya) dan kunci wallet yang sama.
  const keys = enabledChains(cfg);
  if (!keys.length) { console.error('tidak ada chain yang aktif di config (chains.<nama>.enabled)'); process.exit(1); }
  const primaryKey = keys.includes(PRIMARY) ? PRIMARY : keys[0];
  const nets = {};
  for (const key of keys) {
    const view = chainView(cfg, key);
    const clog = logFor(key);
    if (!view.chain.endpoints.length) { clog('tidak ada endpoint RPC di config — chain ini dilewati'); continue; }
    const rpc = new RpcPool(view.chain.endpoints, clog, {
      max_inflight: view.chain.max_inflight || 3,
      dns_over_https: view.chain.dns_over_https !== false,
    });
    const chain = new Chain(rpc, store, clog, key);
    nets[key] = { key, label: chain.label, cfg: view, rpc, chain, log: clog };
    // seed target dari config (hanya kalau belum ada)
    for (const t of view.targets || []) {
      store.run('INSERT OR IGNORE INTO targets(chain,address,label,enabled,added_ts,rules) VALUES(?,?,?,?,?,?)',
        key, String(t.address).toLowerCase(), t.label || null, t.enabled === false ? 0 : 1, Date.now(),
        t.rules ? JSON.stringify(t.rules) : null);
    }
  }
  if (!nets[primaryKey]) { console.error(`chain utama ${primaryKey} tidak bisa dinyalakan (tidak ada RPC?)`); process.exit(1); }

  // ---- perintah CLI (memakai chain lewat --chain=<nama>, bawaan chain utama) ----
  const cliChain = (process.argv.find((a) => a.startsWith('--chain=')) || '').slice(8) || primaryKey;
  const argv = process.argv.filter((a) => !a.startsWith('--chain='));
  if (cmd === 'scout') {
    const net = nets[cliChain]; if (!net) { console.error(`chain ${cliChain} tidak aktif`); process.exit(1); }
    const addr = (argv[3] || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { console.error('pakai: lp scout <alamat> [blok] [--chain=bsc]'); process.exit(1); }
    const blocks = Number(argv[4] || net.cfg.scout?.blocks || 900_000);
    const ethUsd = await net.chain.ethUsd(net.cfg.prices?.eth_usd || 2500);
    process.stderr.write('memindai…');
    const r = await scoutWallet(net.rpc, net.chain, addr, {
      blocks, ethUsd, onProgress: (p) => process.stderr.write(`\rmemindai ${Math.round(p.scanned / p.total * 100)}%   `),
    });
    process.stderr.write('\r                       \r');
    console.log(`\nRAPOR WALLET ${addr} (${net.label})`);
    console.log(`  jendela pindai   : ${blocks.toLocaleString('id')} blok (~${(blocks * net.chain.blockMs / 1000 / 3600).toFixed(1)} jam)`);
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
    const addr = (argv[3] || '').toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { console.error('pakai: lp add <alamat> [label] [--chain=bsc]'); process.exit(1); }
    if (!NETWORKS[cliChain]) { console.error(`chain ${cliChain} tidak dikenal`); process.exit(1); }
    store.run('INSERT OR IGNORE INTO targets(chain,address,label,enabled,added_ts) VALUES(?,?,?,1,?)', cliChain, addr, argv[4] || null, Date.now());
    console.log(`ditambahkan (${cliChain}):`, addr);
    return process.exit(0);
  }
  if (cmd === 'list') {
    for (const t of store.all('SELECT * FROM targets ORDER BY chain, added_ts')) {
      console.log(`${t.enabled ? '[ON ]' : '[off]'} ${t.chain.padEnd(9)} ${t.address} ${t.label || ''}`);
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

  for (const net of Object.values(nets)) {
    net.engine = new Engine({ rpc: net.rpc, store, chain: net.chain, cfg: net.cfg, log: net.log });
  }
  const engines = Object.values(nets).map((n) => n.engine);

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
    const busy = engines.some((e) => !e.idle());
    if (busy) log(`berhenti (${sig}) — menunggu transaksi yang sedang berjalan selesai…`);
    const clean = (await Promise.all(engines.map((e) => e.drain(100_000)))).every(Boolean);
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

  // Satu server API per chain (tidak listen sendiri) + satu pintu depan yang memilih
  // chain dari ?chain= / cookie lpcopy_chain, bawaan chain utama. Bot Telegram memakai
  // pintu API yang sama lewat servers[<chain>].api.
  const servers = {};
  const serverFor = (key) => servers[key] || servers[primaryKey];
  const telegram = new Telegram({
    cfg, cfgPath: CFG_PATH, store, engine: nets[primaryKey].engine, log, nets, primaryKey,
    api: (method, pathname, body, query, chainKey) => serverFor(chainKey).api(method, pathname, body, query),
    shareCard: (opts, chainKey) => serverFor(chainKey).shareCard(opts),
    chartCard: (opts, chainKey) => serverFor(chainKey).chartCard(opts),
    portfolioCard: (opts, chainKey) => serverFor(chainKey).portfolioCard(opts),
  });

  // Server dinyalakan LEBIH DULU: inisialisasi bisa memakan puluhan detik kalau RPC
  // sedang lambat, dan dashboard harus tetap bisa dibuka selama pemanasan.
  for (const net of Object.values(nets)) {
    servers[net.key] = createServer({ engine: net.engine, store, cfg: net.cfg, cfgPath: CFG_PATH, chain: net.chain, rpc: net.rpc, log: net.log, telegram, nets });
  }
  const pickChain = (req, url) => {
    const q = url.searchParams.get('chain');
    if (q && servers[q]) return q;
    const m = /(?:^|;\s*)lpcopy_chain=([a-z0-9_-]+)/i.exec(req.headers.cookie || '');
    return m && servers[m[1]] ? m[1] : primaryKey;
  };
  const front = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    servers[pickChain(req, url)].emit('request', req, res);
  });
  front.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log(`port ${cfg.server.port} sudah dipakai — kemungkinan Quiver lain masih jalan.`);
      log(`  cek: lsof -ti tcp:${cfg.server.port}   |   hentikan: lsof -ti tcp:${cfg.server.port} | xargs kill`);
    } else log(`server: ${e.message}`);
    process.exit(1);
  });
  front.listen(cfg.server.port, cfg.server.host, () => {
    log(`dashboard: http://${cfg.server.host}:${cfg.server.port} — chain: ${Object.keys(nets).join(', ')} (utama ${primaryKey})`);
  });

  telegram.start().catch((e) => log(`telegram: ${e.message}`));

  // Mesin dinyalakan bersamaan — tiap chain punya kolam RPC sendiri, dan pemanasan
  // chain yang RPC-nya lambat tidak boleh menahan chain lain. Masing-masing gagal
  // sendiri-sendiri tanpa menjatuhkan yang lain.
  await Promise.all(Object.values(nets).map(async (net) => {
    const { engine, cfg: view, log: clog } = net;
    clog('menyiapkan mesin…');
    // init() gagal (RPC chain itu sedang tumbang) tidak boleh menjatuhkan chain lain,
    // dan tick TIDAK boleh jalan sebelum kursor terbaca — kursor 0 berarti memindai
    // dari genesis. Dicoba lagi tiap menit sampai berhasil.
    net.ready = false;
    const boot = async () => {
      try {
        await engine.init();
        await engine.syncPositions();
        try { const n = engine.backfillEquityPnl(); if (n) clog(`ekuitas: PnL kumulatif direkonstruksi untuk ${n} titik lama`); } catch (e) { clog(`ekuitas: ${e.message}`); }
        net.ready = true;
        clog(`mode: ${engine.dryRun() ? 'SIMULASI (tidak mengirim transaksi)' : 'LIVE'} | target aktif: ${engine.watcher.enabledSet().size}${net.chain.verified ? '' : ' | alamat kontrak BELUM diverifikasi on-chain'}`);
      } catch (e) {
        clog(`mesin gagal dinyalakan: ${e.message} — dicoba lagi 60 detik lagi`);
        if (!stopping) setTimeout(boot, 60_000).unref?.();
      }
    };
    await boot();
    const pollMs = view.loop?.poll_ms || 1500;
    const syncMs = (view.loop?.sync_seconds || 30) * 1000;
    const eqMs = (view.loop?.equity_seconds || 300) * 1000;
    const when = (fn, what) => () => { if (net.ready) fn().catch((e) => clog(`${what}: ${e.message}`)); };
    timers.push(
      setInterval(when(() => engine.tick(), 'tick'), pollMs),
      setInterval(when(() => engine.syncPositions(), 'sync'), syncMs),
      setInterval(when(() => engine.snapshotEquity(), 'equity'), eqMs),
      // Memecoin sisa yang ditolak dijual diburu terus: tiap detik dilihat apakah
      // jadwalnya (aturan `leftover_retry_sec`) sudah tiba; kalau ya, dikutip ulang.
      setInterval(when(() => engine.retryLeftovers(), 'jual sisa'), 1000),
    );
  }));
  timers.push(setInterval(() => store.prune(30), 3600_000));
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
