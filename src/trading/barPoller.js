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
const volumeBaseline = require('./volumeBaseline');

// ─── Time-window helpers ─────────────────────────────────────────────────────

function _etHMNow(now) {
  const hour = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const min  = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  return hour * 60 + min;
}

/**
 * Parse a "9:35" / "10:00" / "H:MM" / "HH:MM" style string into minutes-since-midnight.
 * Returns null if unparseable.
 */
function _hmToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

/**
 * Is `now` inside setup's configured [window_start, window_end) window in ET?
 * Defaults to the plan-wide 9:35–10:00 window if either bound is missing/invalid.
 */
function _setupInWindow(setup, nowMinutes) {
  const start = _hmToMinutes(setup.window_start) ?? (9 * 60 + 35);
  const end   = _hmToMinutes(setup.window_end)   ?? (10 * 60);
  return nowMinutes >= start && nowMinutes < end;
}

// Indicator registry: setupId → evaluate function
const INDICATORS = {
  // Populated dynamically from DB setups — matched by setup name
};

// Import all available engines
const ma13bounce = require('./indicators/ma13bounce');
const test       = require('./indicators/test');

// Key → engine map (matched against trading_setups.indicator field)
const ENGINES = {
  'ma13bounce': ma13bounce,
  'test':       test,
};

// Legacy name fallback (for setups created before the indicator field existed)
const ENGINE_BY_NAME = {
  '13 ma bounce': 'ma13bounce',
  '13ma bounce':  'ma13bounce',
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

function getEngine(setup) {
  // Primary: use explicit indicator key from DB
  if (setup.indicator) return ENGINES[setup.indicator] || null;
  // Fallback: try to match by name for backwards compatibility
  const key = ENGINE_BY_NAME[(setup.name || '').toLowerCase().trim()];
  return key ? ENGINES[key] : null;
}

function listEngines() {
  return Object.keys(ENGINES);
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

      // Compute rvol from the latest bar against the historical baseline
      // (per plan). Returns null if baseline for this ticker isn't built.
      const latestBar = bars?.[bars.length - 1];
      const rvol = (latestBar && latestBar.etTime)
        ? volumeBaseline.computeRvol(ticker, latestBar.v, latestBar.etTime)
        : null;

      const tickerStatus = {
        barsReceived,
        pmHigh,
        rvol,
        baselineBuilt: volumeBaseline.isBuilt(ticker),
        lastCheckedAt: Date.now(),
        setupResults: [],
      };

      const nowMinutes = _etHMNow(_status.lastPollAt);

      for (const setup of setups) {
        const engine = getEngine(setup);
        const key = `${ticker}:${setup.id}`;
        const alreadyFired = _firedThisSession.has(key);
        const inWindow = _setupInWindow(setup, nowMinutes);

        const setupResult = {
          setupName:   setup.name,
          engineFound: !!engine,
          alreadyFired,
          window:      { start: setup.window_start || '09:35', end: setup.window_end || '10:00', inWindow },
          skipped:     !engine || !bars || barsReceived < 23 || alreadyFired || !inWindow,
          skipReason:  !engine ? 'no engine for setup name'
                    : !bars || barsReceived < 23 ? `only ${barsReceived} bars (need 23)`
                    : alreadyFired ? 'already fired this session'
                    : !inWindow ? `outside setup window (${setup.window_start || '09:35'}–${setup.window_end || '10:00'} ET)`
                    : null,
          signal: null,
          error:  null,
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

module.exports = { start, stop, getEngine, getStatus, listEngines };
