/**
 * Trading tool — stage-boundary integration tests
 *
 * Exercises the wires between Market Gate → Setup Engine → Router →
 * Positions → Grading. Does NOT hit Alpaca — signals are injected
 * directly via setupEngine.onIndicatorFire.
 *
 * Note: uses a shared DB. Each test seeds and cleans its own state so
 * they can run in any order.
 */

// Use an isolated DB file per test run to avoid poisoning dev data.
process.env.DB_PATH = process.env.DB_PATH || '';
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// Point the DB at a tmp file BEFORE anything else pulls src/db.
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tradetest-'));
const TMP_DB_DIR = path.join(TMP_DIR, 'data');
fs.mkdirSync(TMP_DB_DIR, { recursive: true });
// Redirect the DB by copying process.cwd() semantics — src/db uses __dirname
// so instead of trying to point that at TMP_DIR, we wipe rows between tests.
require('../src/trading/db');
const db          = require('../src/db');
const marketGate  = require('../src/trading/marketGate');
const setupEngine = require('../src/trading/setupEngine');
const router      = require('../src/trading/router');
const grading     = require('../src/trading/grading');
const checks      = require('../src/trading/checks');
const brokers     = require('../src/trading/brokers');
const { v4: uuidv4 } = require('uuid');

function cleanDb() {
  db.exec(`
    DELETE FROM trading_positions;
    DELETE FROM trading_orders;
    DELETE FROM trading_signals;
    DELETE FROM trading_signal_log;
    DELETE FROM trading_sessions;
    DELETE FROM trading_setups;
    DELETE FROM trade_card_checks;
    DELETE FROM trade_cards;
    DELETE FROM check_library WHERE check_key IN ('good', 'edit_test');
  `);
  marketGate.clear();
  setupEngine.clearSessionLog();
}

