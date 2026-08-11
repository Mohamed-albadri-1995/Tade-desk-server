#!/usr/bin/env node
/*
 * Is High.5D / Low.5D actually a five-day window?
 *
 * A card came back with the weekly bar reading L 72.98 H 80.17 and the monthly
 * bar reading L 72.98 H 80.17 — the same numbers, on a chart that plainly had a
 * wider month than week. So the weekly pair is either not a five-day window at
 * all, or it is not being read from where we think.
 *
 * The earlier probe (probe-range-fields.js) asked only "does TradingView accept
 * this column name", and High.5D answered, so it was taken. That was the wrong
 * question by one step. A name can be accepted and still return something other
 * than what it says on the tin — which is exactly the failure that reached the
 * card, because an accepted-but-wrong column produces confident numbers rather
 * than a blank.
 *
 * This asks the question that matters: across several stocks, does the weekly
 * candidate ever differ from the monthly one?
 *
 *   node scripts/probe-week-range.js
 *
 * Run it on the server — it needs to reach scanner.tradingview.com.
 *
 * HOW TO READ IT. For a single stock, a five-day high EQUAL to the one-month
 * high is perfectly normal: it means the stock made its monthly high this week.
 * That is why several stocks are used, deliberately mixed between ones near
 * their highs and ones well off them. If a candidate matches the month on
 * EVERY stock, it is not a five-day window — one identical pair is a
 * coincidence, eight is a definition.
 */

const axios = require('axios');

const URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';
const HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Origin: 'https://www.tradingview.com',
  Referer: 'https://www.tradingview.com/',
  Accept: 'application/json',
};

// Liquid, and deliberately not all doing the same thing — a list of stocks all
// at fresh highs would make every candidate look identical to the month for an
// honest reason.
const TICKERS = ['NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:ZTS', 'NYSE:KO', 'NASDAQ:INTC',
  'NYSE:PFE', 'NASDAQ:TSLA', 'NYSE:XOM'];

// Each candidate pair, plus the month as the thing to compare against.
const CANDIDATES = [
  ['High.5D', 'Low.5D'],
  ['High.1W', 'Low.1W'],
  ['High.W', 'Low.W'],
  ['high|1W', 'low|1W'],
];
const REFERENCE = ['High.1M', 'Low.1M'];

async function fetchCols(columns) {
  const body = {
    columns,
    symbols: { tickers: TICKERS },
    range: [0, TICKERS.length],
    markets: ['america'],
    options: { lang: 'en' },
    // FALSE on purpose. The scanner runs with this true, which is what let a
    // bad name through silently in the first place; here we want to be told.
    ignore_unknown_fields: false,
  };
  const r = await axios.post(URL, body, { headers: HEADERS, timeout: 15000 });
  return (r.data.data || []).map(row => ({ ticker: row.s, values: row.d }));
}

const fmt = v => (v === null || v === undefined ? '     —' : Number(v).toFixed(2).padStart(6));

(async () => {
  console.log('WEEKLY RANGE — is the candidate a five-day window, or the month again?\n');

  let ref;
  try {
    ref = await fetchCols([...REFERENCE, 'close']);
  } catch (err) {
    console.error('Could not reach TradingView:', err.response?.status || err.message);
    console.error('Run this on the server, not from a sandbox.');
    process.exit(1);
  }
  const byTicker = new Map(ref.map(r => [r.ticker, { mh: r.values[0], ml: r.values[1], px: r.values[2] }]));

  console.log('  reference — the one-month window we already trust');
  for (const [t, v] of byTicker) {
    console.log(`    ${t.padEnd(14)} low ${fmt(v.ml)}   high ${fmt(v.mh)}   price ${fmt(v.px)}`);
  }

  for (const [hi, lo] of CANDIDATES) {
    console.log(`\n  ${hi} / ${lo}`);
    let rows;
    try {
      rows = await fetchCols([hi, lo]);
    } catch (err) {
      const detail = err.response?.data;
      console.log(`    REJECTED by TradingView — ${typeof detail === 'string' ? detail.slice(0, 120)
        : err.response?.status || err.message}`);
      console.log('    (not a real column name; the live scanner would drop it silently)');
      continue;
    }

    let same = 0, differ = 0, empty = 0;
    for (const r of rows) {
      const m = byTicker.get(r.ticker) || {};
      const [h, l] = r.values;
      const blank = h === null && l === null;
      const identical = !blank && h === m.mh && l === m.ml;
      if (blank) empty++; else if (identical) same++; else differ++;
      console.log(`    ${r.ticker.padEnd(14)} low ${fmt(l)}   high ${fmt(h)}   `
        + (blank ? 'EMPTY' : identical ? 'same as month' : 'differs from month'));
    }

    // The verdict, stated rather than left to be inferred from the rows.
    if (empty === rows.length) {
      console.log('    → accepted but always empty. Unusable.');
    } else if (same === rows.length) {
      console.log('    → identical to the one-month window on every stock. This is NOT a');
      console.log('      five-day range, whatever the name suggests. Do not use it.');
    } else if (differ > 0) {
      console.log(`    → differs from the month on ${differ}/${rows.length}. This behaves like a real`);
      console.log('      shorter window — the candidate to use.');
    }
  }

  console.log('\nWhichever pair differs from the month is the one to put in COMMON_COLUMNS.');
  console.log('If none of them does, the weekly bar cannot be sourced from the screener API');
  console.log('and should be removed from the card rather than shown wrong.\n');
})();
