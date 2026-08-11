const {
  computeMarketBiasDetail,
  computeMarketStage,
  computeLongTermBias,
  computeRegime,
  REGIME_MATRIX,
} = require('../src/sideD/regime');

describe('Short-Term Market Bias — computeMarketBiasDetail()', () => {
  function makeIndices(overrides = {}) {
    return {
      SPY: { change: 0, 'change|1W': 0, ...overrides.SPY },
      QQQ: { change: 0, 'change|1W': 0, ...overrides.QQQ },
      IWM: { change: 0, ...overrides.IWM },
      VIX: { change: 0, ...overrides.VIX },
    };
  }

  // Signal 1 — SPY daily
  test('SPY +0.31% → signal +1', () => {
    const r = computeMarketBiasDetail(makeIndices({ SPY: { change: 0.31 } }));
    const spySig = r.signals.find(s => s.name === 'SPY Day');
    expect(spySig.value).toBe(1);
  });

  test('SPY +0.30% → signal 0 (boundary)', () => {
    const r = computeMarketBiasDetail(makeIndices({ SPY: { change: 0.30 } }));
    const spySig = r.signals.find(s => s.name === 'SPY Day');
    expect(spySig.value).toBe(0);
  });

  test('SPY -0.31% → signal -1', () => {
    const r = computeMarketBiasDetail(makeIndices({ SPY: { change: -0.31 } }));
    const spySig = r.signals.find(s => s.name === 'SPY Day');
    expect(spySig.value).toBe(-1);
  });

  // Signal 4 — VIX
  test('VIX +3.1% → signal -2', () => {
    const r = computeMarketBiasDetail(makeIndices({ VIX: { change: 3.1 } }));
    const vixSig = r.signals.find(s => s.name === 'VIX');
    expect(vixSig.value).toBe(-2);
  });

  test('VIX +3.0% → signal -1 (not -2)', () => {
    const r = computeMarketBiasDetail(makeIndices({ VIX: { change: 3.0 } }));
    const vixSig = r.signals.find(s => s.name === 'VIX');
    expect(vixSig.value).toBe(-1);
  });

  test('VIX +1.0% → signal 0 (not -1)', () => {
    const r = computeMarketBiasDetail(makeIndices({ VIX: { change: 1.0 } }));
    const vixSig = r.signals.find(s => s.name === 'VIX');
    expect(vixSig.value).toBe(0);
  });

  test('VIX -2.1% → signal +1', () => {
    const r = computeMarketBiasDetail(makeIndices({ VIX: { change: -2.1 } }));
    const vixSig = r.signals.find(s => s.name === 'VIX');
    expect(vixSig.value).toBe(1);
  });

  // Classification
  test('score >= 3 → BULLISH', () => {
    const r = computeMarketBiasDetail(makeIndices({
      SPY: { change: 0.5, 'change|1W': 1.5 },
      QQQ: { change: 0.5, 'change|1W': 1.5 },
      IWM: { change: 0.5 },
      VIX: { change: -2.5 },
    }));
    expect(r.result).toBe('BULLISH');
    expect(r.score).toBeGreaterThanOrEqual(3);
  });

  test('score <= -3 → BEARISH', () => {
    const r = computeMarketBiasDetail(makeIndices({
      SPY: { change: -0.5, 'change|1W': -1.5 },
      QQQ: { change: -0.5, 'change|1W': -1.5 },
      IWM: { change: -0.5 },
      VIX: { change: 3.5 },
    }));
    expect(r.result).toBe('BEARISH');
  });

  test('score between -2 and 2 → NEUTRAL', () => {
    const r = computeMarketBiasDetail(makeIndices());
    expect(r.result).toBe('NEUTRAL');
  });
});

