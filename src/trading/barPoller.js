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

// Live status — what happened on the last poll
let _status = {
  running: false,
  lastPollAt: null,
  lastPollError: null,
  tickers: [],
  evaluations: {}, // ticker → { bars: count, results: [{setupName, fired, reason}], pmHigh }
};

function getStatus() { return _status; }

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

  _status.running = true;
  _status.tickers = [...tickers];
  _status.evaluations = {};
  console.log('[BarPoller] Starting for', tickers.length, 'tickers');

  async function poll() {
    const date = toETDate(Date.now());
    const pollAt = Date.now();
    let barsByTicker;
    try {
      barsByTicker = await fetchIntradayBars(tickers, date);
      _status.lastPollError = null;
    } catch (e) {
      console.warn('[BarPoller] Alpaca fetch failed:', e.message);
      _status.lastPollAt = pollAt;
      _status.lastPollError = e.message;
      return;
    }
    _status.lastPollAt = pollAt;

    // Reset per-ticker evaluation results for this poll
    for (const ticker of tickers) {
      _status.evaluations[ticker] = { bars: 0, pmHigh: null, results: [] };
    }

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker];
      _status.evaluations[ticker].bars = bars ? bars.length : 0;

      const r0row = r0.getRow(ticker);
      const pmHigh = r0row?.stock?.pmHigh ?? null;
      _status.evaluations[ticker].pmHigh = pmHigh;

      for (const setup of setups) {
        const engine = getEngine(setup.name);
        if (!engine) continue;

        if (!bars || bars.length < 23) {
          _status.evaluations[ticker].results.push({
            setupName: setup.name,
            fired: false,
            reason: bars ? `only ${bars ? bars.length : 0} bars (need 23)` : 'no bars',
          });
          continue;
        }

        const key = `${ticker}:${setup.id}`;
        if (_firedThisSession.has(key)) {
          _status.evaluations[ticker].results.push({ setupName: setup.name, fired: true, reason: 'already fired this session' });
          continue;
        }

        let signal;
        try {
          signal = engine.evaluate(bars, pmHigh);
        } catch (e) {
          console.warn(`[BarPoller] ${ticker} engine error:`, e.message);
          _status.evaluations[ticker].results.push({ setupName: setup.name, fired: false, reason: `engine error: ${e.message}` });
          continue;
        }

        if (!signal) {
          _status.evaluations[ticker].results.push({ setupName: setup.name, fired: false, reason: 'conditions not met' });
          continue;
        }

        _firedThisSession.add(key);
        _status.evaluations[ticker].results.push({ setupName: setup.name, fired: true, reason: 'signal fired' });
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
  _status.running = false;
  _status.tickers = [];
  console.log('[BarPoller] Stopped');
}

module.exports = { start, stop, getEngine, getStatus };
