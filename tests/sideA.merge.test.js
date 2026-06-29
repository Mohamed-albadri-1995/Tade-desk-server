const { mergeScannersIntoR0 } = require('../src/sideA/merge');

function makeRow(ticker, stockOverrides = {}) {
  return {
    ticker,
    stock: {
      price: 10, change: 5, sector: 'Technology',
      rvol: 3, atr: 1, vwap: null,
      ...stockOverrides,
    },
  };
}

describe('Side A — mergeScannersIntoR0', () => {

  // ─── screenerKeys ─────────────────────────────────────────────────────────
  describe('screenerKeys assignment', () => {
    test('trend scanner → screenerKey "Trend"', () => {
      const result = mergeScannersIntoR0({ trend: [makeRow('AAPL')] });
      expect(result[0].screenerKeys).toContain('Trend');
    });

    test('premarket scanner → screenerKey "Pre-Mkt"', () => {
      const result = mergeScannersIntoR0({ premarket: [makeRow('AAPL')] });
      expect(result[0].screenerKeys).toContain('Pre-Mkt');
    });

    test('bigmoves scanner → screenerKey "Big Move"', () => {
      const result = mergeScannersIntoR0({ bigmoves: [makeRow('AAPL')] });
      expect(result[0].screenerKeys).toContain('Big Move');
    });

    test('same ticker in trend + bigmoves → screenerKeys union, no duplicate', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL')],
        bigmoves: [makeRow('AAPL')],
      });
      expect(result).toHaveLength(1);
      expect(result[0].screenerKeys).toContain('Trend');
      expect(result[0].screenerKeys).toContain('Big Move');
      expect(result[0].screenerKeys).toHaveLength(2);
    });

    test('same ticker in all three → screenerKeys has all three labels', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL')],
        premarket: [makeRow('AAPL')],
        bigmoves: [makeRow('AAPL')],
      });
      expect(result[0].screenerKeys).toEqual(expect.arrayContaining(['Trend', 'Pre-Mkt', 'Big Move']));
      expect(result[0].screenerKeys).toHaveLength(3);
    });
  });

  // ─── deduplication ────────────────────────────────────────────────────────
  describe('deduplication by ticker', () => {
    test('two different tickers → two rows', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL'), makeRow('MSFT')],
      });
      expect(result).toHaveLength(2);
    });

    test('same ticker in same scanner → only one row (first wins)', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL', { price: 100 }), makeRow('AAPL', { price: 200 })],
      });
      expect(result).toHaveLength(1);
      expect(result[0].stock.price).toBe(100);
    });
  });

  // ─── field prioritization (keep first non-null) ───────────────────────────
  describe('stock field prioritization — keep first non-null', () => {
    test('trend has vwap=null, bigmoves has vwap=15 → vwap=15 kept', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL', { vwap: null })],
        bigmoves: [makeRow('AAPL', { vwap: 15 })],
      });
      expect(result[0].stock.vwap).toBe(15);
    });

    test('trend has vwap=12, bigmoves has vwap=15 → trend vwap=12 wins (first non-null)', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL', { vwap: 12 })],
        bigmoves: [makeRow('AAPL', { vwap: 15 })],
      });
      expect(result[0].stock.vwap).toBe(12);
    });

    test('all null for a field → remains null', () => {
      const result = mergeScannersIntoR0({
        trend: [makeRow('AAPL', { vwap: null })],
        bigmoves: [makeRow('AAPL', { vwap: null })],
      });
      expect(result[0].stock.vwap).toBeNull();
    });
  });

  // ─── empty and missing scanners ──────────────────────────────────────────
  describe('empty and missing scanners', () => {
    test('empty input → empty output', () => {
      expect(mergeScannersIntoR0({})).toEqual([]);
    });

    test('all scanners empty → empty output', () => {
      expect(mergeScannersIntoR0({ trend: [], premarket: [], bigmoves: [] })).toEqual([]);
    });

    test('only one scanner has results', () => {
      const result = mergeScannersIntoR0({ trend: [makeRow('AAPL')], premarket: [], bigmoves: [] });
      expect(result).toHaveLength(1);
    });
  });

  // ─── output shape ────────────────────────────────────────────────────────
  describe('output shape', () => {
    test('each row has ticker, stock, screenerKeys', () => {
      const result = mergeScannersIntoR0({ trend: [makeRow('AAPL')] });
      expect(result[0]).toHaveProperty('ticker');
      expect(result[0]).toHaveProperty('stock');
      expect(result[0]).toHaveProperty('screenerKeys');
    });
  });

});
