'use strict';
// Per-user ("tenant") configuration for multi-user mode.
//
// The superadmin keeps the original config.json and database. Every other account gets
// its own folder, data/users/<id>/, holding:
//   config.json   only the fields a user may own (see USER_TOP / USER_CHAIN)
//   lpcopy.db     the same schema as the main database, so no query needs a user filter
//   key, solana-key   wallet keys, encrypted under LPCOPY_MASTER_KEY (keyfile.js)
//
// userCfgView() merges the user file with the global config: user fields read/write the user
// file, everything else (RPC endpoints, loop, aggregators, server, telegram…) is read from the
// global config and is read-only. JSON.stringify(view) yields exactly the user file, so the
// existing writeCfg(cfgPath, cfg) calls in settings.js save the right thing.
const fs = require('node:fs');
const path = require('node:path');

const USER_TOP = new Set(['wallet', 'notify', 'display']);
const USER_CHAIN = new Set(['targets', 'rules', 'mode', 'gas', 'risk', 'swap']);
// cfg.telegram of an account: its own chats and notification switches; the bot token and the
// rest belong to the superadmin (the bot is shared, see telegram.js `hub`).
const USER_TELEGRAM = ['chat_ids', 'notify'];
const GLOBAL_TELEGRAM = ['timezone', 'language', 'allow_groups'];

class ReadOnlyError extends Error {
  constructor(field) { super(`${field} hanya bisa diubah superadmin`); this.code = 'readonly'; }
}

const userDir = (root, id) => path.join(root, 'data', 'users', String(Number(id)));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

// A fresh per-chain block for a new account: the superadmin's tuning as a starting point,
// but no targets, simulation on, nothing paused.
function defaultChainBlock(globalBlock = {}) {
  return {
    targets: [],
    rules: clone(globalBlock.rules) || {},
    // New open-LP accounts go straight to LIVE: they trade their own deposited funds, there is
    // nothing to simulate. (The superadmin's own config is separate and keeps its own mode.)
    mode: { dry_run: false, paused: false, sim_balance_usd: Number(globalBlock.mode?.sim_balance_usd) || 1000 },
    gas: clone(globalBlock.gas) || {},
    risk: clone(globalBlock.risk) || {},
    swap: clone(globalBlock.swap) || {},
  };
}

// Loads (or initialises) a user's config. Every chain known to the global config gets a block,
// so iterating cfg.chains through the view sees the same keys as the global config.
function loadUserCfg(file, globalCfg, dir) {
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Only the fields an account owns survive — e.g. a restored full backup brings server, RPC and
  // telegram blocks that must not sit (or be re-saved) in the account file.
  const u = {};
  for (const k of [...USER_TOP, 'telegram']) if (raw[k] !== undefined) u[k] = raw[k];
  u.chains = {};
  for (const [k, c] of Object.entries(raw.chains && typeof raw.chains === 'object' ? raw.chains : {})) {
    if (!c || typeof c !== 'object') continue;
    u.chains[k] = {};
    for (const f of USER_CHAIN) if (c[f] !== undefined) u.chains[k][f] = c[f];
  }
  u.wallet = {
    ...(u.wallet || {}),
    key_file: path.join(dir, 'key'),
    solana_key_file: path.join(dir, 'solana-key'),
    // Never fall back to the superadmin's LPCOPY_PRIVATE_KEY / LPCOPY_SOLANA_PRIVATE_KEY.
    from_env: false,
    encrypted: true,
  };
  u.notify = u.notify && typeof u.notify === 'object' ? u.notify : {};
  const tg = u.telegram && typeof u.telegram === 'object' ? u.telegram : {};
  u.telegram = {
    chat_ids: Array.isArray(tg.chat_ids) ? tg.chat_ids.map(String) : [],
    notify: tg.notify && typeof tg.notify === 'object' ? tg.notify : {},
  };
  u.display = u.display && typeof u.display === 'object' ? u.display : {};
  u.chains = u.chains && typeof u.chains === 'object' ? u.chains : {};
  for (const [k, g] of Object.entries(globalCfg.chains || {})) {
    const def = defaultChainBlock(g);
    const cur = u.chains[k] && typeof u.chains[k] === 'object' ? u.chains[k] : {};
    for (const f of USER_CHAIN) if (cur[f] === undefined || cur[f] === null) cur[f] = def[f];
    if (!Array.isArray(cur.targets)) cur.targets = [];
    u.chains[k] = cur;
  }
  for (const k of Object.keys(u.chains)) if (!globalCfg.chains?.[k]) delete u.chains[k];
  return u;
}

// Wallet fields an account can never change, even in memory: where its key lives, that it is
// encrypted, and that the superadmin's env keys are never used.
const lockedWallet = (w) => ({ key_file: w.key_file, solana_key_file: w.solana_key_file, from_env: false, encrypted: true });

