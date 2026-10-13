'use strict';
// Initial setup — the only way from "git clone" to a running bot, without
// editing JSON by hand.
//
// Called by index.js BEFORE the config is read: if config.json does not exist (or
// setup is forced via `lp setup` / LPCOPY_SETUP=1), a small server with a wizard is started here,
// and the normal boot waits until the person is done. After the
// files are written, this server is closed and the same process goes on to start the bot —
// no restart needed.
//
// Where things are stored (following the rule already used by env.js):
//   secrets (dashboard token, bot token, API key)  -> .env, mode 600
//   wallet private key                             -> wallet.key_file (~/.lpcopy/key), 600
//   the rest (port, chain, RPC, rules, targets)    -> config.json, 600
// The private key is deliberately NOT put in .env: LPCOPY_PRIVATE_KEY disables the replace/detach
// wallet buttons on the dashboard, and someone who has just installed may not know that.
//
// The wizard page is rendered by the server (src/setup-page.js), standalone without a build —
// `npm ci && npm start` on an empty machine is enough, web/dist need not exist yet.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { NETWORKS, build, normAddr, isSolana } = require('./networks');
const { normalizeCfg, chainTemplate, PRIMARY } = require('./multichain');
const { probeRpc, maskUrl, hasSecret } = require('./settings');
const { CURRENCIES, CURRENCIES_EN } = require('./fx');
const { SETUP_PAGE } = require('./setup-page');
const { allEndpoints } = require('./env');
const { parseBackup, stageRestore, applyPendingRestore } = require('./backup');
const os = require('node:os');

const SETUP_VERSION = 1;

// Setup runs if config.json does not exist, or it is requested explicitly. A config
// that ALREADY exists never triggers the wizard by itself — an old instance installed
// before this wizard existed must not suddenly land on the setup page.
function setupNeeded({ cfgPath, cmd = null, env = process.env }) {
  if (cmd === 'setup' || env.LPCOPY_SETUP === '1') return true;
  return !fs.existsSync(cfgPath);
}

// An instance that HAS run before and then lost config.json is not a fresh install —
// it is an accident (deleted by mistake, rsync aimed wrong). Serving the wizard there means
// pm2 reports "online" while the bot is dead, and one click of "Save" overwrites the old config
// on top of a database that already contains positions. So: a hard stop, unless setup
// is explicitly requested (`lp setup` / LPCOPY_SETUP=1).
function setupBlocked({ root, cfgPath, requested = false, dbPath = null }) {
  if (requested) return null;
  if (fs.existsSync(cfgPath)) return null;
  const db = dbPath || path.join(root, 'data', 'lpcopy.db');
  if (!fs.existsSync(db)) return null;
  return [
    `config.json tidak ada, tapi ${db} sudah berisi riwayat instance ini.`,
    'Ini config yang hilang, bukan pemasangan baru — wizard TIDAK dijalankan supaya config',
    'lama tidak tertimpa di atas database yang sudah terisi.',
    '  kembalikan config.json dari cadangan, atau kalau memang mau memasang ulang:',
    '  LPCOPY_SETUP=1 npm start',
  ].join('\n');
}

// ---- .env writer ---------------------------------------------------------
// Values containing spaces/#/quotes are wrapped in double quotes so parseEnv (env.js)
// reads them whole.
const quoteEnv = (v) => (/[\s#'"\\]/.test(v) ? `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(v));

// Insert values into the .env contents: lines that already exist are replaced in place (comments and
// the order of the example file stay intact), ones that do not are appended at the end. An empty value
// does NOT delete anything — a wizard that leaves a field empty means "do not change".
function upsertEnv(text, vals) {
  let out = String(text || '');
  const tail = [];
  for (const [k, v] of Object.entries(vals)) {
    if (v == null || v === '') continue;
    const line = `${k}=${quoteEnv(v)}`;
    const re = new RegExp(`^(?:export[ \\t]+)?${k}[ \\t]*=.*$`, 'm');
    // The replacement is a function: a token can contain $& or $1, which would be interpreted
    // as a capture reference if passed as a string.
    if (re.test(out)) out = out.replace(re, () => line);
    else tail.push(line);
  }
  if (tail.length) {
    out = out.replace(/\s*$/, '\n');
    out += `\n# Ditulis oleh pemasangan Quiver ${new Date().toISOString().slice(0, 10)}\n${tail.join('\n')}\n`;
  }
  return out;
}

function writeEnvFile({ envPath, examplePath, vals }) {
  const base = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8')
    : examplePath && fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  fs.writeFileSync(envPath, upsertEnv(base, vals), { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* abaikan */ }
}

// ---- wallet key writer -------------------------------------------------
const keyPathOf = (cfg) => String(cfg?.wallet?.key_file || '~/.lpcopy/key').replace(/^~/, process.env.HOME || '');
// Solana (ed25519) key: a separate file, the same one src/solana/wallet.js reads.
const solKeyPathOf = (cfg) => String(cfg?.wallet?.solana_key_file || '~/.lpcopy/solana-key').replace(/^~/, process.env.HOME || '');
const defaultBlock = (key) => chainTemplate(key);

// An old key is never silently overwritten — the same rule as the Settings page:
// moved to a dated backup file first.
function writeKeyFile(p, pk) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(p)) {
    backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, backup);
  }
  fs.writeFileSync(p, pk, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* abaikan */ }
  return backup;
}

