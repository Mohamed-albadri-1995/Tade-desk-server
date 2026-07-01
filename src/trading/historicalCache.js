/**
 * Historical Bar Cache
 *
 * barPoller feeds today's live 1-min bars from Alpaca. Indicator engines
 * that need MORE than today — 2-day VWAP, 5-day MA (1950 bars on 1-min),
 * week/month anchored VWAPs, prior-day last-hour VWAP — have to pull
 * that from somewhere. This module pre-fetches N calendar days of 1-min
 * bars per shortlist ticker at session start and hands them back merged
 * with the live buffer so engines can pretend they always had them.
 *
 * Scope:
 *   - default 6 calendar days = 5 trading days + a weekend cushion
 *   - covers 2-day VWAP, 5-day MA, session-spanning anchored VWAPs
 *   - week/month VWAP that anchor further back need a longer horizon
 *     — flagged, not shipped in this pass; extending is a matter of
 *     setting a bigger `days` at warmup() time and living with the
 *     bigger memory footprint (~5 MB per ticker per 5 days).
 *
 * Non-blocking: warmup runs async in the background. Engines that
 * consult getBars() during warmup get whatever has already arrived —
 * they degrade to "today only" behavior early in the session and pick
 * up the full history a few seconds later. isReady() lets a caller
 * confirm it's fully warm.
 */

const alpacaClient = require('../alpaca/client');
const yahooClient  = require('../yahoo/client');
const { toETDate } = require('../utils/time');

// ticker → array of 1-min bars sorted chronologically.
const _cache = new Map();
// Tickers currently warming or warmed. Prevents duplicate fetch storms
// if warmup() is called twice in quick succession.
const _inflight = new Set();
let _ready = false;
let _warmupStartedAt = null;

/**
 * Pull `days` calendar days of history for every ticker in `tickers`.
 * Weekends are skipped automatically so 6 calendar days ≈ 5 trading days.
 * Errors on individual dates are swallowed (Alpaca sometimes 404s on
 * holidays) — an empty day just means one fewer bar of history, not a
 * total failure.
 */
async function warmup(tickers, days = 6) {
  if (!Array.isArray(tickers) || tickers.length === 0) return;
  _warmupStartedAt = Date.now();
  const upper = tickers.map(t => String(t).toUpperCase()).filter(t => !_inflight.has(t));
  for (const t of upper) _inflight.add(t);
  if (!upper.length) return;

  const now = Date.now();
  const dates = [];
  for (let d = days; d >= 1; d--) {
    const dt = new Date(now - d * 24 * 3600 * 1000);
    // toETDate returns YYYY-MM-DD in ET; skip weekends.
    const iso = toETDate(dt.getTime());
    const wday = new Date(iso + 'T12:00:00-05:00').getDay();
    if (wday === 0 || wday === 6) continue;
    dates.push(iso);
  }

  console.log(`[HistoricalCache] warming ${upper.length} tickers × ${dates.length} days`);
  for (const date of dates) {
    // Prefer Yahoo — consolidated tape, dense bars even for illiquid names.
    // Alpaca IEX is the fallback for anything Yahoo can't serve (rare;
    // sometimes it 404s on private companies or newly-listed tickers).
    // Live path stays on Alpaca WebSocket / HTTP — this only affects the
    // pre-session warmup.
    let map = null;
    try {
      map = await yahooClient.fetchIntradayBars(upper, date);
    } catch (err) {
      console.warn(`[HistoricalCache] Yahoo ${date} failed, trying Alpaca:`, err.message);
    }
    if (!map || Object.values(map).every(b => !b?.length)) {
      try {
        map = await alpacaClient.fetchIntradayBars(upper, date);
      } catch (err) {
        console.warn(`[HistoricalCache] Alpaca ${date} also failed:`, err.message);
        continue;
      }
    } else {
      // Per-ticker fallback: if Yahoo returned nothing for a particular
      // ticker but returned data for others, hit Alpaca just for that one.
      const emptyTickers = upper.filter(t => !map[t]?.length);
      if (emptyTickers.length) {
        try {
          const alpacaMap = await alpacaClient.fetchIntradayBars(emptyTickers, date);
          for (const [t, bars] of Object.entries(alpacaMap)) {
            if (bars?.length) map[t] = bars;
          }
        } catch { /* stick with Yahoo's empty */ }
      }
    }
    for (const [ticker, bars] of Object.entries(map)) {
      if (!bars?.length) continue;
      const list = _cache.get(ticker) || [];
      list.push(...bars);
      _cache.set(ticker, list);
    }
  }
  // Ensure chronological order.
  for (const [ticker, bars] of _cache.entries()) {
    bars.sort((a, b) => new Date(a.t) - new Date(b.t));
  }
  for (const t of upper) _inflight.delete(t);
  _ready = true;
  const ms = Date.now() - _warmupStartedAt;
  console.log(`[HistoricalCache] warm — ${_cache.size} tickers, ${[..._cache.values()].reduce((s, b) => s + b.length, 0)} bars total, ${ms} ms`);
}

/**
 * Return the cached 1-min bar history for a ticker. Empty array if not
 * warmed yet or if the ticker never had any history fetched.
 */
function getBars(ticker) {
  return _cache.get(String(ticker).toUpperCase()) || [];
}

/**
 * Merge cached history with a caller-supplied "today's live buffer" and
 * return the combined chronological list. Live bars whose timestamps
 * overlap the cache (should never happen for a session-start warmup)
 * take precedence — cache is deduped by bar.t before the concat.
 */
function mergeWithLive(ticker, liveBars) {
  const hist = getBars(ticker);
  if (!hist.length) return liveBars;
  if (!Array.isArray(liveBars) || !liveBars.length) return hist.slice();
  const liveTimes = new Set(liveBars.map(b => b.t));
  const filteredHist = hist.filter(b => !liveTimes.has(b.t));
  return [...filteredHist, ...liveBars];
}

function isReady() { return _ready; }
function clear() { _cache.clear(); _ready = false; _warmupStartedAt = null; }

function getStatus() {
  const perTicker = {};
  for (const [t, bars] of _cache.entries()) perTicker[t] = bars.length;
  return {
    ready: _ready,
    startedAt: _warmupStartedAt,
    tickers: _cache.size,
    barsPerTicker: perTicker,
  };
}

module.exports = { warmup, getBars, mergeWithLive, isReady, clear, getStatus };