function userCfgView(globalCfg, userCfg, { dbPath }) {
  const walletLock = lockedWallet(userCfg.wallet || {});
  const chainProxies = new Map();
  const chainProxy = (k) => {
    if (!chainProxies.has(k)) {
      chainProxies.set(k, new Proxy(userCfg.chains[k], {
        get(t, p) {
          // Regular accounts are open-LP only: copy trading is always off and cannot be turned
          // on from a user config. The engine reads cfg.copy (see Engine#copyEnabled).
          if (p === 'copy') return false;
          if (typeof p === 'string' && USER_CHAIN.has(p)) return t[p];
          return globalCfg.chains[k]?.[p];
        },
        set(t, p, v) {
          if (typeof p === 'string' && USER_CHAIN.has(p)) { t[p] = v; return true; }
          throw new ReadOnlyError(`chains.${k}.${String(p)}`);
        },
        has(t, p) { return (typeof p === 'string' && USER_CHAIN.has(p)) ? p in t : p in (globalCfg.chains[k] || {}); },
        deleteProperty(t, p) {
          if (typeof p === 'string' && USER_CHAIN.has(p)) { delete t[p]; return true; }
          throw new ReadOnlyError(`chains.${k}.${String(p)}`);
        },
      }));
    }
    return chainProxies.get(k);
  };
  const chains = new Proxy(userCfg.chains, {
    get(t, k) {
      if (typeof k !== 'string') return t[k];
      if (!globalCfg.chains?.[k] || !t[k]) return undefined;
      return chainProxy(k);
    },
    set(t, k) { throw new ReadOnlyError(`chains.${String(k)}`); },
    deleteProperty(t, k) { throw new ReadOnlyError(`chains.${String(k)}`); },
  });
  const db = Object.freeze({ path: dbPath });
  // The superadmin's fields ride along non-enumerable: readable by the bot, never spread into a
  // write, never serialised into the user file.
  const telegramView = () => {
    const out = { ...userCfg.telegram };
    for (const k of GLOBAL_TELEGRAM) {
      if (globalCfg.telegram?.[k] !== undefined) Object.defineProperty(out, k, { value: globalCfg.telegram[k], enumerable: false });
    }
    return out;
  };
  return new Proxy(userCfg, {
    get(t, p) {
      if (typeof p !== 'string') return undefined;   // env.js META symbol: belongs to the global config only
      if (p === 'chains') return chains;
      if (p === 'db') return db;
      if (p === 'telegram') return telegramView();
      if (p === 'wallet') return Object.freeze({ ...t.wallet, ...walletLock });
      if (USER_TOP.has(p)) return t[p];
      return globalCfg[p];
    },
    set(t, p, v) {
      if (p === 'wallet') { t.wallet = { ...(v && typeof v === 'object' ? v : {}), ...walletLock }; return true; }
      if (typeof p === 'string' && USER_TOP.has(p)) { t[p] = v; return true; }
      if (p === 'telegram') {
        // Only the account's own fields are kept; a bot token never lands here.
        const next = {};
        for (const k of USER_TELEGRAM) next[k] = v?.[k] !== undefined ? v[k] : t.telegram?.[k];
        next.chat_ids = (Array.isArray(next.chat_ids) ? next.chat_ids : []).map(String);
        if (!next.notify || typeof next.notify !== 'object') next.notify = {};
        t.telegram = next;
        return true;
      }
      throw new ReadOnlyError(String(p));
    },
    has(t, p) { return (typeof p === 'string' && (USER_TOP.has(p) || p === 'chains' || p === 'db' || p === 'telegram')) || p in globalCfg; },
    deleteProperty(t, p) {
      if (typeof p === 'string' && USER_TOP.has(p)) { delete t[p]; return true; }
      throw new ReadOnlyError(String(p));
    },
  });
}

// Settings routes a regular account may never call: they change shared infrastructure or
// move whole databases around. Enforced in server.js for every non-superadmin tenant.
const ADMIN_ONLY_ROUTES = new Set([
  'POST /api/settings/aggregators', 'POST /api/settings/aggregators/test',
  'POST /api/settings/rpc', 'POST /api/settings/rpc/test',
  'POST /api/settings/gmgn', 'POST /api/settings/gmgn/test',
  'POST /api/settings/chains', 'POST /api/settings/loop',
  'POST /api/settings/token/rotate',
]);
// Fields of GET /api/settings that describe shared infrastructure; hidden from regular accounts.
const ADMIN_ONLY_SETTINGS = ['rpc', 'rpcCache', 'gmgn', 'aggregators', 'authFromEnv', 'loop'];

module.exports = { USER_TOP, USER_CHAIN, ReadOnlyError, userDir, loadUserCfg, userCfgView, defaultChainBlock, ADMIN_ONLY_ROUTES, ADMIN_ONLY_SETTINGS };
