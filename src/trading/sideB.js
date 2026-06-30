/**
 * Side B — Setup Matcher
 *
 * Manages registered setups and their signal engines.
 * Each setup has a native server implementation of its Pine Script indicator.
 * Signals fire when the indicator conditions are met, then pass through
 * the Side A direction gate before being forwarded to Center.
 *
 * Signal log is maintained for end-of-day TradingView comparison.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sideA = require('./sideA');

// In-memory signal log for the session: [{ id, ticker, setupId, direction, sl, tp, firedAt, source, matched }]
const sessionSignalLog = [];

// Active setups: Map<setupId, setupConfig>
let _setups = null;

function loadSetups() {
  const rows = db.prepare('SELECT * FROM trading_setups WHERE enabled = 1').all();
  _setups = new Map();
  for (const row of rows) {
    _setups.set(row.id, {
      ...row,
      config: JSON.parse(row.config || '{}'),
    });
  }
  return _setups;
}

function getSetups() {
  if (!_setups) loadSetups();
  return _setups;
}

function getSetup(id) {
  return getSetups().get(id) || null;
}

/**
 * Called by a setup's signal engine when its indicator fires.
 * Applies the direction gate and emits to Center if allowed.
 *
 * @param {object} signal - { ticker, setupId, direction, sl, tp, entryType, barData }
 * @param {Function} onSignalPassed - callback(enrichedSignal) when gate passes
 */
function onIndicatorFire(signal, sessionId, onSignalPassed) {
  const { ticker, setupId, direction, sl, tp, entryType } = signal;
  const now = Date.now();

  // Log signal regardless of gate outcome
  const logEntry = {
    id: uuidv4(),
    ticker,
    setupId,
    direction,
    sl,
    tp,
    firedAt: now,
    source: 'native',
    matched: null, // filled during TradingView comparison
  };
  sessionSignalLog.push(logEntry);

  // Persist to DB for end-of-day comparison
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(`
    INSERT OR IGNORE INTO trading_signal_log (id, date, ticker, setup_id, direction, sl, tp, fired_at, source, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(logEntry.id, date, ticker, setupId, direction, sl ?? null, tp ?? null, now, 'native', null);

  // Direction gate
  const gateEntry = sideA.get(ticker);
  const longAllowed = gateEntry?.longAllowed ?? true;
  const shortAllowed = gateEntry?.shortAllowed ?? true;

  const allowed = direction === 'Long' ? longAllowed : shortAllowed;
  if (!allowed) return; // blocked — do not fire

  // Persist to trading_signals
  const signalId = uuidv4();
  db.prepare(`
    INSERT INTO trading_signals (id, session_id, date, ticker, setup_id, direction, entry_type, sl, tp, fired_at, source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(signalId, sessionId, date, ticker, setupId, direction, entryType || 'market', sl, tp, now, 'native');

  const setup = getSetup(setupId);
  const sideAData = sideA.get(ticker);

  onSignalPassed({
    signalId,
    ticker,
    setupId,
    setupName: setup?.name || setupId,
    direction,
    entryType: entryType || setup?.entry_type || 'market',
    sl,
    tp,
    firedAt: now,
    sideA: sideAData,
  });
}

/**
 * Receive a webhook signal from TradingView and compare to native log.
 * Returns { matched, native, webhook }.
 */
function receiveWebhook(payload) {
  const { ticker, setupId, direction, sl, tp } = payload;
  const now = Date.now();
  const date = new Date().toISOString().slice(0, 10);

  // Log webhook signal
  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_signal_log (id, date, ticker, setup_id, direction, sl, tp, fired_at, source, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'webhook', NULL)
  `).run(id, date, ticker, setupId, direction, sl ?? null, tp ?? null, now);

  // Find matching native signal within 2-min window
  const windowMs = 2 * 60 * 1000;
  const native = sessionSignalLog.find(s =>
    s.ticker === ticker &&
    s.setupId === setupId &&
    s.direction === direction &&
    s.source === 'native' &&
    Math.abs(s.firedAt - now) <= windowMs
  );

  const matched = !!native;

  // Update match status in DB
  db.prepare('UPDATE trading_signal_log SET matched = ? WHERE id = ?').run(matched ? 1 : 0, id);
  if (native) {
    db.prepare('UPDATE trading_signal_log SET matched = 1 WHERE id = ?').run(native.id);
  }

  return { matched, native: native || null, webhookId: id };
}

/**
 * End-of-day comparison report: native vs TradingView signals for a date.
 */
function comparisonReport(date) {
  const rows = db.prepare('SELECT * FROM trading_signal_log WHERE date = ? ORDER BY fired_at').all(date);
  const native = rows.filter(r => r.source === 'native');
  const webhook = rows.filter(r => r.source === 'webhook');
  const matched = rows.filter(r => r.matched === 1 && r.source === 'native').length;

  return {
    date,
    nativeCount: native.length,
    webhookCount: webhook.length,
    matchedCount: matched,
    unmatchedNative: native.filter(r => !r.matched),
    unmatchedWebhook: webhook.filter(r => !r.matched),
    all: rows,
  };
}

function getSessionLog() {
  return [...sessionSignalLog];
}

function clearSessionLog() {
  sessionSignalLog.length = 0;
}

module.exports = {
  loadSetups,
  getSetups,
  getSetup,
  onIndicatorFire,
  receiveWebhook,
  comparisonReport,
  getSessionLog,
  clearSessionLog,
};
