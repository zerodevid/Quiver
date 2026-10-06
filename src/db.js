'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- One database is shared by ALL chains (the same wallet on Robinhood Chain and BSC).
-- The chain column ('robinhood' | 'bsc' | ...) separates the data; keys that can
-- collide across chains (token address, pool_ref, tokenId) carry chain in the PK.

-- wallets being copied
CREATE TABLE IF NOT EXISTS targets (
  chain       TEXT NOT NULL DEFAULT 'robinhood',
  address     TEXT NOT NULL,
  label       TEXT,
  enabled     INTEGER NOT NULL DEFAULT 1,
  rules       TEXT,                 -- JSON: per-target rules override (null = use defaults)
  added_ts    INTEGER NOT NULL,
  notes       TEXT,
  PRIMARY KEY (chain, address)
);

-- every LP action detected from a target
CREATE TABLE IF NOT EXISTS actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain         TEXT NOT NULL DEFAULT 'robinhood',
  ts            INTEGER NOT NULL,
  block         INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  target        TEXT NOT NULL,
  venue         TEXT NOT NULL,      -- v4 | v3 | v3pool
  kind          TEXT NOT NULL,      -- mint | increase | decrease | burn | collect | transfer_in | transfer_out
  token_id      TEXT,
  pool_ref      TEXT,               -- poolId (v4) or pool address (v3)
  token0        TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower    INTEGER, tick_upper INTEGER,
  liquidity     TEXT,               -- delta L (positive = add)
  amount0       TEXT, amount1 TEXT,
  value_quote   REAL,               -- position value in the quote asset
  quote_symbol  TEXT,
  UNIQUE(tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);
CREATE INDEX IF NOT EXISTS idx_actions_target ON actions(target, ts DESC);
CREATE INDEX IF NOT EXISTS idx_actions_chain_ts ON actions(chain, ts DESC);
-- history of one target position (Telegram card: how much they entered/withdrew on that NFT)
CREATE INDEX IF NOT EXISTS idx_actions_pos ON actions(chain, target, venue, token_id, ts);

-- the bot's decision on every action (copied / skipped + its reason)
CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id  INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  verdict    TEXT NOT NULL,        -- copy | skip | error | dry
  reason     TEXT,
  plan       TEXT,                 -- JSON execution plan
  tx_hash    TEXT,
  position_id INTEGER,
  FOREIGN KEY(action_id) REFERENCES actions(id)
);
CREATE INDEX IF NOT EXISTS idx_dec_ts ON decisions(ts DESC);
-- handle() asks "already decided?" for EVERY action, and backfill joins
-- actions with decisions: without an index both scan the whole table (O(n²) at start).
CREATE INDEX IF NOT EXISTS idx_dec_action ON decisions(action_id);

-- our own positions
CREATE TABLE IF NOT EXISTS positions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chain         TEXT NOT NULL DEFAULT 'robinhood',
  venue         TEXT NOT NULL,
  token_id      TEXT,
  pool_ref      TEXT NOT NULL,
  token0        TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower    INTEGER, tick_upper INTEGER,
  liquidity     TEXT NOT NULL DEFAULT '0',
  target        TEXT,
  mirror_of     TEXT,              -- token_id of the target position being mirrored
  status        TEXT NOT NULL,     -- open | closed | pending | failed
  opened_ts     INTEGER, closed_ts INTEGER,
  cost0         TEXT DEFAULT '0', cost1 TEXT DEFAULT '0',
  cost_quote    REAL DEFAULT 0,
  out0          TEXT DEFAULT '0', out1 TEXT DEFAULT '0',
  out_quote     REAL DEFAULT 0,
  -- Memecoin that also came out when the position closed and is NOT yet sold. out_quote already
  -- includes its value at the close price (left_quote); once sold, out_quote is corrected
  -- to the actual sale result. While still held, equity values it at the current price.
  left_token    TEXT,
  left_amount   TEXT DEFAULT '0',
  left_quote    REAL DEFAULT 0,
  fees_quote    REAL DEFAULT 0,
  quote_symbol  TEXT,
  tx_open       TEXT, tx_close TEXT,
  entry_sqrt    TEXT, exit_sqrt TEXT,  -- pool price (sqrtPriceX96) at entry & exit
  last_sync     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status);
