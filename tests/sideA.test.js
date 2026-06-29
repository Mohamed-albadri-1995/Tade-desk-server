const { mapTVRow, COMMON_COLUMNS } = require('../src/sideA/tvScanner');
const { mergeScannersIntoR0 } = require('../src/sideA/merge');

describe('Side A — TV Response Mapping', () => {
  function makeRaw(overrides = {}) {
    const defaults = {
      'ticker-view': 'NASDAQ:AAPL',
      open: 150,
      close: 155,
      change: 3.5,
      'relative_volume_10d_calc': 2.0,
      'relative_volume_intraday|5': 4.5,
      market_cap_basic: 1e12,
      sector: 'Technology',
      industry: 'Consumer Electronics',
      change_from_open: 3.2,
      VWAP: 152,
      'High.1M': 170,
      'Low.1M': 130,
      high: 157,
      low: 149,
      ATR: 5,
      short_percentage_of_float: 0.8,
      float_shares_outstanding: 1e9,
      EMA9: 151,
      EMA13: 150,
      EMA20: 148,
      EMA50: 140,
      SMA5: 153,
      premarket_high: 156,
      premarket_low: 151,
    };
    const merged = { ...defaults, ...overrides };
    return { d: COMMON_COLUMNS.map(col => merged[col] ?? null) };
  }

  test('strips exchange prefix from ticker', () => {
    const row = mapTVRow(makeRaw());
    expect(row.ticker).toBe('AAPL');
  });

  test('maps close to stock.price', () => {
    const row = mapTVRow(makeRaw({ close: 155 }));
    expect(row.stock.price).toBe(155);
  });

  test('rvol uses intraday when > 0', () => {
    const row = mapTVRow(makeRaw({ 'relative_volume_intraday|5': 6.0, 'relative_volume_10d_calc': 2.0 }));
    expect(row.stock.rvol).toBe(6.0);
  });

  test('rvol falls back to 10d when intraday is null', () => {
    const row = mapTVRow(makeRaw({ 'relative_volume_intraday|5': null, 'relative_volume_10d_calc': 2.5 }));
    expect(row.stock.rvol).toBe(2.5);
  });

  test('rvol falls back to 10d when intraday is 0', () => {
    const row = mapTVRow(makeRaw({ 'relative_volume_intraday|5': 0, 'relative_volume_10d_calc': 2.5 }));
    expect(row.stock.rvol).toBe(2.5);
  });

  test('maps all stock fields correctly', () => {
    const row = mapTVRow(makeRaw());
    const s = row.stock;
    expect(s.open).toBe(150);
    expect(s.change).toBe(3.5);
    expect(s.vwap).toBe(152);
    expect(s.ema9).toBe(151);
    expect(s.ema13).toBe(150);
    expect(s.ema20).toBe(148);
    expect(s.ema50).toBe(140);
    expect(s.sma5).toBe(153);
    expect(s.monthHigh).toBe(170);
    expect(s.monthLow).toBe(130);
    expect(s.dayHigh).toBe(157);
    expect(s.dayLow).toBe(149);
    expect(s.atr).toBe(5);
    expect(s.mcap).toBe(1e12);
    expect(s.floatShares).toBe(1e9);
    expect(s.shortFloat).toBe(0.8);
    expect(s.sector).toBe('Technology');
    expect(s.industry).toBe('Consumer Electronics');
    expect(s.pmHigh).toBe(156);
    expect(s.pmLow).toBe(151);
  });
});

describe('Side A — Scanner Merge Logic', () => {
  const makeRow = (ticker, extra = {}) => ({
    ticker,
    stock: {
      price: 100, open: 99, change: 5, vwap: 98, ema9: 97, ema13: 96,
      ema20: 95, ema50: 90, sma5: 98, monthHigh: 110, monthLow: 80,
      dayHigh: 102, dayLow: 97, atr: 3, mcap: 1e9, floatShares: 1e7,
      shortFloat: 1, sector: 'Tech', industry: 'Software',
      pmHigh: 101, pmLow: 99, rvol: 5, tvSymbol: ticker, ...extra,
    },
  });

  test('unique tickers are kept', () => {
    const results = {
      trend: [makeRow('AAPL'), makeRow('MSFT')],
      premarket: [makeRow('GOOG')],
      bigmoves: [],
    };
    const merged = mergeScannersIntoR0(results);
    expect(merged.length).toBe(3);
    expect(merged.map(r => r.ticker).sort()).toEqual(['AAPL', 'GOOG', 'MSFT']);
  });

  test('duplicate tickers get merged screenerKeys', () => {
    const results = {
      trend: [makeRow('AAPL')],
      premarket: [makeRow('AAPL')],
      bigmoves: [makeRow('AAPL')],
    };
    const merged = mergeScannersIntoR0(results);
    expect(merged.length).toBe(1);
    expect(merged[0].screenerKeys).toContain('Trend');
    expect(merged[0].screenerKeys).toContain('Pre-Mkt');
    expect(merged[0].screenerKeys).toContain('Big Move');
  });

  test('keeps first non-null stock value on merge', () => {
    const r1 = makeRow('AAPL', { price: 100 });
    const r2 = makeRow('AAPL', { price: null });
    const results = { trend: [r1], premarket: [r2], bigmoves: [] };
    const merged = mergeScannersIntoR0(results);
    expect(merged[0].stock.price).toBe(100);
  });

  test('prefers first scanner price when both non-null', () => {
    const r1 = makeRow('AAPL', { price: 100 });
    const r2 = makeRow('AAPL', { price: 200 });
    const results = { trend: [r1], premarket: [r2], bigmoves: [] };
    const merged = mergeScannersIntoR0(results);
    expect(merged[0].stock.price).toBe(100);
  });
});
