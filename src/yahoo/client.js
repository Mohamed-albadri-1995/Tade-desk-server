const axios = require('axios');
const { toETTime } = require('../utils/time');

const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'en-US,en;q=0.9',
};

const DELAY_MS = 120; // between per-ticker requests to avoid rate limiting

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Fetch raw chart data for one ticker from Yahoo Finance v8 chart API
async function fetchChart(ticker, interval, period1, period2) {
  const resp = await axios.get(`${YF_BASE}/${ticker}`, {
    headers: YF_HEADERS,
    params: { interval, period1, period2 },
    timeout: 15000,
  });
  const result = resp.data?.chart?.result?.[0];
  if (!result) return null;
  return result;
}

// Fetch 1-min intraday bars for a single ticker on given ET date string (e.g. '2024-01-15')
// Returns [{t, o, h, l, c, v, etTime}]
async function fetchTickerIntraday(ticker, date) {
  const start = Math.floor(new Date(`${date}T09:30:00-05:00`).getTime() / 1000);
  const end   = Math.floor(new Date(`${date}T16:00:00-05:00`).getTime() / 1000);

  const result = await fetchChart(ticker, '1m', start, end);
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps.map((t, i) => ({
    t: new Date(t * 1000).toISOString(),
    o: q.open?.[i]   ?? null,
    h: q.high?.[i]   ?? null,
    l: q.low?.[i]    ?? null,
    c: q.close?.[i]  ?? null,
    v: q.volume?.[i] ?? null,
    etTime: toETTime(t * 1000),
  })).filter(b => b.o !== null && b.h !== null && b.l !== null);
}

// Fetch daily bars for a single ticker, strictly before beforeDate (ET date string)
// Returns [{t, o, h, l, c}] — up to 30 calendar days back
async function fetchTickerDaily(ticker, beforeDate) {
  // End = day before beforeDate; Start = 30 calendar days before that
  const endDate = new Date(`${beforeDate}T00:00:00-05:00`);
  endDate.setDate(endDate.getDate() - 1);
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 29);

  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(endDate.getTime() / 1000) + 86400; // include end day

  const result = await fetchChart(ticker, '1d', period1, period2);
  if (!result) return [];

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps.map((t, i) => ({
    t: new Date(t * 1000).toISOString(),
    o: q.open?.[i]  ?? null,
    h: q.high?.[i]  ?? null,
    l: q.low?.[i]   ?? null,
    c: q.close?.[i] ?? null,
  })).filter(b => b.c !== null);
}

// Fetch intraday 1-min bars for multiple tickers (sequential with delay)
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

// Fetch daily bars for multiple tickers (sequential with delay)
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
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    trs.push(tr);
  }
  const last14 = trs.slice(-14);
  if (last14.length < 14) return null;
  return last14.reduce((a, b) => a + b, 0) / 14;
}

module.exports = { fetchIntradayBars, fetchDailyBars, computeATR14 };
