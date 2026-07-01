/**
 * Historical Volume Baseline
 *
 * Builds a 10-day avg volume by minute-of-day for rvol calculation.
 * Fetched from Alpaca historical bars and cached in memory / SQLite.
 */

const db = require('../db');
const { fetchIntradayBars } = require('../alpaca/client');
const { toETDate } = require('../utils/time');

// In-memory cache: Map<ticker, Map<'HH:MM', avgVolume>>
const cache = new Map();

db.exec(`
  CREATE TABLE IF NOT EXISTS volume_baseline (
    ticker TEXT NOT NULL,
    minute TEXT NOT NULL,
    avg_volume REAL NOT NULL,
    built_at INTEGER NOT NULL,
    PRIMARY KEY (ticker, minute)
  );
`);

/**
 * Load baseline from DB into memory for given tickers.
 */
function loadFromDb(tickers) {
  for (const ticker of tickers) {
    const rows = db.prepare('SELECT minute, avg_volume FROM volume_baseline WHERE ticker = ?').all(ticker);
    if (rows.length > 0) {
      const m = new Map();
      for (const r of rows) m.set(r.minute, r.avg_volume);
      cache.set(ticker, m);
    }
  }
}

/**
 * Build baseline for a ticker from last 10 trading days of Alpaca bars.
 * Requires Alpaca credentials set in settings.
 */
async function build(tickers, referenceDate) {
  const dates = getLast10TradingDates(referenceDate);
  for (const ticker of tickers) {
    const minuteVolumes = new Map(); // 'HH:MM' → [volumes]

    for (const date of dates) {
      try {
        const bars = await fetchIntradayBars([ticker], date);
        const tickerBars = bars[ticker] || [];
        for (const bar of tickerBars) {
          const min = bar.etTime; // 'HH:MM'
          if (!minuteVolumes.has(min)) minuteVolumes.set(min, []);
          minuteVolumes.get(min).push(bar.v);
        }
      } catch {
        // Skip days with no data
      }
    }

    // Compute averages and persist
    const avgMap = new Map();
    const now = Date.now();
    const insertStmt = db.prepare(
      'INSERT OR REPLACE INTO volume_baseline (ticker, minute, avg_volume, built_at) VALUES (?, ?, ?, ?)'
    );
    for (const [min, vols] of minuteVolumes.entries()) {
      const avg = vols.reduce((a, b) => a + b, 0) / vols.length;
      avgMap.set(min, avg);
      insertStmt.run(ticker, min, avg, now);
    }
    cache.set(ticker, avgMap);
  }
}

/**
 * Get avg volume for a ticker at a specific minute string ('HH:MM').
 * Returns null if not available.
 */
function getAvgVolume(ticker, minuteStr) {
  return cache.get(ticker)?.get(minuteStr) ?? null;
}

/**
 * Compute rvol: currentVolume / avgVolumeAtThisMinute
 */
function computeRvol(ticker, currentVolume, minuteStr) {
  const avg = getAvgVolume(ticker, minuteStr);
  if (!avg) return null;
  return parseFloat((currentVolume / avg).toFixed(2));
}

function isBuilt(ticker) {
  return cache.has(ticker) && cache.get(ticker).size > 0;
}

/**
 * When was this ticker's baseline last built (any minute row)? Returns 0
 * if never built. Used to decide whether to refresh.
 */
function lastBuiltAt(ticker) {
  const row = db
    .prepare('SELECT MAX(built_at) AS at FROM volume_baseline WHERE ticker = ?')
    .get(ticker);
  return Number(row?.at) || 0;
}

const REBUILD_AFTER_MS = 20 * 60 * 60 * 1000; // 20 hours — rebuild once per trading day

/**
 * Ensure baselines exist for the given tickers. Loads any cached DB rows
 * into memory first, then rebuilds tickers whose cache is empty or older
 * than REBUILD_AFTER_MS. Non-fatal — logs and continues on per-ticker
 * failure so a bad ticker doesn't block the whole session.
 */
async function ensureBuilt(tickers, referenceDate) {
  loadFromDb(tickers);
  const now = Date.now();
  const toBuild = [];
  for (const t of tickers) {
    const staleOrMissing = !isBuilt(t) || (now - lastBuiltAt(t)) > REBUILD_AFTER_MS;
    if (staleOrMissing) toBuild.push(t);
  }
  if (toBuild.length === 0) return { rebuilt: 0, cached: tickers.length };
  console.log('[VolumeBaseline] Building baseline for', toBuild.length, 'ticker(s):', toBuild.join(','));
  try {
    await build(toBuild, referenceDate);
  } catch (err) {
    console.warn('[VolumeBaseline] Build failed (non-fatal):', err.message);
  }
  return { rebuilt: toBuild.length, cached: tickers.length - toBuild.length };
}

function getStatus(tickers) {
  const out = {};
  for (const t of tickers) {
    out[t] = {
      built: isBuilt(t),
      lastBuiltAt: lastBuiltAt(t) || null,
      minutes: cache.get(t)?.size || 0,
    };
  }
  return out;
}

// Simple weekday date list going back N trading days
function getLast10TradingDates(fromDate) {
  const dates = [];
  const d = new Date(`${fromDate}T12:00:00-05:00`);
  while (dates.length < 10) {
    d.setDate(d.getDate() - 1);
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(d.toISOString().slice(0, 10));
    }
  }
  return dates;
}

module.exports = {
  build,
  ensureBuilt,
  loadFromDb,
  getAvgVolume,
  computeRvol,
  isBuilt,
  lastBuiltAt,
  getStatus,
};
