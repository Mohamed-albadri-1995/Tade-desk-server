/*
 * The T2 10:00 VWAP-extension setup, against setup_spec.md v1.0.
 *
 * The spec is unusually precise — anchor, index-not-clock lookback, which side
 * of a tie wins, what an empty sub-window means — and every one of those is a
 * decision that changes which two stocks get traded. So they are tested one at
 * a time rather than through one end-to-end case that would pass for the wrong
 * reason.
 *
 * Bars are constructed rather than recorded. The spec's own reference log needs
 * four days of real 1-minute data for 110 ticker-days, which is not something to
 * check into a repository; what CAN be pinned here is that each rule does what
 * the document says, which is what would break silently.
 */

const s = require('../src/setups/vwapExtension');

/** A minute bar at HH:MM. Flat unless told otherwise, so a test says only what it means. */
function bar(etTime, { o = 10, h = 10, l = 10, c = 10, v = 1000 } = {}) {
  return { etTime, o, h, l, c, v };
}

/** A morning of `n` bars from 09:30, each built by fn(index). */
function morning(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const mins = 9 * 60 + 30 + i;
    const t = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    out.push(bar(t, fn ? fn(i) : {}));
  }
  return out;
}

describe('the morning window', () => {
  test('is 09:30 up to but not including the decision time', () => {
    const bars = [...morning(31), bar('10:00', { c: 99 }), bar('10:01')];
    const win = s.morningBars(bars);
    expect(win[0].etTime).toBe('09:30');
    expect(win[win.length - 1].etTime).toBe('09:59');
    expect(win.some(b => b.etTime === '10:00')).toBe(false);
  });

  test('pre-market bars are excluded entirely', () => {
    const win = s.morningBars([bar('08:15'), bar('09:29'), ...morning(5)]);
    expect(win.map(b => b.etTime)).toEqual(['09:30', '09:31', '09:32', '09:33', '09:34']);
  });

  /*
   * Missing minutes are absent, not filled. Forward-filling would put volume
   * into the VWAP that never traded, and the VWAP is the stop.
   */
  test('a gap in the tape stays a gap', () => {
    const win = s.morningBars([bar('09:30'), bar('09:31'), bar('09:45')]);
    expect(win).toHaveLength(3);
  });

  test('bars arriving out of order are sorted', () => {
    const win = s.morningBars([bar('09:35'), bar('09:31'), bar('09:33')]);
    expect(win.map(b => b.etTime)).toEqual(['09:31', '09:33', '09:35']);
  });
});

describe('session VWAP', () => {
  test('is volume weighted on the typical price, anchored at the first bar', () => {
    const bars = [
      bar('09:30', { h: 12, l: 8, c: 10, v: 100 }),   // typical 10
      bar('09:31', { h: 22, l: 18, c: 20, v: 300 }),  // typical 20
    ];
    // (10*100 + 20*300) / 400 = 17.5
    expect(s.vwapSeries(bars)[1]).toBeCloseTo(17.5, 10);
  });

  test('the first value is just the first bar', () => {
    expect(s.vwapSeries([bar('09:30', { h: 11, l: 9, c: 10, v: 5 })])[0]).toBeCloseTo(10, 10);
  });

  /*
   * Zero volume is not zero price — it is no information. The spec says skip
   * the ticker, which needs a value that cannot be mistaken for a level.
   */
  test('no volume yields null rather than a number', () => {
    expect(s.vwapSeries([bar('09:30', { v: 0 })])[0]).toBeNull();
  });

  test('a later bar with volume revives it', () => {
    const v = s.vwapSeries([bar('09:30', { v: 0 }), bar('09:31', { h: 12, l: 8, c: 10, v: 50 })]);
    expect(v[0]).toBeNull();
    expect(v[1]).toBeCloseTo(10, 10);
  });
});

describe('range position', () => {
  test('at the high it is 100, at the low it is 0', () => {
    expect(s.rangePosition(20, 10, 20)).toBe(100);
    expect(s.rangePosition(10, 10, 20)).toBe(0);
    expect(s.rangePosition(15, 10, 20)).toBe(50);
  });

  test('a stock that never moved is 50, which fails both directions', () => {
    expect(s.rangePosition(10, 10, 10)).toBe(50);
  });
});

