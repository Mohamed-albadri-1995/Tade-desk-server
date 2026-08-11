/*
 * "Everything agrees" — the filter, and the two things it deliberately ignores.
 *
 * This rule lives in the page rather than the server on purpose: it is a view
 * over signals that already exist, and computing it server-side would add a
 * column to r0 and therefore to the training set, mid-collection, for a
 * filter. But a rule with exceptions in it is exactly the kind that gets
 * "tidied" later by someone who reads `vsPmHigh` missing from the list and
 * assumes it was an oversight — so it is pinned here.
 *
 * The function is lifted out of public/index.html and evaluated. That is not
 * elegant, and the alternative was worse: either no test at all, or moving the
 * rule server-side and changing what every tool collects.
 */

const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');

function lift() {
  const grab = (re, what) => {
    const m = page.match(re);
    if (!m) throw new Error(`${what} not found in public/index.html — was it renamed?`);
    return m[0];
  };
  const src = [
    grab(/const ALIGN_BULL = \[[\s\S]*?\];/, 'ALIGN_BULL'),
    grab(/const ALIGN_BEAR = \[[\s\S]*?\];/, 'ALIGN_BEAR'),
    grab(/function alignment\(row\) \{[\s\S]*?\n\}/, 'alignment()'),
  ].join('\n');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}; return { alignment, ALIGN_BULL, ALIGN_BEAR };`)();
}

const { alignment, ALIGN_BULL, ALIGN_BEAR } = lift();

// Every flag the card can show, so a test can start from "all agreeing" and
// break one thing at a time.
const ALL = ['vsEma9', 'vsEma13', 'vsEma20', 'vsEma50', 'vsSma5',
  'vsVwap', 'vsPrevClose', 'vsOpen', 'vsPmHigh', 'vsPmLow'];

const sig = (side, over = {}) => {
  const out = {};
  for (const k of ALL) out[k] = side;
  out.maStack = side === 'above' ? 'bull' : 'bear';
  return { ...out, ...over };
};
const bullRow = (over = {}, cat = { sentiment: 'bull' }) =>
  ({ signals: sig('above', over), catalyst: cat });
const bearRow = (over = {}, cat = { sentiment: 'bear' }) =>
  ({ signals: sig('below', over), catalyst: cat });

describe('a fully aligned card', () => {
  test('everything up, stack in order, bullish story', () => {
    expect(alignment(bullRow())).toBe('bull');
  });

  test('everything down, stack inverted, bearish story', () => {
    expect(alignment(bearRow())).toBe('bear');
  });

  test('one level out of line is not alignment', () => {
    // Each of the required nine, broken one at a time. This is the whole point
    // of the badge — it claims nothing disagrees.
    for (const k of ALIGN_BULL) {
      expect({ broke: k, got: alignment(bullRow({ [k]: 'below' })) })
        .toEqual({ broke: k, got: null });
    }
    for (const k of ALIGN_BEAR) {
      expect({ broke: k, got: alignment(bearRow({ [k]: 'above' })) })
        .toEqual({ broke: k, got: null });
    }
  });

  test('a mixed moving-average stack is not alignment', () => {
    expect(alignment(bullRow({ maStack: 'mixed' }))).toBeNull();
    expect(alignment(bearRow({ maStack: 'mixed' }))).toBeNull();
  });
});

describe('the catalyst has to agree too', () => {
  test('no catalyst is not agreement', () => {
    expect(alignment(bullRow({}, null))).toBeNull();
    expect(alignment(bearRow({}, null))).toBeNull();
  });

  test('a neutral catalyst is not agreement', () => {
    expect(alignment(bullRow({}, { sentiment: 'neutral' }))).toBeNull();
  });

  test('a story pointing the other way is the clearest disagreement there is', () => {
    expect(alignment(bullRow({}, { sentiment: 'bear' }))).toBeNull();
    expect(alignment(bearRow({}, { sentiment: 'bull' }))).toBeNull();
  });
});

describe('what is deliberately NOT required', () => {
  /*
   * The trader's own two examples. A card with every level up, the stack in
   * order and an earnings beat was called fully bullish while sitting BELOW the
   * pre-market high — that level is one the stock may simply not have reached
   * yet, and requiring it would discard the setups that are still setting up.
   */
  test('a bull below the pre-market high is still aligned', () => {
    expect(alignment(bullRow({ vsPmHigh: 'below' }))).toBe('bull');
    expect(ALIGN_BULL).not.toContain('vsPmHigh');
  });

  test('a bear above the pre-market low is still aligned', () => {
    expect(alignment(bearRow({ vsPmLow: 'above' }))).toBe('bear');
    expect(ALIGN_BEAR).not.toContain('vsPmLow');
  });

  test('but the NEAR side still counts — losing it is disagreement, not absence', () => {
    // A bull that has lost the pre-market LOW has broken something, which is a
    // different fact from not yet having taken out the high.
    expect(alignment(bullRow({ vsPmLow: 'below' }))).toBeNull();
    expect(alignment(bearRow({ vsPmHigh: 'above' }))).toBeNull();
  });

  test('the monthly-range quarter says nothing here', () => {
    // Q4 appeared on the bullish example and Q2 on the bearish one, so the
    // quarter cannot be evidence for either. It describes where the stock has
    // been, not what the signals are saying now.
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4', null]) {
      expect({ q, bull: alignment(bullRow({ monthQuarter: q })) }).toEqual({ q, bull: 'bull' });
      expect({ q, bear: alignment(bearRow({ monthQuarter: q })) }).toEqual({ q, bear: 'bear' });
    }
  });
});

describe('missing data is not agreement', () => {
  test('an unresolved flag fails the check rather than passing it', () => {
    // "We could not tell" and "everything lines up" must not look the same on
    // a badge whose whole claim is that nothing disagrees.
    expect(alignment(bullRow({ vsVwap: null }))).toBeNull();
    expect(alignment(bearRow({ vsEma50: null }))).toBeNull();
  });

  test('a card with no signals at all is not aligned', () => {
    expect(alignment({})).toBeNull();
    expect(alignment({ signals: {}, catalyst: { sentiment: 'bull' } })).toBeNull();
  });

  test('a null stack fails, even with every level agreeing', () => {
    expect(alignment(bullRow({ maStack: null }))).toBeNull();
  });
});

describe('the rule is symmetric', () => {
  test('the two lists differ only in which pre-market extreme they drop', () => {
    // If they ever diverge in some other way it will be an accident, and it
    // would make one direction quietly easier to satisfy than the other.
    const common = ALIGN_BULL.filter(k => !k.startsWith('vsPm'));
    expect(ALIGN_BEAR.filter(k => !k.startsWith('vsPm'))).toEqual(common);
    expect(ALIGN_BULL.filter(k => k.startsWith('vsPm'))).toEqual(['vsPmLow']);
    expect(ALIGN_BEAR.filter(k => k.startsWith('vsPm'))).toEqual(['vsPmHigh']);
  });
});
