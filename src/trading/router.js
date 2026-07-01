/**
 * Router (was "Center — Execution & Risk Gate")
 *
 * Receives a gated signal from the Setup Engine, runs pre-trade risk
 * checks, sizes it with the Sizer, applies the grading multiplier, and
 * either notifies (paper/off mode) or forwards to a configured broker
 * (live mode). Broadcasts every step over SSE for the UI.
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sizer = require('./sizer');
const brokers = require('./brokers');
const grading = require('./grading');
const { toETDate } = require('../utils/time');

function getExecutionMode() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'trading_execution_mode'").get();
  const v = (row?.value || 'paper').toLowerCase();
  return ['off', 'paper', 'live'].includes(v) ? v : 'paper';
}

// Active signal listeners (SSE clients)
const listeners = new Set();

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? parseFloat(row.value) : fallback;
}

// ─── Risk checks ──────────────────────────────────────────────────────────────

function checkRisk(ticker, direction, dollarRisk) {
  const maxPositions = getSetting('trading_max_open_positions', 3);
  const dailyLossLimit = getSetting('trading_daily_loss_limit', 1000);

  // Open position count
  const openCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM trading_positions WHERE status = 'open'"
  ).get().cnt;
  if (openCount >= maxPositions) {
    return { ok: false, reason: `Max open positions reached (${maxPositions})` };
  }

  // Duplicate ticker check
  const dup = db.prepare(
    "SELECT id FROM trading_positions WHERE ticker = ? AND status = 'open'"
  ).get(ticker);
  if (dup) {
    return { ok: false, reason: `Already have an open position in ${ticker}` };
  }

  // Daily loss limit — realized P&L from positions closed today (ET).
  // Using closed_at rather than opened_at so a bad trade closed today
  // counts against today's limit even if it was opened earlier.
  const today = toETDate(Date.now());
  const pnlRow = db.prepare(
    "SELECT COALESCE(SUM(pnl), 0) AS total FROM trading_positions WHERE status = 'closed' AND DATE(closed_at/1000,'unixepoch') = ?"
  ).get(today);
  const dailyPnl = pnlRow?.total || 0;
  if (dailyPnl <= -dailyLossLimit) {
    return { ok: false, reason: `Daily loss limit reached ($${dailyLossLimit})` };
  }

  return { ok: true };
}

// ─── Humanized message ────────────────────────────────────────────────────────

function humanize({ ticker, direction, shares, entryPrice, sl, tp, dollarRisk, entryType }) {
  const side = direction === 'Long' ? 'Buy' : 'Sell short';
  const priceStr = entryType === 'market' ? 'at market' : `limit $${entryPrice?.toFixed(2)}`;
  return `${side} ${shares} shares of ${ticker} ${priceStr}. Stop at $${sl.toFixed(2)}, target $${tp.toFixed(2)}. Risk: $${dollarRisk.toFixed(0)}.`;
}

// ─── Alpaca payload ───────────────────────────────────────────────────────────

function buildAlpacaPayload({ ticker, direction, shares, entryType, entryPrice, sl, tp }) {
  const payload = {
    symbol: ticker,
    qty: shares,
    side: direction === 'Long' ? 'buy' : 'sell',
    type: entryType === 'market' ? 'market' : 'limit',
    time_in_force: 'day',
    order_class: 'bracket',
    stop_loss: { stop_price: sl },
    take_profit: { limit_price: tp },
  };
  if (entryType !== 'market' && entryPrice) {
    payload.limit_price = entryPrice;
  }
  return payload;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Process a gated signal from the Setup Engine.
 * @param {object} signal - from setupEngine.onIndicatorFire callback
 * @param {number|null} currentBid - live bid from Alpaca stream (or null)
 * @param {number|null} currentAsk - live ask from Alpaca stream (or null)
 */
