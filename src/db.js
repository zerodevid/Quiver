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
-- handle() menanyakan "sudah diputuskan?" untuk SETIAP aksi, dan backfill menggabungkan
-- actions dengan decisions: tanpa indeks keduanya memindai seluruh tabel (O(n²) saat start).
CREATE INDEX IF NOT EXISTS idx_dec_action ON decisions(action_id);

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
  -- Memecoin yang ikut keluar saat posisi tutup dan BELUM dijual. out_quote sudah
  -- memuat nilainya di harga tutup (left_quote); begitu terjual, out_quote dikoreksi
  -- ke hasil jual sesungguhnya. Selama masih dipegang, ekuitas menilainya di harga kini.
  left_token    TEXT,
  left_amount   TEXT DEFAULT '0',
  left_quote    REAL DEFAULT 0,
  fees_quote    REAL DEFAULT 0,
  quote_symbol  TEXT,
  tx_open       TEXT, tx_close TEXT,
  entry_sqrt    TEXT, exit_sqrt TEXT,  -- harga pool (sqrtPriceX96) saat masuk & keluar
  last_sync     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_token ON positions(venue, token_id) WHERE token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_mirror ON positions(mirror_of, target);

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

-- logo token (GeckoTerminal), berkasnya di data/icons/. status: ok | none | err
CREATE TABLE IF NOT EXISTS icons (
  address    TEXT PRIMARY KEY,
  status     TEXT, file TEXT, ctype TEXT, src TEXT,
  checked_ts INTEGER
);

