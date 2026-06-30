/**
 * Center — Execution & Risk Gate
 *
 * Receives a signal from Side B (already direction-gated).
 * Runs pre-trade risk checks, computes sizing via Side C,
 * builds the Alpaca-ready payload and humanized message,
 * and notifies without submitting to Alpaca (deferred).
 */

const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const sideC = require('./sideC');

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

  // Daily loss limit
  const today = new Date().toISOString().slice(0, 10);
  const pnlRow = db.prepare(
    "SELECT SUM(pnl) as total FROM trading_positions WHERE DATE(opened_at/1000,'unixepoch') = ? AND status = 'closed'"
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
 * Process a signal from Side B.
 * @param {object} signal - from sideB.onIndicatorFire callback
 * @param {number|null} currentBid - current bid price from Alpaca stream (or null)
 * @param {number|null} currentAsk - current ask price from Alpaca stream (or null)
 */
function processSignal(signal, currentBid = null, currentAsk = null) {
  const { signalId, ticker, setupId, setupName, direction, entryType, sl, tp, firedAt, sideA } = signal;

  // Estimate entry price from bid/ask; fall back to midpoint or null
  const entryPrice = entryType === 'market'
    ? (direction === 'Long' ? currentAsk : currentBid) || ((currentBid + currentAsk) / 2) || null
    : null;

  // Grading is being rebuilt — keep the grade multiplier neutral (1.0) for now
  const setupGrade = null;

  // Sizing
  let sizing = null;
  let sizingError = null;
  try {
    sizing = sideC.calculate({
      entryPrice: entryPrice || sl * 1.01, // rough fallback so sizing doesn't crash
      sl,
      sideAMultiplier: sideA?.multiplier ?? 1.0,
      score: sideA?.score ?? null,
      setupGrade,
    });
  } catch (e) {
    sizingError = e.message;
  }

  // Risk gate
  const riskCheck = sizing
    ? checkRisk(ticker, direction, sizing.dollarRisk)
    : { ok: false, reason: sizingError || 'Sizing failed' };

  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);

  // Build order record even if risk check fails (for audit)
  const shares = sizing?.shares ?? 0;
  const dollarRisk = sizing?.dollarRisk ?? 0;
  const positionValue = sizing?.positionValue ?? 0;

  const alpacaPayload = buildAlpacaPayload({ ticker, direction, shares, entryType, entryPrice, sl, tp });
  const humanizedMsg = humanize({ ticker, direction, shares, entryPrice, sl, tp, dollarRisk, entryType });

  const orderId = uuidv4();

  if (riskCheck.ok && shares > 0) {
    db.prepare(`
      INSERT INTO trading_orders
        (id, signal_id, session_id, date, ticker, direction, shares, entry_price, sl, tp,
         dollar_risk, position_value, alpaca_payload, humanized_msg, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'notified', ?)
    `).run(
      orderId, signalId, signal.sessionId || '', today, ticker, direction,
      shares, entryPrice ?? null, sl, tp,
      dollarRisk, positionValue,
      JSON.stringify(alpacaPayload), humanizedMsg, now
    );
  }

  const notification = {
    type: 'signal',
    orderId: riskCheck.ok ? orderId : null,
    signalId,
    ticker,
    setupId,
    setupName,
    direction,
    entryType,
    entryPrice,
    sl,
    tp,
    firedAt,
    sizing,
    sideA,
    bid: currentBid,
    ask: currentAsk,
    riskCheck,
    humanizedMsg,
    alpacaPayload: riskCheck.ok ? alpacaPayload : null,
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

module.exports = { processSignal, addListener, broadcast, checkRisk };
