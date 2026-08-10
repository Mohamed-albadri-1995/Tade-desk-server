/*
 * The generated description of what a tool screens for.
 *
 * The point of generating it is that it cannot drift from what the scanner
 * runs. So the property worth testing is not that some particular sentence
 * comes out, but that the sentence tracks the definition: change a threshold
 * and the words change with it, with no second place to update.
 */

const summary = require('../src/sideA/screenerSummary');
const store = require('../src/sideA/screenerStore');

describe('rule text', () => {
  test('a threshold reads as a sentence', () => {
    expect(summary.ruleText({ left: 'close', operation: 'egreater', right: 5 }))
      .toBe('Price (close) is above or equal 5');
  });

  test('the same rule with a different number says the different number', () => {
    const a = summary.ruleText({ left: 'close', operation: 'egreater', right: 5 });
    const b = summary.ruleText({ left: 'close', operation: 'egreater', right: 9 });
    expect(a).not.toBe(b);
    expect(b).toContain('9');
  });

  /*
   * "above 20" and "above SMA 20" are different rules. A column on the right
   * printed as a bare string reads as a typo, so it is labelled like the left.
   */
  test('a column on the right is named, not printed raw', () => {
    expect(summary.ruleText({ left: 'close', operation: 'greater', right: 'SMA20' }))
      .toBe('Price (close) is above SMA 20');
  });

  test('a timeframe suffix is spelled out', () => {
    expect(summary.ruleText({ left: 'close|1W', operation: 'greater', right: 0 }))
      .toContain('(weekly)');
  });

  /*
   * A field whose own label already carries the timeframe must not have it
   * appended again — that produced "Relative volume (5m) (5m)".
   */
  test('a label that already names its timeframe is not doubled', () => {
    const withTf = store.FIELDS.find(f => f.value.includes('|') && /\(/.test(f.label));
    if (!withTf) return;                       // no such field configured
    const text = summary.fieldLabel(withTf.value);
    expect(text).toBe(withTf.label);
    expect(text.match(/\(/g).length).toBe(1);
  });

  test('a range keeps both ends', () => {
    expect(summary.ruleText({ left: 'change', operation: 'in_range', right: [2, 8] }))
      .toContain('2 … 8');
  });

  test('an unknown field falls back to its raw name rather than vanishing', () => {
    expect(summary.ruleText({ left: 'not_a_real_column', operation: 'greater', right: 1 }))
      .toContain('not_a_real_column');
  });

  test('a malformed filter yields nothing rather than half a sentence', () => {
    expect(summary.ruleText(null)).toBe('');
    expect(summary.ruleText({})).toBe('');
  });
});

/*
 * Volume thresholds are written in full in the definitions — 2000000 — and
 * counting zeroes is not reading.
 */
describe('numbers', () => {
  const t = (right) => summary.ruleText({ left: 'average_volume_10d_calc', operation: 'greater', right });

  test('millions are abbreviated', () => expect(t(2000000)).toContain('2M'));
  test('and keep one useful decimal', () => expect(t(1500000)).toContain('1.5M'));
  test('thousands too', () => expect(t(250000)).toContain('250K'));
  test('billions too', () => expect(t(3000000000)).toContain('3B'));

  /*
   * Small numbers are prices, ratios and percentages. Abbreviating those would
   * be actively wrong — "price above 2K" is not what anyone wrote.
   */
  test('a price is left exactly as written', () => {
    expect(summary.ruleText({ left: 'close', operation: 'egreater', right: 2 })).toContain(' 2');
    expect(summary.ruleText({ left: 'close', operation: 'egreater', right: 1.5 })).toContain('1.5');
  });

  test('the boundary is ten thousand, so 9999 stays as it is', () => {
    expect(t(9999)).toContain('9999');
    expect(t(10000)).toContain('10K');
  });
});

describe('the summary a tool publishes', () => {
  const out = summary.summarise();

  test('it lists screeners, each with its rules', () => {
    expect(Array.isArray(out.screeners)).toBe(true);
    for (const s of out.screeners) {
      expect(typeof s.name).toBe('string');
      expect(Array.isArray(s.rules)).toBe(true);
      expect(s.rules.every(r => typeof r === 'string' && r.length > 0)).toBe(true);
    }
  });

  /*
   * Only enabled ones. A disabled screener finds nothing, and listing it would
   * tell the reader the tool looks for something it does not.
   */
  test('only enabled screeners are described', () => {
    const enabled = store.list({ enabledOnly: true }).map(s => s.name).sort();
    expect(out.screeners.map(s => s.name).sort()).toEqual(enabled);
  });

  /*
   * A screener with no window runs on every scan. Filling that in with the
   * outer bounds of the day would present it as a decision someone made.
   */
  test('no window is reported as no window, not as 04:00–20:00', () => {
    for (const s of out.screeners) {
      const raw = store.list({ enabledOnly: true }).find(x => x.name === s.name);
      if (!raw.runFrom) expect(s.runFrom).toBeNull();
    }
  });

  /*
   * The floor is appended to every screener at scan time, so a stock below it
   * is never collected by anything. It belongs in the description once, as the
   * shared condition it is.
   */
  test('the tradability floor is carried separately from any screener', () => {
    const tradable = require('../src/sideA/tradable');
    expect(out.floor).toEqual(tradable.describe(tradable.thresholds()));
  });

  test('label-only screeners are flagged, not hidden', () => {
    const raw = store.list({ enabledOnly: true }).filter(s => s.labelOnly).map(s => s.name).sort();
    expect(out.screeners.filter(s => s.labelOnly).map(s => s.name).sort()).toEqual(raw);
  });

  test('it says how often the tool looks', () => {
    expect(out.cadence.length).toBeGreaterThan(0);
    for (const c of out.cadence) {
      expect(c.when).toMatch(/^\d\d:\d\d–\d\d:\d\d$/);
      expect(c.every).toMatch(/every/);
    }
  });
});