describe('the direction test', () => {
  // A clean uptrend: price and VWAP both rising, close at the top of the range.
  const up = () => morning(20, i => ({ o: 10 + i * 0.1, h: 10 + i * 0.1, l: 9.9 + i * 0.1, c: 10 + i * 0.1, v: 1000 }));
  const down = () => morning(20, i => ({ o: 10 - i * 0.1, h: 10.1 - i * 0.1, l: 10 - i * 0.1, c: 10 - i * 0.1, v: 1000 }));

  test('a rising stock above a rising VWAP at the top of its range is LONG', () => {
    expect(s.evaluateTicker('UP', up()).signal).toBe('LONG');
  });

  test('a falling stock below a falling VWAP at the bottom of its range is SHORT', () => {
    expect(s.evaluateTicker('DN', down()).signal).toBe('SHORT');
  });

  test('a flat stock is neither', () => {
    const r = s.evaluateTicker('FLAT', morning(20));
    expect(r.signal).toBe('NONE');
    expect(r.reason).toBe('no direction');
  });

  /*
   * All three conditions are required. Price above VWAP is not enough if the
   * close is in the bottom of the range — that is a stock giving it back.
   */
  test('above VWAP but low in the range is not LONG', () => {
    // Rise for most of the morning, then hand it all back on the last bar.
    const bars = up();
    bars[bars.length - 1] = bar('09:49', { o: 11.9, h: 11.9, l: 9.8, c: 9.95, v: 1000 });
    expect(s.evaluateTicker('GIVEBACK', bars).signal).toBe('NONE');
  });

  test('fewer than ten morning bars is skipped, not judged', () => {
    const r = s.evaluateTicker('THIN', morning(9));
    expect(r.signal).toBe('NONE');
    expect(r.skipped).toMatch(/9 morning bar/);
  });

  test('a skip is distinguishable from a genuine no-signal', () => {
    expect(s.evaluateTicker('THIN', morning(9)).skipped).toBeTruthy();
    expect(s.evaluateTicker('FLAT', morning(20)).skipped).toBeUndefined();
  });
});

/*
 * The slope is measured ten bars back BY INDEX. On a stock whose tape has gaps
 * that is more than ten minutes back, and the spec is explicit that this is
 * intended. Getting it wrong would silently change the direction test on
 * exactly the thin names where it matters most.
 */
describe('the VWAP slope', () => {
  test('is taken by index, so gaps in the tape do not shorten it', () => {
    // Twelve bars but spread over fifty minutes: index 10 back from the last is
    // NOT ten minutes back.
    const times = ['09:30', '09:31', '09:32', '09:33', '09:34',
                   '09:40', '09:41', '09:45', '09:50', '09:55', '09:57', '09:59'];
    const bars = times.map((t, i) => bar(t, { h: 10 + i * 0.1, l: 10 + i * 0.1, c: 10 + i * 0.1, v: 100 }));
    const r = s.evaluateTicker('GAPPY', bars);
    const series = s.vwapSeries(s.morningBars(bars));
    expect(r.vwapSlope).toBeCloseTo(series[11] - series[1], 10);
  });

  test('with fewer bars than the lookback it measures from the first', () => {
    const bars = morning(12, i => ({ h: 10 + i * 0.1, l: 10 + i * 0.1, c: 10 + i * 0.1, v: 100 }));
    const r = s.evaluateTicker('SHORTHIST', bars);
    const series = s.vwapSeries(s.morningBars(bars));
    expect(r.vwapSlope).toBeCloseTo(series[11] - series[1], 10);
  });
});

describe('the invalidation test', () => {
  const longBars = () => morning(30, i => ({ h: 10 + i * 0.1, l: 9.9 + i * 0.1, c: 10 + i * 0.1, v: 100 }));

  test('a long whose later low undercuts its early low is rejected', () => {
    const bars = longBars();
    // 09:52 is after the 09:40 cutoff. Put a low under everything before it.
    bars[22] = bar('09:52', { o: 12, h: 12.1, l: 1, c: 12, v: 100 });
    const r = s.evaluateTicker('BROKE', bars);
    expect(r.signal).toBe('NONE');
    expect(r.rejectedSignal).toBe('LONG');
    expect(r.reason).toBe('invalidated in the morning');
  });

  test('a long that held its early low survives', () => {
    expect(s.evaluateTicker('HELD', longBars()).signal).toBe('LONG');
  });

  test('the long cutoff is 09:40 and the short cutoff is 09:50', () => {
    const bars = longBars();
    expect(s.invalidated(s.morningBars(bars), 'LONG',
      { ...s.DEFAULTS, invalidationLongCutoff: '09:40' })).toBe(false);
    // A low placed at 09:45 only counts as "later" under the 09:40 cutoff.
    bars[15] = bar('09:45', { o: 11, h: 11, l: 1, c: 11, v: 100 });
    const win = s.morningBars(bars);
    expect(s.invalidated(win, 'LONG', { ...s.DEFAULTS, invalidationLongCutoff: '09:40' })).toBe(true);
    expect(s.invalidated(win, 'LONG', { ...s.DEFAULTS, invalidationLongCutoff: '09:50' })).toBe(false);
  });

  /*
   * An empty sub-window passes. Not leniency: with no bars there is no evidence
   * of invalidation, and rejecting on absence would drop every thin name.
   */
  test('an empty sub-window does not reject', () => {
    const early = morning(8);                       // nothing after 09:40 at all
    expect(s.invalidated(early, 'LONG')).toBe(false);
  });
});

