/*
 * The Pine ports say the same numbers as the strategies they port.
 *
 * pine/*.pine is a second implementation of three strategies that already
 * exist in qp. Two implementations of one idea is the thing this whole desk
 * spent a rewrite removing — a live trade that can disagree with the backtest
 * that justified it, with no way to tell which is right because both look
 * correct.
 *
 * These are kept anyway, for one reason: TradingView can show YEARS of a
 * strategy on a chart you can scroll, and qp cannot. That is worth having. But
 * it is only worth having while the two agree, and nothing about editing a
 * seed would ever prompt anyone to open a .pine file.
 *
 * So every threshold in the Pine is checked against the seed it came from. A
 * seed edited without the Pine following it fails here, naming both.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: that the Pine is correct Pine. Nothing
 * here compiles it — TradingView is the only thing that can. These tests
 * prevent DRIFT, not bugs.
 */

const fs = require('fs');
const path = require('path');

const PINE = path.join(__dirname, '..', 'pine');
const SEEDS = path.join(__dirname, '..', 'quant-platform', 'chart', 'seeds');

const src = f => fs.readFileSync(path.join(PINE, f), 'utf8');
const seed = (f, name) => {
  const raw = JSON.parse(fs.readFileSync(path.join(SEEDS, f), 'utf8'));
  const list = Array.isArray(raw) ? raw : [raw];
  const hit = list.find(s => s.name === name);
  if (!hit) throw new Error(`no strategy called "${name}" in ${f}`);
  return hit;
};

/** The default of a named Pine input, as a number. */
function input(text, name) {
  const m = text.match(new RegExp(`\\b${name}\\s*=\\s*input\\.(?:int|float)\\(\\s*(-?[\\d.]+)`));
  if (!m) throw new Error(`no input called "${name}" in the Pine`);
  return Number(m[1]);
}

/*
 * The file with its comments removed.
 *
 * These headers TALK about ta.vwap() — at length, because the reason not to
 * use it is the whole point — so "is ta.vwap used" has to be asked of the code
 * and not of the prose. Asked of the prose it fails on the file that explains
 * why it fails.
 */
function code(f) {
  return src(f).split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
}

/** Walk a rule tree collecting every {key, params} primitive it mentions. */
function primitives(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.kind === 'primitive' && node.key) out.push(node);
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(x => primitives(x, out));
    else if (v && typeof v === 'object') primitives(v, out);
  }
  return out;
}

// ── every file is there and is a strategy ──────────────────────────────────

