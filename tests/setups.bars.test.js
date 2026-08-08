/*
 * Choosing a feed, and waiting for the decision bar.
 *
 * This is not plumbing. The setup ranks by VWAP extension and takes the top
 * two, so every candidate has to be measured on the same tape — a list built
 * from two feeds is partly a ranking of feeds.
 *
 * How far apart the feeds actually are was measured rather than assumed, and
 * the assumption was wrong. On a liquid morning the three agree on VWAP to
 * within 0.06% — even Alpaca's IEX feed, which carried a twenty-fifth of the
 * volume, still tracked the price. So the feed is not the reason a backtest
 * number and a live number differ by whole points. What it changes is the last
 * decimal of a stop, and more than that on thin names, which is why the source
 * is recorded per ticker and repeated on the alert.
 */

jest.mock('../src/yahoo/client');
jest.mock('../src/alpaca/client');
jest.mock('../src/polygon/client');

const yahoo = require('../src/yahoo/client');
const alpaca = require('../src/alpaca/client');
const polygon = require('../src/polygon/client');
const bars = require('../src/setups/bars');

const DATE = '2026-08-10';

/** A tape ending at `last`. Only the times matter to this module. */
function tape(last = '09:59') {
  return [{ etTime: '09:30', o: 1, h: 1, l: 1, c: 1, v: 1 },
          { etTime: last, o: 1, h: 1, l: 1, c: 1, v: 1 }];
}

beforeEach(() => {
  jest.clearAllMocks();
  polygon.hasKey.mockReturnValue(true);
  alpaca.getFeed.mockReturnValue('iex');
  polygon.fetchIntradayBars.mockResolvedValue({});
  yahoo.fetchIntradayBars.mockResolvedValue({});
  alpaca.fetchIntradayBars.mockResolvedValue({});
});

describe('which feed answers', () => {
  test('Polygon is asked first — it is the feed the numbers were built on', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.sources.AAA).toBe('polygon');
    expect(yahoo.fetchIntradayBars).not.toHaveBeenCalled();
    expect(alpaca.fetchIntradayBars).not.toHaveBeenCalled();
  });

  test('with no Polygon key it is skipped rather than failed', async () => {
    polygon.hasKey.mockReturnValue(false);
    yahoo.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(polygon.fetchIntradayBars).not.toHaveBeenCalled();
    expect(out.sources.AAA).toBe('yahoo');
  });

  /*
   * When no single feed covers the list, the gaps are filled from the others —
   * a compromised ranking beats a ranking over a fifth of the universe. This is
   * the last resort, not the normal path, and it is what sets `mixed`.
   */
  test('when nothing covers the list, the gaps are filled and the mixture reported', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    yahoo.fetchIntradayBars.mockResolvedValue({ BBB: tape() });
    const out = await bars.fetchMorning(['AAA', 'BBB'], DATE, { attempts: 1, waitMs: 0 });
    expect(yahoo.fetchIntradayBars).toHaveBeenLastCalledWith(['BBB'], DATE);
    expect(out.mixed).toBe(true);
    expect(out.used.sort()).toEqual(['polygon', 'yahoo']);
  });

  test('a feed that throws does not stop the ones after it', async () => {
    polygon.fetchIntradayBars.mockRejectedValue(new Error('rate limited'));
    yahoo.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.sources.AAA).toBe('yahoo');
    expect(out.missing).toEqual([]);
  });

  /*
   * The IEX feed is a few percent of the tape, so its VWAP — and therefore the
   * stop — is not the level a chart draws. Named per ticker so the warning can
   * be attached only where it is true.
   */
  test('Alpaca is recorded with its feed, and IEX is flagged as degraded', async () => {
    alpaca.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.sources.AAA).toBe('alpaca:iex');
    expect(out.degraded).toEqual(['AAA']);
  });

  test('a paid Alpaca feed is not flagged', async () => {
    alpaca.getFeed.mockReturnValue('sip');
    alpaca.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.sources.AAA).toBe('alpaca:sip');
    expect(out.degraded).toEqual([]);
  });

  test('pinning a feed uses that one and no other', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    yahoo.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0, only: 'yahoo' });
    expect(out.sources.AAA).toBe('yahoo');
    expect(polygon.fetchIntradayBars).not.toHaveBeenCalled();
  });
});

/*
 * At 10:00:00 the 09:59 bar is a fraction of a second old. Treating a tape that
 * stops at 09:52 as complete would rank a 22-minute morning as though it were
 * the whole thing — quietly, on a different VWAP and a different range.
 */
