/*
 * WHAT WOULD FIX A FILTER — and the discipline of not answering that from an
 * armchair.
 *
 * why-empty.js named `close ≥ price_52_week_high` as the rule that empties
 * T10. I then told the trader to replace it with "within 1–2% of the 52-week
 * high" — WITHOUT TESTING EITHER HALF. He pushed back, and he was right twice
 * over: the diagnosis was untested, and the cure was unbuildable. TradingView's
 * filter language has no column-times-a-constant, so "within 2%" cannot be
 * expressed at all.
 *
 * The candidate I should have offered is one word away and never occurred to
 * me until the counts forced it:
 *
 *     close ≥ price_52_week_high   closed at the very top of its year
 *     high  ≥ price_52_week_high   PRINTED a new 52-week high today
 *
 * These check the candidate generation and the verdict. The counts themselves
 * come from TradingView and cannot be tested here — which is exactly why the
 * script exists rather than another paragraph of my reasoning.
 */

const tf = require('../scripts/try-filter');

const rule = (left, operation, right) => ({ left, operation, right });

describe('a breakout has a close version and a high version', () => {
  const current = rule('close', 'egreater', 'price_52_week_high');
  const names = (cs) => cs.map(c => `${c.left} ${c.operation} ${c.right}`);

  /*
   * THE ONE THAT WAS NEVER TRIED. "Breakout" means the stock traded at a new
   * high, not that it closed at the exact top of the day AND the year.
   */
  test('it offers "did it PRINT that high today"', () => {
    const cs = tf.candidatesFor(current);
    expect(names(cs)).toContain('high egreater price_52_week_high');
    const it = cs.find(c => c.left === 'high' && c.right === 'price_52_week_high');
    expect(it.why).toMatch(/PRINT that high today/);
  });

  test('and the same question over shorter windows, named as different strategies', () => {
    const n = names(tf.candidatesFor(current));
    expect(n).toContain('close egreater High.3M');
    expect(n).toContain('close egreater High.1M');
    expect(n).toContain('high egreater High.3M');
  });

  test('every candidate is something TradingView can evaluate — a column '
    + 'against a column or a number, never a column times a constant', () => {
    for (const c of tf.candidatesFor(current)) {
      expect(typeof c.right === 'string' || typeof c.right === 'number').toBe(true);
      expect(String(c.right)).not.toMatch(/[*×]/);
    }
  });

  test('it never offers the rule that is already there', () => {
    expect(names(tf.candidatesFor(current))).not.toContain('close egreater price_52_week_high');
  });

  test('a LOW comparison walks the low ladder, not the high one', () => {
    const n = names(tf.candidatesFor(rule('close', 'eless', 'price_52_week_low')));
    expect(n).toContain('close eless Low.3M');
    expect(n.join(' ')).not.toMatch(/High\./);
    // …and the touch version of a low is the day's LOW
    expect(n).toContain('low eless price_52_week_low');
  });
});

describe('a numeric threshold is relaxed in the direction that admits stocks', () => {
  test('a floor comes DOWN', () => {
    const cs = tf.candidatesFor(rule('relative_volume_10d_calc', 'greater', 10));
    // 7.5, not 8: rounding a threshold to a whole number quietly makes it a
    // different rule from the one being offered.
    expect(cs.map(c => c.right)).toEqual([7.5, 5, 2.5]);
  });

  test('a ceiling goes UP', () => {
    const cs = tf.candidatesFor(rule('total_shares_outstanding_fundamental', 'less', 1000000000));
    expect(cs.every(c => c.right > 1000000000)).toBe(true);
  });

  test('small numbers keep their decimals — 1.5 relaxed to 1 is a different rule '
    + 'from 1.5 relaxed to 1.13', () => {
    const cs = tf.candidatesFor(rule('relative_volume_10d_calc', 'greater', 1.5));
    expect(cs.map(c => c.right)).toEqual([1.13, 0.75, 0.38]);
  });

  test('a threshold of zero has nothing to relax', () => {
    expect(tf.candidatesFor(rule('close', 'greater', 0))).toEqual([]);
  });
});

describe('a rule typed on the command line', () => {
  test('the shorthand becomes a filter', () => {
    expect(tf.parseRule('high>=price_52_week_high')).toEqual({
      left: 'high', operation: 'egreater', right: 'price_52_week_high', why: 'yours' });
  });

  test('a number stays a number, and a column stays a column', () => {
    expect(tf.parseRule('Perf.6M > 15').right).toBe(15);
    expect(tf.parseRule('close >= SMA50').right).toBe('SMA50');
  });

  test('nonsense is refused rather than guessed at', () => {
    expect(tf.parseRule('close is high')).toBeNull();
    expect(tf.parseRule('')).toBeNull();
  });
});

/*
 * THE VERDICT IS THE PART THAT COULD LIE, so it is held to the same rule as
 * everywhere else on this desk: it recommends only what it has SEEN work.
 */
describe('it will not recommend a rule it has not seen work', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'try-filter.js'), 'utf8');

  test('a candidate counts only if the SCREENER returns something with it', () => {
    // matching stocks alone proves the rule is expressible, not that it fixes
    // anything — the filter is on `full`, not on `alone`.
    expect(src).toContain('rows.filter(r => r.c !== current && r.full.n > 0');
  });

  test('when nothing works it says the combination is rare, and sends you back '
    + 'to why-empty rather than inventing a cure', () => {
    expect(src).toMatch(/none of these makes the screener return anything/);
    expect(src).toMatch(/COMBINATION that is rare/);
  });

  test('it changes nothing — the winning rule is applied by hand', () => {
    expect(src).toMatch(/Nothing has been changed/);
    expect(src).not.toMatch(/store\.update\(|store\.create\(/);
  });

  test('an error is never a zero', () => {
    expect(src).toContain('// A REFUSAL IS NOT A ZERO.');
    expect(src).toContain('ERROR: ${c.error}');
  });
});
