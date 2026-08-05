const { mapTVRow, COMMON_COLUMNS } = require('../src/sideA/tvScanner');

// Build a minimal but complete raw TV row
function buildRawRow(overrides = {}) {
  // d array must match COMMON_COLUMNS index order
  const d = new Array(COMMON_COLUMNS.length).fill(null);
  const idx = {};
  COMMON_COLUMNS.forEach((col, i) => { idx[col] = i; });

  // Defaults
  d[idx['ticker-view']]                   = 'AMEX:TEST';
  d[idx['open']]                          = 10;
  d[idx['close']]                         = 12;
  d[idx['change']]                        = 5;
  d[idx['relative_volume_10d_calc']]      = 3.1;
  d[idx['relative_volume_intraday|5']]    = 5.2;
  d[idx['market_cap_basic']]             = 1e8;
  d[idx['sector']]                        = 'Technology';
  d[idx['industry']]                      = 'Semiconductors';
  d[idx['change_from_open']]              = 0.5;
  d[idx['VWAP']]                          = 11;
  d[idx['High.1M']]                       = 15;
  d[idx['Low.1M']]                        = 8;
  d[idx['high']]                          = 12.5;
  d[idx['low']]                           = 9.5;
  d[idx['ATR']]                           = 2;
  d[idx['short_percentage_of_float']]     = 4.5;
  d[idx['float_shares_outstanding']]      = 5e6;
  d[idx['EMA9']]                          = 11.5;
  d[idx['EMA13']]                         = 11.2;
  d[idx['EMA20']]                         = 10.8;
  d[idx['EMA50']]                         = 10.2;
  d[idx['SMA5']]                          = 11.8;
  d[idx['premarket_high']]               = 13;
  d[idx['premarket_low']]                = 11;
  d[idx['High.3M']]                       = 18;
  d[idx['Low.3M']]                        = 6;
  d[idx['price_52_week_high']]            = 24;
  d[idx['price_52_week_low']]             = 3;
  d[idx['High.All']]                      = 40;

  const base = { s: 'AMEX:TEST', d };
  Object.assign(base, overrides.root || {});
  for (const [col, val] of Object.entries(overrides.d || {})) {
    if (idx[col] !== undefined) d[idx[col]] = val;
  }
  return base;
}

