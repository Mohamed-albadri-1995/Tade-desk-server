const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '../../data/tradedesk.db');

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
  ['finnhubApiKey', ''],
  ['githubBackupToken', ''],
  ['alpacaApiKey', ''],
  ['alpacaApiSecret', ''],
];
const insertSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
for (const [k, v] of defaults) insertSetting.run(k, v);

module.exports = db;