CREATE INDEX IF NOT EXISTS idx_pos_chain_status ON positions(chain, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pos_token_chain ON positions(chain, venue, token_id) WHERE token_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pos_mirror ON positions(mirror_of, target);

-- pool metadata cache
CREATE TABLE IF NOT EXISTS pools (
  chain        TEXT NOT NULL DEFAULT 'robinhood',
  pool_ref     TEXT NOT NULL,
  venue        TEXT NOT NULL,
  token0       TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  pool_addr    TEXT,
  first_block  INTEGER,
  first_ts     INTEGER,
  -- birth price of a v4 pool from the Initialize event (block + sqrtPriceX96): the price at the
  -- event block that was never preceded by a Swap. See Chain.poolInitOf.
  init_block   INTEGER,
  init_sqrt    TEXT,
  PRIMARY KEY (chain, pool_ref)
);

CREATE TABLE IF NOT EXISTS tokens (
  chain     TEXT NOT NULL DEFAULT 'robinhood',
  address   TEXT NOT NULL,
  symbol    TEXT, name TEXT, decimals INTEGER,
  seen_ts   INTEGER,
  PRIMARY KEY (chain, address)
);

-- token logos (GeckoTerminal), files in data/icons/. status: ok | none | err
CREATE TABLE IF NOT EXISTS icons (
  chain      TEXT NOT NULL DEFAULT 'robinhood',
  address    TEXT NOT NULL,
  status     TEXT, file TEXT, ctype TEXT, src TEXT,
  checked_ts INTEGER,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS txs (
  hash       TEXT PRIMARY KEY,
  chain      TEXT NOT NULL DEFAULT 'robinhood',
  ts         INTEGER, kind TEXT, status TEXT,
  gas_used   INTEGER, gas_price TEXT, gas_quote REAL,
  error      TEXT, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_txs_kind_ts ON txs(kind, ts);

-- wallet_quote: cash in the wallet (USDG + ETH + WETH, USD); NULL = unreadable.
-- total_quote = cash + position value + unclaimed fees.
-- pnl_quote   = cumulative PnL (realized + unrealized) — a growth curve
--               that does not spike when funds are deposited/withdrawn.
CREATE TABLE IF NOT EXISTS equity (
  chain          TEXT NOT NULL DEFAULT 'robinhood',
  ts             INTEGER NOT NULL,
  wallet_quote   REAL, positions_quote REAL, total_quote REAL,
  realized_quote REAL, fees_quote REAL, open_positions INTEGER,
  pnl_quote      REAL,
  PRIMARY KEY (chain, ts)
);

-- ---- wallet research: positions & PnL of any wallet (not just ours) ----
-- Everything is derived from the chain: ModifyLiquidity + ERC20 Transfer inside the same tx,
-- then principal is separated from fees using the pool price at that time (from the Swap event).
CREATE TABLE IF NOT EXISTS wallets (
  chain          TEXT NOT NULL DEFAULT 'robinhood',
  address        TEXT NOT NULL,
  label          TEXT,
  first_block    INTEGER,      -- start of the window ever scanned
  scanned_to     INTEGER,      -- scanning has reached this block
  last_scan_ts   INTEGER,
  stats          TEXT,         -- JSON summary (cache)
  positions_n    INTEGER DEFAULT 0,
  PRIMARY KEY (chain, address)
);

CREATE TABLE IF NOT EXISTS wpositions (
  chain        TEXT NOT NULL DEFAULT 'robinhood',
  wallet       TEXT NOT NULL,
  venue        TEXT NOT NULL,
  token_id     TEXT NOT NULL,
  pool_ref     TEXT,
  token0 TEXT, token1 TEXT, fee INTEGER, tick_spacing INTEGER, hooks TEXT,
  tick_lower   INTEGER, tick_upper INTEGER,
  liquidity    TEXT DEFAULT '0',      -- current L (0 = closed)
  in0 TEXT DEFAULT '0',  in1 TEXT DEFAULT '0',   -- total tokens in (capital)
  out0 TEXT DEFAULT '0', out1 TEXT DEFAULT '0',  -- total tokens out (principal + fee)
  fee0 TEXT DEFAULT '0', fee1 TEXT DEFAULT '0',  -- the fee part of what came out
  live_value_q REAL DEFAULT 0,        -- current position value (only those still open)
  live_fee_q   REAL DEFAULT 0,        -- fees collected but not yet claimed
  in_range     INTEGER,
  invested_q   REAL DEFAULT 0,        -- capital in the quote asset, valued at the event
  returned_q   REAL DEFAULT 0,
  fees_q       REAL DEFAULT 0,
  pnl_q        REAL DEFAULT 0,
  quote_symbol TEXT,
  opened_block INTEGER, opened_ts INTEGER,
  closed_block INTEGER, closed_ts INTEGER,
  status       TEXT NOT NULL,         -- open | closed
  events_n     INTEGER DEFAULT 0,
  incomplete   INTEGER DEFAULT 0,     -- 1 = part of the history is outside the scan window
  -- A closed position that returned non-quote tokens: what has been swapped into
  -- USDG/ETH = realized (actual swap proceeds), the rest is still held by the wallet
  -- and valued at the current price = unrealized. pnl_q = both - capital.
  held_tok     TEXT DEFAULT '0',      -- non-quote token still held (raw)
  sold_tok     TEXT DEFAULT '0',      -- what has been swapped / sent out
  realized_q   REAL,                  -- USD actually in hand
  unrealized_q REAL,                  -- value of held_tok at the current pool price
  tracked_to   INTEGER,               -- sale tracking has reached this block
  PRIMARY KEY (chain, wallet, venue, token_id)
);
CREATE INDEX IF NOT EXISTS idx_wpos_wallet ON wpositions(chain, wallet, status);
CREATE INDEX IF NOT EXISTS idx_wpos_closed ON wpositions(chain, wallet, closed_ts DESC);

CREATE TABLE IF NOT EXISTS wevents (
  chain      TEXT NOT NULL DEFAULT 'robinhood',
  wallet     TEXT NOT NULL,
  token_id   TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER,
  tx_hash    TEXT NOT NULL,
  log_index  INTEGER NOT NULL,
  kind       TEXT NOT NULL,          -- mint | increase | decrease | close
  liq_delta  TEXT,
  amount0 TEXT, amount1 TEXT,        -- what actually moved (from ERC20 Transfer)
  princ0 TEXT, princ1 TEXT,          -- the principal part
  fee0 TEXT, fee1 TEXT,              -- the fee part (only on withdrawals)
  sqrt_price TEXT,                   -- pool price at that time
  value_q    REAL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_wev_pos ON wevents(chain, wallet, token_id, block);

-- Every tx that TAKES non-quote tokens OUT of the wallet after a position is closed:
-- how many tokens left and how much quote asset (USDG/ETH/WETH) came in in the same
-- tx. Read once from the receipt, then allocated FIFO to the positions that
-- ever received that token (see proceeds.js).
CREATE TABLE IF NOT EXISTS wsales (
  chain      TEXT NOT NULL DEFAULT 'robinhood',
  wallet     TEXT NOT NULL,
  token      TEXT NOT NULL,
  tx_hash    TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER,
  tok_out    TEXT NOT NULL,           -- token that left the wallet (raw)
  quote_usd  REAL,                    -- quote asset that came in, in USD (NULL = none)
  kind       TEXT,                    -- sell (quote came in) | send (none)
  PRIMARY KEY (chain, wallet, token, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_wsales ON wsales(chain, wallet, token, block);

-- Non-quote tokens that CAME INTO the wallet from outside the positions we track: bought on the
-- market, sent from another wallet, or leftovers of an LP outside the scan window. Without this the
-- FIFO queue runs out of stock and a sale spills onto a position that does not exist yet — one
-- cheap sale can be recorded as the proceeds of a position closed the day after.
CREATE TABLE IF NOT EXISTS wflows (
  chain    TEXT NOT NULL DEFAULT 'robinhood',
  wallet   TEXT NOT NULL,
  token    TEXT NOT NULL,
  tx_hash  TEXT NOT NULL,
  block    INTEGER NOT NULL,
  ts       INTEGER,
  tok_in   TEXT NOT NULL,             -- token that came into the wallet in this tx (raw, net)
  PRIMARY KEY (chain, wallet, token, tx_hash)
);
CREATE INDEX IF NOT EXISTS idx_wflows ON wflows(chain, wallet, token, block);

-- pool price at a block, from the nearest Swap event (expensive to look up, cheap to store)
CREATE TABLE IF NOT EXISTS wprices (
  chain      TEXT NOT NULL DEFAULT 'robinhood',
  pool_ref   TEXT NOT NULL,
  block      INTEGER NOT NULL,
  sqrt_price TEXT NOT NULL,
  src_block  INTEGER,
  PRIMARY KEY (chain, pool_ref, block)
);

-- RPC answers that can no longer change: calls tied to a single past block
-- (receipt, block header, balance/eth_call/getLogs at a block that is already deep).
-- Its contents may disappear at any time — at worst one more RPC call. The rules for
-- what may enter and when it is dropped: src/rpccache.js.
CREATE TABLE IF NOT EXISTS rpc_cache (
  chain   TEXT NOT NULL,
  k       TEXT NOT NULL,
  method  TEXT NOT NULL,
  block   INTEGER,
  res     TEXT NOT NULL,
  bytes   INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (chain, k)
);
CREATE INDEX IF NOT EXISTS idx_rpccache_ts ON rpc_cache(ts);

CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS logs (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ts  INTEGER NOT NULL, level TEXT, msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
`;

// Multi-chain migration for a database created before the `chain` column existed. All
// old rows = Robinhood Chain. Tables whose primary key must now include chain are
// rebuilt (SQLite cannot change a PRIMARY KEY via ALTER TABLE); the
// others just get ADD COLUMN. Idempotent: tables that already have the chain column are skipped.
const LEGACY = 'robinhood';
function migrateChain(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const exists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  // Tables with a new composite PK: rebuilt from the definition in SCHEMA.
  const rebuild = ['targets', 'pools', 'tokens', 'icons', 'equity', 'wallets', 'wpositions', 'wsales', 'wflows', 'wprices'];
  const create = (t) => {
    const m = SCHEMA.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${t} \\(([\\s\\S]*?)\\n\\);`));
    if (!m) throw new Error(`definisi tabel ${t} tidak ditemukan`);
    return m[0];
  };
  for (const t of rebuild) {
    if (!exists(t) || cols(t).includes('chain')) continue;
    const old = cols(t);
    db.exec('BEGIN');
    try {
      db.exec(create(t).replace(`CREATE TABLE IF NOT EXISTS ${t} (`, `CREATE TABLE ${t}__new (`));
      db.exec(`INSERT OR IGNORE INTO ${t}__new (chain, ${old.join(',')}) SELECT '${LEGACY}', ${old.join(',')} FROM ${t}`);
      db.exec(`DROP TABLE ${t}`);
      db.exec(`ALTER TABLE ${t}__new RENAME TO ${t}`);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw new Error(`migrasi tabel ${t}: ${e.message}`); }
  }
  // Tables whose PK is already unique across chains (autoincrement id / tx hash): just the column.
  for (const t of ['actions', 'positions', 'txs', 'wevents']) {
    if (exists(t) && !cols(t).includes('chain')) db.exec(`ALTER TABLE ${t} ADD COLUMN chain TEXT NOT NULL DEFAULT '${LEGACY}'`);
  }
  // The old unique index positions(venue, token_id) no longer applies across chains.
  db.exec('DROP INDEX IF EXISTS idx_pos_token');
  // State keys that used to be global are now per chain (engine.js sk()).
  if (exists('state') && !db.prepare("SELECT 1 FROM state WHERE k='schema_chain'").get()) {
    const keys = ['cursor', 'paused', 'adopt_scanned_to', 'dd_peak', 'dd_day', 'dd_tripped', 'leftovers', 'swap_seen', 'swap_tokens',
      'equity_pnl_backfill', 'capital_baseline', 'deposits_scanned_to', 'eth_usdg_pools', 'v3_factory'];
    for (const k of keys) db.prepare("UPDATE OR IGNORE state SET k = k || ':' || ? WHERE k = ?").run(LEGACY, k);
    db.prepare("INSERT OR REPLACE INTO state(k,v) VALUES('schema_chain','1')").run();
  }
}

function open(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // Chain migration FIRST (old tables rebuilt / given the column), then the schema: the new
  // indexes in SCHEMA refer to the chain column and would fail on tables that do not have it yet.
  migrateChain(db);
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS does not add columns to an already existing table.
  const eqCols = new Set(db.prepare('PRAGMA table_info(equity)').all().map((c) => c.name));
  if (!eqCols.has('pnl_quote')) {
    db.exec('ALTER TABLE equity ADD COLUMN pnl_quote REAL');
    // Before this column existed, wallet_quote was always written as 0 without ever being measured —
    // that is "unknown", not "cash empty".
    db.exec('UPDATE equity SET wallet_quote = NULL');
  }
  const posCols = new Set(db.prepare('PRAGMA table_info(positions)').all().map((c) => c.name));
  if (!posCols.has('claimed_quote')) db.exec('ALTER TABLE positions ADD COLUMN claimed_quote REAL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS fee_claims (
    tx_hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    amount0 TEXT NOT NULL, amount1 TEXT NOT NULL, value_quote REAL NOT NULL
  )`);
  // Memecoin from fees that were claimed but NOT yet sold. claimed_quote already holds
  // its value at the pool price at claim time (est_quote); once sold, that estimate is replaced by the
  // actual sale result — exactly the pattern of left_token/left_quote for close leftovers,
  // except the column that is corrected is claimed_quote (and out_quote if the position is already
  // closed, because markClosed folds claimed_quote into it).
  db.exec(`CREATE TABLE IF NOT EXISTS fee_leftovers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, chain TEXT NOT NULL, position_id INTEGER NOT NULL,
    ts INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, est_quote REAL NOT NULL,
    tx_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_feeleft_token ON fee_leftovers(chain, token);`);
  db.exec(`CREATE TABLE IF NOT EXISTS compound_settings (
    position_id INTEGER PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
    min_usd REAL NOT NULL DEFAULT 5, interval_minutes INTEGER NOT NULL DEFAULT 30,
    last_check INTEGER, last_tx TEXT, last_note TEXT,
    -- Automatic fee harvesting comes in two flavours: 'compound' (fees go back in as liquidity
    -- in the same position) and 'claim' (fees are withdrawn to the wallet; the memecoin side is sold
    -- into the pool's quote asset if sell_fee is on). Old rows = compound, the only
    -- mode that existed before this column.
    mode TEXT NOT NULL DEFAULT 'compound', sell_fee INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS compound_runs (
    tx_hash TEXT PRIMARY KEY, position_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    liquidity TEXT NOT NULL, reinvested_quote REAL NOT NULL
  )`);
  const cmpCols = new Set(db.prepare('PRAGMA table_info(compound_settings)').all().map((c) => c.name));
  if (!cmpCols.has('mode')) {
    db.exec("ALTER TABLE compound_settings ADD COLUMN mode TEXT NOT NULL DEFAULT 'compound'");
    db.exec('ALTER TABLE compound_settings ADD COLUMN sell_fee INTEGER NOT NULL DEFAULT 1');
  }
  if (!posCols.has('entry_sqrt')) {
    db.exec('ALTER TABLE positions ADD COLUMN entry_sqrt TEXT');
    db.exec('ALTER TABLE positions ADD COLUMN exit_sqrt TEXT');
  }
  if (!posCols.has('left_token')) {
    db.exec('ALTER TABLE positions ADD COLUMN left_token TEXT');
    db.exec(`ALTER TABLE positions ADD COLUMN left_amount TEXT DEFAULT '0'`);
    db.exec('ALTER TABLE positions ADD COLUMN left_quote REAL DEFAULT 0');
  }
  // Manual control ("take over"): the time a mirror position was released from its target. NULL =
  // automatic. See Manual.takeover.
  if (!posCols.has('takeover_ts')) db.exec('ALTER TABLE positions ADD COLUMN takeover_ts INTEGER');
  // Non-EVM venue data (JSON): the native range (DLMM bins / Orca-Raydium ticks), binStep,
  // the position NFT mint, and the target's L before the action. tick_lower/tick_upper still
  // hold the equivalent Uniswap ticks so the dashboard & exit triggers apply as is.
  if (!posCols.has('ext')) db.exec('ALTER TABLE positions ADD COLUMN ext TEXT');
  const actCols = new Set(db.prepare('PRAGMA table_info(actions)').all().map((c) => c.name));
  if (!actCols.has('ext')) db.exec('ALTER TABLE actions ADD COLUMN ext TEXT');
  const poolCols = new Set(db.prepare('PRAGMA table_info(pools)').all().map((c) => c.name));
  if (!poolCols.has('init_sqrt')) {
    db.exec('ALTER TABLE pools ADD COLUMN init_block INTEGER');
    db.exec('ALTER TABLE pools ADD COLUMN init_sqrt TEXT');
    // Before this, a research position with incomplete history still stored a partial
    // capital (a mint without a price: $0) and the PnL from that capital — showing "+$1,000" for a
    // position that merely came back whole. Now both are NULL = unknown; ones whose
    // price has not been read yet (incomplete=2) are re-read on the next update.
    db.exec('UPDATE wpositions SET invested_q=NULL, pnl_q=NULL WHERE incomplete<>0');
  }
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
  // `meta` is only for listeners, not stored: {quiet} = a problem being
  // handled by the fallback path (still recorded, not pushed to the chat); {recovered} =
  // recovery news that closes an earlier alert.
  log(level, msg, meta = null) {
    this.run('INSERT INTO logs(ts,level,msg) VALUES(?,?,?)', Date.now(), level, String(msg).slice(0, 2000));
    // Optional listener (Telegram bot) — its failure must not bring down the log writer.
    if (this.onLog) { try { this.onLog(level, String(msg), meta); } catch { /* abaikan */ } }
  }
  // drop old logs so the file does not bloat
  prune(days = 30) {
    const cut = Date.now() - days * 86400_000;
    this.run('DELETE FROM logs WHERE ts < ?', cut);
  }
}

module.exports = { Store };
