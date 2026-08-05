const { computeDerivedFields } = require('../src/sideB/calculations');

// Helper: round to 6 decimal places to avoid float noise
const r = (n) => Math.round(n * 1e6) / 1e6;

describe('Side B — computeDerivedFields', () => {

  // ─── prevClose ───────────────────────────────────────────────────────────
  describe('prevClose = price / (1 + change/100)', () => {
    test('standard case: price=110, change=+10%', () => {
      const result = computeDerivedFields({ price: 110, change: 10, open: 110, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 120, monthLow: 100 });
      expect(r(result.prevClose)).toBe(r(100));
    });

    test('change = 0 (flat day): prevClose equals price', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(r(result.prevClose)).toBe(r(50));
    });

    test('negative change: price=90, change=-10%', () => {
      const result = computeDerivedFields({ price: 90, change: -10, open: 90, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 100, monthLow: 80 });
      expect(r(result.prevClose)).toBe(r(100));
    });
  });

  // ─── gapPct ──────────────────────────────────────────────────────────────
  describe('gapPct = (open - prevClose) / prevClose * 100', () => {
    test('gap up: open above prevClose', () => {
      // price=110, change=+10% → prevClose=100; open=105 → gapPct=+5%
      const result = computeDerivedFields({ price: 110, change: 10, open: 105, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 120, monthLow: 90 });
      expect(r(result.gapPct)).toBe(r(5));
    });

    test('zero gap: open equals prevClose', () => {
      // price=110, change=+10% → prevClose=100; open=100 → gapPct=0
      const result = computeDerivedFields({ price: 110, change: 10, open: 100, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 120, monthLow: 90 });
      expect(r(result.gapPct)).toBe(r(0));
    });

    test('gap down: open below prevClose', () => {
      // price=90, change=-10% → prevClose=100; open=95 → gapPct=-5%
      const result = computeDerivedFields({ price: 90, change: -10, open: 95, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 100, monthLow: 80 });
      expect(r(result.gapPct)).toBe(r(-5));
    });
  });

  // ─── pmRange ─────────────────────────────────────────────────────────────
  describe('pmRange = pmHigh - pmLow', () => {
    test('normal PM range', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 55, pmLow: 45, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(result.pmRange).toBe(10);
    });

    test('no PM session: pmHigh = pmLow = 0 → pmRange = 0', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(result.pmRange).toBe(0);
    });
  });

  // ─── adrPct ──────────────────────────────────────────────────────────────
  describe('adrPct = atr / price * 100', () => {
    test('standard case: atr=5, price=100 → adrPct=5%', () => {
      const result = computeDerivedFields({ price: 100, change: 0, open: 100, pmHigh: 0, pmLow: 0, atr: 5, monthHigh: 110, monthLow: 90 });
      expect(r(result.adrPct)).toBe(r(5));
    });

    test('large ATR: atr=15, price=50 → adrPct=30%', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 15, monthHigh: 60, monthLow: 40 });
      expect(r(result.adrPct)).toBe(r(30));
    });
  });

  // ─── monthRangePos ───────────────────────────────────────────────────────
  describe('monthRangePos = (price - monthLow) / (monthHigh - monthLow) * 100', () => {
    test('price at midpoint of range → 50%', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(r(result.monthRangePos)).toBe(r(50));
    });

    test('price at high of range → 100%', () => {
      const result = computeDerivedFields({ price: 60, change: 0, open: 60, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(r(result.monthRangePos)).toBe(r(100));
    });

    test('price at low of range → 0%', () => {
      const result = computeDerivedFields({ price: 40, change: 0, open: 40, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 });
      expect(r(result.monthRangePos)).toBe(r(0));
    });

    test('monthHigh === monthLow (no range) → returns 0, not NaN', () => {
      const result = computeDerivedFields({ price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 50, monthLow: 50 });
      expect(result.monthRangePos).toBe(0);
    });
  });

  // ─── quarter / year range positions ──────────────────────────────────────
  // These are display-only, so unlike monthRangePos they are allowed to say
  // "unknown" instead of answering 0 — a bar drawn at 0 reads as "sitting on
  // its low", which is a claim missing data does not support.
  describe('weekRangePos / quarterRangePos / yearRangePos', () => {
    const base = { price: 50, change: 0, open: 50, pmHigh: 0, pmLow: 0, atr: 1, monthHigh: 60, monthLow: 40 };

    test('price at the midpoint of each wider range → 50%', () => {
      const out = computeDerivedFields({ ...base, quarterLow: 40, quarterHigh: 60, yearLow: 0, yearHigh: 100 });
      expect(r(out.quarterRangePos)).toBe(r(50));
      expect(r(out.yearRangePos)).toBe(r(50));
    });

    test('the four ranges are independent — same price, different positions', () => {
      // The whole reason for four bars: 100% of the week and 50% of the year is
      // a different stock from 100% of both, and one bar cannot say which.
      const out = computeDerivedFields({
        ...base, weekLow: 48, weekHigh: 50,     // price 50 → 100% of the week
        monthHigh: 55, monthLow: 45,            //          →  50% of the month
        quarterLow: 30, quarterHigh: 55,        //          →  80% of the quarter
        yearLow: 10, yearHigh: 90,              //          →  50% of the year
      });
      expect(r(out.weekRangePos)).toBe(r(100));
      expect(r(out.monthRangePos)).toBe(r(50));
      expect(r(out.quarterRangePos)).toBe(r(80));
      expect(r(out.yearRangePos)).toBe(r(50));
    });

    test('week uses a trailing five sessions, so a flat week is null not zero', () => {
      const out = computeDerivedFields({ ...base, weekLow: 50, weekHigh: 50 });
      expect(out.weekRangePos).toBeNull();
    });

    test('a missing end → null, so no bar is drawn', () => {
      const out = computeDerivedFields({ ...base, quarterLow: null, quarterHigh: 60 });
      expect(out.quarterRangePos).toBeNull();
    });

    test('absent entirely → null rather than NaN', () => {
      const out = computeDerivedFields(base);
      expect(out.quarterRangePos).toBeNull();
      expect(out.yearRangePos).toBeNull();
    });

    test('a flat range → null, not 0', () => {
      const out = computeDerivedFields({ ...base, quarterLow: 50, quarterHigh: 50 });
      expect(out.quarterRangePos).toBeNull();
    });

    test('an inverted pair is refused rather than returning a negative', () => {
      const out = computeDerivedFields({ ...base, yearLow: 90, yearHigh: 10 });
      expect(out.yearRangePos).toBeNull();
    });

    test('price outside the range is reported honestly, not clamped', () => {
      // Clamping is the card's job — the number should still say "above the
      // year high", because a stock through its 52-week high is the whole point
      // of several of these screeners.
      const out = computeDerivedFields({ ...base, price: 120, yearLow: 0, yearHigh: 100 });
      expect(r(out.yearRangePos)).toBe(r(120));
    });
  });

  // ─── pmAdrRatio ──────────────────────────────────────────────────────────
  describe('pmAdrRatio = pmRange / atr', () => {
    test('standard case: pmRange=10, atr=5 → pmAdrRatio=2', () => {
      const result = computeDerivedFields({ price: 100, change: 0, open: 100, pmHigh: 55, pmLow: 45, atr: 5, monthHigh: 110, monthLow: 90 });
      expect(r(result.pmAdrRatio)).toBe(r(2));
    });

    test('pmRange < atr: pmRange=3, atr=5 → pmAdrRatio=0.6', () => {
      const result = computeDerivedFields({ price: 100, change: 0, open: 100, pmHigh: 103, pmLow: 100, atr: 5, monthHigh: 110, monthLow: 90 });
      expect(r(result.pmAdrRatio)).toBe(r(0.6));
    });

    test('atr = 0 (no ATR data) → returns 0, not Infinity', () => {
      const result = computeDerivedFields({ price: 100, change: 0, open: 100, pmHigh: 105, pmLow: 100, atr: 0, monthHigh: 110, monthLow: 90 });
      expect(result.pmAdrRatio).toBe(0);
    });
  });

  // ─── applyDerivedFields passthrough ─────────────────────────────────────
  describe('output preserves all original stock fields', () => {
    test('all original fields are present in output', () => {
      const stock = { price: 100, change: 5, open: 97, pmHigh: 102, pmLow: 98, atr: 4, monthHigh: 110, monthLow: 90, sector: 'Technology', rvol: 3 };
      const result = computeDerivedFields(stock);
      expect(result.sector).toBe('Technology');
      expect(result.rvol).toBe(3);
      expect(result.price).toBe(100);
    });
  });

});
