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
    or_high REAL,
    or_low REAL,
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
    or_high REAL,
    or_low REAL,
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
    run_from TEXT,
    check_from TEXT,
    check_to TEXT,
    run_to TEXT,
    mirror_of TEXT,
    label_only INTEGER NOT NULL DEFAULT 0,
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

// ── column migrations ──────────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so a
// column added to the schema above never reaches a database created before it.
// The tools deployed earliest are the ones that miss out, which is exactly
// backwards: they hold the most history and are the most expensive to rebuild.
//
// This crashed T2 and T3 on every start — a screeners table with no run_from,
// and code that had started reading it.
function ensureColumns(table, columns) {
  let existing;
  try {
    existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  } catch {
    return;                       // table not there at all; the schema owns it
  }
  for (const [name, decl] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
      console.log(`[DB] added missing column ${table}.${name}`);
    } catch (err) {
      console.warn(`[DB] could not add ${table}.${name}: ${err.message}`);
    }
  }
}

// Run windows, added after the first tools were already running.
ensureColumns('screeners', { run_from: 'TEXT', run_to: 'TEXT' });
// When it is worth OPENING the tool, as opposed to when the screener scans.
// They are not the same thing and conflating them is why the pre-market gap
// screener looked worth checking at 04:30, when it had found nothing yet.
ensureColumns('screeners', { check_from: 'TEXT', check_to: 'TEXT' });
// A screener that maintains a LIST rather than proposing trades. Its matches
// never enter r0 and it is exempt from the tradability floor, because "is this
// a growth company" is not a question about whether you could day-trade it.
ensureColumns('screeners', { label_only: 'INTEGER NOT NULL DEFAULT 0' });

// Which screener a mirror was made from. Recorded rather than inferred from the
// name: the pairing used to be read off a "(mirror)" suffix, so renaming a
// mirror — which is a perfectly ordinary thing to do — silently unpaired it and
// the whole directional comparison went missing for that tool.
ensureColumns('screeners', { mirror_of: 'TEXT' });

// The 09:30–09:35 opening range. Free to capture — the 1-minute bars are
// already fetched for the outcome maths — and it is the trigger level for the
// one day-trading setup with published evidence behind it, so not recording it
// would mean a month of data that cannot answer the question afterwards.
ensureColumns('r3a', { or_high: 'REAL', or_low: 'REAL' });
ensureColumns('r3b', { or_high: 'REAL', or_low: 'REAL' });

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
  // Tradability floor — applied to every screener on this tool. See tradable.js.
  ['minAvgVolume', '1000000'],
  ['minAtr', '1'],
  ['minAtrPct', '3'],
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
