/*
 * WHY A SCREENER IS EMPTY — and the discipline that makes the answer worth
 * having.
 *
 * T8's breakout screener ran every day for twenty recorded days and produced
 * ZERO rows, while the pullback beside it produced seventy-three. Both were
 * enabled, TradingView answered both, neither errored. A screener returning
 * nothing looks exactly like a screener whose setup is rare, and the two need
 * opposite responses — one is a rule to rewrite, the other is a rule working.
 *
 * The ladder asks TradingView with each filter removed in turn. The part that
 * can lie is the VERDICT, so that is what is tested here: the network half
 * cannot be exercised in a test, and mocking it would only prove the mock.
 *
 * The two ways it could lie, and both have precedent in this repo:
 *
 *   BLAMING AN INNOCENT RULE, when the combination is what is rare
 *   COUNTING AN ERROR AS A ZERO, so whichever filter was being asked when the
 *   network went gets the blame
 */

const { verdictOf, describe: describeFilter } = require('../scripts/why-empty');

const ok = (n) => ({ n, ms: 10, error: null });
const err = (m) => ({ n: null, ms: null, error: m });
const F = {
  hi: { left: 'close', operation: 'egreater', right: 'price_52_week_high' },
  rvol: { left: 'relative_volume_10d_calc', operation: 'greater', right: 1.5 },
  perf: { left: 'Perf.6M', operation: 'greater', right: 30 },
};

describe('it names the filter that is doing the killing', () => {
  test('the one whose removal turns nothing into something', () => {
    const out = verdictOf(ok(0), [
      { f: F.hi, alone: ok(0), without: ok(37) },
      { f: F.rvol, alone: ok(400), without: ok(0) },
      { f: F.perf, alone: ok(900), without: ok(0) },
    ]);
    expect(out[0]).toContain('close ≥ price_52_week_high');
    expect(out[1]).toContain('returns 37 name(s); with it, none');
  });

  test('when several would open it up, the biggest leads and the rest are '
    + 'counted rather than hidden', () => {
    const out = verdictOf(ok(0), [
      { f: F.hi, alone: ok(0), without: ok(37) },
      { f: F.rvol, alone: ok(400), without: ok(4) },
    ]);
    expect(out[0]).toContain('close ≥ price_52_week_high');
    expect(out.join(' ')).toMatch(/1 other filter\(s\) would also open it up/);
  });

  /*
   * THE RESTRAINT THAT MAKES IT USEFUL. If removing any single filter still
   * returns nothing, no one rule is responsible — and naming one would send
   * you off to rewrite an innocent line while the real answer ("this
   * combination is rare") went unsaid.
   */
  test('it refuses to name a culprit when there is not one', () => {
    const out = verdictOf(ok(0), [
      { f: F.hi, alone: ok(2), without: ok(0) },
      { f: F.rvol, alone: ok(400), without: ok(0) },
    ]).join(' ');
    expect(out).toMatch(/no single filter explains the zero/);
    expect(out).toMatch(/COMBINATION/);
    // …and it still points at the tightest rule, which is where to look first.
    expect(out).toMatch(/tightest on its own is  close ≥ price_52_week_high  \(2 name/);
  });

  test('a screener that DOES match says so, and sends you upstream', () => {
    const out = verdictOf(ok(12), []).join(' ');
    expect(out).toMatch(/matches 12 name\(s\) right now/);
    expect(out).toMatch(/run window, the schedule, or the tool being paused/);
  });
});

/* ── an error is never a zero ────────────────────────────────────────────── */

describe('a refusal and "nothing matched" are opposite facts', () => {
  test('the screener itself failing is reported as that, not as empty', () => {
    const out = verdictOf(err('Request failed with status code 403'), []);
    expect(out[0]).toMatch(/TradingView refused the screener itself/);
    expect(out[1]).toContain('403');
    expect(out.join(' ')).not.toMatch(/no single filter/);
  });

  /*
   * THE ONE THAT WOULD HAVE BEEN EASY TO GET WRONG. A probe that did not come
   * back has `n: null`. Treated as a number it is falsy — so a naive
   * `without.n > 0` check silently reclassifies every failed probe as "removing
   * this changes nothing", and the verdict blames whichever filter happened to
   * be asked when the network went.
   */
  test('a failed probe is not evidence that its filter is innocent', () => {
    const out = verdictOf(ok(0), [
      { f: F.hi, alone: err('timeout'), without: err('timeout') },
      { f: F.rvol, alone: ok(400), without: ok(0) },
    ]).join(' ');
    expect(out).toMatch(/no single filter explains/);
    // …and it says how much of the ladder it is standing on.
    expect(out).toMatch(/1 probe\(s\) did not answer/);
  });

  test('when nothing answered at all, it blames nothing', () => {
    const out = verdictOf(ok(0), [
      { f: F.hi, alone: err('timeout'), without: err('timeout') },
    ]).join(' ');
    expect(out).toMatch(/not one of the leave-one-out probes came back/);
    expect(out).not.toMatch(/VERDICT: close/);
  });

  test('a real zero and a failed probe never print the same way', () => {
    const zero = verdictOf(ok(0), [
      { f: F.hi, alone: ok(0), without: ok(37) }]).join(' ');
    const failed = verdictOf(ok(0), [
      { f: F.hi, alone: err('403'), without: err('403') }]).join(' ');
    expect(zero).not.toEqual(failed);
    expect(zero).toMatch(/VERDICT: close ≥ price_52_week_high/);
  });
});

/* ── the filter, in words a trader reads ─────────────────────────────────── */

describe('a filter reads back as the rule it is', () => {
  test('the operators become symbols', () => {
    expect(describeFilter(F.hi)).toBe('close ≥ price_52_week_high');
    expect(describeFilter(F.rvol)).toBe('relative_volume_10d_calc > 1.5');
  });

  test('an operator with no symbol is printed as itself rather than dropped', () => {
    // Silently omitting an unknown operator would print "close  50", which
    // reads as a rule nobody wrote.
    expect(describeFilter({ left: 'close', operation: 'match', right: 'x' }))
      .toBe('close match x');
  });
});
