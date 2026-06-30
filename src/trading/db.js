/**
 * Trading tool database tables.
 * Called once at startup to ensure tables exist.
 */
const db = require('../db');

db.exec(`
  CREATE TABLE IF NOT EXISTS trading_setups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    entry_type TEXT NOT NULL DEFAULT 'market',
    window_start TEXT NOT NULL DEFAULT '9:35',
    window_end TEXT NOT NULL DEFAULT '10:00',
    enabled INTEGER NOT NULL DEFAULT 1,
    config TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS trading_sessions (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    shortlist TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'active'
  );

  CREATE TABLE IF NOT EXISTS trading_signals (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    setup_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    entry_type TEXT NOT NULL,
    sl REAL NOT NULL,
    tp REAL NOT NULL,
    fired_at INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'native',
    status TEXT NOT NULL DEFAULT 'pending',
    dismissed INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS trading_orders (
    id TEXT PRIMARY KEY,
    signal_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL,
    shares INTEGER NOT NULL,
    entry_price REAL,
    sl REAL NOT NULL,
    tp REAL NOT NULL,
    dollar_risk REAL NOT NULL,
    position_value REAL NOT NULL,
    alpaca_payload TEXT NOT NULL,
    humanized_msg TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'notified',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS trading_signal_log (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    setup_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    sl REAL,
    tp REAL,
    fired_at INTEGER NOT NULL,
    source TEXT NOT NULL,
    matched INTEGER
  );

  CREATE TABLE IF NOT EXISTS trading_positions (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL,
    shares INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    entry_time TEXT NOT NULL,
    sl REAL NOT NULL,
    tp REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    exit_price REAL,
    exit_time TEXT,
    pnl REAL,
    opened_at INTEGER NOT NULL,
    closed_at INTEGER
  );
`);

// Default trading settings
const tradingDefaults = [
  ['trading_risk_pct', '1.0'],
  ['trading_max_shares', '1000'],
  ['trading_max_dollar_risk', '500'],
  ['trading_max_total_exposure', '10000'],
  ['trading_max_open_positions', '3'],
  ['trading_daily_loss_limit', '1000'],
  ['trading_score_multiplier_high', '1.2'],
  ['trading_score_multiplier_low', '0.8'],
  ['trading_score_threshold_high', '85'],
  ['trading_score_threshold_low', '70'],
  ['trading_equity', '25000'],
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of tradingDefaults) insertSetting.run(k, v);

module.exports = db;
