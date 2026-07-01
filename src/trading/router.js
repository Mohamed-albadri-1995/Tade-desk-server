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
const checks  = require('./checks');
const { toETDate } = require('../utils/time');

const SCANNER_URL = process.env.SCANNER_URL || 'http://127.0.0.1:3000';

/**
 * Fresh-fetch the scanner-side r0 row for a ticker so the trade card
 * captures "the exact data at the exact time" (per the design brief),
 * not just what the 30-second gate poll happened to have cached.
 *
 * Returns a plain snapshot object (subset of r0 flattened) or null on
 * any failure — callers fall back to the gate's cached context.
 */
async function fetchScannerSnapshot(ticker) {
  try {
    const res = await fetch(`${SCANNER_URL}/api/registry?tickers=${encodeURIComponent(ticker)}`);
    if (!res.ok) return null;
    const body = await res.json();
    const row  = (body?.rows || []).find(r => String(r.ticker).toUpperCase() === ticker.toUpperCase());
    if (!row) return null;
    const ctx = row.context || {};
    return {
      // Scanner classification & scoring at the moment of fire
      regime:        ctx.regime        ?? null,
      regimeLabel:   ctx.regimeLabel   ?? null,
      longTerm:      ctx.longTerm      ?? null,
      midTerm:       ctx.midTerm       ?? null,
      shortTerm:     ctx.shortTerm     ?? null,
      secBias:       ctx.secBias       ?? null,
      secScore:      ctx.secScore      ?? null,
      secHot:        ctx.secHot        ?? null,
      broadResolved: ctx.broadResolved ?? null,
      themes:        ctx.themes        ?? null,
      sector:        row.stock?.sector   ?? null,
      industry:      row.stock?.industry ?? null,
      _score:        row._score           ?? null,
      confidence:    row._scoreDetails?.confidence ?? null,
      screenerKeys:  row.screenerKeys   ?? null,
      inShortlist:   row.inShortlist    ?? null,
      // Metadata so the card knows when the snapshot was taken
      capturedAt:    Date.now(),
      lastUpdatedAt: row.lastUpdated ?? null,
    };
  } catch { return null; }
}

/**
 * Look up the engine object for a setupId. barPoller has the same
 * lookup — duplicate it lightly rather than reaching into internals.
 */
