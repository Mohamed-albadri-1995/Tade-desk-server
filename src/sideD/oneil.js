/*
 * O'Neil's market model, read from the file qp writes.
 *
 * WHY IT IS A FILE AND NOT A COMPUTATION HERE.
 *
 * The market model is ONE fact about the market. Computing it inside each of
 * nine screener tools is nine chances to disagree, on nine different page
 * loads, against nine separate fetches of the same index bars — and the first
 * time T3 said "confirmed uptrend" while T7 said "under pressure" there would
 * be no way to tell which was wrong.
 *
 * So qp computes it once (quant-platform/chart/oneil.py) and publishes
 * data/oneil-market.json. qp is the writer because it already holds what this
 * needs and the nine tools do not: the index history, the parquet bar cache
 * and relstrength.py.
 *
 * The exchange follows the same rules as data/canslim-members.json, which is
 * the precedent in this system and the right one:
 *
 *   - It is a LABEL, never a filter. No tool's results change because of it.
 *     Reading it cannot alter which stocks a screener returns.
 *   - It is one-way. Only qp writes; a reader that cannot find or parse the
 *     file carries on with no market block rather than failing a scan.
 *   - It is written atomically on the qp side (temp file + rename), so a
 *     reader never sees half of one.
 *
 * WHY "LABEL, NEVER A FILTER" MATTERS MOST HERE. T1-T9 are nine independent
 * experiments whose backtests are compared against each other. The moment the
 * market state changes what a screener returns, every card captured before
 * that change measures a different thing and the comparison — the whole point
 * of running nine tools — is gone.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');

// Next to the databases, exactly like canslim-members.json: same lifetime,
// same backup, obvious to find. qp resolves the same path from its own side.
const FILE = process.env.ONEIL_MARKET_FILE
  || path.join(path.dirname(config.dbPath), 'oneil-market.json');

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && raw.status ? raw : null;
  } catch {
    return null;                     // absent or unreadable → simply no block
  }
}

/**
 * What ONE stock did on the exact sessions the index was distributed.
 *
 * This is the whole reason the market model is worth putting on a card.
 * Stamping "uptrend under pressure" on a card gives 150 identical lines on a
 * register day, and a field with the same value on every row carries no
 * information about any row — it is a page header copied into the body.
 *
 * This number is different on every card and is computed from a market-level
 * fact: O'Neil's "leaders hold up during market pullbacks", made checkable.
 * A stock rising on the sessions the index was sold is being accumulated while
 * the market is being distributed, which is what a leader looks like before it
 * leads.
 *
 * `dailyByDate` maps 'YYYY-MM-DD' → that session's percent change for the
 * stock. The caller supplies it because only the caller knows where its bars
 * come from; this function owns the arithmetic and the wording, so all nine
 * tools say the same thing about the same numbers.
 */
function stockVsDistribution(dailyByDate, days) {
  const out = { checked: 0, held: 0, avgRel: null, verdict: null, dates: [], note: null };
  if (!Array.isArray(days) || !days.length) {
    // NOT "0 of 0", which reads as a failure. In a confirmed uptrend with no
    // live distribution days there is nothing to hold up through, and saying
    // so is the honest answer.
    out.note = 'no live distribution days — nothing to hold up through';
    return out;
  }
  if (!dailyByDate) {
    out.note = 'no daily bars for this stock';
    return out;
  }
  const rels = [];
  for (const d of days) {
    const stockPct = dailyByDate[d.date];
    if (stockPct == null || !Number.isFinite(stockPct)) continue;
    const rel = stockPct - (Number(d.pct) || 0);
    rels.push(rel);
    out.dates.push({
      date: d.date,
      index: d.index,
      stockPct: Math.round(stockPct * 100) / 100,
      indexPct: d.pct,
      rel: Math.round(rel * 100) / 100,
      held: rel > 0,
    });
  }
  out.checked = rels.length;
  if (!rels.length) {
    out.note = 'this stock has no bars on those sessions';
    return out;
  }
  out.held = rels.filter(r => r > 0).length;
  out.avgRel = Math.round((rels.reduce((a, b) => a + b, 0) / rels.length) * 100) / 100;
  const share = out.held / out.checked;
  out.verdict = (share >= 0.6 && out.avgRel > 0) ? 'HOLDING UP'
    : (share <= 0.4 || out.avgRel < 0) ? 'GIVING WAY'
      : 'IN LINE';
  return out;
}

// O'Neil's own action for each state. Printed as text because it is a RULE,
// not a measurement, and printed on the card because that is where the
// decision is being made.
const EXPOSURE = {
  confirmed_uptrend:
    'Buy breakouts. This is the state the method is designed for.',
  uptrend_under_pressure:
    'Stop initiating new positions; tighten stops on open ones. A name holding '
    + 'up through distribution is a leader candidate for the next follow-through.',
  market_in_correction:
    'No new buying. Three out of four stocks follow the market, and this one '
    + 'is going down.',
};

