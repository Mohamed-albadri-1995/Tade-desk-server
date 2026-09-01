/*
 * Short interest — the one field on the card that has never had a value.
 *
 * WHY IT WAS EMPTY. It came from TradingView's `short_percentage_of_float`
 * column, and that column returns nothing for every name: seven column names
 * were probed against seven stocks including GME and every one came back
 * empty. Not missing data for one stock — a field the scanner does not serve.
 *
 * It is not a cosmetic gap. `technical.js` has a Squeeze Setup signal gated on
 * `shortFloat >= threshold`, so that signal has never been able to fire once.
 *
 * WHERE THE NUMBER ACTUALLY COMES FROM. Every US short interest figure
 * originates in one place: FINRA. Broker-dealers report their short positions
 * twice a month, FINRA consolidates and publishes, and every vendor
 * redistributes that same file. So there is no question of which source is
 * "right" — only which one is reachable, and how it is denominated.
 *
 * TWO SOURCES, TRIED IN ORDER, because neither can be verified from a
 * development machine and both have failed for others before:
 *
 *   1. Yahoo quoteSummary. Gives shares short AND the percentage of float
 *      already computed, plus the prior month for a direction. It is the
 *      same FINRA data, and this repo already talks to Yahoo with working
 *      headers. Its risk is the cookie/crumb wall it puts up periodically.
 *   2. FINRA's own published file. Authoritative and needs no key, but gives
 *      SHARES short — a percentage needs a float, which the scanner does
 *      supply on every row.
 *
 * WHAT IS NEVER DONE. Short % of float and short % of shares OUTSTANDING are
 * different numbers, and outstanding is always the larger denominator, so
 * quoting one as the other understates the squeeze every time. Where only
 * outstanding is available the field says so rather than being labelled float.
 */

const axios = require('axios');

// The same headers the chart client uses. Yahoo refuses a bare request.
const YF_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// FINRA publishes twice a month. The file is small and covers every symbol, so
// one download serves the whole register rather than a request per ticker.
const FINRA_URL = 'https://cdn.finra.org/equity/otcmarket/biweekly/shrt{ymd}.txt';

const num = v => (v == null || v === '' || Number.isNaN(Number(v))
  ? null : Number(v));

/**
 * Yahoo's quoteSummary → the fields we keep. PURE.
 *
 * Yahoo wraps every number as {raw, fmt}. Reading `.fmt` would give a string
 * like "12.34%" that looks like a number until something does arithmetic on
 * it, so only `raw` is taken.
 */
function parseYahoo(payload) {
  const r = payload?.quoteSummary?.result?.[0];
  const k = r?.defaultKeyStatistics;
  if (!k) return null;
  const pct = num(k.shortPercentOfFloat?.raw);
  const shares = num(k.sharesShort?.raw);
  const prior = num(k.sharesShortPriorMonth?.raw);
  if (pct == null && shares == null) return null;
  return {
    // Yahoo gives the share of float as a FRACTION (0.1234), and the card
    // prints a percentage. Multiplying at the edge rather than in the render
    // keeps one representation in the system.
    shortFloat: pct == null ? null : Math.round(pct * 1000) / 10,
    sharesShort: shares,
    sharesShortPrior: prior,
    // Direction over the last report, which is what a rising short base is.
    trend: (shares != null && prior != null)
      ? (shares > prior ? 'rising' : shares < prior ? 'falling' : 'flat')
      : null,
    daysToCover: num(k.shortRatio?.raw),
    asOf: k.dateShortInterest?.raw
      ? new Date(k.dateShortInterest.raw * 1000).toISOString().slice(0, 10)
      : null,
    basis: 'float',
    src: 'yahoo',
  };
}

/**
 * FINRA's biweekly consolidated file → one symbol's row. PURE.
 *
 * Pipe-delimited with a header. Column names have changed over the years, so
 * they are looked up rather than indexed by position — a positional read
 * silently returns the wrong column the first time FINRA inserts a field.
 */
