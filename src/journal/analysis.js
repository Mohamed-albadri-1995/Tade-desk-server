/**
 * Journal Analysis & Grading Engine
 *
 * Per-setup expectancy, risk-weighted contribution, condition grading.
 */

const db = require('../db');

function getSetting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? parseFloat(row.value) : fallback;
}

// ─── Core metrics ─────────────────────────────────────────────────────────────

function computeMetrics(trades) {
  const closed = trades.filter(t => t.status === 'closed' && t.net_pnl != null);
  if (!closed.length) return emptyMetrics(trades.length);

  const wins   = closed.filter(t => t.net_pnl > 0);
  const losses = closed.filter(t => t.net_pnl < 0);

  const grossWin  = wins.reduce((s, t) => s + t.net_pnl, 0);
  const grossLoss = losses.reduce((s, t) => s + t.net_pnl, 0);
  const netPnl    = grossWin + grossLoss;
  const winRate   = wins.length / closed.length * 100;
  const avgWin    = wins.length ? grossWin / wins.length : 0;
  const avgLoss   = losses.length ? grossLoss / losses.length : 0;
  const expectancy = winRate / 100 * avgWin - (1 - winRate / 100) * Math.abs(avgLoss);
  const profitFactor = Math.abs(grossLoss) > 0 ? grossWin / Math.abs(grossLoss) : null;

  // R-based metrics
  const rVals = closed.filter(t => t.r_multiple != null).map(t => t.r_multiple);
  const avgR  = rVals.length ? rVals.reduce((a, b) => a + b, 0) / rVals.length : null;

  // Capture %
  const capVals = closed.filter(t => t.capture_pct != null).map(t => t.capture_pct);
  const avgCapture = capVals.length ? capVals.reduce((a, b) => a + b, 0) / capVals.length : null;

  // Duration
  const durVals = closed.filter(t => t.duration_ms != null).map(t => t.duration_ms);
  const avgDurationMs = durVals.length ? durVals.reduce((a, b) => a + b, 0) / durVals.length : null;

  // Dollar risk (shares × |entry - SL|)
  const totalDollarRisk = closed
    .filter(t => t.sl != null && t.entry_price != null && t.shares != null)
    .reduce((s, t) => s + t.shares * Math.abs(t.entry_price - t.sl), 0);

  const expectancyPerDollarRisk = totalDollarRisk > 0 ? netPnl / totalDollarRisk : null;

  // MAE/MFE averages
  const maeVals = closed.filter(t => t.mae_pct != null).map(t => t.mae_pct);
  const mfeVals = closed.filter(t => t.mfe_pct != null).map(t => t.mfe_pct);

  return {
    total: trades.length,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: parseFloat(winRate.toFixed(1)),
    netPnl: parseFloat(netPnl.toFixed(2)),
    grossWin: parseFloat(grossWin.toFixed(2)),
    grossLoss: parseFloat(grossLoss.toFixed(2)),
    avgWin: parseFloat(avgWin.toFixed(2)),
    avgLoss: parseFloat(avgLoss.toFixed(2)),
    expectancy: parseFloat(expectancy.toFixed(2)),
    expectancyPerDollarRisk: expectancyPerDollarRisk != null ? parseFloat(expectancyPerDollarRisk.toFixed(4)) : null,
    profitFactor: profitFactor != null ? parseFloat(profitFactor.toFixed(2)) : null,
    avgR: avgR != null ? parseFloat(avgR.toFixed(2)) : null,
    avgCapture: avgCapture != null ? parseFloat(avgCapture.toFixed(1)) : null,
    avgDurationMs: avgDurationMs != null ? Math.round(avgDurationMs) : null,
    totalDollarRisk: parseFloat(totalDollarRisk.toFixed(2)),
    avgMaePct: maeVals.length ? parseFloat((maeVals.reduce((a,b)=>a+b,0)/maeVals.length).toFixed(3)) : null,
    avgMfePct: mfeVals.length ? parseFloat((mfeVals.reduce((a,b)=>a+b,0)/mfeVals.length).toFixed(3)) : null,
  };
}

function emptyMetrics(total = 0) {
  return { total, closed: 0, wins: 0, losses: 0, winRate: 0, netPnl: 0,
    grossWin: 0, grossLoss: 0, avgWin: 0, avgLoss: 0, expectancy: 0,
    expectancyPerDollarRisk: null, profitFactor: null, avgR: null,
    avgCapture: null, avgDurationMs: null, totalDollarRisk: 0,
    avgMaePct: null, avgMfePct: null };
}

// ─── Grade ────────────────────────────────────────────────────────────────────

function gradeSetup(metrics, minTrades) {
  if (metrics.closed < minTrades) return { grade: 'B', reason: `bootstrapping (${metrics.closed}/${minTrades} trades)` };

  const { expectancyPerDollarRisk: edr, winRate, expectancy } = metrics;
  const score = edr ?? (expectancy / 100);  // fallback if no SL data

  if (score >= 0.015 && winRate >= 50) return { grade: 'A+', reason: 'strong expectancy + win rate' };
  if (score >= 0.010 && winRate >= 40) return { grade: 'A',  reason: 'solid expectancy' };
  if (score >= 0.005)                  return { grade: 'B',  reason: 'positive expectancy' };
  return { grade: 'C', reason: 'negative or low expectancy' };
}

function gradeCondition(deltaExpectancy, n, minTrades) {
  if (n < minTrades) return { grade: 'B', reason: `bootstrapping (${n}/${minTrades})` };
  if (deltaExpectancy >= 1.0)  return { grade: 'A+', reason: 'high delta expectancy' };
  if (deltaExpectancy >= 0.5)  return { grade: 'A',  reason: 'positive delta expectancy' };
  if (deltaExpectancy >= 0)    return { grade: 'B',  reason: 'slightly positive' };
  return { grade: 'C', reason: 'negative delta expectancy' };
}