function processSignal(signal, currentBid = null, currentAsk = null) {
  const { signalId, ticker, setupId, setupName, direction, entryType, sl, tp, firedAt, gate, entry: signalEntry } = signal;

  // Entry price preference for market orders (in order):
  //   1. Real live quote from Alpaca WS (currentAsk for long, currentBid for short)
  //   2. Bid/ask midpoint if only one side is known
  //   3. The indicator's own signal.entry (close of the signal bar)
  //   4. null → let sizing use the indicator entry too
  // This replaces the previous `sl × 1.01` fake fallback which produced
  // absurd sizing when Alpaca quotes weren't available.
  let entryPrice = null;
  let entrySource = 'none';
  if (entryType === 'market') {
    if (direction === 'Long' && currentAsk) { entryPrice = currentAsk; entrySource = 'ask'; }
    else if (direction === 'Short' && currentBid) { entryPrice = currentBid; entrySource = 'bid'; }
    else if (currentBid && currentAsk) { entryPrice = (currentBid + currentAsk) / 2; entrySource = 'mid'; }
    else if (signalEntry) { entryPrice = signalEntry; entrySource = 'signal_bar_close'; }
  } else if (signalEntry) {
    entryPrice = signalEntry;
    entrySource = 'signal_bar_close';
  }

  // Grading engine — grade this specific fire based on the setup's learned
  // history and the additional checks currently aligned on this bar. The
  // resulting letter grade feeds the Sizer's per-trade multiplier.
  const additionalChecks = signal.additionalChecks || [];
  const mandatoryChecks  = signal.mandatoryChecks  || [];
  let liveGrade = null;
  try {
    liveGrade = grading.gradeSignal({
      setupId,
      additionalChecks,
      account: signal.account || null,
    });
  } catch (err) {
    // Learning table might not have any rows yet — grade defaults to bootstrap.
    liveGrade = { grade: 'B (bootstrapping)', totalR: 0, baseR: 0, deltaR: 0, alignedKeysCounted: [], inBootstrap: true };
  }
  const setupGrade = liveGrade.grade === 'B (bootstrapping)' ? null : liveGrade.grade;

  // Sizing — if we still have no entry price, use the indicator's entry as
  // a last resort so the calc runs. If even that isn't set, refuse to size.
  let sizing = null;
  let sizingError = null;
  const sizingEntry = entryPrice ?? signalEntry ?? null;
  if (!sizingEntry) {
    sizingError = 'No entry price available (no bid/ask, no signal entry)';
  } else {
    try {
      sizing = sizer.calculate({
        entryPrice: sizingEntry,
        sl,
        gateMultiplier: gate?.multiplier ?? 1.0,
        score: gate?.score ?? null,
        setupGrade,
      });
    } catch (e) {
      sizingError = e.message;
    }
  }

  // Risk gate
  const riskCheck = sizing
    ? checkRisk(ticker, direction, sizing.dollarRisk)
    : { ok: false, reason: sizingError || 'Sizing failed' };

  const now = Date.now();
  const today = toETDate(now); // was UTC — use ET so log date matches session date

  // Build order record even if risk check fails (for audit)
  const shares = sizing?.shares ?? 0;
  const dollarRisk = sizing?.dollarRisk ?? 0;
  const positionValue = sizing?.positionValue ?? 0;

  const alpacaPayload = buildAlpacaPayload({ ticker, direction, shares, entryType, entryPrice, sl, tp });
  const humanizedMsg = humanize({ ticker, direction, shares, entryPrice, sl, tp, dollarRisk, entryType });

  const orderId = uuidv4();

  // Execution mode — if 'off', drop everything (still logged via the
  // notification below so the user sees it happened). 'paper' persists
  // an order + opens a paper position. 'live' will fan out to enabled
  // broker profiles (live submission still stubbed in brokers.send()).
  const mode = getExecutionMode();

  let positionId = null;
  const brokerResults = [];
  if (mode !== 'off' && riskCheck.ok && shares > 0) {
    positionId = uuidv4();
    const orderStatus = mode === 'live' ? 'submitted' : 'notified';
    const writeAll = db.transaction(() => {
      db.prepare(`
        INSERT INTO trading_orders
          (id, signal_id, session_id, date, ticker, direction, shares, entry_price, sl, tp,
           dollar_risk, position_value, alpaca_payload, humanized_msg, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        orderId, signalId, signal.sessionId || '', today, ticker, direction,
        shares, entryPrice ?? null, sl, tp,
        dollarRisk, positionValue,
        JSON.stringify(alpacaPayload), humanizedMsg, orderStatus, now
      );
      db.prepare(`
        INSERT INTO trading_positions
          (id, order_id, ticker, direction, shares, entry_price, entry_time,
           sl, tp, status, opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
      `).run(
        positionId, orderId, ticker, direction,
        shares, entryPrice ?? 0,
        new Date(now).toISOString(),
        sl, tp,
        now
      );
    });
    writeAll();

    // Trade card — created at fire time; the outcome fields (exit,
    // R-multiple, net P&L) get filled in when the position closes so
    // the grading engine can learn from it.
    try {
      grading.createCardForSignal({
        ticker, setupId, direction,
        sessionId: signal.sessionId,
        entryPrice: entryPrice ?? signalEntry ?? null,
        sl, tp,
        firedAt: now,
        gate,
        orderId, positionId,
        mandatoryChecks,
        additionalChecks,
        account: signal.account || null,
        liveGrade,
      });
    } catch (err) {
      console.warn('[Router] Trade card creation failed:', err.message);
    }

    if (mode === 'live') {
      // Fan out to every enabled broker profile.
      for (const b of brokers.getActive()) {
        try {
          const r = require('./brokers').send;  // via require to keep it hot-swappable
          const result = r(b, { ticker, direction, shares, entryType, entryPrice, sl, tp, orderId });
          // send() is async; keep a Promise handle but don't block the SSE broadcast.
          brokerResults.push({ brokerId: b.id, brokerName: b.name, brokerType: b.type, pending: true });
          Promise.resolve(result).catch(() => { /* logged in broker */ });
        } catch (err) {
          brokerResults.push({ brokerId: b.id, brokerName: b.name, brokerType: b.type, ok: false, error: err.message });
        }
      }
    }
  }

  const notification = {
    type: 'signal',
    orderId: riskCheck.ok ? orderId : null,
    positionId: riskCheck.ok ? positionId : null,
    signalId,
    ticker,
    setupId,
    setupName,
    direction,
    entryType,
    entryPrice: sizingEntry,
    entrySource,
    sl,
    tp,
    firedAt,
    sizing,
    sizingError: sizingError || null,
    gate,
    bid: currentBid,
    ask: currentAsk,
    riskCheck,
    humanizedMsg,
    alpacaPayload: riskCheck.ok ? alpacaPayload : null,
    executionMode: mode,
    brokerResults,
    liveGrade,
    ts: now,
  };

  // Broadcast to all SSE listeners
  broadcast(notification);

  return notification;
}

// ─── SSE broadcast ────────────────────────────────────────────────────────────

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try { res.write(msg); } catch { listeners.delete(res); }
  }
}

function addListener(res) {
  listeners.add(res);
  res.on('close', () => listeners.delete(res));
}

/**
 * Close an open position and compute realized P&L. Used by the manual
 * close button in the UI; will also be used by future Alpaca order-fill
 * event handling.
 */
function closePosition(positionId, exitPrice, reason = 'manual') {
  const pos = db.prepare("SELECT * FROM trading_positions WHERE id = ? AND status = 'open'").get(positionId);
  if (!pos) return { ok: false, error: 'Position not found or already closed' };

  const px = Number(exitPrice);
  if (!Number.isFinite(px) || px <= 0) return { ok: false, error: 'Invalid exit price' };

  // P&L: (exit - entry) × shares for long, (entry - exit) × shares for short
  const pnl = pos.direction === 'Long'
    ? (px - pos.entry_price) * pos.shares
    : (pos.entry_price - px) * pos.shares;

  const now = Date.now();
  const roundedPnl = Math.round(pnl * 100) / 100;
  db.prepare(`
    UPDATE trading_positions
       SET exit_price = ?, exit_time = ?, pnl = ?, status = 'closed', closed_at = ?
     WHERE id = ?
  `).run(px, new Date(now).toISOString(), roundedPnl, now, positionId);

  // Complete the trade card so the grading engine can learn from this trade.
  try {
    grading.completeCardForPosition(positionId, {
      exitPrice: px,
      netPnl:    roundedPnl,
      closedAt:  now,
      exitReason: reason,
    });
  } catch (err) {
    console.warn('[Router] Trade card completion failed:', err.message);
  }

  const closed = db.prepare('SELECT * FROM trading_positions WHERE id = ?').get(positionId);
  broadcast({ type: 'position_closed', position: closed, reason, ts: now });
  return { ok: true, position: closed };
}

/**
 * Read open positions (used by the UI to render the position list).
 */
function listOpenPositions() {
  return db.prepare("SELECT * FROM trading_positions WHERE status = 'open' ORDER BY opened_at DESC").all();
}

/**
 * Read today's closed positions with P&L (used by the daily loss check
 * and by the UI to show session results).
 */
function listClosedPositionsToday() {
  const today = toETDate(Date.now());
  return db
    .prepare("SELECT * FROM trading_positions WHERE status = 'closed' AND DATE(closed_at/1000,'unixepoch') = ? ORDER BY closed_at DESC")
    .all(today);
}

module.exports = {
  processSignal,
  addListener,
  broadcast,
  checkRisk,
  closePosition,
  listOpenPositions,
  listClosedPositionsToday,
};
