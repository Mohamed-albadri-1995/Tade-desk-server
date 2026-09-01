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
 * THREE SOURCES, TRIED IN ORDER — and the order was earned by measurement,
 * not by guessing. Every one failed on the first attempt and none could say
 * why, so each now records its own reason. What that showed, from the box
 * that actually runs this:
 *
 *   yahoo   401, and the CRUMB step itself failed
 *   nasdaq  answered, but not with the shape that was assumed
 *   finra   nothing — the path being tried serves OTC names only
 *
 *   1. FINRA's own published file. It is the source every other one
 *      redistributes, needs no key and no cookie dance, and is ONE FILE
 *      COVERING EVERY SYMBOL — so filling a register of 150 names costs one
 *      request rather than 150. It gives SHARES short; the percentage needs
 *      a float, which the scanner supplies on every row.
 *   2. Yahoo quoteSummary, per symbol, for names FINRA's file does not carry.
 *      It computes the share of float itself. Needs a cookie and a crumb.
 *   3. Nasdaq, per symbol, free and no key, with the two-week history.
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
// FINRA PUBLISHES MORE THAN ONE FILE, and the first pattern tried was the
// OTC one — which is why 25 days of walking back found nothing for GME, a
// listed stock. The consolidated file covering listed names is served from a
// different path, and FINRA has moved these before, so the known patterns are
// tried in turn and the one that answers is reported.
const FINRA_URLS = [
  'https://cdn.finra.org/equity/regsho/monthly/shrt{ymd}.txt',
  'https://cdn.finra.org/equity/otcmarket/biweekly/shrt{ymd}.txt',
  'https://cdn.finra.org/equity/otcmarket/biweekly/shrt{ymd}.csv',
];
const FINRA_URL = FINRA_URLS[0];

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

/*
 * YAHOO NOW REQUIRES A COOKIE AND A CRUMB.
 *
 * A bare quoteSummary request returns 401 "Invalid Cookie" — which is why the
 * first version of this got nothing from either source and could not say so.
 * The handshake is three steps and is stable:
 *
 *   1. GET fc.yahoo.com — it sets the consent cookie and returns an error
 *      page, which is fine; the cookie is the point.
 *   2. GET /v1/test/getcrumb with that cookie — returns a short token.
 *   3. Send both on the real request.
 *
 * Cached for the process: the crumb is tied to the cookie and both last for
 * hours, so re-doing the dance per symbol would triple every lookup.
 */
let _yf = { cookie: null, crumb: null, at: 0 };

