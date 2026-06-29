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

function mapTVRow(rawTV) {
  const d = rawTV.d;
  const colIdx = {};
  COMMON_COLUMNS.forEach((col, i) => { colIdx[col] = i; });

  const get = col => {
    const i = colIdx[col];
    return i !== undefined ? d[i] : null;
  };

  // TV now returns ticker-view as a rich object; use rawTV.s (e.g. "NASDAQ:SHPH") instead
  const rawTicker = (typeof rawTV.s === 'string' ? rawTV.s : '') || '';
  const ticker = rawTicker.includes(':') ? rawTicker.split(':')[1] : rawTicker;

  const intraday_rvol = get('relative_volume_intraday|5');
  const tenDay_rvol = get('relative_volume_10d_calc');
  let rvol;
  if (intraday_rvol !== null && intraday_rvol !== undefined && intraday_rvol > 0) {
    rvol = intraday_rvol;
  } else {
    rvol = tenDay_rvol;
  }

  return {
    ticker,
    stock: {
      tvSymbol: rawTicker,
      price: get('close'),
      open: get('open'),
      change: get('change'),
      vwap: get('VWAP'),
      ema9: get('EMA9'),
      ema13: get('EMA13'),
      ema20: get('EMA20'),
      ema50: get('EMA50'),
      sma5: get('SMA5'),
      monthHigh: get('High.1M'),
      monthLow: get('Low.1M'),
      dayHigh: get('high'),
      dayLow: get('low'),
      atr: get('ATR'),
      mcap: get('market_cap_basic'),
      floatShares: get('float_shares_outstanding'),
      shortFloat: get('short_percentage_of_float'),
      sector: get('sector'),
      industry: get('industry'),
      pmHigh: get('premarket_high'),
      pmLow: get('premarket_low'),
      rvol,
      _changeFromOpen: get('change_from_open'),
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

async function runScanner(name) {
  const body = SCANNERS[name];
  const resp = await axios.post(TV_URL, body, {
    headers: TV_HEADERS,
    timeout: 15000,
  });
  const rawRows = resp.data.data || [];
  console.log(`[TV Scanner] ${name}: TV returned ${rawRows.length} raw rows`);
  const rows = [];
  for (const raw of rawRows) {
    try {
      rows.push(mapTVRow(raw));
    } catch (e) {
      console.error(`[TV Scanner] ${name} mapTVRow error:`, e.message, JSON.stringify(raw).slice(0, 150));
    }
  }
  return { name, rows };
}

async function runAllScanners() {
  const results = await Promise.allSettled([
    runScanner('trend'),
    runScanner('premarket'),
    runScanner('bigmoves'),
  ]);

  const scannerResults = {};
  for (const r of results) {
    if (r.status === 'fulfilled') {
      scannerResults[r.value.name] = r.value.rows;
    } else {
      const errData = r.reason?.response?.data;
      console.error('[TV Scanner] Failed:', r.reason?.message, errData ? JSON.stringify(errData).slice(0, 200) : '');
    }
  }
  console.log('[TV Scanner] Results:', Object.entries(scannerResults).map(([k,v]) => `${k}:${v.length}`).join(' '));
  return scannerResults;
}

module.exports = { runAllScanners, mapTVRow, COMMON_COLUMNS };