function seedSetup(overrides = {}) {
  const s = {
    id:           overrides.id           || uuidv4(),
    name:         overrides.name         || 'test-setup',
    description:  overrides.description  || '',
    indicator:    overrides.indicator    || 'test',
    entry_type:   overrides.entry_type   || 'market',
    window_start: overrides.window_start || '00:00',
    window_end:   overrides.window_end   || '23:59',
    enabled:      overrides.enabled ?? 1,
    config:       overrides.config       || '{}',
  };
  db.prepare(`
    INSERT INTO trading_setups (id, name, description, indicator, entry_type, window_start, window_end, enabled, config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(s.id, s.name, s.description, s.indicator, s.entry_type, s.window_start, s.window_end, s.enabled, s.config);
  setupEngine.loadSetups();
  return s;
}

async function fireSignalDirect({ ticker = 'AAPL', setupId, direction = 'Long', entry = 100, sl = 95, tp = 110 } = {}) {
  let routerPromise = null;
  setupEngine.onIndicatorFire(
    { ticker, setupId, direction, entry, sl, tp, entryType: 'market' },
    'test-session',
    (enriched) => {
      routerPromise = router.processSignal({ ...enriched, sessionId: 'test-session' }, null, null);
    }
  );
  if (routerPromise) await routerPromise;
  return { passed: !!routerPromise };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Trading pipeline — stage boundaries', () => {
  beforeEach(cleanDb);

  test('Market Gate empty → Setup Engine blocks the fire (no order, no position)', async () => {
    const setup = seedSetup();
    db.prepare("UPDATE settings SET value = 'paper' WHERE key = 'trading_execution_mode'").run();
    const result = await fireSignalDirect({ setupId: setup.id });

    const signals   = db.prepare('SELECT COUNT(*) AS n FROM trading_signals').get().n;
    const positions = db.prepare('SELECT COUNT(*) AS n FROM trading_positions').get().n;
    const logCount  = db.prepare("SELECT COUNT(*) AS n FROM trading_signal_log WHERE source = 'native'").get().n;

    expect(logCount).toBe(1);      // fire IS logged
    expect(signals).toBe(0);       // but not turned into a signal
    expect(positions).toBe(0);     // and no position opened
  });

  test('Market Gate permits → Router opens exactly one order + one position (paper mode)', async () => {
    const setup = seedSetup();
    marketGate.update('AAPL', { shortTerm: 'BULLISH', secBias: 'BULLISH', longTerm: 'BULLISH', secScore: 40 }, 80, null);
    db.prepare("UPDATE settings SET value = 'paper' WHERE key = 'trading_execution_mode'").run();

    await fireSignalDirect({ setupId: setup.id });
    const orders    = db.prepare('SELECT COUNT(*) AS n FROM trading_orders').get().n;
    const positions = db.prepare("SELECT COUNT(*) AS n FROM trading_positions WHERE status = 'open'").get().n;

    expect(orders).toBe(1);
    expect(positions).toBe(1);
  });

  test('Execution mode off → nothing gets persisted even when the gate is open', async () => {
    const setup = seedSetup();
    marketGate.update('AAPL', { shortTerm: 'BULLISH', secBias: 'BULLISH', longTerm: 'BULLISH', secScore: 40 }, 80, null);
    db.prepare("UPDATE settings SET value = 'off' WHERE key = 'trading_execution_mode'").run();

    await fireSignalDirect({ setupId: setup.id });
    const orders    = db.prepare('SELECT COUNT(*) AS n FROM trading_orders').get().n;
    const positions = db.prepare('SELECT COUNT(*) AS n FROM trading_positions').get().n;

    expect(orders).toBe(0);
    expect(positions).toBe(0);
  });

  test('Direction bearish market blocks a long signal', async () => {
    const setup = seedSetup();
    // Bearish confirmed by sector: shortTerm=BEARISH, secBias=BEARISH → long blocked, short allowed
    marketGate.update('AAPL', { shortTerm: 'BEARISH', secBias: 'BEARISH', longTerm: 'BEARISH', secScore: -40 }, 80, null);
    db.prepare("UPDATE settings SET value = 'paper' WHERE key = 'trading_execution_mode'").run();

    await fireSignalDirect({ setupId: setup.id, direction: 'Long' });
    const signals = db.prepare('SELECT COUNT(*) AS n FROM trading_signals').get().n;
    expect(signals).toBe(0);
  });

  test('Closing a position writes P&L on the trade card so grading can learn from it', async () => {
    const setup = seedSetup();
    marketGate.update('AAPL', { shortTerm: 'BULLISH', secBias: 'BULLISH', longTerm: 'BULLISH', secScore: 40 }, 80, null);
    db.prepare("UPDATE settings SET value = 'paper' WHERE key = 'trading_execution_mode'").run();

    await fireSignalDirect({ setupId: setup.id, entry: 100, sl: 95 });
    const positionRow = db.prepare("SELECT id FROM trading_positions WHERE status = 'open'").get();
    expect(positionRow).toBeTruthy();

    const closeResult = router.closePosition(positionRow.id, 110, 'target');
    expect(closeResult.ok).toBe(true);

    const card = db.prepare('SELECT * FROM trade_cards WHERE position_id = ?').get(positionRow.id);
    expect(card).toBeTruthy();
    expect(card.r_multiple).toBeCloseTo(2, 3); // exit 110, entry 100, stop 95 → +2R
    expect(card.exit_reason).toBe('target');
  });

  test('Daily loss check reads realized P&L closed today (not opened)', async () => {
    const setup = seedSetup();
    marketGate.update('AAPL', { shortTerm: 'BULLISH', secBias: 'BULLISH', longTerm: 'BULLISH', secScore: 40 }, 80, null);
    db.prepare("UPDATE settings SET value = 'paper' WHERE key = 'trading_execution_mode'").run();
    db.prepare("UPDATE settings SET value = '5' WHERE key = 'trading_daily_loss_limit'").run();

    // Open + close first position with a big loss to blow the limit
    await fireSignalDirect({ setupId: setup.id, entry: 100, sl: 99, tp: 105 });
    const p = db.prepare("SELECT id FROM trading_positions WHERE status = 'open'").get();
    router.closePosition(p.id, 50, 'stop'); // huge loss

    // Now a new signal should be blocked at the risk gate
    const risk = router.checkRisk('MSFT', 'Long', 10);
    expect(risk.ok).toBe(false);
    expect(String(risk.reason)).toMatch(/Daily loss/i);
  });

  test('Grading learns from closed cards and grades a new fire', () => {
    // Seed a library entry so the version-tag JOIN in checkContributions
    // finds the linked rows. Any check_key present in trade_card_checks
    // must also exist in check_library with matching version_id.
    db.prepare(`
      INSERT OR IGNORE INTO check_library
        (id, check_key, label, category, section, description, condition, enabled, created_at, updated_at, version_id)
      VALUES (?, 'good', 'good check', 'additional', null, null, '{}', 1, ?, ?, 1)
    `).run(uuidv4(), Date.now(), Date.now());

    // Seed 30 completed cards on setup S1 with one aligned check that
    // strongly correlates with wins.
    const setupId = uuidv4();
    for (let i = 0; i < 30; i++) {
      const cardId = uuidv4();
      const r = i < 20 ? 2 : -0.5;
      db.prepare(`
        INSERT INTO trade_cards (id, date, ticker, setup_id, direction, position_id, entry_price, stop_distance, r_multiple, closed_at, context, fired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cardId, '2026-06-30', 'TEST', setupId, 'Long', uuidv4(), 100, 1, r, Date.now(), '{}', Date.now());
      db.prepare(`
        INSERT INTO trade_card_checks (id, card_id, kind, check_key, label, aligned, check_version_id)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(uuidv4(), cardId, 'additional', 'good', 'good check', r > 0 ? 1 : 0);
    }
    const aligned    = grading.gradeSignal({ setupId, additionalChecks: [{ key: 'good', aligned: true }] });
    const notAligned = grading.gradeSignal({ setupId, additionalChecks: [{ key: 'good', aligned: false }] });
    expect(aligned.grade).toBe('A+');
    expect(notAligned.grade).not.toBe('A+');
    expect(aligned.totalR).toBeGreaterThan(notAligned.totalR);
  });

  test('At least one broker profile always exists (default paper)', () => {
    const active = brokers.getActive();
    expect(active.length).toBeGreaterThan(0);
    expect(active.every(b => b.enabled)).toBe(true);
  });

  test('Editing a check bumps its version and freezes its old learning', () => {
    // Create a library entry, seed 20 cards linked at version 1 that make
    // the check look like a winner, then edit the condition. The learning
    // pool should reset to empty (0 aligned trades under version 2), so
    // gradeSignal falls back to the setup baseline instead of citing the
    // stale expectancy delta.
    const setupId = uuidv4();
    const check = checks.createCheck({
      check_key: 'edit_test',
      label:     'edit test',
      category:  'additional',
      condition: { op: 'gt', left: { field: 'close' }, right: { literal: 0 } },
    });
    expect(check.versionId).toBe(1);

    for (let i = 0; i < 20; i++) {
      const cardId = uuidv4();
      const r = i < 15 ? 2 : -0.5;
      db.prepare(`
        INSERT INTO trade_cards (id, date, ticker, setup_id, direction, position_id, entry_price, stop_distance, r_multiple, closed_at, context, fired_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(cardId, '2026-06-30', 'TEST', setupId, 'Long', uuidv4(), 100, 1, r, Date.now(), '{}', Date.now());
      db.prepare(`
        INSERT INTO trade_card_checks (id, card_id, kind, check_key, label, aligned, check_version_id)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(uuidv4(), cardId, 'additional', 'edit_test', 'edit test', r > 0 ? 1 : 0);
    }

    const before = grading.checkContributions(setupId);
    expect(before.find(c => c.key === 'edit_test')).toBeTruthy();

    // Edit the condition → version bumps to 2, old rows still tagged 1.
    const bumped = checks.updateCheck(check.id, {
      condition: { op: 'gt', left: { field: 'close' }, right: { literal: 1 } },
    });
    expect(bumped.versionId).toBe(2);

    const after = grading.checkContributions(setupId);
    expect(after.find(c => c.key === 'edit_test')).toBeFalsy();
  });
});