// ---- config builder ------------------------------------------------------
const numOr = (v, dflt) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : dflt);

// Endpoints from the browser are sanitised: only known fields, only https (or
// http to the local machine for a local node).
function cleanEndpoint(e) {
  const url = String(e?.url || '').trim();
  let u;
  try { u = new URL(url); } catch { throw new Error(`URL RPC tidak valid: ${url.slice(0, 60)}`); }
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error(`URL RPC harus https: ${maskUrl(url)}`);
  const out = { url };
  if (Number(e.max_batch) > 0) out.max_batch = Math.min(200, Math.round(Number(e.max_batch)));
  if (e.no_logs) out.no_logs = true;
  if (Number(e.max_log_blocks) > 0) out.max_log_blocks = Math.round(Number(e.max_log_blocks));
  if (e.archive) out.archive = true;
  // Solana endpoint flags (src/solana/rpc.js)
  if (e.no_gpa) out.no_gpa = true;
  if (e.no_history) out.no_history = true;
  if (e.headers && typeof e.headers === 'object') {
    const h = {};
    for (const [k, v] of Object.entries(e.headers)) if (String(v || '').trim()) h[String(k).slice(0, 64)] = String(v);
    if (Object.keys(h).length) out.headers = h;
  }
  if (e.catatan) out.catatan = String(e.catatan).slice(0, 200);
  return out;
}

// Final config = the example file (or the existing config, if setup is repeated)
// overwritten by the wizard answers. A pure function so it can be tested without starting a server.
function buildConfig({ template, base = null, answers }) {
  const cfg = JSON.parse(JSON.stringify(base || template));
  normalizeCfg(cfg);                                   // old single-chain config -> chains.*
  const tpl = JSON.parse(JSON.stringify(template));
  normalizeCfg(tpl);
  cfg.chains = cfg.chains || {};

  cfg.display = cfg.display || {};
  cfg.display.currency = answers.display?.currency || null;

  cfg.server = cfg.server || {};
  cfg.server.port = numOr(answers.server?.port, cfg.server.port || 8799);
  cfg.server.host = String(answers.server?.host || cfg.server.host || '127.0.0.1');
  // Secrets also written to .env are emptied in the config: one field, one source.
  if (answers.secrets?.authToken) cfg.server.auth_token = null;
  if (answers.secrets?.publicUrl) cfg.server.public_url = null;
  if (answers.secrets?.telegramToken) { cfg.telegram = cfg.telegram || {}; cfg.telegram.bot_token = null; }
  if (answers.secrets?.ntfyTopic) { cfg.notify = cfg.notify || {}; cfg.notify.ntfy_topic = null; }
  if (answers.secrets?.gmgnKey) { cfg.gmgn = cfg.gmgn || {}; cfg.gmgn.api_key = null; }

  const cap = answers.capital || {};
  const dryRun = cap.dry_run !== false;
  const aktif = [];
  for (const key of Object.keys(NETWORKS)) {
    const want = answers.chains?.[key] || {};
    const block = cfg.chains[key] || tpl.chains?.[key] || defaultBlock(key);
    if (!block) continue;
    cfg.chains[key] = block;
    block.enabled = !!want.enabled;
    if (!block.enabled) continue;
    aktif.push(key);
    block.chain = block.chain || {};
    // An endpoint list not sent at all = use what is already in the config;
    // an EMPTY list that is sent = an error, not a silent permission to use the defaults.
    if (Array.isArray(want.endpoints)) {
      if (!want.endpoints.length) throw new Error(`${build(key).label}: belum ada endpoint RPC.`);
      block.chain.endpoints = want.endpoints.map(cleanEndpoint);
    }
    if (!(block.chain.endpoints || []).length) throw new Error(`${build(key).label}: belum ada endpoint RPC.`);
    // Alchemy: one key in .env, one endpoint at the front of the list for every chain
    // that has its host (networks.js). The URL is stored as ${ALCHEMY_KEY} —
    // env.js swaps it at boot, so the key never enters config.json.
    const hostAlchemy = NETWORKS[key]?.alchemyHost;
    if (answers.secrets?.alchemyKey && hostAlchemy && !(block.chain.endpoints || []).some((e) => String(e.url).includes(hostAlchemy))) {
      block.chain.endpoints = [
        { url: 'https://' + hostAlchemy + '/v2/${ALCHEMY_KEY}', max_batch: 40, archive: true, catatan: 'Alchemy — kuncinya di .env sebagai ALCHEMY_KEY' },
        ...block.chain.endpoints,
      ];
    }
    block.mode = { ...(block.mode || {}), dry_run: dryRun, paused: false };

    // The capital limits from the wizard apply the same on every enabled chain; the difference is
    // set later on the Rules page.
    block.rules = block.rules || {};
    const sz = block.rules.sizing = { ...(block.rules.sizing || {}) };
    if (cap.fixed_quote_usd != null && cap.fixed_quote_usd !== '') { sz.mode = 'fixed_quote'; sz.fixed_quote_usd = numOr(cap.fixed_quote_usd, sz.fixed_quote_usd); }
    for (const k of ['min_quote_usd', 'max_quote_per_position_usd', 'max_total_exposure_usd', 'daily_budget_usd']) {
      if (cap[k] != null && cap[k] !== '') sz[k] = numOr(cap[k], sz[k]);
    }

    // Targets: added, not overwritten — the list in the config is only a seed for the targets
    // table in SQLite (INSERT OR IGNORE at boot). Addresses in the chain's canonical form:
    // EVM lower-case, Solana base58 untouched (case-sensitive).
    const owns = new Set((block.targets || []).map((t) => normAddr(key, t.address) || String(t.address || '')));
    for (const t of answers.targets || []) {
      if ((t.chain || PRIMARY) !== key) continue;
      const addr = normAddr(key, t.address);
      if (!addr) throw new Error(`Alamat target tidak valid: ${String(t.address).slice(0, 20)}`);
      if (owns.has(addr)) continue;
      owns.add(addr);
      block.targets = [...(block.targets || []), { address: addr, label: String(t.label || '').slice(0, 60) || null, enabled: true }];
    }
  }
  if (!aktif.length) throw new Error('Pilih minimal satu chain.');
  cfg.setup = { completed_ts: Date.now(), version: SETUP_VERSION };
  return cfg;
}

