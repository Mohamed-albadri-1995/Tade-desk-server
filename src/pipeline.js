const { runAllScanners } = require('./sideA/tvScanner');
const { mergeScannersIntoR0 } = require('./sideA/merge');
const { applyDerivedFields } = require('./sideB/calculations');
const { buildMarketSnapshot, enrichR0WithContext } = require('./sideD/engine');
const { scoreAllRows } = require('./sideE/scoring');
const r0 = require('./r0/registry');

const scanStatus = {
  lastRun: null,
  lastRowCount: 0,
  running: false,
  error: null,
};

async function runFullScan() {
  if (scanStatus.running) {
    console.log('[Pipeline] Scan already running, skipping');
    return { rowsProcessed: 0, ts: Date.now() };
  }
  scanStatus.running = true;
  scanStatus.error = null;

  try {
    console.log('[Pipeline] Starting full scan...');

    // Side A: TradingView Scanners
    const scannerResults = await runAllScanners();
    const merged = mergeScannersIntoR0(scannerResults);

    // Side B: Internal Calculations
    const withDerived = applyDerivedFields(merged);

    // Side D: Market Context
    let withContext = withDerived;
    try {
      await buildMarketSnapshot();
      withContext = enrichR0WithContext(withDerived);
    } catch (err) {
      console.error('[Pipeline] Market context failed:', err.message);
    }

    // Side E: Scoring
    const withScores = scoreAllRows(withContext);

    // Write to r0
    r0.upsertRows(withScores);

    scanStatus.lastRun = Date.now();
    scanStatus.lastRowCount = withScores.length;
    console.log('[Pipeline] Scan complete:', withScores.length, 'rows');

    return { rowsProcessed: withScores.length, ts: scanStatus.lastRun };
  } catch (err) {
    scanStatus.error = err.message;
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
  };
}

module.exports = { runFullScan, getScanStatus };
