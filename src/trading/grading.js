/**
 * Grading Engine
 *
 * Two output levels per the user's design:
 *
 *   1. Setup expectancy — how good is this setup on average?
 *      Drives the setup's base position size multiplier and, at the
 *      extreme, a kill switch if expectancy per dollar risked is
 *      persistently negative over enough trades.
 *
 *   2. Live per-signal quality grade (A+ / A / B / C) — for THIS
 *      specific fire, based on which additional (non-mandatory) checks
 *      are currently aligned. The engine learns from past trades which
 *      combinations of aligned checks produced the best outcomes and
 *      grades the live signal accordingly. Fed into the sizer as
 *      setupGrade so the per-trade size scales with quality.
 *
 * ─── Trade card model ────────────────────────────────────────────────
 * Every trade produces a card with two blocks of checks:
 *
 *   mandatoryChecks[]   — the setup's must-pass conditions (from the
 *                          indicator that fired). If any of these were
 *                          not satisfied the trade shouldn't have been
 *                          taken; they're for audit, not grading.
 *
 *   additionalChecks[]  — optional conditions we're testing. Their
 *                          alignment on this trade + the trade's
 *                          outcome are the raw material for learning.
 *
 * Each check is:
 *   { key: 'ema9_above_ema20', label: '9 > 20', section?: 'stack',
 *     value: '$182.4 vs $180.1', aligned: true|false }
 *
 * ─── Learning ────────────────────────────────────────────────────────
 * For a setup S, given N closed trade cards:
 *
 *   winRate     = wins / N
 *   avgWinR     = mean(R-multiple | R > 0)
 *   avgLossR    = mean(R-multiple | R < 0)  (positive number)
 *   expectancyR = winRate * avgWinR - (1 - winRate) * avgLossR
 *
 * For each additional check C on setup S:
 *
 *   split trades into (aligned) and (not aligned)
 *   deltaExpectancyR = expectancy(aligned) - expectancy(notAligned)
 *
 * Live grading combines the aligned-check contributions into a single
 * expectancy estimate for this specific fire, then buckets into a
 * letter grade.
 *
 * All configuration (which checks are mandatory vs additional, the
 * grade cutoffs, the minimum sample sizes) lives in the settings /
 * setup config so the user can adjust per the wider plan.
 */