describe('waiting for the decision bar', () => {
  test('a tape that stops short is not accepted', async () => {
    yahoo.fetchIntradayBars.mockResolvedValue({ AAA: tape('09:52') });
    polygon.hasKey.mockReturnValue(false);
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.missing).toEqual(['AAA']);
    expect(out.coverage).toBe(0);
  });

  test('it retries, and takes the bar when it arrives', async () => {
    polygon.hasKey.mockReturnValue(false);
    yahoo.fetchIntradayBars
      .mockResolvedValueOnce({ AAA: tape('09:52') })
      .mockResolvedValue({ AAA: tape('09:59') });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 3, waitMs: 0 });
    expect(out.missing).toEqual([]);
    expect(out.attempts).toBe(2);
  });

  test('a later bar than asked for still counts — a gap at 09:59 is not a failure', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape('10:03') });
    const out = await bars.fetchMorning(['AAA'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.missing).toEqual([]);
  });

  test('it stops retrying once enough of the universe has arrived', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape(), BBB: tape(), CCC: tape() });
    const out = await bars.fetchMorning(['AAA', 'BBB', 'CCC', 'DDD'], DATE,
      { attempts: 4, waitMs: 0, minCoverage: 0.7 });
    expect(out.attempts).toBe(1);
    expect(out.coverage).toBeCloseTo(0.75, 5);
    expect(out.missing).toEqual(['DDD']);
  });

  test('partial data is returned rather than discarded', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape() });
    const out = await bars.fetchMorning(['AAA', 'ZZZ'], DATE, { attempts: 1, waitMs: 0 });
    expect(Object.keys(out.bars)).toEqual(['AAA']);
    expect(out.missing).toEqual(['ZZZ']);
  });
});

describe('the universe list', () => {
  test('is de-duplicated and upper-cased', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({});
    await bars.fetchMorning(['aaa', 'AAA', 'bbb'], DATE, { attempts: 1, waitMs: 0 });
    expect(polygon.fetchIntradayBars).toHaveBeenCalledWith(['AAA', 'BBB'], DATE);
  });

  test('an empty universe asks no feed anything', async () => {
    const out = await bars.fetchMorning([], DATE);
    expect(out.missing).toEqual([]);
    expect(polygon.fetchIntradayBars).not.toHaveBeenCalled();
  });
});

/*
 * Polygon costs one request per symbol and its free plan allows five a minute,
 * so a card list of forty is not slow on that plan — it is impossible. Asking
 * anyway spends the first minute of the decision collecting 429s before falling
 * through to a feed that would have answered at once, which is the worst
 * possible use of 10:00.
 */
describe('the Polygon rate limit', () => {
  test('a small universe still uses it', async () => {
    polygon.fetchIntradayBars.mockResolvedValue({ AAA: tape(), BBB: tape() });
    const out = await bars.fetchMorning(['AAA', 'BBB'], DATE, { attempts: 1, waitMs: 0 });
    expect(out.feed).toBe('polygon');
  });

  test('a card-list-sized universe skips it entirely', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `T${i}`);
    yahoo.fetchIntradayBars.mockResolvedValue(
      Object.fromEntries(many.map(t => [t, tape()])));
    const out = await bars.fetchMorning(many, DATE, { attempts: 1, waitMs: 0 });
    expect(polygon.fetchIntradayBars).not.toHaveBeenCalled();
    expect(out.feed).toBe('yahoo');
  });

  test('the limit is raisable, for a paid key', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `T${i}`);
    jest.resetModules();
    process.env.POLYGON_MAX_SYMBOLS = '500';
    const p2 = require('../src/polygon/client');
    const y2 = require('../src/yahoo/client');
    const a2 = require('../src/alpaca/client');
    p2.hasKey.mockReturnValue(true);
    a2.getFeed.mockReturnValue('iex');
    y2.fetchIntradayBars.mockResolvedValue({});
    a2.fetchIntradayBars.mockResolvedValue({});
    p2.fetchIntradayBars.mockResolvedValue(Object.fromEntries(many.map(t => [t, tape()])));
    const bars2 = require('../src/setups/bars');
    const out = await bars2.fetchMorning(many, DATE, { attempts: 1, waitMs: 0 });
    expect(out.feed).toBe('polygon');
    delete process.env.POLYGON_MAX_SYMBOLS;
    jest.resetModules();
  });
});