// Write all files. The order is deliberate: secrets first, config.json last —
// it is the "already installed" marker, so if the process dies midway
// the wizard shows up again, not a half-finished bot that comes up.
function applySetup({ root, cfgPath, envPath, answers, log = () => {} }) {
  const template = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const base = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
  const cfg = buildConfig({ template, base, answers });          // validate before anything is written

  const s = answers.secrets || {};
  const vals = {
    LPCOPY_AUTH_TOKEN: s.authToken,
    LPCOPY_TELEGRAM_BOT_TOKEN: s.telegramToken,
    LPCOPY_NTFY_TOPIC: s.ntfyTopic,
    LPCOPY_GMGN_API_KEY: s.gmgnKey,
    LPCOPY_DASHBOARD_URL: s.publicUrl,
    ALCHEMY_KEY: s.alchemyKey,
  };
  writeEnvFile({ envPath, examplePath: path.join(root, '.env.example'), vals });
  // This process goes on to start the bot without a restart, so the new values are installed
  // right now: loadDotEnv does not overwrite variables that already exist in process.env,
  // and on a repeated setup the old variables have already been loaded.
  for (const [k, v] of Object.entries(vals)) if (v) process.env[k] = String(v);
  log(`pemasangan: .env ditulis (${envPath})`);

  let wallet = null;
  if (answers.wallet?.privateKey) {
    const p = keyPathOf(cfg);
    const w = new ethers.Wallet(answers.wallet.privateKey);
    const bak = writeKeyFile(p, w.privateKey);
    if (answers.wallet.mnemonic) fs.writeFileSync(`${p}.mnemonic`, answers.wallet.mnemonic, { mode: 0o600 });
    wallet = { address: w.address.toLowerCase(), keyFile: p, backup: bak, mnemonicFile: answers.wallet.mnemonic ? `${p}.mnemonic` : null };
    log(`pemasangan: kunci wallet ditulis (${wallet.address})${bak ? ` — kunci lama dicadangkan: ${path.basename(bak)}` : ''}`);
  }
  let solanaWallet = null;
  if (answers.solanaWallet?.secret) {
    const { parseSecret } = require('./solana/wallet');
    const bs58 = require('bs58').default || require('bs58');
    const kp = parseSecret(answers.solanaWallet.secret);
    const p = solKeyPathOf(cfg);
    let same = false;
    try { same = parseSecret(fs.readFileSync(p, 'utf8')).publicKey.equals(kp.publicKey); } catch { /* missing / not a key */ }
    const bak = same ? null : writeKeyFile(p, bs58.encode(kp.secretKey));
    solanaWallet = { address: kp.publicKey.toBase58(), keyFile: p, backup: bak };
    log(`pemasangan: kunci wallet Solana ditulis (${solanaWallet.address})${bak ? ` — kunci lama dicadangkan: ${path.basename(bak)}` : ''}`);
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* abaikan */ }
  log(`pemasangan: config.json ditulis (${cfgPath})`);
  return { cfg, wallet, solanaWallet };
}

