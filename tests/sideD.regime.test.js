const {
  computeMarketBiasDetail,
  computeMarketStage,
  computeLongTermBias,
  computeRegime,
  REGIME_MATRIX,
} = require('../src/sideD/regime');

// Helper to build index input
function mkIdx({ spyDay=0, qqqDay=0, iwmDay=0, vixDay=0, spyWeek=0, qqqWeek=0,
                  close=100, sma5=90, sma20=85, sma50=80, sma200=70, bbUpper=110, bbLower=90 } = {}) {
  return {
    SPY: { change: spyDay, 'change|1W': spyWeek, close, SMA5: sma5, SMA20: sma20, SMA50: sma50, SMA200: sma200, 'BB.upper': bbUpper, 'BB.lower': bbLower },
    QQQ: { change: qqqDay, 'change|1W': qqqWeek },
    IWM: { change: iwmDay },
    VIX: { change: vixDay },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
describe('computeMarketBiasDetail — Short-Term Bias (spec §2)', () => {

  describe('Signal 1-3: SPY/QQQ/IWM daily change threshold ±0.3%', () => {
    test('SPY +0.31% → sig1 = +1', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: 0.31 }));
      expect(r.signals.find(s => s.name === 'SPY Day').value).toBe(1);
    });
    test('SPY +0.30% → sig1 = 0 (exact boundary, not above)', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: 0.30 }));
      expect(r.signals.find(s => s.name === 'SPY Day').value).toBe(0);
    });
    test('SPY -0.31% → sig1 = -1', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: -0.31 }));
      expect(r.signals.find(s => s.name === 'SPY Day').value).toBe(-1);
    });
    test('SPY -0.30% → sig1 = 0 (exact boundary, not below)', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: -0.30 }));
      expect(r.signals.find(s => s.name === 'SPY Day').value).toBe(0);
    });
  });

  describe('Signal 4: VIX asymmetric weighting', () => {
    test('VIX +3.01% → sig4 = -2', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: 3.01 }));
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(-2);
    });
    test('VIX +3.00% → sig4 = -2 (>3 check, exactly 3 gives -1)', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: 3.00 }));
      // 3 is not > 3, but is > 1 → sig4 = -1
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(-1);
    });
    test('VIX +1.5% → sig4 = -1', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: 1.5 }));
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(-1);
    });
    test('VIX -2.01% → sig4 = +1', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: -2.01 }));
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(1);
    });
    test('VIX -2.00% → sig4 = 0 (< -2 required)', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: -2.00 }));
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(0);
    });
    test('VIX +0.5% → sig4 = 0', () => {
      const r = computeMarketBiasDetail(mkIdx({ vixDay: 0.5 }));
      expect(r.signals.find(s => s.name === 'VIX').value).toBe(0);
    });
  });

  describe('Signal 5-6: weekly change threshold ±1%', () => {
    test('SPY week +1.01% → sig5 = +1', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyWeek: 1.01 }));
      expect(r.signals.find(s => s.name === 'SPY Week').value).toBe(1);
    });
    test('SPY week +1.00% → sig5 = 0 (exact boundary)', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyWeek: 1.00 }));
      expect(r.signals.find(s => s.name === 'SPY Week').value).toBe(0);
    });
    test('SPY week -1.01% → sig5 = -1', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyWeek: -1.01 }));
      expect(r.signals.find(s => s.name === 'SPY Week').value).toBe(-1);
    });
  });

  describe('Final classification (score threshold ±3)', () => {
    test('score >= +3 → BULLISH', () => {
      // SPY day +1, QQQ day +1, IWM day +1 → score=3
      const r = computeMarketBiasDetail(mkIdx({ spyDay: 0.5, qqqDay: 0.5, iwmDay: 0.5 }));
      expect(r.result).toBe('BULLISH');
      expect(r.score).toBe(3);
    });
    test('score = +2 → NEUTRAL', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: 0.5, qqqDay: 0.5 }));
      expect(r.result).toBe('NEUTRAL');
      expect(r.score).toBe(2);
    });
    test('score <= -3 → BEARISH', () => {
      const r = computeMarketBiasDetail(mkIdx({ spyDay: -0.5, qqqDay: -0.5, iwmDay: -0.5 }));
      expect(r.result).toBe('BEARISH');
      expect(r.score).toBe(-3);
    });
    test('all zero → NEUTRAL, score=0', () => {
      const r = computeMarketBiasDetail(mkIdx());
      expect(r.result).toBe('NEUTRAL');
      expect(r.score).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeMarketStage — Mid-Term (spec §3)', () => {

  test('all 6 signals bull → UPTREND', () => {
    // close > sma5 > sma20 > sma50 (bullCount=6)
    const r = computeMarketStage(mkIdx({ close: 100, sma5: 95, sma20: 90, sma50: 85, sma200: 70 }));
    expect(r.result).toBe('UPTREND');
    expect(r.bull).toBe(6);
  });

  test('bullCount=4, close>sma5 → UPTREND', () => {
    // close=100 > sma5=95 > sma20=90, but sma20 < sma50 kills s4, and s5/s6 are proxied from same
    // s1=T, s2=T, s3=T, s4=F(sma20<sma50), s5=T(proxy=s2), s6=T(proxy=s3) → bull=5 → UPTREND
    // To get bull=4 with CA5=true: need exactly 4 T and close>sma5
    // s1(close>sma5)=T, s2(close>sma20)=T, s3(sma5>sma20)=F, s4(sma20>sma50)=T,
    // s5=s2=T, s6=s3=F → bull=4, CA5=true → UPTREND
    const r = computeMarketStage({ SPY: { close: 100, SMA5: 98, SMA20: 95, SMA50: 90, SMA200: 70, 'BB.upper': 110, 'BB.lower': 85 } });
    expect(r.result).toBe('UPTREND');
  });

  test('DOWNTREND when bullCount=0', () => {
    // close below all MAs
    const r = computeMarketStage(mkIdx({ close: 60, sma5: 70, sma20: 75, sma50: 80, sma200: 85 }));
    expect(r.result).toBe('DOWNTREND');
    expect(r.bull).toBe(0);
  });

  describe('Bollinger position (spec §4)', () => {
    test('BB% >= 0.75 → UPPER', () => {
      // close=108, lower=90, upper=110 → BB%=(108-90)/(110-90)=18/20=0.9
      const r = computeMarketStage(mkIdx({ close: 108, bbLower: 90, bbUpper: 110 }));
      expect(r.bb).toBe('UPPER');
    });
    test('BB% <= 0.25 → LOWER', () => {
      // close=94, lower=90, upper=110 → BB%=(94-90)/(110-90)=4/20=0.2
      const r = computeMarketStage(mkIdx({ close: 94, bbLower: 90, bbUpper: 110 }));
      expect(r.bb).toBe('LOWER');
    });
    test('BB% in middle → MID', () => {
      // close=100, lower=90, upper=110 → BB%=0.5
      const r = computeMarketStage(mkIdx({ close: 100, bbLower: 90, bbUpper: 110 }));
      expect(r.bb).toBe('MID');
    });
    test('BB range = 0 → default to 0.5 (MID)', () => {
      const r = computeMarketStage(mkIdx({ bbLower: 100, bbUpper: 100 }));
      expect(r.bb).toBe('MID');
    });
  });

  test('uses SPY if present, QQQ as fallback', () => {
    const withSPY = computeMarketStage(mkIdx());
    expect(withSPY.src).toBe('SPY');
    const withoutSPY = computeMarketStage({ QQQ: { close: 100, SMA5: 95, SMA20: 90, SMA50: 85, SMA200: 70, 'BB.upper': 110, 'BB.lower': 80 } });
    expect(withoutSPY.src).toBe('QQQ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeLongTermBias — Long-Term (spec §5)', () => {
  test('above200=T, goldenCross=T → BULLISH', () => {
    const r = computeLongTermBias(mkIdx({ close: 100, sma50: 90, sma200: 80 }));
    expect(r.result).toBe('BULLISH');
    expect(r.above200).toBe(true);
    expect(r.goldenCross).toBe(true);
  });
  test('above200=T, goldenCross=F → RECOVERING', () => {
    const r = computeLongTermBias(mkIdx({ close: 100, sma50: 75, sma200: 80 }));
    expect(r.result).toBe('RECOVERING');
  });
  test('above200=F, goldenCross=T → WEAKENING', () => {
    const r = computeLongTermBias(mkIdx({ close: 70, sma50: 90, sma200: 80 }));
    expect(r.result).toBe('WEAKENING');
  });
  test('above200=F, goldenCross=F → BEARISH', () => {
    const r = computeLongTermBias(mkIdx({ close: 70, sma50: 75, sma200: 80 }));
    expect(r.result).toBe('BEARISH');
  });
  test('dist calculation: (close - sma200) / sma200 * 100', () => {
    const r = computeLongTermBias(mkIdx({ close: 110, sma200: 100 }));
    expect(r.dist).toBeCloseTo(10, 4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('computeRegime — Regime Matrix (spec §6)', () => {
  function mkLT(result) { return { result }; }
  function mkMT(result, bb='MID') { return { result, bb }; }

  test('BULLISH + UPTREND → STRONG_UP', () => {
    const r = computeRegime(mkLT('BULLISH'), mkMT('UPTREND'));
    expect(r.slug).toBe('STRONG_UP');
  });
  test('BULLISH + DOWNTREND → CORRECTION', () => {
    const r = computeRegime(mkLT('BULLISH'), mkMT('DOWNTREND'));
    expect(r.slug).toBe('CORRECTION');
  });
  test('BEARISH + DOWNTREND → STRONG_DOWN', () => {
    const r = computeRegime(mkLT('BEARISH'), mkMT('DOWNTREND'));
    expect(r.slug).toBe('STRONG_DOWN');
  });
  test('BULLISH + PULLBACK → PULLBACK_BULL', () => {
    const r = computeRegime(mkLT('BULLISH'), mkMT('PULLBACK'));
    expect(r.slug).toBe('PULLBACK_BULL');
  });
  test('WEAKENING + PULLBACK → TOPPING', () => {
    const r = computeRegime(mkLT('WEAKENING'), mkMT('PULLBACK'));
    expect(r.slug).toBe('TOPPING');
  });

  describe('Bollinger adjustments', () => {
    test('STRONG_UP + BB UPPER → EXTENDED_UP', () => {
      const mt = mkMT('UPTREND', 'UPPER');
      const r = computeRegime(mkLT('BULLISH'), mt, mt.bb);
      expect(r.slug).toBe('EXTENDED_UP');
    });
    test('STRONG_UP + BB MID → stays STRONG_UP', () => {
      const mt = mkMT('UPTREND', 'MID');
      const r = computeRegime(mkLT('BULLISH'), mt, mt.bb);
      expect(r.slug).toBe('STRONG_UP');
    });
    test('STRONG_DOWN + BB LOWER → CAPITULATION', () => {
      const mt = mkMT('DOWNTREND', 'LOWER');
      const r = computeRegime(mkLT('BEARISH'), mt, mt.bb);
      expect(r.slug).toBe('CAPITULATION');
    });
    test('STRONG_DOWN + BB MID → stays STRONG_DOWN', () => {
      const mt = mkMT('DOWNTREND', 'MID');
      const r = computeRegime(mkLT('BEARISH'), mt, mt.bb);
      expect(r.slug).toBe('STRONG_DOWN');
    });
  });

  test('all 20 regime matrix entries resolve correctly', () => {
    const entries = [
      ['BULLISH','UPTREND','STRONG_UP'], ['BULLISH','PULLBACK','PULLBACK_BULL'],
      ['BULLISH','REBOUND','UP'], ['BULLISH','SIDEWAYS','CHOP_BULL'],
      ['BULLISH','DOWNTREND','CORRECTION'],
      ['RECOVERING','UPTREND','WEAK_UP'], ['RECOVERING','PULLBACK','RECOVERY'],
      ['RECOVERING','REBOUND','RECOVERY'], ['RECOVERING','SIDEWAYS','BASING'],
      ['RECOVERING','DOWNTREND','DOWN'],
      ['WEAKENING','UPTREND','RECOVERY'], ['WEAKENING','PULLBACK','TOPPING'],
      ['WEAKENING','REBOUND','BEAR_RALLY'], ['WEAKENING','SIDEWAYS','CHOP_BEAR'],
      ['WEAKENING','DOWNTREND','DOWN'],
      ['BEARISH','UPTREND','BEAR_RALLY'], ['BEARISH','PULLBACK','DOWN'],
      ['BEARISH','REBOUND','BEAR_RALLY'], ['BEARISH','SIDEWAYS','BASING'],
      ['BEARISH','DOWNTREND','STRONG_DOWN'],
    ];
    for (const [lt, mt, expected] of entries) {
      const r = computeRegime(mkLT(lt), mkMT(mt, 'MID'));
      expect(r.slug).toBe(expected);
    }
  });

  test('output has required fields: slug, label, icon, color, stance, guidance, confidence, aligned', () => {
    const r = computeRegime(mkLT('BULLISH'), mkMT('UPTREND'));
    ['slug','label','icon','color','stance','guidance','confidence','aligned'].forEach(f => {
      expect(r).toHaveProperty(f);
    });
  });
});
