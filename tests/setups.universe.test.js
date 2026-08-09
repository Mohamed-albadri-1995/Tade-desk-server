/*
 * The card-field layer: which stocks a setup is even allowed to consider.
 *
 * This is the one thing qp cannot do. It decides everything about bars, but it
 * has never heard of `bias`, `score` or `catalyst` — those exist only on a card
 * — so a filter over them is not a duplicate of anything.
 *
 * The property that matters most is the ORDER. The setup ranks and takes the
 * top two, so filtering afterwards means the filter eats picks and leaves gaps:
 * ranks 1 and 2 come back, one fails the bias check, and you trade one name
 * while rank 3 — which passed — was discarded before you saw it. Filtering
 * first means the ranking happens among the names you would actually take.
 */

const u = require('../src/setups/universe');

/** A card, in the shape r0 holds one. */
function card(ticker, { score = 80, bias = 'BULLISH', catalyst = null,
                        rvol = 5, price = 30, canslim = false } = {}) {
  return {
    ticker, _score: score, bias, catalyst, canslim,
    stock: { rvol, price, adrPct: 4, gapPct: 10, mcap: 1e9 },
  };
}

describe('a rule against one card', () => {
  test('reads the screener\'s own analysis, which is why this exists', () => {
    expect(u.testRule({ left: 'bias', op: 'eq', right: 'BULLISH' }, card('A'))).toBe(true);
    expect(u.testRule({ left: 'score', op: 'egreater', right: 70 }, card('A'))).toBe(true);
    expect(u.testRule({ left: 'score', op: 'egreater', right: 90 }, card('A'))).toBe(false);
  });

  test('text compares case-insensitively', () => {
    expect(u.testRule({ left: 'bias', op: 'eq', right: 'bullish' }, card('A'))).toBe(true);
    expect(u.testRule({ left: 'bias', op: 'eq', right: 'Bullish' }, card('A'))).toBe(true);
  });

  test('"has any of" lets one rule accept several values', () => {
    const r = { left: 'bias', op: 'has', right: 'BULLISH,STRONG' };
    expect(u.testRule(r, card('A', { bias: 'BULLISH' }))).toBe(true);
    expect(u.testRule(r, card('A', { bias: 'BEARISH' }))).toBe(false);
  });

  test('card numbers work too, named as they appear on the card', () => {
    expect(u.testRule({ left: 'rvol', op: 'above', right: 3 }, card('A'))).toBe(true);
    expect(u.testRule({ left: 'price', op: 'below', right: 10 }, card('A'))).toBe(false);
  });

  /*
   * "Cannot tell" is not "failed". A card whose score has not been computed yet
   * has not failed a score test, and collapsing the two would let the filter
   * quietly pass or reject exactly the rows it exists to judge.
   */
  test('an unknown value is null, not false', () => {
    expect(u.testRule({ left: 'score', op: 'above', right: 5 },
      card('A', { score: null }))).toBeNull();
    expect(u.testRule({ left: 'catalyst', op: 'eq', right: 'GAP UP' },
      card('A'))).toBeNull();
  });

  test('an unknown field is null rather than an accidental pass', () => {
    expect(u.testRule({ left: 'nonsense', op: 'eq', right: 1 }, card('A'))).toBeNull();
  });
});

describe('applying a filter to a card list', () => {
  const rows = [
    card('AAA', { bias: 'BULLISH', score: 85 }),
    card('BBB', { bias: 'BEARISH', score: 90 }),
    card('CCC', { bias: 'BULLISH', score: 40 }),
  ];

  test('AND needs every rule', () => {
    const out = u.apply(rows, { logic: 'AND', rules: [
      { left: 'bias', op: 'eq', right: 'BULLISH' },
      { left: 'score', op: 'egreater', right: 70 },
    ] });
    expect(out.kept.map(r => r.ticker)).toEqual(['AAA']);
    expect(out.dropped.map(r => r.ticker)).toEqual(['BBB', 'CCC']);
  });

  test('OR needs any of them', () => {
    const out = u.apply(rows, { logic: 'OR', rules: [
      { left: 'bias', op: 'eq', right: 'BULLISH' },
      { left: 'score', op: 'egreater', right: 88 },
    ] });
    expect(out.kept.map(r => r.ticker)).toEqual(['AAA', 'BBB', 'CCC']);
  });

  test('no filter keeps everything and says it did not run', () => {
    expect(u.apply(rows, null).kept).toHaveLength(3);
    expect(u.apply(rows, null).filtered).toBe(false);
    expect(u.apply(rows, { rules: [] }).filtered).toBe(false);
  });

  /*
   * A filter that removes everything must be explainable. "0 of 40 passed" with
   * no reason is how a filter gets blamed for a quiet morning it had nothing to
   * do with — or worse, trusted on a morning it broke.
   */
  test('it reports which rule turned each card away', () => {
    const out = u.apply(rows, { rules: [{ left: 'score', op: 'egreater', right: 95 }] });
    expect(out.kept).toHaveLength(0);
    expect(Object.values(out.reasons)[0]).toBe(3);
    expect(Object.keys(out.reasons)[0]).toMatch(/Model score is at least 95/);
  });

  test('an unknown value drops by default — a gate must not open on ignorance', () => {
    const out = u.apply([card('X', { score: null })],
      { rules: [{ left: 'score', op: 'above', right: 50 }] });
    expect(out.kept).toHaveLength(0);
  });

  test('…but that reading can be reversed deliberately', () => {
    const out = u.apply([card('X', { score: null })],
      { unknown: 'keep', rules: [{ left: 'score', op: 'above', right: 50 }] });
    expect(out.kept).toHaveLength(1);
  });
});

describe('saying what a filter is', () => {
  test('in words, for the alert and the setups list', () => {
    expect(u.describe({ logic: 'AND', rules: [
      { left: 'bias', op: 'eq', right: 'BULLISH' },
      { left: 'score', op: 'egreater', right: 70 },
    ] })).toBe('Bias is BULLISH AND Model score is at least 70');
  });

  test('nothing to say when there is no filter', () => {
    expect(u.describe(null)).toBeNull();
    expect(u.describe({ rules: [] })).toBeNull();
  });
});

describe('rejecting a malformed filter at the door', () => {
  test('an unknown field is named', () => {
    expect(u.validate({ rules: [{ left: 'nope', op: 'eq', right: 1 }] })[0])
      .toMatch(/unknown field/);
  });

  test('an unknown operator is named', () => {
    expect(u.validate({ rules: [{ left: 'bias', op: 'wat', right: 1 }] })[0])
      .toMatch(/unknown operator/);
  });

  test('a missing value is named', () => {
    expect(u.validate({ rules: [{ left: 'bias', op: 'eq' }] })[0])
      .toMatch(/needs a value/);
  });

  test('a good filter has nothing to say', () => {
    expect(u.validate({ rules: [{ left: 'bias', op: 'eq', right: 'BULLISH' }] }))
      .toEqual([]);
  });
});