// ---- restore from a backup ----------------------------------------------
// The wizard's second path: a backup file from Settings → Backup (backup.js)
// replaces all the steps. No database is open yet and no engine is
// running, so the files are written directly — without a pending file and restart.

// ${NAME} referenced by RPC URLs/headers in the config. Those not yet in this machine's
// environment are asked by the wizard; if left empty the endpoint fails and is visible in
// Settings → RPC (applyEnv leaves it as it is).
function envRefs(cfg) {
  const out = new Set();
  const find = (v) => { for (const m of String(v || '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(m[1]); };
  for (const e of allEndpoints(cfg)) {
    find(e.url);
    for (const h of Object.values(e.headers || {})) find(h);
  }
  return [...out];
}

// An absolute path from another machine (/home/ubuntu/... on a Mac) cannot be used here:
// it falls back to the template default. A relative path, ~/…, or under the home/this folder is used.
function localPath(p, dflt, root) {
  if (!p) return dflt;
  const abs = String(p).replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(abs)) return p;
  const di = (dir) => abs === dir || abs.startsWith(dir + path.sep);
  return di(os.homedir()) || di(path.resolve(root)) ? p : dflt;
}

// The restored config: the backup's contents, with what belongs to THIS MACHINE from the wizard (port,
// token via .env) or the template (paths that do not exist here). Always simulation.
function restoredConfig({ backup, template, port, root }) {
  const cfg = JSON.parse(JSON.stringify(backup.parts.config.json));
  normalizeCfg(cfg);
  cfg.server = { ...(cfg.server || {}), port, host: cfg.server?.host || template.server?.host || '127.0.0.1' };
  // The dashboard token is written to .env; the old token in the file (from the origin machine) is not carried over.
  cfg.server.auth_token = null;
  cfg.db = { ...(cfg.db || {}), path: localPath(cfg.db?.path, template.db?.path || 'data/lpcopy.db', root) };
  cfg.wallet = { ...(cfg.wallet || {}), key_file: localPath(cfg.wallet?.key_file, template.wallet?.key_file || '~/.lpcopy/key', root) };
  cfg.mode = { ...(cfg.mode || {}), dry_run: true };
  cfg.setup = { completed_ts: Date.now(), version: SETUP_VERSION, restored_from: backup.createdAt || null };
  return cfg;
}

// The same order as applySetup: everything that can fail because of input (file, password,
// corrupt database) is checked first, config.json is written LAST.
async function applyRestore({ root, cfgPath, envPath, backup: raw, parts = {}, password = '', token, port, env = {}, log = () => {} }) {
  const backup = parseBackup(raw);
  if (!backup.parts.config) throw new Error('Berkas cadangan ini tidak berisi pengaturan — pasang baru, lalu pulihkan sisanya dari Pengaturan → Cadangan.');
  if (String(token || '').length < 12) throw new Error('Token akses minimal 12 karakter — ini satu-satunya kunci dasbor.');
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port dasbor harus angka 1–65535.');
  const want = { db: !!parts.db, wallet: !!parts.wallet };
  if (want.db && !backup.parts.db) throw new Error('Berkas cadangan tidak berisi bagian db.');
  if (want.wallet && !backup.parts.wallet && !backup.parts.solanaWallet) throw new Error('Berkas cadangan tidak berisi bagian wallet.');

  const template = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const cfg = restoredConfig({ backup, template, port: p, root });

  let w = null, solKp = null;
  if (want.wallet && backup.parts.wallet && !process.env.LPCOPY_PRIVATE_KEY) {
    try { w = await ethers.Wallet.fromEncryptedJson(JSON.stringify(backup.parts.wallet.keystore), String(password)); }
    catch { throw new Error('Password keystore salah, atau keystore di berkas cadangan rusak.'); }
  }
  if (want.wallet && backup.parts.solanaWallet && !process.env.LPCOPY_SOLANA_PRIVATE_KEY) {
    try { solKp = require('./solana/wallet').decryptKeystore(backup.parts.solanaWallet.keystore, password); }
    catch { throw new Error('Password keystore salah, atau keystore Solana di berkas cadangan rusak.'); }
  }
  // Database: checked (hash, integrity, tables) in a pending file first, then installed.
  const dbPath = path.isAbsolute(cfg.db.path) ? cfg.db.path : path.join(root, cfg.db.path);
  if (want.db) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    await stageRestore({ backup, parts: { db: true }, cfgPath, dbPath });
  }

  // Only variables the config really references may be written to .env through here.
  const refs = new Set(envRefs(cfg));
  const vals = { LPCOPY_AUTH_TOKEN: String(token) };
  for (const [k, v] of Object.entries(env || {})) if (refs.has(k) && String(v || '').trim()) vals[k] = String(v).trim();
  writeEnvFile({ envPath, examplePath: path.join(root, '.env.example'), vals });
  for (const [k, v] of Object.entries(vals)) process.env[k] = v;
  log(`pemulihan: .env ditulis (${envPath})`);

  if (want.db) applyPendingRestore(dbPath, log);

  let wallet = null;
  if (w) {
    const kp = keyPathOf(cfg);
    let same = false;
    try { same = new ethers.Wallet(fs.readFileSync(kp, 'utf8').trim()).address === w.address; } catch { /* missing / not a key */ }
    const bak = same ? null : writeKeyFile(kp, w.privateKey);
    wallet = { address: w.address.toLowerCase(), keyFile: kp, backup: bak };
    log(`pemulihan: wallet ${wallet.address}${same ? ' (berkas kunci sudah sama)' : ' ditulis'}${bak ? ` — kunci lama dicadangkan: ${path.basename(bak)}` : ''}`);
  }
  let solanaWallet = null;
  if (solKp) {
    const { parseSecret } = require('./solana/wallet');
    const bs58 = require('bs58').default || require('bs58');
    const kp = solKeyPathOf(cfg);
    let same = false;
    try { same = parseSecret(fs.readFileSync(kp, 'utf8')).publicKey.equals(solKp.publicKey); } catch { /* missing / not a key */ }
    const bak = same ? null : writeKeyFile(kp, bs58.encode(solKp.secretKey));
    solanaWallet = { address: solKp.publicKey.toBase58(), keyFile: kp, backup: bak };
    log(`pemulihan: wallet Solana ${solanaWallet.address}${same ? ' (berkas kunci sudah sama)' : ' ditulis'}${bak ? ` — kunci lama dicadangkan: ${path.basename(bak)}` : ''}`);
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* abaikan */ }
  log(`pemulihan: config.json dari cadangan ${backup.createdAt || '?'} ditulis (${cfgPath})${want.db ? ', basis data dipasang' : ''}`);
  return { cfg, wallet, solanaWallet, db: want.db };
}

// ---- wizard server --------------------------------------------------------
// This server lives only until setup completes, and only serves the wizard page
// + /api/setup/*. There are no dashboard routes here: as long as there is no config,
// no database, engine, or token — there is nothing to leak apart from
// what the wizard asks.
const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

function readJson(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) { req.destroy(); reject(new Error('badan permintaan kebesaran')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON tidak terbaca')); } });
    req.on('error', reject);
  });
}

