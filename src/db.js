'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- wallet yang dicopy
CREATE TABLE IF NOT EXISTS targets (
  address     TEXT PRIMARY KEY,
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  rules       TEXT,                 -- JSON: override aturan per target (null = pakai default)
  added_ts    INTEGER NOT NULL,
  notes       TEXT
);

-- setiap aksi LP yang terdeteksi dari target
CREATE TABLE IF NOT EXISTS actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            INTEGER NOT NULL,
  block         INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  target        TEXT NOT NULL,
  venue         TEXT NOT NULL,      -- v4 | v3 | v3pool
  kind          TEXT NOT NULL,      -- mint | increase | decrease | burn | collect | transfer_in | transfer_out
  token_id      TEXT,
  pool_ref      TEXT,               -- poolId (v4) atau alamat pool (v3)
  token0        TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower    INTEGER, tick_upper INTEGER,
  liquidity     TEXT,               -- delta L (positif = tambah)
  amount0       TEXT, amount1 TEXT,
  value_quote   REAL,               -- nilai posisi dalam aset kuotasi
  quote_symbol  TEXT,
  UNIQUE(tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_actions_target ON actions(target, ts DESC);

-- keputusan bot atas setiap aksi (disalin / dilewat + alasannya)
CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id  INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  verdict    TEXT NOT NULL,        -- copy | skip | error | dry
  reason     TEXT,
  plan       TEXT,                 -- JSON rencana eksekusi
  tx_hash    TEXT,
  position_id INTEGER,
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_dec_ts ON decisions(ts DESC);

-- posisi milik kita
CREATE TABLE IF NOT EXISTS positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  venue         TEXT NOT NULL,
  token_id      TEXT,
  pool_ref      TEXT NOT NULL,
  token0        TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower    INTEGER, tick_upper INTEGER,
  liquidity     TEXT NOT NULL DEFAULT '0',
  target        TEXT,
  mirror_of     TEXT,              -- token_id posisi target yang dicermin
  status        TEXT NOT NULL,     -- open | closed | pending | failed
  opened_ts     INTEGER, closed_ts INTEGER,
  cost0         TEXT DEFAULT '0', cost1 TEXT DEFAULT '0',
  cost_quote    REAL DEFAULT 0,
  out0          TEXT DEFAULT '0', out1 TEXT DEFAULT '0',
  out_quote     REAL DEFAULT 0,
  fees_quote    REAL DEFAULT 0,
  quote_symbol  TEXT,
  tx_open       TEXT, tx_close TEXT,
  last_sync     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_token ON positions(venue, token_id) WHERE token_id IS NOT NULL;

-- cache metadata pool
CREATE TABLE IF NOT EXISTS pools (
  pool_ref     TEXT PRIMARY KEY,
  venue        TEXT NOT NULL,
  token0       TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  pool_addr    TEXT,
  first_block  INTEGER,
  first_ts     INTEGER
);

CREATE TABLE IF NOT EXISTS tokens (
  address   TEXT PRIMARY KEY,
  symbol    TEXT, name TEXT, decimals INTEGER,
  seen_ts   INTEGER
);

CREATE TABLE IF NOT EXISTS txs (
  hash       TEXT PRIMARY KEY,
  ts         INTEGER, kind TEXT, status TEXT,
  gas_used   INTEGER, gas_price TEXT, gas_quote REAL,
  error      TEXT, detail TEXT
);

CREATE TABLE IF NOT EXISTS equity (
  ts             INTEGER PRIMARY KEY,
  wallet_quote   REAL, positions_quote REAL, total_quote REAL,
  realized_quote REAL, fees_quote REAL, open_positions INTEGER
);

-- ---- riset wallet: posisi & PnL wallet mana pun (bukan cuma milik kita) ----
-- Semua diturunkan dari chain: ModifyLiquidity + Transfer ERC20 di dalam tx yang sama,
-- lalu pokok dipisahkan dari fee memakai harga pool saat itu (dari event Swap).
CREATE TABLE IF NOT EXISTS wallets (
  address        TEXT PRIMARY KEY,
  label          TEXT,
  first_block    INTEGER,      -- awal jendela yang pernah dipindai
  scanned_to     INTEGER,      -- pemindaian sudah sampai blok ini
  last_scan_ts   INTEGER,
  stats          TEXT,         -- JSON ringkasan (cache)
  positions_n    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS wpositions (
  wallet       TEXT NOT NULL,
  venue        TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  pool_ref     TEXT,
  token0 TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower   INTEGER, tick_upper INTEGER,
  liquidity    TEXT DEFAULT '0',      -- L sekarang (0 = tertutup)
  in0 TEXT DEFAULT '0',  in1 TEXT DEFAULT '0',   -- total token masuk (modal)
  out0 TEXT DEFAULT '0', out1 TEXT DEFAULT '0',  -- total token keluar (pokok + fee)
  fee0 TEXT DEFAULT '0', fee1 TEXT DEFAULT '0',  -- bagian fee dari yang keluar
  live_value_q REAL DEFAULT 0,        -- nilai posisi sekarang (hanya yang masih terbuka)
  live_fee_q   REAL DEFAULT 0,        -- fee terkumpul tapi belum diklaim
  in_range     INTEGER,
  invested_q   REAL DEFAULT 0,        -- modal dalam aset kuotasi, dinilai saat kejadian
  returned_q   REAL DEFAULT 0,
  fees_q       REAL DEFAULT 0,
  pnl_q        REAL DEFAULT 0,
  quote_symbol TEXT,
  opened_block INTEGER, opened_ts INTEGER,
  closed_block INTEGER, closed_ts INTEGER,
  status       TEXT NOT NULL,         -- open | closed
  events_n     INTEGER DEFAULT 0,
  incomplete   INTEGER DEFAULT 0,     -- 1 = sebagian riwayat di luar jendela pindai
  PRIMARY KEY (wallet, venue, token_id)
);
CREATE INDEX IF NOT EXISTS idx_wpos_wallet ON wpositions(wallet, status);
CREATE INDEX IF NOT EXISTS idx_wpos_closed ON wpositions(wallet, closed_ts DESC);

CREATE TABLE IF NOT EXISTS wevents (
  wallet     TEXT NOT NULL,
  token_id   TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER,
  tx_hash    TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- mint | increase | decrease | close
  liq_delta  TEXT,
  amount0 TEXT, amount1 TEXT,        -- yang benar-benar berpindah (dari ERC20 Transfer)
  princ0 TEXT, princ1 TEXT,          -- bagian pokok
  fee0 TEXT, fee1 TEXT,              -- bagian fee (hanya pada penarikan)
  sqrt_price TEXT,                   -- harga pool saat itu
  value_q    REAL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_wev_pos ON wevents(wallet, token_id, block);

-- harga pool pada suatu blok, dari event Swap terdekat (mahal dicari, murah disimpan)
CREATE TABLE IF NOT EXISTS wprices (
  pool_ref   TEXT NOT NULL,
  block      INTEGER NOT NULL,
  sqrt_price TEXT NOT NULL,
  src_block  INTEGER,
  PRIMARY KEY (pool_ref, block)
);

CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS logs (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts  INTEGER NOT NULL, level TEXT, msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
`;

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  return db;
}

class Store {
  constructor(dbPath) {
    this.db = open(dbPath);
    this.q = {};
  }
  prep(sql) {
    if (!this.q[sql]) this.q[sql] = this.db.prepare(sql);
    return this.q[sql];
  }
  run(sql, ...args) { return this.prep(sql).run(...args); }
  all(sql, ...args) { return this.prep(sql).all(...args); }
  get(sql, ...args) { return this.prep(sql).get(...args); }

  getState(k, dflt = null) {
    const r = this.get('SELECT v FROM state WHERE k=?', k);
    return r ? r.v : dflt;
  }
  setState(k, v) {
    this.run('INSERT INTO state(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', k, String(v));
  }
  log(level, msg) {
    this.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', Date.now(), level, String(msg).slice(0, 2000));
    // Pendengar opsional (bot Telegram) — kegagalannya tidak boleh menjatuhkan penulis log.
    if (this.onLog) { try { this.onLog(level, String(msg)); } catch { /* abaikan */ } }
  }
  // buang log lama supaya file tidak membengkak
  prune(days = 30) {
    const cut = Date.now() - days * 86400_000;
    this.run('DELETE FROM logs WHERE ts < ?', cut);
  }
}

module.exports = { Store };
