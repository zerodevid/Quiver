'use strict';
// Backup & restore of one instance: settings (config.json), database, and wallet.
//
// A single JSON file, its contents chosen by the user:
//   config  — config.json AS IT IS ON DISK: values from .env are already in the ${NAME}
//             form (writeCfg), so secrets in .env do not come along. Secrets typed through the
//             dashboard (RPC API key, Telegram token) do live in config.json and come along.
//   db      — a copy of the database (sqlite backup API, does not lock the engine) WITHOUT the
//             rpc_cache table: 90%+ of the file size, just a cache that refills by itself.
//             Gzipped then base64.
//   wallet  — a password-encrypted V3 keystore, same as the wallet export. The raw private key
//             never enters the file. A Solana key, when installed, rides along under
//             parts.solanaWallet (quiver-solana-keystore, same password).
//
// Restoring config & db is NOT overwritten in place: the running process holds the
// database connection and an in-memory copy of the config (which other routes write back).
// The file is put aside as <file>.restore-pending, then swapped at boot by
// applyPendingRestore() before anything opens it. The old file is not deleted: it is moved
// to <name>.pre-restore-<time>.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { Worker } = require('node:worker_threads');
const sqlite = require('node:sqlite');

const FORMAT = 'quiver-backup';
const VERSION = 1;
const PENDING = '.restore-pending';
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Drop rpc_cache then VACUUM, in a worker: DatabaseSync is synchronous, and VACUUM of a
// ~100 MB file on the main thread holds up the engine loop (block scanning, position exit) for over a second.
// `check` = only inspect the uploaded file (integrity + required tables).
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
try {
  const out = {};
  if (workerData.check) {
    const ok = db.prepare('PRAGMA quick_check').get();
    out.check = Object.values(ok || {})[0];
  } else {
    db.exec('DROP TABLE IF EXISTS rpc_cache');
    db.exec('VACUUM');
  }
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  out.tables = { positions: has('positions'), state: has('state') };
  const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return null; } };
  out.stats = {
    positions: n('SELECT COUNT(*) n FROM positions'),
    open: n("SELECT COUNT(*) n FROM positions WHERE status='open'"),
    targets: n('SELECT COUNT(*) n FROM targets'),
    lastTs: n('SELECT MAX(ts) n FROM logs'),
  };
  parentPort.postMessage(out);
} finally { db.close(); }
`;
function inWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: data });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (c) => { if (c) reject(new Error(`worker keluar ${c}`)); });
  });
}

// A database copy ready to be packed. `db` = the DatabaseSync connection currently in use.
async function snapshotDb(db, tmpDir) {
  const tmp = path.join(tmpDir, `backup-${process.pid}-${Date.now()}.db`);
  try {
    await sqlite.backup(db, tmp);
    const info = await inWorker({ file: tmp });
    const raw = await fs.promises.readFile(tmp);
    const gz = await gzip(raw, { level: 9 });
    return {
      bytes: raw.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      stats: info.stats,
      gz: gz.toString('base64'),
    };
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) fs.rmSync(f, { force: true });
  }
}

async function createBackup({ parts, cfgPath, db, dbPath, wallet, solanaKeypair = null, password, meta = {} }) {
  const out = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), ...meta, parts: {} };
  if (parts.config) out.parts.config = { json: JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  if (parts.db) out.parts.db = await snapshotDb(db, path.dirname(dbPath));
  if (parts.wallet && wallet) {
    const keystore = JSON.parse(await wallet.encrypt(password));
    out.parts.wallet = { address: wallet.address.toLowerCase(), keystore };
  }
  if (parts.wallet && solanaKeypair) {
    const keystore = require('./solana/wallet').encryptKeystore(solanaKeypair, password);
    out.parts.solanaWallet = { address: keystore.address, keystore };
  }
  return out;
}

// File shape check. Does not trust its contents: the file comes from an upload.
function parseBackup(b) {
  if (!b || typeof b !== 'object' || b.format !== FORMAT) throw new Error('Bukan berkas cadangan Quiver.');
  if (!Number.isInteger(b.version) || b.version > VERSION) throw new Error('Versi berkas cadangan lebih baru dari bot ini — perbarui bot dulu.');
  const p = b.parts || {};
  if (p.config && (typeof p.config.json !== 'object' || !p.config.json || Array.isArray(p.config.json))) throw new Error('Bagian pengaturan di berkas cadangan rusak.');
  if (p.db && (typeof p.db.gz !== 'string' || !/^[0-9a-f]{64}$/.test(p.db.sha256 || ''))) throw new Error('Bagian basis data di berkas cadangan rusak.');
  if (p.wallet && (typeof p.wallet.keystore !== 'object' || !p.wallet.keystore)) throw new Error('Bagian wallet di berkas cadangan rusak.');
  if (p.solanaWallet && (typeof p.solanaWallet.keystore !== 'object' || p.solanaWallet.keystore?.format !== 'quiver-solana-keystore')) throw new Error('Bagian wallet Solana di berkas cadangan rusak.');
  return b;
}

// The restored config. What belongs to THIS MACHINE stays from the current config: the dashboard
// door (port, host, token — restoring an old token could lock the user out),
// the database location and the key file. The mode is always simulation: an old file may have
// been made while LIVE, and turning on real transactions must be a typed decision.
function mergeConfig(restored, current) {
  const out = JSON.parse(JSON.stringify(restored));
  for (const k of ['server', 'db']) {
    if (current[k] !== undefined) out[k] = current[k]; else delete out[k];
  }
  if (current.wallet?.key_file !== undefined) out.wallet = { ...(out.wallet || {}), key_file: current.wallet.key_file };
  if (current.wallet?.solana_key_file !== undefined) out.wallet = { ...(out.wallet || {}), solana_key_file: current.wallet.solana_key_file };
  out.mode = { ...(out.mode || {}), dry_run: true };
  return out;
}

// Write the config/db parts as pending files. The database is checked first (hash,
// integrity, required tables) in a temp file, then moved to the pending name —
// an existing pending file is always intact.
async function stageRestore({ backup, parts, cfgPath, dbPath }) {
  const staged = [];
  if (parts.db) {
    const raw = await gunzip(Buffer.from(backup.parts.db.gz, 'base64'));
    if (crypto.createHash('sha256').update(raw).digest('hex') !== backup.parts.db.sha256) throw new Error('Basis data di berkas cadangan rusak (hash tidak cocok).');
    const tmp = `${dbPath}.restore-tmp-${process.pid}`;
    try {
      await fs.promises.writeFile(tmp, raw, { mode: 0o600 });
      const info = await inWorker({ file: tmp, check: true });
      if (info.check !== 'ok') throw new Error(`Basis data di berkas cadangan rusak (${info.check}).`);
      if (!info.tables.positions || !info.tables.state) throw new Error('Berkas basis data bukan milik Quiver (tabel positions/state tidak ada).');
      fs.renameSync(tmp, dbPath + PENDING);
    } finally {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    }
    staged.push('db');
  }
  if (parts.config) {
    const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath + PENDING, JSON.stringify(mergeConfig(backup.parts.config.json, current), null, 2), { mode: 0o600 });
    staged.push('config');
  }
  return staged;
}

// Called at boot, before the file is opened. The file in use is moved
// to <name>.pre-restore-<time><ext> (along with -wal/-shm: the database's latest contents can
// still be in the WAL, and a WAL only applies beside a file of the same name).
function applyPendingRestore(file, log = () => {}) {
  const pending = file + PENDING;
  if (!fs.existsSync(pending)) return null;
  const ext = path.extname(file);
  const old = `${file.slice(0, file.length - ext.length)}.pre-restore-${stamp()}${ext}`;
  if (fs.existsSync(file)) {
    fs.renameSync(file, old);
    for (const s of ['-wal', '-shm']) if (fs.existsSync(file + s)) fs.renameSync(file + s, old + s);
  }
  fs.renameSync(pending, file);
  log(`pemulihan: ${path.basename(file)} diganti dari cadangan (yang lama: ${path.basename(old)})`);
  return old;
}

module.exports = { FORMAT, VERSION, createBackup, parseBackup, mergeConfig, stageRestore, applyPendingRestore };