async function yahooCrumb() {
  const AGE = 6 * 3600 * 1000;
  if (_yf.crumb && Date.now() - _yf.at < AGE) return _yf;
  let cookie = null;
  const notes = [];
  for (const url of ['https://fc.yahoo.com/', 'https://finance.yahoo.com/']) {
    try {
      const r = await axios.get(url, {
        headers: { ...YF_HEADERS, Accept: 'text/html,application/xhtml+xml' },
        timeout: 10000, validateStatus: () => true, maxRedirects: 0,
      });
      const set = r.headers?.['set-cookie'];
      if (set && set.length) {
        cookie = set.map(c => c.split(';')[0]).join('; ');
        notes.push(`cookie from ${url} (${r.status})`);
        break;
      }
      notes.push(`${url} ${r.status} no set-cookie`);
    } catch (e) { notes.push(`${url} ${String(e.message).slice(0, 40)}`); }
  }
  try {
    const r = await axios.get('https://fc.yahoo.com/', {
      headers: YF_HEADERS, timeout: 10000,
      // It answers 404 and that is expected — the Set-Cookie header is what
      // is being collected, so a non-2xx must not throw here.
      validateStatus: () => true,
      maxRedirects: 0,
    });
    void r;
  } catch { /* the loop above already has whatever cookie is available */ }
  let crumb = null;
  try {
    const r = await axios.get(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      { headers: { ...YF_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
        timeout: 10000, responseType: 'text' });
    if (typeof r.data === 'string' && r.data.length && r.data.length < 64) {
      crumb = r.data.trim();
    } else {
      notes.push(`getcrumb returned ${typeof r.data} len=${String(r.data || '').length}`);
    }
  } catch (e) {
    notes.push(`getcrumb ${e.response?.status || ''} ${String(e.message).slice(0, 40)}`);
  }
  _yf = { cookie, crumb, at: Date.now(), notes };
  return _yf;
}

async function fetchYahoo(ticker, diag) {
  const { cookie, crumb, notes } = await yahooCrumb();
  if (diag && notes) diag.yahooHandshake = notes.join(' | ');
  for (const host of YF_HOSTS) {
    try {
      const r = await axios.get(
        `https://${host}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}`,
        { headers: { ...YF_HEADERS, ...(cookie ? { Cookie: cookie } : {}) },
          params: { modules: 'defaultKeyStatistics', ...(crumb ? { crumb } : {}) },
          timeout: 12000 });
      const rec = parseYahoo(r.data);
      if (rec) return rec;
      if (diag) diag.yahoo = `answered but no defaultKeyStatistics`;
    } catch (e) {
      if (diag) {
        diag.yahoo = `${e.response?.status || ''} ${String(e.message).slice(0, 80)}`
          + (crumb ? ' (crumb obtained)' : ' (NO crumb)');
      }
    }
  }
  return null;
}

/*
 * NASDAQ, the third source. Free, no key, and it serves short interest per
 * symbol as a small JSON document — the two-week history included, which is
 * the direction O'Neil's reading wants. It refuses a request that does not
 * look like a browser, hence the headers.
 */
function parseNasdaq(payload) {
  const rows = payload?.data?.shortInterestTable?.rows;
  if (!Array.isArray(rows) || !rows.length) return null;
  const n = v => {
    const x = Number(String(v == null ? '' : v).replace(/[$,%\s]/g, ''));
    return Number.isFinite(x) ? x : null;
  };
  const cur = rows[0];
  const prev = rows[1];
  const shares = n(cur.interest);
  if (shares == null) return null;
  const prior = prev ? n(prev.interest) : null;
  return {
    shortFloat: null,               // shares only — the caller supplies a float
    sharesShort: shares,
    sharesShortPrior: prior,
    trend: prior == null ? null
      : shares > prior ? 'rising' : shares < prior ? 'falling' : 'flat',
    daysToCover: n(cur.daysToCover),
    asOf: String(cur.settlementDate || '').trim() || null,
    basis: 'shares',
    src: 'nasdaq',
  };
}

async function fetchNasdaq(ticker, diag) {
  try {
    const r = await axios.get(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/short-interest`,
      { headers: { ...YF_HEADERS, Origin: 'https://www.nasdaq.com',
                   Referer: 'https://www.nasdaq.com/' },
        params: { assetclass: 'stocks' }, timeout: 12000 });
    const rec = parseNasdaq(r.data);
    if (rec) return rec;
    if (diag) {
      // IT ANSWERED. So the endpoint is reachable and the shape is wrong,
      // which is a different problem from being blocked — and one that cannot
      // be fixed by guessing at the path a second time.
      diag.nasdaq = 'answered but no shortInterestTable';
      diag.nasdawRaw = JSON.stringify(r.data).slice(0, 400);
    }
  } catch (e) {
    if (diag) diag.nasdaq = `${e.response?.status || ''} ${String(e.message).slice(0, 80)}`;
  }
  return null;
}

let _finraFile = { day: null, text: null };

async function fetchFinraFile(diag) {
  const day = _etDay();
  if (_finraFile.day === day) return _finraFile.text;
  // Walk back from today to the last published file. FINRA publishes on a
  // settlement schedule, not a fixed weekday, so the date is found by asking
  // rather than by computing one and hoping.
  const d = new Date();
  for (let back = 0; back < 25; back++) {
    const t = new Date(d.getTime() - back * 86400000);
    const ymd = t.toISOString().slice(0, 10).replace(/-/g, '');
    for (const pat of FINRA_URLS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await axios.get(pat.replace('{ymd}', ymd), {
          timeout: 20000, responseType: 'text', headers: YF_HEADERS,
        });
        if (typeof r.data === 'string' && r.data.includes('|')) {
          if (diag) diag.finraUrl = pat.replace('{ymd}', ymd);
          _finraFile = { day, text: r.data };
          return r.data;
        }
      } catch { /* not this file, not this day — keep going */ }
    }
  }
  if (diag) diag.finra = 'no published file found in the last 25 days';
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
  // A CACHED FAILURE IS NOT CACHED. A successful answer holds for the day —
  // the number only changes twice a month — but caching a miss would mean a
  // source that came back five minutes later still reported nothing until
  // tomorrow, and would make the probe useless for debugging.
  if (hit && hit.day === day && hit.rec) return hit.rec;
  const diag = ctx.diag || {};
  let rec = null;
  try {
    // FINRA FIRST, and by a distance. It is the source every other one
    // redistributes, it needs no key and no cookie dance, and above all it is
    // ONE FILE COVERING EVERY SYMBOL — cached for the day, so filling 150
    // rows costs one request instead of 150.
    //
    // It was third when this was written, on the assumption that a
    // ready-made percentage was worth more than the raw shares. That cost
    // every symbol a Yahoo 401 and a Nasdaq miss before reaching the only
    // source that answered: 300 wasted requests on a register day.
    const text = await fetchFinraFile(diag);
    if (text) {
      rec = parseFinra(text, t);
      if (!rec && diag) diag.finra = 'file fetched, symbol not in it';
    }
    // The per-symbol sources are the fallback now — for names FINRA's file
    // does not carry, and for the share-of-float Yahoo computes for us.
    if (!rec) rec = await fetchYahoo(t, diag);
    if (!rec) rec = await fetchNasdaq(t, diag);
    rec = toPercent(rec, ctx);
  } catch (e) { diag.error = String(e.message).slice(0, 120); rec = null; }
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
  parseYahoo, parseFinra, parseNasdaq, toPercent, lookup, fill, FINRA_URL,
};
