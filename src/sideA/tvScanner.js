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
  'high': ['number', 'null'], 'low': ['number', 'null'], 'ATR': ['number', 'null'],
  'short_percentage_of_float': ['number', 'null'], 'float_shares_outstanding': ['number', 'null'],
  'EMA9': ['number', 'null'], 'EMA13': ['number', 'null'], 'EMA20': ['number', 'null'],
  'EMA50': ['number', 'null'], 'SMA5': ['number', 'null'],
  'premarket_high': ['number', 'null'], 'premarket_low': ['number', 'null'],
};

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
  const tradable = require('./tradable');
  const t = tradable.thresholds();
  const body = buildRequest([...screener.filters, ...tradable.serverFilters(t)], screener.sort);
  if (Number.isFinite(screener.limit)) body.range = [0, screener.limit];
  const resp = await axios.post(TV_URL, body, {
    headers: TV_HEADERS,
    timeout: 15000,
  });
  const rawRows = resp.data.data || [];
  if (rawRows.length > 0) validateTVStructure(rawRows[0]);
  const mapped = rawRows.map(mapTVRow).filter(r => r.ticker);
  const { kept, dropped } = tradable.applyLocal(mapped, t);
  if (dropped) {
    console.log(`[TV Scanner] "${screener.name}": ${dropped} row(s) below ${t.minAtrPct}% ATR`);
  }
  return { name: screener.name, key: screener.key, rows: kept, floorDropped: dropped };
}

/**
 * Run a screener definition without storing anything — powers the builder's
 * "test" button, so a filter set can be checked before it is saved.
 */
async function testScreener(def) {
  const started = Date.now();
  const { rows } = await runScreener({
    name: def.name || 'test',
    key: 'test',
    filters: def.filters,
    sort: def.sort || { sortBy: 'change', sortOrder: 'desc' },
    limit: Number.isFinite(def.limit) ? def.limit : 20,
  });
  return { count: rows.length, ms: Date.now() - started, rows };
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
    return {};
  }
  if (asleep) console.log(`[TV Scanner] ${asleep} screener(s) outside their run window, skipped.`);

  const results = await Promise.allSettled(screeners.map(runScreener));

  const scannerResults = {};
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      scannerResults[r.value.name] = r.value.rows;
    } else {
      const errData = r.reason?.response?.data;
      console.error(`[TV Scanner] "${screeners[i].name}" failed:`, r.reason?.message,
        errData ? JSON.stringify(errData).slice(0, 200) : '');
    }
  });
  console.log('[TV Scanner] Results:', Object.entries(scannerResults).map(([k,v]) => `${k}:${v.length}`).join(' '));
  return scannerResults;
}

module.exports = { runAllScanners, runScreener, testScreener, mapTVRow, COMMON_COLUMNS, buildRequest };
