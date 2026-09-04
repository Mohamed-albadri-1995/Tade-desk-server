const axios = require('axios');

const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

const COMMON_COLUMNS = [
  'ticker-view',
  'open',
  'close',
  'change',
  'relative_volume_10d_calc',
  'relative_volume_intraday|5',
  'market_cap_basic',
  'sector',
  'industry',
  'change_from_open',
  'VWAP',
  'High.1M',
  'Low.1M',
  // Wider ranges, for the card's range bars. One month said where a stock sat
  // over twenty sessions and nothing about whether that was also the top of the
  // year — which is the difference between a breakout and a bounce in a
  // downtrend. All-time has a high and no usable low, so it is shown as a
  // distance rather than a position.
  // Five trailing sessions, not the current week's candle. `high|1W` exists and
  // is the week-to-date bar, which on a Monday morning is one session and by
  // Friday is five — a range that means something different every day is not a
  // range you can compare. High.5D is a trailing window like High.1M and
  // High.3M, so all four bars answer the same shape of question.
  // (`High.W` / `High.1W` are accepted names that come back empty — probed and
  // confirmed against AAPL, see scripts/probe-range-fields.js.)
  //
  // VERIFIED AGAINST LIVE DATA, not just accepted as a name. High.5D differed
  // from High.1M on seven of eight stocks in scripts/probe-week-range.js. The
  // eighth was a fresh earnings reaction that had made the month's high and its
  // low inside five days — which is the correct answer, not a broken column.
  // `high|1W` also works and gives nearly the same numbers, but it is
  // week-to-date: on a Monday it is one session and by Friday five, so the bars
  // would not be comparable across days.
  'High.5D',
  'Low.5D',
  'High.3M',
  'Low.3M',
  'price_52_week_high',
  'price_52_week_low',
  'High.All',
  'high',
  'low',
  'ATR',
  'short_percentage_of_float',
  'float_shares_outstanding',
  'EMA9',
  'EMA13',
  'EMA20',
  'EMA50',
  'SMA5',
  'premarket_high',
  'premarket_low',
];

const COMMON_BASE_FILTER = {
  operator: 'and',
  operands: [
    {
      operation: {
        operator: 'or',
        operands: [
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                { expression: { left: 'typespecs', operation: 'has', right: ['common'] } },
              ],
            },
          },
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'stock' } },
                { expression: { left: 'typespecs', operation: 'has', right: ['preferred'] } },
              ],
            },
          },
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'dr' } },
              ],
            },
          },
          {
            operation: {
              operator: 'and',
              operands: [
                { expression: { left: 'type', operation: 'equal', right: 'fund' } },
                { expression: { left: 'typespecs', operation: 'has_none_of', right: ['etf', 'mutual', 'closedend'] } },
              ],
            },
          },
        ],
      },
    },
    {
      expression: {
        left: 'typespecs',
        operation: 'has_none_of',
        right: ['pre-ipo'],
      },
    },
  ],
};

function buildRequest(filter, sort) {
  return {
    columns: COMMON_COLUMNS,
    filter,
    filter2: COMMON_BASE_FILTER,
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, 50],
    sort,
    symbols: {},
  };
}

