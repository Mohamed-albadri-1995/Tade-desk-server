const { v4: uuidv4 } = require('uuid');
const { runAllScanners } = require('./sideA/tvScanner');
const { mergeScannersIntoR0 } = require('./sideA/merge');
const { applyDerivedFields } = require('./sideB/calculations');
const { fetchNewsForTicker } = require('./sideC/news');
const { buildMarketSnapshot, enrichR0WithContext } = require('./sideD/engine');
const db = require('./db');
const r0 = require('./r0/registry');
const { syncShortlistToR0 } = require('./sideF/shortlist');
const { refreshStaleInR0 } = require('./sideG/staleFetch');
const { toETDate } = require('./utils/time');
const { scoreAllRows } = require('./sideE/score');

const scanStatus = {
  lastRun: null,
  lastRowCount: 0,
  running: false,
  error: null,
  lastReport: null,
};

function stageWrap(report, key, fn) {
  return async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      report.stages[key] = { ok: true, duration: Date.now() - t0, ...result };
    } catch (err) {
      report.stages[key] = { ok: false, duration: Date.now() - t0, error: err.message };
      throw err;
    }
  };
}

function stageWrapSoft(report, key, fn) {
  return async () => {
    const t0 = Date.now();
    try {
      const result = await fn();
      report.stages[key] = { ok: true, duration: Date.now() - t0, ...result };
    } catch (err) {
      report.stages[key] = { ok: false, duration: Date.now() - t0, error: err.message };
      console.error(`[Pipeline] ${key} failed (non-fatal):`, err.message);
    }
  };
}

async function runFullScan() {
  if (scanStatus.running) {
    console.log('[Pipeline] Scan already running, skipping');
    return { rowsProcessed: 0, ts: Date.now() };
  }
  scanStatus.running = true;
  scanStatus.error = null;

  const report = {
    scanId: uuidv4(),
    startedAt: Date.now(),
    completedAt: null,
    ok: false,
    stages: {},
  };

  try {
    console.log('[Pipeline] Starting full scan...');

    // Day-boundary guard: if r0 has any rows from a previous date, flush before scanning.
    // This is the primary cleanup mechanism — more reliable than the midnight cron alone.
    const today = toETDate(Date.now());
    const hasPreviousDay = r0.getAll().some(row => row.date !== today);
    if (hasPreviousDay) {
      console.log('[Pipeline] Day boundary detected — flushing r0');
      r0.clearAll();
    }

    // Side A: TradingView Scanners (fatal)
    let merged;
    await stageWrap(report, 'sideA', async () => {
      const scannerResults = await runAllScanners();
      merged = mergeScannersIntoR0(scannerResults);
      return { rowCount: merged.length };
    })();

    // Side B: Internal Calculations (fatal)
    let withDerived;
    await stageWrap(report, 'sideB', async () => {
      withDerived = applyDerivedFields(merged);
      return { rowCount: withDerived.length };
    })();

    // Side D: Market Context (non-fatal)
    let withContext = withDerived;
    await stageWrapSoft(report, 'sideD', async () => {
      await buildMarketSnapshot();
      withContext = enrichR0WithContext(withDerived);
      return { rowCount: withContext.length };
    })();

    // Side E: Live scoring via Python Flask service (non-fatal — null scores if service down)
    let withScores = withContext;
    await stageWrapSoft(report, 'sideE', async () => {
      // Preserve user-set bias from previous r0 state before scoring
      const toScore = withContext.map(row => {
        const prev = r0.getRow(row.ticker);
        return prev?.bias && prev.bias !== 'auto' ? { ...row, bias: prev.bias } : row;
      });
      withScores = await scoreAllRows(toScore);
      const scored = withScores.filter(r => r._score !== null).length;
      return { rowCount: withScores.length, scored };
    })();
    if (!report.stages.sideE?.ok) {
      withScores = withContext.map(row => ({ ...row, _score: null }));
    }

    // Mark existing rows stale, then write live scan results
    r0.markAllStale();
    r0.upsertRows(withScores);

    // Side G: Refresh stale tickers with fresh TV quotes (non-fatal)
    await stageWrapSoft(report, 'sideG', async () => {
      return await refreshStaleInR0();
    })();

    // Side C: News & Catalyst for all live tickers (non-fatal)
    await stageWrapSoft(report, 'sideC', async () => {
      const liveRows = r0.getAll().filter(r => r.liveNow);
      const results = await Promise.allSettled(
        liveRows.map(row => fetchNewsForTicker(row.ticker).then(({ news, catalyst }) => {
          r0.updateNews(row.ticker, news, catalyst);
        }))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      return { rowCount: liveRows.length, failed };
    })();

    // Side F: Restore inShortlist flags from DB (non-fatal)
    await stageWrapSoft(report, 'sideF', async () => {
      syncShortlistToR0();
      return {};
    })();

    // r0 summary
    const allRows = r0.getAll();
    report.r0Summary = {
      total: allRows.length,
      liveNow: allRows.filter(r => r.liveNow).length,
      stale: allRows.filter(r => !r.liveNow).length,
      inShortlist: allRows.filter(r => r.inShortlist).length,
    };

    report.ok = true;
    report.completedAt = Date.now();

    // Checkpoint r0 to DB so a mid-day server restart can restore state
    try {
      db.prepare(
        'INSERT OR REPLACE INTO r0_checkpoint (id, date, data, saved_at) VALUES (1, ?, ?, ?)'
      ).run(today, JSON.stringify(r0.serialize()), report.completedAt);
    } catch (cpErr) {
      console.warn('[Pipeline] Checkpoint save failed:', cpErr.message);
    }

    scanStatus.lastRun = report.completedAt;
    scanStatus.lastRowCount = withScores.length;
    scanStatus.lastReport = report;

    console.log('[Pipeline] Scan complete:', withScores.length, 'live,', report.r0Summary.stale, 'stale');
    return { rowsProcessed: withScores.length, ts: scanStatus.lastRun };
  } catch (err) {
    report.completedAt = Date.now();
    report.ok = false;
    scanStatus.error = err.message;
    scanStatus.lastReport = report;
    console.error('[Pipeline] Scan error:', err.message);
    throw err;
  } finally {
    scanStatus.running = false;
  }
}

function getScanStatus() {
  return {
    lastRun: scanStatus.lastRun,
    lastRowCount: scanStatus.lastRowCount,
    running: scanStatus.running,
    error: scanStatus.error,
    lastReport: scanStatus.lastReport,
  };
}

module.exports = { runFullScan, getScanStatus };
