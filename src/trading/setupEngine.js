/**
 * Setup Engine (was "Side B — Setup Matcher")
 *
 * Owns the enabled setups and the fire-handler that receives signals
 * from indicator engines. On each fire:
 *   1. Log the fire (always, even if blocked) for end-of-day comparison
 *   2. Check the Market Gate — block if the ticker's direction isn't allowed
 *   3. Forward the enriched signal to the Router (was "Center")
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const marketGate = require('./marketGate');
const { toETDate } = require('../utils/time');

const sessionSignalLog = [];
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
 * Returns the list of active setups as an array — the single source of
 * truth used by the bar poller so both the engine and the poller work
 * off the exact same list.
 */
function getActiveSetupsArray() {
  return [...getSetups().values()];
}

/**
 * @param {object} signal   { ticker, setupId, direction, sl, tp, entryType, entry, barData }
 * @param {string} sessionId
 * @param {Function} onSignalPassed  called with the enriched signal on gate pass
 */
function onIndicatorFire(signal, sessionId, onSignalPassed) {
  const { ticker, setupId, direction, sl, tp, entryType, entry } = signal;
  const now = Date.now();

  const logEntry = {
    id: uuidv4(),
    ticker,
    setupId,
    direction,
    sl,
    tp,
    firedAt: now,
    source: 'native',
    matched: null,
  };
  sessionSignalLog.push(logEntry);

  const date = toETDate(now);
  db.prepare(`
    INSERT OR IGNORE INTO trading_signal_log (id, date, ticker, setup_id, direction, sl, tp, fired_at, source, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(logEntry.id, date, ticker, setupId, direction, sl ?? null, tp ?? null, now, 'native', null);

  // Market Gate — fail-safe default: if the gate has never been populated
  // for this ticker (session not yet ready, poll failed, or unknown
  // ticker), block the trade. This prevents silent permits from a
  // half-initialised state.
  const gateEntry = marketGate.get(ticker);
  const gateReady = !!gateEntry;
  const longAllowed  = gateReady ? gateEntry.longAllowed  : false;
  const shortAllowed = gateReady ? gateEntry.shortAllowed : false;
  const allowed = direction === 'Long' ? longAllowed : shortAllowed;

  if (!allowed) {
    return { blocked: true, reason: gateReady ? 'Direction not allowed by Market Gate' : 'Market Gate not ready' };
  }

  const signalId = uuidv4();
  db.prepare(`
    INSERT INTO trading_signals (id, session_id, date, ticker, setup_id, direction, entry_type, sl, tp, fired_at, source, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(signalId, sessionId, date, ticker, setupId, direction, entryType || 'market', sl, tp, now, 'native');

  const setup = getSetup(setupId);
  const gateData = marketGate.get(ticker);

  onSignalPassed({
    signalId,
    ticker,
    setupId,
    setupName: setup?.name || setupId,
    direction,
    entryType: entryType || setup?.entry_type || 'market',
    entry: entry ?? null,
    sl,
    tp,
    firedAt: now,
    gate: gateData, // was `sideA` in the old schema
  });

  return { blocked: false, signalId };
}

/**
 * Receive a TradingView webhook signal and match it against the native
 * session log within a 2-minute window.
 */
function receiveWebhook(payload) {
  const { ticker, setupId, direction, sl, tp } = payload;
  const now = Date.now();
  const date = toETDate(now);

  const id = uuidv4();
  db.prepare(`
    INSERT INTO trading_signal_log (id, date, ticker, setup_id, direction, sl, tp, fired_at, source, matched)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'webhook', NULL)
  `).run(id, date, ticker, setupId, direction, sl ?? null, tp ?? null, now);

  const windowMs = 2 * 60 * 1000;
  const native = sessionSignalLog.find(s =>
    s.ticker === ticker &&
    s.setupId === setupId &&
    s.direction === direction &&
    s.source === 'native' &&
    Math.abs(s.firedAt - now) <= windowMs
  );

  const matched = !!native;
  db.prepare('UPDATE trading_signal_log SET matched = ? WHERE id = ?').run(matched ? 1 : 0, id);
  if (native) {
    db.prepare('UPDATE trading_signal_log SET matched = 1 WHERE id = ?').run(native.id);
  }
  return { matched, native: native || null, webhookId: id };
}

function comparisonReport(date) {
  const rows = db.prepare('SELECT * FROM trading_signal_log WHERE date = ? ORDER BY fired_at').all(date);
  const native  = rows.filter(r => r.source === 'native');
  const webhook = rows.filter(r => r.source === 'webhook');
  const matched = rows.filter(r => r.matched === 1 && r.source === 'native').length;
  return {
    date,
    nativeCount:  native.length,
    webhookCount: webhook.length,
    matchedCount: matched,
    unmatchedNative:  native.filter(r => !r.matched),
    unmatchedWebhook: webhook.filter(r => !r.matched),
    all: rows,
  };
}

function getSessionLog() { return [...sessionSignalLog]; }
function clearSessionLog() { sessionSignalLog.length = 0; }

module.exports = {
  loadSetups,
  getSetups,
  getSetup,
  getActiveSetupsArray,
  onIndicatorFire,
  receiveWebhook,
  comparisonReport,
  getSessionLog,
  clearSessionLog,
};
