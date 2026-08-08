/*
 * Polygon 1-minute bars.
 *
 * WHY THIS EXISTS when Yahoo and Alpaca are already wired in.
 *
 * The T2 setup's numbers were derived on Polygon — it is the quant platform's
 * default feed, and the reference trade log in setup_spec.md was produced
 * through it. Verifying the JavaScript implementation against Yahoo bars gave
 * every direction correct and six of eight entry prices correct to the cent,
 * while the extensions differed by up to 2.4 percentage points. That is not an
 * arithmetic difference — the VWAP formula here is identical to the platform's,
 * HLC/3 accumulated from 09:30 — it is a VOLUME difference between feeds.
 *
 * And extension is the ranking metric. A feed that shifts it shifts which two
 * names get traded, so matching the feed the setup was designed on is not
 * fastidiousness, it is the difference between running the tested setup and
 * running one that resembles it.
 *
 * THE FREE TIER MAY NOT BE ABLE TO DO THIS LIVE. Polygon's free plan serves
 * end-of-day aggregates; asking at 10:00 for bars from 09:30 today can come
 * back empty or stale, in which case the setup has to fall back and say so.
 * `probe()` answers that question directly rather than leaving it to be
 * discovered on a Monday morning.
 */

const axios = require('axios');
const { getKey } = require('../sharedKeys');
const { toETTime, toETDate } = require('../utils/time');

const BASE = 'https://api.polygon.io';

function apiKey() {
  return getKey('polygonApiKey', 'POLYGON_API_KEY');
}

function hasKey() {
  return Boolean(apiKey());
}

/**
 * 1-minute bars for one ticker on one ET date, regular session only.
 *
 * Polygon returns unadjusted aggregates covering extended hours; the session
 * filter is applied here so the VWAP anchors at 09:30 exactly as the spec
 * requires, rather than depending on a query parameter.
 */
async function fetchTickerIntraday(ticker, date) {
  const key = apiKey();
  if (!key) throw new Error('no Polygon API key');

  const url = `${BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/minute/${date}/${date}`;
  const res = await axios.get(url, {
    params: { adjusted: 'false', sort: 'asc', limit: 50000, apiKey: key },
    timeout: 20000,
  });

  const results = res.data && res.data.results;
  if (!Array.isArray(results)) return [];

  return results
    .map(b => ({
      t: new Date(b.t).toISOString(),
      o: b.o ?? null, h: b.h ?? null, l: b.l ?? null, c: b.c ?? null,
      v: b.v ?? null,
      etDate: toETDate(b.t),
      etTime: toETTime(b.t),
    }))
    // The same window every other source is trimmed to. Extended-hours bars
    // would put pre-market volume into a VWAP that must anchor at the open.
    .filter(b => b.etDate === date && b.etTime >= '09:30' && b.etTime < '16:00'
      && b.o !== null && b.h !== null && b.l !== null && b.c !== null);
}

/**
 * Several tickers. Sequential with a pause: the free tier allows five calls a
 * minute and answers 429 past that, so a universe of forty names cannot be
 * fetched from it at all — which `probe` reports rather than discovering here
 * one 429 at a time.
 */
async function fetchIntradayBars(tickers, date, { delayMs = 120 } = {}) {
  const out = {};
  for (const ticker of tickers) {
    try {
      out[ticker] = await fetchTickerIntraday(ticker, date);
    } catch (err) {
      const status = err.response && err.response.status;
      // 429 is rate limiting and will apply to everything after it too, so
      // there is nothing to gain by continuing to ask.
      if (status === 429) {
        console.warn('[Polygon] rate limited — stopping this pass');
        break;
      }
      console.warn(`[Polygon] ${ticker} failed: ${err.message}`);
      out[ticker] = [];
    }
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}

/**
 * Can this key serve TODAY's intraday bars, right now?
 *
 * The one question that decides whether the setup can run live on the feed it
 * was designed on. Answered with a real request for a liquid name rather than
 * by reading a plan description.
 */
async function probe(date, ticker = 'AAPL') {
  if (!hasKey()) return { ok: false, reason: 'no Polygon API key configured' };
  try {
    const bars = await fetchTickerIntraday(ticker, date);
    if (!bars.length) {
      return { ok: false, reason: `no bars returned for ${ticker} on ${date}`, bars: 0 };
    }
    return {
      ok: true, bars: bars.length,
      first: bars[0].etTime,
      last: bars[bars.length - 1].etTime,
    };
  } catch (err) {
    const status = err.response && err.response.status;
    return {
      ok: false,
      reason: status === 403 ? 'key rejected for this data (plan does not cover it)'
        : status === 429 ? 'rate limited'
        : err.message,
      status: status || null,
    };
  }
}

module.exports = { fetchIntradayBars, fetchTickerIntraday, probe, hasKey };
