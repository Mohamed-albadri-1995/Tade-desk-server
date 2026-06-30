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

// ─── Status tracking (read-only observability) ────────────────────────────────
const _status = {
  running: false,
  sessionId: null,
  tickers: [],
  setupNames: [],
  lastPollAt: null,
  lastPollError: null,
  pollCount: 0,
  tickerResults: {}, // ticker → { barsReceived, lastCheckedAt, conditions: [], signal: null, firedThisSession: false }
};

function getStatus() {
  return {
    ..._status,
    tickerResults: { ..._status.tickerResults },
  };
}

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

  _status.running = true;
  _status.sessionId = sessionId;
  _status.tickers = [...tickers];
  _status.setupNames = setups.map(s => s.name);
  _status.lastPollAt = null;
  _status.lastPollError = null;
  _status.pollCount = 0;
  _status.tickerResults = {};

  if (!tickers.length) return;

  console.log('[BarPoller] Starting for', tickers.length, 'tickers');

  async function poll() {
    const date = toETDate(Date.now());
    _status.lastPollAt = Date.now();
    _status.pollCount++;
    _status.lastPollError = null;

    let barsByTicker;
    try {
      barsByTicker = await fetchIntradayBars(tickers, date);
    } catch (e) {
      _status.lastPollError = e.message;
      console.warn('[BarPoller] Alpaca fetch failed:', e.message);
      return;
    }

    for (const ticker of tickers) {
      const bars = barsByTicker[ticker];
      const barsReceived = bars?.length ?? 0;
      const r0row = r0.getRow(ticker);
      const pmHigh = r0row?.stock?.pmHigh ?? null;

      const tickerStatus = {
        barsReceived,
        pmHigh,
        lastCheckedAt: Date.now(),
        setupResults: [],
      };

      for (const setup of setups) {
        const engine = getEngine(setup.name);
        const key = `${ticker}:${setup.id}`;
        const alreadyFired = _firedThisSession.has(key);

        const setupResult = {
          setupName: setup.name,
          engineFound: !!engine,
          alreadyFired,
          skipped: !engine || !bars || barsReceived < 23 || alreadyFired,
          skipReason: !engine ? 'no engine for setup name'
                    : !bars || barsReceived < 23 ? `only ${barsReceived} bars (need 23)`
                    : alreadyFired ? 'already fired this session'
                    : null,
          signal: null,
          error: null,
        };

        if (!setupResult.skipped) {
          try {
            const signal = engine.evaluate(bars, pmHigh);
            setupResult.signal = signal ? { direction: signal.direction, sl: signal.sl, tp: signal.tp, meta: signal.meta } : null;

            if (signal) {
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
            } else if (engine.debug) {
              // Capture per-condition detail for monitoring
              setupResult.debugInfo = engine.debug(bars, pmHigh);
            }
          } catch (e) {
            setupResult.error = e.message;
            console.warn(`[BarPoller] ${ticker} engine error:`, e.message);
          }
        }

        setupResult.firedThisSession = _firedThisSession.has(key);
        tickerStatus.setupResults.push(setupResult);
      }

      _status.tickerResults[ticker] = tickerStatus;
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
  console.log('[BarPoller] Stopped');
}

module.exports = { start, stop, getEngine, getStatus };