describe('the ranking metric', () => {
  test('extension is positive for both directions', () => {
    const long = s.evaluateTicker('L', morning(20, i => ({ h: 10 + i * 0.1, l: 9.9 + i * 0.1, c: 10 + i * 0.1, v: 100 })));
    const short = s.evaluateTicker('S', morning(20, i => ({ h: 10.1 - i * 0.1, l: 10 - i * 0.1, c: 10 - i * 0.1, v: 100 })));
    expect(long.extension).toBeGreaterThan(0);
    expect(short.extension).toBeGreaterThan(0);
  });

  test('it is distance from VWAP as a percentage of price', () => {
    const r = s.evaluateTicker('L', morning(20, i => ({ h: 10 + i * 0.1, l: 9.9 + i * 0.1, c: 10 + i * 0.1, v: 100 })));
    expect(r.extension).toBeCloseTo((r.decisionClose / r.decisionVwap - 1) * 100, 10);
  });

  /*
   * The whole point of the setup: the FURTHEST from VWAP wins, not the nearest.
   * Reversing this comparison is the single most plausible silent mistake here.
   */
  test('the furthest from VWAP ranks first', () => {
    const picks = s.rank([
      { ticker: 'NEAR', signal: 'LONG', extension: 1.0, volume: 1 },
      { ticker: 'FAR', signal: 'LONG', extension: 5.0, volume: 1 },
      { ticker: 'MID', signal: 'LONG', extension: 3.0, volume: 1 },
    ]);
    expect(picks.map(p => p.ticker)).toEqual(['FAR', 'MID']);
  });

  test('NONE never ranks', () => {
    expect(s.rank([{ ticker: 'X', signal: 'NONE', extension: 99, volume: 1 }])).toEqual([]);
  });

  test('one survivor means one pick, not none', () => {
    expect(s.rank([{ ticker: 'ONLY', signal: 'LONG', extension: 2, volume: 1 }])).toHaveLength(1);
  });

  test('a tie is broken by morning volume', () => {
    const picks = s.rank([
      { ticker: 'QUIET', signal: 'LONG', extension: 3, volume: 10 },
      { ticker: 'BUSY', signal: 'LONG', extension: 3, volume: 99 },
    ], { ...s.DEFAULTS, topN: 1 });
    expect(picks[0].ticker).toBe('BUSY');
  });

  test('and then alphabetically, so the order never depends on map insertion', () => {
    const picks = s.rank([
      { ticker: 'ZZZ', signal: 'LONG', extension: 3, volume: 5 },
      { ticker: 'AAA', signal: 'LONG', extension: 3, volume: 5 },
    ], { ...s.DEFAULTS, topN: 1 });
    expect(picks[0].ticker).toBe('AAA');
  });
});

describe('the trade plan', () => {
  test('the stop is VWAP and the target is twice the risk away', () => {
    const p = s.plan('LONG', 10.5, 10.0);
    expect(p.stop).toBe(10.0);
    expect(p.risk).toBeCloseTo(0.5, 10);
    expect(p.target).toBeCloseTo(11.5, 10);
  });

  test('a short targets downward', () => {
    const p = s.plan('SHORT', 9.5, 10.0);
    expect(p.risk).toBeCloseTo(0.5, 10);
    expect(p.target).toBeCloseTo(8.5, 10);
  });

  test('zero risk is rejected rather than sized', () => {
    expect(s.plan('LONG', 10, 10)).toBeNull();
  });

  test('risk is reported as a percentage too, because sizing is by risk', () => {
    expect(s.plan('LONG', 100, 95).riskPct).toBeCloseTo(5, 10);
  });
});

describe('a whole morning', () => {
  const rising = (mult) => morning(25, i => ({
    o: 10 + i * 0.1 * mult, h: 10 + i * 0.1 * mult,
    l: 9.9 + i * 0.1 * mult, c: 10 + i * 0.1 * mult, v: 1000,
  }));

  test('it picks two, most extended first, each with a plan', () => {
    const out = s.run({ SLOW: rising(1), FAST: rising(3), FLAT: morning(25) });
    expect(out.picks.map(p => p.ticker)).toEqual(['FAST', 'SLOW']);
    expect(out.picks[0].plan.stop).toBeCloseTo(out.picks[0].decisionVwap, 10);
    expect(out.picks[0].plan.target).toBeGreaterThan(out.picks[0].plan.entry);
  });

  test('it reports why the rest are not there', () => {
    const out = s.run({ FAST: rising(3), FLAT: morning(25), THIN: morning(4) });
    expect(out.counts.evaluated).toBe(3);
    expect(out.counts.skipped).toBe(1);
    expect(out.candidates.find(c => c.ticker === 'FLAT').reason).toBe('no direction');
  });

  test('nothing qualifying means no picks, not a fallback', () => {
    expect(s.run({ FLAT: morning(25), ALSOFLAT: morning(25) }).picks).toEqual([]);
  });

  test('an empty universe is not an error', () => {
    const out = s.run({});
    expect(out.picks).toEqual([]);
    expect(out.counts.evaluated).toBe(0);
  });

  test('topN is honoured', () => {
    const out = s.run({ A: rising(1), B: rising(2), C: rising(3) }, { topN: 1 });
    expect(out.picks).toHaveLength(1);
    expect(out.picks[0].ticker).toBe('C');
  });
});