function _getIndicatorEngine(setupId) {
  const row = db.prepare('SELECT indicator FROM trading_setups WHERE id = ?').get(setupId);
  const key = row?.indicator || null;
  if (!key) return null;
  try { return require('./indicators/' + key); } catch { return null; }
}

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
async function processSignal(signal, currentBid = null, currentAsk = null) {
  const { signalId, ticker, setupId, setupName, direction, entryType, sl, tp, firedAt, gate, entry: signalEntry } = signal;

  // Which "account" to tag this card with, so the grading engine can
  // learn per account (e.g. Alpaca Paper vs Alpaca Live separately).
  // The convention: use the default broker's name. Users who want
  // per-account learning simply flip which profile is the default.
  if (!signal.account) {
    try {
      const defaultBroker = brokers.list().find(b => b.isDefault) || brokers.getActive()[0];
      if (defaultBroker) signal.account = defaultBroker.name;
    } catch { /* no brokers table yet — leave null */ }
  }

  // Fresh-fetch the scanner snapshot so the card records EXACTLY what
  // the scanner knew at the moment of fire. Non-blocking: on failure
  // we fall back to the gate cache (which is up to 30 s old).
  const scannerSnapshot = await fetchScannerSnapshot(ticker)
    || (gate?.context ? {
        regime: gate.context.regime, regimeLabel: gate.context.regimeLabel,
        longTerm: gate.context.longTerm, midTerm: gate.context.midTerm, shortTerm: gate.context.shortTerm,
        secBias: gate.context.secBias, secScore: gate.context.secScore, secHot: gate.context.secHot,
        broadResolved: gate.context.broadResolved, themes: gate.context.themes,
        _score: gate.score, screenerKeys: null, sector: null, industry: null,
        capturedAt: Date.now(), fallbackSource: 'gate-cache',
      } : null);

  // Evaluate the three flavours of checks:
  //   • MANDATORY   ← indicator's debug() at this bar (always aligned on a fire)
  //   • DEFAULT     ← every enabled library entry, category='default'
  //   • ADDITIONAL  ← library entries assigned to this setup
  let mandatoryChecks = signal.mandatoryChecks || [];
  let defaultChecks    = [];
  let additionalChecks = signal.additionalChecks || [];
  try {
    const collected = checks.collectChecksForFire({
      indicatorEngine: _getIndicatorEngine(setupId),
      bars:            signal.bars || [],
      pmHigh:          signal.pmHigh ?? null,
      setupId,
      indicatorExtras: signal.indicators || signal.barData || {},
      scannerContext:  scannerSnapshot || {},
      historySeries:   signal.history  || {},
      engineCtx:       { rvol: signal.rvol ?? null },
    });
    mandatoryChecks  = collected.mandatoryChecks.length  ? collected.mandatoryChecks  : mandatoryChecks;
    defaultChecks    = collected.defaultChecks;
    additionalChecks = collected.additionalChecks.length ? collected.additionalChecks : additionalChecks;
  } catch (err) {
    console.warn('[Router] Check evaluation failed:', err.message);
  }

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

  // Grading engine — combine defaults + additionals for learning; both
  // categories reflect conditions we're tracking and want to learn from.
  // The mandatory list is stored on the card but doesn't feed the grader
  // (mandatory checks are always aligned on a fire — by definition).
  const gradingChecks = [...defaultChecks, ...additionalChecks];
  let liveGrade = null;
  try {
    liveGrade = grading.gradeSignal({
      setupId,
      additionalChecks: gradingChecks,
      account: signal.account || null,
    });
  } catch (err) {
    liveGrade = { grade: 'B (bootstrapping)', totalR: 0, baseR: 0, deltaR: 0, alignedKeysCounted: [], inBootstrap: true };
  }
  const signalGrade = liveGrade.grade === 'B (bootstrapping)' ? null : liveGrade.grade;

  // Sizing — if we still have no entry price, use the indicator's entry as
  // a last resort so the calc runs. If even that isn't set, refuse to size.
  let sizing = null;
  let sizingError = null;
  const sizingEntry = entryPrice ?? signalEntry ?? null;
  if (!sizingEntry) {
    sizingError = 'No entry price available (no bid/ask, no signal entry)';
  } else {
    try {
      // Setup-level expectancy multiplier (default 1.0; only moves once
      // we have enough closed trades — see grading.setupSizeMultiplier).
      let setupMult = 1.0;
      try {
        const sm = grading.setupSizeMultiplier(setupId, { account: signal.account || null });
        setupMult = sm.multiplier;
      } catch { /* keep 1.0 */ }

      sizing = sizer.calculate({
        entryPrice:      sizingEntry,
        sl,
        gateMultiplier:  gate?.multiplier ?? 1.0,
        score:           gate?.score ?? null,
        signalGrade,        // this fire's rating (was setupGrade)
        setupMultiplier: setupMult,  // the setup's overall track record
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

    // Trade card — created at fire time. Card carries three flavours of
    // checks (mandatory + default + additional) plus the scanner
    // snapshot from the moment of fire so post-hoc analysis has the
    // exact classification that was in play.
    try {
      grading.createCardForSignal({
        ticker, setupId, direction,
        sessionId: signal.sessionId,
        entryPrice: entryPrice ?? signalEntry ?? null,
        sl, tp,
        firedAt: now,
        gate,
        scannerSnapshot,
        orderId, positionId,
        mandatoryChecks,
        additionalChecks: [...defaultChecks, ...additionalChecks],
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
    checks: {
      mandatory:  mandatoryChecks,
      default:    defaultChecks,
      additional: additionalChecks,
    },
    scannerSnapshot,
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