const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// ─── Schema ──────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS trade_cards (
    id TEXT PRIMARY KEY,
    date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    setup_id TEXT NOT NULL,
    direction TEXT NOT NULL,
    account TEXT,
    position_id TEXT,
    order_id TEXT,
    entry_price REAL,
    exit_price REAL,
    shares INTEGER,
    stop_distance REAL,
    r_multiple REAL,       -- signed: -0.5 = loss of 0.5R, +2.1 = 2.1R win
    net_pnl REAL,
    exit_reason TEXT,
    fired_at INTEGER,
    closed_at INTEGER,
    context TEXT NOT NULL DEFAULT '{}',
    grade TEXT,            -- letter grade assigned at signal-fire time
    grade_details TEXT     -- JSON of the live grading decision
  );

  CREATE TABLE IF NOT EXISTS trade_card_checks (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    kind TEXT NOT NULL,             -- 'mandatory' | 'additional'
    check_key TEXT NOT NULL,
    label TEXT NOT NULL,
    section TEXT,
    value TEXT,
    aligned INTEGER,
    FOREIGN KEY (card_id) REFERENCES trade_cards(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS trade_card_checks_card_idx ON trade_card_checks(card_id);
  CREATE INDEX IF NOT EXISTS trade_card_checks_key_idx  ON trade_card_checks(check_key, aligned);
`);

// Version stamp on every stored evaluation so an edited check's history
// doesn't mix logic-versions when the grading engine reads it back.
// Existing rows default to 1, which matches the seed version_id in
// check_library so nothing gets orphaned.
try { db.exec('ALTER TABLE trade_card_checks ADD COLUMN check_version_id INTEGER NOT NULL DEFAULT 1'); } catch { /* already exists */ }

// ─── Card building ───────────────────────────────────────────────────────────

/**
 * Create a trade card at signal-fire time. Card details (technicals,
 * MAE/MFE, R-multiple) are filled later when the position closes.
 */
function createCardForSignal({
  ticker, setupId, direction, sessionId,
  entryPrice, sl, tp, firedAt,
  gate, scannerSnapshot = null,
  orderId, positionId,
  mandatoryChecks = [],
  additionalChecks = [],
  account = null,
  liveGrade = null,
}) {
  const id = uuidv4();
  const stopDistance = entryPrice && sl ? Math.abs(entryPrice - sl) : null;
  const date = new Date(firedAt || Date.now())
    .toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  const txn = db.transaction(() => {
    db.prepare(`
      INSERT INTO trade_cards
        (id, date, ticker, setup_id, direction, account, position_id, order_id,
         entry_price, shares, stop_distance, fired_at, context, grade, grade_details)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, date, ticker.toUpperCase(), setupId, direction,
      account, positionId || null, orderId || null,
      entryPrice ?? null, null, stopDistance,
      firedAt || Date.now(),
      JSON.stringify({ gate, scannerSnapshot }),
      liveGrade?.grade || null,
      liveGrade ? JSON.stringify(liveGrade) : null,
    );

    const insertCheck = db.prepare(`
      INSERT INTO trade_card_checks (id, card_id, kind, check_key, label, section, value, aligned, check_version_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of mandatoryChecks) {
      insertCheck.run(
        uuidv4(), id, 'mandatory',
        c.key, c.label, c.section || null, c.value != null ? String(c.value) : null,
        c.aligned == null ? null : (c.aligned ? 1 : 0),
        // Mandatory checks are read from the indicator's debug() output, not
        // the check_library, so they track the indicator version rather than
        // a library version. Stamp 1 for now; a future indicator-version
        // scheme can flow through here without a schema change.
        1,
      );
    }
    for (const c of additionalChecks) {
      insertCheck.run(
        uuidv4(), id, 'additional',
        c.key, c.label, c.section || null, c.value != null ? String(c.value) : null,
        c.aligned == null ? null : (c.aligned ? 1 : 0),
        c.versionId || 1,
      );
    }
  });
  txn();

  return { id, date, ticker, setupId, direction };
}

/**
 * Called when a position closes — filling in the outcome fields so the
 * card can contribute to the learning pool. `exitReason` is one of:
 * 'target' | 'stop' | 'manual' | 'timeout'.
 */
function completeCardForPosition(positionId, { exitPrice, netPnl, closedAt, exitReason = 'manual' }) {
  const card = db.prepare('SELECT * FROM trade_cards WHERE position_id = ?').get(positionId);
  if (!card) return null;

  const stopDistance = card.stop_distance;
  const dir = card.direction;
  const entry = card.entry_price;
  let rMultiple = null;
  if (Number.isFinite(entry) && Number.isFinite(stopDistance) && stopDistance > 0) {
    const priceMove = dir === 'Long' ? (exitPrice - entry) : (entry - exitPrice);
    rMultiple = priceMove / stopDistance;
  }

  db.prepare(`
    UPDATE trade_cards
       SET exit_price = ?, closed_at = ?, r_multiple = ?, net_pnl = ?, exit_reason = ?
     WHERE id = ?
  `).run(
    exitPrice ?? null,
    closedAt ?? Date.now(),
    rMultiple,
    netPnl ?? null,
    exitReason,
    card.id,
  );
  return { id: card.id, rMultiple };
}

// ─── Learning: setup expectancy ──────────────────────────────────────────────

function _getSetting(key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row || row.value === '' || row.value == null) return fallback;
  const n = parseFloat(row.value);
  return Number.isFinite(n) ? n : fallback;
}

function _getIntSetting(key, fallback) {
  const n = _getSetting(key, fallback);
  return Number.isInteger(n) ? n : Math.round(n);
}

/**
 * Setup-level stats over the pool of closed trade cards.
 * account: optional filter — 'account = ?'
 */
function setupExpectancy(setupId, { account = null, since = null } = {}) {
  const params = [setupId];
  let where = 'setup_id = ? AND r_multiple IS NOT NULL';
  if (account) { where += ' AND account = ?'; params.push(account); }
  if (since)   { where += ' AND closed_at >= ?'; params.push(since); }

  const rows = db.prepare(`SELECT r_multiple FROM trade_cards WHERE ${where}`).all(...params);
  const n = rows.length;
  if (n === 0) {
    return { setupId, account, n: 0, expectancyR: null, winRate: null, avgWinR: null, avgLossR: null, grade: 'B (bootstrapping)' };
  }

  const rs = rows.map(r => r.r_multiple);
  const wins   = rs.filter(r => r > 0);
  const losses = rs.filter(r => r < 0);
  const winRate  = wins.length / n;
  const avgWinR  = wins.length   ? wins.reduce((s, r) => s + r, 0) / wins.length : 0;
  const avgLossR = losses.length ? Math.abs(losses.reduce((s, r) => s + r, 0) / losses.length) : 0;
  const expectancyR = winRate * avgWinR - (1 - winRate) * avgLossR;

  const minTrades = _getIntSetting('grading_min_setup_trades', 20);
  const grade = _classifySetup(expectancyR, winRate, n, minTrades);

  return { setupId, account, n, winRate, avgWinR, avgLossR, expectancyR, grade };
}

function _classifySetup(expectancyR, winRate, n, minTrades) {
  if (n < minTrades) return 'B (bootstrapping)';
  if (expectancyR >= 1.5 && winRate >= 0.50) return 'A+';
  if (expectancyR >= 1.0 && winRate >= 0.40) return 'A';
  if (expectancyR >= 0.5)                    return 'B';
  return 'C';
}

/**
 * Multiplier the setup contributes to base position size.
 *
 * Design (per user's rule): default is 1.0 and stays 1.0 until we have
 * enough closed trades on this setup to trust an expectancy measurement.
 * Only once the sample size crosses `grading_min_setup_trades` do we
 * start to scale (or, at the extreme, kill).
 *
 * That means a brand-new setup runs at its full configured risk; it
 * doesn't get punished for having no history yet. Only once the data
 * says something meaningful does the multiplier move away from 1.0.
 */
function setupSizeMultiplier(setupId, opts = {}) {
  const s = setupExpectancy(setupId, opts);
  const minTrades = _getIntSetting('grading_min_setup_trades', 20);
  const killR     = _getSetting('grading_kill_expectancy_r', -0.5);
  const killMinTr = _getIntSetting('grading_kill_min_trades', 30);

  // Bootstrap guard: not enough data → neutral multiplier, no adjustment.
  if (!Number.isFinite(s.expectancyR) || s.n < minTrades) {
    return {
      multiplier: 1.0,
      reason:     `bootstrap: ${s.n}/${minTrades} closed trades — multiplier held at 1.0×`,
      stats:      s,
    };
  }

  // Kill switch: enough evidence that the setup is losing money.
  if (s.n >= killMinTr && s.expectancyR <= killR) {
    return { multiplier: 0, reason: 'kill-switch: negative expectancy over threshold', stats: s };
  }

  // Enough data — scale by the setup's letter grade.
  const table = {
    'A+': 1.20,
    'A':  1.00,
    'B':  0.75,
    'C':  0.40,
  };
  return { multiplier: table[s.grade] ?? 1.0, reason: `setup grade ${s.grade}`, stats: s };
}

// ─── Learning: per-check delta expectancy ────────────────────────────────────

/**
 * For each additional check on this setup, compute:
 *   expectancy(aligned) - expectancy(not aligned) = deltaExpectancyR
 * and how many trades each side has.
 */
function checkContributions(setupId, opts = {}) {
  const params = [setupId];
  let where = 'tc.setup_id = ? AND tc.r_multiple IS NOT NULL';
  if (opts.account) { where += ' AND tc.account = ?'; params.push(opts.account); }

  // Join against check_library on check_key so each learning row must
  // match the CURRENT version_id of its check. Rows whose check has been
  // edited since the trade closed get filtered out and the check starts
  // its expectancy pool over — same effect as resetting learning without
  // touching the historical trade cards themselves. Rows whose check is
  // no longer in the library (removed) also drop out here.
  const rows = db.prepare(`
    SELECT tc.r_multiple AS r, cc.check_key AS k, cc.label AS label, cc.aligned AS aligned
      FROM trade_cards tc
      JOIN trade_card_checks cc ON cc.card_id = tc.id AND cc.kind = 'additional'
      JOIN check_library    cl ON cl.check_key = cc.check_key
                              AND cl.version_id = cc.check_version_id
     WHERE ${where}
  `).all(...params);

  const byKey = new Map();
  for (const row of rows) {
    if (!byKey.has(row.k)) byKey.set(row.k, { label: row.label, aligned: [], notAligned: [] });
    const bucket = row.aligned === 1 ? 'aligned' : row.aligned === 0 ? 'notAligned' : null;
    if (bucket) byKey.get(row.k)[bucket].push(row.r);
  }

  const mean = arr => arr.length === 0 ? null : arr.reduce((s, r) => s + r, 0) / arr.length;
  const winRate = arr => arr.length === 0 ? null : arr.filter(r => r > 0).length / arr.length;

  const out = [];
  for (const [k, buckets] of byKey.entries()) {
    const eAligned    = mean(buckets.aligned);
    const eNotAligned = mean(buckets.notAligned);
    const delta = eAligned != null && eNotAligned != null ? eAligned - eNotAligned : null;
    out.push({
      key:            k,
      label:          buckets.label,
      nAligned:       buckets.aligned.length,
      nNotAligned:    buckets.notAligned.length,
      expectancyR_aligned:    eAligned,
      expectancyR_notAligned: eNotAligned,
      deltaExpectancyR: delta,
      winRateAligned:    winRate(buckets.aligned),
      winRateNotAligned: winRate(buckets.notAligned),
    });
  }
  return out.sort((a, b) => (b.deltaExpectancyR ?? -Infinity) - (a.deltaExpectancyR ?? -Infinity));
}

// ─── Live grading ────────────────────────────────────────────────────────────

/**
 * Grade a live signal fire from its aligned additional checks.
 *
 * Algorithm:
 *   1. Load the setup's learned check contributions (checkContributions above).
 *   2. Sum deltaExpectancyR for each currently-aligned additional check
 *      that has enough samples on both sides (default: 5 each).
 *   3. Add the setup's baseline expectancy.
 *   4. Bucket the total into A+ / A / B / C using configurable cutoffs.
 *
 * Falls back to the setup's grade when there aren't enough learned check
 * contributions yet (bootstrap phase).
 */
function gradeSignal({ setupId, additionalChecks = [], account = null }) {
  const setupStats = setupExpectancy(setupId, { account });
  const minPerSide = _getIntSetting('grading_min_check_side_trades', 5);

  const contributions = checkContributions(setupId, { account })
    .filter(c => c.nAligned >= minPerSide && c.nNotAligned >= minPerSide && c.deltaExpectancyR != null);

  const alignedKeys = new Set(additionalChecks.filter(c => c.aligned).map(c => c.key));

  const usedDeltas = contributions
    .filter(c => alignedKeys.has(c.key))
    .map(c => ({ key: c.key, label: c.label, delta: c.deltaExpectancyR }));

  const baseR   = setupStats.expectancyR ?? 0;
  const deltaR  = usedDeltas.reduce((s, x) => s + x.delta, 0);
  const totalR  = baseR + deltaR;

  const aplusR = _getSetting('grading_live_aplus_r', 1.5);
  const aR     = _getSetting('grading_live_a_r',     1.0);
  const bR     = _getSetting('grading_live_b_r',     0.5);

  const inBootstrap = usedDeltas.length === 0;
  let grade;
  if (inBootstrap) grade = setupStats.grade === 'B (bootstrapping)' ? 'B' : setupStats.grade;
  else if (totalR >= aplusR) grade = 'A+';
  else if (totalR >= aR)     grade = 'A';
  else if (totalR >= bR)     grade = 'B';
  else                        grade = 'C';

  return {
    grade,
    totalR,
    baseR,
    deltaR,
    alignedKeysCounted: usedDeltas,
    inBootstrap,
    setupStats,
  };
}

/**
 * Journal-tab summary — overall metrics + per-setup expectancy in one call.
 * Replaces the old journal/analysis.js analyzeAccount which computed the
 * same numbers from journal_trades. Now everything reads trade_cards
 * (which includes journal-imported history via the bridge).
 *
 * Filters: from, to (YYYY-MM-DD date strings on trade_cards.date), account.
 */
function accountSummary({ from = null, to = null, account = null } = {}) {
  const params = [];
  let where = 'closed_at IS NOT NULL';
  if (from)    { where += ' AND date >= ?';   params.push(from); }
  if (to)      { where += ' AND date <= ?';   params.push(to); }
  if (account) { where += ' AND account = ?'; params.push(account); }

  // ALL closed cards for P&L + drawdown; the r_multiple math below
  // just skips any card whose r_multiple is null (which happens for
  // imported journal trades missing the SL price).
  const cards = db.prepare(`
    SELECT setup_id, r_multiple, net_pnl, closed_at
      FROM trade_cards
     WHERE ${where}
     ORDER BY closed_at ASC
  `).all(...params);

  const closed = cards.length;
  // Win/loss + R math only over cards that HAVE an r_multiple; net P&L
  // is over all closed cards so a fill without SL still counts toward
  // the dollar total.
  const rCards = cards.filter(c => Number.isFinite(c.r_multiple));
  const wins   = rCards.filter(c => c.r_multiple > 0);
  const losses = rCards.filter(c => c.r_multiple < 0);
  const netPnl = cards.reduce((s, c) => s + (c.net_pnl || 0), 0);
  const winRate = rCards.length ? (wins.length / rCards.length) * 100 : 0;
  const avgWinR   = wins.length   ? wins.reduce((s, c) => s + c.r_multiple, 0) / wins.length : 0;
  const avgLossR  = losses.length ? Math.abs(losses.reduce((s, c) => s + c.r_multiple, 0) / losses.length) : 0;
  const expectancy = (winRate / 100) * avgWinR - (1 - winRate / 100) * avgLossR;
  const rVals = rCards.map(c => c.r_multiple);
  const avgR = rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;

  // Peak-to-trough drawdown on the equity curve.
  let peak = 0, cum = 0, maxDrawdown = 0;
  for (const c of cards) {
    cum += (c.net_pnl || 0);
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Per-setup breakdown — one setupExpectancy call per distinct setup_id.
  const setupIds = [...new Set(cards.map(c => c.setup_id).filter(Boolean))];
  const setupContributions = setupIds.map(setupId => {
    const stats = setupExpectancy(setupId, { account });
    const bySetup = cards.filter(c => c.setup_id === setupId);
    const sPnl = bySetup.reduce((s, c) => s + (c.net_pnl || 0), 0);
    return {
      setupId,
      trades:      bySetup.length,
      winRate:     stats.winRate != null ? stats.winRate * 100 : null,
      expectancy:  stats.expectancyR,
      netPnl:      sPnl,
      grade:       { grade: stats.grade },
    };
  }).sort((a, b) => (b.netPnl || 0) - (a.netPnl || 0));

  return {
    metrics: {
      total: closed, closed,
      wins: wins.length, losses: losses.length,
      winRate, netPnl,
      avgWinR, avgLossR,
      expectancy, avgR,
    },
    setupContributions,
    maxDrawdown,
  };
}

/**
 * Recent trade cards for the viewer — one row per card, no checks joined.
 * `limit` caps output; filters are all optional and additive.
 */
function listCards({ limit = 50, setupId = null, ticker = null, from = null, to = null, account = null } = {}) {
  const params = [];
  const wheres = [];
  if (setupId) { wheres.push('setup_id = ?'); params.push(setupId); }
  if (ticker)  { wheres.push('ticker = ?');   params.push(ticker.toUpperCase()); }
  if (from)    { wheres.push('date >= ?');    params.push(from); }
  if (to)      { wheres.push('date <= ?');    params.push(to); }
  if (account) { wheres.push('account = ?');  params.push(account); }
  const whereSql = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT id, date, ticker, setup_id, direction, account, entry_price, exit_price,
           shares, stop_distance, r_multiple, net_pnl, exit_reason,
           fired_at, closed_at, grade
      FROM trade_cards
      ${whereSql}
     ORDER BY fired_at DESC
     LIMIT ?
  `).all(...params, Math.max(1, Math.min(500, Number(limit) || 50)));
  return rows;
}

/**
 * Full trade-card detail for the viewer — the card plus every check that
 * was recorded at fire time (mandatory + default + additional).
 */
function getCard(id) {
  const card = db.prepare('SELECT * FROM trade_cards WHERE id = ?').get(id);
  if (!card) return null;
  const checks = db.prepare(`
    SELECT kind, check_key, label, section, value, aligned, check_version_id
      FROM trade_card_checks
     WHERE card_id = ?
     ORDER BY kind, section, label
  `).all(id);
  let context = {};
  let gradeDetails = null;
  try { context      = JSON.parse(card.context)       || {}; } catch { /* ignore */ }
  try { gradeDetails = JSON.parse(card.grade_details) || null; } catch { /* ignore */ }
  return {
    ...card,
    context,
    grade_details: gradeDetails,
    checks: {
      mandatory:  checks.filter(c => c.kind === 'mandatory'),
      additional: checks.filter(c => c.kind === 'additional'),
    },
  };
}

module.exports = {
  createCardForSignal,
  completeCardForPosition,
  setupExpectancy,
  setupSizeMultiplier,
  checkContributions,
  gradeSignal,
  accountSummary,
  listCards,
  getCard,
};
