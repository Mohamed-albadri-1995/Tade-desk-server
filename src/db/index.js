const Database = require('better-sqlite3');
const path = require('path');
const config = require('../config');

// Per-tool database — see src/config.js. Each tool owns its own file so their
// registers, shortlists, training rows and settings stay entirely separate.
const DB_PATH = config.dbPath;

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS shortlist (
    date TEXT PRIMARY KEY,
    items TEXT NOT NULL DEFAULT '[]',
    exported INTEGER NOT NULL DEFAULT 0,
    exported_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS r1_frozen (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    data TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    PRIMARY KEY (date, ticker)
  );

  CREATE TABLE IF NOT EXISTS r2_market_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    slot TEXT NOT NULL,
    captured_at INTEGER NOT NULL,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS r3a (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    entry_price_a REAL,
    hh_a REAL,
    ll_a REAL,
    atr14 REAL,
    up_r_a REAL,
    down_r_a REAL,
    captured_at INTEGER NOT NULL,
    PRIMARY KEY (date, ticker)
  );

  CREATE TABLE IF NOT EXISTS r3b (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    entry_price_b REAL,
    hh_b REAL,
    ll_b REAL,
    atr14 REAL,
    up_r_b REAL,
    down_r_b REAL,
    captured_at INTEGER NOT NULL,
    PRIMARY KEY (date, ticker)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS r0_checkpoint (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    data TEXT NOT NULL,
    saved_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduler_jobs (
    job_id TEXT PRIMARY KEY,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS analysis_model (
    id INTEGER PRIMARY KEY,
    trained_at INTEGER NOT NULL,
    config TEXT NOT NULL,
    features TEXT NOT NULL,
    backtest TEXT NOT NULL,
    insights TEXT
  );

  CREATE TABLE IF NOT EXISTS screeners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    filters TEXT NOT NULL,
    sort TEXT,
    limit_n INTEGER NOT NULL DEFAULT 50,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS r4a_train (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    data TEXT NOT NULL,
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (date, ticker)
  );

  CREATE TABLE IF NOT EXISTS r4b_train (
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    data TEXT NOT NULL,
    source TEXT NOT NULL,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (date, ticker)
  );
`);

// Default settings
const defaults = [
  ['hotImmediateThreshold', '60'],
  ['hotSustainedThreshold', '40'],
  ['hotSustainedSessions', '3'],
  ['hotFloorThreshold', '20'],
  ['coolOffDays', '2'],
  ['sectorBullishThreshold', '20'],
  ['sectorBearishThreshold', '-20'],
  ['shortlistMinScore', '70'],
  ['shortlistTopN', '5'],
  ['scorerEntryTime', '9:40'],
  ['regimeSampleThreshold', '150'],
  ['finnhubApiKey', ''],
  ['githubBackupToken', ''],
  ['alpacaApiKey', ''],
  ['alpacaApiSecret', ''],
  ['alpacaAccountUrl', 'https://paper-api.alpaca.markets'],
  ['analysisEntryType', 'A'],
  ['analysisDirectionalBias', 'Up'],
  ['analysisSuccessThreshold', '1.5'],
  ['analysisTrainingWindow', '90'],
  ['aiApiKey', ''],
  ['aiModel', 'anthropic/claude-haiku-4-5'],
];
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of defaults) insertSetting.run(k, v);

// Force-update aiModel if it still has the old OpenAI default
db.prepare("UPDATE settings SET value = 'anthropic/claude-haiku-4-5' WHERE key = 'aiModel' AND value = 'gpt-4o-mini'").run();

module.exports = db;