describe('Mid-Term Stage — computeMarketStage()', () => {
  function makeIndices(overrides = {}) {
    return {
      SPY: {
        close: 100,
        SMA5: 98,
        SMA20: 95,
        SMA50: 90,
        SMA200: 80,
        'BB.upper': 110,
        'BB.lower': 85,
        ...overrides,
      },
    };
  }

  test('UPTREND when bullCount >= 5', () => {
    const r = computeMarketStage(makeIndices({ close: 100, SMA5: 98, SMA20: 95, SMA50: 90, SMA200: 80 }));
    expect(r.bull).toBeGreaterThanOrEqual(5);
    expect(r.result).toBe('UPTREND');
  });

  test('DOWNTREND when bullCount <= 1', () => {
    const r = computeMarketStage(makeIndices({ close: 80, SMA5: 95, SMA20: 98, SMA50: 100, SMA200: 102 }));
    expect(r.result).toBe('DOWNTREND');
  });

  test('BB% >= 0.75 → bb = UPPER', () => {
    const r = computeMarketStage(makeIndices({ close: 109, 'BB.upper': 110, 'BB.lower': 85 }));
    const bbPct = (109 - 85) / (110 - 85);
    expect(bbPct).toBeGreaterThanOrEqual(0.75);
    expect(r.bb).toBe('UPPER');
  });

  test('BB% <= 0.25 → bb = LOWER', () => {
    const r = computeMarketStage(makeIndices({ close: 86, 'BB.upper': 110, 'BB.lower': 85 }));
    const bbPct = (86 - 85) / (110 - 85);
    expect(bbPct).toBeLessThanOrEqual(0.25);
    expect(r.bb).toBe('LOWER');
  });
});

describe('Long-Term Bias — computeLongTermBias()', () => {
  function makeIndices(close, sma50, sma200) {
    return { SPY: { close, SMA50: sma50, SMA200: sma200 } };
  }

  test('Above200=T, GoldenCross=T → BULLISH', () => {
    expect(computeLongTermBias(makeIndices(210, 205, 200)).result).toBe('BULLISH');
  });

  test('Above200=T, GoldenCross=F → RECOVERING', () => {
    expect(computeLongTermBias(makeIndices(210, 195, 200)).result).toBe('RECOVERING');
  });

  test('Above200=F, GoldenCross=T → WEAKENING', () => {
    expect(computeLongTermBias(makeIndices(195, 205, 200)).result).toBe('WEAKENING');
  });

  test('Above200=F, GoldenCross=F → BEARISH', () => {
    expect(computeLongTermBias(makeIndices(190, 195, 200)).result).toBe('BEARISH');
  });
});

describe('Regime Matrix — computeRegime()', () => {
  test('BULLISH + UPTREND → STRONG_UP', () => {
    const lt = { result: 'BULLISH' };
    const mt = { result: 'UPTREND' };
    const r = computeRegime(lt, mt, 'MID');
    expect(r.slug).toBe('STRONG_UP');
  });

  test('BULLISH + UPTREND + BB UPPER → EXTENDED_UP', () => {
    const lt = { result: 'BULLISH' };
    const mt = { result: 'UPTREND' };
    const r = computeRegime(lt, mt, 'UPPER');
    expect(r.slug).toBe('EXTENDED_UP');
  });

  test('BEARISH + DOWNTREND → STRONG_DOWN', () => {
    const lt = { result: 'BEARISH' };
    const mt = { result: 'DOWNTREND' };
    const r = computeRegime(lt, mt, 'MID');
    expect(r.slug).toBe('STRONG_DOWN');
  });

  test('BEARISH + DOWNTREND + BB LOWER → CAPITULATION', () => {
    const lt = { result: 'BEARISH' };
    const mt = { result: 'DOWNTREND' };
    const r = computeRegime(lt, mt, 'LOWER');
    expect(r.slug).toBe('CAPITULATION');
  });

  test('BULLISH + PULLBACK → PULLBACK_BULL', () => {
    const lt = { result: 'BULLISH' };
    const mt = { result: 'PULLBACK' };
    const r = computeRegime(lt, mt, 'MID');
    expect(r.slug).toBe('PULLBACK_BULL');
  });

  test('BULLISH + DOWNTREND → CORRECTION', () => {
    const lt = { result: 'BULLISH' };
    const mt = { result: 'DOWNTREND' };
    const r = computeRegime(lt, mt, 'MID');
    expect(r.slug).toBe('CORRECTION');
  });

  test('All REGIME_MATRIX cells exist', () => {
    const lts = ['BULLISH', 'RECOVERING', 'WEAKENING', 'BEARISH'];
    const mts = ['UPTREND', 'PULLBACK', 'REBOUND', 'SIDEWAYS', 'DOWNTREND'];
    for (const lt of lts) {
      for (const mt of mts) {
        const r = computeRegime({ result: lt }, { result: mt }, 'MID');
        expect(r.slug).toBeTruthy();
        expect(r.label).toBeTruthy();
        expect(r.stance).toMatch(/^(LONG|NEUTRAL|SHORT)$/);
      }
    }
  });
});
