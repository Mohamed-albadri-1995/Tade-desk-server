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
    indicator TEXT,
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

// Migration: add indicator column if missing
try { db.exec('ALTER TABLE trading_setups ADD COLUMN indicator TEXT'); } catch { /* already exists */ }
// Migration: broker submission traceability — when we fan out to Alpaca
// paper, its order id is stamped on our order + position rows so the
// fill-tracking loop can match Alpaca's status updates back to us.
try { db.exec('ALTER TABLE trading_orders ADD COLUMN alpaca_order_id TEXT'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE trading_positions ADD COLUMN alpaca_order_id TEXT'); } catch { /* already exists */ }

// Migration: grading-loop overrides + auto-pause config on the setup itself.
//   override_kill_switch  — 1 means ignore the multiplier=0 kill switch and
//                           trade the setup at signal-grade sizing anyway.
//                           User escape hatch when they believe the model
//                           is wrong (e.g. a market-regime shift the sample
//                           doesn't reflect yet).
//   auto_pause_c_streak   — number of consecutive C-graded fires that will
//                           auto-flip enabled=0 on the setup. 0 disables.
//                           Default 0 so existing setups aren't affected
//                           until the user opts in per setup.
try { db.exec('ALTER TABLE trading_setups ADD COLUMN override_kill_switch INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
try { db.exec('ALTER TABLE trading_setups ADD COLUMN auto_pause_c_streak INTEGER NOT NULL DEFAULT 0'); } catch { /* already exists */ }
// If set (e.g. 'vwap_cluster_bounce'), the check evaluator will pull
// the setup's mandatory conditions from the qp Python library instead
// of the JS indicator engine's debug(). Same source as the compare
// tool's setup picker — guarantees no drift between the two.
try { db.exec("ALTER TABLE trading_setups ADD COLUMN qp_setup_id TEXT"); } catch { /* already exists */ }

// Event log for grading-loop actions (kill-switch blocks, overrides,
// auto-pauses). Feeds the UI's "why did this happen" panel.
db.exec(`
  CREATE TABLE IF NOT EXISTS trading_grading_events (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    setup_id TEXT NOT NULL,
    kind TEXT NOT NULL,           -- 'kill_block' | 'kill_override' | 'auto_pause' | 'grade_drift'
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS trading_grading_events_setup_idx
    ON trading_grading_events(setup_id, ts DESC);
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
  // Data source — 'polling' (60s HTTP) or 'websocket' (Alpaca live stream)
  ['trading_data_source', 'polling'],
  // Execution mode — 'off' (block everything) | 'paper' (notify only) | 'live' (send to broker)
  ['trading_execution_mode', 'paper'],
  // Live-money safety: brokers.send() checks this before any live POST.
  // Defaults to 'false' so a fresh install can NEVER send a live order
  // until the user explicitly acknowledges it in Settings. Values: 'true' | 'false'.
  ['trading_live_confirmed', 'false'],
  // Market Gate rules (was 'sideA_' settings)
  ['trading_gate_enabled', '1'],
  ['trading_gate_neutral_multiplier', '0.75'],
  ['trading_gate_weak_sec_score', '10'],
  ['trading_gate_weak_sec_multiplier', '0.8'],
  // Grading engine — expectancy and letter-grade thresholds
  ['grading_min_setup_trades',       '20'],
  ['grading_min_check_side_trades',  '5'],
  ['grading_kill_expectancy_r',      '-0.5'],
  ['grading_kill_min_trades',        '30'],
  ['grading_live_aplus_r',           '1.5'],
  ['grading_live_a_r',               '1.0'],
  ['grading_live_b_r',               '0.5'],
];

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of tradingDefaults) insertSetting.run(k, v);

// One-time migration of old sideA_* keys → new trading_gate_* keys so a
// user upgrading doesn't lose their tuned thresholds.
const migrations = [
  ['trading_sideA_gate_enabled',        'trading_gate_enabled'],
  ['trading_sideA_neutral_multiplier',  'trading_gate_neutral_multiplier'],
  ['trading_sideA_weak_sec_score',      'trading_gate_weak_sec_score'],
  ['trading_sideA_weak_sec_multiplier', 'trading_gate_weak_sec_multiplier'],
];
const readVal   = db.prepare('SELECT value FROM settings WHERE key = ?');
const writeVal  = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
const dropOld   = db.prepare('DELETE FROM settings WHERE key = ?');
for (const [oldKey, newKey] of migrations) {
  const oldRow = readVal.get(oldKey);
  if (!oldRow) continue;
  const newRow = readVal.get(newKey);
  // Only carry the old value forward if the new key is still at its default —
  // avoids overwriting a value the user just typed on the new key.
  if (newRow && newRow.value === oldRow.value) { dropOld.run(oldKey); continue; }
  writeVal.run(oldRow.value, newKey);
  dropOld.run(oldKey);
}

module.exports = db;
