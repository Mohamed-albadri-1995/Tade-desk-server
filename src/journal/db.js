/**
 * Journal database tables. Called once at startup.
 */
const db = require('../db');

db.exec(`
  CREATE TABLE IF NOT EXISTS journal_trades (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    direction TEXT NOT NULL,
    setup_id TEXT,
    shares INTEGER NOT NULL,
    entry_price REAL NOT NULL,
    entry_time TEXT NOT NULL,
    exit_price REAL,
    exit_time TEXT,
    sl REAL,
    tp REAL,
    gross_pnl REAL,
    commission REAL NOT NULL DEFAULT 0,
    net_pnl REAL,
    pct_move REAL,
    duration_ms INTEGER,
    mae_pct REAL,
    mfe_pct REAL,
    r_multiple REAL,
    capture_pct REAL,
    exit_verdict TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    account TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    technical_computed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal_context_snapshots (
    trade_id TEXT PRIMARY KEY,
    regime TEXT,
    regime_label TEXT,
    sec_bias TEXT,
    broad_resolved TEXT,
    short_term TEXT,
    mid_term TEXT,
    long_term TEXT,
    sec_score REAL,
    sector TEXT,
    industry TEXT,
    scanner_score INTEGER,
    scanner_confidence REAL,
    captured_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS journal_technical_snapshots (
    trade_id TEXT PRIMARY KEY,
    price REAL,
    vwap REAL,
    ema9 REAL,
    ema13 REAL,
    ema20 REAL,
    ema50 REAL,
    sma20 REAL,
    bb_upper REAL,
    bb_lower REAL,
    bb_mid REAL,
    atr REAL,
    rvol REAL,
    pm_high REAL,
    pm_low REAL,
    price_rel_vwap TEXT,
    price_rel_ema9 TEXT,
    price_rel_ema13 TEXT,
    price_rel_ema20 TEXT,
    price_rel_ema50 TEXT,
    ema_stack_bullish INTEGER,
    bb_zone TEXT,
    computed_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS journal_conditions (
    id TEXT PRIMARY KEY,
    trade_id TEXT NOT NULL,
    condition_key TEXT NOT NULL,
    label TEXT NOT NULL,
    section TEXT,
    value TEXT,
    aligned INTEGER,
    mandatory INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS journal_setup_templates (
    id TEXT PRIMARY KEY,
    setup_id TEXT NOT NULL UNIQUE,
    conditions TEXT NOT NULL DEFAULT '[]',
    min_grade_trades INTEGER NOT NULL DEFAULT 20,
    min_condition_trades INTEGER NOT NULL DEFAULT 10,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal_daily_notes (
    date TEXT PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS journal_fee_profiles (
    id TEXT PRIMARY KEY,
    account TEXT NOT NULL UNIQUE,
    rules TEXT NOT NULL DEFAULT '[]',
    mode TEXT NOT NULL DEFAULT 'replace',
    updated_at INTEGER NOT NULL
  );
`);

// Migration: extend journal_technical_snapshots with the multi-day /
// multi-week / month / premarket levels + extra SMAs so the check-library
// evaluator has every field it can reference. Populated by technicalFetch
// (which runs dailyLevels.computeLevels on the fetched bar buffer).
// Missing values stay null on old imports until they're re-fetched.
const journalTechExtraColumns = [
  'sma5 REAL', 'sma9 REAL', 'sma13 REAL',
  'ma5day REAL', 'ma5day_slope REAL',
  'vwap_2day REAL', 'vwap_week REAL', 'vwap_month REAL',
  'week_high REAL', 'week_low REAL',
  'month_high REAL', 'month_low REAL',
  'prev_day_high REAL', 'prev_day_low REAL',
  'open REAL', 'high REAL', 'low REAL', 'volume REAL', 'prev_close REAL',
  'sec_hot INTEGER',
];
for (const col of journalTechExtraColumns) {
  try { db.exec(`ALTER TABLE journal_technical_snapshots ADD COLUMN ${col}`); } catch { /* exists */ }
}

module.exports = db;
