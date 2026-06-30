const axios = require('axios');
const { toETTime, toETDate } = require('../utils/time');

// Try query1 first, fall back to query2 (mirrors what the extension does)
const YF_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DELAY_MS = 150;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch raw chart result from Yahoo Finance v8, trying both hosts
async function fetchChart(ticker, params) {
  let lastErr;
  for (const host of YF_HOSTS) {
    try {
      const resp = await axios.get(`https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}`, {
        headers: YF_HEADERS,
        params,
        timeout: 15000,
      });
      const result = resp.data?.chart?.result?.[0];
      if (result) return result;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`No chart data for ${ticker}`);
}

// Fetch 1-min intraday bars for a single ticker on a specific ET date.
// Uses range=5d so Yahoo returns recent trading days without timezone-sensitive period1/period2.
// We then filter to only the bars for the requested date.
// Returns [{t, o, h, l, c, v, etTime}]
async function fetchTickerIntraday(ticker, date) {
  const result = await fetchChart(ticker, {
    interval: '1m',
    range: '5d',
    includePrePost: false,
  });

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps
    .map((t, i) => {
      const etDate = toETDate(t * 1000);
      const etTime = toETTime(t * 1000);
      return {
        t:      new Date(t * 1000).toISOString(),
        o:      q.open?.[i]   ?? null,
        h:      q.high?.[i]   ?? null,
        l:      q.low?.[i]    ?? null,
        c:      q.close?.[i]  ?? null,
        v:      q.volume?.[i] ?? null,
        etDate,
        etTime,
      };
    })
    .filter(b => b.etDate === date && b.o !== null && b.h !== null && b.l !== null);
}

// Fetch daily bars for a single ticker, for days strictly before beforeDate.
// Uses range=3mo so Yahoo returns ~63 trading days without exact timestamp math.
// Returns [{t, o, h, l, c}]
async function fetchTickerDaily(ticker, beforeDate) {
  const result = await fetchChart(ticker, {
    interval: '1d',
    range: '3mo',
    includePrePost: false,
  });

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps
    .map((t, i) => ({
      t: new Date(t * 1000).toISOString(),
      o: q.open?.[i]  ?? null,
      h: q.high?.[i]  ?? null,
      l: q.low?.[i]   ?? null,
      c: q.close?.[i] ?? null,
    }))
    .filter(b => b.c !== null && toETDate(new Date(b.t).getTime()) < beforeDate);
}

// Fetch intraday 1-min bars for multiple tickers sequentially.
// Returns { TICKER: [{t, o, h, l, c, v, etTime}] }
async function fetchIntradayBars(tickers, date) {
  const out = {};
  for (const ticker of tickers) {
    try {
      out[ticker] = await fetchTickerIntraday(ticker, date);
    } catch (e) {
      console.warn(`[Yahoo] Intraday fetch failed for ${ticker}: ${e.message}`);
      out[ticker] = [];
    }
    await sleep(DELAY_MS);
  }
  return out;
}

// Fetch daily bars for multiple tickers sequentially.
// Returns { TICKER: [{t, o, h, l, c}] }
async function fetchDailyBars(tickers, beforeDate) {
  const out = {};
  for (const ticker of tickers) {
    try {
      out[ticker] = await fetchTickerDaily(ticker, beforeDate);
    } catch (e) {
      console.warn(`[Yahoo] Daily fetch failed for ${ticker}: ${e.message}`);
      out[ticker] = [];
    }
    await sleep(DELAY_MS);
  }
  return out;
}

// Compute ATR14 from daily bars array [{h, l, c}]
function computeATR14(bars) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const cur  = bars[i];
    const prev = bars[i - 1];
    trs.push(Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    ));
  }
  const last14 = trs.slice(-14);
  if (last14.length < 14) return null;
  return last14.reduce((a, b) => a + b, 0) / 14;
}

module.exports = { fetchIntradayBars, fetchDailyBars, computeATR14 };