/**
 * How far into the uptrend we are. O'Neil buys EARLY in one — and this is also
 * where base-stage counting starts, because bases are counted from the market
 * bottom, not from wherever a chart happens to begin.
 */
function ftdBand(sessions) {
  if (sessions == null) return null;
  if (sessions < 25) return 'early';
  if (sessions <= 150) return 'established';
  return 'late';
}

/*
 * The per-stock read, fetched from qp once and held for the day.
 *
 * WHY CACHED, AND WHY FOR A DAY. Rule X5 of the spec: NO NETWORK CALL IN A CARD
 * RENDER. A register day is 150 cards and a card re-renders on every re-quote;
 * a fetch per card per render would be thousands of requests for an answer
 * that changes once a day.
 *
 * And it genuinely does change only once a day: the input is a list of
 * completed daily sessions and each stock's closes on them. Nothing about it
 * moves while the market is open — the newest distribution day cannot appear
 * until today has closed.
 *
 * FAILURE IS AN EMPTY MAP, never an exception. Every caller renders the card
 * exactly as it does today when this returns nothing.
 */
let _cache = { day: null, stocks: {}, asOf: null, days: [], at: 0 };

function _etDay() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

async function loadStocks(symbols) {
  const day = _etDay();
  if (_cache.day !== day) _cache = { day, stocks: {}, asOf: null, days: [], at: 0 };

  // Only ask for what is missing. The register grows through the morning, so
  // this is called repeatedly with a longer list each time; refetching the
  // whole list every time would re-pay for every name already answered.
  const want = [...new Set((symbols || []).map(s => String(s).toUpperCase()))]
    .filter(s => s && !(s in _cache.stocks));
  if (!want.length) return _cache;

  const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
  // Chunked: a register day is 150 names, and one URL holding all of them is
  // both a very long query string and one slow request instead of several.
  for (let i = 0; i < want.length; i += 50) {
    const chunk = want.slice(i, i + 50);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(`${qp}/api/oneil/stock?symbols=${chunk.join(',')}`,
        { signal: ctl.signal });
      const d = await r.json();
      if (d && d.ok) {
        _cache.asOf = d.as_of || _cache.asOf;
        _cache.days = d.distribution_days || _cache.days;
        Object.assign(_cache.stocks, d.stocks || {});
        _cache.at = Date.now();
      }
    } catch {
      // qp down or slow. The cards render without the block, and the next
      // call retries — nothing is cached as "checked and empty".
    } finally {
      // IN A FINALLY, because the throwing path is the common one when qp is
      // down and a leaked 30-second timer per chunk holds the process awake.
      // Found by the test runner refusing to exit.
      clearTimeout(timer);
    }
  }
  return _cache;
}

/*
 * Phase 4 per stock — demand, the RS line, divergence. Same caching contract
 * as loadStocks(): fetched once per ET day for everything on screen, never per
 * card, because the inputs are completed daily sessions and nothing about them
 * moves while the market is open.
 */
let _ratings = { day: null, stocks: {}, at: 0 };

async function loadRatings(symbols) {
  const day = _etDay();
  if (_ratings.day !== day) _ratings = { day, stocks: {}, at: 0 };
  const want = [...new Set((symbols || []).map(s => String(s).toUpperCase()))]
    .filter(s => s && !(s in _ratings.stocks));
  if (!want.length) return _ratings;

  const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
  // Smaller chunks than the distribution-day call: this one fetches 400 daily
  // bars per name where that one fetches 120, so the same wall-clock budget
  // buys fewer symbols per request.
  for (let i = 0; i < want.length; i += 25) {
    const chunk = want.slice(i, i + 25);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 45000);
    try {
      const r = await fetch(`${qp}/api/oneil/ratings?symbols=${chunk.join(',')}`,
        { signal: ctl.signal });
      const d = await r.json();
      if (d && d.ok) {
        Object.assign(_ratings.stocks, d.stocks || {});
        _ratings.at = Date.now();
      }
    } catch {
      // qp down or slow. Nothing is cached as "checked and empty", so the
      // next call retries rather than leaving a permanent blank.
    } finally {
      clearTimeout(timer);   // in a finally: the throwing path is the common
                             // one when qp is down, and a leaked timer per
                             // chunk holds the process awake.
    }
  }
  return _ratings;
}

/*
 * C, A and the weekly base — the panel's slowest and most stable inputs.
 *
 * Cached for the whole ET day like the others, and it is generous rather than
 * risky: fundamentals change QUARTERLY and a base changes by the week. The
 * page asks once for what is on screen; a card never fetches.
 */
let _fundamentals = { day: null, stocks: {}, at: 0 };
let _bases = { day: null, stocks: {}, at: 0 };

