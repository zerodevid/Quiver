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
const { setupNeeded, runSetup } = require('./setup');
const { applyPendingRestore } = require('./backup');
const { NETWORKS, isSolana, normAddr, addrHint } = require('./networks');
// The Solana engine is loaded only when a Solana chain is enabled: its SDKs (Meteora/Orca/
// Raydium) are heavy and an EVM-only instance does not need them.
const solanaStack = () => ({
  SolanaRpc: require('./solana/rpc').SolanaRpc,
  SolanaChain: require('./solana/chain').SolanaChain,
  SolanaEngine: require('./solana/engine').SolanaEngine,
});

const ROOT = path.join(__dirname, '..');
// .env is loaded FIRST: it may also contain LPCOPY_CONFIG.
let DOTENV;
try { DOTENV = loadDotEnv(defaultEnvPath(ROOT)); }
catch (e) { console.error(`.env: ${e.message}`); process.exit(1); }
const CFG_PATH = process.env.LPCOPY_CONFIG || path.join(ROOT, 'config.json');

function loadCfg() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
  cfg.db = cfg.db || {}; cfg.db.path = path.isAbsolute(cfg.db.path || '') ? cfg.db.path : path.join(ROOT, cfg.db.path || 'data/lpcopy.db');
  return cfg;
}
// Single-instance lock: the pid of another Quiver process that is still alive, or 0.
const PID_FILE = path.join(ROOT, 'data', 'lpcopy.pid');
function otherInstanceAlive() {
  if (!fs.existsSync(PID_FILE)) return 0;
  const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
  if (!pid || pid === process.pid) return 0;
  try { process.kill(pid, 0); return pid; } catch { return 0; }
}
const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
// Short chain label before the log line, so logs of several engines in one process are readable.
const TAG = { robinhood: 'RH', bsc: 'BSC', solana: 'SOL', ethereum: 'ETH', base: 'BASE', arbitrum: 'ARB', optimism: 'OP', polygon: 'POLY', avalanche: 'AVAX' };
const tagOf = (key) => TAG[key] || key.toUpperCase().slice(0, 4);