// An address that is pleasant to open: 0.0.0.0 / :: cannot be clicked.
const openUrl = (host, port) => `http://${/^(0\.0\.0\.0|::|)$/.test(host) ? '127.0.0.1' : host}:${port}`;

// Start the wizard and wait until the files are written. Its Promise resolves after the
// server is fully closed — the same port is used straight away by the dashboard server afterwards.
function runSetup({ root, cfgPath, envPath, requested = false, log = console.log }) {
  const halangan = setupBlocked({ root, cfgPath, requested });
  if (halangan) { log(halangan); return process.exit(1); }
  // The template is required: the wizard builds the config FROM the example file, not from a second
  // built-in list in the code that would certainly drift from it.
  const tplPath = path.join(root, 'config.example.json');
  if (!fs.existsSync(tplPath)) {
    log(`config.example.json tidak ada di ${root} — wizard pemasangan memakainya sebagai template.`);
    log('  salin dari repo: scp config.example.json <host>:~/<instance>/   (deploy.sh sudah mengirimnya sejak versi ini)');
    return process.exit(1);
  }
  const template = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  const sourceCfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : JSON.parse(JSON.stringify(template));
  normalizeCfg(sourceCfg);
  const port = Number(process.env.LPCOPY_SETUP_PORT || sourceCfg.server?.port || 8799);
  const host = String(process.env.LPCOPY_SETUP_HOST || sourceCfg.server?.host || '127.0.0.1');

  // Setup code. This page installs the signing key and the dashboard token, and is
  // often opened through a tunnel (cloudflared) even though the server itself is bound to
  // loopback — so the code is ALWAYS required, not just when bound publicly.
  // Printed in the terminal and stored in data/setup-code.txt so it can be `cat`-ed
  // from another SSH session.
  const code = crypto.randomBytes(4).toString('hex');
  const codeFile = path.join(root, 'data', 'setup-code.txt');
  try {
    fs.mkdirSync(path.dirname(codeFile), { recursive: true });
    fs.writeFileSync(codeFile, code + '\n', { mode: 0o600 });
  } catch { /* may fail: the code is still printed in the terminal */ }

  const hits = new Map();
  const blocked = (ip) => { const e = hits.get(ip); return !!e && e.until > Date.now() && e.n >= 10; };
  const fail = (ip) => { const now = Date.now(), e = hits.get(ip); hits.set(ip, { n: (e && e.until > now ? e.n : 0) + 1, until: now + 5 * 60_000 }); };
  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const codeOk = (req) => {
    const a = Buffer.from(String(req.headers['x-setup-code'] || ''));
    const b = Buffer.from(code);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // The private key never returns to the browser: it is generated/validated here,
  // held in memory, and only written to the key file when the wizard is finished.
  let pending = null;
  let pendingSol = null;   // the same for the Solana key: { secret, address, mode }

  const chainKeys = Object.keys(NETWORKS);
  const srcEndpoints = (key) => {
    const block = sourceCfg.chains?.[key] || defaultBlock(key) || {};
    return (block.chain?.endpoints || []).map((e) => ({ ...e }));
  };
  // Endpoints whose URL contains a secret (an old config, a repeated setup) are sent
  // masked; the browser refers back to them with {ref:i} and the original never
  // leaves the server.
  const epView = (e, i) => {
    const hidden = hasSecret(e);
    let hostname = '?';
    try { hostname = new URL(e.url).hostname; } catch { /* biarkan */ }
    return {
      ref: i, url: hidden ? maskUrl(e.url) : e.url, host: hostname, secret: hidden,
      max_batch: e.max_batch || 40, no_logs: !!e.no_logs, max_log_blocks: e.max_log_blocks || 0,
      archive: !!e.archive, no_gpa: !!e.no_gpa, no_history: !!e.no_history, catatan: e.catatan || '',
    };
  };
  const resolveEps = (key, list) => {
    const src = srcEndpoints(key);
    return (list || []).map((e) => {
      if (e && e.ref != null && e.url == null) {
        const original = src[Number(e.ref)];
        if (!original) throw new Error('endpoint tidak dikenal');
        return { ...original, ...(e.no_logs != null ? { no_logs: !!e.no_logs } : {}), ...(e.archive != null ? { archive: !!e.archive } : {}), ...(e.max_log_blocks != null ? { max_log_blocks: Number(e.max_log_blocks) } : {}), ...(e.no_gpa != null ? { no_gpa: !!e.no_gpa } : {}), ...(e.no_history != null ? { no_history: !!e.no_history } : {}) };
      }
      return e;
    }).filter(Boolean);
  };

  const state = () => ({
    ok: true,
    paths: { config: cfgPath, env: envPath, key: keyPathOf(sourceCfg), solanaKey: solKeyPathOf(sourceCfg) },
    existing: {
      config: fs.existsSync(cfgPath), env: fs.existsSync(envPath),
      key: fs.existsSync(keyPathOf(sourceCfg)), privateKeyFromEnv: !!process.env.LPCOPY_PRIVATE_KEY,
      solanaKey: fs.existsSync(solKeyPathOf(sourceCfg)), solanaKeyFromEnv: !!process.env.LPCOPY_SOLANA_PRIVATE_KEY,
    },
    server: { port, host, url: openUrl(host, port) },
    suggestToken: crypto.randomBytes(18).toString('base64url'),
    currencies: Object.entries(CURRENCIES).map(([passcode, nameVal]) => ({ code: passcode, name: nameVal, nameEn: CURRENCIES_EN[passcode] || nameVal })),
    display: { currency: sourceCfg.display?.currency ?? 'IDR' },
    wallet: pending ? { address: pending.address, mode: pending.mode } : null,
    solanaWallet: pendingSol ? { address: pendingSol.address, mode: pendingSol.mode } : null,
    chains: chainKeys.map((key) => {
      const p = build(key);
      return {
        key, kind: p.kind || 'evm', label: p.label, chainId: p.CHAIN_ID, nativeSymbol: p.nativeSymbol, alchemy: !!NETWORKS[key].alchemyHost,
        enabled: sourceCfg.chains?.[key] ? sourceCfg.chains[key].enabled !== false : key === PRIMARY,
        endpoints: srcEndpoints(key).map(epView),
      };
    }),
    capital: {
      dry_run: true,
      ...['fixed_quote_usd', 'min_quote_usd', 'max_quote_per_position_usd', 'max_total_exposure_usd', 'daily_budget_usd']
        .reduce((a, k) => ({ ...a, [k]: template.chains?.[PRIMARY]?.rules?.sizing?.[k] ?? null }), {}),
    },
  });

  return new Promise((resolve, reject) => {
    let finished = null;
    const json = (res, sc, body) => { res.writeHead(sc, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS }); res.end(JSON.stringify(body)); };
    // The files are written (fresh install or restore): answer, then hand the port over to the dashboard.
    const resolveVal = (res, result) => {
      finished = result;
      // The dashboard port is taken from the FRESHLY written config: if setup
      // ran on another port (LPCOPY_SETUP_PORT), the browser must be told
      // where it moved — otherwise it waits on a dead port.
      const finalPort = Number(result.cfg.server?.port || port);
      json(res, 200, {
        ok: true,
        address: result.wallet?.address || null,
        solanaAddress: result.solanaWallet?.address || null,
        restored: !!result.cfg.setup?.restored_from,
        port: finalPort,
        samePort: finalPort === port,
        url: openUrl(result.cfg.server?.host || host, finalPort),
      });
      // Answer first, then close — the port must be free before the dashboard server
      // binds it, including keep-alive connections that are still hanging.
      setTimeout(() => {
        server.closeAllConnections?.();
        server.close(() => {
          try { fs.unlinkSync(codeFile); } catch { /* already gone */ }
          log('pemasangan selesai — menyalakan Quiver…');
          resolve(finished);
        });
      }, 100);
    };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const key = `${req.method} ${url.pathname}`;
      try {
        // Polled continuously by the browser after "Save": once the answer is no longer
        // {setup:true} (this server is dead, the dashboard answers), the page moves on.
        if (key === 'GET /api/setup/ping') return json(res, 200, { setup: true });

        if (url.pathname.startsWith('/api/setup/')) {
          const ip = clientIp(req);
          if (blocked(ip)) return json(res, 429, { error: 'terlalu banyak percobaan — tunggu 5 menit' });
          if (!codeOk(req)) { fail(ip); return json(res, 401, { error: 'Kode pemasangan salah. Lihat terminal tempat Quiver dijalankan, atau jalankan: cat data/setup-code.txt' }); }
          hits.delete(ip);
        }

        if (key === 'GET /api/setup/state') return json(res, 200, state());

        // Wallet: generated/checked now, written later. What goes back to the browser
        // is only its address.
        if (key === 'POST /api/setup/wallet') {
          const b = await readJson(req);
          if (b.mode === 'none') { pending = null; return json(res, 200, { ok: true, wallet: null }); }
          if (b.mode === 'generate') {
            const w = ethers.Wallet.createRandom();
            pending = { mode: 'generate', privateKey: w.privateKey, address: w.address.toLowerCase(), mnemonic: w.mnemonic?.phrase || null };
            return json(res, 200, { ok: true, wallet: { address: pending.address, mode: 'generate' } });
          }
          let pk = String(b.privateKey || '').trim();
          if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return json(res, 200, { error: 'Kunci privat harus 64 karakter hex (boleh diawali 0x).' });
          if (!pk.startsWith('0x')) pk = '0x' + pk;
          let w;
          try { w = new ethers.Wallet(pk); } catch { return json(res, 200, { error: 'Kunci privat tidak valid.' }); }
          pending = { mode: 'import', privateKey: pk, address: w.address.toLowerCase(), mnemonic: null };
          return json(res, 200, { ok: true, wallet: { address: pending.address, mode: 'import' } });
        }

        // Solana wallet: a separate ed25519 key, generated/checked now, written at finish.
        if (key === 'POST /api/setup/solana-wallet') {
          const b = await readJson(req);
          if (b.mode === 'none') { pendingSol = null; return json(res, 200, { ok: true, wallet: null }); }
          const { Keypair } = require('@solana/web3.js');
          const { parseSecret } = require('./solana/wallet');
          const bs58 = require('bs58').default || require('bs58');
          let kp;
          if (b.mode === 'generate') kp = Keypair.generate();
          else {
            try { kp = parseSecret(String(b.secret || '')); } catch { kp = null; }
            if (!kp) return json(res, 200, { error: 'Kunci Solana harus base58 (ekspor Phantom/Solflare) atau larik JSON solana-keygen.' });
          }
          pendingSol = { mode: b.mode === 'generate' ? 'generate' : 'import', secret: bs58.encode(kp.secretKey), address: kp.publicKey.toBase58() };
          return json(res, 200, { ok: true, wallet: { address: pendingSol.address, mode: pendingSol.mode } });
        }

        // Test one endpoint — the same test as the Settings page, including the
        // flag suggestions (no_logs / max_log_blocks / archive).
        if (key === 'POST /api/setup/rpc') {
          const b = await readJson(req);
          const ck = String(b.chain || PRIMARY);
          if (!NETWORKS[ck]) return json(res, 200, { error: 'chain tidak dikenal' });
          let ep;
          try { ep = resolveEps(ck, [b.endpoint])[0]; } catch (e) { return json(res, 200, { error: e.message }); }
          if (!ep?.url) return json(res, 200, { error: 'URL RPC kosong' });
          const result = await probeRpc({ url: ep.url, headers: ep.headers }, build(ck));
          return json(res, 200, { ok: true, ...result });
        }

        // Preview of the backup file: what needs to be asked before restoring. Only
        // the config part is sent by the browser (the database can be tens of MB).
        if (key === 'POST /api/setup/restore/inspect') {
          const b = await readJson(req);
          const c = b.config && typeof b.config === 'object' ? JSON.parse(JSON.stringify(b.config)) : null;
          if (!c) return json(res, 200, { error: 'Berkas cadangan ini tidak berisi pengaturan — pasang baru, lalu pulihkan sisanya dari Pengaturan → Cadangan.' });
          normalizeCfg(c);
          const envVars = envRefs(c).map((name) => ({ name, set: !!process.env[name] }));
          return json(res, 200, { ok: true, envVars, port, backupPort: c.server?.port ?? null });
        }

        if (key === 'POST /api/setup/restore') {
          const b = await readJson(req, 256 * 1024 * 1024);
          let result;
          try {
            result = await applyRestore({ root, cfgPath, envPath, backup: b.backup, parts: b.parts, password: b.password,
              token: b.token, port: b.port, env: b.env, log });
          } catch (e) { return json(res, 200, { error: e.message }); }
          return resolveVal(res, result);
        }

        if (key === 'POST /api/setup/finish') {
          const b = await readJson(req);
          const answers = { ...b };
          answers.chains = {};
          for (const ck of chainKeys) {
            const want = b.chains?.[ck];
            if (!want?.enabled) { answers.chains[ck] = { enabled: false }; continue; }
            answers.chains[ck] = { enabled: true, endpoints: resolveEps(ck, want.endpoints) };
          }
          answers.wallet = pending ? { privateKey: pending.privateKey, mnemonic: pending.mnemonic } : null;
          answers.solanaWallet = pendingSol ? { secret: pendingSol.secret } : null;
          const evmOn = chainKeys.some((ck) => !isSolana(ck) && answers.chains[ck].enabled);
          const solOn = chainKeys.some((ck) => isSolana(ck) && answers.chains[ck].enabled);
          if (b.capital?.dry_run === false && evmOn && !pending && !fs.existsSync(keyPathOf(sourceCfg)) && !process.env.LPCOPY_PRIVATE_KEY) {
            return json(res, 200, { error: 'Mode LIVE butuh wallet — pasang wallet dulu di langkah Wallet.' });
          }
          if (b.capital?.dry_run === false && solOn && !pendingSol && !fs.existsSync(solKeyPathOf(sourceCfg)) && !process.env.LPCOPY_SOLANA_PRIVATE_KEY) {
            return json(res, 200, { error: 'Mode LIVE di Solana butuh wallet Solana — pasang dulu di langkah Wallet.' });
          }
          let result;
          try { result = applySetup({ root, cfgPath, envPath, answers, log }); }
          catch (e) { return json(res, 200, { error: e.message }); }
          return resolveVal(res, result);
        }

        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'rute tidak ada' });
        // The rest: the wizard page, any path (old links, /dashboard, etc.).
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS });
        return res.end(SETUP_PAGE());
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    });

    server.on('error', (e) => {
      // The same as the dashboard server in index.js: a port already in use is answered with
      // a hint, not a stack dump.
      if (e.code === 'EADDRINUSE') {
        log(`port ${port} sudah dipakai — kemungkinan Quiver lain masih jalan.`);
        log(`  cek: lsof -ti tcp:${port}   |   hentikan: lsof -ti tcp:${port} | xargs kill`);
        log(`  atau pasang di port lain: LPCOPY_SETUP_PORT=8800 npm start`);
        return process.exit(1);
      }
      reject(e);
    });
    // This banner is bilingual although the rest of the log is Indonesian: it is the entry to setup, and
    // the wizard page itself defaults to English (src/setup-page.js).
    server.listen(port, host, () => {
      const garis = '─'.repeat(52);
      log(`\n┌${garis}┐`);
      log(`│  Quiver — first-run setup · pemasangan awal`);
      log(`│  Open / buka  : ${openUrl(host, port)}`);
      log(`│  Setup code   : ${code}`);
      log(`│  (also in / tersimpan juga di ${path.relative(root, codeFile)})`);
      log(`└${garis}┘\n`);
      // pm2 reports this process "online" although the bot is not running — say so plainly.
      if (process.env.pm_id !== undefined) log('PERHATIAN: bot BELUM berjalan — instance ini sedang menunggu pemasangan diselesaikan.');
    });
  });
}

module.exports = { setupNeeded, setupBlocked, upsertEnv, writeEnvFile, buildConfig, applySetup, applyRestore, restoredConfig, envRefs, cleanEndpoint, keyPathOf, writeKeyFile, runSetup, SETUP_VERSION };