async function _qpBatch(pathname, symbols, into, size, timeoutMs, extra = '') {
  const day = _etDay();
  if (into.day !== day) { into.day = day; into.stocks = {}; into.at = 0; }
  const want = [...new Set((symbols || []).map(s => String(s).toUpperCase()))]
    .filter(s => s && !(s in into.stocks));
  if (!want.length) return into;
  const qp = process.env.QP_URL || 'http://127.0.0.1:8765';
  for (let i = 0; i < want.length; i += size) {
    const chunk = want.slice(i, i + size);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${qp}${pathname}?symbols=${chunk.join(',')}${extra}`,
        { signal: ctl.signal });
      const d = await r.json();
      if (d && d.ok) { Object.assign(into.stocks, d.stocks || {}); into.at = Date.now(); }
    } catch {
      // Nothing is cached as "checked and empty", so the next call retries.
    } finally {
      clearTimeout(timer);      // in a finally: the throwing path is the
                                // common one when qp is down.
    }
  }
  return into;
}

// EDGAR is one HTTP request per company and rate-limited to ten a second, so
// the chunks are small and the timeout is long. This is the slowest thing the
// page asks for and the one whose answer changes least often.
const loadFundamentals = syms => _qpBatch('/api/oneil/fundamentals', syms, _fundamentals, 10, 60000);

/*
 * THE CARDS' VERSION: read what EDGAR has already given us, never go and ask.
 *
 * The panel is one symbol and a deliberate tap, so it can afford to walk
 * EDGAR. A scan is 25 cold tickers at once, and walking them inside one
 * request made the page wait on the slowest source before it drew anything
 * AND got the news feed's EDGAR source rate-limited — every card in that scan
 * printed "edgar not answering". A miss here is a normal answer: the nightly
 * walk fills the cache, and tapping ⤢ fills it for that one name.
 */
const loadFundamentalsCached = syms =>
  _qpBatch('/api/oneil/fundamentals', syms, _fundamentals, 40, 15000,
           '&cached_only=1');

/*
 * ...AND SOMETHING HAS TO FILL THAT CACHE.
 *
 * While C and A lived behind a popup, the popup was the only thing that ever
 * walked EDGAR: one symbol, when a person asked for it. Moving the tables
 * onto the card removed that path, and a cache nothing fills is an empty
 * cache — every card would have read "not fetched yet" forever.
 *
 * So the misses are walked HERE, in the background, after the response has
 * already gone out. The request still never waits on EDGAR — that is the
 * rule, and it is what the page's own timings depend on — but the names it
 * asked for are queued and will be there next time.
 *
 * Deliberately slow. EDGAR asks for under ten requests a second and qp
 * already spaces them; this adds a queue of one at a time so a 25-card scan
 * cannot become a burst, and it drops any name already in flight so two tools
 * scanning the same ticker do not fetch it twice.
 */
const _warming = new Set();
let _warmQueue = [];
let _warmRunning = false;

async function _warmLoop() {
  if (_warmRunning) return;
  _warmRunning = true;
  try {
    while (_warmQueue.length) {
      const sym = _warmQueue.shift();
      try {
        await loadFundamentals([sym]);      // the BUILDING path, one name
      } catch { /* a name EDGAR has nothing for is not an error */ }
      finally { _warming.delete(sym); }
    }
  } finally { _warmRunning = false; }
}

function warmFundamentals(symbols) {
  const day = _etDay();
  if (_fundamentals.day !== day) { _fundamentals.day = day; _fundamentals.stocks = {}; }
  for (const raw of symbols || []) {
    const s = String(raw).toUpperCase();
    if (!s || s in _fundamentals.stocks || _warming.has(s)) continue;
    _warming.add(s);
    _warmQueue.push(s);
  }
  // NOT AWAITED BY THE CALLER, and it must stay that way.
  _warmLoop();
  return { queued: _warmQueue.length };
}
const loadBases = syms => _qpBatch('/api/oneil/base', syms, _bases, 20, 60000);
const fundamentalsCache = () => (_fundamentals.day === _etDay() ? _fundamentals : { stocks: {} });
const basesCache = () => (_bases.day === _etDay() ? _bases : { stocks: {} });

function ratingsCache() {
  return _ratings.day === _etDay() ? _ratings : { day: null, stocks: {}, at: 0 };
}

function stocksCache() {
  return _cache.day === _etDay() ? _cache : { day: null, stocks: {}, days: [], asOf: null, at: 0 };
}

module.exports = {
  read, stockVsDistribution, EXPOSURE, ftdBand, FILE,
  loadStocks, stocksCache, loadRatings, ratingsCache,
  loadFundamentals, loadFundamentalsCached, warmFundamentals, fundamentalsCache,
  loadBases, basesCache,
};
