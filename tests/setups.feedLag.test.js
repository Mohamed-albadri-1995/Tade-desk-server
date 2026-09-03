/*
 * THE DECISION MUST SAY WHICH BAR IT WAS ABOUT.
 *
 * This is the failure that looks exactly like a quiet market, and it cost a
 * whole session on 2026-09-03.
 *
 * A DELAYED FEED DOES NOT FAIL. qp reads whatever bars exist and answers about
 * those. So on Yahoo's free intraday data — roughly fifteen minutes behind —
 * the desk asks about the 09:41 bar at 09:42, is answered about 09:26, and
 * publishes "nothing qualified". That is the same sentence a quiet market
 * produces. Twenty minutes later the 09:41 bar arrives, the entry appears, and
 * the stale guard correctly refuses it because it is now nineteen minutes old.
 *
 * The desk's own log for that day:
 *
 *     09:49  cards 7  evaluated 7  signalled 0
 *     10:00  cards 9  evaluated 9  signalled 2   stale: GEO@09:45, IBKR@09:41
 *
 * Both signals appear on exactly the run where a fifteen-minute delay would
 * first expose them. Every part of the desk behaved correctly and nothing
 * could say why, because nothing compared the bar ASKED about with the bar
 * ANSWERED about.
 *
 * So that comparison is now a number, and these tests are about the number
 * being right — including, especially, that it is NULL rather than zero when
 * it cannot be taken.
 */

const runner = require('../src/setups/runner');
const log = require('../src/setups/sessionLog');

const lag = runner.feedLagMin;

describe('the lag between the bar asked for and the bar answered', () => {
  test('the same bar is no lag', () => {
    expect(lag('09:41', '09:41')).toBe(0);
  });

  test('a fifteen-minute feed measures fifteen', () => {
    expect(lag('09:41', '09:26')).toBe(15);
  });

  test('one bar behind is one — the tolerance lives elsewhere, not in the '
    + 'measurement', () => {
    expect(lag('09:41', '09:40')).toBe(1);
  });

  test('it crosses the hour without going negative', () => {
    expect(lag('10:02', '09:47')).toBe(15);
  });

  /*
   * NULL, NOT ZERO. qp before this change reported no bar at all, and a lag of
   * zero on a desk that cannot measure one is the most reassuring wrong answer
   * available — it would have shown a clean feed on the day the feed was the
   * problem.
   */
  test('an unmeasurable lag is null, never zero', () => {
    expect(lag('09:41', null)).toBeNull();
    expect(lag(null, '09:41')).toBeNull();
    expect(lag('09:41', undefined)).toBeNull();
    expect(lag('', '')).toBeNull();
    expect(lag('09:41', 'not a time')).toBeNull();
  });

  test('a bar NEWER than the one asked about is zero, not negative — that is '
    + 'the fetch rolling onto the next minute mid-run, not negative lag', () => {
    expect(lag('09:41', '09:42')).toBe(0);
  });
});

/*
 * The day's summary has to carry it, because on a delayed feed EVERY run has a
 * lag and the reader needs one line rather than ninety.
 */
describe('the day says the feed was behind', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  let DIR;
  let sl;

  beforeEach(() => {
    DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'feedlag-'));
    process.env.SESSION_LOG_DIR = DIR;
    jest.resetModules();
    sl = require('../src/setups/sessionLog');
  });
  afterEach(() => {
    delete process.env.SESSION_LOG_DIR;
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  const run = (bar, lagMin) => sl.runOf({
    date: '2026-09-03', setupId: 'test', setupName: 'Test', bar,
    counts: { evaluated: 9, signalled: 0 },
    data: { feed: 'yahoo', coverage: 1, missing: [],
            askedBar: bar, lastBar: '09:26', lagMin },
  });

  test('the WORST lag of the day, and how many bars had one', () => {
    sl.record(run('09:41', 15));
    sl.record(run('09:42', 16));
    sl.record(run('09:43', 1));            // inside tolerance, not counted
    const s = sl.summaryOf('2026-09-03').test;
    expect(s.lagMaxMin).toBe(16);
    expect(s.lagBars).toBe(2);
    expect(s.runs).toBe(3);
  });

  test('...and it is stated ONCE, with the final number', () => {
    for (const m of [10, 15, 19]) sl.record(run('09:41', m));
    const s = sl.summaryOf('2026-09-03').test;
    const lines = s.problems.filter(p => /feed ran up to/.test(p));
    // ONE LINE. Noted inside the loop, the sentence would change as the max
    // grew and the string-dedupe would let three near-identical lines through.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/19 minutes behind on 3 of 3 runs/);
    expect(lines[0]).toMatch(/yahoo/);
    expect(lines[0]).toMatch(/cannot run on a delayed feed/);
  });

  test('a healthy feed says nothing about lag at all', () => {
    sl.record(run('09:41', 0));
    sl.record(run('09:42', 1));
    const s = sl.summaryOf('2026-09-03').test;
    expect(s.lagBars).toBeUndefined();
    expect(s.problems.filter(p => /feed ran up to/.test(p))).toHaveLength(0);
  });

  /*
   * A DESK THAT CANNOT MEASURE THE LAG MUST NOT REPORT A CLEAN ONE. An older
   * qp reports no bar; that has to read as "unknown", not as "live".
   */
  test('runs with no lag reported claim neither a good feed nor a bad one', () => {
    sl.record(sl.runOf({
      date: '2026-09-03', setupId: 'test', setupName: 'Test', bar: '09:41',
      counts: { evaluated: 9, signalled: 0 },
      data: { feed: 'yahoo', coverage: 1, missing: [] },
    }));
    const s = sl.summaryOf('2026-09-03').test;
    expect(s.lagMaxMin).toBeUndefined();
    expect(s.lagBars).toBeUndefined();
    expect(s.problems.filter(p => /feed ran up to/.test(p))).toHaveLength(0);
  });

  test('the run row carries the two bars, so a single minute can be checked '
    + 'without the summary', () => {
    sl.record(run('09:41', 15));
    const [r] = sl.runsOn('2026-09-03');
    expect(r.feed.askedBar).toBe('09:41');
    expect(r.feed.lastBar).toBe('09:26');
    expect(r.feed.lagMin).toBe(15);
    // COVERAGE IS NOT FRESHNESS. A delayed feed has 100% coverage of a market
    // fifteen minutes ago, which is exactly why coverage alone hid this.
    expect(r.feed.coverage).toBe(1);
  });
});

describe('the threshold', () => {
  test('one bar is tolerated, two is not — the same tolerance the stale guard '
    + 'uses, and for the same reason', () => {
    expect(runner.FEED_LAG_WARN_MIN).toBe(2);
  });

  test('...and the day agrees with the run about where the line is', () => {
    // Two constants that disagreed would mean a run that warns and a day that
    // does not, or the reverse.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'setups', 'sessionLog.js'), 'utf8');
    expect(src).toMatch(/const LAG_BAD_MIN = 2;/);
  });
});
