/**
 * Historical Backtest Runner (optional, user-triggered)
 *
 * Replays an indicator engine over the 1-min bars of a past trading day
 * so the user can verify the JS implementation matches their TradingView
 * Pine Script signal log (Phase 1 of the trading plan).
 *
 * This is intentionally NOT part of the live pipeline — the UI wires it up
 * on demand only.
 */

const db = require('../db');
const { fetchIntradayBars } = require('../alpaca/client');

// Lazy-load the indicator engines so a broken engine can't block startup.
function loadEngines() {
  return {
    ma13bounce:     require('./indicators/ma13bounce'),
    vwapBounce:     require('./indicators/vwapBounce'),
    smaTouchBounce: require('./indicators/smaTouchBounce'),
    test:           require('./indicators/test'),
  };
}

function _hmToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function _barMinutes(bar) {
  // Alpaca returns etTime as 'HH:MM'
  return _hmToMinutes(bar?.etTime);
}

/**
 * Look up the pre-market high for a ticker/date from r1_frozen so backtests
 * can reproduce the "close > PM high" check the way it ran live.
 * Returns null if no R1 row exists for that ticker+date.
 */
function getPmHighFromR1(ticker, date) {
  try {
    const row = db.prepare('SELECT data FROM r1_frozen WHERE date = ? AND ticker = ?').get(date, ticker);
    if (!row) return null;
    const parsed = JSON.parse(row.data);
    return parsed?.stock?.pmHigh ?? null;
  } catch {
    return null;
  }
}

/**
 * Replay an indicator over one trading day.
 *
 * @param {object} opts
 * @param {string} opts.ticker
 * @param {string} opts.date         'YYYY-MM-DD' (ET)
 * @param {string} opts.indicator    key into loadEngines() (e.g. 'ma13bounce')
 * @param {string|null} opts.windowStart  'HH:MM' — bars before this are skipped for fires
 * @param {string|null} opts.windowEnd    'HH:MM' — bars at/after this stop fires
 * @param {number|null} opts.pmHigh       override r1_frozen pmHigh
 * @returns {object} { ok, config, barsTotal, fires: [...], reason? }
 */
async function runBacktest(opts) {
  const {
    ticker,
    date,
    indicator,
    windowStart = null,
    windowEnd   = null,
  } = opts;
  const pmHighOverride = opts.pmHigh == null ? null : Number(opts.pmHigh);

  if (!ticker) return { ok: false, error: 'ticker is required' };
  if (!date)   return { ok: false, error: 'date is required (YYYY-MM-DD)' };
  if (!indicator) return { ok: false, error: 'indicator is required' };

  const engines = loadEngines();
  const engine  = engines[indicator];
  if (!engine || typeof engine.evaluate !== 'function') {
    return { ok: false, error: `Unknown indicator '${indicator}' (available: ${Object.keys(engines).join(', ')})` };
  }

  let barsByTicker;
  try {
    barsByTicker = await fetchIntradayBars([ticker.toUpperCase()], date);
  } catch (err) {
    return { ok: false, error: `Alpaca fetch failed: ${err.message}` };
  }
  const bars = barsByTicker?.[ticker.toUpperCase()] || [];
  if (!bars.length) {
    return { ok: false, error: `No bars for ${ticker} on ${date} (check Alpaca creds + weekday)` };
  }

  const pmHigh = Number.isFinite(pmHighOverride) ? pmHighOverride : getPmHighFromR1(ticker, date);

  const startMin = _hmToMinutes(windowStart);
  const endMin   = _hmToMinutes(windowEnd);

  // Replay bar-by-bar with dedup on bar time. Some engines return the
  // signal bar via meta.barTime; use that as the primary dedup key.
  const seenFires = new Set();
  const fires = [];

  for (let i = 0; i < bars.length; i++) {
    const barMin = _barMinutes(bars[i]);
    if (startMin != null && barMin != null && barMin < startMin) continue;
    if (endMin   != null && barMin != null && barMin >= endMin) break;

    const window = bars.slice(0, i + 1);
    let signal = null;
    try {
      // Historical replay has no live rvol stream. Indicators that need
      // it will short-circuit on null; ones that don't are unaffected.
      signal = engine.evaluate(window, pmHigh, { rvol: null });
    } catch { /* engine internal error, skip */ }
    if (!signal) continue;

    const key = String(signal.meta?.barTime ?? bars[i]?.t ?? i);
    if (seenFires.has(key)) continue;
    seenFires.add(key);

    fires.push({
      barIndex:  i,
      etTime:    bars[i].etTime,
      barTime:   signal.meta?.barTime ?? bars[i].t,
      direction: signal.direction,
      entry:     signal.entry,
      sl:        signal.sl,
      tp:        signal.tp,
      riskPerShare: signal.riskPerShare,
      meta:      signal.meta || null,
    });
  }

  return {
    ok: true,
    config: {
      ticker: ticker.toUpperCase(),
      date,
      indicator,
      windowStart,
      windowEnd,
      pmHigh,
    },
    barsTotal:  bars.length,
    firstBarET: bars[0]?.etTime ?? null,
    lastBarET:  bars[bars.length - 1]?.etTime ?? null,
    fires,
  };
}

function listIndicators() {
  return Object.keys(loadEngines());
}

module.exports = { runBacktest, listIndicators };
