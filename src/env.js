'use strict';
// Secrets via .env — so config.json can be shared, backed up, or sent
// to a server without carrying tokens and keys along.
//
// Priority order: existing environment variables (e.g. from pm2 / the shell) >
// the contents of the .env file > values in config.json. Values that come from .env are NEVER
// written back to config.json: every config write goes through writeCfg(), which
// returns those fields to the original file's contents before saving.
//
// What can be set (see .env.example):
//   LPCOPY_PRIVATE_KEY          the bot wallet's private key (replaces wallet.key_file)
//   LPCOPY_SOLANA_PRIVATE_KEY   the Solana wallet key, base58 or a JSON array
//                               (replaces wallet.solana_key_file)
//   LPCOPY_AUTH_TOKEN           dashboard sign-in token      -> server.auth_token
//   LPCOPY_TELEGRAM_BOT_TOKEN   bot token from @BotFather    -> telegram.bot_token
//   LPCOPY_NTFY_TOPIC           ntfy.sh topic                -> notify.ntfy_topic
//   LPCOPY_GMGN_API_KEY         GMGN OpenAPI key             -> gmgn.api_key
//   LPCOPY_DASHBOARD_URL        https URL of the dashboard (tunnel) -> server.public_url
//                               used by the Telegram mini app button; may be per instance:
//                               LPCOPY_DASHBOARD_URL_LPCOPY2 for ~/lpcopy2
//   any variable                referenced from RPC URLs/headers as ${NAME}, e.g.
//                               "https://…alchemy.com/v2/${ALCHEMY_KEY}"
const fs = require('node:fs');
const path = require('node:path');

// Config fields that .env can take over: [variable, path in config].
const FIELDS = [
  ['LPCOPY_AUTH_TOKEN', ['server', 'auth_token']],
  ['LPCOPY_TELEGRAM_BOT_TOKEN', ['telegram', 'bot_token']],
  ['LPCOPY_NTFY_TOPIC', ['notify', 'ntfy_topic']],
  ['LPCOPY_GMGN_API_KEY', ['gmgn', 'api_key']],
  ['LPCOPY_DASHBOARD_URL', ['server', 'public_url']],
  // Swap aggregator keys (swaprouter.js; Settings → Aggregators shows them as "from .env").
  ['OKX_API_KEY', ['aggregators', 'okx', 'api_key']],
  ['OKX_SECRET_KEY', ['aggregators', 'okx', 'secret_key']],
  ['OKX_API_PASSPHRASE', ['aggregators', 'okx', 'passphrase']],
  ['OKX_PROJECT_ID', ['aggregators', 'okx', 'project_id']],
  ['LIFI_API_KEY', ['aggregators', 'lifi', 'api_key']],
  ['ZEROX_API_KEY', ['aggregators', 'zerox', 'api_key']],
  ['ONEINCH_API_KEY', ['aggregators', 'oneinch', 'api_key']],
  ['OPENOCEAN_API_KEY', ['aggregators', 'openocean', 'api_key']],
];
// One VPS hosts several instances (~/lpcopy, ~/lpcopy2, ~/lpcopy3) that share
// one .env file, and each instance's dashboard address differs. The fields in this list may
// be given a suffix of their folder name — LPCOPY_DASHBOARD_URL_LPCOPY2 — exactly the rule
// deploy.sh already uses to print the address.
const PER_INSTANCE = new Set(['LPCOPY_DASHBOARD_URL']);
const INSTANCE = path.basename(path.join(__dirname, '..')).toUpperCase().replace(/[^A-Z0-9_]/g, '_');
const META = Symbol('lpcopy.env');

// A small .env parser: KEY=value, blank lines and # comments are ignored, a value may
// be wrapped in '…' (literal) or "…" (\n recognised), "export KEY=…" is accepted.
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
    else v = v.replace(/\s+#.*$/, '').trim();          // comment at the end of a line
    out[m[1]] = v;
  }
  return out;
}

