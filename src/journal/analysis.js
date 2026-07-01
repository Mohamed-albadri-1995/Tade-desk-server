/**
 * Journal metric helpers.
 *
 * Just computeMetrics (arbitrary-filter dollar/win-rate math for the
 * Journal tab metric bar) and calendarData (daily P&L heatmap) live here.
 * Expectancy, per-setup grading, and per-check contribution moved to
 * src/trading/grading.js — one source of truth reading trade_cards.
 */

const db = require('../db');

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
  calendarData,
};
