const axios = require('axios');

// TradingView scanner for index data
const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

const INDEX_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'VIX'];

const SECTOR_ETF_MAP = {
  Technology: { etf: 'XLK', tvSymbol: 'AMEX:XLK' },
  Financial: { etf: 'XLF', tvSymbol: 'AMEX:XLF' },
  Industrial: { etf: 'XLI', tvSymbol: 'AMEX:XLI' },
  'Consumer Discretionary': { etf: 'XLY', tvSymbol: 'AMEX:XLY' },
  Energy: { etf: 'XLE', tvSymbol: 'AMEX:XLE' },
  'Health Care': { etf: 'XLV', tvSymbol: 'AMEX:XLV' },
  'Communication Services': { etf: 'XLC', tvSymbol: 'AMEX:XLC' },
  Utilities: { etf: 'XLU', tvSymbol: 'AMEX:XLU' },
  Materials: { etf: 'XLB', tvSymbol: 'AMEX:XLB' },
  'Real Estate': { etf: 'XLRE', tvSymbol: 'AMEX:XLRE' },
  'Consumer Staples': { etf: 'XLP', tvSymbol: 'AMEX:XLP' },
  Semiconductors: { etf: 'SMH', tvSymbol: 'NASDAQ:SMH' },
  Biotechnology: { etf: 'IBB', tvSymbol: 'NASDAQ:IBB' },
  Retail: { etf: 'XRT', tvSymbol: 'AMEX:XRT' },
  Transportation: { etf: 'XTN', tvSymbol: 'AMEX:XTN' },
};

// TV sector name → Market Tab sector key
const TV_SECTOR_TO_MARKET_KEY = {
  Technology: 'Technology',
  Financial: 'Financial',
  Industrial: 'Industrial',
  'Consumer Cyclical': 'Consumer Discretionary',
  Energy: 'Energy',
  Healthcare: 'Health Care',
  'Communication Services': 'Communication Services',
  Utilities: 'Utilities',
  'Basic Materials': 'Materials',
  'Real Estate': 'Real Estate',
  'Consumer Defensive': 'Consumer Staples',
  Semiconductors: 'Semiconductors',
  Biotechnology: 'Biotechnology',
  Retail: 'Retail',
  Transportation: 'Transportation',
};

const INDEX_COLUMNS = [
  'close', 'change', 'change_from_open',
  'SMA5', 'SMA20', 'SMA50', 'SMA200',
  'BB.upper', 'BB.lower',
  'change|1W',
  'ADX',
  'VWAP',
  'relative_volume_10d_calc',
  // Hourly signals proxied as daily for simplicity — see note below
];

async function fetchSymbolData(symbols, columns) {
  const body = {
    columns,
    filter2: {
      operator: 'and',
      operands: [
        {
          expression: {
            left: 'name',
            operation: 'in_range',
            right: symbols,
          },
        },
      ],
    },
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, symbols.length + 5],
    sort: { sortBy: 'name', sortOrder: 'asc' },
    symbols: {},
  };
  const resp = await axios.post(TV_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });
  const result = {};
  for (const row of resp.data.data || []) {
    const sym = row.s ? row.s.split(':').pop() : null;
    if (!sym) continue;
    const d = row.d;
    const obj = {};
    columns.forEach((col, i) => { obj[col] = d[i]; });
    result[sym] = obj;
  }
  return result;
}

async function fetchMarketData() {
  const cols = [
    'close', 'change', 'change|1W',
    'SMA5', 'SMA20', 'SMA50', 'SMA200',
    'BB.upper', 'BB.lower',
    'ADX', 'VWAP',
    'relative_volume_10d_calc',
  ];

  const allSymbols = [
    ...INDEX_SYMBOLS,
    ...Object.values(SECTOR_ETF_MAP).map(s => s.etf),
  ];

  const body = {
    columns: cols,
    filter2: {
      operator: 'and',
      operands: [
        {
          expression: {
            left: 'name',
            operation: 'in_range',
            right: allSymbols,
          },
        },
      ],
    },
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, allSymbols.length + 5],
    sort: { sortBy: 'name', sortOrder: 'asc' },
    symbols: {},
  };

  const resp = await axios.post(TV_URL, body, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
  });

  const result = {};
  for (const row of (resp.data.data || [])) {
    const sym = row.s ? row.s.split(':').pop() : null;
    if (!sym) continue;
    const d = row.d;
    const obj = {};
    cols.forEach((c, i) => { obj[c] = d[i]; });
    result[sym] = obj;
  }
  return result;
}

module.exports = { fetchMarketData, SECTOR_ETF_MAP, TV_SECTOR_TO_MARKET_KEY };
