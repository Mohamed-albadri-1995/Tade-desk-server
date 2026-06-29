const db = require('../db');
const { toETTime } = require('../utils/time');

const BASE = 'https://data.alpaca.markets/v2/stocks';

function getCredentials() {
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('alpacaApiKey','alpacaApiSecret')").all();
  const creds = {};
  for (const r of rows) creds[r.key] = r.value;
  if (!creds.alpacaApiKey || !creds.alpacaApiSecret) {
    throw new Error('Alpaca credentials not set — add them in Settings > API Keys');
  }
  return { key: creds.alpacaApiKey, secret: creds.alpacaApiSecret };
}

function authHeaders() {
  const { key, secret } = getCredentials();
  return {
    'APCA-API-KEY-ID': key,
    'APCA-API-SECRET-KEY': secret,
    'Content-Type': 'application/json',
  };
}

// Fetch all pages for a bars request, returns { TICKER: [{t,o,h,l,c,v}] }
async function fetchAllPages(url, params) {
  const result = {};
  let pageToken = null;

  do {
    const qs = new URLSearchParams(params);
    if (pageToken) qs.set('page_token', pageToken);
    const res = await fetch(`${url}?${qs}`, { headers: authHeaders() });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Alpaca API error ${res.status}: ${body}`);
    }
    const data = await res.json();
    for (const [ticker, bars] of Object.entries(data.bars || {})) {
      if (!result[ticker]) result[ticker] = [];
      result[ticker].push(...bars);
    }
    pageToken = data.next_page_token || null;
  } while (pageToken);

  return result;
}

// Fetch 1-min intraday bars for date (ET date string e.g. '2024-01-15')
// Returns { TICKER: [{t, o, h, l, c, v, etTime}] } where etTime is 'HH:MM'
async function fetchIntradayBars(tickers, date) {
  const raw = await fetchAllPages(`${BASE}/bars`, {
    symbols: tickers.join(','),
    timeframe: '1Min',
    start: `${date}T09:30:00-05:00`,
    end: `${date}T16:00:00-05:00`,
    limit: 10000,
    adjustment: 'raw',
    feed: 'iex',
  });

  // Annotate each bar with its ET time string for easy lookup
  const out = {};
  for (const [ticker, bars] of Object.entries(raw)) {
    out[ticker] = bars.map(b => ({
      ...b,
      etTime: toETTime(new Date(b.t).getTime()),
    }));
  }
  return out;
}

// Fetch daily bars for tickers, strictly before beforeDate (ET date string)
// Returns { TICKER: [{t, o, h, l, c}] } — up to 20 calendar days back (guarantees 14+ trading days)
async function fetchDailyBars(tickers, beforeDate) {
  // Go back 30 calendar days to be safe across holidays
  const endDate = new Date(`${beforeDate}T00:00:00-05:00`);
  endDate.setDate(endDate.getDate() - 1); // day before
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 29);

  const fmt = d => d.toISOString().slice(0, 10);

  return fetchAllPages(`${BASE}/bars`, {
    symbols: tickers.join(','),
    timeframe: '1Day',
    start: fmt(startDate),
    end: fmt(endDate),
    limit: 1000,
    adjustment: 'raw',
    feed: 'iex',
  });
}

// Compute ATR14 from an array of daily bars (at least 15 bars needed for 14 TRs)
function computeATR14(bars) {
  if (!bars || bars.length < 2) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      cur.h - cur.l,
      Math.abs(cur.h - prev.c),
      Math.abs(cur.l - prev.c)
    );
    trs.push(tr);
  }
  // Take the last 14 TRs
  const last14 = trs.slice(-14);
  if (last14.length < 14) return null;
  return last14.reduce((a, b) => a + b, 0) / 14;
}

module.exports = { fetchIntradayBars, fetchDailyBars, computeATR14 };