describe('the three ports exist', () => {
  const FILES = ['or_vwap_0935.pine', 't2_vwap_extension_1000.pine', 'test_sma_vwap.pine'];

  test.each(FILES)('%s is a v6 strategy', f => {
    const t = src(f);
    expect(t).toMatch(/^\/\/@version=6/m);
    expect(t).toMatch(/^strategy\(/m);
  });

  /*
   * The ranking is the one thing Pine cannot do, and the one thing most likely
   * to be forgotten when reading a backtest off it. Every file says so.
   */
  test.each(FILES)('%s says the ranking is missing', f => {
    expect(src(f)).toMatch(/rank/i);
  });

  /*
   * All three are defined on minute bars — opening ranges, 09:41 splits, a
   * 09:35 trigger. On 5m the range and the trigger become the same bar, which
   * is a different strategy that still produces a plausible equity curve.
   */
  test.each(FILES)('%s says to run it on 1-minute bars', f => {
    expect(src(f)).toMatch(/1-MINUTE BARS/i);
  });

  /* An account that cannot hold overnight needs the flatten in the backtest. */
  test.each(FILES)('%s flattens at the end of the session', f => {
    expect(input(src(f), 'flattenAt')).toBe(1550);
    expect(src(f)).toMatch(/strategy\.close_all/);
  });

  /* One position a day — `max_entries_per_day: 1` on every one of these. */
  test.each(FILES)('%s takes at most one entry a day', f => {
    expect(src(f)).toMatch(/tradedToday/);
  });
});

// ── OR + VWAP 09:35 ────────────────────────────────────────────────────────

describe('OR + VWAP 09:35 matches its seed', () => {
  const t = src('or_vwap_0935.pine');
  const L = seed('or_vwap.json', 'OR + VWAP 09:35 (Long)');
  const S = seed('or_vwap.json', 'OR + VWAP 09:35 (Short)');

  test('the decision minute, and the opening range it reads', () => {
    expect(input(t, 'decideAt')).toBe(L.risk.window_start);
    expect(input(t, 'decideAt')).toBe(L.risk.window_end);   // one bar, not a window
    const win = primitives(L.entry).find(p => p.key === 'levels.window_low');
    expect(input(t, 'orStart')).toBe(win.params.start);
    expect(input(t, 'orEnd')).toBe(win.params.end);
  });

  test('the two position thresholds, and that they are not the same number', () => {
    // 0.55 long / 0.45 short — a mirror in value but written separately, and
    // the short is `le` where the long is `ge`.
    expect(input(t, 'posLong')).toBe(0.55);
    expect(input(t, 'posShort')).toBe(0.45);
    expect(L.entry.rules[2].op).toBe('ge');
    expect(S.entry.rules[2].op).toBe('le');
    expect(L.entry.rules[2].right.value).toBe(input(t, 'posLong'));
    expect(S.entry.rules[2].right.value).toBe(input(t, 'posShort'));
  });

  test('the ATR gate', () => {
    const atr = primitives(L.entry).find(p => p.key === 'volatility.atr');
    expect(input(t, 'atrLen')).toBe(atr.params.length);
    expect(input(t, 'atrMult')).toBe(L.entry.rules[3].right.b.value);
  });

  test('the VWAP slope lookback', () => {
    expect(input(t, 'vwapBack')).toBe(L.entry.rules[1].right.offset);
  });

  test('one leg at 2R and a runner — the fractions add to one', () => {
    expect(L.risk.targets).toHaveLength(1);
    expect(input(t, 'legFrac')).toBe(L.risk.targets[0].fraction);
    expect(input(t, 'legR')).toBe(L.risk.targets[0].r_multiple);
    // The runner is the remainder and is never its own input.
    expect(t).toMatch(/q2 = qtyRaw - q1/);
  });

  /*
   * FROZEN. The stop is the opening-range midpoint, decided once. This is the
   * strategy where the live order and the backtest already agree, and the Pine
   * must not quietly introduce a trailing stop that flatters it.
   */
  test('the stop is fixed at entry, as the seed says', () => {
    expect(L.risk.sl.freeze).toBe(true);
    expect(t).toMatch(/stop = entryStop/);
    expect(t).not.toMatch(/freezeStop/);          // no toggle: there is nothing to toggle
  });

  test('the exit rule closes the whole position, runner included', () => {
    expect(L.exit.rules[0].op).toBe('cross_below');
    expect(t).toMatch(/ta\.crossunder\(close, vwap\)/);
    expect(t).toMatch(/ta\.crossover\(close, vwap\)/);
  });
});

// ── T2 10:00 ───────────────────────────────────────────────────────────────

describe('T2 10:00 matches its seed', () => {
  const t = src('t2_vwap_extension_1000.pine');
  const L = seed('t2_vwap_extension.json', 'T2 10:00 VWAP Extension (Long)');
  const S = seed('t2_vwap_extension.json', 'T2 10:00 VWAP Extension (Short)');

  test('the decision minute', () => {
    expect(input(t, 'decideAt')).toBe(L.risk.window_start);
    expect(input(t, 'decideAt')).toBe(1000);
  });

  test('the position thresholds are percentages here, not fractions', () => {
    // 55 and 45, because this strategy multiplies by 100 and the other does
    // not. Writing 0.55 in the Pine would be silently, permanently true.
    expect(input(t, 'posLong')).toBe(55);
    expect(input(t, 'posShort')).toBe(45);
    expect(L.entry.rules[2].right.value).toBe(55);
    expect(S.entry.rules[2].right.value).toBe(45);
  });

  test('the VWAP slope lookback is 10, not 3', () => {
    expect(input(t, 'vwapBack')).toBe(L.entry.rules[1].right.offset);
    expect(input(t, 'vwapBack')).toBe(10);
  });

  /*
   * THE ASYMMETRY, pinned deliberately.
   *
   * The long wants a higher low in the back half of the half hour (09:41); the
   * short wants a lower high in the last ten minutes (09:51). They are not
   * mirror images and were not meant to be — anyone "fixing" that in one place
   * has to fail here rather than quietly change one side of a tested pair.
   */
  test('the long splits at 09:41 and the short at 09:51', () => {
    const lows = primitives(L.entry).filter(p => p.key === 'levels.window_low');
    const highs = primitives(S.entry).filter(p => p.key === 'levels.window_high');
    expect(lows.some(p => p.params.start === 941 && p.params.end === 1000)).toBe(true);
    expect(lows.some(p => p.params.start === 930 && p.params.end === 941)).toBe(true);
    expect(highs.some(p => p.params.start === 951 && p.params.end === 1000)).toBe(true);
    expect(highs.some(p => p.params.start === 930 && p.params.end === 951)).toBe(true);
    expect(t).toMatch(/inWin\(941, 1000\)/);
    expect(t).toMatch(/inWin\(930, 941\)/);
    expect(t).toMatch(/inWin\(951, 1000\)/);
    expect(t).toMatch(/inWin\(930, 951\)/);
  });

  test('one target, the whole position, at 2R', () => {
    expect(L.risk.targets).toHaveLength(1);
    expect(L.risk.targets[0].fraction).toBe(1.0);
    expect(input(t, 'targetR')).toBe(L.risk.targets[0].r_multiple);
  });

  test('the stop is the VWAP reading at entry, frozen', () => {
    expect(L.risk.sl.freeze).toBe(true);
    expect(L.risk.sl.anchor.key).toBe('vwap.session');
    expect(t).toMatch(/entryStop := vwap/);
    expect(t).toMatch(/stop  = entryStop/);
  });

  test('there is no exit rule — only the stop, the target and the bell', () => {
    expect((L.exit && L.exit.rules) || []).toHaveLength(0);
    expect(t).not.toMatch(/crossunder\(close, vwap\)/);
  });
});

// ── Test ───────────────────────────────────────────────────────────────────

describe('Test matches its seed', () => {
  const t = src('test_sma_vwap.pine');
  const S = seed('Test.json', 'Test');

  test('it is watched across a window, not decided at a minute', () => {
    expect(input(t, 'winStart')).toBe(S.risk.window_start);
    expect(input(t, 'winEnd')).toBe(S.risk.window_end);
    expect(S.risk.window_end).toBeGreaterThan(S.risk.window_start);
  });

  test('the two moving averages', () => {
    const smas = primitives(S.entry).filter(p => p.key === 'ma.sma');
    const lens = [...new Set(smas.map(p => p.params.length))].sort((a, b) => a - b);
    expect(lens).toEqual([input(t, 'fastLen'), input(t, 'slowLen')]);
  });

  /*
   * The CROSS is the trigger and the rest is state. A port that made all four
   * plain comparisons would fire on every bar the condition stayed true, which
   * is a different strategy wearing the same name.
   */
  test('the trigger is a cross, not a comparison', () => {
    expect(S.entry.rules[3].op).toBe('cross_above');
    expect(t).toMatch(/ta\.crossover\(smaSlow, vwap\)/);
  });

  test('the stop rides the lower VWAP band at the seed\'s multiple', () => {
    expect(S.risk.sl.anchor.key).toBe('vwap.stdev_bands');
    expect(S.risk.sl.anchor.sub).toBe('lower');
    expect(input(t, 'bandMult')).toBe(S.risk.sl.anchor.params.mult);
  });

  /*
   * THE EXCEPTION, and the reason this file has a toggle the other two do not.
   *
   * `hold: true` means the backtest re-reads the band every bar and the stop
   * follows it up. A broker gets one price. The toggle exists so the two can be
   * run against each other and the gap between them read as a number instead of
   * argued about.
   */
  test('the moving stop is the default, and freezing it is offered', () => {
    expect(S.risk.sl.anchor.hold).toBe(true);
    expect(S.risk.sl.freeze).toBeUndefined();
    expect(t).toMatch(/freezeStop\s*=\s*input\.bool\(false/);
    expect(t).toMatch(/curStop = freezeStop \? entryStop : /);
  });

  test('two targets and a runner, and the fractions add to one', () => {
    expect(S.risk.targets).toHaveLength(2);
    expect(input(t, 'f1')).toBe(S.risk.targets[0].fraction);
    expect(input(t, 'r1')).toBe(S.risk.targets[0].r_multiple);
    expect(input(t, 'f2')).toBe(S.risk.targets[1].fraction);
    expect(input(t, 'r2')).toBe(S.risk.targets[1].r_multiple);
    const runner = 1 - S.risk.targets.reduce((n, x) => n + x.fraction, 0);
    expect(runner).toBeCloseTo(0.1, 6);
    // The runner takes the REMAINDER, so no share is lost to three floors.
    expect(t).toMatch(/q3 = qtyRaw - q1 - q2/);
  });

  /*
   * TEN SHARES, not three. The smallest leg is a tenth of the position, so
   * under ten shares it floors to zero and the strategy silently becomes a
   * two-leg one. This is the same trap the rehearsal script exists to avoid.
   */
  test('the share floor is high enough for the smallest leg to survive', () => {
    /*
     * ROUNDED before the ceiling. 1 - (0.1 + 0.8) is 0.09999999999999998 in
     * binary floating point, and ceil(1/that) is ELEVEN — a test that would
     * have demanded one more share than the strategy needs, for no reason
     * anyone reading it could see.
     *
     * The order layer sidesteps the same trap by giving the runner the
     * REMAINDER (total - used) rather than its fraction of the total, so a
     * runner fraction that is a hair under a tenth still gets its share.
     */
    const round6 = x => Math.round(x * 1e6) / 1e6;
    const smallest = Math.min(
      ...S.risk.targets.map(x => x.fraction),
      round6(1 - S.risk.targets.reduce((n, x) => n + x.fraction, 0)));
    expect(input(t, 'minShares')).toBeGreaterThanOrEqual(Math.ceil(1 / smallest));
  });

  test('it is long only, as the seed is', () => {
    expect(S.side).toBe('long');
    expect(t).not.toMatch(/strategy\.short/);
  });
});

// ── the maths that is easy to get subtly wrong ─────────────────────────────

describe('the primitives are ported, not approximated', () => {
  const ALL = ['or_vwap_0935.pine', 't2_vwap_extension_1000.pine', 'test_sma_vwap.pine'];

  /*
   * ta.vwap() accumulates every bar it is handed. qp accumulates RTH bars only
   * and resets at 09:30 — so on a chart with extended hours switched on, the
   * built-in is a different line and the whole strategy is a different
   * strategy. All three compute it by hand instead.
   */
  test.each(ALL)('%s builds session VWAP itself rather than using ta.vwap', f => {
    const t = src(f);
    expect(code(f)).not.toMatch(/ta\.vwap\(/);
    expect(t).toMatch(/cumPV\s*\+=\s*hlc3 \* volume/);
    expect(t).toMatch(/cumV\s*\+=\s*volume/);
    expect(t).toMatch(/if newDay/);
  });

  /*
   * The band is a VOLUME-weighted stdev around the running VWAP —
   * E[p²] − E[p]² accumulated like the VWAP — not ta.stdev of close. The stop
   * sits on this line, so the difference is the trade.
   */
  test('the VWAP band is the volume-weighted one', () => {
    const t = src('test_sma_vwap.pine');
    expect(t).toMatch(/cumPV2\s*\+=\s*hlc3 \* hlc3 \* volume/);
    expect(t).toMatch(/cumPV2 \/ cumV - vwap \* vwap/);
    expect(code('test_sma_vwap.pine')).not.toMatch(/ta\.stdev/);
  });

  /*
   * [start, end) — half open. The 09:35 bar is the trigger and is NOT part of
   * the range it breaks out of; including it would make every breakout look
   * marginal and some of them impossible.
   */
  test('the intraday windows are half-open, and exclude the trigger bar', () => {
    expect(src('or_vwap_0935.pine')).toMatch(/nowMin >= hhmmToMin\(orStart\) and nowMin < hhmmToMin\(orEnd\)/);
    expect(src('t2_vwap_extension_1000.pine')).toMatch(/nowMin >= hhmmToMin\(s\) and nowMin < hhmmToMin\(e\)/);
  });

  /* A zero-width range divides by zero and makes every name a perfect setup. */
  test.each(['or_vwap_0935.pine', 't2_vwap_extension_1000.pine'])(
    '%s refuses a zero-width range', f => {
      expect(src(f)).toMatch(/> 0/);
      expect(src(f)).toMatch(/rngOk|orOk/);
    });

  /* The clock is New York's, on every file — not the chart's, not the box's. */
  test.each(ALL)('%s reads the clock in New York', f => {
    expect(src(f)).toMatch(/hour\(time, "America\/New_York"\)/);
    expect(src(f)).toMatch(/minute\(time, "America\/New_York"\)/);
  });
});
