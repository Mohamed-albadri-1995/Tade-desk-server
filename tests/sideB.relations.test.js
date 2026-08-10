const { computeRelations, applyRelations, RELATION_FIELDS } = require('../src/sideB/relations');

// A stock in a clean bullish state: price above every level, MAs stacked.
const BULL = {
  price: 10, ema9: 9.5, ema13: 9.2, ema20: 9.0, ema50: 8.0, sma5: 9.4,
  vwap: 9.8, prevClose: 8.0, open: 9.0, pmHigh: 9.9, pmLow: 9.1,
  monthRangePos: 80, pmAdrRatio: 2.4, dayHigh: 10.5, dayLow: 8.5,
};

describe('Side B — relational signals', () => {
  test('flags every level a stock is above', () => {
    const r = computeRelations(BULL);
    expect(r.vsEma9).toBe('above');
    expect(r.vsEma20).toBe('above');
    expect(r.vsVwap).toBe('above');
    expect(r.vsPrevClose).toBe('above');
    expect(r.vsPmHigh).toBe('above');
    expect(r.aboveAllMas).toBe(true);
    expect(r.belowAllMas).toBe(false);
  });

  test('flags below correctly', () => {
    const r = computeRelations({ ...BULL, price: 7 });
    expect(r.vsEma9).toBe('below');
    expect(r.vsEma50).toBe('below');
    expect(r.belowAllMas).toBe(true);
    expect(r.aboveAllMas).toBe(false);
  });

  test('distance keeps the magnitude a flag throws away', () => {
    const near = computeRelations({ ...BULL, price: 9.01, ema20: 9.0 });
    const far  = computeRelations({ ...BULL, price: 12.6, ema20: 9.0 });
    expect(near.vsEma20).toBe('above');
    expect(far.vsEma20).toBe('above');          // same flag …
    expect(near.distEma20).toBeCloseTo(0.111, 2);
    expect(far.distEma20).toBeCloseTo(40, 2);   // … very different fact
  });

  test('distance is signed and relative', () => {
    const r = computeRelations({ ...BULL, price: 8, prevClose: 10 });
    expect(r.distPrevClose).toBeCloseTo(-20, 5);
    expect(r.vsPrevClose).toBe('below');
  });

  describe('moving-average stack', () => {
    test('fully ordered fast-over-slow is bull', () => {
      const r = computeRelations(BULL);
      expect(r.maStack).toBe('bull');
      expect(r.maStackScore).toBe(3);
    });
    test('fully inverted is bear', () => {
      const r = computeRelations({ ...BULL, ema9: 8, ema13: 8.5, ema20: 9, ema50: 9.5 });
      expect(r.maStack).toBe('bear');
      expect(r.maStackScore).toBe(0);
    });
    test('partial ordering is mixed, and the score says how partial', () => {
      const r = computeRelations({ ...BULL, ema9: 9.5, ema13: 9.2, ema20: 8.0, ema50: 8.5 });
      expect(r.maStack).toBe('mixed');
      expect(r.maStackScore).toBe(2);
    });
  });

  describe('month range quarter', () => {
    test.each([[10, 'Q1'], [24.9, 'Q1'], [25, 'Q2'], [60, 'Q3'], [75, 'Q4'], [100, 'Q4']])(
      'position %s%% → %s', (pos, q) => {
        expect(computeRelations({ ...BULL, monthRangePos: pos }).monthQuarter).toBe(q);
      });

    test('lower quarter of the monthly range is Q1', () => {
      expect(computeRelations({ ...BULL, monthRangePos: 12 }).monthQuarter).toBe('Q1');
    });
  });

  describe('pre-market range band', () => {
    test.each([[0.3, '<0.5'], [0.7, '0.5-1'], [1.5, '1-2'], [2.4, '2-3'], [10.6, '3+']])(
      'ratio %s → %s', (ratio, band) => {
        expect(computeRelations({ ...BULL, pmAdrRatio: ratio }).pmAdrBand).toBe(band);
      });
  });

  test('day range position: 0 at the low, 100 at the high', () => {
    expect(computeRelations({ ...BULL, price: 8.5 }).dayRangePos).toBeCloseTo(0, 5);
    expect(computeRelations({ ...BULL, price: 10.5 }).dayRangePos).toBeCloseTo(100, 5);
    expect(computeRelations({ ...BULL, price: 9.5 }).dayRangePos).toBeCloseTo(50, 5);
  });
});

describe('Side B — relations are null-safe', () => {
  test('missing inputs yield null, never NaN', () => {
    const r = computeRelations({ price: 10 });
    expect(r.distEma9).toBeNull();
    expect(r.vsEma9).toBeNull();
    expect(r.maStack).toBeNull();
    expect(r.monthQuarter).toBeNull();
    for (const f of RELATION_FIELDS) {
      expect(Number.isNaN(r[f])).toBe(false);
    }
  });

  test('empty or absent stock does not throw', () => {
    expect(() => computeRelations(null)).not.toThrow();
    expect(() => computeRelations({})).not.toThrow();
    expect(computeRelations({}).aboveAllMas).toBe(false);
  });

  test('a zero reference level does not divide by zero', () => {
    const r = computeRelations({ ...BULL, ema9: 0 });
    expect(r.distEma9).toBeNull();
    expect(r.vsEma9).toBeNull();
  });

  test('all-or-nothing flags need every MA present', () => {
    const r = computeRelations({ price: 10, ema9: 9, ema13: 8, ema20: 7 }); // ema50 missing
    expect(r.aboveAllMas).toBe(false);
    expect(r.maStack).toBeNull();
  });

  test('every declared field is produced', () => {
    const r = computeRelations(BULL);
    for (const f of RELATION_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(r, f)).toBe(true);
    }
  });
});

describe('Side B — applyRelations attaches signals to rows', () => {
  test('adds a signals block without touching stock', () => {
    const rows = [{ ticker: 'AAA', stock: { ...BULL } }];
    const out = applyRelations(rows);
    expect(out[0].signals.vsEma9).toBe('above');
    expect(out[0].stock).toEqual(BULL);       // unchanged
    expect(out[0].ticker).toBe('AAA');
  });

  test('a row with no stock still gets a signals block', () => {
    const out = applyRelations([{ ticker: 'BBB' }]);
    expect(out[0].signals).toBeDefined();
    expect(out[0].signals.vsEma9).toBeNull();
  });
});