describe('Side A — mapTVRow', () => {

  // ─── Ticker extraction ────────────────────────────────────────────────────
  describe('ticker extraction from rawTV.s', () => {
    test('strips exchange prefix: NASDAQ:AAPL → AAPL', () => {
      const row = buildRawRow({ root: { s: 'NASDAQ:AAPL' } });
      expect(mapTVRow(row).ticker).toBe('AAPL');
    });

    test('no prefix: AAPL → AAPL', () => {
      const row = buildRawRow({ root: { s: 'AAPL' } });
      expect(mapTVRow(row).ticker).toBe('AAPL');
    });

    test('NYSE prefix: NYSE:XYZ → XYZ', () => {
      const row = buildRawRow({ root: { s: 'NYSE:XYZ' } });
      expect(mapTVRow(row).ticker).toBe('XYZ');
    });

    test('ticker-view column is object (TV API change) — still extracts from rawTV.s', () => {
      const row = buildRawRow({
        root: { s: 'NYSE:XYZ' },
        d: { 'ticker-view': { name: 'XYZ', type: 'stock', description: 'Some Company' } },
      });
      expect(mapTVRow(row).ticker).toBe('XYZ');
    });

    test('empty s field → ticker is empty string (filtered out by runScanner)', () => {
      const row = buildRawRow({ root: { s: '' } });
      expect(mapTVRow(row).ticker).toBe('');
    });
  });

  // ─── rvol resolution ─────────────────────────────────────────────────────
  describe('rvol resolution (spec §3.8)', () => {
    test('intraday > 0: uses intraday', () => {
      const row = buildRawRow({ d: { 'relative_volume_intraday|5': 5.2, 'relative_volume_10d_calc': 3.1 } });
      expect(mapTVRow(row).stock.rvol).toBe(5.2);
    });

    test('intraday = 0: falls back to tenDay', () => {
      const row = buildRawRow({ d: { 'relative_volume_intraday|5': 0, 'relative_volume_10d_calc': 3.1 } });
      expect(mapTVRow(row).stock.rvol).toBe(3.1);
    });

    test('intraday = null: falls back to tenDay', () => {
      const row = buildRawRow({ d: { 'relative_volume_intraday|5': null, 'relative_volume_10d_calc': 3.1 } });
      expect(mapTVRow(row).stock.rvol).toBe(3.1);
    });

    test('both null: rvol = null', () => {
      const row = buildRawRow({ d: { 'relative_volume_intraday|5': null, 'relative_volume_10d_calc': null } });
      expect(mapTVRow(row).stock.rvol).toBeNull();
    });

    test('intraday present and > 0 wins even if tenDay is higher', () => {
      const row = buildRawRow({ d: { 'relative_volume_intraday|5': 2, 'relative_volume_10d_calc': 10 } });
      expect(mapTVRow(row).stock.rvol).toBe(2);
    });
  });

  // ─── Safe extractors ─────────────────────────────────────────────────────
  describe('safe extractors — num() and str()', () => {
    test('number field returns number', () => {
      const row = buildRawRow({ d: { 'close': 99.5 } });
      expect(mapTVRow(row).stock.price).toBe(99.5);
    });

    test('number field is null → returns null (not NaN)', () => {
      const row = buildRawRow({ d: { 'close': null } });
      expect(mapTVRow(row).stock.price).toBeNull();
    });

    test('number field is unexpected object → returns null', () => {
      const row = buildRawRow({ d: { 'ATR': { value: 5 } } });
      expect(mapTVRow(row).stock.atr).toBeNull();
    });

    test('string field returns string', () => {
      const row = buildRawRow({ d: { 'sector': 'Energy' } });
      expect(mapTVRow(row).stock.sector).toBe('Energy');
    });

    test('string field is null → returns null', () => {
      const row = buildRawRow({ d: { 'sector': null } });
      expect(mapTVRow(row).stock.sector).toBeNull();
    });

    test('string field is object with .name → returns .name', () => {
      const row = buildRawRow({ d: { 'sector': { name: 'Technology', id: 5 } } });
      expect(mapTVRow(row).stock.sector).toBe('Technology');
    });
  });

  // ─── Full field mapping ───────────────────────────────────────────────────
  describe('complete stock field mapping', () => {
    test('all expected fields are present in output', () => {
      const row = buildRawRow();
      const { stock } = mapTVRow(row);
      const expected = ['tvSymbol','price','open','change','vwap','ema9','ema13','ema20','ema50',
        'sma5','monthHigh','monthLow','dayHigh','dayLow','atr','mcap','floatShares','shortFloat',
        'sector','industry','pmHigh','pmLow','rvol',
        'quarterHigh','quarterLow','yearHigh','yearLow','allTimeHigh'];
      for (const field of expected) {
        expect(stock).toHaveProperty(field);
      }
    });

    test('tvSymbol stores full symbol with exchange prefix', () => {
      const row = buildRawRow({ root: { s: 'NYSE:TSLA' } });
      expect(mapTVRow(row).stock.tvSymbol).toBe('NYSE:TSLA');
    });

    test('values match input', () => {
      const row = buildRawRow();
      const { stock } = mapTVRow(row);
      expect(stock.price).toBe(12);
      expect(stock.open).toBe(10);
      expect(stock.change).toBe(5);
      expect(stock.sector).toBe('Technology');
      expect(stock.pmHigh).toBe(13);
      expect(stock.pmLow).toBe(11);
    });

    // The wider ranges feed the card's range bars. Each pair has to come back
    // on the right field: TradingView answers by position in COMMON_COLUMNS,
    // so a column inserted in the wrong place silently shifts every field
    // after it and the year bar would quietly be drawing the quarter.
    test('the wider range columns map to their own fields', () => {
      const { stock } = mapTVRow(buildRawRow());
      expect(stock.monthHigh).toBe(15);
      expect(stock.monthLow).toBe(8);
      expect(stock.quarterHigh).toBe(18);
      expect(stock.quarterLow).toBe(6);
      expect(stock.yearHigh).toBe(24);
      expect(stock.yearLow).toBe(3);
      expect(stock.allTimeHigh).toBe(40);
    });

    test('a missing wider range comes back null, not zero', () => {
      const row = buildRawRow({ d: { 'High.3M': null, 'Low.3M': null, 'High.All': null } });
      const { stock } = mapTVRow(row);
      expect(stock.quarterHigh).toBeNull();
      expect(stock.quarterLow).toBeNull();
      expect(stock.allTimeHigh).toBeNull();
      // and the ones that are present are unaffected
      expect(stock.yearHigh).toBe(24);
    });
  });

});