async function main() {
  // Initial setup. Without config.json nothing can be started, so the wizard comes
  // first (a small server on the same port), then the normal boot — in the same process,
  // without a restart. An existing config never triggers this by itself; repeat
  // with `lp setup` or LPCOPY_SETUP=1.
  if (setupNeeded({ cfgPath: CFG_PATH, cmd: process.argv[2] })) {
    const requested = process.argv[2] === 'setup' || process.env.LPCOPY_SETUP === '1';
    await runSetup({ root: ROOT, cfgPath: CFG_PATH, envPath: defaultEnvPath(ROOT), requested, log: console.log });
    try { DOTENV = loadDotEnv(defaultEnvPath(ROOT)); } catch (e) { console.error(`.env: ${e.message}`); process.exit(1); }
  }
  // Restore from a backup (Settings → Backup): config & database are swapped here,
  // before anything opens them. Only by the bot process itself, not CLI commands
  // (`lp scout` etc.) that can run alongside a live bot.
  if ((process.argv[2] || 'run') === 'run' && !otherInstanceAlive()) {
    applyPendingRestore(CFG_PATH, console.log);
    applyPendingRestore(loadCfg().db.path, console.log);
  }
  const cfg = loadCfg();
  // Multi-chain shape (chains.<name>.*). An old config is normalised in memory; written
  // back to disk so the new shape is visible & editable (writeCfg keeps
  // secrets from .env from being written).
  const normNotes = normalizeCfg(cfg);
  const envMeta = applyEnv(cfg);
  const cmd = process.argv[2] || 'run';
  const store = new Store(cfg.db.path);
  const logFile = path.join(ROOT, 'logs', 'lpcopy.log');
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  // Under pm2 stdout is already written to logs/<name>.log (ecosystem.config.cjs) — for the
  // "lpcopy" instance that is the SAME file, so every line used to be recorded twice and the
  // file grew without bound. Under pm2 stdout is enough (rotation: pm2-logrotate).
  // Without pm2 (npm start) it is still written to a file, rotated at 20 MB.
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
  // Only the variable NAMES are recorded — their values never enter the log.
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

  // One {rpc, chain, engine} set per active chain. All share the Store (one
  // database, the chain column separates its data) and the same wallet key.
  const keys = enabledChains(cfg);
  if (!keys.length) { console.error('tidak ada chain yang aktif di config (chains.<nama>.enabled)'); process.exit(1); }
  const primaryKey = keys.includes(PRIMARY) ? PRIMARY : keys[0];
  const nets = {};
  // Builds the {rpc, chain} half of one chain's stack; null (with a reason in `buildNet.why`)
  // when it cannot be built. Used at boot and when a chain is switched on from Settings.
  function buildNet(key) {
    buildNet.why = '';
    const view = chainView(cfg, key);
    const clog = logFor(key);
    if (!view.chain.endpoints.length) { buildNet.why = 'tidak ada endpoint RPC'; clog('tidak ada endpoint RPC di config — chain ini dilewati'); return null; }
    let rpc, chain;
    if (isSolana(key)) {
      const S = solanaStack();
      try { rpc = new S.SolanaRpc(view.chain.endpoints, clog); }
      catch (e) { buildNet.why = e.message; clog(`${e.message} — chain ini dilewati`); return null; }
      chain = new S.SolanaChain(rpc, store, clog, key);
    } else {
      rpc = new RpcPool(view.chain.endpoints, clog, {
        max_inflight: view.chain.max_inflight || 3,
        dns_over_https: view.chain.dns_over_https !== false,
        // Answers that are already final (past blocks) are stored in the same database —
        // the limits & depth can be tuned via chains.<name>.chain.cache.
        cache: { ...(view.chain.cache || {}), store, chain: key },
      });
      chain = new Chain(rpc, store, clog, key);
    }
    const net = { key, label: chain.label, cfg: view, rpc, chain, log: clog, timers: [], stopped: false };
    // seed targets from the config (only if not present yet). Solana addresses are case-sensitive.
    for (const t of view.targets || []) {
      const a = normAddr(key, t.address);
      if (!a) { clog(`target ${t.address} dilewati: bukan ${addrHint(key)}`); continue; }
      store.run('INSERT OR IGNORE INTO targets(chain,address,label,enabled,added_ts,rules) VALUES(?,?,?,?,?,?)',
        key, a, t.label || null, t.enabled === false ? 0 : 1, Date.now(),
        t.rules ? JSON.stringify(t.rules) : null);
    }
    return net;
  }
  for (const key of keys) { const net = buildNet(key); if (net) nets[key] = net; }
  if (!nets[primaryKey]) { console.error(`chain utama ${primaryKey} tidak bisa dinyalakan (tidak ada RPC?)`); process.exit(1); }

  // ---- CLI commands (using a chain via --chain=<name>, default the main chain) ----
  const cliChain = (process.argv.find((a) => a.startsWith('--chain=')) || '').slice(8) || primaryKey;
  const argv = process.argv.filter((a) => !a.startsWith('--chain='));
  if (cmd === 'scout') {
    const net = nets[cliChain]; if (!net) { console.error(`chain ${cliChain} tidak aktif`); process.exit(1); }
    const sol = isSolana(cliChain);
    const addr = normAddr(cliChain, argv[3]);
    if (!addr) { console.error(`pakai: lp scout <alamat> [blok] [--chain=bsc|solana] — ${addrHint(cliChain)}`); process.exit(1); }
    const blocks = Number(argv[4] || net.cfg.scout?.blocks || 900_000);
    const ethUsd = await net.chain.ethUsd(net.cfg.prices?.eth_usd || 2500);
    process.stderr.write('memindai…');
    const onProgress = (p) => process.stderr.write(`\rmemindai ${Math.round(p.scanned / p.total * 100)}%   `);
    const r = sol
      ? await require('./solana/scout').scoutWalletSol(net.rpc, net.chain, addr, { ethUsd, store, onProgress })
      : await scoutWallet(net.rpc, net.chain, addr, { blocks, ethUsd, onProgress });
    process.stderr.write('\r                       \r');
    console.log(`\nRAPOR WALLET ${addr} (${net.label})`);
    if (!sol) console.log(`  jendela pindai   : ${blocks.toLocaleString('id')} blok (~${(blocks * net.chain.blockMs / 1000 / 3600).toFixed(1)} jam)`);
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
    if (!NETWORKS[cliChain]) { console.error(`chain ${cliChain} tidak dikenal`); process.exit(1); }
    const addr = normAddr(cliChain, argv[3]);
    if (!addr) { console.error(`pakai: lp add <alamat> [label] [--chain=bsc|solana] — ${addrHint(cliChain)}`); process.exit(1); }
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

  // ---- run mode --------------------------------------------------------
  // Single-instance lock: two processes sharing the same DB would overwrite each other's cursor.
  const old = otherInstanceAlive();
  if (old) { console.error(`Quiver sudah jalan (pid ${old}). Hentikan dulu: kill ${old}`); process.exit(1); }
  fs.writeFileSync(PID_FILE, String(process.pid));
  const cleanup = () => { try { fs.unlinkSync(PID_FILE); } catch { /* already gone */ } };
  process.on('exit', cleanup);

  const makeEngine = (net) => {
    const E = isSolana(net.key) ? solanaStack().SolanaEngine : Engine;
    net.engine = new E({ rpc: net.rpc, store, chain: net.chain, cfg: net.cfg, log: net.log });
  };
  for (const net of Object.values(nets)) makeEngine(net);
  // Live list: chains can be switched on and off while the bot runs.
  const allEngines = () => Object.values(nets).map((n) => n.engine).filter(Boolean);

  // Stop in an orderly way. pm2 restart (every deploy) sends SIGINT; the process used to
  // exit right away — an entry that had zapped but not minted left a naked token,
  // an exit tx not yet booked waited for the next sync. Now no new
  // work is started, and work in progress is waited for (max 100 s;
  // pm2's kill_timeout in ecosystem.config.cjs is 120 s). A second signal = forced exit.
  // (Registered before init: backfill & the initial sync can also send transactions.)
  const timers = [];
  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) { log(`${sig} kedua — keluar paksa`); cleanup(); process.exit(1); }
    stopping = true;
    for (const t of timers) clearInterval(t);
    for (const n of Object.values(nets)) { n.stopped = true; n.timers.forEach(clearInterval); }
    const engines = allEngines();
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
  // Node kills the process on an unhandled promise rejection — a single "loose" promise
  // that fails would kill the bot instantly, in the middle of a zap or mint, without stopping in an orderly way.
  // Just recorded; flows that truly matter have their own handling.
  process.on('unhandledRejection', (e) => {
    log(`PERINGATAN: promise tak tertangani — ${e?.stack || e}`);
    try { store.log('error', `promise tak tertangani: ${String(e?.message || e).slice(0, 300)}`); } catch { /* abaikan */ }
  });
  // An uncaught synchronous error: the process state can no longer be trusted — stop in an orderly way
  // (waiting for running transactions), pm2 restarts it.
  process.on('uncaughtException', (e) => {
    log(`GALAT TAK TERTANGKAP: ${e?.stack || e}`);
    try { store.log('error', `galat tak tertangkap: ${String(e?.message || e).slice(0, 300)}`); } catch { /* abaikan */ }
    shutdown('uncaughtException');
  });

  // One API server per chain (does not listen by itself) + one front door that picks the
  // chain from ?chain= / the lpcopy_chain cookie, defaulting to the main chain. The Telegram bot uses the
  // same API door via servers[<chain>].api.
  const servers = {};
  const serverFor = (key) => servers[key] || servers[primaryKey];
  const telegram = new Telegram({
    cfg, cfgPath: CFG_PATH, store, engine: nets[primaryKey].engine, log, nets, primaryKey,
    api: (method, pathname, body, query, chainKey) => serverFor(chainKey).api(method, pathname, body, query),
    shareCard: (opts, chainKey) => serverFor(chainKey).shareCard(opts),
    chartCard: (opts, chainKey) => serverFor(chainKey).chartCard(opts),
    portfolioCard: (opts, chainKey) => serverFor(chainKey).portfolioCard(opts),
  });

  // The server is started FIRST: initialisation can take tens of seconds if the RPC
  // is slow, and the dashboard must stay openable during warm-up.
  // Switch a chain on or off while the bot runs (Settings → Chain), no restart. Switching on
  // builds the stack and warms it up in the background; switching off stops its timers and waits
  // for in-flight work (an entry that zapped but has not minted yet) before dropping it.
  const chainControl = {
    primaryKey,
    async start(key) {
      if (nets[key]) return { ok: true };
      const net = buildNet(key);
      if (!net) return { error: `${NETWORKS[key]?.label || key} belum bisa dinyalakan: ${buildNet.why}` };
      nets[key] = net;
      makeEngine(net);
      makeServer(net);
      log(`chain ${key} dinyalakan dari Pengaturan`);
      runNet(net).catch((e) => net.log(`mesin gagal dinyalakan: ${e.message}`));
      return { ok: true };
    },
    async stop(key) {
      const net = nets[key];
      if (!net) return { ok: true };
      if (key === primaryKey) return { error: `${net.label} adalah chain utama dan tidak bisa dimatikan dari sini` };
      net.stopped = true;
      net.timers.forEach(clearInterval);
      net.timers.length = 0;
      const clean = await net.engine.drain(100_000);
      delete nets[key];
      delete servers[key];
      log(`chain ${key} dimatikan dari Pengaturan${clean ? '' : ' (masih ada pekerjaan yang belum selesai, dilanjutkan saat chain dinyalakan lagi)'}`);
      return { ok: true };
    },
  };
  const makeServer = (net) => {
    servers[net.key] = createServer({ engine: net.engine, store, cfg: net.cfg, cfgPath: CFG_PATH, chain: net.chain, rpc: net.rpc, log: net.log, telegram, nets, chainControl });
  };
  for (const net of Object.values(nets)) makeServer(net);
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

  // The engines are started together — each chain has its own RPC pool, and warming up a
  // chain whose RPC is slow must not hold up the other chains. Each fails
  // on its own without bringing down the others.
  async function runNet(net) {
    const { engine, cfg: view, log: clog } = net;
    clog('menyiapkan mesin…');
    // init() failing (that chain's RPC is down) must not bring down other chains,
    // and the tick must NOT run before the cursor is read — a cursor of 0 means scanning
    // from genesis. Retried every minute until it succeeds.
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
        if (!stopping && !net.stopped) setTimeout(boot, 60_000).unref?.();
      }
    };
    await boot();
    if (net.stopped) return;
    const pollMs = view.loop?.poll_ms || 1500;
    const syncMs = (view.loop?.sync_seconds || 30) * 1000;
    const eqMs = (view.loop?.equity_seconds || 300) * 1000;
    const when = (fn, what) => () => { if (net.ready) fn().catch((e) => clog(`${what}: ${e.message}`)); };
    net.timers.push(
      setInterval(when(() => engine.tick(), 'tick'), pollMs),
      setInterval(when(() => engine.syncPositions(), 'sync'), syncMs),
      setInterval(when(() => engine.snapshotEquity(), 'equity'), eqMs),
      // Leftover memecoins whose sale was rejected are pursued continuously: every second we check whether
      // the schedule (the `leftover_retry_sec` rule) has arrived; if so, it is re-quoted.
      setInterval(when(() => engine.retryLeftovers(), 'jual sisa'), 1000),
    );
  }
  await Promise.all(Object.values(nets).map(runNet));
  timers.push(setInterval(() => {
    store.prune(30);
    // RPC cache: drop expired entries and those past the size limit.
    for (const net of Object.values(nets)) {
      try { net.rpc.cache?.sweep(); } catch (e) { net.log(`cache rpc: ${e.message}`); }
    }
  }, 3600_000));
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
