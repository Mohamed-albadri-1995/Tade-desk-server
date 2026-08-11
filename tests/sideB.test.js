const { computeDerivedFields } = require('../src/sideB/calculations');

describe('Side B — Internal Calculations', () => {
  test('prevClose: price / (1 + change/100)', () => {
    const stock = { price: 100, change: 10, open: 95, pmHigh: 98, pmLow: 90, atr: 5, monthHigh: 110, monthLow: 80 };
    const r = computeDerivedFields(stock);
    expect(r.prevClose).toBeCloseTo(100 / 1.1, 5);
  });

  test('gapPct: (open - prevClose) / prevClose * 100', () => {
    const prevClose = 100 / 1.1; // ~90.909
    const stock = { price: 100, change: 10, open: 95, pmHigh: 98, pmLow: 90, atr: 5, monthHigh: 110, monthLow: 80 };
    const r = computeDerivedFields(stock);
    expect(r.gapPct).toBeCloseTo(((95 - prevClose) / prevClose) * 100, 4);
  });

  test('pmRange: pmHigh - pmLow', () => {
    const stock = { price: 100, change: 5, open: 99, pmHigh: 20, pmLow: 10, atr: 5, monthHigh: 110, monthLow: 80 };
    const r = computeDerivedFields(stock);
    expect(r.pmRange).toBe(10);
  });

  test('adrPct: atr / price * 100', () => {
    const stock = { price: 50, change: 5, open: 49, pmHigh: 52, pmLow: 48, atr: 5, monthHigh: 60, monthLow: 40 };
    const r = computeDerivedFields(stock);
    expect(r.adrPct).toBeCloseTo((5 / 50) * 100, 5);
  });

  test('monthRangePos: (price - monthLow) / (monthHigh - monthLow) * 100', () => {
    const stock = { price: 50, change: 0, open: 50, pmHigh: 52, pmLow: 48, atr: 2, monthHigh: 70, monthLow: 30 };
    const r = computeDerivedFields(stock);
    expect(r.monthRangePos).toBeCloseTo(((50 - 30) / (70 - 30)) * 100, 5);
  });

  test('monthRangePos: 0 when monthHigh === monthLow', () => {
    const stock = { price: 50, change: 0, open: 50, pmHigh: 52, pmLow: 48, atr: 2, monthHigh: 50, monthLow: 50 };
    const r = computeDerivedFields(stock);
    expect(r.monthRangePos).toBe(0);
  });

  test('pmAdrRatio: pmRange / atr', () => {
    const stock = { price: 100, change: 5, open: 99, pmHigh: 20, pmLow: 5, atr: 5, monthHigh: 110, monthLow: 80 };
    const r = computeDerivedFields(stock);
    expect(r.pmAdrRatio).toBeCloseTo(15 / 5, 5);
  });

  test('pmAdrRatio: 0 when atr is 0', () => {
    const stock = { price: 100, change: 5, open: 99, pmHigh: 20, pmLow: 5, atr: 0, monthHigh: 110, monthLow: 80 };
    const r = computeDerivedFields(stock);
    expect(r.pmAdrRatio).toBe(0);
  });
});