CREATE TABLE IF NOT EXISTS txs (
  hash       TEXT PRIMARY KEY,
  ts         INTEGER, kind TEXT, status TEXT,
  gas_used   INTEGER, gas_price TEXT, gas_quote REAL,
  error      TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_txs_kind_ts ON txs(kind, ts);

-- wallet_quote: kas di wallet (USDG + ETH + WETH, USD); NULL = tidak terbaca.
-- total_quote = kas + nilai posisi + fee belum diklaim.
-- pnl_quote   = PnL kumulatif (terealisasi + belum terealisasi) — kurva pertumbuhan
--               yang tidak ikut melonjak saat dana disetor/ditarik.
CREATE TABLE IF NOT EXISTS equity (
  ts             INTEGER PRIMARY KEY,
  wallet_quote   REAL, positions_quote REAL, total_quote REAL,
  realized_quote REAL, fees_quote REAL, open_positions INTEGER,
  pnl_quote      REAL
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
  -- Posisi tertutup yang mengembalikan token non-kuotasi: yang sudah ditukar jadi
  -- USDG/ETH = terealisasi (hasil tukar sesungguhnya), sisanya masih dipegang wallet
  -- dan dinilai harga sekarang = belum terealisasi. pnl_q = keduanya - modal.
  held_tok     TEXT DEFAULT '0',      -- token non-kuotasi yang masih dipegang (mentah)
  sold_tok     TEXT DEFAULT '0',      -- yang sudah ditukar / dikirim keluar
  realized_q   REAL,                  -- USD yang benar-benar di tangan
  unrealized_q REAL,                  -- nilai held_tok pada harga pool sekarang
  tracked_to   INTEGER,               -- pelacakan penjualan sudah sampai blok ini
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

-- Tiap tx yang MENGELUARKAN token non-kuotasi dari wallet setelah posisi ditutup:
-- berapa token yang pergi dan berapa aset kuotasi (USDG/ETH/WETH) yang masuk di tx
-- yang sama. Dibaca sekali dari receipt, lalu dialokasikan FIFO ke posisi-posisi
-- yang pernah menerima token itu (lihat proceeds.js).
CREATE TABLE IF NOT EXISTS wsales (
  wallet     TEXT NOT NULL,
  token      TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER,
  tok_out    TEXT NOT NULL,           -- token yang keluar dari wallet (mentah)
  quote_usd  REAL,                    -- aset kuotasi yang masuk, dalam USD (NULL = tidak ada)
  kind       TEXT,                    -- sell (ada kuotasi masuk) | send (tidak ada)
  PRIMARY KEY (wallet, token, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_wsales ON wsales(wallet, token, block);

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
  // CREATE TABLE IF NOT EXISTS tidak menambah kolom ke tabel yang sudah ada.
  const eqCols = new Set(db.prepare('PRAGMA table_info(equity)').all().map((c) => c.name));
  if (!eqCols.has('pnl_quote')) {
    db.exec('ALTER TABLE equity ADD COLUMN pnl_quote REAL');
    // Sebelum kolom ini ada, wallet_quote selalu ditulis 0 tanpa pernah diukur —
    // itu "tidak diketahui", bukan "kas kosong".
    db.exec('UPDATE equity SET wallet_quote = NULL');
  }
  const posCols = new Set(db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name));
  if (!posCols.has('claimed_quote')) db.exec('ALTER TABLE positions ADD COLUMN claimed_quote REAL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS fee_claims (
    tx_hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    amount0 TEXT NOT NULL, amount1 TEXT NOT NULL, value_quote REAL NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS compound_settings (
    position_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    min_usd REAL NOT NULL DEFAULT 5, interval_minutes INTEGER NOT NULL DEFAULT 30,
    last_check INTEGER, last_tx TEXT, last_note TEXT
  );
  CREATE TABLE IF NOT EXISTS compound_runs (
    tx_hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    liquidity TEXT NOT NULL, reinvested_quote REAL NOT NULL
  )`);
  if (!posCols.has('entry_sqrt')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_sqrt TEXT');
    db.exec('ALTER TABLE positions ADD COLUMN exit_sqrt TEXT');
  }
  if (!posCols.has('left_token')) {
    db.exec('ALTER TABLE positions ADD COLUMN left_token TEXT');
    db.exec(`ALTER TABLE positions ADD COLUMN left_amount TEXT DEFAULT '0'`);
    db.exec('ALTER TABLE positions ADD COLUMN left_quote REAL DEFAULT 0');
  }
  // Kendali manual ("ambil alih"): waktu posisi cermin dilepas dari target. NULL =
  // otomatis. Lihat Manual.takeover.
  if (!posCols.has('takeover_ts')) db.exec('ALTER TABLE positions ADD COLUMN takeover_ts INTEGER');
  const wpCols = new Set(db.prepare('PRAGMA table_info(wpositions)').all().map((c) => c.name));
  if (!wpCols.has('held_tok')) {
    db.exec(`ALTER TABLE wpositions ADD COLUMN held_tok TEXT DEFAULT '0'`);
    db.exec(`ALTER TABLE wpositions ADD COLUMN sold_tok TEXT DEFAULT '0'`);
    db.exec('ALTER TABLE wpositions ADD COLUMN realized_q REAL');
    db.exec('ALTER TABLE wpositions ADD COLUMN unrealized_q REAL');
    db.exec('ALTER TABLE wpositions ADD COLUMN tracked_to INTEGER');
  }
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
  // `meta` hanya untuk pendengar, tidak disimpan: {quiet} = masalah yang sedang
  // ditangani jalan cadangan (tetap tercatat, tidak didorong ke chat); {recovered} =
  // kabar pulih yang menutup peringatan sebelumnya.
  log(level, msg, meta = null) {
    this.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', Date.now(), level, String(msg).slice(0, 2000));
    // Pendengar opsional (bot Telegram) — kegagalannya tidak boleh menjatuhkan penulis log.
    if (this.onLog) { try { this.onLog(level, String(msg), meta); } catch { /* abaikan */ } }
  }
  // buang log lama supaya file tidak membengkak
  prune(days = 30) {
    const cut = Date.now() - days * 86400_000;
    this.run('DELETE FROM logs WHERE ts < ?', cut);
  }
}

module.exports = { Store };