// ─── Per-setup analysis ───────────────────────────────────────────────────────

function analyzeSetup(setupId) {
  const minTrades    = getSetting('journal_min_grade_trades', 20);
  const minCondTrades = getSetting('journal_min_condition_trades', 10);

  const trades = db.prepare(`
    SELECT t.*, ts.r_multiple, ts.capture_pct
    FROM journal_trades t
    LEFT JOIN journal_technical_snapshots ts ON ts.trade_id = t.id
    WHERE t.setup_id = ?
  `).all(setupId);

  const metrics = computeMetrics(trades);
  const gradeResult = gradeSetup(metrics, minTrades);

  // Condition analysis
  const conditionStats = analyzeConditions(setupId, minCondTrades);

  return { setupId, metrics, grade: gradeResult, conditions: conditionStats };
}

function analyzeConditions(setupId, minTrades) {
  // Get all trades for this setup that have conditions computed
  const rows = db.prepare(`
    SELECT jc.condition_key, jc.aligned, t.net_pnl, t.r_multiple,
           t.sl, t.entry_price, t.shares, jc.mandatory
    FROM journal_conditions jc
    JOIN journal_trades t ON t.id = jc.trade_id
    WHERE t.setup_id = ? AND t.status = 'closed' AND t.net_pnl IS NOT NULL
  `).all(setupId);

  const byKey = {};
  for (const row of rows) {
    if (!byKey[row.condition_key]) byKey[row.condition_key] = { aligned: [], notAligned: [], mandatory: row.mandatory };
    const bucket = row.aligned === 1 ? 'aligned' : 'notAligned';
    byKey[row.condition_key][bucket].push(row.net_pnl);
  }

  const result = [];
  for (const [key, data] of Object.entries(byKey)) {
    const expAligned    = expectancyFromPnls(data.aligned);
    const expNotAligned = expectancyFromPnls(data.notAligned);
    const delta = expAligned != null && expNotAligned != null ? expAligned - expNotAligned : null;
    const n = data.aligned.length + data.notAligned.length;
    const grade = delta != null ? gradeCondition(delta, Math.min(data.aligned.length, data.notAligned.length), minTrades) : null;

    result.push({
      conditionKey: key,
      mandatory: data.mandatory === 1,
      nAligned: data.aligned.length,
      nNotAligned: data.notAligned.length,
      expectancyAligned: expAligned,
      expectancyNotAligned: expNotAligned,
      deltaExpectancy: delta != null ? parseFloat(delta.toFixed(2)) : null,
      grade,
    });
  }

  return result.sort((a, b) => (b.deltaExpectancy ?? -999) - (a.deltaExpectancy ?? -999));
}

function expectancyFromPnls(pnls) {
  if (!pnls.length) return null;
  const wins   = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const wr = wins.length / pnls.length;
  const avgW = wins.length   ? wins.reduce((a,b)=>a+b,0)   / wins.length   : 0;
  const avgL = losses.length ? losses.reduce((a,b)=>a+b,0) / losses.length : 0;
  return parseFloat((wr * avgW - (1 - wr) * Math.abs(avgL)).toFixed(2));
}

// ─── Account-level overview ───────────────────────────────────────────────────

function analyzeAccount(filters = {}) {
  let q = 'SELECT t.* FROM journal_trades t WHERE 1=1';
  const params = [];
  if (filters.account) { q += ' AND t.account = ?'; params.push(filters.account); }
  if (filters.from)    { q += ' AND t.date >= ?';   params.push(filters.from); }
  if (filters.to)      { q += ' AND t.date <= ?';   params.push(filters.to); }

  const trades  = db.prepare(q).all(...params);
  const metrics = computeMetrics(trades);

  // Per-setup contribution
  const setupIds = [...new Set(trades.map(t => t.setup_id).filter(Boolean))];
  const setupContributions = setupIds.map(sid => {
    const setupTrades = trades.filter(t => t.setup_id === sid);
    const sm = computeMetrics(setupTrades);
    return {
      setupId: sid,
      trades: sm.closed,
      netPnl: sm.netPnl,
      totalDollarRisk: sm.totalDollarRisk,
      pnlShare: metrics.netPnl !== 0 ? parseFloat((sm.netPnl / metrics.netPnl * 100).toFixed(1)) : null,
      riskShare: metrics.totalDollarRisk > 0 ? parseFloat((sm.totalDollarRisk / metrics.totalDollarRisk * 100).toFixed(1)) : null,
      expectancy: sm.expectancy,
      winRate: sm.winRate,
    };
  });

  // Drawdown
  const sorted = trades
    .filter(t => t.status === 'closed' && t.net_pnl != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of sorted) {
    equity += t.net_pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    metrics,
    maxDrawdown: parseFloat(maxDD.toFixed(2)),
    setupContributions,
    tradeCount: trades.length,
  };
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

function calendarData(filters = {}) {
  let q = 'SELECT date, SUM(net_pnl) as pnl, COUNT(*) as n FROM journal_trades WHERE status="closed"';
  const params = [];
  if (filters.from) { q += ' AND date >= ?'; params.push(filters.from); }
  if (filters.to)   { q += ' AND date <= ?'; params.push(filters.to); }
  q += ' GROUP BY date ORDER BY date';
  return db.prepare(q).all(...params);
}

module.exports = {
  computeMetrics,
  gradeSetup,
  gradeCondition,
  analyzeSetup,
  analyzeAccount,
  calendarData,
};
