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

    // Broker fanout — a profile's `env` decides which execution mode it
    // participates in, not the type alone. That way one alpaca account
    // can be a paper-only sandbox and another can be live, and both are
    // gated by the master mode independently.
    if (mode !== 'off') {
      for (const b of brokers.getActive()) {
        // 'paper' type is offline-only; skip in paper mode too, it's a no-op record.
        if (b.type === 'paper') continue;
        // Match brokers.js derivation: URL wins over an explicit env field.
        const cfg = b.config || {};
        const env = cfg.env
          ? String(cfg.env).toLowerCase()
          : (String(cfg.url || '').toLowerCase().includes('paper-api') ? 'paper' : 'live');
        if (mode === 'paper' && env !== 'paper') continue;
        if (mode === 'live'  && env !== 'live')  continue;
        try {
          const sendFn = require('./brokers').send;  // via require to keep it hot-swappable
          const result = sendFn(b, { ticker, direction, shares, entryType, entryPrice, sl, tp, orderId });
          brokerResults.push({ brokerId: b.id, brokerName: b.name, brokerType: b.type, env, pending: true });
          Promise.resolve(result)
            .then(r => {
              if (r?.alpacaOrderId) {
                // Stamp the position + order so the fill-tracking loop can
                // match Alpaca's status updates back to our records and let
                // the grading engine learn from the REAL fill price.
                try {
                  db.prepare('UPDATE trading_positions SET alpaca_order_id = ? WHERE id = ?')
                    .run(r.alpacaOrderId, positionId);
                  db.prepare('UPDATE trading_orders SET alpaca_order_id = ?, status = ? WHERE id = ?')
                    .run(r.alpacaOrderId, r.alpacaStatus || 'submitted', orderId);
                } catch { /* schema migration may not have run yet */ }
              }
              if (!r?.ok) console.warn(`[Router] broker ${b.name} submit failed:`, r?.error);
            })
            .catch(err => console.warn(`[Router] broker ${b.name} threw:`, err.message));
        } catch (err) {
          brokerResults.push({ brokerId: b.id, brokerName: b.name, brokerType: b.type, env, ok: false, error: err.message });
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

  // Journal write — mirror this trade into the journal so the trade log
  // stays complete across live signals, paper broker fills, and manual
  // closes. Idempotent by design: journal_trades has PK on id, and we
  // seed with the position id so a re-close (shouldn't happen but safe)
  // becomes a no-op INSERT OR REPLACE. Silent best-effort — the position
  // + card writes above are the authoritative record.
  try {
    _writeJournalFromPosition(pos, px, reason, now, roundedPnl);
  } catch (err) {
    console.warn('[Router] Journal write failed:', err.message);
  }

  const closed = db.prepare('SELECT * FROM trading_positions WHERE id = ?').get(positionId);
  broadcast({ type: 'position_closed', position: closed, reason, ts: now });
  return { ok: true, position: closed };
}

function _writeJournalFromPosition(pos, exitPrice, reason, closedAt, netPnl) {
  const openIso  = new Date(pos.opened_at).toISOString();
  const closeIso = new Date(closedAt).toISOString();
  const entryTime = openIso.slice(11, 19);
  const exitTime  = closeIso.slice(11, 19);
  const date      = toETDate(pos.opened_at);
  const pctMove = pos.entry_price
    ? (exitPrice - pos.entry_price) / pos.entry_price * 100 * (pos.direction === 'Long' ? 1 : -1)
    : null;
  const durationMs = closedAt - pos.opened_at;
  const card = db.prepare('SELECT setup_id, account FROM trade_cards WHERE position_id = ?').get(pos.id);
  db.prepare(`
    INSERT OR REPLACE INTO journal_trades
      (id, date, ticker, direction, setup_id, shares, entry_price, entry_time,
       exit_price, exit_time, sl, tp, gross_pnl, commission, net_pnl,
       pct_move, duration_ms, source, account, status, technical_computed,
       created_at, exit_verdict)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    pos.id, date, pos.ticker, pos.direction, card?.setup_id || null,
    pos.shares, pos.entry_price, entryTime,
    exitPrice, exitTime, pos.sl, pos.tp,
    netPnl, 0, netPnl,
    pctMove != null ? parseFloat(pctMove.toFixed(3)) : null,
    durationMs,
    'trading', card?.account || null, 'closed', 0,
    closedAt, reason,
  );
}

/**
 * Read open positions (used by the UI to render the position list).
 * Enriched with:
 *   - setup name and account from the trade card
 *   - live unrealized P&L computed against the latest buffered bar
 *   - card id so the UI can jump straight to the card viewer
 */
function listOpenPositions() {
  const positions = db.prepare(`
    SELECT p.*, c.id AS card_id, c.setup_id, c.account, s.name AS setup_name
      FROM trading_positions p
      LEFT JOIN trade_cards c    ON c.position_id = p.id
      LEFT JOIN trading_setups s ON s.id = c.setup_id
     WHERE p.status = 'open'
     ORDER BY p.opened_at DESC
  `).all();
  // barPoller lives in the same process — requiring it lazily keeps a
  // clean import cycle for tests that spin up router.js without a session.
  let barPoller;
  try { barPoller = require('./barPoller'); } catch { /* not started */ }
  return positions.map(p => {
    const latest = barPoller?.getLatestBar ? barPoller.getLatestBar(p.ticker) : null;
    const currentPrice = latest && Number.isFinite(latest.c) ? latest.c : null;
    let unrealizedPnl = null;
    let unrealizedR   = null;
    if (currentPrice != null && Number.isFinite(p.entry_price) && p.shares > 0) {
      const move = p.direction === 'Long' ? (currentPrice - p.entry_price) : (p.entry_price - currentPrice);
      unrealizedPnl = Math.round(move * p.shares * 100) / 100;
      const stopDist = Number.isFinite(p.sl) ? Math.abs(p.entry_price - p.sl) : null;
      if (stopDist && stopDist > 0) unrealizedR = Math.round((move / stopDist) * 100) / 100;
    }
    return {
      ...p,
      setup_name:      p.setup_name || null,
      current_price:   currentPrice,
      unrealized_pnl:  unrealizedPnl,
      unrealized_r:    unrealizedR,
      bar_at:          latest?.t || null,
    };
  });
}

/**
 * Read today's closed positions with P&L (used by the daily loss check
 * and by the UI to show session results).
 */
function listClosedPositionsToday() {
  const today = toETDate(Date.now());
  return db.prepare(`
    SELECT p.*, c.id AS card_id, c.setup_id, c.account, s.name AS setup_name
      FROM trading_positions p
      LEFT JOIN trade_cards c    ON c.position_id = p.id
      LEFT JOIN trading_setups s ON s.id = c.setup_id
     WHERE p.status = 'closed'
       AND DATE(p.closed_at/1000,'unixepoch') = ?
     ORDER BY p.closed_at DESC
  `).all(today);
}

/**
 * Market-close a position via Alpaca. If the position has an
 * alpaca_order_id and a matching Alpaca broker profile exists, submit
 * a DELETE /v2/positions/{ticker} which liquidates the position at
 * market. The bracket legs get canceled automatically. brokerSync's
 * fill poller will then rewrite our local record with the real exit
 * price. If no Alpaca broker exists, fall back to closing at the
 * latest bar close so paper-only sessions still work.
 */
async function marketClosePosition(positionId) {
  const pos = db.prepare("SELECT * FROM trading_positions WHERE id = ? AND status = 'open'").get(positionId);
  if (!pos) return { ok: false, error: 'Position not found or already closed' };

  const brokers = require('./brokers');
  const alpacaProfile = brokers.getActive().find(b => b.type === 'alpaca');
  if (alpacaProfile) {
    const cfg = alpacaProfile.config || {};
    const raw = cfg.url && /alpaca\.markets/i.test(cfg.url) ? cfg.url : 'https://paper-api.alpaca.markets';
    const base = brokers.normalizeAlpacaBase(raw);
    try {
      const resp = await fetch(`${base}/v2/positions/${encodeURIComponent(pos.ticker)}`, {
        method: 'DELETE',
        headers: {
          'APCA-API-KEY-ID':     cfg.key,
          'APCA-API-SECRET-KEY': cfg.secret,
        },
      });
      if (resp.ok || resp.status === 207) {
        // brokerSync will close our local record when the fill lands.
        return { ok: true, submittedTo: 'alpaca', pending: true };
      }
      const body = await resp.text().catch(() => '');
      // 404 = Alpaca has no position for this ticker. Two ways that
      // happens: the bracket already fired (SL/TP hit and we missed the
      // update), or the session ended and Alpaca liquidated at EOD. In
      // both cases the local record is out of sync — close it here at
      // the latest bar close instead of leaving it stuck open.
      if (resp.status === 404) {
        return _localFallbackClose(pos.id, pos.ticker, 'reconcile: Alpaca has no matching position');
      }
      return { ok: false, error: `Alpaca ${resp.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { ok: false, error: `Alpaca network error: ${err.message}` };
    }
  }

  return _localFallbackClose(pos.id, pos.ticker, 'no Alpaca profile');
}

/**
 * Close a stuck local position at the latest bar close. Used when the
 * primary broker path can't act (no profile, or Alpaca doesn't have
 * the position anymore). Returns the same shape as marketClose.
 */
function _localFallbackClose(positionId, ticker, reason) {
  let latestClose = null;
  try {
    const barPoller = require('./barPoller');
    const bar = barPoller.getLatestBar?.(ticker);
    if (bar && Number.isFinite(bar.c)) latestClose = bar.c;
  } catch { /* no session running */ }
  if (!Number.isFinite(latestClose)) {
    // Fall further back — use the position's own entry price. Worse
    // than a live bar but better than leaving the row stuck open.
    const pos = db.prepare('SELECT entry_price FROM trading_positions WHERE id = ?').get(positionId);
    if (pos && Number.isFinite(pos.entry_price)) latestClose = pos.entry_price;
  }
  if (!Number.isFinite(latestClose)) {
    return { ok: false, error: 'No price available to close at — supply a limit price manually' };
  }
  const result = closePosition(positionId, latestClose, 'reconcile');
  if (!result.ok) return result;
  return { ...result, reconciled: true, reason };
}

module.exports = {
  processSignal,
  addListener,
  broadcast,
  checkRisk,
  closePosition,
  marketClosePosition,
  listOpenPositions,
  listClosedPositionsToday,
};
