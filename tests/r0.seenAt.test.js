/*
 * Per-screener first-sighting times.
 *
 * The trader opens momentum positions until 10:00 and reversals until 13:00. A
 * stock that a screener first threw up at 15:00 must never look like one that
 * had been on the list since the pre-market — that mistake reads as a trade
 * that was available and was missed, when it was never available at all.
 */

const r0 = require('../src/r0/registry');

const AT = (h, m) => new Date(2026, 6, 30, h, m).getTime();

beforeEach(() => {
  r0.clearAll();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const scan = (ticker, keys, at) => {
  jest.setSystemTime(at);
  r0.upsertRows([{ ticker, stock: { price: 10 }, screenerKeys: keys }]);
};

describe('seenAt', () => {
  test('stamps the time each screener first matched', () => {
    scan('AAA', ['Pre-Market Gap'], AT(8, 12));
    expect(r0.getRow('AAA').seenAt).toEqual({ 'Pre-Market Gap': AT(8, 12) });
  });

  test('a later match by a different screener keeps its own later time', () => {
    scan('AAA', ['Pre-Market Gap'], AT(8, 12));
    scan('AAA', ['After Open Volume'], AT(15, 4));
    expect(r0.getRow('AAA').seenAt).toEqual({
      'Pre-Market Gap': AT(8, 12),
      'After Open Volume': AT(15, 4),
    });
  });

  test('re-matching does not move a time that is already stamped', () => {
    scan('AAA', ['Big Move'], AT(9, 40));
    scan('AAA', ['Big Move'], AT(11, 0));
    scan('AAA', ['Big Move'], AT(15, 30));
    expect(r0.getRow('AAA').seenAt['Big Move']).toBe(AT(9, 40));
  });

  test('the history outlives screenerKeys, which only lists what matches now', () => {
    // This is the case the card has to get right: the morning screener has
    // stopped running, so the row no longer carries its key — but the stock was
    // genuinely visible from 08:12, and the card must still be able to say so.
    scan('AAA', ['Pre-Market Gap'], AT(8, 12));
    scan('AAA', ['After Open Volume'], AT(15, 4));
    const row = r0.getRow('AAA');
    expect(row.screenerKeys).toEqual(['After Open Volume']);
    expect(Object.keys(row.seenAt).sort()).toEqual(['After Open Volume', 'Pre-Market Gap']);
  });

  test('two screeners matching in the same scan share that scan time', () => {
    scan('AAA', ['Trend', 'Big Move'], AT(9, 45));
    expect(r0.getRow('AAA').seenAt).toEqual({ Trend: AT(9, 45), 'Big Move': AT(9, 45) });
  });

  test('firstSeen still marks when the stock entered the tool', () => {
    scan('AAA', ['Pre-Market Gap'], AT(8, 12));
    scan('AAA', ['After Open Volume'], AT(15, 4));
    expect(r0.getRow('AAA').firstSeen).toBe(AT(8, 12));
  });

  test('an update carrying no screenerKeys leaves the history alone', () => {
    // e.g. the bias route, which re-upserts the row it just read
    scan('AAA', ['Trend'], AT(9, 45));
    jest.setSystemTime(AT(10, 0));
    const row = r0.getRow('AAA');
    r0.upsertRows([{ ...row, _score: 71 }]);
    expect(r0.getRow('AAA').seenAt).toEqual({ Trend: AT(9, 45) });
    expect(r0.getRow('AAA')._score).toBe(71);
  });

  test('each ticker keeps its own history', () => {
    scan('AAA', ['Pre-Market Gap'], AT(8, 12));
    scan('BBB', ['After Open Volume'], AT(15, 4));
    expect(r0.getRow('AAA').seenAt).toEqual({ 'Pre-Market Gap': AT(8, 12) });
    expect(r0.getRow('BBB').seenAt).toEqual({ 'After Open Volume': AT(15, 4) });
  });
});
