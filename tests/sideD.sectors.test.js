// Isolate sectors from DB — override getSetting inside the module
// We must mock the db before requiring sectors
jest.mock('../src/db', () => ({
  prepare: () => ({ get: () => null }), // getSetting returns null → use || defaults
}));

const { sectorShortTermBias, hotState, resetHotState } = require('../src/sideD/sectors');

// SPY baseline
const SPY = { change: 0, 'change|1W': 0 };

function mkETF({ change=0, weekChg=0, close=100, sma20=95, sma50=90, vwap=98, adx=20 } = {}) {
  return {
    change,
    'change|1W': weekChg,
    close,
    SMA20: sma20,
    SMA50: sma50,
    VWAP: vwap,
    ADX: adx,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('sectorShortTermBias — Sector Score', () => {

  describe('Condition 1: Close > SMA20', () => {
    test('close > sma20 → c1 = true (bullish signal)', () => {
      // close=100, sma20=95 → c1=T; all others neutral
      const r = sectorShortTermBias('Tech', mkETF({ close: 100, sma20: 95, sma50: 90, vwap: 101, adx: 20 }), SPY);
      expect(r.score).toBeGreaterThan(0);
    });
    test('close < sma20 → c1 = false', () => {
      const below = sectorShortTermBias('Tech', mkETF({ close: 90, sma20: 95, sma50: 85, vwap: 101, adx: 20 }), SPY);
      const above = sectorShortTermBias('Tech', mkETF({ close: 100, sma20: 95, sma50: 85, vwap: 101, adx: 20 }), SPY);
      expect(above.score).toBeGreaterThan(below.score);
    });
  });

  describe('Relative Strength: dRS = sector change - SPY change', () => {
    test('sector outperforms SPY → dRS > 0 → higher score', () => {
      const spyHigh = { change: 2, 'change|1W': 0 };
      const r = sectorShortTermBias('Tech', mkETF({ change: 3 }), spyHigh);
      expect(r.dRS).toBeCloseTo(1, 5);
    });
    test('sector underperforms SPY → dRS < 0', () => {
      const spyHigh = { change: 3, 'change|1W': 0 };
      const r = sectorShortTermBias('Tech', mkETF({ change: 1 }), spyHigh);
      expect(r.dRS).toBeCloseTo(-2, 5);
    });
  });

  describe('ADX amplifier', () => {
    test('ADX > 25 → stronger trend signal (higher abs score)', () => {
      const strong = sectorShortTermBias('Tech', mkETF({ adx: 30, change: 3, close: 100, sma20: 95, sma50: 90, vwap: 95 }), SPY);
      const weak   = sectorShortTermBias('Tech', mkETF({ adx: 10, change: 3, close: 100, sma20: 95, sma50: 90, vwap: 95 }), SPY);
      expect(Math.abs(strong.score)).toBeGreaterThan(Math.abs(weak.score));
    });
  });

  describe('Score range and classification', () => {
    test('score is always within [-100, +100]', () => {
      const r = sectorShortTermBias('Tech', mkETF({ change: 100, adx: 50 }), SPY);
      expect(r.score).toBeGreaterThanOrEqual(-100);
      expect(r.score).toBeLessThanOrEqual(100);
    });

    test('all bearish conditions → BEARISH bias (default threshold -20)', () => {
      // close below sma20, sma20 below sma50, below vwap, sector below SPY, negative week
      const spyUp = { change: 5, 'change|1W': 3 };
      const r = sectorShortTermBias('Tech', mkETF({ close: 80, sma20: 90, sma50: 95, vwap: 95, change: -3, weekChg: -2, adx: 25 }), spyUp);
      expect(r.bias).toBe('BEARISH');
    });

    test('all bullish conditions → BULLISH bias (default threshold +20)', () => {
      const spyDown = { change: -1, 'change|1W': -1 };
      const r = sectorShortTermBias('Tech', mkETF({ close: 100, sma20: 90, sma50: 85, vwap: 95, change: 3, weekChg: 2, adx: 30 }), spyDown);
      expect(r.bias).toBe('BULLISH');
    });

    test('returns dRS and wRS fields', () => {
      const r = sectorShortTermBias('Tech', mkETF(), SPY);
      expect(r).toHaveProperty('dRS');
      expect(r).toHaveProperty('wRS');
      expect(r).toHaveProperty('adx');
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('Hot Sector State Machine (spec §3.3)', () => {
  // DB mock returns null → getSetting uses || defaults:
  // hotImmediate=60, hotSustained=40, hotSustainedN=3, hotFloor=20, coolOff=2

  // We call updateHotSector indirectly via sectorShortTermBias → computeAllSectors
  // But updateHotSector is not exported. Test via hotState observation.
  // Instead we import and test the exported resetHotState:

  test('resetHotState clears all hot state entries', () => {
    // Seed hotState manually
    hotState['TestSector'] = { hot: true, consecutiveSessions: 3, coolOffSessions: 0 };
    hotState['OtherSector'] = { hot: false, consecutiveSessions: 1, coolOffSessions: 0 };
    resetHotState();
    expect(Object.keys(hotState)).toHaveLength(0);
  });

  test('resetHotState on already-empty state does not throw', () => {
    resetHotState();
    expect(() => resetHotState()).not.toThrow();
    expect(Object.keys(hotState)).toHaveLength(0);
  });
});
