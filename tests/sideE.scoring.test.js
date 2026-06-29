jest.mock('../src/db', () => ({
  prepare: () => ({ get: () => null }), // loadScoringModel returns null → use defaults
}));

const { scoreRow, scoreAllRows } = require('../src/sideE/scoring');

// Default scoring model weights (from loadScoringModel fallback):
// rvol: { weight:15, threshold:5 }
// gapPct: { weight:10, threshold:5 }
// adrPct: { weight:10, threshold:15 }
// pmRange: { weight:10, threshold:3 }
// regimeLong: { weight:15 }
// sectorBias: { weight:15 }
// sectorHot: { weight:10 }
// catalyst: { weight:15 }

function mkRow({ rvol=null, gapPct=null, adrPct=null, pmRange=null, atr=null,
                 regime=null, secBias=null, secHot=false, catalystSentiment=null } = {}) {
  return {
    stock: { rvol, gapPct, adrPct, pmRange, atr },
    context: regime || secBias || secHot ? {
      regime,
      secBias,
      secHot,
    } : null,
    catalyst: catalystSentiment ? { sentiment: catalystSentiment } : null,
  };
}

describe('Side E — scoreRow', () => {

  test('no stock data → score = 0 (all factors null)', () => {
    const r = scoreRow(mkRow());
    expect(r).toBe(0);
  });

  test('missing stock field → scoreRow returns null', () => {
    const r = scoreRow({ context: null, catalyst: null });
    expect(r).toBeNull();
  });

  // ─── RVOL ───────────────────────────────────────────────────────────────
  describe('RVOL factor (weight=15, threshold=5)', () => {
    test('rvol >= 5 → +15', () => {
      const r = scoreRow(mkRow({ rvol: 5 }));
      expect(r).toBe(15);
    });
    test('rvol = 6 → +15', () => {
      expect(scoreRow(mkRow({ rvol: 6 }))).toBe(15);
    });
    test('rvol >= 2 and < 5 → +7 (half weight)', () => {
      expect(scoreRow(mkRow({ rvol: 3 }))).toBe(Math.round(15 * 0.5));
    });
    test('rvol < 2 → 0', () => {
      expect(scoreRow(mkRow({ rvol: 1.5 }))).toBe(0);
    });
    test('rvol = null → 0 (no contribution)', () => {
      expect(scoreRow(mkRow({ rvol: null }))).toBe(0);
    });
  });

  // ─── Gap Pct ────────────────────────────────────────────────────────────
  describe('GapPct factor (weight=10, threshold=5)', () => {
    test('|gapPct| >= 5 → +10', () => {
      expect(scoreRow(mkRow({ gapPct: 5 }))).toBe(10);
    });
    test('negative gap >= 5% abs → +10', () => {
      expect(scoreRow(mkRow({ gapPct: -5 }))).toBe(10);
    });
    test('|gapPct| >= 2 and < 5 → +5 (half)', () => {
      expect(scoreRow(mkRow({ gapPct: 3 }))).toBe(Math.round(10 * 0.5));
    });
    test('|gapPct| < 2 → 0', () => {
      expect(scoreRow(mkRow({ gapPct: 1 }))).toBe(0);
    });
  });

  // ─── ADR Pct ────────────────────────────────────────────────────────────
  describe('ADRPct factor (weight=10, threshold=15)', () => {
    test('adrPct >= 15 → +10', () => {
      expect(scoreRow(mkRow({ adrPct: 15 }))).toBe(10);
    });
    test('adrPct >= 8 and < 15 → +5 (half)', () => {
      expect(scoreRow(mkRow({ adrPct: 10 }))).toBe(Math.round(10 * 0.5));
    });
    test('adrPct < 8 → 0', () => {
      expect(scoreRow(mkRow({ adrPct: 5 }))).toBe(0);
    });
  });

  // ─── PM Range ───────────────────────────────────────────────────────────
  describe('PM Range factor (weight=10, threshold=3)', () => {
    test('pmRange/atr >= 3 → +10', () => {
      expect(scoreRow(mkRow({ pmRange: 30, atr: 10 }))).toBe(10);
    });
    test('pmRange/atr >= 1 and < 3 → +5 (half)', () => {
      expect(scoreRow(mkRow({ pmRange: 15, atr: 10 }))).toBe(Math.round(10 * 0.5));
    });
    test('pmRange/atr < 1 → 0', () => {
      expect(scoreRow(mkRow({ pmRange: 5, atr: 10 }))).toBe(0);
    });
    test('atr = null → no PM contribution', () => {
      expect(scoreRow(mkRow({ pmRange: 30, atr: null }))).toBe(0);
    });
  });

  // ─── Regime ─────────────────────────────────────────────────────────────
  describe('Regime factor (weight=15)', () => {
    const bullishRegimes = ['STRONG_UP', 'UP', 'EXTENDED_UP', 'PULLBACK_BULL', 'WEAK_UP'];
    const bearishRegimes = ['STRONG_DOWN', 'DOWN', 'CAPITULATION', 'TOPPING'];

    bullishRegimes.forEach(slug => {
      test(`regime ${slug} → +15`, () => {
        expect(scoreRow(mkRow({ regime: slug }))).toBe(15);
      });
    });

    bearishRegimes.forEach(slug => {
      test(`regime ${slug} → +0 (no points)`, () => {
        expect(scoreRow(mkRow({ regime: slug }))).toBe(0);
      });
    });

    test('neutral regime (e.g. CORRECTION) → +6 (40% of 15)', () => {
      expect(scoreRow(mkRow({ regime: 'CORRECTION' }))).toBe(Math.round(15 * 0.4));
    });
  });

  // ─── Sector Bias ────────────────────────────────────────────────────────
  describe('Sector Bias factor (weight=15)', () => {
    test('secBias = BULLISH → +15', () => {
      expect(scoreRow(mkRow({ secBias: 'BULLISH' }))).toBe(15);
    });
    test('secBias = NEUTRAL → +4 (30% of 15)', () => {
      expect(scoreRow(mkRow({ secBias: 'NEUTRAL' }))).toBe(Math.round(15 * 0.3));
    });
    test('secBias = BEARISH → 0', () => {
      expect(scoreRow(mkRow({ secBias: 'BEARISH' }))).toBe(0);
    });
  });

  // ─── Sector Hot ─────────────────────────────────────────────────────────
  describe('Sector Hot factor (weight=10)', () => {
    test('secHot = true → +10', () => {
      expect(scoreRow(mkRow({ secHot: true }))).toBe(10);
    });
    test('secHot = false → 0', () => {
      expect(scoreRow(mkRow({ secHot: false }))).toBe(0);
    });
  });

  // ─── Catalyst ───────────────────────────────────────────────────────────
  describe('Catalyst factor (weight=15)', () => {
    test('bull catalyst → +15', () => {
      expect(scoreRow(mkRow({ catalystSentiment: 'bull' }))).toBe(15);
    });
    test('bear catalyst → -15 (but clamped to 0 since only factor)', () => {
      expect(scoreRow(mkRow({ catalystSentiment: 'bear' }))).toBe(0);
    });
  });

  // ─── Score clamp ────────────────────────────────────────────────────────
  describe('Score clamped to [0, 100]', () => {
    test('all factors max → score = 100 (clamp)', () => {
      // rvol>=5 (+15), gapPct>=5 (+10), adrPct>=15 (+10), pmRange/atr>=3 (+10),
      // STRONG_UP (+15), BULLISH (+15), hot (+10), bull catalyst (+15) = 100
      const row = {
        stock: { rvol: 10, gapPct: 10, adrPct: 20, pmRange: 30, atr: 5 },
        context: { regime: 'STRONG_UP', secBias: 'BULLISH', secHot: true },
        catalyst: { sentiment: 'bull' },
      };
      expect(scoreRow(row)).toBe(100);
    });

    test('bear catalyst cannot push score below 0', () => {
      const row = {
        stock: { rvol: null, gapPct: null, adrPct: null, pmRange: null, atr: null },
        context: null,
        catalyst: { sentiment: 'bear' },
      };
      expect(scoreRow(row)).toBe(0);
    });
  });

  // ─── scoreAllRows ────────────────────────────────────────────────────────
  describe('scoreAllRows', () => {
    test('adds _score to each row', () => {
      const rows = [
        { stock: { rvol: 10, gapPct: null, adrPct: null, pmRange: null, atr: null }, context: null, catalyst: null },
        { stock: { rvol: null, gapPct: null, adrPct: null, pmRange: null, atr: null }, context: null, catalyst: null },
      ];
      const result = scoreAllRows(rows);
      expect(result[0]).toHaveProperty('_score');
      expect(result[1]).toHaveProperty('_score');
      expect(result[0]._score).toBe(15);
      expect(result[1]._score).toBe(0);
    });
  });
});
