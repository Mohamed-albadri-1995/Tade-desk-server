const axios = require('axios');

// TradingView scanner for index data
const TV_URL = 'https://scanner.tradingview.com/america/scan?label-product=screener-stock';

// Index symbols with TV exchange prefix for direct symbol lookup
const INDEX_TICKERS = {
  SPY: 'AMEX:SPY',
  QQQ: 'NASDAQ:QQQ',
  IWM: 'AMEX:IWM',
  DIA: 'AMEX:DIA',
  VIX: 'TVC:VIX',
};

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

  // Fetch indices (including VIX via TVC:VIX) using direct symbol tickers
  const indexTickers = Object.values(INDEX_TICKERS);
  const indexBody = {
    columns: cols,
    symbols: { tickers: indexTickers },
    ignore_unknown_fields: true,
    options: { lang: 'en' },
    range: [0, indexTickers.length + 2],
  };

  // Fetch sector ETFs using name filter (all in america market)
  const sectorEtfs = Object.values(SECTOR_ETF_MAP).map(s => s.etf);
  const sectorBody = {
    columns: cols,
    filter2: {
      operator: 'and',
      operands: [{ expression: { left: 'name', operation: 'in_range', right: sectorEtfs } }],
    },
    ignore_unknown_fields: true,
    markets: ['america'],
    options: { lang: 'en' },
    range: [0, sectorEtfs.length + 5],
    sort: { sortBy: 'name', sortOrder: 'asc' },
    symbols: {},
  };

  const [indexResp, sectorResp] = await Promise.all([
    axios.post(TV_URL, indexBody, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }),
    axios.post(TV_URL, sectorBody, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }),
  ]);

  const result = {};
  const parseRows = (rows) => {
    for (const row of rows) {
      const sym = row.s ? row.s.split(':').pop() : null;
      if (!sym) continue;
      const obj = {};
      cols.forEach((c, i) => { obj[c] = row.d[i]; });
      result[sym] = obj;
    }
  };

  parseRows(indexResp.data.data || []);
  parseRows(sectorResp.data.data || []);
  return result;
}

module.exports = { fetchMarketData, SECTOR_ETF_MAP, TV_SECTOR_TO_MARKET_KEY };
