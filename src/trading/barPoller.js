/**
 * Bar Poller
 *
 * During an active session, polls Alpaca every 60s for fresh 1-min bars
 * for each watched ticker, runs all active indicator engines, and fires
 * signals via sideB.onIndicatorFire() when conditions are met.
 */

const { fetchIntradayBars } = require('../alpaca/client');
const { toETDate } = require('../utils/time');
const r0 = require('../r0/registry');

// Indicator registry: setupId → evaluate function
const INDICATORS = {
  // Populated dynamically from DB setups — matched by setup name
};

// Import all available engines
const ma13bounce = require('./indicators/ma13bounce');

// Name → engine map (matched against trading_setups.name, case-insensitive)
const ENGINE_BY_NAME = {
  '13 ma bounce': ma13bounce,
  '13ma bounce':  ma13bounce,
};

let _interval = null;
let _firedThisSession = new Set(); // prevent duplicate signals per ticker per session

function getEngine(setupName) {
  return ENGINE_BY_NAME[(setupName || '').toLowerCase().trim()] || null;
}

/**
 * Start polling for a session.
 * @param {string}   sessionId
 * @param {string[]} tickers
 * @param {object[]} setups        - active setups from DB
 * @param {Function} onSignalFired - callback(signal) → sideB.onIndicatorFire
 */
function start(sessionId, tickers, setups, onSignalFired) {
  stop(); // clear any previous interval
  _firedThisSession.clear();

  if (!tickers.length) return;

  console.log('[BarPoller] Starting for', tickers.length, 'tickers');

  async function poll() {
    const date = toETDate(Date.now());
    let barsByTicker;
    try {
      barsByTicker = await fetchIntradayBars(tickers, date);
    } catch (e) {
      console.warn('[BarPoller] Alpaca fetch failed:', e.message);
      return;
    }

    for (const setup of setups) {
      const engine = getEngine(setup.name);
      if (!engine) continue;

      for (const ticker of tickers) {
        const bars = barsByTicker[ticker];
        if (!bars || bars.length < 23) continue;

        // Deduplicate: only fire once per ticker+setup per session
        const key = `${ticker}:${setup.id}`;
        if (_firedThisSession.has(key)) continue;

        // Get PM high from r0 scanner context
        const r0row = r0.getRow(ticker);
        const pmHigh = r0row?.stock?.pmHigh ?? null;

        let signal;
        try {
          signal = engine.evaluate(bars, pmHigh);
        } catch (e) {
          console.warn(`[BarPoller] ${ticker} engine error:`, e.message);
          continue;
        }

        if (!signal) continue;

        _firedThisSession.add(key);
        console.log(`[BarPoller] Signal: ${ticker} ${signal.direction} setup=${setup.name}`);

        onSignalFired({
          ticker,
          setupId:   setup.id,
          direction: signal.direction,
          sl:        signal.sl,
          tp:        signal.tp,
          entryType: setup.entry_type || 'market',
          barData:   signal.meta,
        }, sessionId);
      }
    }
  }

  // Poll immediately, then every 60s
  poll();
  _interval = setInterval(poll, 60 * 1000);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  _firedThisSession.clear();
  console.log('[BarPoller] Stopped');
}

module.exports = { start, stop, getEngine };