const SCANNERS = {
  trend: buildRequest(
    [
      { left: 'close', operation: 'egreater', right: 20 },
      { left: 'close', operation: 'egreater', right: 'SMA5' },
      { left: 'close', operation: 'egreater', right: 'VWAP' },
      { left: 'close|1W', operation: 'greater', right: 'VWAP|1W' },
      { left: 'close|1M', operation: 'greater', right: 'VWAP|1M' },
      { left: 'EMA50|1', operation: 'greater', right: 'EMA120|1' },
      { left: 'close|1', operation: 'egreater', right: 'EMA50|1' },
      { left: 'average_volume_90d_calc', operation: 'greater', right: 1000000 },
      { left: 'VWAP', operation: 'egreater', right: 'SMA75|5' },
      { left: 'relative_volume_intraday|5', operation: 'greater', right: 3 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
      { left: 'close', operation: 'egreater', right: 1 },
    ],
    { sortBy: 'change', sortOrder: 'desc' }
  ),

  premarket: buildRequest(
    [
      { left: 'close', operation: 'egreater', right: 0.5 },
      { left: 'close', operation: 'egreater', right: 1 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 3 },
      { left: 'premarket_volume', operation: 'greater', right: 1500000 },
    ],
    { sortBy: 'premarket_volume', sortOrder: 'desc' }
  ),

  bigmoves: buildRequest(
    [
      { left: 'relative_volume_10d_calc', operation: 'greater', right: 10 },
      { left: 'close', operation: 'egreater', right: 2 },
      { left: 'average_volume_10d_calc', operation: 'greater', right: 2000000 },
    ],
    { sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' }
  ),
};

// Expected types for each column — used for structure validation
const COLUMN_EXPECTED_TYPES = {
  'ticker-view': ['string', 'object'], // TV changed this to object; accept both
  'open': ['number'], 'close': ['number'], 'change': ['number'],
  'relative_volume_10d_calc': ['number'], 'relative_volume_intraday|5': ['number', 'null'],
  'market_cap_basic': ['number', 'null'], 'sector': ['string', 'null'],
  'industry': ['string', 'null'], 'change_from_open': ['number', 'null'],
  'VWAP': ['number', 'null'], 'High.1M': ['number', 'null'], 'Low.1M': ['number', 'null'],
  'High.5D': ['number', 'null'], 'Low.5D': ['number', 'null'],
  'High.3M': ['number', 'null'], 'Low.3M': ['number', 'null'],
  'price_52_week_high': ['number', 'null'], 'price_52_week_low': ['number', 'null'],
  'High.All': ['number', 'null'],
  'high': ['number', 'null'], 'low': ['number', 'null'], 'ATR': ['number', 'null'],
  'short_percentage_of_float': ['number', 'null'], 'float_shares_outstanding': ['number', 'null'],
  'EMA9': ['number', 'null'], 'EMA13': ['number', 'null'], 'EMA20': ['number', 'null'],
  'EMA50': ['number', 'null'], 'SMA5': ['number', 'null'],
  'premarket_high': ['number', 'null'], 'premarket_low': ['number', 'null'],
};

/**
 * Is the response positionally aligned with the columns we asked for?
 *
 * mapTVRow reads values by index — `d[colIdx['ATR']]` — which is only correct
 * while the response array lines up with COMMON_COLUMNS one for one. Requests
 * go out with `ignore_unknown_fields: true`, so a column TradingView does not
 * recognise is dropped rather than refused. If a drop also shortens the row,
 * every field after it shifts by one and the data is not wrong in a way anyone
 * would notice: ATR reads a market cap, the tradability floor passes the wrong
 * stocks, and a month of collection is quietly ruined.
 *
 * So the length is checked before anything is mapped, and a mismatch means no
 * rows rather than shifted rows. Losing a scan is recoverable; recording a
 * scan's worth of misaligned numbers into the training set is not.
 */
function columnsAligned(sampleRow) {
  const d = (sampleRow && sampleRow.d) || [];
  if (d.length === COMMON_COLUMNS.length) return true;
  console.error(
    `[TV Scanner] ABORT: response has ${d.length} values for ${COMMON_COLUMNS.length} ` +
    'requested columns. Fields are read by position, so mapping this would ' +
    'silently shift every column. Refusing the batch — check COMMON_COLUMNS ' +
    'against scripts/verify-tv-fields.js for a name TradingView dropped.');
  return false;
}

/*
 * A column that is accepted but returns another column's values.
 *
 * `ignore_unknown_fields: true` makes a misspelled name disappear, and
 * columnsAligned catches that because the response gets shorter. This is the
 * other failure and it is worse, because it produces confident numbers rather
 * than a blank: a name TradingView accepts while serving something else. It
 * reached the card as a weekly range bar reading exactly the same low and high
 * as the monthly one.
 *
 * The windows nest, so for ONE stock a five-day high equal to the one-month
 * high is ordinary — it means the monthly high was made this week. Across a
 * whole result set it is not ordinary, it is a definition. So the check needs
 * a population, and it needs enough of one to mean anything.
 *
 * Reported rather than corrected. What the right column name is cannot be
 * decided from here — scripts/probe-week-range.js answers that against the
 * live API — and quietly blanking the field would trade a wrong bar for a
 * missing one without anyone learning why.
 */
const MIN_ROWS_TO_JUDGE = 20;
let _windowWarned = false;

function checkWindowsDiffer(rows, screenerName) {
  if (_windowWarned || rows.length < MIN_ROWS_TO_JUDGE) return;
  const pairs = [
    ['week', 'month', 'weekHigh', 'weekLow', 'monthHigh', 'monthLow'],
    ['month', 'quarter', 'monthHigh', 'monthLow', 'quarterHigh', 'quarterLow'],
  ];
  for (const [narrow, wide, nh, nl, wh, wl] of pairs) {
    const usable = rows.filter(r => [nh, nl, wh, wl].every(k => r.stock?.[k] != null));
    if (usable.length < MIN_ROWS_TO_JUDGE) continue;
    const identical = usable.filter(r =>
      r.stock[nh] === r.stock[wh] && r.stock[nl] === r.stock[wl]).length;
    if (identical === usable.length) {
      _windowWarned = true;
      console.error(
        `[TV Scanner] "${screenerName}": the ${narrow} range is identical to the ${wide} range ` +
        `on all ${usable.length} rows. One stock can do that; every stock cannot. The ${narrow} ` +
        'columns are almost certainly serving another window\'s values — run ' +
        'scripts/probe-week-range.js on the server to find the right names.');
      return;
    }
  }
}

let _structureWarned = false;
function validateTVStructure(sampleRow) {
  if (_structureWarned) return;
  const d = sampleRow.d || [];
  const issues = [];
  COMMON_COLUMNS.forEach((col, i) => {
    const val = d[i];
    const expected = COLUMN_EXPECTED_TYPES[col];
    if (!expected) return;
    const actual = val === null || val === undefined ? 'null' : typeof val;
    if (!expected.includes(actual)) {
      issues.push(`${col}[${i}]: expected ${expected.join('|')} got ${actual}`);
    }
  });
  if (issues.length > 0) {
    console.warn('[TV Scanner] Structure change detected — update mapTVRow if data looks wrong:');
    issues.forEach(i => console.warn('  >', i));
    _structureWarned = true;
  }
}

// Safe extractors — return null instead of throwing on unexpected types
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const str = v => (typeof v === 'string') ? v : (v && typeof v === 'object' && v.name) ? v.name : null;

function mapTVRow(rawTV) {
  const d = rawTV.d;
  const colIdx = {};
  COMMON_COLUMNS.forEach((col, i) => { colIdx[col] = i; });

  const getRaw = col => { const i = colIdx[col]; return i !== undefined ? d[i] : null; };
  const getNum = col => num(getRaw(col));
  const getStr = col => str(getRaw(col));

  // Always use rawTV.s for ticker — resilient to ticker-view format changes
  const rawTicker = (typeof rawTV.s === 'string' ? rawTV.s : '') || '';
  const ticker = rawTicker.includes(':') ? rawTicker.split(':')[1] : rawTicker;

  const intraday_rvol = getNum('relative_volume_intraday|5');
  const tenDay_rvol = getNum('relative_volume_10d_calc');
  const rvol = (intraday_rvol !== null && intraday_rvol > 0) ? intraday_rvol : tenDay_rvol;

  return {
    ticker,
    stock: {
      tvSymbol: rawTicker,
      price: getNum('close'),
      open: getNum('open'),
      change: getNum('change'),
      vwap: getNum('VWAP'),
      ema9: getNum('EMA9'),
      ema13: getNum('EMA13'),
      ema20: getNum('EMA20'),
      ema50: getNum('EMA50'),
      sma5: getNum('SMA5'),
      monthHigh: getNum('High.1M'),
      monthLow: getNum('Low.1M'),
      weekHigh: getNum('High.5D'),
      weekLow: getNum('Low.5D'),
      quarterHigh: getNum('High.3M'),
      quarterLow: getNum('Low.3M'),
      yearHigh: getNum('price_52_week_high'),
      yearLow: getNum('price_52_week_low'),
      allTimeHigh: getNum('High.All'),
      dayHigh: getNum('high'),
      dayLow: getNum('low'),
      atr: getNum('ATR'),
      mcap: getNum('market_cap_basic'),
      floatShares: getNum('float_shares_outstanding'),
      shortFloat: getNum('short_percentage_of_float'),
      sector: getStr('sector'),
      industry: getStr('industry'),
      pmHigh: getNum('premarket_high'),
      pmLow: getNum('premarket_low'),
      rvol,
      _changeFromOpen: getNum('change_from_open'),
    },
  };
}

const TV_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://www.tradingview.com',
  'Referer': 'https://www.tradingview.com/',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

// Run one screener definition (from the database) against TradingView.
async function runScreener(screener) {
  // The tradability floor rides along with every screener — see tradable.js.
  // A stock too thin to get out of, or with too little range to pay for the
  // risk, is not a candidate whatever the strategy says about it.
  //
  // A LABEL-ONLY screener is the exception. It is not proposing trades, it is
  // deciding who belongs on a list, and the floor answers a different question:
  // a $600 growth name with 1.5% daily range is still a growth company, it is
  // just not a day trade. Applying the floor there would make membership depend
  // on today's volatility, which is exactly the bug it exists to fix.
  const tradable = require('./tradable');
  const t = tradable.thresholds();
  // A NEGLECTED-NAME screener keeps the price floor and loses the liquidity
  // legs — see tradable.serverFilters and the note on the unexplained-move
  // screener. Keyed by screener key, so the exemption travels with the
  // definition rather than being a name match that a rename would break.
  const { NEGLECTED_KEYS } = require('./seedScreeners');
  const liquidity = !NEGLECTED_KEYS.has(String(screener.key || ''));
  const floor = screener.labelOnly ? [] : tradable.serverFilters(t, { liquidity });
  const body = buildRequest([...screener.filters, ...floor], screener.sort);
  if (Number.isFinite(screener.limit)) body.range = [0, screener.limit];
  const resp = await axios.post(TV_URL, body, {
    headers: TV_HEADERS,
    timeout: 15000,
  });
  const rawRows = resp.data.data || [];
  /*
   * HOW MANY MATCHED, as opposed to how many were RETURNED.
   *
   * `range` asks for a page — 50 rows for a screener, and whatever the caller
   * wants for a probe — so the row count saturates at the limit and stops
   * being a measure of anything. A leave-one-out probe read that way reports
   * "97" for a rule that matches four thousand stocks and "97" for one that
   * matches ninety-eight, which is an arithmetically correct number about the
   * wrong question. TradingView returns the true total beside the page.
   */
  const totalCount = Number.isFinite(resp.data.totalCount) ? resp.data.totalCount : null;
  if (rawRows.length > 0 && !columnsAligned(rawRows[0])) {
    return { name: screener.name, key: screener.key, rows: [], floorDropped: 0,
             totalCount, misaligned: true };
  }
  if (rawRows.length > 0) validateTVStructure(rawRows[0]);
  const mapped = rawRows.map(mapTVRow).filter(r => r.ticker);
  if (screener.labelOnly) {
    return { name: screener.name, key: screener.key, rows: mapped, floorDropped: 0,
             totalCount, labelOnly: true };
  }
  checkWindowsDiffer(mapped, screener.name);
  const { kept, dropped } = tradable.applyLocal(mapped, t, { liquidity });
  if (dropped) {
    console.log(`[TV Scanner] "${screener.name}": ${dropped} row(s) below ${t.minAtrPct}% ADR`);
  }
  return { name: screener.name, key: screener.key, rows: kept, floorDropped: dropped,
           totalCount };
}

/**
 * Run a screener definition without storing anything — powers the builder's
 * "test" button, so a filter set can be checked before it is saved.
 */
async function testScreener(def) {
  const started = Date.now();
  const { rows, totalCount } = await runScreener({
    name: def.name || 'test',
    key: 'test',
    filters: def.filters,
    sort: def.sort || { sortBy: 'change', sortOrder: 'desc' },
    limit: Number.isFinite(def.limit) ? def.limit : 20,
  });
  // `count` is the page — what this screener would actually collect.
  // `totalCount` is how many stocks matched, which is the only one of the two
  // that measures a rule's selectivity. They differ the moment a rule matches
  // more than the limit, which for a single filter is most of the time.
  return { count: rows.length, totalCount, ms: Date.now() - started, rows };
}

/**
 * Run every enabled screener this tool defines.
 *
 * Definitions come from the database rather than a constant, so the set is
 * whatever the trader has built for this tool. Results are keyed by the
 * screener's display name, which is what lands in screenerKeys on the card.
 */
async function runAllScanners() {
  const store = require('./screenerStore');
  const all = store.list({ enabledOnly: true });

  // A screener with a run window only fires inside it, so a pre-market
  // screener does not keep matching at 11am and fill its own dataset with rows
  // from a session it was never meant to describe.
  const now = Date.now();
  const screeners = all.filter(s => store.isActiveAt(s, now));
  const asleep = all.length - screeners.length;

  if (!screeners.length) {
    console.warn(`[TV Scanner] No screeners are due to run right now` +
      (asleep ? ` (${asleep} outside their window).` : ' — none are defined for this tool.'));
    // THE SAME SHAPE AS THE SUCCESSFUL RETURN, which this used to break by
    // returning a bare {}. The caller destructures `{ candidates, labels }`,
    // so both arrived undefined and the very next stage threw "Cannot convert
    // undefined or null to object" on Object.keys(labels).
    //
    // The scan then FAILED rather than finishing with nothing, which is a
    // different and much worse outcome: nothing downstream ran, so no row was
    // scored and every card showed a blank score. And it happened on the
    // ordinary path — every scan outside the screeners' run window, which is
    // most of the day.
    return { candidates: {}, labels: {} };
  }
  if (asleep) console.log(`[TV Scanner] ${asleep} screener(s) outside their run window, skipped.`);

  const results = await Promise.allSettled(screeners.map(runScreener));

  // Two piles, kept apart on purpose. `candidates` become cards and travel into
  // r0 and every register downstream; `labels` only maintain a list. Mixing
  // them would put stocks nobody could trade into the training data, which is
  // the cost that made a slow-moving universe screener impossible before.
  const candidates = {};
  const labels = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      (r.value.labelOnly ? labels : candidates)[r.value.name] = r.value.rows;
    } else {
      const errData = r.reason?.response?.data;
      console.error(`[TV Scanner] "${screeners[i].name}" failed:`, r.reason?.message,
        errData ? JSON.stringify(errData).slice(0, 200) : '');
    }
  });
  const shown = xs => Object.entries(xs).map(([k, v]) => `${k}:${v.length}`).join(' ');
  console.log('[TV Scanner] Results:', shown(candidates)
    + (Object.keys(labels).length ? `  | labels ${shown(labels)}` : ''));
  return { candidates, labels };
}

module.exports = {
  runAllScanners, runScreener, testScreener, mapTVRow, COMMON_COLUMNS, buildRequest,
  checkWindowsDiffer, MIN_ROWS_TO_JUDGE,
  // Test seam only: the warning fires once per process so a scan every fifteen
  // minutes does not fill the log with the same line.
  _resetWindowWarning: () => { _windowWarned = false; },
};