// Load .env into process.env without overwriting variables that already exist. Returns
// the list of names loaded (not the values) to be recorded in the log.
function loadDotEnv(file) {
  if (!file || !fs.existsSync(file)) return { file: null, keys: [], external: [] };
  const vars = parseEnv(fs.readFileSync(file, 'utf8'));
  const st = fs.statSync(file);
  const loose = (st.mode & 0o077) !== 0;
  // A private key in a file readable by other users = leaked. Just as strict
  // as the wallet.key_file check in the executor.
  if (loose && (vars.LPCOPY_PRIVATE_KEY || vars.LPCOPY_SOLANA_PRIVATE_KEY)) throw new Error(`izin ${file} terlalu longgar untuk menyimpan kunci privat — jalankan: chmod 600 ${file}`);
  const keys = [], external = [];
  for (const [k, v] of Object.entries(vars)) {
    if (v === '') continue;                                   // empty = not set
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

// All RPC endpoint lists in the config: per chain (cfg.chains.<name>.chain.endpoints)
// and the old single-chain shape (cfg.chain.endpoints) while not yet normalised.
function allEndpoints(cfg) {
  const out = [];
  if (Array.isArray(cfg?.chain?.endpoints)) out.push(...cfg.chain.endpoints);
  for (const c of Object.values(cfg?.chains || {})) if (Array.isArray(c?.chain?.endpoints)) out.push(...c.chain.endpoints);
  return out;
}

// Apply environment variables to cfg (in place). Notes about what was taken
// over are stored in a symbol property — not part of JSON.stringify.
function applyEnv(cfg, env = process.env) {
  const meta = { fields: [], templates: new Map(), missing: [] };
  for (const [name, p] of FIELDS) {
    const special = PER_INSTANCE.has(name) ? `${name}_${INSTANCE}` : null;
    const use = special && env[special] ? special : name;
    const v = env[use];
    if (v == null || v === '') continue;
    meta.fields.push({ name: use, path: p, value: v, fileValue: getAt(cfg, p) ?? null });
    setAt(cfg, p, v);
  }
  // ${NAME} in RPC URLs and headers. Ones whose variable does not exist are left as they are
  // (that endpoint will fail and show on the Settings page) and recorded.
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

// The name of the variable that governs a field, or null. Used by the Settings
// page to refuse changes that would be overwritten again on restart.
function envName(cfg, dotted) {
  const f = cfg?.[META]?.fields.find((x) => x.path.join('.') === dotted);
  return f ? f.name : null;
}
const privateKeyFromEnv = () => !!process.env.LPCOPY_PRIVATE_KEY;

// A copy of cfg that is safe to write to disk: fields from .env are returned to the original
// file's value, and RPC URLs/headers that contain secrets go back to the ${NAME} form.
function cfgForDisk(cfg) {
  const out = JSON.parse(JSON.stringify(cfg));
  const meta = cfg?.[META];
  if (!meta) return out;
  for (const f of meta.fields) {
    // If the value was changed from outside (it should have been refused), do not guess.
    if (getAt(out, f.path) === f.value) setAt(out, f.path, f.fileValue);
  }
  const back = (s) => (typeof s === 'string' && meta.templates.has(s) ? meta.templates.get(s) : s);
  for (const e of allEndpoints(out)) {
    e.url = back(e.url);
    if (e.headers && typeof e.headers === 'object') for (const k of Object.keys(e.headers)) e.headers[k] = back(e.headers[k]);
  }
  return out;
}

// The only way to write config.json. Permission 600: its contents can still hold secrets
// for anyone who has not moved them to .env.
function writeCfg(cfgPath, cfg) {
  fs.writeFileSync(cfgPath, JSON.stringify(cfgForDisk(cfg), null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* abaikan */ }
}

const defaultEnvPath = (root) => process.env.LPCOPY_ENV || path.join(root, '.env');

module.exports = { parseEnv, loadDotEnv, applyEnv, cfgForDisk, writeCfg, envName, privateKeyFromEnv, defaultEnvPath, allEndpoints, FIELDS };