function parseFinra(text, symbol) {
  const lines = String(text || '').split('\n');
  if (lines.length < 2) return null;
  const head = lines[0].split('|').map(h => h.trim().toLowerCase());
  const find = (...names) => {
    for (const n of names) {
      const i = head.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const iSym = find('symbolcode', 'symbol', 'issuesymbolidentifier');
  const iShort = find('currentshortpositionquantity', 'currentshortposition',
                      'currentshares');
  const iDate = find('settlementdate', 'settlementdesignator');
  const iAdv = find('averagedailyvolumequantity', 'averagedailyvolume');
  if (iSym < 0 || iShort < 0) return null;
  const want = String(symbol || '').toUpperCase();
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split('|');
    if (p.length <= iSym) continue;
    if (p[iSym].trim().toUpperCase() !== want) continue;
    const shares = num(p[iShort]);
    if (shares == null) continue;
    const adv = iAdv >= 0 ? num(p[iAdv]) : null;
    return {
      shortFloat: null,          // needs a float — the caller supplies it
      sharesShort: shares,
      sharesShortPrior: null,
      trend: null,
      daysToCover: adv ? Math.round((shares / adv) * 100) / 100 : null,
      asOf: iDate >= 0 && p.length > iDate ? p[iDate].trim() : null,
      basis: 'shares',
      src: 'finra',
    };
  }
  return null;
}

/**
 * Turn shares short into a percentage, and SAY WHICH DENOMINATOR.
 *
 * Float and shares outstanding are different numbers and outstanding is always
 * the larger, so quoting one as the other understates a squeeze every time.
 * The basis travels with the value so the card can label it.
 */
function toPercent(rec, { floatShares, sharesOutstanding } = {}) {
  if (!rec) return null;
  if (rec.shortFloat != null) return rec;
  const denom = floatShares || sharesOutstanding;
  if (!denom) return rec;
  return {
    ...rec,
    shortFloat: Math.round((rec.sharesShort / denom) * 1000) / 10,
    basis: floatShares ? 'float' : 'outstanding',
  };
}

/* ── the network half ────────────────────────────────────────────────── */

// Short interest is published TWICE A MONTH. Caching for a day is not a
// compromise — the number cannot change more often than that, and a register
// day is 150 names re-rendered constantly.
const _cache = new Map();                     // TICKER -> { day, rec }

function _etDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function fetchYahoo(ticker) {
  for (const host of YF_HOSTS) {
    try {
      const r = await axios.get(
        `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`,
        { headers: YF_HEADERS, params: { modules: 'defaultKeyStatistics' },
          timeout: 12000 });
      const rec = parseYahoo(r.data);
      if (rec) return rec;
    } catch { /* try the other host, then fall through to FINRA */ }
  }
  return null;
}

let _finraFile = { day: null, text: null };

async function fetchFinraFile() {
  const day = _etDay();
  if (_finraFile.day === day) return _finraFile.text;
  // Walk back from today to the last published file. FINRA publishes on a
  // settlement schedule, not a fixed weekday, so the date is found by asking
  // rather than by computing one and hoping.
  const d = new Date();
  for (let back = 0; back < 25; back++) {
    const t = new Date(d.getTime() - back * 86400000);
    const ymd = t.toISOString().slice(0, 10).replace(/-/g, '');
    try {
      const r = await axios.get(FINRA_URL.replace('{ymd}', ymd), {
        timeout: 20000, responseType: 'text',
      });
      if (typeof r.data === 'string' && r.data.includes('|')) {
        _finraFile = { day, text: r.data };
        return r.data;
      }
    } catch { /* not published that day — keep walking back */ }
  }
  _finraFile = { day, text: null };
  return null;
}

/**
 * One ticker's short interest. Yahoo first, FINRA second, null if neither.
 * NEVER throws: a missing short interest costs a field, not a scan.
 */
async function lookup(ticker, ctx = {}) {
  const t = String(ticker || '').toUpperCase();
  if (!t) return null;
  const day = _etDay();
  const hit = _cache.get(t);
  if (hit && hit.day === day) return hit.rec;
  let rec = null;
  try {
    rec = await fetchYahoo(t);
    if (!rec) {
      const text = await fetchFinraFile();
      if (text) rec = parseFinra(text, t);
    }
    rec = toPercent(rec, ctx);
  } catch { rec = null; }
  _cache.set(t, { day, rec });
  return rec;
}

/**
 * Fill `shortFloat` on r0 rows that do not have one.
 *
 * Only the empty ones: if the scanner ever starts serving the column, its
 * value wins and nothing here fires. Bounded concurrency because this is a
 * per-symbol lookup and a register day is 150 of them.
 */
async function fill(rows, { concurrency = 4 } = {}) {
  const want = (rows || []).filter(r => r && r.stock
    && r.stock.shortFloat == null && r.ticker);
  let filled = 0;
  for (let i = 0; i < want.length; i += concurrency) {
    const batch = want.slice(i, i + concurrency);
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(batch.map(async (row) => {
      const rec = await lookup(row.ticker, {
        floatShares: row.stock.floatShares,
        sharesOutstanding: row.stock.sharesOutstanding,
      });
      if (!rec || rec.shortFloat == null) return;
      row.stock.shortFloat = rec.shortFloat;
      row.stock.shortBasis = rec.basis;
      row.stock.shortAsOf = rec.asOf;
      row.stock.shortSrc = rec.src;
      row.stock.shortTrend = rec.trend;
      row.stock.daysToCover = rec.daysToCover;
      filled += 1;
    }));
  }
  return { checked: want.length, filled };
}

module.exports = {
  parseYahoo, parseFinra, toPercent, lookup, fill, FINRA_URL,
};
