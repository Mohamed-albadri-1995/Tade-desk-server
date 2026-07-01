/**
 * Bar Poller / Bar Stream Router
 *
 * During an active session, feeds indicator engines with 1-min bars for
 * each shortlist ticker. Data source is selectable via the
 * `trading_data_source` setting: 'polling' (HTTP every 60s) or
 * 'websocket' (Alpaca live stream).
 *
 * The evaluation logic (windows, dedupe, rvol, indicator dispatch) is
 * identical for both sources — only the delivery differs.
 */

const db = require('../db');
const { fetchIntradayBars } = require('../alpaca/client');
const { toETDate } = require('../utils/time');
const r0 = require('../r0/registry');
const volumeBaseline = require('./volumeBaseline');
const { AlpacaStream } = require('./alpacaStream');

// ─── Time-window helpers ─────────────────────────────────────────────────────

function _etHMNow(now) {
  const hour = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
  const min  = parseInt(new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', minute: 'numeric' }));
  return hour * 60 + min;
}

function _hmToMinutes(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}

function _setupInWindow(setup, nowMinutes) {
  const start = _hmToMinutes(setup.window_start) ?? (9 * 60 + 35);
  const end   = _hmToMinutes(setup.window_end)   ?? (10 * 60);
  return nowMinutes >= start && nowMinutes < end;
}

// ─── Indicator registry ─────────────────────────────────────────────────────

const ma13bounce = require('./indicators/ma13bounce');
const test       = require('./indicators/test');

const ENGINES = {
  'ma13bounce': ma13bounce,
  'test':       test,
};

const ENGINE_BY_NAME = {
  '13 ma bounce': 'ma13bounce',
  '13ma bounce':  'ma13bounce',
};

function getEngine(setup) {
  if (setup.indicator) return ENGINES[setup.indicator] || null;
  const key = ENGINE_BY_NAME[(setup.name || '').toLowerCase().trim()];
  return key ? ENGINES[key] : null;
}

function listEngines() {
  return Object.keys(ENGINES);
}

// ─── Session state ──────────────────────────────────────────────────────────

let _pollingInterval = null;
let _wsClient        = null;
let _firedThisSession = new Set();

// Only populated in websocket mode — rolling per-ticker bar buffer.
const _barBuffer = new Map(); // ticker → bar[]
const MAX_BUFFERED_BARS = 400;

const _status = {
  running:      false,
  source:       'polling',
  sessionId:    null,
  tickers:      [],
  setupNames:   [],
  lastPollAt:   null,
  lastPollError: null,
  pollCount:    0,
  tickerResults: {},
  ws:           null,
};

function getStatus() {
  return {
    ..._status,
    tickerResults: { ..._status.tickerResults },
    ws: _wsClient ? _wsClient.getStatus() : null,
  };
}

function _readSourceSetting() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'trading_data_source'").get();
  const val = (row?.value || 'polling').toLowerCase();
  return val === 'websocket' ? 'websocket' : 'polling';
}

// ─── Shared evaluation ──────────────────────────────────────────────────────

function _evaluateTicker(ticker, bars, setups, sessionId, onSignalFired) {
  const barsReceived = bars?.length ?? 0;
  const r0row = r0.getRow(ticker);
  const pmHigh = r0row?.stock?.pmHigh ?? null;

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

  const nowMinutes = _etHMNow(Date.now());

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
            entry:     signal.entry ?? null,
            sl:        signal.sl,
            tp:        signal.tp,
            entryType: setup.entry_type || 'market',
            barData:   signal.meta,
            // Extras the Router needs to evaluate default + additional
            // library checks at this exact bar (per-setup context capture).
            bars,
            pmHigh,
            rvol,
            indicators: { ...(signal.meta || {}), rvol },
          }, sessionId);
        } else if (engine.debug) {
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

// ─── HTTP polling mode ──────────────────────────────────────────────────────

function _startPollingMode(sessionId, tickers, setups, onSignalFired) {
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
      _evaluateTicker(ticker, barsByTicker[ticker], setups, sessionId, onSignalFired);
    }
  }

  poll();
  _pollingInterval = setInterval(poll, 60 * 1000);
}

// ─── WebSocket mode ─────────────────────────────────────────────────────────

async function _seedBufferFromHttp(tickers) {
  const date = toETDate(Date.now());
  try {
    const barsByTicker = await fetchIntradayBars(tickers, date);
    for (const ticker of tickers) {
      const bars = barsByTicker[ticker] || [];
      _barBuffer.set(ticker, bars.slice(-MAX_BUFFERED_BARS));
    }
    console.log('[BarPoller/WS] Seeded buffer for', tickers.length, 'tickers');
  } catch (err) {
    console.warn('[BarPoller/WS] Buffer seed failed:', err.message);
  }
}

function _startWsMode(sessionId, tickers, setups, onSignalFired) {
  _barBuffer.clear();
  _seedBufferFromHttp(tickers);

  _wsClient = new AlpacaStream({
    tickers,
    onBar: (ticker, bar) => {
      const buf = _barBuffer.get(ticker) || [];
      buf.push(bar);
      if (buf.length > MAX_BUFFERED_BARS) buf.shift();
      _barBuffer.set(ticker, buf);
      _status.lastPollAt = Date.now();
      _status.pollCount++;
      _evaluateTicker(ticker, buf, setups, sessionId, onSignalFired);
    },
    onError: (err) => {
      _status.lastPollError = err.message || String(err);
    },
  });
  _wsClient.start();
}

function getLatestQuote(ticker) {
  return _wsClient ? _wsClient.getLatestQuote(ticker) : null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

function start(sessionId, tickers, setups, onSignalFired) {
  stop();
  _firedThisSession.clear();
  _barBuffer.clear();

  const source = _readSourceSetting();

  _status.running = true;
  _status.source = source;
  _status.sessionId = sessionId;
  _status.tickers = [...tickers];
  _status.setupNames = setups.map(s => s.name);
  _status.lastPollAt = null;
  _status.lastPollError = null;
  _status.pollCount = 0;
  _status.tickerResults = {};

  if (!tickers.length) return;

  console.log(`[BarPoller] Starting (${source}) for ${tickers.length} tickers`);

  if (source === 'websocket') {
    _startWsMode(sessionId, tickers, setups, onSignalFired);
  } else {
    _startPollingMode(sessionId, tickers, setups, onSignalFired);
  }
}

function stop() {
  if (_pollingInterval) {
    clearInterval(_pollingInterval);
    _pollingInterval = null;
  }
  if (_wsClient) {
    try { _wsClient.stop(); } catch { /* ignore */ }
    _wsClient = null;
  }
  _firedThisSession.clear();
  _barBuffer.clear();
  _status.running = false;
  console.log('[BarPoller] Stopped');
}

module.exports = { start, stop, getEngine, getStatus, listEngines, getLatestQuote };
