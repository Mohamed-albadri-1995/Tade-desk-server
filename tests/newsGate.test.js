/*
 * The news test, and the reason it runs where it does.
 *
 * The unexplained-move screener asks TradingView for stocks that went 15% in
 * two hours. TradingView has no news column, so what comes back is every 15%
 * mover — and most of those moved because something happened. The setup is the
 * ones where nothing did.
 *
 * A card filter on the setup would be too late. By then the whole unfiltered
 * list is in r0, frozen into R1 the next morning, and in the training data.
 * Asked for plainly: the full list must not reach r0 or any other part of the
 * warehouse. So the gate sits between the scanner and the merge, and the names
 * that fail it are never recorded as candidates at all.
 */

const gate = require('../src/sideA/newsGate');

const SCREENERS = [
  { name: 'Unexplained Move', key: 'unexplained-move' },
  { name: 'Unexplained Move (mirror)', key: 'unexplained-move-mirror' },
  { name: '20-Day Break', key: '20d-break' },
  { name: 'Gap + Volume', key: 'gap-volume' },
];

const row = ticker => ({ ticker, stock: { price: 3, tvSymbol: `NASDAQ:${ticker}` } });

/** A news lookup with a fixed answer per ticker. */
const feed = (map, fail = []) => async (ticker) => {
  if (fail.includes(ticker)) throw new Error('news API timed out');
  return { news: [], catalyst: map[ticker] || null };
};

describe('which screeners are gated', () => {
  test('the unexplained-move pair requires NO news', () => {
    expect(gate.gateFor('unexplained-move')).toBe('none');
    expect(gate.gateFor('unexplained-move-mirror')).toBe('none');
  });

  /*
   * The 20-day break WANTS a catalyst, and that stays a card filter on the
   * setup. Its news requirement is a preference — a break with something
   * behind it is a better break — and a preference belongs where it can be
   * changed per setup and where the names it removes are still recorded. Only
   * a screener whose PREMISE is the news test is worth a lookup per candidate
   * and worth keeping out of the archive.
   */
  test('the 20-day break is NOT gated here — its news rule is a preference', () => {
    expect(gate.gateFor('20d-break')).toBeNull();
  });

  test('an ordinary screener is not gated', () => {
    expect(gate.gateFor('gap-volume')).toBeNull();
    expect(gate.gateFor('')).toBeNull();
    expect(gate.gateFor(undefined)).toBeNull();
  });
});

describe('applying the gate', () => {
  test('only the names with nothing behind the move survive', async () => {
    const candidates = {
      'Unexplained Move': [row('QUIET'), row('NEWSY'), row('ALSOQUIET')],
    };
    const { candidates: out } = await gate.apply(candidates, SCREENERS, {
      fetch: feed({ NEWSY: 'FDA approval' }),
    });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['QUIET', 'ALSOQUIET']);
  });

  test('an ungated screener is passed through untouched, and costs nothing', async () => {
    const fetch = jest.fn(feed({}));
    const candidates = { 'Gap + Volume': [row('AAA'), row('BBB')] };
    const { candidates: out } = await gate.apply(candidates, SCREENERS, { fetch });
    expect(out['Gap + Volume']).toHaveLength(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('the mirror is gated the same way as the base', async () => {
    const { candidates: out } = await gate.apply(
      { 'Unexplained Move (mirror)': [row('QUIET'), row('NEWSY')] },
      SCREENERS, { fetch: feed({ NEWSY: 'earnings' }) });
    expect(out['Unexplained Move (mirror)'].map(r => r.ticker)).toEqual(['QUIET']);
  });

  /*
   * THE ONE PLACE A FAILED LOOKUP DROPS THE ROW.
   *
   * Everywhere else in this pipeline a missing value means "cannot tell" and
   * the row survives, because losing a candidate to a flaky API is worse than
   * keeping a doubtful one. Here the whole premise is "nothing explains this
   * move", and "we could not find out" is not that — a name kept on a failed
   * lookup is a name whose news nobody checked, in a screener that exists to
   * find names with no news.
   */
  test('a failed lookup drops the stock, and says so', async () => {
    const { candidates: out, report } = await gate.apply(
      { 'Unexplained Move': [row('QUIET'), row('BROKEN')] },
      SCREENERS, { fetch: feed({}, ['BROKEN']) });
    expect(out['Unexplained Move'].map(r => r.ticker)).toEqual(['QUIET']);
    expect(report.failed).toBe(1);
    expect(report.dropped).toBe(1);
  });

  test('one lookup per ticker, however many rows mention it', async () => {
    const fetch = jest.fn(feed({}));
    await gate.apply({ 'Unexplained Move': [row('AAA'), row('AAA'), row('BBB')] },
                     SCREENERS, { fetch });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('the report says what went in and what came out', async () => {
    const { report } = await gate.apply(
      { 'Unexplained Move': [row('Q1'), row('Q2'), row('N1')] },
      SCREENERS, { fetch: feed({ N1: 'merger' }) });
    expect(report.byScreener['Unexplained Move']).toEqual({ mode: 'none', in: 3, out: 2 });
    expect(report.checked).toBe(3);
    expect(report.dropped).toBe(1);
  });

  test('an empty scan is not an error', async () => {
    const { candidates: out } = await gate.apply({}, SCREENERS, { fetch: feed({}) });
    expect(out).toEqual({});
  });

  test('a screener the definition list does not know is left alone', async () => {
    const { candidates: out } = await gate.apply(
      { 'Something New': [row('AAA')] }, SCREENERS, { fetch: feed({}) });
    expect(out['Something New']).toHaveLength(1);
  });
});

/*
 * The point of the whole file: what the warehouse is allowed to see.
 */
describe('what reaches the merge', () => {
  test('the unfiltered list never leaves this stage', async () => {
    const candidates = {
      'Unexplained Move': [row('QUIET'), row('NEWSY1'), row('NEWSY2'), row('NEWSY3')],
    };
    const before = candidates['Unexplained Move'].length;
    const { candidates: out } = await gate.apply(candidates, SCREENERS, {
      fetch: feed({ NEWSY1: 'a', NEWSY2: 'b', NEWSY3: 'c' }),
    });
    expect(before).toBe(4);
    expect(out['Unexplained Move']).toHaveLength(1);
    // …and the three that moved on news are simply not in what goes forward.
    expect(JSON.stringify(out)).not.toContain('NEWSY');
  });
});
